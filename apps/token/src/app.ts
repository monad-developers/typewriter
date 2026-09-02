import { deriveAccountID, KeyType } from "typewriter/client";
import { encodeAbiParameters, type Hex, parseSignature } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export function secp256k1Credential(account: PrivateKeyAccount): {
  accountID: Hex;
  keyType: typeof KeyType.Secp256k1;
  publicKey: Hex;
  signer: (payload: Hex) => Promise<Hex>;
} {
  const publicKey = encodeAbiParameters(
    [{ name: "account", type: "address" }],
    [account.address],
  );
  const keyType = KeyType.Secp256k1;
  return {
    accountID: deriveAccountID({ keyType, publicKey }),
    keyType,
    publicKey,
    signer: async (payload) => {
      const { v, r, s } = parseSignature(await account.sign({ hash: payload }));
      return encodeAbiParameters(
        [
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
        [Number(v), r, s],
      );
    },
  };
}
