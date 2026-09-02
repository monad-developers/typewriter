import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import { Hex as OxHex, Secp256k1, Signature } from "ox";
import type * as HexNamespace from "ox/Hex";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { bytesToHex, encodeAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";

function signSecp256k1(privateKey: Hex, payload: Hex): Hex {
  const signature = Secp256k1.sign({
    payload,
    privateKey: privateKey as HexNamespace.Hex,
  });
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      Signature.yParityToV(signature.yParity),
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}

export function useDemoSignUp() {
  const { setAccount } = useAccountContext();
  const { domain } = useDomainContext();

  return useMutation({
    mutationFn: async () => {
      if (domain === null) throw new Error("Missing domain");
      const rootPrivateKey = generatePrivateKey();
      const rootAddress = privateKeyToAccount(rootPrivateKey).address;
      const rootPublicKey = encodeAbiParameters(
        [{ type: "address" }],
        [rootAddress],
      );
      const createParams = { keyType: 2, publicKey: rootPublicKey } as const;
      const accountId = deriveAccountID(createParams);
      const createMutation = {
        name: "CreateAccount",
        params: createParams,
        accountID: accountId,
        credentialID: 0n,
        nonce: 0n,
        expiration: 0n,
      } as unknown as TypedMutation<typeof domain, "CreateAccount">;
      const create = authorizeMutation(
        createMutation,
        signSecp256k1(
          rootPrivateKey,
          getAuthorizationPayload(domain, createMutation),
        ),
      );
      await request("/api", { method: "POST", body: create });

      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);
      const addMutation = {
        name: "AddCredential",
        params: {
          expiration: 0n,
          keyType: 0,
          permissions: BigInt(DEFAULT_NON_ROOT_PERMISSIONS),
          publicKey: sessionPublicKey,
        },
        accountID: accountId,
        credentialID: 0n,
        nonce:
          BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24)))) << 64n,
        expiration: 0n,
      } as unknown as TypedMutation<typeof domain, "AddCredential">;
      const add = authorizeMutation(
        addMutation,
        signSecp256k1(
          rootPrivateKey,
          getAuthorizationPayload(domain, addMutation),
        ),
      );
      await request("/api", { method: "POST", body: add });
      await setAccount({ accountId, keyId: 1, sessionKey });
    },
  });
}
