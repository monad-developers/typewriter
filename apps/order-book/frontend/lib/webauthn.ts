import { bytesToHex, encodeAbiParameters, type Hex } from "viem";
import type { Authentication } from "webauthx/client";

export const RP_ID: string =
  (typeof process !== "undefined" ? process.env.BUN_PUBLIC_RP_ID : undefined) ||
  window.location.hostname;
export const RP_NAME = "Order Book";

export function splitSignature(hex: Hex): { r: bigint; s: bigint } {
  return {
    r: BigInt(`0x${hex.slice(2, 66)}`),
    s: BigInt(`0x${hex.slice(66)}`),
  };
}

export function encodeWebAuthnSignature(
  assertion: Authentication.Response,
): Hex {
  const { r, s } = splitSignature(assertion.signature);
  const clientDataJSON = assertion.metadata.clientDataJSON;
  const marker = '"challenge":"';
  const markerIndex = clientDataJSON.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("WebAuthn clientDataJSON missing challenge field");
  }
  const challengeOffset = BigInt(markerIndex + marker.length);
  return encodeAbiParameters(
    [
      { type: "bytes" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      assertion.metadata.authenticatorData,
      clientDataJSON,
      challengeOffset,
      r,
      s,
    ],
  );
}

export async function identify(): Promise<Hex> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32))
        .buffer as ArrayBuffer,
      rpId: RP_ID,
      userVerification: "discouraged",
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Sign-in cancelled");
  const assertion = credential.response as AuthenticatorAssertionResponse;
  if (!assertion.userHandle) throw new Error("Passkey missing userHandle");
  return bytesToHex(new Uint8Array(assertion.userHandle)) as Hex;
}
