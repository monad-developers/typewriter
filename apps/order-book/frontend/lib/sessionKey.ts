import { bytesToHex } from "viem";

export async function generateSessionKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

export async function exportPublicKey(
  keyPair: CryptoKeyPair,
): Promise<`0x${string}`> {
  const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return bytesToHex(new Uint8Array(raw));
}
