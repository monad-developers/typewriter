import { Secp256k1 } from "ox";
import {
  type PerpsMutation,
  type PerpsMutationName,
  type PerpsParams,
  secp256k1Signer,
} from "perps-sdk";
import type { Hex } from "viem";
import { app, dev, requireEnv } from "./app";
import { accountExists } from "./read";

const ZERO = `0x${"0".repeat(64)}`;

const privateKey = (
  dev
    ? (process.env.ADMIN_PRIVATE_KEY ?? Secp256k1.randomPrivateKey())
    : requireEnv("ADMIN_PRIVATE_KEY")
) as Hex;

const signer = secp256k1Signer(app.manifest, privateKey);

/** The server's own account, which signs every admin mutation. */
export const admin = {
  accountID: signer.accountID,
  execute: <const name extends PerpsMutationName>(
    name: name,
    params: PerpsParams<name>,
  ) => app.execute(signer.sign(name, params) as PerpsMutation),
};

/**
 * Creates the admin account and claims the admin seat if it is empty. Fails
 * if another account holds it.
 */
export async function bootstrapAdmin() {
  if (!accountExists(admin.accountID)) {
    await app.execute(signer.createAccount);
  }
  const current = app.state.admin;
  if (current === ZERO) {
    await admin.execute("SetAdmin", { admin: admin.accountID });
  } else if (current.toLowerCase() !== admin.accountID.toLowerCase()) {
    throw new Error(
      `ADMIN_PRIVATE_KEY's account ${admin.accountID} is not the admin ${current}`,
    );
  }
}
