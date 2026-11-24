import { bytesToHex, type Hex } from "viem";

export const RP_ID: string =
  (typeof process !== "undefined" ? process.env.BUN_PUBLIC_RP_ID : undefined) ||
  window.location.hostname;
export const RP_NAME = "Order Book";

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
