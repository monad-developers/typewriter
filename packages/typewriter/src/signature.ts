import { AbiParameters, Hex, Signature as OxSignature } from "ox";
import {
  P256_SIGNATURE_PARAMS,
  SECP256K1_SIGNATURE_PARAMS,
} from "./typewriter-constants";

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function packP256Signature(signature: Hex.Hex): Hex.Hex {
  assertSignatureSize(signature, 64, "P256");
  const r = BigInt(Hex.slice(signature, 0, 32));
  const s = BigInt(Hex.slice(signature, 32, 64));
  return AbiParameters.encode(P256_SIGNATURE_PARAMS, [
    r,
    s > P256_N / 2n ? P256_N - s : s,
  ]);
}

export function packSecp256k1Signature(signature: Hex.Hex): Hex.Hex {
  assertSignatureSize(signature, 65, "secp256k1");
  const v = Number(BigInt(Hex.slice(signature, 64, 65)));
  return AbiParameters.encode(SECP256K1_SIGNATURE_PARAMS, [
    OxSignature.vToYParity(v) + 27,
    Hex.slice(signature, 0, 32),
    Hex.slice(signature, 32, 64),
  ]);
}

function assertSignatureSize(
  signature: Hex.Hex,
  expected: number,
  name: string,
): void {
  if (
    !Hex.validate(signature, { strict: true }) ||
    Hex.size(signature) !== expected
  ) {
    throw new Error(`${name} signature must be ${expected} bytes`);
  }
}
