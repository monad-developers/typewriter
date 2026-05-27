import type { FFCAConfig } from "ffca";
import {
  type Address,
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  parseSignature,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export const TOKEN_DOMAIN = { name: "Token", version: "1" } as const;

export type TokenSignature = {
  keyType: number;
  rawSignature: Hex;
};

export type MintArgs = {
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

export type TransferArgs = {
  from: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

const TRANSFER_TYPES = {
  Transfer: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const MINT_TYPES = {
  Mint: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const tokenMutations = {
  Transfer: {
    tag: 0,
    params: parseAbiParameters(
      "address from, address to, uint256 amount, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ args }) => {
      const transfer = args as TransferArgs;
      return [
        `accounts[${transfer.from}].nonce`,
        `accounts[${transfer.from}].balance`,
        `accounts[${transfer.to}].balance`,
      ];
    },
  },
  Mint: {
    tag: 1,
    params: parseAbiParameters(
      "address to, uint256 amount, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ args }) => {
      const mint = args as MintArgs;
      return [`accounts[${mint.to}].nonce`, `accounts[${mint.to}].balance`];
    },
  },
} satisfies FFCAConfig["mutations"];

export async function signTransfer(params: {
  account: PrivateKeyAccount;
  token: Address;
  chainId: number;
  transfer: TransferArgs;
}): Promise<TokenSignature> {
  const signature = await params.account.signTypedData({
    domain: {
      ...TOKEN_DOMAIN,
      chainId: params.chainId,
      verifyingContract: params.token,
    },
    types: TRANSFER_TYPES,
    primaryType: "Transfer",
    message: params.transfer,
  });
  const { v, r, s } = parseSignature(signature as Hex);
  return {
    keyType: 2,
    rawSignature: encodeAbiParameters(
      parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
      [Number(v), r, s],
    ),
  };
}

export async function signMint(params: {
  account: PrivateKeyAccount;
  token: Address;
  chainId: number;
  mint: MintArgs;
}): Promise<TokenSignature> {
  const signature = await params.account.signTypedData({
    domain: {
      ...TOKEN_DOMAIN,
      chainId: params.chainId,
      verifyingContract: params.token,
    },
    types: MINT_TYPES,
    primaryType: "Mint",
    message: params.mint,
  });
  const { v, r, s } = parseSignature(signature as Hex);
  return {
    keyType: 2,
    rawSignature: encodeAbiParameters(
      parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
      [Number(v), r, s],
    ),
  };
}
