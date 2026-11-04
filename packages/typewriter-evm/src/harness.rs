use std::collections::{BTreeMap, HashMap};

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
        JournalTr,
    },
    database::InMemoryDB,
    inspector::InspectEvm,
    interpreter::{
        interpreter::EthInterpreter,
        interpreter_types::{Jumps, MemoryTr},
        Interpreter,
    },
    primitives::{
        alloy_primitives::{B512, U64},
        Address, Bytes, TxKind, B256, U256,
    },
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
    ReadStorage { id: u64, params: ReadStorageParams },
    RevertJournals { id: u64, params: JournalIdsParams },
    PruneJournals { id: u64, params: JournalIdsParams },
}

#[derive(Deserialize)]
struct InitParams {
    spec: Option<MonadHardfork>,
    chain_id: Option<u64>,
    block: Option<BlockParams>,
    #[serde(default)]
    accounts: BTreeMap<Address, AccountParams>,
}

#[derive(Deserialize)]
struct BlockParams {
    number: Option<U256>,
    timestamp: Option<U256>,
    basefee: Option<U64>,
    coinbase: Option<Address>,
}

#[derive(Deserialize)]
struct AccountParams {
    #[serde(default)]
    balance: U256,
    #[serde(default)]
    nonce: u64,
    code: Option<Bytes>,
    #[serde(default)]
    storage: BTreeMap<U256, U256>,
}

#[derive(Deserialize)]
struct ExecuteParams {
    from: Address,
    to: Address,
    data: Bytes,
    #[serde(default)]
    value: U256,
}

impl ExecuteParams {
    fn tx_env(&self, chain_id: u64, access_list: AccessList) -> TxEnv {
        TxEnv::builder()
            .caller(self.from)
            .chain_id(Some(chain_id))
            .kind(TxKind::Call(self.to))
            .gas_limit(u64::MAX)
            .gas_price(0)
            .value(self.value)
            .data(self.data.clone())
            .access_list(access_list)
            .build_fill()
    }
}

#[derive(Deserialize)]
struct ReadStorageParams {
    address: Address,
    slots: Vec<U256>,
}

#[derive(Deserialize)]
struct JournalIdsParams {
    journal_ids: Vec<u64>,
}

/// Slots and values are B256, not U256: U256 serializes without leading
/// zeros, and the runtime matches slots as 32-byte hex.
#[derive(Serialize)]
struct TxOutcome {
    #[serde(flatten)]
    status: TxStatus,
    gas_used: u64,
    /// Sorted by address, then storage key.
    access_list: AccessList,
    /// The hardfork it executed under.
    spec: MonadHardfork,
}

impl TxOutcome {
    fn success(&self) -> bool {
        matches!(self.status, TxStatus::Success)
    }
}

/// A halt is a failure other than REVERT, such as out of gas or an invalid
/// opcode. It returns no data and uses all the gas the frame was given.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TxStatus {
    Success,
    Revert {
        data: Bytes,
    },
    /// The HaltReason's Debug name, e.g. `InvalidFEOpcode`. HaltReason's own
    /// serde form is an object for some reasons, such as out of gas.
    Halt {
        reason: String,
    },
}

/// gas_used is with cold access: execute warms no access list.
#[derive(Serialize)]
struct ExecuteOk {
    #[serde(flatten)]
    outcome: TxOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal_id: Option<u64>,
    /// Writes to the called contract, sorted by slot.
    slot_writes: Vec<SlotWrite>,
    /// The 64-byte KECCAK256 inputs: a mapping key and the mapping's slot.
    keccak_preimages: Vec<B512>,
}

#[derive(Serialize)]
struct SlotWrite {
    slot: B256,
    value: B256,
}

// -----------------------------------------------------------------------------
// Inspector

type MonadCtx = monad_revm::api::default_ctx::MonadContext<InMemoryDB>;
type Evm = monad_revm::api::builder::DefaultMonadEvm<MonadCtx, HarnessInspector>;
type TxResult = ExecutionResult<HaltReason>;

#[derive(Default)]
struct HarnessInspector {
    keccak_preimages: Vec<B512>,
}

impl HarnessInspector {
    fn clear(&mut self) {
        *self = Self::default();
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
        let mut preimage = B512::ZERO;
        let memory_size = interp.memory.size();
        if offset < memory_size {
            let copied = (memory_size - offset).min(64);
            preimage[..copied].copy_from_slice(&interp.memory.slice_len(offset, copied));
        }
        self.keccak_preimages.push(preimage);
    }
}

// -----------------------------------------------------------------------------
// Harness

/// revm clears its own journal when a tx succeeds, so each tx's pre-images
/// are kept here to undo it later.
#[derive(Default)]
struct Journal {
    accounts: HashMap<Address, AccountInfo>,
    storage: HashMap<(Address, U256), U256>,
}

impl Journal {
    fn from_state(state: &EvmState) -> Self {
        let mut journal = Journal::default();
        for (address, account) in state {
            journal.accounts.insert(*address, account.original_info());
            // Only writes: undoing a slot the tx just read would overwrite
            // what a later tx, whose journal stays, wrote to it.
            for (slot, value) in account
                .storage
                .iter()
                .filter(|(_, value)| value.is_changed())
            {
                journal
                    .storage
                    .insert((*address, *slot), value.original_value());
            }
        }
        journal
    }

    fn undo(&self, db: &mut InMemoryDB) {
        for (address, info) in &self.accounts {
            db.insert_account_info(*address, info.clone());
        }
        for ((address, slot), value) in &self.storage {
            let Ok(()) = db.insert_account_storage(*address, *slot, *value);
        }
    }
}

pub struct EvmHarness {
    evm: Evm,
    /// The caller's hardfork. Without one, the hardfork follows the chain's
    /// schedule at the block timestamp.
    pinned_spec: Option<MonadHardfork>,
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
            pinned_spec: params.spec,
            journals: HashMap::new(),
            next_journal_id: 1,
        };
        harness.init(params)?;
        Ok(harness)
    }

    fn init(&mut self, params: &InitParams) -> Result<(), String> {
        if let Some(chain_id) = params.chain_id {
            self.evm.0.ctx.cfg.0.chain_id = chain_id;
        }
        match &params.block {
            Some(block) => self.set_block_context(block)?,
            None => self.update_spec()?,
        }
        let db = self.evm.0.ctx.journaled_state.db_mut();
        for (&address, account) in &params.accounts {
            let mut info = AccountInfo {
                balance: account.balance,
                nonce: account.nonce,
                ..Default::default()
            };
            if let Some(code) = &account.code {
                info = info.with_code(Bytecode::new_raw(code.clone()));
            }
            db.insert_account_info(address, info);
            for (&slot, &value) in &account.storage {
                let Ok(()) = db.insert_account_storage(address, slot, value);
            }
        }
        Ok(())
    }

    fn set_block_context(&mut self, params: &BlockParams) -> Result<(), String> {
        let block = &mut self.evm.0.ctx.block;
        if let Some(number) = params.number {
            block.number = number;
        }
        if let Some(timestamp) = params.timestamp {
            block.timestamp = timestamp;
        }
        if let Some(basefee) = params.basefee {
            block.basefee = basefee.to();
        }
        if let Some(coinbase) = params.coinbase {
            block.beneficiary = coinbase;
        }
        self.update_spec()
    }

    /// Switches to the pinned hardfork, or else to the chain's hardfork at the
    /// block timestamp. Fails on a chain without a known schedule, so a
    /// non-Monad chain never runs with Monad's gas and precompiles.
    fn update_spec(&mut self) -> Result<(), String> {
        let chain_id = self.evm.0.ctx.cfg.0.chain_id;
        let spec = match self.pinned_spec {
            Some(spec) => spec,
            None => {
                let timestamp = self.evm.0.ctx.block.timestamp.saturating_to();
                MonadHardfork::from_chain_and_timestamp(chain_id, timestamp).ok_or_else(|| {
                    format!("chain {chain_id} has no known Monad hardfork schedule; pass a spec")
                })?
            }
        };
        if spec == self.evm.0.ctx.cfg.0.spec {
            return Ok(());
        }
        // MonadEvm reads the spec from the cfg on every frame, so replacing the
        // cfg also switches its instructions and precompiles.
        let mut cfg = MonadCfgEnv::new_with_spec(spec).with_chain_id(chain_id);
        relax_cfg(&mut cfg);
        self.evm.0.ctx.cfg = cfg;
        self.evm.0.ctx.journaled_state.set_spec_id(spec.into());
        Ok(())
    }

    fn revert_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_journal_ids(&params.journal_ids)?;
        for journal_id in params.journal_ids.iter().rev() {
            let journal = self.journals.remove(journal_id).expect("validated above");
            journal.undo(self.evm.0.ctx.journaled_state.db_mut());
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

    fn execute(&mut self, tx: &ExecuteParams) -> Result<ExecuteOk, String> {
        let (result, state) = self.run_tx(tx, AccessList::default())?;
        let access_list = self.discovered_access_list(tx, &state);
        let outcome = tx_outcome(&result, access_list, self.evm.0.ctx.cfg.0.spec);
        let keccak_preimages = std::mem::take(&mut self.evm.0.inspector.keccak_preimages);
        if !outcome.success() {
            return Ok(ExecuteOk {
                outcome,
                journal_id: None,
                slot_writes: Vec::new(),
                keccak_preimages,
            });
        }

        let slot_writes = collect_slot_writes(&state, tx.to);
        let journal = Journal::from_state(&state);
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

    fn read_storage(&self, params: &ReadStorageParams) -> BTreeMap<B256, B256> {
        let db = self.evm.0.ctx.journaled_state.db();
        params
            .slots
            .iter()
            .map(|&slot| {
                let Ok(value) = db.storage_ref(params.address, slot);
                (slot.into(), value.into())
            })
            .collect()
    }

    /// Checks every id before a request changes anything, so a request with an
    /// unknown id has no effect.
    fn ensure_journal_ids(&self, journal_ids: &[u64]) -> Result<(), String> {
        match journal_ids
            .iter()
            .find(|id| !self.journals.contains_key(id))
        {
            Some(id) => Err(format!("unknown journal id: {id}")),
            None => Ok(()),
        }
    }

    /// Runs the tx and takes its post-state out of revm's journal, even when
    /// the run fails, so no run leaves state behind for the next one. Execute
    /// commits the state it gets back; every other run drops it. finalize is
    /// the only way to drop it: transact_one commits the tx on success, which
    /// clears revm's revert log.
    fn run_tx(
        &mut self,
        tx: &ExecuteParams,
        access_list: AccessList,
    ) -> Result<(TxResult, EvmState), String> {
        self.evm.0.inspector.clear();
        let tx_env = tx.tx_env(self.evm.0.ctx.cfg.0.chain_id, access_list);
        let result = self.evm.inspect_one_tx(tx_env);
        let state = self.evm.finalize();
        let result = result.map_err(|e| format!("transact: {e:?}"))?;
        Ok((result, state))
    }

    /// Lists the accounts and slots the tx touched, leaving out accounts the
    /// chain already warms: the sender, the recipient, the coinbase, and
    /// precompiles.
    fn discovered_access_list(&self, tx: &ExecuteParams, state: &EvmState) -> AccessList {
        let precompiles = self.evm.0.ctx.journaled_state.precompile_addresses();
        let coinbase = self.evm.0.ctx.block.beneficiary;
        let is_warm = |address: &Address| {
            *address == tx.from
                || *address == tx.to
                || *address == coinbase
                || precompiles.contains(address)
        };
        // EvmState is a HashMap, so sort for a stable order.
        let mut items: Vec<AccessListItem> = state
            .iter()
            .filter(|(address, account)| !account.storage.is_empty() || !is_warm(address))
            .map(|(&address, account)| {
                let mut storage_keys: Vec<B256> =
                    account.storage.keys().map(|&slot| slot.into()).collect();
                storage_keys.sort();
                AccessListItem {
                    address,
                    storage_keys,
                }
            })
            .collect();
        items.sort_by_key(|item| item.address);
        AccessList(items)
    }
}

// -----------------------------------------------------------------------------
// Conversion helpers

fn tx_outcome(result: &TxResult, access_list: AccessList, spec: MonadHardfork) -> TxOutcome {
    let status = match result {
        ExecutionResult::Success { .. } => TxStatus::Success,
        ExecutionResult::Revert { output, .. } => TxStatus::Revert {
            data: output.clone(),
        },
        ExecutionResult::Halt { reason, .. } => TxStatus::Halt {
            reason: format!("{reason:?}"),
        },
    };
    TxOutcome {
        status,
        gas_used: result.tx_gas_used(),
        access_list,
        spec,
    }
}

fn collect_slot_writes(state: &EvmState, address: Address) -> Vec<SlotWrite> {
    let Some(account) = state.get(&address) else {
        return Vec::new();
    };
    let mut writes: Vec<SlotWrite> = account
        .storage
        .iter()
        .filter(|(_, value)| value.original_value() != value.present_value())
        .map(|(&slot, value)| SlotWrite {
            slot: slot.into(),
            value: value.present_value().into(),
        })
        .collect();
    writes.sort_by_key(|write| write.slot);
    writes
}

/// The runtime orders txs and accounts for gas and balances itself, so these
/// checks would only reject txs it has already accepted.
fn relax_cfg(cfg: &mut MonadCfgEnv) {
    cfg.0.disable_nonce_check = true;
    cfg.0.disable_balance_check = true;
    cfg.0.disable_base_fee = true;
    cfg.0.tx_gas_limit_cap = Some(u64::MAX);
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

#[derive(Deserialize)]
struct RequestId {
    id: u64,
}

/// Never fails, so the FFI boundary stays infallible.
pub fn dispatch_json(harness: &mut EvmHarness, request_json: &str) -> String {
    let request = match serde_json::from_str::<Request>(request_json) {
        Ok(request) => request,
        Err(e) => {
            // Bad params fail the whole parse. Answer with the request's id
            // when it has one, so the caller can match the error to its call.
            let id =
                serde_json::from_str::<RequestId>(request_json).map_or(0, |request| request.id);
            return respond::<EmptyResult>(id, Err(format!("parse error: {e}")));
        }
    };
    let empty = |result: Result<(), String>| result.map(|()| EmptyResult {});
    match request {
        Request::SetBlockContext { id, params } => {
            respond(id, empty(harness.set_block_context(&params)))
        }
        Request::Execute { id, params } => respond(id, harness.execute(&params)),
        Request::ReadStorage { id, params } => respond(id, Ok(harness.read_storage(&params))),
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

    /// PUSH1 0 DUP1 SLOAD PUSH1 1 ADD SWAP1 SSTORE STOP.
    const COUNTER: &[u8] = &[0x60, 0x00, 0x80, 0x54, 0x60, 0x01, 0x01, 0x90, 0x55, 0x00];

    fn address(n: u16) -> Address {
        let mut bytes = [0u8; 20];
        bytes[18..].copy_from_slice(&n.to_be_bytes());
        Address::from(bytes)
    }

    fn harness(accounts: &[(u16, &[u8])]) -> EvmHarness {
        let accounts = accounts
            .iter()
            .map(|&(account, code)| {
                let account_params = AccountParams {
                    balance: U256::ZERO,
                    nonce: 0,
                    code: Some(Bytes::copy_from_slice(code)),
                    storage: BTreeMap::new(),
                };
                (address(account), account_params)
            })
            .collect();
        EvmHarness::new(&InitParams {
            spec: Some(MonadHardfork::MonadTen),
            chain_id: None,
            block: None,
            accounts,
        })
        .unwrap()
    }

    fn tx() -> ExecuteParams {
        ExecuteParams {
            from: address(CALLER),
            to: address(CONTRACT),
            data: Bytes::new(),
            value: U256::ZERO,
        }
    }

    #[test]
    fn bad_params_answer_with_the_request_id() {
        let request = r#"{"method":"readStorage","id":7,"params":{"address":"0x12","slots":[]}}"#;
        let response: serde_json::Value =
            serde_json::from_str(&dispatch_json(&mut harness(&[]), request)).unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn revert_keeps_later_writes_to_slots_the_journal_read() {
        // CALLDATASIZE PUSH1 9 JUMPI, then with no calldata PUSH1 0 SLOAD POP
        // STOP, else JUMPDEST and COUNTER.
        let mut code = vec![0x36, 0x60, 0x09, 0x57, 0x60, 0x00, 0x54, 0x50, 0x00, 0x5b];
        code.extend_from_slice(COUNTER);
        let mut harness = harness(&[(CONTRACT, &code)]);

        let read = harness.execute(&tx()).unwrap().journal_id.unwrap();
        let write = ExecuteParams {
            data: Bytes::from_static(&[0x01]),
            ..tx()
        };
        let write = harness.execute(&write).unwrap().journal_id.unwrap();
        harness
            .prune_journals(&JournalIdsParams {
                journal_ids: vec![write],
            })
            .unwrap();
        harness
            .revert_journals(&JournalIdsParams {
                journal_ids: vec![read],
            })
            .unwrap();

        let storage = harness.read_storage(&ReadStorageParams {
            address: address(CONTRACT),
            slots: vec![U256::ZERO],
        });
        assert_eq!(storage[&B256::ZERO], B256::from(U256::from(1)));
    }
}
