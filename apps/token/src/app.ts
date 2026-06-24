import { FFCA_DOMAIN } from "typewriter";
import {
  type Address,
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  parseSignature,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

const TOKEN_DOMAIN = FFCA_DOMAIN;

export type TokenSignature = {
  keyType: number;
  rawSignature: Hex;
};

export type MintParams = {
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

export type TransferParams = {
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

export async function signTransfer(params: {
  account: PrivateKeyAccount;
  token: Address;
  chainId: number;
  transfer: TransferParams;
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
  const rawSignature = encodeAbiParameters(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [Number(v), r, s],
  );
  return { keyType: 2, rawSignature };
}

export async function signMint(params: {
  account: PrivateKeyAccount;
  token: Address;
  chainId: number;
  mint: MintParams;
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
  const rawSignature = encodeAbiParameters(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [Number(v), r, s],
  );
  return { keyType: 2, rawSignature };
}
