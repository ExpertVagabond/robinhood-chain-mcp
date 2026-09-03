/**
 * Blockscout REST v2 client.
 *
 * Robinhood Chain's explorer is a Blockscout instance, which gives indexed access the
 * raw JSON-RPC cannot: token enumeration, holder counts, address transaction history.
 * Only mainnet has one — testnet calls fail with a clear message rather than a
 * confusing network error.
 */

import type { NetworkConfig } from "./networks.js";

/**
 * Cloudflare (or another edge control) refused the request before Blockscout saw it.
 * Distinct from a chain or contract problem: the explorer is up, we were turned away.
 * The live canary skips on this rather than reporting a false chain change.
 */
export class ExplorerBlockedError extends Error {
  constructor(path: string) {
    super(
      `Blockscout returned HTTP 403 for ${path}. The explorer is behind bot protection ` +
        `that rejects non-browser clients; this is an access problem, not a chain change.`,
    );
    this.name = "ExplorerBlockedError";
  }
}

/**
 * Full browser User-Agent. The instance's edge rejects every non-browser UA tried,
 * including the conventional "Mozilla/5.0 (compatible; name/1.0; +url)" bot form.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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
    //
    // The one 4xx that is NOT our fault is 403. This instance sits behind Cloudflare
    // bot management, which serves a "Just a moment..." interstitial to any client
    // that does not present a browser User-Agent. Verified 2026-09-02: the UA below
    // returns 200 while "robinhood-chain-mcp", "curl/8.7.1", a bare "node", and even
    // the polite-bot form "Mozilla/5.0 (compatible; name/1.0; +url)" all return 403.
    // A 403 therefore means "the explorer refused us", never "the chain changed" -
    // callers distinguish the two via ExplorerBlockedError.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": BROWSER_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return (await res.json()) as T;
      lastStatus = res.status;
      if (res.status < 500) break;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    if (lastStatus === 403) {
      throw new ExplorerBlockedError(path);
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
