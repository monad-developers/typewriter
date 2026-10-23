// napi-rs addon: the production transport for typewriter-evm.
//
// The native class owns one `EvmHarness` (see `harness.rs`). The constructor
// takes the JSON init params, and `call` forwards a JSON request and returns
// a JSON response. The TypeScript client owns one instance per `createEVM()`.

mod harness;

use harness::{dispatch_json, EvmHarness};
use napi_derive::napi;

#[napi]
pub struct NativeEvm {
    harness: EvmHarness,
}

#[napi]
impl NativeEvm {
    #[napi(constructor)]
    pub fn new(params_json: String) -> napi::Result<Self> {
        let harness = EvmHarness::from_json(&params_json).map_err(napi::Error::from_reason)?;
        Ok(Self { harness })
    }

    #[napi]
    pub fn call(&mut self, request_json: String) -> String {
        dispatch_json(&mut self.harness, &request_json)
    }
}
