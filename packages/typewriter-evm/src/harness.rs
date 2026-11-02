use std::collections::{BTreeMap, BTreeSet, HashMap};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadHardfork,
};
use revm::{
    bytecode::opcode,
    context::{BlockEnv, CfgEnv, Context, TxEnv},
    context_interface::{
        result::{ExecutionResult, HaltReason},
        transaction::{AccessList, AccessListItem},
        Cfg, ContextTr, JournalTr,
    },
    database::InMemoryDB,
    handler::{instructions::EthInstructions, EthPrecompiles, MainBuilder, MainContext},
    inspector::InspectEvm,
    interpreter::{
        interpreter::EthInterpreter,
        interpreter_types::{Jumps, MemoryTr},
        CallInputs, CallOutcome, CreateInputs, CreateOutcome, Interpreter, InterpreterResult,
    },
    primitives::{
        alloy_primitives::{B512, U64},
        hardfork::SpecId,
        Address, Bytes, TxKind, B256, U256,
    },
    state::{AccountInfo, Bytecode, EvmState},
    DatabaseRef, ExecuteCommitEvm, ExecuteEvm, Inspector,
};
use serde::{Deserialize, Deserializer, Serialize};

// -----------------------------------------------------------------------------
// Specs

/// A Monad hardfork runs on monad-revm and an Ethereum one on mainnet revm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Spec {
    Monad(MonadHardfork),
    Ethereum(SpecId),
}

impl Spec {
    fn from_name(name: &str) -> Option<Self> {
        if let Ok(spec) = name.parse() {
            return Some(Spec::Monad(spec));
        }
        match name.parse::<SpecId>() {
            Ok(spec) if (SpecId::MERGE..=SpecId::OSAKA).contains(&spec) => {
                Some(Spec::Ethereum(spec))
            }
            _ => None,
        }
    }

    /// The hardfork of a known chain at a block timestamp.
    fn scheduled(chain_id: u64, timestamp: u64) -> Option<Self> {
        MonadHardfork::from_chain_and_timestamp(chain_id, timestamp)
            .map(Spec::Monad)
            .or_else(|| ethereum_spec(chain_id, timestamp).map(Spec::Ethereum))
    }
}

impl<'de> Deserialize<'de> for Spec {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Spec::from_name(&name)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown spec `{name}`")))
    }
}

/// Ethereum mainnet, Sepolia, and Hoodi activate Shanghai, Cancun, Prague, and
/// Osaka at these timestamps.
fn ethereum_spec(chain_id: u64, timestamp: u64) -> Option<SpecId> {
    let activations: [u64; 4] = match chain_id {
        1 => [1_681_338_455, 1_710_338_135, 1_746_612_311, 1_764_798_551],
        11_155_111 => [1_677_557_088, 1_706_655_072, 1_741_159_776, 1_760_427_360],
        560_048 => [0, 0, 1_742_999_832, 1_761_677_592],
        _ => return None,
    };
    let specs = [
        SpecId::SHANGHAI,
        SpecId::CANCUN,
        SpecId::PRAGUE,
        SpecId::OSAKA,
    ];
    Some(
        activations
            .iter()
            .zip(specs)
            .rev()
            .find(|(activation, _)| timestamp >= **activation)
            .map_or(SpecId::MERGE, |(_, spec)| spec),
    )
}

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
    spec: Option<Spec>,
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
struct SimulateParams {
    #[serde(flatten)]
    tx: ExecuteParams,
    journal_ids: Vec<u64>,
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

/// gas_used is with the access list warm, as the chain charges it.
#[derive(Serialize)]
struct SimulateOk {
    #[serde(flatten)]
    outcome: TxOutcome,
    gas_limit: u64,
}

#[derive(Serialize)]
struct SlotWrite {
    slot: B256,
    value: B256,
}

// -----------------------------------------------------------------------------
// Inspector

type TxResult = ExecutionResult<HaltReason>;

/// The gas limit must exceed the gas spent in two places: SSTORE needs more
/// than the call stipend left (EIP-2200), and a call or create keeps 1/64 of
/// the gas it could forward (EIP-150). Gas spent after either point is already
/// counted, so each frame needs a reserve: 2,301 for its own SSTOREs, and
/// enough that 63/64 of its remaining gas covers each child's gas plus the
/// child's reserve. A halted frame uses all the gas it is given, which its
/// need already counts.
///
/// Typewriter contracts never catch a halt in a nested call: a failed call
/// reverts the tx. The limit relies on this. Simulate runs at u64::MAX gas, so
/// a caught halt in a call that forwards all its gas burns nearly all of it,
/// and gas_limit comes out near u64::MAX, which the node rejects.
#[derive(Default)]
struct HarnessInspector {
    keccak_preimages: Vec<B512>,
    frame_reserves: Vec<u64>,
    gas_reserve: u64,
}

impl HarnessInspector {
    fn clear(&mut self) {
        *self = Self::default();
    }

    /// Ends a call or create frame and raises its caller's reserve to cover it.
    fn frame_end(&mut self, gas_limit: u64, result: &InterpreterResult, sstore_reserve: u64) {
        let Some(mut reserve) = self.frame_reserves.pop() else {
            return;
        };
        reserve = reserve.max(sstore_reserve);
        // The gas this frame needs to be given: what it spent plus its reserve.
        let need = gas_limit - result.gas.remaining() + reserve;
        match self.frame_reserves.last_mut() {
            // The caller keeps 1/64 of its gas back from the call, so to give
            // `need` it must hold this frame's reserve plus about need/63 more.
            Some(parent) => *parent = (*parent).max(reserve + need.div_ceil(63) + 1),
            // The top frame's reserve is the tx's.
            None => self.gas_reserve = reserve,
        }
    }
}

impl<CTX: ContextTr> Inspector<CTX> for HarnessInspector {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, _context: &mut CTX) {
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

    fn call(&mut self, _context: &mut CTX, _inputs: &mut CallInputs) -> Option<CallOutcome> {
        self.frame_reserves.push(0);
        None
    }

    fn call_end(&mut self, context: &mut CTX, inputs: &CallInputs, outcome: &mut CallOutcome) {
        // Precompiles have fixed costs and no SSTORE.
        let sstore_reserve = if outcome.was_precompile_called {
            0
        } else {
            context.cfg().gas_params().call_stipend() + 1
        };
        self.frame_end(inputs.gas_limit, &outcome.result, sstore_reserve);
    }

    fn create(&mut self, _context: &mut CTX, _inputs: &mut CreateInputs) -> Option<CreateOutcome> {
        self.frame_reserves.push(0);
        None
    }

    fn create_end(
        &mut self,
        context: &mut CTX,
        inputs: &CreateInputs,
        outcome: &mut CreateOutcome,
    ) {
        let sstore_reserve = context.cfg().gas_params().call_stipend() + 1;
        self.frame_end(inputs.gas_limit(), &outcome.result, sstore_reserve);
    }
}

// -----------------------------------------------------------------------------
// Backends

type MonadEvm = monad_revm::api::builder::DefaultMonadEvm<
    monad_revm::api::default_ctx::MonadContext<InMemoryDB>,
    HarnessInspector,
>;
type EthereumEvm =
    revm::handler::MainnetEvm<revm::handler::MainnetContext<InMemoryDB>, HarnessInspector>;

/// The parts of an EVM the harness uses, so one harness drives either.
trait Backend {
    fn spec(&self) -> Spec;
    fn set_spec(&mut self, spec: Spec) -> Result<(), String>;
    fn chain_id(&self) -> u64;
    fn block(&self) -> &BlockEnv;
    fn block_mut(&mut self) -> &mut BlockEnv;
    fn db(&self) -> &InMemoryDB;
    fn db_mut(&mut self) -> &mut InMemoryDB;
    fn inspector(&mut self) -> &mut HarnessInspector;
    fn is_precompile(&self, address: &Address) -> bool;
    fn transact(&mut self, tx: TxEnv) -> (Result<TxResult, String>, EvmState);
    fn commit(&mut self, state: EvmState);
}

fn new_backend(spec: Spec, chain_id: u64) -> Result<Box<dyn Backend>, String> {
    let mut backend: Box<dyn Backend> = match spec {
        Spec::Monad(_) => {
            let mut ctx = monad_context_with_db(InMemoryDB::default());
            ctx.cfg.0.chain_id = chain_id;
            Box::new(ctx.build_monad_with_inspector(HarnessInspector::default()))
        }
        Spec::Ethereum(_) => {
            let mut ctx = Context::mainnet().with_db(InMemoryDB::default());
            ctx.cfg.chain_id = chain_id;
            Box::new(ctx.build_mainnet_with_inspector(HarnessInspector::default()))
        }
    };
    backend.set_spec(spec)?;
    Ok(backend)
}

macro_rules! backend_common {
    ($($inner:tt)*) => {
        fn chain_id(&self) -> u64 {
            self$($inner)*.ctx.cfg.chain_id()
        }
        fn block(&self) -> &BlockEnv {
            &self$($inner)*.ctx.block
        }
        fn block_mut(&mut self) -> &mut BlockEnv {
            &mut self$($inner)*.ctx.block
        }
        fn db(&self) -> &InMemoryDB {
            self$($inner)*.ctx.journaled_state.db()
        }
        fn db_mut(&mut self) -> &mut InMemoryDB {
            self$($inner)*.ctx.journaled_state.db_mut()
        }
        fn inspector(&mut self) -> &mut HarnessInspector {
            &mut self$($inner)*.inspector
        }
        fn is_precompile(&self, address: &Address) -> bool {
            self$($inner)*.ctx.journaled_state.precompile_addresses().contains(address)
        }
        fn transact(&mut self, tx: TxEnv) -> (Result<TxResult, String>, EvmState) {
            let result = self.inspect_one_tx(tx);
            let state = self.finalize();
            (result.map_err(|e| format!("transact: {e:?}")), state)
        }
        fn commit(&mut self, state: EvmState) {
            ExecuteCommitEvm::commit(self, state);
        }
    };
}

impl Backend for MonadEvm {
    backend_common!(.0);

    fn spec(&self) -> Spec {
        Spec::Monad(self.0.ctx.cfg.0.spec)
    }

    fn set_spec(&mut self, spec: Spec) -> Result<(), String> {
        let Spec::Monad(spec) = spec else {
            return Err(format!("{spec:?} is not a Monad hardfork"));
        };
        // MonadEvm reads the spec from the cfg on every frame, so replacing the
        // cfg also switches its instructions and precompiles.
        let mut cfg = MonadCfgEnv::new_with_spec(spec).with_chain_id(self.chain_id());
        relax_cfg(&mut cfg.0);
        self.0.ctx.cfg = cfg;
        self.0.ctx.journaled_state.set_spec_id(spec.into());
        Ok(())
    }
}

impl Backend for EthereumEvm {
    backend_common!();

    fn spec(&self) -> Spec {
        Spec::Ethereum(self.ctx.cfg.spec)
    }

    fn set_spec(&mut self, spec: Spec) -> Result<(), String> {
        let Spec::Ethereum(spec) = spec else {
            return Err(format!("{spec:?} is not an Ethereum hardfork"));
        };
        let mut cfg = CfgEnv::new_with_spec(spec).with_chain_id(self.chain_id());
        relax_cfg(&mut cfg);
        self.ctx.cfg = cfg;
        self.ctx.journaled_state.set_spec_id(spec);
        self.instruction = EthInstructions::new_mainnet_with_spec(spec);
        self.precompiles = EthPrecompiles::new(spec);
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Harness

/// revm clears its own journal when a tx succeeds, so each tx's pre/post images
/// are kept here to revert or temporarily undo it later.
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
            // Only writes: undoing a slot the tx just read would overwrite
            // what a later tx, whose journal stays, wrote to it.
            for (slot, value) in account
                .storage
                .iter()
                .filter(|(_, value)| value.is_changed())
            {
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

/// Which side of a tx a journal writes: Pre undoes the tx, Post redoes it.
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

pub struct EvmHarness {
    evm: Box<dyn Backend>,
    /// The caller's hardfork. Without one, the hardfork follows the chain's
    /// schedule at the block timestamp.
    pinned_spec: Option<Spec>,
    journals: HashMap<u64, Journal>,
    next_journal_id: u64,
}

impl EvmHarness {
    pub fn from_json(params_json: &str) -> Result<Self, String> {
        let params = serde_json::from_str(params_json).map_err(|e| format!("parse error: {e}"))?;
        Self::new(&params)
    }

    /// The chain ID picks the network, Monad or Ethereum, unless a spec is
    /// pinned, and the network is fixed from then on.
    fn new(params: &InitParams) -> Result<Self, String> {
        let chain_id = params.chain_id.unwrap_or(1);
        let timestamp = params
            .block
            .as_ref()
            .and_then(|block| block.timestamp)
            .map_or(0, |timestamp| timestamp.saturating_to());
        let spec = Self::spec_at(params.spec, chain_id, timestamp)?;
        let mut harness = Self {
            evm: new_backend(spec, chain_id)?,
            pinned_spec: params.spec,
            journals: HashMap::new(),
            next_journal_id: 1,
        };
        harness.init(params)?;
        Ok(harness)
    }

    fn spec_at(pinned_spec: Option<Spec>, chain_id: u64, timestamp: u64) -> Result<Spec, String> {
        pinned_spec
            .or_else(|| Spec::scheduled(chain_id, timestamp))
            .ok_or_else(|| format!("chain {chain_id} has no known hardfork schedule; pass a spec"))
    }

    fn init(&mut self, params: &InitParams) -> Result<(), String> {
        if let Some(block) = &params.block {
            self.set_block_context(block)?;
        }
        let db = self.evm.db_mut();
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
        let block = self.evm.block_mut();
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
    /// block timestamp.
    fn update_spec(&mut self) -> Result<(), String> {
        let timestamp = self.evm.block().timestamp.saturating_to();
        let spec = Self::spec_at(self.pinned_spec, self.evm.chain_id(), timestamp)?;
        if spec == self.evm.spec() {
            return Ok(());
        }
        self.evm.set_spec(spec)
    }

    fn revert_journals(&mut self, params: &JournalIdsParams) -> Result<(), String> {
        self.ensure_journal_ids(&params.journal_ids)?;
        for journal_id in params.journal_ids.iter().rev() {
            let journal = self.journals.remove(journal_id).expect("validated above");
            journal.write(self.evm.db_mut(), Image::Pre);
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
        let outcome = tx_outcome(&result, access_list.clone());
        let keccak_preimages = std::mem::take(&mut self.evm.inspector().keccak_preimages);
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
        for journal_id in params.journal_ids.iter().rev() {
            self.journals[journal_id].write(self.evm.db_mut(), Image::Pre);
        }
        let cached_access_list = self.merge_journal_access_lists(&params.journal_ids);
        let result = self.run_simulate(&params.tx, cached_access_list);
        for journal_id in &params.journal_ids {
            self.journals[journal_id].write(self.evm.db_mut(), Image::Post);
        }
        result
    }

    fn read_storage(&self, params: &ReadStorageParams) -> BTreeMap<B256, B256> {
        let db = self.evm.db();
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
        self.evm.inspector().clear();
        let tx_env = tx.tx_env(self.evm.chain_id(), access_list);
        let (result, state) = self.evm.transact(tx_env);
        Ok((result?, state))
    }

    /// Lists the accounts and slots the tx touched, leaving out accounts the
    /// chain already warms: the sender, the recipient, the coinbase, and
    /// precompiles.
    fn discovered_access_list(&self, tx: &ExecuteParams, state: &EvmState) -> AccessList {
        let coinbase = self.evm.block().beneficiary;
        let is_warm = |address: &Address| {
            *address == tx.from
                || *address == tx.to
                || *address == coinbase
                || self.evm.is_precompile(address)
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

    fn run_simulate(
        &mut self,
        tx: &ExecuteParams,
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
        let outcome = tx_outcome(&result, access_list);
        // Ethereum refunds after execution, so the limit covers the gas spent
        // before the refund, and at least the calldata floor (EIP-7623).
        let gas_limit = if outcome.success() {
            let gas = result.gas();
            (gas.total_gas_spent() + self.evm.inspector().gas_reserve).max(gas.floor_gas())
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

fn tx_outcome(result: &TxResult, access_list: AccessList) -> TxOutcome {
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
fn relax_cfg<S>(cfg: &mut CfgEnv<S>) {
    cfg.disable_nonce_check = true;
    cfg.disable_balance_check = true;
    cfg.disable_base_fee = true;
    cfg.tx_gas_limit_cap = Some(u64::MAX);
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
        Request::Simulate { id, params } => respond(id, harness.simulate(&params)),
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
    const CALLEE: u16 = 0x0c02;
    const INNER: u16 = 0x0c03;

    /// PUSH1 0 DUP1 SLOAD PUSH1 1 ADD SWAP1 SSTORE STOP.
    const COUNTER: &[u8] = &[0x60, 0x00, 0x80, 0x54, 0x60, 0x01, 0x01, 0x90, 0x55, 0x00];
    const CALL: u8 = 0xf1;
    const STATICCALL: u8 = 0xfa;
    const GAS: &[u8] = &[0x5a];

    fn address(n: u16) -> Address {
        let mut bytes = [0u8; 20];
        bytes[18..].copy_from_slice(&n.to_be_bytes());
        Address::from(bytes)
    }

    /// Calls `target` with no calldata and the `gas` operand.
    fn call(op: u8, target: u16, gas: &[u8]) -> Vec<u8> {
        let mut code = [0x60, 0x00].repeat(if op == CALL { 5 } else { 4 });
        code.push(0x73);
        code.extend_from_slice(address(target).as_slice());
        code.extend_from_slice(gas);
        code.push(op);
        code
    }

    /// Reverts unless the call succeeded, then stops.
    fn require_success(mut code: Vec<u8>) -> Vec<u8> {
        let revert = u8::try_from(code.len() + 5).unwrap();
        code.extend_from_slice(&[0x15, 0x60, revert, 0x57, 0x00, 0x5b, 0x60, 0x00, 0x80, 0xfd]);
        code
    }

    const SPECS: [Spec; 2] = [
        Spec::Monad(MonadHardfork::MonadTen),
        Spec::Ethereum(SpecId::OSAKA),
    ];

    fn harness(accounts: &[(u16, &[u8])]) -> EvmHarness {
        harness_with(SPECS[0], accounts, &[])
    }

    fn harness_with(spec: Spec, accounts: &[(u16, &[u8])], storage: &[(u64, u64)]) -> EvmHarness {
        let storage: BTreeMap<U256, U256> = storage
            .iter()
            .map(|&(slot, value)| (U256::from(slot), U256::from(value)))
            .collect();
        let accounts = accounts
            .iter()
            .map(|&(account, code)| {
                let account_params = AccountParams {
                    balance: U256::ZERO,
                    nonce: 0,
                    code: Some(Bytes::copy_from_slice(code)),
                    storage: storage.clone(),
                };
                (address(account), account_params)
            })
            .collect();
        EvmHarness::new(&InitParams {
            spec: Some(spec),
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

    fn simulate(harness: &mut EvmHarness) -> Result<SimulateOk, String> {
        harness.run_simulate(&tx(), Some(AccessList::default()))
    }

    fn succeeds_at(harness: &mut EvmHarness, gas_limit: u64) -> bool {
        let mut tx_env = tx().tx_env(harness.evm.chain_id(), AccessList::default());
        tx_env.gas_limit = gas_limit;
        let (result, _) = harness.evm.transact(tx_env);
        matches!(result.unwrap(), ExecutionResult::Success { .. })
    }

    /// The tx fails at gas_used and succeeds at the simulated limit.
    fn assert_reserve_needed(accounts: &[(u16, &[u8])]) {
        assert_reserve_needed_with(&SPECS, accounts, &[]);
    }

    fn assert_reserve_needed_with(
        specs: &[Spec],
        accounts: &[(u16, &[u8])],
        storage: &[(u64, u64)],
    ) {
        for &spec in specs {
            let mut harness = harness_with(spec, accounts, storage);
            let result = simulate(&mut harness).unwrap();
            assert!(result.outcome.success(), "{spec:?}");
            assert!(
                !succeeds_at(&mut harness, result.outcome.gas_used),
                "{spec:?}"
            );
            assert!(succeeds_at(&mut harness, result.gas_limit), "{spec:?}");
        }
    }

    #[test]
    fn chain_id_picks_the_network() {
        let osaka = 1_764_798_551;
        assert_eq!(
            Spec::scheduled(1, osaka - 1),
            Some(Spec::Ethereum(SpecId::PRAGUE))
        );
        assert_eq!(
            Spec::scheduled(1, osaka),
            Some(Spec::Ethereum(SpecId::OSAKA))
        );
        assert_eq!(Spec::scheduled(1, 0), Some(Spec::Ethereum(SpecId::MERGE)));
        assert_eq!(
            Spec::scheduled(560_048, 0),
            Some(Spec::Ethereum(SpecId::CANCUN))
        );
        assert_eq!(
            Spec::scheduled(143, 1_788_359_400),
            Some(Spec::Monad(MonadHardfork::MonadTen))
        );
        assert_eq!(Spec::scheduled(31_337, osaka), None);
    }

    #[test]
    fn spec_names() {
        assert_eq!(
            Spec::from_name("MonadTen"),
            Some(Spec::Monad(MonadHardfork::MonadTen))
        );
        assert_eq!(
            Spec::from_name("Osaka"),
            Some(Spec::Ethereum(SpecId::OSAKA))
        );
        assert_eq!(Spec::from_name("Amsterdam"), None);
        assert_eq!(Spec::from_name("London"), None);
    }

    #[test]
    fn reserve_covers_refunds() {
        // PUSH1 0 PUSH1 0 SSTORE STOP clears slot 0, which Ethereum refunds
        // after execution. Monad has no refunds.
        let code: &[u8] = &[0x60, 0x00, 0x60, 0x00, 0x55, 0x00];
        assert_reserve_needed_with(&[SPECS[1]], &[(CONTRACT, code)], &[(0, 1)]);
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
