/**
 * Canonical Robinhood Chain assets and the EIP-3009 surface.
 *
 * USDG is the chain's native stablecoin (Paxos Global Dollar). It matters more than
 * a typical ERC-20 here because Robinhood Chain has no canonical USDC — USDC bridged
 * in from any of the 13 supported source chains arrives as USDG.
 */

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface KnownAsset {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  /** Supports EIP-3009 transferWithAuthorization (gasless, third-party submitted). */
  eip3009: boolean;
  /** Supports EIP-2612 permit. */
  eip2612: boolean;
  domain?: Eip712Domain;
  /** Expected DOMAIN_SEPARATOR, for drift detection against the live contract. */
  expectedDomainSeparator?: `0x${string}`;
  note?: string;
}

export const KNOWN_ASSETS: Record<string, KnownAsset> = {
  USDG: {
    symbol: "USDG",
    name: "Global Dollar",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    eip3009: true,
    eip2612: true,
    // USDG does not expose version(), so the domain was derived by matching the
    // on-chain DOMAIN_SEPARATOR rather than assumed:
    //   keccak256(abi.encode(EIP712Domain_typehash, keccak("Global Dollar"),
    //     keccak("1"), 4663, 0x5fc5...d168)) == the value below, exactly.
    domain: {
      name: "Global Dollar",
      version: "1",
      chainId: 4663,
      verifyingContract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    },
    expectedDomainSeparator:
      "0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036",
    note: "Native stablecoin. USDC bridged from other chains arrives as USDG. EIP-2535 Diamond — its facets do not appear in the proxy bytecode, so scanning bytecode for selectors gives a false negative.",
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    decimals: 18,
    eip3009: false,
    eip2612: false,
  },
  USDE: {
    symbol: "USDE",
    name: "Ethena USDe",
    address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
    decimals: 18,
    eip3009: false,
    eip2612: false,
    note: "eip3009/eip2612 flags not probed; treat as unverified.",
  },
};

export function resolveAsset(symbolOrAddress: string): KnownAsset | undefined {
  const needle = symbolOrAddress.trim().toLowerCase();
  return Object.values(KNOWN_ASSETS).find(
    (a) =>
      a.symbol.toLowerCase() === needle || a.address.toLowerCase() === needle,
  );
}

/** Function selectors, for probing an unknown token's capabilities. */
export const SELECTORS = {
  // ERC-20
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  // EIP-2612
  permit: "0xd505accf",
  nonces: "0x7ecebe00",
  DOMAIN_SEPARATOR: "0x3644e515",
  // EIP-3009
  transferWithAuthorization: "0xe3ee160e",
  receiveWithAuthorization: "0xef55bec6",
  cancelAuthorization: "0x5a049a70",
  authorizationState: "0xe94a0102",
} as const;

/**
 * Revert selectors that mean "this function does not exist here", as opposed to
 * "this function exists and rejected your arguments". Distinguishing the two is the
 * only reliable way to detect capabilities on a Diamond, whose facet code is not
 * reachable from the proxy's bytecode.
 */
export const UNKNOWN_FUNCTION_REVERTS: Record<string, string> = {
  "0x800ab12c": "FacetNotFound() — EIP-2535 Diamond, no facet for this selector",
};

/** EIP-712 type for TransferWithAuthorization, per EIP-3009. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
