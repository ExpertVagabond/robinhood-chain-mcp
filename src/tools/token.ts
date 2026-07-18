import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, json } from "../rpc.js";
import { BlockscoutClient, tokenAddress, tokenHolders, type TokenItem } from "../blockscout.js";
import { KNOWN_ASSETS } from "../assets.js";

export function registerTokenTools(
  register: Register,
  _rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "list_tokens",
    "List ERC-20 tokens on Robinhood Chain, most-held first, via the explorer index. Mainnet only.",
    {
      limit: z.number().default(25).describe("Max tokens to return (page size is 50)"),
      query: z.string().optional().describe("Filter by name or symbol"),
    },
    async ({ limit, query }) => {
      const res = await scout.get<{ items?: TokenItem[] }>("/tokens", {
        type: "ERC-20",
        q: query,
      });
      const items = (res.items ?? []).slice(0, limit);
      return json({
        count: items.length,
        note:
          "Explorer returns one page (50). A larger limit will not fetch more; narrow with `query` instead.",
        tokens: items.map((t) => ({
          symbol: t.symbol ?? null,
          name: t.name ?? null,
          address: tokenAddress(t),
          decimals: t.decimals ?? null,
          holders: tokenHolders(t),
          marketCap: t.circulating_market_cap ?? null,
        })),
      });
    },
  );

  register(
    "known_assets",
    "Curated Robinhood Chain assets with verified metadata, including which support EIP-3009 / EIP-2612.",
    {},
    async () =>
      json({
        assets: Object.values(KNOWN_ASSETS),
        note:
          "USDG is the chain's native stablecoin. Robinhood Chain has no canonical USDC — USDC bridged from other chains arrives as USDG.",
      }),
  );

  register(
    "token_info",
    "Detailed token info from the explorer: supply, holders, market data. Mainnet only.",
    { token: z.string().describe("Symbol or contract address") },
    async ({ token }) => {
      const known = KNOWN_ASSETS[token.toUpperCase()];
      const address = known?.address ?? token;
      const info = await scout.get<TokenItem>(`/tokens/${address}`);
      return json({
        ...info,
        address: tokenAddress(info) || address,
        curated: known ?? null,
      });
    },
  );

  register(
    "chain_stats",
    "Explorer-level chain statistics: block time, gas prices, total transactions, market data. Mainnet only.",
    {},
    async () => json(await scout.get("/stats")),
  );
}
