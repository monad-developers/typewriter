// Shared EVM harness: wire types, the `EvmHarness` over monad-revm, request
// dispatch, and conversion helpers. The native addon (`lib.rs`) is the only
// caller; it owns one `EvmHarness` per instance and forwards JSON through
// `dispatch_json`.
//
// Operations:
//   init           — one-shot setup: spec, chain id, block context, accounts.
//   setBlockContext— update block number, timestamp, basefee, coinbase.
//   execute        — run one tx and store its successful state transition as a
//                    journal identified by a numeric id.
//   simulate       — temporarily undo the given journal ids, run one tx and
//                    trace its gas limit, then re-apply the journals; does
//                    not create/modify journals.
//   readStorage    — read raw account storage slots from the in-memory DB.
//   revertJournals — revert and delete the given journal ids.
//   pruneJournals  — delete the given journal ids without touching state.

use std::collections::{BTreeMap, HashMap};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadHardfork,
};
use revm::{
    bytecode::opcode,
    context::TxEnv,
    context_interface::{
        cfg::GasParams,
        result::{ExecutionResult, HaltReason, Output},
        transaction::{AccessList, AccessListItem},
        Host, JournalTr,
    },
    database::InMemoryDB,
    inspector::InspectEvm,
    interpreter::{
        interpreter::EthInterpreter,
        interpreter_types::{Jumps, LoopControl, MemoryTr},
        CallInputs, CallOutcome, CallValue, CreateInputs, CreateOutcome, Interpreter,
        InterpreterAction, InterpreterResult,
    },
    primitives::{Address, AddressSet, Bytes, TxKind, B256, U256},
    state::{AccountInfo, Bytecode},
    DatabaseRef, ExecuteCommitEvm, ExecuteEvm, Inspector,
};
use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Wire types

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum Request {
    Init { id: u64, params: InitParams },
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
struct OkResponse<T: Serialize> {
    id: u64,
    ok: bool,
    result: T,
}

#[derive(Serialize)]
struct ErrorResponse {
    id: u64,
    ok: bool,
    error: String,
}

#[derive(Serialize)]
struct EmptyResult {}

const EMPTY_RESULT: EmptyResult = EmptyResult {};

const RESPONSE_SERIALIZE_ERROR: &str = r#"{"id":0,"ok":false,"error":"response serialize error"}"#;

fn serialize_response<T: Serialize>(response: &T) -> String {
    serde_json::to_string(response).unwrap_or_else(|_| RESPONSE_SERIALIZE_ERROR.into())
}

// Fields that execute and simulate both return.
#[derive(Serialize)]
struct TxOutcome {
    success: bool,
    gas_used: u64,
    output: String,
    access_list: Vec<AccessListEntry>,
    keccak_preimages: Vec<KeccakPreimageEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revert_data: Option<String>,
}

// gas_used is the gas with cold access. Execute does not warm an access list.
#[derive(Serialize)]
struct ExecuteOk {
    #[serde(flatten)]
    outcome: TxOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal_id: Option<u64>,
    slot_writes: Vec<SlotWriteEntry>,
}

// gas_used is the gas with the access list warm, as the chain charges it.
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
    address: String,
    slot: String,
    prev_value: String,
    new_value: String,
}

#[derive(Serialize)]
struct KeccakPreimageEntry {
    hash: String,
    preimage: String,
}

// -----------------------------------------------------------------------------
// Harness

type MonadCtx = monad_revm::api::default_ctx::MonadContext<InMemoryDB>;

type Evm = monad_revm::api::builder::DefaultMonadEvm<MonadCtx, HarnessInspector>;

type TxResult = ExecutionResult<HaltReason>;

#[derive(Default)]
struct HarnessInspector {
    keccak_preimages: Vec<RawKeccakPreimage>,
    gas: GasLimitTracker,
}

struct RawKeccakPreimage {
    hash: B256,
    preimage: Vec<u8>,
}

impl HarnessInspector {
    fn clear(&mut self) {
        self.keccak_preimages.clear();
    }

    fn wire_preimages(&self) -> Vec<KeccakPreimageEntry> {
        self.keccak_preimages
            .iter()
            .map(|entry| KeccakPreimageEntry {
                hash: format!("0x{}", hex::encode(entry.hash.as_slice())),
                preimage: format!("0x{}", hex::encode(&entry.preimage)),
            })
            .collect()
    }

    fn record_keccak_preimage(&mut self, interp: &mut Interpreter<EthInterpreter>) {
        let stack = interp.stack.data();
        if stack.len() < 2 {
            return;
        }
        let offset = stack[stack.len() - 1];
        let len = stack[stack.len() - 2];
        if len != U256::from(32) && len != U256::from(64) {
            return;
        }

        let offset = match usize::try_from(offset) {
            Ok(offset) => offset,
            Err(_) => return,
        };
        let len = usize::try_from(len).expect("len checked above");
        let Some(end) = offset.checked_add(len) else {
            return;
        };

        let mut preimage = vec![0; len];
        let memory_size = interp.memory.size();
        if offset < memory_size {
            let copied = memory_size.min(end) - offset;
            preimage[..copied].copy_from_slice(&interp.memory.slice_len(offset, copied));
        }

        self.keccak_preimages.push(RawKeccakPreimage {
            hash: revm::primitives::keccak256(&preimage),
            preimage,
        });
    }
}

impl Inspector<MonadCtx> for HarnessInspector {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, context: &mut MonadCtx) {
        let opcode = interp.bytecode.opcode();
        if opcode == opcode::KECCAK256 {
            self.record_keccak_preimage(interp);
        }
        self.gas.step(opcode, interp, context);
    }

    fn step_end(&mut self, interp: &mut Interpreter<EthInterpreter>, _context: &mut MonadCtx) {
        self.gas.step_end(interp);
    }

    fn call(&mut self, context: &mut MonadCtx, inputs: &mut CallInputs) -> Option<CallOutcome> {
        let transfers_value =
            matches!(inputs.value, CallValue::Transfer(value) if !value.is_zero());
        let stipend = if transfers_value {
            context.gas_params().call_stipend()
        } else {
            0
        };
        self.gas.frame_start(inputs.gas_limit, stipend);
        None
    }

    fn call_end(
        &mut self,
        context: &mut MonadCtx,
        _inputs: &CallInputs,
        outcome: &mut CallOutcome,
    ) {
        self.gas.frame_end(&outcome.result, context.gas_params());
    }

    fn create(
        &mut self,
        _context: &mut MonadCtx,
        inputs: &mut CreateInputs,
    ) -> Option<CreateOutcome> {
        self.gas.frame_start(inputs.gas_limit(), 0);
        None
    }

    fn create_end(
        &mut self,
        context: &mut MonadCtx,
        _inputs: &CreateInputs,
        outcome: &mut CreateOutcome,
    ) {
        self.gas.frame_end(&outcome.result, context.gas_params());
    }
}

// Traces the smallest gas limit that runs a tx on the same path as a run at
// max gas. The gas used is not enough for two reasons: CALL and CREATE
// forward at most 63/64 of the remaining gas (EIP-150), and SSTORE fails
// unless more than the call stipend remains (EIP-2200). Monad gives no
// refunds, so refunds do not change the limit.
//
// Each frame records the most gas it spent at any point (`need`). When a
// child frame ends, its need becomes a requirement on the gas the parent must
// have left before the call forwards gas. Contracts do not branch on gas, so
// every other charge is the same at each gas limit that keeps this path, and
// intrinsic gas plus the top frame's need is the exact minimum.
//
// A child that halts uses all the gas it gets. At max gas that is almost all
// of u64::MAX, so no gas limit that the chain accepts can run the tx.
#[derive(Default)]
struct GasLimitTracker {
    enabled: bool,
    halted: bool,
    frames: Vec<FrameGas>,
    // The last opcode that `step` saw, so `step_end` knows what ran.
    opcode: u8,
    // Gas the current frame has left after a CALL or CREATE took the gas it
    // forwards. The next `frame_start` uses it.
    remaining_after_forward: Option<u64>,
    top_frame: Option<FrameGas>,
}

#[derive(Clone, Copy)]
struct FrameGas {
    gas_limit: u64,
    need: u64,
    // Gas the parent spent before it forwarded gas to this frame.
    parent_spent: u64,
    stipend: u64,
}

impl GasLimitTracker {
    fn start(&mut self) {
        self.enabled = true;
        self.halted = false;
        self.frames.clear();
        self.remaining_after_forward = None;
        self.top_frame = None;
    }

    fn finish(&mut self, tx_gas_limit: u64) -> Result<u64, String> {
        self.enabled = false;
        if self.halted {
            return Err("a call halted and used all its gas; no gas limit can run the tx".into());
        }
        let top_frame = self
            .top_frame
            .ok_or_else(|| "gas trace has no top frame".to_string())?;
        let intrinsic_gas = tx_gas_limit - top_frame.gas_limit;
        Ok(intrinsic_gas + top_frame.need)
    }

    fn step(&mut self, opcode: u8, interp: &mut Interpreter<EthInterpreter>, context: &MonadCtx) {
        if !self.enabled || interp.bytecode.is_end() {
            return;
        }
        self.opcode = opcode;
        if opcode == opcode::SSTORE {
            if let Some(frame) = self.frames.last_mut() {
                let sentry = interp.gas.total_gas_spent() + context.gas_params().call_stipend() + 1;
                frame.need = frame.need.max(sentry);
            }
        }
    }

    fn step_end(&mut self, interp: &mut Interpreter<EthInterpreter>) {
        if !self.enabled {
            return;
        }
        let Some(frame) = self.frames.last_mut() else {
            return;
        };
        let forwards_gas = matches!(
            self.opcode,
            opcode::CALL
                | opcode::CALLCODE
                | opcode::DELEGATECALL
                | opcode::STATICCALL
                | opcode::CREATE
                | opcode::CREATE2
        ) && matches!(
            interp.bytecode.action(),
            Some(InterpreterAction::NewFrame(_))
        );
        if forwards_gas {
            // The spent gas now includes the forwarded gas. The child returns
            // the gas it does not use, so frame_end records the requirement.
            self.remaining_after_forward = Some(interp.gas.remaining());
        } else {
            frame.need = frame.need.max(interp.gas.total_gas_spent());
        }
    }

    fn frame_start(&mut self, gas_limit: u64, stipend: u64) {
        if !self.enabled {
            return;
        }
        let forwarded = gas_limit - stipend;
        let parent_spent = match (self.frames.last(), self.remaining_after_forward.take()) {
            (Some(parent), Some(remaining)) => parent.gas_limit - (remaining + forwarded),
            _ => 0,
        };
        self.frames.push(FrameGas {
            gas_limit,
            need: 0,
            parent_spent,
            stipend,
        });
    }

    fn frame_end(&mut self, result: &InterpreterResult, gas_params: &GasParams) {
        if !self.enabled {
            return;
        }
        let Some(mut frame) = self.frames.pop() else {
            return;
        };
        // A frame with no bytecode (a precompile or an account with no code)
        // has no steps, so its need is the gas it used.
        frame.need = frame.need.max(frame.gas_limit - result.gas.remaining());
        if !result.result.is_ok_or_revert() {
            self.halted = true;
        }
        match self.frames.last_mut() {
            Some(parent) => {
                let child_gas = frame.need.saturating_sub(frame.stipend);
                let required = frame.parent_spent + min_gas_to_forward(gas_params, child_gas);
                parent.need = parent.need.max(required);
            }
            None => self.top_frame = Some(frame),
        }
    }
}

// The smallest remaining gas from which CALL or CREATE forwards at least
// `child_gas` (EIP-150 keeps 1/64 in the caller).
fn min_gas_to_forward(gas_params: &GasParams, child_gas: u64) -> u64 {
    let forwarded = |gas: u64| gas_params.call_stipend_reduction(gas);
    let mut gas = child_gas.saturating_add(child_gas / 63);
    while gas < u64::MAX && forwarded(gas) < child_gas {
        gas += 1;
    }
    while gas > 0 && forwarded(gas - 1) >= child_gas {
        gas -= 1;
    }
    gas
}

// Per-journal pre/post-image record. REVM's transaction execution clears its
// internal journal log on success, so cross-tx isolation has to live in
// userland: we capture pre-images on first touch within a journal, post-
// images each time. revertJournals writes pre-images back; simulate
// un-applies uncommitted journals, runs the simulation, re-applies them.
#[derive(Default)]
struct Journal {
    accounts: HashMap<Address, (AccountInfo, AccountInfo)>,
    storage: HashMap<(Address, U256), (U256, U256)>,
    access_list: AccessList,
}

pub struct EvmHarness {
    evm: Evm,
    journals: HashMap<u64, Journal>,
    next_journal_id: u64,
    initialized: bool,
}

impl EvmHarness {
    pub fn new() -> Self {
        let mut ctx = monad_context_with_db(InMemoryDB::default());
        relax_cfg(&mut ctx.cfg);
        let evm = ctx.build_monad_with_inspector(HarnessInspector::default());
        Self {
            evm,
            journals: HashMap::new(),
            next_journal_id: 1,
            initialized: false,
        }
    }

    fn init(&mut self, params: &InitParams) -> Result<(), String> {
        if self.initialized {
            return Err("init already called".into());
        }
        if let Some(spec) = params.spec.as_deref() {
            let s = parse_spec(spec).ok_or_else(|| format!("unknown spec: {spec}"))?;
            let mut cfg = MonadCfgEnv::new_with_spec(s);
            relax_cfg(&mut cfg);
            self.evm.0.ctx.cfg = cfg;
            self.evm.0.ctx.journaled_state.set_spec_id(s.into());
        }
        if let Some(id) = params.chain_id {
            self.evm.0.ctx.cfg.0.chain_id = id;
        }
        if let Some(block) = &params.block {
            self.apply_block_params(block)?;
        }
        if let Some(accounts) = &params.accounts {
            let db = self.evm.0.ctx.journaled_state.db_mut();
            for (addr_str, acc) in accounts {
                let address = parse_address(addr_str)?;
                let mut info = AccountInfo {
                    balance: match acc.balance.as_deref() {
                        Some(b) => parse_u256(b)?,
                        None => U256::ZERO,
                    },
                    nonce: acc.nonce.unwrap_or(0),
                    ..Default::default()
                };
                if let Some(code_hex) = acc.code.as_deref() {
                    info = info.with_code(Bytecode::new_raw(parse_bytes(code_hex)?));
                }
                db.insert_account_info(address, info);
                if let Some(storage) = &acc.storage {
                    for (slot_str, value_str) in storage {
                        let slot = parse_u256(slot_str)?;
                        let value = parse_u256(value_str)?;
                        db.insert_account_storage(address, slot, value)
                            .map_err(|e| format!("insert_account_storage: {e:?}"))?;
                    }
                }
            }
        }
        self.initialized = true;
        Ok(())
    }

    fn set_block_context(&mut self, params: &BlockParams) -> Result<(), String> {
        self.ensure_initialized()?;
        self.apply_block_params(params)
    }

    fn apply_block_params(&mut self, block: &BlockParams) -> Result<(), String> {
        let b = &mut self.evm.0.ctx.block;
        if let Some(n) = &block.number {
            b.number = parse_u256(n)?;
        }
        if let Some(t) = &block.timestamp {
            b.timestamp = parse_u256(t)?;
        }
        if let Some(f) = &block.basefee {
            b.basefee = parse_u256(f)?.to::<u64>();
        }
        if let Some(c) = &block.coinbase {
            b.beneficiary = parse_address(c)?;
        }
        Ok(())
    }

    fn revert_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_initialized()?;
        self.ensure_journal_ids(&params.journal_ids)?;
        let db = self.evm.0.ctx.journaled_state.db_mut();
        for journal_id in params.journal_ids.iter().rev() {
            let journal = self
                .journals
                .remove(journal_id)
                .expect("journal ids validated above");
            rewind(db, &journal);
        }
        Ok(())
    }

    fn prune_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_initialized()?;
        self.ensure_journal_ids(&params.journal_ids)?;
        for journal_id in &params.journal_ids {
            self.journals.remove(journal_id);
        }
        Ok(())
    }

    fn execute(&mut self, params: &ExecuteParams) -> Result<ExecuteOk, String> {
        self.ensure_initialized()?;
        let tx = TxRequest::parse(params, self.evm.0.ctx.cfg.0.chain_id)?;
        // The discovery pass is the only pass. Its post-state is the
        // mutation's state, and the accounts and slots it touched become the
        // journal's access list.
        let (result, access_list) = match self.discovery_pass(&tx) {
            Ok(pass) => pass,
            Err(error) => {
                let _ = self.evm.finalize();
                return Err(error);
            }
        };
        let outcome = self.tx_outcome(&result, &access_list);
        if !outcome.success {
            // A failed tx is observable as a rejection, not as local state.
            // Drain and discard any journal state left by revm.
            let _ = self.evm.finalize();
            return Ok(ExecuteOk {
                outcome,
                journal_id: None,
                slot_writes: Vec::new(),
            });
        }

        let slot_writes = collect_slot_writes(self.evm.0.ctx.journaled_state.evm_state());
        let mut journal = Journal::default();
        self.record_into_journal(&mut journal);
        journal.access_list = access_list;
        // Commit the journaled state into the DB so future reads and
        // writes see the post-tx state.
        self.flush_journal_to_db();
        let journal_id = self.next_journal_id;
        self.next_journal_id += 1;
        self.journals.insert(journal_id, journal);
        Ok(ExecuteOk {
            outcome,
            journal_id: Some(journal_id),
            slot_writes,
        })
    }

    fn simulate(&mut self, params: &SimulateParams) -> Result<SimulateOk, String> {
        self.ensure_initialized()?;
        self.ensure_journal_ids(&params.journal_ids)?;
        let tx = TxRequest::parse(&params.tx, self.evm.0.ctx.cfg.0.chain_id)?;

        {
            let db = self.evm.0.ctx.journaled_state.db_mut();
            for journal_id in params.journal_ids.iter().rev() {
                let journal = self
                    .journals
                    .get(journal_id)
                    .expect("journal ids validated above");
                rewind(db, journal);
            }
        }

        let cached_access_list = self.merge_journal_access_lists(&params.journal_ids);
        let result = self.run_simulate(&tx, cached_access_list);

        // Drop the last pass's journal-state writes so they never reach the DB.
        let _ = self.evm.finalize();

        // Re-apply post-images in caller-provided occurrence order regardless
        // of simulate's success — logical state must be restored.
        {
            let db = self.evm.0.ctx.journaled_state.db_mut();
            for journal_id in &params.journal_ids {
                let journal = self
                    .journals
                    .get(journal_id)
                    .expect("journal ids validated above");
                replay(db, journal);
            }
        }

        result
    }

    fn read_storage(&self, params: &ReadStorageParams) -> Result<BTreeMap<String, String>, String> {
        let address = parse_address(&params.address)?;
        let db = self.evm.0.ctx.journaled_state.db();
        let mut out = BTreeMap::new();
        for slot_str in &params.slots {
            let slot = parse_u256(slot_str)?;
            let value = db
                .storage_ref(address, slot)
                .map_err(|e| format!("storage_ref: {e:?}"))?;
            out.insert(format_u256(slot), format_u256(value));
        }
        Ok(out)
    }

    // Walk the journal's post-tx state and merge it into the output journal:
    //   - record (pre, post) on first sighting of an account/slot
    //   - update only `post` on subsequent sightings (`pre` is already
    //     the journal's earliest-known pre-image).
    fn record_into_journal(&mut self, journal: &mut Journal) {
        let state = self.evm.0.ctx.journaled_state.evm_state();
        for (addr, account) in state.iter() {
            let post_info = account.info.clone();
            let pre_info = account.original_info();
            journal
                .accounts
                .entry(*addr)
                .and_modify(|(_, post)| *post = post_info.clone())
                .or_insert((pre_info, post_info));

            for (slot, slot_state) in account.storage.iter() {
                let pre = slot_state.original_value();
                let post = slot_state.present_value();
                journal
                    .storage
                    .entry((*addr, *slot))
                    .and_modify(|(_, p)| *p = post)
                    .or_insert((pre, post));
            }
        }
    }

    fn flush_journal_to_db(&mut self) {
        let state = self.evm.finalize();
        self.evm.commit(state);
    }

    fn ensure_initialized(&self) -> Result<(), String> {
        if self.initialized {
            Ok(())
        } else {
            Err("not initialized".into())
        }
    }

    fn ensure_journal_ids(&self, journal_ids: &[u64]) -> Result<(), String> {
        for journal_id in journal_ids {
            if !self.journals.contains_key(journal_id) {
                return Err(format!("unknown journal id: {journal_id}"));
            }
        }
        Ok(())
    }

    // Run the tx with no access list at max gas and collect the accounts and
    // slots it touched. The post-state stays live; the caller commits or
    // discards it.
    //
    // Between passes, finalize drains the journal state and we discard it so
    // the next pass starts from the same DB state. The alternative —
    // checkpoint_revert — doesn't work because transact_one calls commit_tx
    // after success, which clears the revertable journal log.
    fn discovery_pass(&mut self, tx: &TxRequest) -> Result<(TxResult, AccessList), String> {
        self.evm.0.inspector.clear();
        let result = self
            .evm
            .inspect_one_tx(tx.tx_env(AccessList::default(), u64::MAX))
            .map_err(|e| format!("transact (discovery pass): {e:?}"))?;
        let journaled_state = &self.evm.0.ctx.journaled_state;
        let access_list = discovered_access_list(
            journaled_state.evm_state(),
            journaled_state.precompile_addresses(),
            tx,
            self.evm.0.ctx.block.beneficiary,
        );
        Ok((result, access_list))
    }

    // Simulate discovers the access list, unless the caller gives one from
    // cached journals. The measured pass runs at max gas with those addresses
    // and slots pre-warmed, so the metered gas matches what the chain charges
    // for a tx sent with that access list. The same pass traces the gas limit.
    // The post-state stays live.
    fn run_simulate(
        &mut self,
        tx: &TxRequest,
        cached_access_list: Option<AccessList>,
    ) -> Result<SimulateOk, String> {
        let access_list = match cached_access_list {
            Some(access_list) => access_list,
            None => {
                let (_, access_list) = self.discovery_pass(tx)?;
                // Drain the discovery pass's journal state without committing it.
                let _ = self.evm.finalize();
                access_list
            }
        };

        self.evm.0.inspector.clear();
        self.evm.0.inspector.gas.start();
        let result = self
            .evm
            .inspect_one_tx(tx.tx_env(access_list.clone(), u64::MAX))
            .map_err(|e| format!("transact (simulate): {e:?}"));
        let traced_gas_limit = self.evm.0.inspector.gas.finish(u64::MAX);
        let result = result?;

        let outcome = self.tx_outcome(&result, &access_list);
        let gas_limit = if outcome.success {
            // tx_gas_used is at least the calldata floor (EIP-7623), and the
            // chain rejects a gas limit below the floor.
            traced_gas_limit?.max(result.tx_gas_used())
        } else {
            result.tx_gas_used()
        };
        Ok(SimulateOk { outcome, gas_limit })
    }

    fn tx_outcome(&self, result: &TxResult, access_list: &AccessList) -> TxOutcome {
        let (success, output, revert_data) = match result {
            ExecutionResult::Success { output, .. } => {
                let bytes = match output {
                    Output::Call(b) => b,
                    Output::Create(b, _) => b,
                };
                (true, format!("0x{}", hex::encode(bytes)), None)
            }
            ExecutionResult::Revert { output, .. } => (
                false,
                format!("0x{}", hex::encode(output)),
                Some(format!("0x{}", hex::encode(output))),
            ),
            ExecutionResult::Halt { reason, .. } => {
                (false, "0x".into(), Some(format!("halt: {reason:?}")))
            }
        };

        TxOutcome {
            success,
            gas_used: result.tx_gas_used(),
            output,
            access_list: encode_access_list(access_list),
            keccak_preimages: self.evm.0.inspector.wire_preimages(),
            revert_data,
        }
    }

    fn merge_journal_access_lists(&self, journal_ids: &[u64]) -> Option<AccessList> {
        if journal_ids.is_empty() {
            return None;
        }

        let mut items: Vec<AccessListItem> = Vec::new();
        for journal_id in journal_ids {
            let journal = self
                .journals
                .get(journal_id)
                .expect("journal ids validated above");
            for item in &journal.access_list.0 {
                match items
                    .iter_mut()
                    .find(|merged| merged.address == item.address)
                {
                    Some(merged) => {
                        for key in &item.storage_keys {
                            if !merged.storage_keys.contains(key) {
                                merged.storage_keys.push(*key);
                            }
                        }
                    }
                    None => items.push(item.clone()),
                }
            }
        }

        Some(AccessList(items))
    }
}

impl Default for EvmHarness {
    fn default() -> Self {
        Self::new()
    }
}

// The tx fields parsed once per request. Each pass builds its TxEnv from
// these with its own access list and gas limit.
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
            value: match params.value.as_deref() {
                Some(v) => parse_u256(v)?,
                None => U256::ZERO,
            },
            chain_id,
        })
    }

    fn tx_env(&self, access_list: AccessList, gas_limit: u64) -> TxEnv {
        TxEnv::builder()
            .caller(self.from)
            .chain_id(Some(self.chain_id))
            .kind(TxKind::Call(self.to))
            .gas_limit(gas_limit)
            .gas_price(0)
            .value(self.value)
            .data(self.data.clone())
            .access_list(access_list)
            .build_fill()
    }
}

fn rewind(db: &mut InMemoryDB, journal: &Journal) {
    for (addr, (pre, _post)) in journal.accounts.iter() {
        db.insert_account_info(*addr, pre.clone());
    }
    for ((addr, slot), (pre, _post)) in journal.storage.iter() {
        let _ = db.insert_account_storage(*addr, *slot, *pre);
    }
}

fn replay(db: &mut InMemoryDB, journal: &Journal) {
    for (addr, (_pre, post)) in journal.accounts.iter() {
        db.insert_account_info(*addr, post.clone());
    }
    for ((addr, slot), (_pre, post)) in journal.storage.iter() {
        let _ = db.insert_account_storage(*addr, *slot, *post);
    }
}

// -----------------------------------------------------------------------------
// Conversion helpers

// Every account the tx touched, with the storage slots it loaded. Keep
// address-only entries for cold callees, but drop addresses that are already
// warm at transaction start: the sender, the recipient, the coinbase, and the
// precompiles of the active spec.
fn discovered_access_list(
    state: &revm::state::EvmState,
    precompiles: &AddressSet,
    tx: &TxRequest,
    coinbase: Address,
) -> AccessList {
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

fn encode_access_list(list: &AccessList) -> Vec<AccessListEntry> {
    let mut out: Vec<AccessListEntry> = Vec::new();
    for item in &list.0 {
        let mut keys: Vec<String> = item
            .storage_keys
            .iter()
            .map(|k| format!("0x{}", hex::encode(k.as_slice())))
            .collect();
        keys.sort();
        out.push(AccessListEntry {
            address: format!("0x{:x}", item.address),
            storage_keys: keys,
        });
    }
    out.sort_by(|a, b| a.address.cmp(&b.address));
    out
}

fn collect_slot_writes(state: &revm::state::EvmState) -> Vec<SlotWriteEntry> {
    let mut writes: Vec<SlotWriteEntry> = Vec::new();
    for (address, account) in state.iter() {
        for (slot, slot_state) in account.storage.iter() {
            let pre = slot_state.original_value();
            let post = slot_state.present_value();
            if pre == post {
                continue;
            }
            writes.push(SlotWriteEntry {
                address: format!("0x{:x}", address),
                slot: format_u256(*slot),
                prev_value: format_u256(pre),
                new_value: format_u256(post),
            });
        }
    }
    writes.sort_by(|a, b| a.address.cmp(&b.address).then(a.slot.cmp(&b.slot)));
    writes
}

fn parse_address(s: &str) -> Result<Address, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).map_err(|e| format!("bad address: {e}"))?;
    if bytes.len() != 20 {
        return Err(format!("bad address length: {}", bytes.len()));
    }
    let mut arr = [0u8; 20];
    arr.copy_from_slice(&bytes);
    Ok(Address::from(arr))
}

fn parse_bytes(s: &str) -> Result<Bytes, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).map_err(|e| format!("bad bytes: {e}"))?;
    Ok(Bytes::from(bytes))
}

fn parse_u256(s: &str) -> Result<U256, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.is_empty() {
        return Ok(U256::ZERO);
    }
    U256::from_str_radix(s, 16).map_err(|e| format!("bad u256: {e}"))
}

fn format_u256(value: U256) -> String {
    format!("0x{}", hex::encode(value.to_be_bytes::<32>()))
}

// typewriter handles sequencing, gas, and balance accounting upstream — the harness
// just executes bytecode. Disable revm's tx-level checks so we don't have to
// stage them in to make every execute go through.
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

// Parse one JSON request, run it against the harness, and serialize the
// response back to JSON. This is the single entry point the native addon
// calls; it never returns `Err` so the FFI boundary stays infallible and the
// protocol (id-correlated ok/error envelopes) is owned entirely in Rust.
pub fn dispatch_json(harness: &mut EvmHarness, request_json: &str) -> String {
    match serde_json::from_str::<Request>(request_json) {
        Ok(req) => dispatch(harness, req),
        Err(e) => err(0, format!("parse error: {e}")),
    }
}

fn dispatch(harness: &mut EvmHarness, req: Request) -> String {
    match req {
        Request::Init { id, params } => match harness.init(&params) {
            Ok(()) => ok(id, &EMPTY_RESULT),
            Err(e) => err(id, e),
        },
        Request::SetBlockContext { id, params } => match harness.set_block_context(&params) {
            Ok(()) => ok(id, &EMPTY_RESULT),
            Err(e) => err(id, e),
        },
        Request::Execute { id, params } => match harness.execute(&params) {
            Ok(r) => ok(id, &r),
            Err(e) => err(id, e),
        },
        Request::Simulate { id, params } => match harness.simulate(&params) {
            Ok(r) => ok(id, &r),
            Err(e) => err(id, e),
        },
        Request::ReadStorage { id, params } => match harness.read_storage(&params) {
            Ok(r) => ok(id, &r),
            Err(e) => err(id, e),
        },
        Request::RevertJournals { id, params } => match harness.revert_journals(&params) {
            Ok(()) => ok(id, &EMPTY_RESULT),
            Err(e) => err(id, e),
        },
        Request::PruneJournals { id, params } => match harness.prune_journals(&params) {
            Ok(()) => ok(id, &EMPTY_RESULT),
            Err(e) => err(id, e),
        },
    }
}

fn ok<T: Serialize>(id: u64, result: &T) -> String {
    serialize_response(&OkResponse {
        id,
        ok: true,
        result,
    })
}

fn err(id: u64, error: String) -> String {
    serialize_response(&ErrorResponse {
        id,
        ok: false,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALLER: u16 = 0xca11;
    const CONTRACT: u16 = 0x0c01;
    const CALLEE: u16 = 0x0c02;
    const INNER: u16 = 0x0c03;

    // Increments slot 0: PUSH1 0 DUP1 SLOAD PUSH1 1 ADD SWAP1 SSTORE STOP.
    const COUNTER: &[u8] = &[0x60, 0x00, 0x80, 0x54, 0x60, 0x01, 0x01, 0x90, 0x55, 0x00];
    // Revert target at offset 3, then the body starts at offset 8:
    // PUSH1 8 JUMP | JUMPDEST PUSH1 0 DUP1 REVERT | JUMPDEST.
    const PRELUDE: &[u8] = &[0x60, 0x08, 0x56, 0x5b, 0x60, 0x00, 0x80, 0xfd, 0x5b];
    // ISZERO PUSH1 3 JUMPI: revert unless the top of the stack is nonzero.
    const REQUIRE: &[u8] = &[0x15, 0x60, 0x03, 0x57];

    fn address(n: u16) -> Address {
        let mut bytes = [0u8; 20];
        bytes[18..].copy_from_slice(&n.to_be_bytes());
        Address::from(bytes)
    }

    fn push_address(code: &mut Vec<u8>, target: u16) {
        code.push(0x73);
        code.extend_from_slice(address(target).as_slice());
    }

    // CALL target with all gas, no calldata, and `value` wei.
    fn call(code: &mut Vec<u8>, target: u16, value: u8) {
        code.extend_from_slice(&[0x60, 0, 0x60, 0, 0x60, 0, 0x60, 0, 0x60, value]);
        push_address(code, target);
        code.extend_from_slice(&[0x5a, 0xf1]);
    }

    // STATICCALL target with all gas and no calldata.
    fn static_call(code: &mut Vec<u8>, target: u16) {
        code.extend_from_slice(&[0x60, 0, 0x60, 0, 0x60, 0, 0x60, 0]);
        push_address(code, target);
        code.extend_from_slice(&[0x5a, 0xfa]);
    }

    // Calls `target` and reverts when the call fails.
    fn call_or_revert(target: u16, value: u8) -> Vec<u8> {
        let mut code = PRELUDE.to_vec();
        call(&mut code, target, value);
        code.extend_from_slice(REQUIRE);
        code.push(0x00);
        code
    }

    fn harness(accounts: &[(u16, &[u8])], storage: &[(u16, u8, u8)]) -> EvmHarness {
        let mut init = serde_json::Map::new();
        for (account, code) in accounts {
            let account_storage: serde_json::Map<String, serde_json::Value> = storage
                .iter()
                .filter(|(owner, _, _)| owner == account)
                .map(|(_, slot, value)| (format!("0x{slot:x}"), format!("0x{value:x}").into()))
                .collect();
            init.insert(
                format!("{:#x}", address(*account)),
                serde_json::json!({
                    "code": format!("0x{}", hex::encode(code)),
                    "balance": "0x100",
                    "storage": account_storage,
                }),
            );
        }
        let params: InitParams =
            serde_json::from_value(serde_json::json!({ "accounts": init })).unwrap();
        let mut harness = EvmHarness::new();
        harness.init(&params).unwrap();
        harness
    }

    fn tx(harness: &EvmHarness, to: u16) -> TxRequest {
        TxRequest {
            from: address(CALLER),
            to: address(to),
            data: Bytes::new(),
            value: U256::ZERO,
            chain_id: harness.evm.0.ctx.cfg.0.chain_id,
        }
    }

    // Returns the traced gas limit and the gas used at max gas.
    fn simulate(harness: &mut EvmHarness, to: u16) -> Result<(u64, u64), String> {
        let tx = tx(harness, to);
        let result = harness.run_simulate(&tx, Some(AccessList::default()));
        let _ = harness.evm.finalize();
        let result = result?;
        assert!(result.outcome.success);
        Ok((result.gas_limit, result.outcome.gas_used))
    }

    // Runs the tx at `gas_limit` and returns whether it succeeded and the
    // value it left in `account`'s slot 0.
    fn run_at(harness: &mut EvmHarness, to: u16, gas_limit: u64, account: u16) -> (bool, U256) {
        let tx = tx(harness, to);
        harness.evm.0.inspector.clear();
        let result = harness
            .evm
            .inspect_one_tx(tx.tx_env(AccessList::default(), gas_limit))
            .unwrap();
        let slot = harness
            .evm
            .0
            .ctx
            .journaled_state
            .evm_state()
            .get(&address(account))
            .and_then(|account| account.storage.get(&U256::ZERO))
            .map_or(U256::ZERO, |slot| slot.present_value());
        let _ = harness.evm.finalize();
        (matches!(result, ExecutionResult::Success { .. }), slot)
    }

    // The traced limit succeeds and one gas less fails. Returns the limit and
    // the gas used.
    fn assert_exact(harness: &mut EvmHarness, to: u16) -> (u64, u64) {
        let (gas_limit, gas_used) = simulate(harness, to).unwrap();
        assert!(run_at(harness, to, gas_limit, to).0);
        assert!(!run_at(harness, to, gas_limit - 1, to).0);
        (gas_limit, gas_used)
    }

    #[test]
    fn sstore_needs_more_than_the_call_stipend() {
        // PUSH1 0 SLOAD PUSH1 0 SSTORE STOP: a warm SSTORE costs less than
        // the 2,300 gas that must remain before it.
        let code = [0x60, 0x00, 0x54, 0x60, 0x00, 0x55, 0x00];
        let mut harness = harness(&[(CONTRACT, &code)], &[]);
        let (gas_limit, gas_used) = assert_exact(&mut harness, CONTRACT);
        assert!(gas_limit > gas_used);
    }

    #[test]
    fn call_keeps_one_64th() {
        let caller = call_or_revert(CALLEE, 0);
        let mut harness = harness(&[(CONTRACT, &caller), (CALLEE, COUNTER)], &[]);
        let (gas_limit, gas_used) = assert_exact(&mut harness, CONTRACT);
        assert!(gas_limit > gas_used);
    }

    #[test]
    fn nested_calls() {
        let outer = call_or_revert(CALLEE, 0);
        let middle = call_or_revert(INNER, 0);
        let mut harness = harness(
            &[(CONTRACT, &outer), (CALLEE, &middle), (INNER, COUNTER)],
            &[],
        );
        assert_exact(&mut harness, CONTRACT);
    }

    #[test]
    fn value_call_gets_the_stipend() {
        let caller = call_or_revert(CALLEE, 1);
        let mut harness = harness(&[(CONTRACT, &caller), (CALLEE, COUNTER)], &[]);
        assert_exact(&mut harness, CONTRACT);
    }

    #[test]
    fn value_call_to_an_account_with_no_code() {
        let caller = call_or_revert(INNER, 1);
        let mut harness = harness(&[(CONTRACT, &caller)], &[]);
        assert_exact(&mut harness, CONTRACT);
    }

    #[test]
    fn static_call_to_precompiles() {
        for precompile in [0x01, 0x100] {
            let mut caller = PRELUDE.to_vec();
            static_call(&mut caller, precompile);
            caller.extend_from_slice(REQUIRE);
            caller.push(0x00);
            let mut harness = harness(&[(CONTRACT, &caller)], &[]);
            assert_exact(&mut harness, CONTRACT);
        }
    }

    #[test]
    fn create_keeps_one_64th() {
        // Init code: PUSH1 1 PUSH1 0 SSTORE PUSH1 0 PUSH1 0 RETURN.
        let init_code = [0x60, 0x01, 0x60, 0x00, 0x55, 0x60, 0x00, 0x60, 0x00, 0xf3];
        let mut caller = PRELUDE.to_vec();
        caller.push(0x69);
        caller.extend_from_slice(&init_code);
        // PUSH1 0 MSTORE, then CREATE(value 0, offset 22, size 10).
        caller.extend_from_slice(&[0x60, 0x00, 0x52, 0x60, 0x0a, 0x60, 0x16, 0x60, 0x00, 0xf0]);
        caller.extend_from_slice(REQUIRE);
        caller.push(0x00);
        let mut harness = harness(&[(CONTRACT, &caller)], &[]);
        let (gas_limit, gas_used) = assert_exact(&mut harness, CONTRACT);
        assert!(gas_limit > gas_used);
    }

    #[test]
    fn clearing_a_slot_gives_no_refund() {
        // PUSH1 0 PUSH1 0 SSTORE STOP clears slot 0. Ethereum refunds gas
        // for this, and gas used then falls below the gas the tx needs.
        // Monad gives no refunds.
        let code = [0x60, 0x00, 0x60, 0x00, 0x55, 0x00];
        let mut harness = harness(&[(CONTRACT, &code)], &[(CONTRACT, 0, 1)]);
        let (gas_limit, gas_used) = assert_exact(&mut harness, CONTRACT);
        assert_eq!(gas_limit, gas_used);
    }

    #[test]
    fn ignored_call_failure_keeps_the_max_gas_path() {
        // CALL the counter, POP the result, STOP. One gas below the traced
        // limit the counter runs out of gas, but the caller still succeeds on
        // a different path.
        let mut caller = Vec::new();
        call(&mut caller, CALLEE, 0);
        caller.extend_from_slice(&[0x50, 0x00]);
        let mut harness = harness(&[(CONTRACT, &caller), (CALLEE, COUNTER)], &[]);
        let (gas_limit, _) = simulate(&mut harness, CONTRACT).unwrap();
        assert_eq!(
            run_at(&mut harness, CONTRACT, gas_limit, CALLEE),
            (true, U256::from(1))
        );
        assert_eq!(
            run_at(&mut harness, CONTRACT, gas_limit - 1, CALLEE),
            (true, U256::ZERO)
        );
    }

    #[test]
    fn halting_call_has_no_gas_limit() {
        // CALL a contract that runs INVALID with all gas, POP, STOP. The
        // child uses almost all of u64::MAX gas.
        let mut caller = Vec::new();
        call(&mut caller, CALLEE, 0);
        caller.extend_from_slice(&[0x50, 0x00]);
        let mut harness = harness(&[(CONTRACT, &caller), (CALLEE, &[0xfe])], &[]);
        assert!(simulate(&mut harness, CONTRACT).is_err());
    }
}
