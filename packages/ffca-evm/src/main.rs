// Sidecar that wraps monad-revm and speaks line-delimited JSON over stdio.
//
// Operations:
//   init           — one-shot setup: spec, chain id, block context, accounts.
//   setBlockContext— update block number, timestamp, basefee, coinbase.
//   execute        — run one tx and store its successful state transition as a
//                    journal identified by a numeric id.
//   simulate       — temporarily undo the given journal ids, run one tx, then
//                    re-apply the journals; does not create/modify journals.
//   readStorage    — read raw account storage slots from the sidecar DB.
//   revertJournals — revert and delete the given journal ids.
//   pruneJournals  — delete the given journal ids without touching state.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, Write};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadSpecId,
};
use revm::{
    context::TxEnv,
    context_interface::{
        result::{ExecutionResult, Output},
        transaction::{AccessList, AccessListItem},
        JournalTr,
    },
    database::InMemoryDB,
    inspector::JournalExt,
    primitives::{Address, Bytes, TxKind, B256, U256},
    state::{AccountInfo, Bytecode},
    DatabaseRef, ExecuteCommitEvm, ExecuteEvm,
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
    from: String,
    to: String,
    data: String,
    value: Option<String>,
    journal_ids: Vec<u64>,
}

impl SimulateParams {
    fn as_execute_params(&self) -> ExecuteParams {
        ExecuteParams {
            from: self.from.clone(),
            to: self.to.clone(),
            data: self.data.clone(),
            value: self.value.clone(),
        }
    }
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
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct ExecuteOk {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal_id: Option<u64>,
    gas_used: u64,
    gas_limit: u64,
    output: String,
    access_list: Vec<AccessListEntry>,
    slot_writes: Vec<SlotWriteEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revert_data: Option<String>,
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

// -----------------------------------------------------------------------------
// Harness

type Evm = monad_revm::api::builder::DefaultMonadEvm<
    monad_revm::api::default_ctx::MonadContext<InMemoryDB>,
>;

// Per-journal pre/post-image record. revm 34's `transact_one` clears its
// internal journal log on success, so cross-tx isolation has to live in
// userland: we capture pre-images on first touch within a journal, post-
// images each time. revertJournals writes pre-images back; simulate
// un-applies uncommitted journals, runs the simulation, re-applies them.
#[derive(Default)]
struct Journal {
    accounts: HashMap<Address, (AccountInfo, AccountInfo)>,
    storage: HashMap<(Address, U256), (U256, U256)>,
}

struct EvmHarness {
    evm: Evm,
    journals: HashMap<u64, Journal>,
    next_journal_id: u64,
    initialized: bool,
}

impl EvmHarness {
    fn new() -> Self {
        let mut ctx = monad_context_with_db(InMemoryDB::default());
        relax_cfg(&mut ctx.cfg);
        let evm = ctx.build_monad();
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
        let mut result = match self.run_two_pass(params) {
            Ok(result) => result,
            Err(error) => {
                let _ = self.evm.finalize();
                return Err(error);
            }
        };
        if result.success {
            result.slot_writes = collect_slot_writes(self.evm.0.ctx.journaled_state.evm_state());
            let mut journal = Journal::default();
            self.record_into_journal(&mut journal);
            // Commit the journaled state into the DB so future reads and
            // writes see the post-tx state.
            self.flush_journal_to_db();
            let journal_id = self.next_journal_id;
            self.next_journal_id += 1;
            self.journals.insert(journal_id, journal);
            result.journal_id = Some(journal_id);
        } else {
            // A failed tx is observable as a rejection, not as local state.
            // Drain and discard any journal state left by revm.
            let _ = self.evm.finalize();
        }
        Ok(result)
    }

    fn simulate(&mut self, params: &SimulateParams) -> Result<ExecuteOk, String> {
        self.ensure_initialized()?;
        self.ensure_journal_ids(&params.journal_ids)?;

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

        let result = self.run_two_pass(&params.as_execute_params());

        // Drop pass 2's journal-state writes so they never reach the DB.
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
            let pre_info = (*account.original_info).clone();
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

    // Two-pass execution. Pass 1 discovers the access list; pass 2 runs with
    // those addresses/slots pre-warmed so the metered gas matches what the
    // chain will charge for a tx broadcast with the discovered access list.
    //
    // After pass 1, finalize drains the journal state and we discard it so
    // pass 2 starts from the same DB state. The alternative —
    // checkpoint_revert — doesn't work because transact_one calls commit_tx
    // after success, which clears the revertable journal log.
    fn run_two_pass(&mut self, params: &ExecuteParams) -> Result<ExecuteOk, String> {
        let from = parse_address(&params.from)?;
        let to = parse_address(&params.to)?;
        let data = parse_bytes(&params.data)?;
        let value = match params.value.as_deref() {
            Some(v) => parse_u256(v)?,
            None => U256::ZERO,
        };
        let chain_id = self.evm.0.ctx.cfg.0.chain_id;
        let coinbase = self.evm.0.ctx.block.beneficiary;

        let build_tx = |access_list: AccessList, gas_limit: u64| {
            TxEnv::builder()
                .caller(from)
                .chain_id(Some(chain_id))
                .kind(TxKind::Call(to))
                .gas_limit(gas_limit)
                .gas_price(0)
                .value(value)
                .data(data.clone())
                .access_list(access_list)
                .build_fill()
        };

        // Pass 1 — discover the access list from touched accounts/slots.
        let _ = self
            .evm
            .transact_one(build_tx(AccessList::default(), u64::MAX))
            .map_err(|e| format!("transact (pass 1): {e:?}"))?;
        let touched = collect_access_list(self.evm.0.ctx.journaled_state.evm_state());
        // Drain pass 1's journal state without committing it.
        let _ = self.evm.finalize();

        // Pass 2 — measure with pre-warmed access list.
        //
        // collect_access_list includes every account touched during execution.
        // Keep address-only entries for cold callees, but drop addresses that
        // are already warm at transaction start.
        let tx_access_list = AccessList(
            touched
                .0
                .iter()
                .filter(|item| {
                    !item.storage_keys.is_empty()
                        || (!is_intrinsically_warm(item.address, from, to, coinbase)
                            && !is_precompile(item.address))
                })
                .cloned()
                .collect(),
        );

        let mut result = self
            .evm
            .transact_one(build_tx(tx_access_list.clone(), u64::MAX))
            .map_err(|e| format!("transact (pass 2): {e:?}"))?;

        let gas_limit = match &result {
            ExecutionResult::Success { gas_used, .. } => {
                let _ = self.evm.finalize();
                let gas_limit =
                    self.estimate_gas_limit(params, tx_access_list.clone(), *gas_used)?;

                // The estimate attempts finalize their own state, so rerun the
                // successful pass and leave its journal state live for execute().
                result = self
                    .evm
                    .transact_one(build_tx(tx_access_list.clone(), gas_limit))
                    .map_err(|e| format!("transact (final pass): {e:?}"))?;
                gas_limit
            }
            ExecutionResult::Revert { gas_used, .. } => *gas_used,
            ExecutionResult::Halt { gas_used, .. } => *gas_used,
        };

        let (success, gas_used, output, revert_data) = match &result {
            ExecutionResult::Success {
                gas_used, output, ..
            } => {
                let bytes = match output {
                    Output::Call(b) => b.clone(),
                    Output::Create(b, _) => b.clone(),
                };
                (true, *gas_used, format!("0x{}", hex::encode(&bytes)), None)
            }
            ExecutionResult::Revert { gas_used, output } => (
                false,
                *gas_used,
                format!("0x{}", hex::encode(output)),
                Some(format!("0x{}", hex::encode(output))),
            ),
            ExecutionResult::Halt { gas_used, reason } => (
                false,
                *gas_used,
                "0x".into(),
                Some(format!("halt: {reason:?}")),
            ),
        };

        let access_list_wire = encode_access_list(&tx_access_list);

        Ok(ExecuteOk {
            success,
            journal_id: None,
            gas_used,
            gas_limit,
            output,
            access_list: access_list_wire,
            slot_writes: Vec::new(),
            revert_data,
        })
    }

    fn estimate_gas_limit(
        &mut self,
        params: &ExecuteParams,
        access_list: AccessList,
        gas_used: u64,
    ) -> Result<u64, String> {
        let mut high = gas_used.max(21_000);
        while !self.succeeds_with_gas_limit(params, access_list.clone(), high)? {
            high = high
                .checked_add((high / 64).max(1_000))
                .ok_or_else(|| "gas estimate overflow".to_string())?;
        }

        let mut low = gas_used.saturating_sub(1);
        while low + 1 < high {
            let mid = low + (high - low) / 2;
            if self.succeeds_with_gas_limit(params, access_list.clone(), mid)? {
                high = mid;
            } else {
                low = mid;
            }
        }

        Ok(high)
    }

    fn succeeds_with_gas_limit(
        &mut self,
        params: &ExecuteParams,
        access_list: AccessList,
        gas_limit: u64,
    ) -> Result<bool, String> {
        let from = parse_address(&params.from)?;
        let to = parse_address(&params.to)?;
        let data = parse_bytes(&params.data)?;
        let value = match params.value.as_deref() {
            Some(v) => parse_u256(v)?,
            None => U256::ZERO,
        };
        let chain_id = self.evm.0.ctx.cfg.0.chain_id;

        let tx = TxEnv::builder()
            .caller(from)
            .chain_id(Some(chain_id))
            .kind(TxKind::Call(to))
            .gas_limit(gas_limit)
            .gas_price(0)
            .value(value)
            .data(data)
            .access_list(access_list)
            .build_fill();

        let result = self
            .evm
            .transact_one(tx)
            .map_err(|e| format!("transact (estimate): {e:?}"))?;
        let success = matches!(result, ExecutionResult::Success { .. });
        let _ = self.evm.finalize();
        Ok(success)
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

// Walk the journal's post-tx state, collecting every account that was
// touched and the storage slots that were loaded for it. This is what we
// pass to pass 2 as the access list, and what we serialize back to TS.
fn collect_access_list(state: &revm::state::EvmState) -> AccessList {
    let mut items: Vec<AccessListItem> = Vec::new();
    for (address, account) in state.iter() {
        let storage_keys: Vec<B256> = account
            .storage
            .keys()
            .map(|slot| B256::from(slot.to_be_bytes()))
            .collect();
        items.push(AccessListItem {
            address: *address,
            storage_keys,
        });
    }
    AccessList(items)
}

fn encode_access_list(list: &AccessList) -> Vec<AccessListEntry> {
    let mut out: Vec<AccessListEntry> = Vec::new();
    for item in &list.0 {
        let keys: Vec<String> = item
            .storage_keys
            .iter()
            .map(|k| format!("0x{}", hex::encode(k.as_slice())))
            .collect();
        let mut keys = keys;
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

fn is_intrinsically_warm(
    address: Address,
    caller: Address,
    to: Address,
    coinbase: Address,
) -> bool {
    address == caller || address == to || address == coinbase
}

fn is_precompile(address: Address) -> bool {
    let bytes = address.as_slice();
    bytes[..19].iter().all(|byte| *byte == 0) && (1..=10).contains(&bytes[19])
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

// ffca handles sequencing, gas, and balance accounting upstream — the sidecar
// just executes bytecode. Disable revm's tx-level checks so we don't have to
// stage them in to make every execute go through.
fn relax_cfg(cfg: &mut MonadCfgEnv) {
    cfg.0.disable_nonce_check = true;
    cfg.0.disable_balance_check = true;
    cfg.0.disable_base_fee = true;
    cfg.0.tx_gas_limit_cap = Some(u64::MAX);
}

fn parse_spec(s: &str) -> Option<MonadSpecId> {
    match s {
        "MonadEight" => Some(MonadSpecId::MonadEight),
        "MonadNine" => Some(MonadSpecId::MonadNine),
        "MonadNext" => Some(MonadSpecId::MonadNext),
        _ => None,
    }
}

// -----------------------------------------------------------------------------
// Dispatch

fn dispatch(harness: &mut EvmHarness, req: Request) -> Response {
    match req {
        Request::Init { id, params } => match harness.init(&params) {
            Ok(()) => ok(id, serde_json::json!({})),
            Err(e) => err(id, e),
        },
        Request::SetBlockContext { id, params } => match harness.set_block_context(&params) {
            Ok(()) => ok(id, serde_json::json!({})),
            Err(e) => err(id, e),
        },
        Request::Execute { id, params } => match harness.execute(&params) {
            Ok(r) => ok(id, serde_json::to_value(r).unwrap()),
            Err(e) => err(id, e),
        },
        Request::Simulate { id, params } => match harness.simulate(&params) {
            Ok(r) => ok(id, serde_json::to_value(r).unwrap()),
            Err(e) => err(id, e),
        },
        Request::ReadStorage { id, params } => match harness.read_storage(&params) {
            Ok(r) => ok(id, serde_json::to_value(r).unwrap()),
            Err(e) => err(id, e),
        },
        Request::RevertJournals { id, params } => match harness.revert_journals(&params) {
            Ok(()) => ok(id, serde_json::json!({})),
            Err(e) => err(id, e),
        },
        Request::PruneJournals { id, params } => match harness.prune_journals(&params) {
            Ok(()) => ok(id, serde_json::json!({})),
            Err(e) => err(id, e),
        },
    }
}

fn ok(id: u64, result: serde_json::Value) -> Response {
    Response {
        id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn err(id: u64, error: String) -> Response {
    Response {
        id,
        ok: false,
        result: None,
        error: Some(error),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let mut harness = EvmHarness::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => dispatch(&mut harness, req),
            Err(e) => Response {
                id: 0,
                ok: false,
                result: None,
                error: Some(format!("parse error: {e}")),
            },
        };
        let s = serde_json::to_string(&response).unwrap();
        writeln!(out, "{s}")?;
        out.flush()?;
    }
    Ok(())
}
