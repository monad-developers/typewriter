import type { Abi, Address } from "ox";
import type { AbiParameter, PrivateKeyAccount } from "viem";

// TODO(kyle) add encode/decode, db schema,
// `tag` is the contract enum index for this mutation; encoded as the uint8
// in the bundle's `mutations[]` field. Hand-authored for now — see the
// "derive from the contract" idea in CLAUDE.md.
//
// `resolve` must be pure: read-only over `state` and `bundle`, no side
// effects. The runtime calls it once per mutation immediately before `apply`,
// and treats its return value as canonical (it's encoded into calldata and
// passed to `apply`). A `resolve` that mutates state breaks failure isolation
// and replay determinism.
//
// `bundle` is a read-only view of every mutation in this bundle (in
// post-sequence order, including this one). Use it for batch-aware decisions
// — e.g. seeing what other mutations are landing alongside this one.
export type BundleView = readonly { name: string; args: unknown }[];

export type FFCAMutationConfig =
  | {
      tag: number;
      params: readonly AbiParameter[];
      apply: (state: unknown, args: unknown) => void;
    }
  | {
      tag: number;
      params: readonly AbiParameter[];
      resolution: readonly AbiParameter[];
      resolve: (state: unknown, args: unknown, bundle: BundleView) => unknown;
      apply: (state: unknown, args: unknown, resolution: unknown) => void;
    };

export type FFCAConfig = {
  address: Address.Address;
  domain: { name: string; version: string };
  abi: Abi.Abi;
  account: PrivateKeyAccount;
  chainId: number;
  rpcUrl: string | string[];
  state: { initial: unknown };
  // ABI shape of one entry in the contract's `bundle.signatures[]` array.
  // Must include `keyType: uint8` and `rawSignature: bytes`; apps add
  // whatever else (account, keyId, …) the contract expects.
  signature: { params: readonly AbiParameter[] };
  mutations: { [name: string]: FFCAMutationConfig };
  // Order in which queued mutations are sorted within a bundle, before
  // resolve+apply. Every mutation submitted to the runtime must have a name
  // in this list. Stable within a name (insertion order preserved). Omit for
  // FIFO. Future: replace with a state-aware callback.
  sequence?: readonly string[];
};
