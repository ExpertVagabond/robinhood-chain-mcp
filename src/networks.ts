/**
 * Robinhood Chain networks.
 *
 * Robinhood Chain is an Arbitrum Orbit L2 settling on Ethereum, fully EVM-compatible,
 * with ETH as the gas token — there is no custom gas currency to account for.
 *
 * Both chain IDs below were confirmed against the live RPCs via eth_chainId
 * (mainnet 0x1237 = 4663, testnet 0xb626 = 46630) rather than taken from docs.
 */

export interface NetworkConfig {
  name: string;
  chainId: number;
  chainIdHex: string;
  rpcUrl: string;
  /** Blockscout instance, or undefined where none is published. */
  explorerUrl?: string;
  /** Blockscout REST v2 base, derived from explorerUrl. */
  explorerApiUrl?: string;
  nativeSymbol: string;
  nativeDecimals: number;
  testnet: boolean;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    name: "Robinhood Chain",
    chainId: 4663,
    chainIdHex: "0x1237",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com/",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerApiUrl: "https://robinhoodchain.blockscout.com/api/v2",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    testnet: false,
  },
  testnet: {
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    chainIdHex: "0xb626",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com/",
    // Found in the docs-site JS bundle, not the documentation itself. An earlier
    // guess at a robinhoodchain-testnet.blockscout.com host 404s, which is why this
    // was briefly recorded as "no explorer" — verified live before being restored.
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    explorerApiUrl: "https://explorer.testnet.chain.robinhood.com/api/v2",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    testnet: true,
  },
};

export function resolveNetwork(): NetworkConfig {
  const requested = (process.env.ROBINHOOD_NETWORK ?? "mainnet").toLowerCase();
  const base = NETWORKS[requested] ?? NETWORKS.mainnet;
  const rpcOverride = process.env.ROBINHOOD_RPC_URL;
  return rpcOverride ? { ...base, rpcUrl: rpcOverride } : base;
}
