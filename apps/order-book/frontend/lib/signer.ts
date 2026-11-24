import type { OrderBookManifest } from "order-book-sdk";
import { Bytes, Hex, Signature, WebAuthnP256 } from "ox";
import { createSigner, KeyType } from "typewriter/client";

/** Signs with a Web Crypto ECDSA P-256 key pair, such as a session key. */
export async function webCryptoSigner(
  manifest: OrderBookManifest,
  keyPair: CryptoKeyPair,
) {
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

/** Signs with a passkey, asking the authenticator for each signature. */
export function passkeySigner(
  manifest: OrderBookManifest,
  publicKey: Hex.Hex,
  rpId: string,
) {
  return createSigner(manifest, {
    keyType: KeyType.WebAuthnP256,
    publicKey,
    async sign(payload) {
      const { metadata, signature } = await WebAuthnP256.sign({
        challenge: payload,
        rpId,
      });
      return { ...signature, ...metadata };
    },
  });
}
