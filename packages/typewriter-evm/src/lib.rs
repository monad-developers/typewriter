// napi-rs addon: the production transport for typewriter-evm.
//
// The native class owns one `EvmHarness` (see `harness.rs`) and exposes a
// single `call` method that forwards a JSON request and returns a JSON
// response. The JSON protocol is intentionally preserved across the FFI
// boundary so the Rust harness stays transport-agnostic and the TypeScript
// client owns one instance per `createEVM()`.

mod harness;

use harness::{dispatch_json, EvmHarness};
use napi_derive::napi;

#[napi]
pub struct NativeEvm {
    harness: EvmHarness,
}

impl Default for NativeEvm {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl NativeEvm {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            harness: EvmHarness::new(),
        }
    }

    #[napi]
    pub fn call(&mut self, request_json: String) -> String {
        dispatch_json(&mut self.harness, &request_json)
    }
}
