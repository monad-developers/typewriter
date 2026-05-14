import { AbiFunction, AbiParameters, type Address, Hash, Hex } from "ox";
import type { StorageLayout } from "storage-layout";
import type { Abi, Hex as ViemHex } from "viem";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_WALLET_CLIENT,
} from "./setup";

export const TOKEN_ADDR = "0x0000000000000000000000000000000000000e20" as const;
export const SCHEDULER_ADDR = SCHEDULER_ACCOUNT.address;
export const USER_ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
export const RECIPIENT_ADDR =
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;

export const INITIAL_SUPPLY = 1_000_000_000_000_000_000_000n;
export const TRANSFER_AMOUNT = 123_000_000_000_000_000_000n;
export const SIMULATE_AMOUNT = 456_000_000_000_000_000_000n;

export const TOTAL_SUPPLY_SLOT = Hex.fromNumber(2n, { size: 32 });
export const BALANCE_OF_SLOT = 3n;

export const tokenStorageLayout = {
  storage: [
    {
      astId: 1,
      contract: "test/contracts/src/TestToken.sol:TestToken",
      label: "totalSupply",
      offset: 0,
      slot: "2",
      type: "t_uint256",
    },
    {
      astId: 2,
      contract: "test/contracts/src/TestToken.sol:TestToken",
      label: "balanceOf",
      offset: 0,
      slot: "3",
      type: "t_mapping(t_address,t_uint256)",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
    },
    "t_mapping(t_address,t_uint256)": {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => uint256)",
      numberOfBytes: "32",
      value: "t_uint256",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

export type ForgeArtifact = {
  abi: Abi;
  bytecode: { object: ViemHex };
  deployedBytecode: { object: Hex.Hex };
};

export function mappingSlot(key: Address.Address, slot: bigint): Hex.Hex {
  return Hash.keccak256(
    AbiParameters.encode(AbiParameters.from("address, uint256"), [key, slot]),
  );
}

export function normalizeAccessRecord(
  accessList: readonly {
    address: Address.Address;
    storageKeys: readonly Hex.Hex[];
  }[],
): { address: string; storageKeys: Hex.Hex[] }[] {
  return accessList
    .map(({ address, storageKeys }) => ({
      address: address.toLowerCase(),
      storageKeys: [...storageKeys].sort(),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

export async function loadTestToken(): Promise<ForgeArtifact> {
  return (await Bun.file(
    `${import.meta.dir}/contracts/out/TestToken.sol/TestToken.json`,
  ).json()) as ForgeArtifact;
}

export function tokenInit(
  artifact: ForgeArtifact,
  tokenAddr: Address.Address = TOKEN_ADDR,
) {
  const schedulerBalanceSlot = mappingSlot(SCHEDULER_ADDR, BALANCE_OF_SLOT);
  return {
    schedulerBalanceSlot,
    params: {
      chain_id: 31337,
      accounts: {
        [tokenAddr]: {
          code: artifact.deployedBytecode.object,
          storage: {
            [TOTAL_SUPPLY_SLOT]: Hex.fromNumber(INITIAL_SUPPLY, { size: 32 }),
            [schedulerBalanceSlot]: Hex.fromNumber(INITIAL_SUPPLY, {
              size: 32,
            }),
          },
        },
      },
    },
  } as const;
}

export function transferData(to: Address.Address, amount: bigint): Hex.Hex {
  const transfer = AbiFunction.from(
    "function transfer(address to, uint256 amount) returns (bool)",
  );
  return AbiFunction.encodeData(transfer, [to, amount]);
}

export async function deployTestToken(
  artifact: ForgeArtifact,
): Promise<Address.Address> {
  const hash = await TEST_WALLET_CLIENT.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [SCHEDULER_ADDR, INITIAL_SUPPLY],
  });
  const receipt = await TEST_PUBLIC_CLIENT.waitForTransactionReceipt({ hash });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error("missing contract address");
  }
  return receipt.contractAddress;
}
