import { type Subprocess, spawn } from "bun";
import type * as AccessList from "ox/AccessList";
import type { Address } from "ox/Address";
import type { Hex } from "ox/Hex";

export type EvmAccount = {
  balance?: bigint;
  nonce?: number;
  code?: Hex;
  storage?: { [slot: Hex]: Hex };
};

export type EvmStateDiff = { [address: Address]: EvmAccount };

export type EvmExecuteParams = {
  from: Address;
  to: Address;
  data: Hex;
  gasLimit?: number;
};

export type EvmExecuteResult = {
  success: boolean;
  gasUsed: number;
  output: Hex;
  pre: EvmStateDiff;
  post: EvmStateDiff;
  accessList: AccessList.AccessList;
  revertReason?: string;
};

export type EvmConfig = {
  spec?: string;
  accounts?: { [address: Address]: EvmAccount };
};

const BINARY_PATH = `${import.meta.dir}/target/release/evm`;

export type EVM = {
  execute(params: EvmExecuteParams): Promise<EvmExecuteResult>;
  close(): Promise<void>;
};

type RequestInit = { method: "init"; id: number; params: WireInitParams };
type RequestSetAccount = {
  method: "setAccount";
  id: number;
  params: WireSetAccountParams;
};
type RequestExecute = {
  method: "execute";
  id: number;
  params: WireExecuteParams;
};
type Request = RequestInit | RequestSetAccount | RequestExecute;

type Response<T = unknown> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };

type WireInitParams = { spec?: string };

type WireSetAccountParams = {
  address: Address;
  balance?: Hex;
  nonce?: number;
  code?: Hex;
  storage?: { [slot: Hex]: Hex };
};

type WireExecuteParams = {
  from: Address;
  to: Address;
  data: Hex;
  gas_limit?: number;
};

type WireAccount = {
  balance?: Hex;
  nonce?: number;
  code?: Hex;
  storage?: { [slot: Hex]: Hex };
};

type WireExecuteResult = {
  success: boolean;
  gas_used: number;
  output: Hex;
  pre: Record<Address, WireAccount>;
  post: Record<Address, WireAccount>;
  access_list: Array<{ address: Address; storage_keys: readonly Hex[] }>;
  revert_reason?: string;
};

function normalizeResult(r: WireExecuteResult): EvmExecuteResult {
  const normalizeSide = (side: Record<Address, WireAccount>): EvmStateDiff => {
    const out: EvmStateDiff = {};
    for (const [addr, acc] of Object.entries(side) as [
      Address,
      WireAccount,
    ][]) {
      out[addr] = {
        ...(acc.balance !== undefined && { balance: BigInt(acc.balance) }),
        ...(acc.nonce !== undefined && { nonce: acc.nonce }),
        ...(acc.code !== undefined && { code: acc.code }),
        ...(acc.storage !== undefined && { storage: acc.storage }),
      };
    }
    return out;
  };
  return {
    success: r.success,
    gasUsed: r.gas_used,
    output: r.output,
    pre: normalizeSide(r.pre),
    post: normalizeSide(r.post),
    accessList: r.access_list.map((e) => ({
      address: e.address,
      storageKeys: e.storage_keys,
    })),
    revertReason: r.revert_reason,
  };
}

export async function createEVM(config: EvmConfig = {}): Promise<EVM> {
  if (!(await Bun.file(BINARY_PATH).exists())) {
    throw new Error(
      `evm binary not built at ${BINARY_PATH} — run \`bun run build\` in packages/evm`,
    );
  }
  const proc: Subprocess<"pipe", "pipe", "inherit"> = spawn({
    cmd: [BINARY_PATH],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let buffer = "";

  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Response;
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(new Error(msg.error));
        }
      }
    } catch (err) {
      for (const entry of pending.values()) {
        entry.reject(err as Error);
      }
      pending.clear();
    }
  })();

  const stdin = proc.stdin;

  function call<T>(
    req: Omit<Request, "id"> & { params: Request["params"] },
  ): Promise<T> {
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    stdin.flush();
    return promise;
  }

  await call<unknown>({
    method: "init",
    params: { spec: config.spec },
  });

  if (config.accounts) {
    for (const [address, acc] of Object.entries(config.accounts) as [
      Address,
      EvmAccount,
    ][]) {
      await call<unknown>({
        method: "setAccount",
        params: {
          address,
          ...(acc.balance !== undefined && {
            balance: `0x${acc.balance.toString(16)}` as Hex,
          }),
          ...(acc.nonce !== undefined && { nonce: acc.nonce }),
          ...(acc.code !== undefined && { code: acc.code }),
          ...(acc.storage !== undefined && { storage: acc.storage }),
        },
      });
    }
  }

  return {
    async execute(params) {
      const r = await call<WireExecuteResult>({
        method: "execute",
        params: {
          from: params.from,
          to: params.to,
          data: params.data,
          gas_limit: params.gasLimit,
        },
      });
      return normalizeResult(r);
    },
    async close() {
      try {
        stdin.end();
      } catch {}
      proc.kill();
      await proc.exited;
    },
  };
}
