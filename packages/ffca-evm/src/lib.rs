#![allow(dead_code)]

include!("main.rs");

use napi::bindgen_prelude::Result as NapiResult;
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
    pub fn call(&mut self, request_json: String) -> NapiResult<String> {
        let response = match serde_json::from_str::<Request>(&request_json) {
            Ok(req) => dispatch(&mut self.harness, req),
            Err(e) => Response {
                id: 0,
                ok: false,
                result: None,
                error: Some(format!("parse error: {e}")),
            },
        };

        serde_json::to_string(&response)
            .map_err(|e| napi::Error::from_reason(format!("response serialize error: {e}")))
    }
}
