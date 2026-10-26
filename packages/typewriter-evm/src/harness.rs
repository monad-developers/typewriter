use std::collections::{BTreeMap, BTreeSet, HashMap};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadHardfork,
};
use revm::{
    bytecode::opcode,
    context::TxEnv,
    context_interface::{
        result::{ExecutionResult, HaltReason},
        transaction::{AccessList, AccessListItem},
        Host, JournalTr,
    },
    database::InMemoryDB,
    inspector::InspectEvm,
    interpreter::{
        interpreter::EthInterpreter,
        interpreter_types::{Jumps, MemoryTr},
        CallInputs, CallOutcome, CreateInputs, CreateOutcome, Interpreter, InterpreterResult,
    },
    primitives::{Address, Bytes, TxKind, B256, U256},
    state::{AccountInfo, Bytecode, EvmState},
    DatabaseRef, ExecuteCommitEvm, ExecuteEvm, Inspector,
};
use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Wire types

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum Request {
    SetBlockContext { id: u64, params: BlockParams },
    Execute { id: u64, params: ExecuteParams },
    Simulate { id: u64, params: SimulateParams },
    ReadStorage { id: u64, params: ReadStorageParams },
    RevertJournals { id: u64, params: JournalIdsParams },
    PruneJournals { id: u64, params: JournalIdsParams },
}

#[derive(Deserialize)]
struct InitParams {
    spec: Option<String>,
    chain_id: Option<u64>,
    block: Option<BlockParams>,
    accounts: Option<BTreeMap<String, AccountParams>>,
}

#[derive(Deserialize)]
struct BlockParams {
    number: Option<String>,
    timestamp: Option<String>,
    basefee: Option<String>,
    coinbase: Option<String>,
}

#[derive(Deserialize)]
struct AccountParams {
    balance: Option<String>,
    nonce: Option<u64>,
    code: Option<String>,
    storage: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
struct ExecuteParams {
    from: String,
    to: String,
    data: String,
    value: Option<String>,
}

#[derive(Deserialize)]
struct SimulateParams {
    #[serde(flatten)]
    tx: ExecuteParams,
    journal_ids: Vec<u64>,
}

#[derive(Deserialize)]
struct ReadStorageParams {
    address: String,
    slots: Vec<String>,
}

#[derive(Deserialize)]
struct JournalIdsParams {
    journal_ids: Vec<u64>,
}

#[derive(Serialize)]
struct TxOutcome {
    #[serde(flatten)]
    status: TxStatus,
    gas_used: u64,
    access_list: Vec<AccessListEntry>,
}

impl TxOutcome {
    fn success(&self) -> bool {
        matches!(self.status, TxStatus::Success)
    }
}

// A halt is a failure other than REVERT, such as out of gas or an invalid
// opcode. It returns no data and uses all the gas the frame was given.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TxStatus {
    Success,
    Revert { data: String },
    Halt { reason: String },
}

// gas_used is with cold access: execute warms no access list.
#[derive(Serialize)]
struct ExecuteOk {
    #[serde(flatten)]
    outcome: TxOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal_id: Option<u64>,
    // Writes to the called contract.
    slot_writes: Vec<SlotWriteEntry>,
    // The 64-byte KECCAK256 inputs: a mapping key and the mapping's slot.
    keccak_preimages: Vec<String>,
}

// gas_used is with the access list warm, as the chain charges it.
#[derive(Serialize)]
struct SimulateOk {
    #[serde(flatten)]
    outcome: TxOutcome,
    gas_limit: u64,
}

#[derive(Serialize)]
struct AccessListEntry {
    address: String,
    #[serde(rename = "storageKeys")]
    storage_keys: Vec<String>,
}

#[derive(Serialize)]
struct SlotWriteEntry {
    slot: String,
    value: String,
}

// -----------------------------------------------------------------------------
// Inspector

type MonadCtx = monad_revm::api::default_ctx::MonadContext<InMemoryDB>;
type Evm = monad_revm::api::builder::DefaultMonadEvm<MonadCtx, HarnessInspector>;
type TxResult = ExecutionResult<HaltReason>;

// The gas limit must exceed gas_used in two places: SSTORE needs more than
// the call stipend left (EIP-2200), and a call or create keeps 1/64 of the
// gas it could forward (EIP-150). Gas spent after either point is already in
// gas_used, so each frame needs a reserve: 2,301 for its own SSTOREs, and
// enough that 63/64 of its remaining gas covers each child's gas plus the
// child's reserve. Monad has no refunds, so gas_used is the gas spent. A
// halted frame uses all the gas it is given, which its need already counts.
//
// Typewriter contracts never catch a halt in a nested call: a failed call
// reverts the tx. The limit relies on this. Simulate runs at u64::MAX gas, so
// a caught halt in a call that forwards all its gas burns nearly all of it,
// and gas_limit comes out near u64::MAX, which the node rejects.
#[derive(Default)]
struct HarnessInspector {
    keccak_preimages: Vec<[u8; 64]>,
    frame_reserves: Vec<u64>,
    gas_reserve: u64,
}

impl HarnessInspector {
    fn clear(&mut self) {
        *self = Self::default();
    }

    fn frame_end(&mut self, gas_limit: u64, result: &InterpreterResult, sstore_reserve: u64) {
        let Some(mut reserve) = self.frame_reserves.pop() else {
            return;
        };
        reserve = reserve.max(sstore_reserve);
        let need = gas_limit - result.gas.remaining() + reserve;
        match self.frame_reserves.last_mut() {
            Some(parent) => *parent = (*parent).max(reserve + need.div_ceil(63) + 1),
            None => self.gas_reserve = reserve,
        }
    }
}

impl Inspector<MonadCtx> for HarnessInspector {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, _context: &mut MonadCtx) {
        if interp.bytecode.opcode() != opcode::KECCAK256 {
            return;
        }
        let [.., len, offset] = interp.stack.data().as_slice() else {
            return;
        };
        // Only a mapping slot hashes 64 bytes: the key and the mapping's slot.
        let (Ok(offset), Ok(64)) = (usize::try_from(*offset), usize::try_from(*len)) else {
            return;
        };
        // Memory past its current size reads as zeros.
        let mut preimage = [0; 64];
        let memory_size = interp.memory.size();
        if offset < memory_size {
            let copied = (memory_size - offset).min(64);
            preimage[..copied].copy_from_slice(&interp.memory.slice_len(offset, copied));
        }
        self.keccak_preimages.push(preimage);
    }

    fn call(&mut self, _context: &mut MonadCtx, _inputs: &mut CallInputs) -> Option<CallOutcome> {
        self.frame_reserves.push(0);
        None
    }

    fn call_end(&mut self, context: &mut MonadCtx, inputs: &CallInputs, outcome: &mut CallOutcome) {
        // Precompiles have fixed costs and no SSTORE.
        let sstore_reserve = if outcome.was_precompile_called {
            0
        } else {
            context.gas_params().call_stipend() + 1
        };
        self.frame_end(inputs.gas_limit, &outcome.result, sstore_reserve);
    }

    fn create(
        &mut self,
        _context: &mut MonadCtx,
        _inputs: &mut CreateInputs,
    ) -> Option<CreateOutcome> {
        self.frame_reserves.push(0);
        None
    }

    fn create_end(
        &mut self,
        context: &mut MonadCtx,
        inputs: &CreateInputs,
        outcome: &mut CreateOutcome,
    ) {
        let sstore_reserve = context.gas_params().call_stipend() + 1;
        self.frame_end(inputs.gas_limit(), &outcome.result, sstore_reserve);
    }
}

// -----------------------------------------------------------------------------
// Harness

// revm clears its own journal when a tx succeeds, so each tx's pre/post images
// are kept here to revert or temporarily undo it later.
#[derive(Default)]
struct Journal {
    accounts: HashMap<Address, (AccountInfo, AccountInfo)>,
    storage: HashMap<(Address, U256), (U256, U256)>,
    access_list: AccessList,
}

impl Journal {
    fn from_state(state: &EvmState, access_list: AccessList) -> Self {
        let mut journal = Journal {
            access_list,
            ..Default::default()
        };
        for (address, account) in state {
            journal
                .accounts
                .insert(*address, (account.original_info(), account.info.clone()));
            for (slot, value) in &account.storage {
                journal.storage.insert(
                    (*address, *slot),
                    (value.original_value(), value.present_value()),
                );
            }
        }
        journal
    }

    fn write(&self, db: &mut InMemoryDB, image: Image) {
        for (address, images) in &self.accounts {
            db.insert_account_info(*address, image.pick(images).clone());
        }
        for ((address, slot), images) in &self.storage {
            let Ok(()) = db.insert_account_storage(*address, *slot, *image.pick(images));
        }
    }
}

// Which side of a tx a journal writes: Pre undoes the tx, Post redoes it.
#[derive(Clone, Copy)]
enum Image {
    Pre,
    Post,
}

impl Image {
    fn pick<T>(self, (pre, post): &(T, T)) -> &T {
        match self {
            Image::Pre => pre,
            Image::Post => post,
        }
    }
}

struct TxRequest {
    from: Address,
    to: Address,
    data: Bytes,
    value: U256,
    chain_id: u64,
}

impl TxRequest {
    fn parse(params: &ExecuteParams, chain_id: u64) -> Result<Self, String> {
        Ok(Self {
            from: parse_address(&params.from)?,
            to: parse_address(&params.to)?,
            data: parse_bytes(&params.data)?,
            value: params.value.as_deref().map_or(Ok(U256::ZERO), parse_u256)?,
            chain_id,
        })
    }

    fn tx_env(&self, access_list: AccessList) -> TxEnv {
        TxEnv::builder()
            .caller(self.from)
            .chain_id(Some(self.chain_id))
            .kind(TxKind::Call(self.to))
            .gas_limit(u64::MAX)
            .gas_price(0)
            .value(self.value)
            .data(self.data.clone())
            .access_list(access_list)
            .build_fill()
    }
}

pub struct EvmHarness {
    evm: Evm,
    journals: HashMap<u64, Journal>,
    next_journal_id: u64,
}

impl EvmHarness {
    pub fn from_json(params_json: &str) -> Result<Self, String> {
        let params = serde_json::from_str(params_json).map_err(|e| format!("parse error: {e}"))?;
        Self::new(&params)
    }

    fn new(params: &InitParams) -> Result<Self, String> {
        let mut ctx = monad_context_with_db(InMemoryDB::default());
        relax_cfg(&mut ctx.cfg);
        let mut harness = Self {
            evm: ctx.build_monad_with_inspector(HarnessInspector::default()),
            journals: HashMap::new(),
            next_journal_id: 1,
        };
        harness.init(params)?;
        Ok(harness)
    }

    fn init(&mut self, params: &InitParams) -> Result<(), String> {
        if let Some(spec) = params.spec.as_deref() {
            let spec = parse_spec(spec).ok_or_else(|| format!("unknown spec: {spec}"))?;
            let mut cfg = MonadCfgEnv::new_with_spec(spec);
            relax_cfg(&mut cfg);
            self.evm.0.ctx.cfg = cfg;
            self.evm.0.ctx.journaled_state.set_spec_id(spec.into());
        }
        if let Some(chain_id) = params.chain_id {
            self.evm.0.ctx.cfg.0.chain_id = chain_id;
        }
        if let Some(block) = &params.block {
            self.set_block_context(block)?;
        }
        let db = self.evm.0.ctx.journaled_state.db_mut();
        for (address, account) in params.accounts.iter().flatten() {
            let address = parse_address(address)?;
            let mut info = AccountInfo {
                balance: account
                    .balance
                    .as_deref()
                    .map_or(Ok(U256::ZERO), parse_u256)?,
                nonce: account.nonce.unwrap_or(0),
                ..Default::default()
            };
            if let Some(code) = account.code.as_deref() {
                info = info.with_code(Bytecode::new_raw(parse_bytes(code)?));
            }
            db.insert_account_info(address, info);
            for (slot, value) in account.storage.iter().flatten() {
                let Ok(()) =
                    db.insert_account_storage(address, parse_u256(slot)?, parse_u256(value)?);
            }
        }
        Ok(())
    }

    fn set_block_context(&mut self, params: &BlockParams) -> Result<(), String> {
        let block = &mut self.evm.0.ctx.block;
        if let Some(number) = &params.number {
            block.number = parse_u256(number)?;
        }
        if let Some(timestamp) = &params.timestamp {
            block.timestamp = parse_u256(timestamp)?;
        }
        if let Some(basefee) = &params.basefee {
            block.basefee = u64::try_from(parse_u256(basefee)?)
                .map_err(|_| format!("basefee does not fit in u64: {basefee}"))?;
        }
        if let Some(coinbase) = &params.coinbase {
            block.beneficiary = parse_address(coinbase)?;
        }
        Ok(())
    }

    fn revert_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_journal_ids(&params.journal_ids)?;
        for journal_id in params.journal_ids.iter().rev() {
            let journal = self.journals.remove(journal_id).expect("validated above");
            journal.write(self.evm.0.ctx.journaled_state.db_mut(), Image::Pre);
        }
        Ok(())
    }

    fn prune_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_journal_ids(&params.journal_ids)?;
        for journal_id in &params.journal_ids {
            self.journals.remove(journal_id);
        }
        Ok(())
    }

    fn execute(&mut self, params: &ExecuteParams) -> Result<ExecuteOk, String> {
        let tx = TxRequest::parse(params, self.evm.0.ctx.cfg.0.chain_id)?;
        let (result, state) = self.run_tx(&tx, AccessList::default())?;
        let access_list = self.discovered_access_list(&tx, &state);
        let outcome = tx_outcome(&result, &access_list);
        let keccak_preimages = self
            .evm
            .0
            .inspector
            .keccak_preimages
            .iter()
            .map(|preimage| format_bytes(preimage))
            .collect();
        if !outcome.success() {
            return Ok(ExecuteOk {
                outcome,
                journal_id: None,
                slot_writes: Vec::new(),
                keccak_preimages,
            });
        }

        let slot_writes = collect_slot_writes(&state, tx.to);
        let journal = Journal::from_state(&state, access_list);
        self.evm.commit(state);
        let journal_id = self.next_journal_id;
        self.next_journal_id += 1;
        self.journals.insert(journal_id, journal);
        Ok(ExecuteOk {
            outcome,
            journal_id: Some(journal_id),
            slot_writes,
            keccak_preimages,
        })
    }

    fn simulate(&mut self, params: &SimulateParams) -> Result<SimulateOk, String> {
        self.ensure_journal_ids(&params.journal_ids)?;
        let tx = TxRequest::parse(&params.tx, self.evm.0.ctx.cfg.0.chain_id)?;
        for journal_id in params.journal_ids.iter().rev() {
            self.journals[journal_id].write(self.evm.0.ctx.journaled_state.db_mut(), Image::Pre);
        }
        let cached_access_list = self.merge_journal_access_lists(&params.journal_ids);
        let result = self.run_simulate(&tx, cached_access_list);
        for journal_id in &params.journal_ids {
            self.journals[journal_id].write(self.evm.0.ctx.journaled_state.db_mut(), Image::Post);
        }
        result
    }

    fn read_storage(&self, params: &ReadStorageParams) -> Result<BTreeMap<String, String>, String> {
        let address = parse_address(&params.address)?;
        let db = self.evm.0.ctx.journaled_state.db();
        params
            .slots
            .iter()
            .map(|slot| {
                let slot = parse_u256(slot)?;
                let value = db
                    .storage_ref(address, slot)
                    .map_err(|e| format!("storage_ref: {e:?}"))?;
                Ok((format_u256(slot), format_u256(value)))
            })
            .collect()
    }

    fn ensure_journal_ids(&self, journal_ids: &[u64]) -> Result<(), String> {
        match journal_ids
            .iter()
            .find(|id| !self.journals.contains_key(id))
        {
            Some(id) => Err(format!("unknown journal id: {id}")),
            None => Ok(()),
        }
    }

    // Runs the tx and takes its post-state out of revm's journal, even when
    // the run fails, so no run leaves state behind for the next one. Execute
    // commits the state it gets back; every other run drops it. finalize is
    // the only way to drop it: transact_one commits the tx on success, which
    // clears revm's revert log.
    fn run_tx(
        &mut self,
        tx: &TxRequest,
        access_list: AccessList,
    ) -> Result<(TxResult, EvmState), String> {
        self.evm.0.inspector.clear();
        let result = self.evm.inspect_one_tx(tx.tx_env(access_list));
        let state = self.evm.finalize();
        let result = result.map_err(|e| format!("transact: {e:?}"))?;
        Ok((result, state))
    }

    // Lists the accounts and slots the tx touched, leaving out accounts the
    // chain already warms: the sender, the recipient, the coinbase, and
    // precompiles.
    fn discovered_access_list(&self, tx: &TxRequest, state: &EvmState) -> AccessList {
        let precompiles = self.evm.0.ctx.journaled_state.precompile_addresses();
        let coinbase = self.evm.0.ctx.block.beneficiary;
        let is_warm = |address: &Address| {
            *address == tx.from
                || *address == tx.to
                || *address == coinbase
                || precompiles.contains(address)
        };
        AccessList(
            state
                .iter()
                .filter(|(address, account)| !account.storage.is_empty() || !is_warm(address))
                .map(|(address, account)| AccessListItem {
                    address: *address,
                    storage_keys: account
                        .storage
                        .keys()
                        .map(|slot| B256::from(slot.to_be_bytes()))
                        .collect(),
                })
                .collect(),
        )
    }

    fn run_simulate(
        &mut self,
        tx: &TxRequest,
        cached_access_list: Option<AccessList>,
    ) -> Result<SimulateOk, String> {
        let access_list = match cached_access_list {
            Some(access_list) => access_list,
            None => {
                let (_, state) = self.run_tx(tx, AccessList::default())?;
                self.discovered_access_list(tx, &state)
            }
        };

        let (result, _) = self.run_tx(tx, access_list.clone())?;
        let outcome = tx_outcome(&result, &access_list);
        let gas_limit = if outcome.success() {
            result.tx_gas_used() + self.evm.0.inspector.gas_reserve
        } else {
            result.tx_gas_used()
        };
        Ok(SimulateOk { outcome, gas_limit })
    }

    fn merge_journal_access_lists(&self, journal_ids: &[u64]) -> Option<AccessList> {
        if journal_ids.is_empty() {
            return None;
        }
        let mut merged: BTreeMap<Address, BTreeSet<B256>> = BTreeMap::new();
        for journal_id in journal_ids {
            for item in &self.journals[journal_id].access_list.0 {
                merged
                    .entry(item.address)
                    .or_default()
                    .extend(&item.storage_keys);
            }
        }
        Some(AccessList(
            merged
                .into_iter()
                .map(|(address, keys)| AccessListItem {
                    address,
                    storage_keys: keys.into_iter().collect(),
                })
                .collect(),
        ))
    }
}

// -----------------------------------------------------------------------------
// Conversion helpers

fn tx_outcome(result: &TxResult, access_list: &AccessList) -> TxOutcome {
    let status = match result {
        ExecutionResult::Success { .. } => TxStatus::Success,
        ExecutionResult::Revert { output, .. } => TxStatus::Revert {
            data: format_bytes(output),
        },
        ExecutionResult::Halt { reason, .. } => TxStatus::Halt {
            reason: format!("{reason:?}"),
        },
    };
    TxOutcome {
        status,
        gas_used: result.tx_gas_used(),
        access_list: encode_access_list(access_list),
    }
}

fn encode_access_list(list: &AccessList) -> Vec<AccessListEntry> {
    let mut entries: Vec<AccessListEntry> = list
        .0
        .iter()
        .map(|item| {
            let mut storage_keys: Vec<String> = item
                .storage_keys
                .iter()
                .map(|key| format_bytes(key.as_slice()))
                .collect();
            storage_keys.sort();
            AccessListEntry {
                address: format!("{:#x}", item.address),
                storage_keys,
            }
        })
        .collect();
    entries.sort_by(|a, b| a.address.cmp(&b.address));
    entries
}

fn collect_slot_writes(state: &EvmState, address: Address) -> Vec<SlotWriteEntry> {
    let Some(account) = state.get(&address) else {
        return Vec::new();
    };
    let mut writes: Vec<SlotWriteEntry> = account
        .storage
        .iter()
        .filter(|(_, value)| value.original_value() != value.present_value())
        .map(|(slot, value)| SlotWriteEntry {
            slot: format_u256(*slot),
            value: format_u256(value.present_value()),
        })
        .collect();
    writes.sort_by(|a, b| a.slot.cmp(&b.slot));
    writes
}

fn parse_address(s: &str) -> Result<Address, String> {
    let bytes =
        hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(|e| format!("bad address: {e}"))?;
    Address::try_from(bytes.as_slice()).map_err(|_| format!("bad address length: {}", bytes.len()))
}

fn parse_bytes(s: &str) -> Result<Bytes, String> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .map(Bytes::from)
        .map_err(|e| format!("bad bytes: {e}"))
}

fn parse_u256(s: &str) -> Result<U256, String> {
    match s.strip_prefix("0x").unwrap_or(s) {
        "" => Ok(U256::ZERO),
        digits => U256::from_str_radix(digits, 16).map_err(|e| format!("bad u256: {e}")),
    }
}

fn format_u256(value: U256) -> String {
    format_bytes(&value.to_be_bytes::<32>())
}

fn format_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

// The runtime orders txs and accounts for gas and balances itself, so these
// checks would only reject txs it has already accepted.
fn relax_cfg(cfg: &mut MonadCfgEnv) {
    cfg.0.disable_nonce_check = true;
    cfg.0.disable_balance_check = true;
    cfg.0.disable_base_fee = true;
    cfg.0.tx_gas_limit_cap = Some(u64::MAX);
}

fn parse_spec(s: &str) -> Option<MonadHardfork> {
    match s {
        "MonadEight" => Some(MonadHardfork::MonadEight),
        "MonadNine" => Some(MonadHardfork::MonadNine),
        "MonadTen" => Some(MonadHardfork::MonadTen),
        "MonadNext" => Some(MonadHardfork::MonadNext),
        _ => None,
    }
}

// -----------------------------------------------------------------------------
// Dispatch

#[derive(Serialize)]
struct Response<T: Serialize> {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct EmptyResult {}

// Never fails, so the FFI boundary stays infallible.
pub fn dispatch_json(harness: &mut EvmHarness, request_json: &str) -> String {
    let request = match serde_json::from_str::<Request>(request_json) {
        Ok(request) => request,
        Err(e) => return respond::<EmptyResult>(0, Err(format!("parse error: {e}"))),
    };
    let empty = |result: Result<(), String>| result.map(|()| EmptyResult {});
    match request {
        Request::SetBlockContext { id, params } => {
            respond(id, empty(harness.set_block_context(&params)))
        }
        Request::Execute { id, params } => respond(id, harness.execute(&params)),
        Request::Simulate { id, params } => respond(id, harness.simulate(&params)),
        Request::ReadStorage { id, params } => respond(id, harness.read_storage(&params)),
        Request::RevertJournals { id, params } => {
            respond(id, empty(harness.revert_journals(&params)))
        }
        Request::PruneJournals { id, params } => {
            respond(id, empty(harness.prune_journals(&params)))
        }
    }
}

fn respond<T: Serialize>(id: u64, result: Result<T, String>) -> String {
    let (result, error) = match result {
        Ok(result) => (Some(result), None),
        Err(error) => (None, Some(error)),
    };
    let response = Response {
        id,
        ok: error.is_none(),
        result,
        error,
    };
    serde_json::to_string(&response)
        .unwrap_or_else(|_| r#"{"id":0,"ok":false,"error":"response serialize error"}"#.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALLER: u16 = 0xca11;
    const CONTRACT: u16 = 0x0c01;
    const CALLEE: u16 = 0x0c02;
    const INNER: u16 = 0x0c03;

    // PUSH1 0 DUP1 SLOAD PUSH1 1 ADD SWAP1 SSTORE STOP.
    const COUNTER: &[u8] = &[0x60, 0x00, 0x80, 0x54, 0x60, 0x01, 0x01, 0x90, 0x55, 0x00];
    const CALL: u8 = 0xf1;
    const STATICCALL: u8 = 0xfa;
    const GAS: &[u8] = &[0x5a];

    fn address(n: u16) -> Address {
        let mut bytes = [0u8; 20];
        bytes[18..].copy_from_slice(&n.to_be_bytes());
        Address::from(bytes)
    }

    // Calls `target` with no calldata and the `gas` operand.
    fn call(op: u8, target: u16, gas: &[u8]) -> Vec<u8> {
        let mut code = [0x60, 0x00].repeat(if op == CALL { 5 } else { 4 });
        code.push(0x73);
        code.extend_from_slice(address(target).as_slice());
        code.extend_from_slice(gas);
        code.push(op);
        code
    }

    // Reverts unless the call succeeded, then stops.
    fn require_success(mut code: Vec<u8>) -> Vec<u8> {
        let revert = u8::try_from(code.len() + 5).unwrap();
        code.extend_from_slice(&[0x15, 0x60, revert, 0x57, 0x00, 0x5b, 0x60, 0x00, 0x80, 0xfd]);
        code
    }

    fn harness(accounts: &[(u16, &[u8])]) -> EvmHarness {
        let accounts: serde_json::Map<String, serde_json::Value> = accounts
            .iter()
            .map(|(account, code)| {
                (
                    format!("{:#x}", address(*account)),
                    serde_json::json!({ "code": format_bytes(code) }),
                )
            })
            .collect();
        let params = serde_json::from_value(serde_json::json!({ "accounts": accounts })).unwrap();
        EvmHarness::new(&params).unwrap()
    }

    fn tx(harness: &EvmHarness) -> TxRequest {
        TxRequest {
            from: address(CALLER),
            to: address(CONTRACT),
            data: Bytes::new(),
            value: U256::ZERO,
            chain_id: harness.evm.0.ctx.cfg.0.chain_id,
        }
    }

    fn simulate(harness: &mut EvmHarness) -> Result<SimulateOk, String> {
        let tx = tx(harness);
        harness.run_simulate(&tx, Some(AccessList::default()))
    }

    fn succeeds_at(harness: &mut EvmHarness, gas_limit: u64) -> bool {
        let mut tx_env = tx(harness).tx_env(AccessList::default());
        tx_env.gas_limit = gas_limit;
        let result = harness.evm.inspect_one_tx(tx_env).unwrap();
        let _ = harness.evm.finalize();
        matches!(result, ExecutionResult::Success { .. })
    }

    // The tx fails at gas_used and succeeds at the simulated limit.
    fn assert_reserve_needed(accounts: &[(u16, &[u8])]) {
        let mut harness = harness(accounts);
        let result = simulate(&mut harness).unwrap();
        assert!(result.outcome.success());
        assert!(!succeeds_at(&mut harness, result.outcome.gas_used));
        assert!(succeeds_at(&mut harness, result.gas_limit));
    }

    #[test]
    fn basefee_past_u64_is_an_error() {
        let params = BlockParams {
            number: None,
            timestamp: None,
            basefee: Some(format!("{:#x}", U256::MAX)),
            coinbase: None,
        };
        assert!(harness(&[]).set_block_context(&params).is_err());
    }

    #[test]
    fn reserve_covers_sstore_sentry() {
        // PUSH1 0 SLOAD PUSH1 0 SSTORE STOP: the warm no-op SSTORE costs less
        // than the 2,301 gas that must remain before it.
        assert_reserve_needed(&[(CONTRACT, &[0x60, 0x00, 0x54, 0x60, 0x00, 0x55, 0x00])]);
    }

    #[test]
    fn reserve_covers_precompile_calls() {
        for precompile in [0x01, 0x100] {
            let code = require_success(call(STATICCALL, precompile, GAS));
            assert_reserve_needed(&[(CONTRACT, &code)]);
        }
    }

    #[test]
    fn reserve_covers_nested_calls() {
        let outer = require_success(call(CALL, CALLEE, GAS));
        let middle = require_success(call(CALL, INNER, GAS));
        assert_reserve_needed(&[(CONTRACT, &outer), (CALLEE, &middle), (INNER, COUNTER)]);
    }

    #[test]
    fn reserve_covers_caught_halt() {
        // ecrecover with 1 gas halts; the caller ignores the failure.
        let mut code = call(STATICCALL, 0x01, &[0x60, 0x01]);
        code.push(0x00);
        let mut harness = harness(&[(CONTRACT, &code)]);
        let result = simulate(&mut harness).unwrap();
        assert!(result.outcome.success());
        assert!(succeeds_at(&mut harness, result.gas_limit));
    }
}
