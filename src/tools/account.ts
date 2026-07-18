import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, formatUnits, fromHex, json } from "../rpc.js";
import { BlockscoutClient, tokenAddress } from "../blockscout.js";
import { KNOWN_ASSETS, SELECTORS } from "../assets.js";

const pad32 = (addr: string) => addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export function registerAccountTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "get_balance",
    "Native ETH balance for an address.",
    { address: z.string(), block: z.string().default("latest") },
    async ({ address, block }) => {
      const hex = await rpc.call<string>("eth_getBalance", [address, block]);
      const cfg = rpc.config;
      return json({
        address,
        wei: fromHex(hex).toString(),
        formatted: formatUnits(fromHex(hex), cfg.nativeDecimals, cfg.nativeSymbol),
      });
    },
  );

  register(
    "get_nonce",
    "Transaction count (nonce) for an address.",
    { address: z.string(), block: z.string().default("latest") },
    async ({ address, block }) => {
      const hex = await rpc.call<string>("eth_getTransactionCount", [address, block]);
      return json({ address, nonce: Number(fromHex(hex)) });
    },
  );

  register(
    "is_contract",
    "Whether an address holds contract code, and how much.",
    { address: z.string() },
    async ({ address }) => {
      const code = await rpc.call<string>("eth_getCode", [address, "latest"]);
      const bytes = Math.max(0, (code.length - 2) / 2);
      return json({ address, isContract: bytes > 0, codeSizeBytes: bytes });
    },
  );

  register(
    "get_token_balance",
    "ERC-20 balance for an address. Accepts a known symbol (e.g. USDG) or a token address.",
    { address: z.string(), token: z.string().describe("Symbol or contract address") },
    async ({ address, token }) => {
      const known = KNOWN_ASSETS[token.toUpperCase()];
      const tokenAddr = known?.address ?? token;
      const raw = await rpc.call<string>("eth_call", [
        { to: tokenAddr, data: SELECTORS.balanceOf + pad32(address) },
        "latest",
      ]);
      const value = fromHex(raw);

      // Decimals are only known a priori for curated assets; read them otherwise so
      // the formatted figure is never silently wrong by orders of magnitude.
      let decimals: number | undefined = known?.decimals;
      const symbol: string | undefined = known?.symbol;
      if (decimals === undefined) {
        try {
          const d = await rpc.call<string>("eth_call", [
            { to: tokenAddr, data: SELECTORS.decimals },
            "latest",
          ]);
          decimals = Number(fromHex(d));
        } catch {
          decimals = undefined;
        }
      }
      return json({
        address,
        token: tokenAddr,
        symbol: symbol ?? null,
        raw: value.toString(),
        decimals: decimals ?? null,
        formatted:
          decimals === undefined
            ? "unknown — could not read decimals()"
            : formatUnits(value, decimals, symbol ?? "units"),
      });
    },
  );

  register(
    "list_token_holdings",
    "All token balances held by an address, via the explorer index. Mainnet only.",
    { address: z.string() },
    async ({ address }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/addresses/${address}/token-balances`,
      );
      const items = res.items ?? [];
      return json({
        address,
        count: items.length,
        holdings: items.map((i) => {
          const t = (i.token ?? {}) as Record<string, unknown>;
          return {
            symbol: t.symbol ?? null,
            name: t.name ?? null,
            address: tokenAddress(t as never),
            decimals: t.decimals ?? null,
            raw: i.value ?? null,
          };
        }),
      });
    },
  );
}
