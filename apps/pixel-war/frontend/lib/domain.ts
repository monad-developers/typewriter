import { type Hex, keccak256, stringToHex } from "viem";

export type AppDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
};

/// Keys local storage per deployment so a redeploy never resurrects an account
/// whose keys the new contract has never seen.
export function domainHash(domain: AppDomain): Hex {
  return keccak256(
    stringToHex(
      `${domain.name}:${domain.version}:${domain.chainId}:${domain.verifyingContract}`,
    ),
  );
}
