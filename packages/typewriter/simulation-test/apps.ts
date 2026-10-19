import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect, type Random, type Scope } from "effect";
import { Address, Hash, Hex, Secp256k1 } from "ox";
import { encodeAbiParameters } from "viem";
import {
  deriveAccountID,
  getAuthorizationPayload,
  KeyType,
} from "../src/client";
import type { TypewriterManifest } from "../src/config";
import type { RpcRequest } from "../src/rpc-transport";
import type { Authorization } from "../src/types";
import type { Chain } from "./chain";
import { SIM } from "./index";

const ROOT = `${import.meta.dir}/../../..`;

export type Mutation = {
  name: string;
  params: unknown;
  authorization: Authorization;
};

/** Makes mutations for one app. */
export type Generator = {
  /** Makes the next mutation at `nowMs`. */
  next: (random: Random.Random, nowMs: number) => Mutation;
};

export type SimApp = {
  /** The app directory, relative to the repository root. */
  dir: string;
  /** The contract name of the Solidity entrypoint. */
  contract: string;
  makeGenerator: (manifest: TypewriterManifest) => Generator;
};

export function entrypoint(app: SimApp): string {
  return `${ROOT}/${app.dir}/contracts/src/${app.contract}.sol`;
}

/** Builds and deploys `app` from `deployer`, and returns its address. */
export function deploy({
  app,
  chain,
  deployer,
}: {
  app: SimApp;
  chain: Chain;
  deployer: Address.Address;
}): Effect.Effect<Address.Address, never, Scope.Scope> {
  return Effect.gen(function* () {
    const contracts = `${ROOT}/${app.dir}/contracts`;
    // A private build directory, so that parallel runs do not share artifacts.
    const out = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "typewriter-sim-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      $`forge build --root ${contracts} --out ${out}/out --cache-path ${out}/cache`.quiet(),
    );
    const artifact = yield* Effect.promise(() =>
      Bun.file(`${out}/out/${app.contract}.sol/${app.contract}.json`).json(),
    );
    const args = encodeAbiParameters([{ type: "address" }], [deployer]);
    // `PublicRpcSchema` does not include wallet methods.
    const hash = (yield* chain.request({
      method: "eth_sendTransaction",
      params: [
        { from: deployer, data: Hex.concat(artifact.bytecode.object, args) },
      ],
    } as unknown as RpcRequest)) as Hex.Hex;
    yield* chain.mine(SIM.chain.genesisTimestamp);
    const receipt = yield* chain.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (receipt?.contractAddress == null) {
      return yield* Effect.die(`deploy of ${app.contract} has no address`);
    }
    return receipt.contractAddress;
  });
}

type Signer = {
  accountID: Hex.Hex;
  publicKey: Hex.Hex;
  sign: (payload: Hex.Hex) => Hex.Hex;
};

/** Makes the secp256k1 signer of account `index` from the seed. */
function makeSigner(index: number): Signer {
  const privateKey = Hash.keccak256(
    Hex.fromString(`${SIM.seed}:account:${index}`),
  );
  const address = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey }));
  const publicKey = encodeAbiParameters([{ type: "address" }], [address]);
  return {
    accountID: deriveAccountID({ keyType: KeyType.Secp256k1, publicKey }),
    publicKey,
    sign: (payload) => {
      const { r, s, yParity } = Secp256k1.sign({ payload, privateKey });
      return encodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
        [27 + yParity, Hex.padLeft(r, 32), Hex.padLeft(s, 32)],
      );
    },
  };
}

function authorize(
  manifest: TypewriterManifest,
  signer: Signer,
  mutation: {
    name: string;
    params: unknown;
    nonce: bigint;
    expiration: bigint;
  },
): Mutation {
  const unsigned = {
    ...mutation,
    accountID: signer.accountID,
    credentialID: 0n,
  };
  const signature = signer.sign(
    getAuthorizationPayload(manifest, unsigned as never),
  );
  return {
    name: mutation.name,
    params: mutation.params,
    authorization: {
      accountID: unsigned.accountID,
      credentialID: unsigned.credentialID,
      nonce: unsigned.nonce,
      expiration: unsigned.expiration,
      signature,
    },
  };
}

function index(random: Random.Random, length: number): number {
  return Math.floor(random.nextDoubleUnsafe() * length);
}

function makeTokenGenerator(manifest: TypewriterManifest): Generator {
  const signers = Array.from({ length: SIM.generator.accounts }, (_, i) =>
    makeSigner(i),
  );
  const created: Signer[] = [];
  const nonces = new Map<Hex.Hex, bigint>();

  return {
    next: (random, nowMs) => {
      const uncreated = signers[created.length];
      if (
        uncreated !== undefined &&
        (created.length === 0 || random.nextDoubleUnsafe() < 0.2)
      ) {
        created.push(uncreated);
        nonces.set(uncreated.accountID, 0n);
        return authorize(manifest, uncreated, {
          name: "CreateAccount",
          params: {
            keyType: KeyType.Secp256k1,
            publicKey: uncreated.publicKey,
          },
          nonce: 0n,
          expiration: 0n,
        });
      }

      const from = created[index(random, created.length)]!;
      const nonce = nonces.get(from.accountID)!;
      nonces.set(from.accountID, nonce + 1n);
      const expiration = BigInt(Math.floor(nowMs / 1000) + 60);
      const amount = BigInt(1 + index(random, 1_000));

      if (created.length < 2 || random.nextDoubleUnsafe() < 0.5) {
        return authorize(manifest, from, {
          name: "Mint",
          params: { amount },
          nonce,
          expiration,
        });
      }
      const others = created.filter((signer) => signer !== from);
      const to = others[index(random, others.length)]!;
      return authorize(manifest, from, {
        name: "Transfer",
        params: { to: to.accountID, amount },
        nonce,
        expiration,
      });
    },
  };
}

export const APPS: { [name: string]: SimApp } = {
  token: {
    dir: "apps/token",
    contract: "Token",
    makeGenerator: makeTokenGenerator,
  },
};
