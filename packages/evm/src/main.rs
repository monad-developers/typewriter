// Sidecar that wraps monad-revm and speaks line-delimited JSON over stdio.
//
// Five operations:
//   init           — one-shot setup: spec, chain id, block context, accounts.
//   beginBundle    — open a journal checkpoint.
//   execute        — run one tx inside the open bundle.
//   commitBundle   — drain the journal and persist writes to the DB.
//   revertBundle   — roll the journal back to the bundle's open checkpoint.

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadSpecId,
};
use revm::{
    context::TxEnv,
    context_interface::{
        journaled_state::JournalCheckpoint,
        result::{ExecutionResult, Output},
        JournalTr,
    },
    database::InMemoryDB,
    primitives::{Address, Bytes, TxKind, U256},
    state::{AccountInfo, Bytecode},
    ExecuteCommitEvm, ExecuteEvm,
};
use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Wire types

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum Request {
    Init { id: u64, params: InitParams },
    BeginBundle { id: u64 },
    Execute { id: u64, params: ExecuteParams },
    CommitBundle { id: u64 },
    RevertBundle { id: u64 },
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

#[derive(Serialize)]
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Default)]
struct AccountDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    balance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage: Option<BTreeMap<String, String>>,
}

#[derive(Serialize)]
struct ExecuteOk {
    success: bool,
    gas_used: u64,
    output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    revert_data: Option<String>,
}

#[derive(Serialize)]
struct CommitOk {
    state_diff: BTreeMap<String, AccountDiff>,
}

// -----------------------------------------------------------------------------
// Harness

type Evm = monad_revm::api::builder::DefaultMonadEvm<
    monad_revm::api::default_ctx::MonadContext<InMemoryDB>,
>;

struct EvmHarness {
    evm: Evm,
    bundle: Option<JournalCheckpoint>,
    initialized: bool,
}

impl EvmHarness {
    fn new() -> Self {
        let mut ctx = monad_context_with_db(InMemoryDB::default());
        relax_cfg(&mut ctx.cfg);
        let evm = ctx.build_monad();
        Self {
            evm,
            bundle: None,
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

    fn begin_bundle(&mut self) -> Result<(), String> {
        if self.bundle.is_some() {
            return Err("a bundle is already open".into());
        }
        let cp = self.evm.0.ctx.journaled_state.checkpoint();
        self.bundle = Some(cp);
        Ok(())
    }

    fn commit_bundle(&mut self) -> Result<CommitOk, String> {
        if self.bundle.take().is_none() {
            return Err("no bundle is open".into());
        }
        self.evm.0.ctx.journaled_state.checkpoint_commit();
        let state = self.evm.finalize();
        let state_diff = encode_state_diff(&state);
        self.evm.commit(state);
        Ok(CommitOk { state_diff })
    }

    fn revert_bundle(&mut self) -> Result<(), String> {
        let cp = self
            .bundle
            .take()
            .ok_or_else(|| "no bundle is open".to_string())?;
        self.evm.0.ctx.journaled_state.checkpoint_revert(cp);
        let _ = self.evm.finalize();
        Ok(())
    }

    fn execute(&mut self, params: &ExecuteParams) -> Result<ExecuteOk, String> {
        if self.bundle.is_none() {
            return Err("execute requires an open bundle".into());
        }
        let from = parse_address(&params.from)?;
        let to = parse_address(&params.to)?;
        let data = parse_bytes(&params.data)?;
        let value = match params.value.as_deref() {
            Some(v) => parse_u256(v)?,
            None => U256::ZERO,
        };

        let tx = TxEnv::builder()
            .caller(from)
            .kind(TxKind::Call(to))
            .gas_limit(u64::MAX)
            .gas_price(0)
            .value(value)
            .data(data)
            .build_fill();

        let result = self
            .evm
            .transact_one(tx)
            .map_err(|e| format!("transact: {e:?}"))?;

        // Don't finalize here — leave journal entries in place so revertBundle
        // can roll them back. finalize() + commit() happen once in
        // commit_bundle, draining the bundle's accumulated writes.
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

        Ok(ExecuteOk {
            success,
            gas_used,
            output,
            revert_data,
        })
    }
}

// -----------------------------------------------------------------------------
// Conversion helpers

fn encode_state_diff(state: &revm::state::EvmState) -> BTreeMap<String, AccountDiff> {
    let mut out: BTreeMap<String, AccountDiff> = BTreeMap::new();
    for (address, account) in state.iter() {
        let mut writes = AccountDiff::default();
        let mut changed = false;
        let info = &account.info;

        let mut storage = BTreeMap::new();
        for (slot, entry) in account.storage.iter() {
            if entry.original_value() != entry.present_value() {
                storage.insert(
                    format!("0x{slot:064x}"),
                    format!("0x{:064x}", entry.present_value()),
                );
            }
        }
        if !storage.is_empty() {
            writes.storage = Some(storage);
            changed = true;
        }

        if info.balance != U256::ZERO {
            writes.balance = Some(format!("0x{:x}", info.balance));
            changed = true;
        }
        if info.nonce != 0 {
            writes.nonce = Some(info.nonce);
            changed = true;
        }
        if let Some(code) = info.code.as_ref() {
            if !code.is_empty() {
                writes.code = Some(format!("0x{}", hex::encode(code.original_byte_slice())));
                changed = true;
            }
        }

        if changed {
            out.insert(format!("0x{address:x}"), writes);
        }
    }
    out
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
        Request::BeginBundle { id } => match harness.begin_bundle() {
            Ok(()) => ok(id, serde_json::json!({})),
            Err(e) => err(id, e),
        },
        Request::Execute { id, params } => match harness.execute(&params) {
            Ok(r) => ok(id, serde_json::to_value(r).unwrap()),
            Err(e) => err(id, e),
        },
        Request::CommitBundle { id } => match harness.commit_bundle() {
            Ok(r) => ok(id, serde_json::to_value(r).unwrap()),
            Err(e) => err(id, e),
        },
        Request::RevertBundle { id } => match harness.revert_bundle() {
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
