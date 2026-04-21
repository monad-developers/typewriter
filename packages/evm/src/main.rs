use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

use monad_revm::{
    api::{builder::MonadBuilder, default_ctx::monad_context_with_db},
    MonadCfgEnv, MonadSpecId,
};
use revm::{
    context::TxEnv,
    context_interface::{
        journaled_state::JournalTr,
        result::{ExecutionResult, Output},
    },
    database::InMemoryDB,
    database_interface::Database,
    primitives::{Address, Bytes, TxKind, KECCAK_EMPTY, U256},
    state::{AccountInfo, Bytecode},
    ExecuteCommitEvm, ExecuteEvm,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum Request {
    #[serde(rename = "init")]
    Init { id: u64, params: InitParams },
    #[serde(rename = "setAccount")]
    SetAccount { id: u64, params: SetAccountParams },
    #[serde(rename = "execute")]
    Execute { id: u64, params: ExecuteParams },
}

#[derive(Deserialize)]
struct InitParams {
    spec: Option<String>,
}

#[derive(Deserialize)]
struct SetAccountParams {
    address: String,
    balance: Option<String>,
    nonce: Option<u64>,
    code: Option<String>,
    storage: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Deserialize)]
struct ExecuteParams {
    from: String,
    to: String,
    data: String,
    gas_limit: Option<u64>,
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
struct Account {
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
struct AccessListEntry {
    address: String,
    storage_keys: Vec<String>,
}

#[derive(Serialize)]
struct ExecuteResult {
    success: bool,
    gas_used: u64,
    output: String,
    pre: BTreeMap<String, Account>,
    post: BTreeMap<String, Account>,
    access_list: Vec<AccessListEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revert_reason: Option<String>,
}

struct EvmHarness {
    db: InMemoryDB,
    spec: MonadSpecId,
}

impl EvmHarness {
    fn new() -> Self {
        Self {
            db: InMemoryDB::default(),
            spec: MonadSpecId::default(),
        }
    }

    fn set_account(&mut self, params: &SetAccountParams) -> Result<(), String> {
        let address = parse_address(&params.address)?;
        let existing = self
            .db
            .cache
            .accounts
            .get(&address)
            .map(|a| a.info.clone())
            .unwrap_or_default();
        let code = match params.code.as_deref() {
            Some(c) => Some(Bytecode::new_raw(parse_bytes(c)?)),
            None => existing.code.clone(),
        };
        let mut info = AccountInfo {
            balance: match params.balance.as_deref() {
                Some(b) => parse_u256(b)?,
                None => existing.balance,
            },
            nonce: params.nonce.unwrap_or(existing.nonce),
            ..Default::default()
        };
        if let Some(bc) = code {
            info = info.with_code(bc);
        }
        self.db.insert_account_info(address, info);
        if let Some(storage) = &params.storage {
            for (slot_str, value_str) in storage {
                let slot = parse_u256(slot_str)?;
                let value = parse_u256(value_str)?;
                self.db
                    .insert_account_storage(address, slot, value)
                    .map_err(|e| format!("insert_account_storage: {e:?}"))?;
            }
        }
        Ok(())
    }

    fn execute(&mut self, params: &ExecuteParams) -> Result<ExecuteResult, String> {
        let from = parse_address(&params.from)?;
        let to = parse_address(&params.to)?;
        let data = parse_bytes(&params.data)?;
        let gas_limit = params.gas_limit.unwrap_or(30_000_000);

        let db = std::mem::take(&mut self.db);
        let mut cfg = MonadCfgEnv::new_with_spec(self.spec);
        cfg.0.disable_nonce_check = true;
        let ctx = monad_context_with_db(db).with_cfg(cfg);
        let mut evm = ctx.build_monad();

        let tx = TxEnv::builder()
            .caller(from)
            .kind(TxKind::Call(to))
            .gas_limit(gas_limit)
            .gas_price(0)
            .data(data)
            .build_fill();

        let exec = evm.transact(tx);
        let result_state = match exec {
            Ok(rs) => rs,
            Err(e) => {
                self.db = evm.0.ctx.journaled_state.into_database();
                return Err(format!("{e:?}"));
            }
        };

        let mut pre_map: BTreeMap<String, Account> = BTreeMap::new();
        let mut post_map: BTreeMap<String, Account> = BTreeMap::new();
        let mut access_list = Vec::new();

        let touched: Vec<Address> = result_state.state.keys().copied().collect();
        let mut pre_infos: BTreeMap<Address, Option<AccountInfo>> = BTreeMap::new();
        for address in &touched {
            let pre = evm
                .0
                .ctx
                .journaled_state
                .db_mut()
                .basic(*address)
                .ok()
                .flatten();
            pre_infos.insert(*address, pre);
        }

        for (address, account) in result_state.state.iter() {
            let post_info = &account.info;
            let pre_info = pre_infos.get(address).cloned().flatten();

            let mut storage_keys = Vec::new();
            for (slot, _entry) in account.storage.iter() {
                storage_keys.push(format!("0x{slot:064x}"));
            }
            storage_keys.sort();
            access_list.push(AccessListEntry {
                address: format!("0x{address:x}"),
                storage_keys,
            });

            let mut pre_acc = Account::default();
            let mut post_acc = Account::default();
            let mut changed = false;

            let pre_balance = pre_info.as_ref().map(|i| i.balance).unwrap_or(U256::ZERO);
            if pre_balance != post_info.balance {
                pre_acc.balance = Some(format!("0x{pre_balance:x}"));
                post_acc.balance = Some(format!("0x{:x}", post_info.balance));
                changed = true;
            }

            let pre_nonce = pre_info.as_ref().map(|i| i.nonce).unwrap_or(0);
            if pre_nonce != post_info.nonce {
                pre_acc.nonce = Some(pre_nonce);
                post_acc.nonce = Some(post_info.nonce);
                changed = true;
            }

            let pre_code_hash = pre_info
                .as_ref()
                .map(|i| i.code_hash)
                .unwrap_or(KECCAK_EMPTY);
            if pre_code_hash != post_info.code_hash {
                let pre_code = pre_info
                    .as_ref()
                    .and_then(|i| i.code.as_ref())
                    .map(|c| format!("0x{}", hex::encode(c.original_byte_slice())));
                let post_code = post_info
                    .code
                    .as_ref()
                    .map(|c| format!("0x{}", hex::encode(c.original_byte_slice())));
                pre_acc.code = pre_code;
                post_acc.code = post_code;
                changed = true;
            }

            let mut pre_storage = BTreeMap::new();
            let mut post_storage = BTreeMap::new();
            for (slot, entry) in account.storage.iter() {
                if entry.original_value() != entry.present_value() {
                    let k = format!("0x{slot:064x}");
                    pre_storage.insert(k.clone(), format!("0x{:064x}", entry.original_value()));
                    post_storage.insert(k, format!("0x{:064x}", entry.present_value()));
                }
            }
            if !pre_storage.is_empty() {
                pre_acc.storage = Some(pre_storage);
                post_acc.storage = Some(post_storage);
                changed = true;
            }

            if changed {
                let addr_str = format!("0x{address:x}");
                pre_map.insert(addr_str.clone(), pre_acc);
                post_map.insert(addr_str, post_acc);
            }
        }
        access_list.sort_by(|a, b| a.address.cmp(&b.address));

        let (success, gas_used, output, revert_reason) = match &result_state.result {
            ExecutionResult::Success {
                gas_used, output, ..
            } => {
                let out_bytes = match output {
                    Output::Call(b) => b.clone(),
                    Output::Create(b, _) => b.clone(),
                };
                (
                    true,
                    *gas_used,
                    format!("0x{}", hex::encode(&out_bytes)),
                    None,
                )
            }
            ExecutionResult::Revert { gas_used, output } => (
                false,
                *gas_used,
                format!("0x{}", hex::encode(output)),
                Some(decode_revert_reason(output)),
            ),
            ExecutionResult::Halt { gas_used, reason } => (
                false,
                *gas_used,
                String::from("0x"),
                Some(format!("{reason:?}")),
            ),
        };

        if success {
            evm.commit(result_state.state);
        }

        self.db = evm.0.ctx.journaled_state.into_database();

        Ok(ExecuteResult {
            success,
            gas_used,
            output,
            pre: pre_map,
            post: post_map,
            access_list,
            revert_reason,
        })
    }
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
    U256::from_str_radix(s, 16).map_err(|e| format!("bad u256: {e}"))
}

fn decode_revert_reason(output: &[u8]) -> String {
    if output.len() >= 68 && output[..4] == [0x08, 0xc3, 0x79, 0xa0] {
        let len_bytes = &output[36..68];
        let len = U256::from_be_slice(len_bytes).to::<usize>();
        if output.len() >= 68 + len {
            if let Ok(s) = std::str::from_utf8(&output[68..68 + len]) {
                return s.to_string();
            }
        }
    }
    format!("0x{}", hex::encode(output))
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
            Ok(Request::Init { id, params }) => {
                if let Some(spec) = params.spec {
                    if let Some(s) = parse_spec(&spec) {
                        harness.spec = s;
                    }
                }
                Response {
                    id,
                    ok: true,
                    result: Some(serde_json::json!({"spec": format!("{:?}", harness.spec)})),
                    error: None,
                }
            }
            Ok(Request::SetAccount { id, params }) => match harness.set_account(&params) {
                Ok(()) => Response {
                    id,
                    ok: true,
                    result: Some(serde_json::json!({})),
                    error: None,
                },
                Err(e) => Response {
                    id,
                    ok: false,
                    result: None,
                    error: Some(e),
                },
            },
            Ok(Request::Execute { id, params }) => match harness.execute(&params) {
                Ok(r) => Response {
                    id,
                    ok: true,
                    result: Some(serde_json::to_value(r).unwrap()),
                    error: None,
                },
                Err(e) => Response {
                    id,
                    ok: false,
                    result: None,
                    error: Some(e),
                },
            },
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

fn parse_spec(s: &str) -> Option<MonadSpecId> {
    match s {
        "MonadEight" => Some(MonadSpecId::MonadEight),
        _ => None,
    }
}
