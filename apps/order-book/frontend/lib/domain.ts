import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseAbiParameters,
  toHex,
} from "viem";

const TYPEWRITER_DOMAIN_NAME = "Typewriter";
const TYPEWRITER_DOMAIN_VERSION = "1";

export type AppDomain = {
  chainId: number;
  verifyingContract: Address;
};

export function domainHash(domain: AppDomain): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        keccak256(
          toHex(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ),
        ),
        keccak256(toHex(TYPEWRITER_DOMAIN_NAME)),
        keccak256(toHex(TYPEWRITER_DOMAIN_VERSION)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
}
