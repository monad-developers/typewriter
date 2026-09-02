import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { bytesToHex } from "viem";
import {
  Authentication as ClientAuthentication,
  Registration as ClientRegistration,
} from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import { useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, RP_ID, RP_NAME } from "../lib/webauthn";

export function useSignUp() {
  const { setAccount } = useAccountContext();
  const { domain } = useDomainContext();

  return useMutation({
    mutationFn: async () => {
      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);
      if (domain === null) throw new Error("Missing domain");

      const placeholderUserId = crypto.getRandomValues(new Uint8Array(32));
      const { options: createOptions } = ServerRegistration.getOptions({
        name: RP_NAME,
        rp: { id: RP_ID, name: RP_NAME },
        user: { id: placeholderUserId, name: RP_NAME, displayName: RP_NAME },
        authenticatorSelection: {
          userVerification: "discouraged",
          residentKey: "required",
          requireResidentKey: true,
        },
      });
      const credential = await ClientRegistration.create({
        options: createOptions,
      });

      const createParams = {
        keyType: 1,
        publicKey: credential.publicKey,
      } as const;
      const accountId = deriveAccountID(createParams);
      const createMutation = {
        name: "CreateAccount",
        params: createParams,
        accountID: accountId,
        credentialID: 0n,
        nonce: 0n,
        expiration: 0n,
      } as unknown as TypedMutation<typeof domain, "CreateAccount">;
      const createAssertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: getAuthorizationPayload(domain, createMutation),
      });

      await request("/api", {
        method: "POST",
        body: authorizeMutation(
          createMutation,
          encodeWebAuthnSignature(createAssertion),
        ),
      });

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
      const addAssertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: getAuthorizationPayload(domain, addMutation),
      });
      await request("/api", {
        method: "POST",
        body: authorizeMutation(
          addMutation,
          encodeWebAuthnSignature(addAssertion),
        ),
      });

      await setAccount({ accountId, keyId: 1, sessionKey });
    },
  });
}
