import { Bytes, Hex, Signature } from "ox";
import type { TypewriterManifest } from "typewriter";
import { createSigner, KeyType } from "typewriter/client";

/** Signs `manifest`'s mutations with a Web Crypto ECDSA P-256 key pair. */
export async function webCryptoSigner<
  const manifest extends TypewriterManifest,
>(manifest: manifest, keyPair: CryptoKeyPair) {
  const publicKey = Hex.fromBytes(
    new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
  );
  return createSigner(manifest, {
    keyType: KeyType.P256,
    publicKey,
    async sign(payload) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        Uint8Array.from(Bytes.fromHex(payload)),
      );
      return Signature.fromHex(Hex.fromBytes(new Uint8Array(signature)));
    },
  });
}
