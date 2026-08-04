import { bytesToHex, encodeAbiParameters, type Hex, hexToBytes } from "viem";

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export async function generateSessionKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

export async function exportPublicKey(keyPair: CryptoKeyPair): Promise<Hex> {
  const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return bytesToHex(new Uint8Array(raw));
}

/// Signs an EIP-712 digest with the session key. The contract's P-256 path hashes
/// the digest with SHA-256 before handing it to the precompile, which is exactly
/// what WebCrypto's ECDSA/SHA-256 does, and it wants a low `s`.
export async function signP256(
  sessionKey: CryptoKeyPair,
  hash: Hex,
): Promise<Hex> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    sessionKey.privateKey,
    hexToBytes(hash).buffer as ArrayBuffer,
  );
  const bytes = new Uint8Array(signature);
  const r = BigInt(bytesToHex(bytes.slice(0, 32)));
  let s = BigInt(bytesToHex(bytes.slice(32)));
  if (s > P256_N / 2n) s = P256_N - s;
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [r, s],
  );
}
