/**
 * Blockscout REST v2 client.
 *
 * Robinhood Chain's explorer is a Blockscout instance, which gives indexed access the
 * raw JSON-RPC cannot: token enumeration, holder counts, address transaction history.
 * Only mainnet has one — testnet calls fail with a clear message rather than a
 * confusing network error.
 */

import type { NetworkConfig } from "./networks.js";

export class NoExplorerError extends Error {
  constructor(network: string) {
    super(
      `No block explorer is published for ${network}. Explorer-backed tools are mainnet-only; JSON-RPC tools work on both networks.`,
    );
  }
}

export class BlockscoutClient {
  constructor(private network: NetworkConfig) {}

  get available(): boolean {
    return Boolean(this.network.explorerApiUrl);
  }

  async get<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    if (!this.network.explorerApiUrl) {
      throw new NoExplorerError(this.network.name);
    }
    const url = new URL(this.network.explorerApiUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Blockscout is a public, rate-limited service that returns intermittent 5xx
    // under bursts. Retry server errors with backoff; never retry 4xx, which are our
    // fault and will fail identically every time.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "robinhood-chain-mcp" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return (await res.json()) as T;
      lastStatus = res.status;
      if (res.status < 500) break;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw new Error(
      `Blockscout HTTP ${lastStatus} for ${path}` +
        (lastStatus >= 500 ? " (retried 3x — the explorer is likely rate-limiting or down)" : ""),
    );
  }
}

export interface TokenItem {
  address?: string;
  address_hash?: string;
  symbol?: string;
  name?: string;
  decimals?: string;
  type?: string;
  holders?: string;
  holders_count?: string;
  total_supply?: string;
  exchange_rate?: string | null;
  circulating_market_cap?: string | null;
}

/** Blockscout has moved this field name between versions; accept either. */
export const tokenAddress = (t: TokenItem): string =>
  t.address ?? t.address_hash ?? "";
export const tokenHolders = (t: TokenItem): string =>
  t.holders ?? t.holders_count ?? "0";
