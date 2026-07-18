import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, TransportError, fromHex, json } from "../rpc.js";
import { BlockscoutClient, tokenAddress, type TokenItem } from "../blockscout.js";
import { decodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Robinhood Stock Tokens — ERC-20 tokenised equities and ETFs issued by
 * Robinhood Assets (Jersey) Limited, 18 decimals, one token per ticker.
 *
 * Two things make these unlike ordinary ERC-20s, and both are traps:
 *
 * 1. CORPORATE ACTIONS MOVE VALUE, NOT BALANCES. Dividends and splits are applied
 *    through an on-chain `uiMultiplier` (ERC-8056) that changes the shares-per-token
 *    ratio while every holder's raw balance stays fixed. Reading `balanceOf` and
 *    presenting it as a share count is therefore wrong after any corporate action —
 *    `balanceOfUI` is the multiplier-adjusted figure.
 *
 * 2. TICKER SQUATTING IS RAMPANT. The explorer lists several contracts per ticker;
 *    only one is genuine. Robinhood's docs warn that "a token with a matching
 *    name/ticker but a different contract address is not a Robinhood Stock Token"
 *    but publish no registry to check against. `uiMultiplier()` turns out to be a
 *    reliable discriminator: the real tokens implement it, the copies do not.
 *
 * Addresses here were resolved on-chain, not from documentation: the registry came
 * from a token's own ACCESS_CONTROLLED_REGISTRY(), which also serves as the beacon.
 */

/** Also the EIP-1967 beacon for every Stock proxy. */
export const ACCESS_CONTROLS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00";

// Selectors computed with `cast sig`, not recalled from memory — an incorrect
// selector on a Diamond/proxy silently reverts or returns the wrong slot.
const SEL = {
  uiMultiplier: "0xa60bf13d",
  newUIMultiplier: "0xdc767007",
  effectiveAt: "0x97a4064f",
  balanceOfUI: "0x437a9958",
  totalSupplyUI: "0x9bea6429",
  balanceOf: "0x70a08231",
  totalSupply: "0x18160ddd",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  uid: "0xf514ce36",
  terms: "0xd5025625",
  paused: "0x5c975abb",
  tokenPaused: "0x86c75e74",
  oraclePaused: "0x7706ba52",
  registry: "0x50c09be3",
} as const;

const pad = (v: string) => v.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const call = (rpc: RpcClient, to: string, data: string) =>
  rpc.call<string>("eth_call", [{ to, data }, "latest"]);

function decodeString(hex: string): string | null {
  try {
    return decodeAbiParameters(parseAbiParameters("string"), hex as `0x${string}`)[0] as string;
  } catch {
    return null;
  }
}

/**
 * A token is a genuine Stock Token iff it implements uiMultiplier().
 *
 * A revert is a real answer (the function is absent). A transport failure is NOT --
 * rethrowing it keeps a rate-limit from being reported as "this is not a stock
 * token", which is a false claim about the contract rather than an outage.
 */
async function isStockToken(rpc: RpcClient, address: string): Promise<bigint | null> {
  try {
    const raw = await call(rpc, address, SEL.uiMultiplier);
    if (!raw || raw === "0x") return null;
    return fromHex(raw);
  } catch (err) {
    if (err instanceof TransportError) throw err;
    return null;
  }
}

/** Format an 18-decimal fixed-point value as a decimal string. */
function fmt18(v: bigint): string {
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function registerStockTokenTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "verify_stock_token",
    "Determine whether a contract is a GENUINE Robinhood Stock Token or a ticker-squatting copy. The explorer lists multiple contracts per ticker and Robinhood publishes no registry to check against; this probes uiMultiplier(), which only the real tokens implement.",
    { token: z.string().describe("Contract address, or a ticker to search for") },
    async ({ token }) => {
      // A bare ticker means "find every contract using this symbol and tell me which
      // one is real" — the question someone actually has.
      if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
        const res = await scout.get<{ items?: TokenItem[] }>("/search", { q: token });
        const candidates = (res.items ?? [])
          .filter((i) => String((i as { type?: string }).type ?? "") === "token")
          .slice(0, 10);
        const checked = await Promise.all(
          candidates.map(async (c) => {
            const addr = tokenAddress(c);
            const mult = addr ? await isStockToken(rpc, addr) : null;
            return {
              address: addr,
              symbol: c.symbol ?? null,
              name: c.name ?? null,
              genuine: mult !== null,
              uiMultiplier: mult !== null ? fmt18(mult) : null,
            };
          }),
        );
        const genuine = checked.filter((c) => c.genuine);
        return json({
          query: token,
          candidatesChecked: checked.length,
          genuineCount: genuine.length,
          genuine,
          impostors: checked.filter((c) => !c.genuine),
          warning:
            genuine.length === 0
              ? "No genuine Stock Token found for this ticker — every match is an unrelated contract reusing the symbol."
              : genuine.length > 1
                ? "More than one contract implements uiMultiplier(); inspect each before trusting it."
                : undefined,
        });
      }

      const mult = await isStockToken(rpc, token);
      const [name, symbol] = await Promise.all([
        call(rpc, token, SEL.name).catch(() => null),
        call(rpc, token, SEL.symbol).catch(() => null),
      ]);
      return json({
        address: token,
        genuine: mult !== null,
        name: name ? decodeString(name) : null,
        symbol: symbol ? decodeString(symbol) : null,
        uiMultiplier: mult !== null ? fmt18(mult) : null,
        verdict:
          mult !== null
            ? "Implements uiMultiplier() — consistent with a genuine Robinhood Stock Token."
            : "Does NOT implement uiMultiplier(). This is not a Robinhood Stock Token, whatever its ticker says.",
      });
    },
  );

  register(
    "stock_token_info",
    "Full state of a Robinhood Stock Token: metadata, the corporate-action multiplier, raw vs multiplier-adjusted supply, and every pause flag.",
    { token: z.string().describe("Stock token contract address") },
    async ({ token }) => {
      const [name, symbol, decimals, uid, mult, newMult, effectiveAt, supply, supplyUI] =
        await Promise.all([
          call(rpc, token, SEL.name).catch(() => null),
          call(rpc, token, SEL.symbol).catch(() => null),
          call(rpc, token, SEL.decimals).catch(() => null),
          call(rpc, token, SEL.uid).catch(() => null),
          call(rpc, token, SEL.uiMultiplier).catch(() => null),
          call(rpc, token, SEL.newUIMultiplier).catch(() => null),
          call(rpc, token, SEL.effectiveAt).catch(() => null),
          call(rpc, token, SEL.totalSupply).catch(() => null),
          call(rpc, token, SEL.totalSupplyUI).catch(() => null),
        ]);
      if (mult === null) {
        return json({
          address: token,
          genuine: false,
          error:
            "No uiMultiplier() — not a Robinhood Stock Token. Run verify_stock_token for detail.",
        });
      }
      const paused = await Promise.all([
        call(rpc, token, SEL.paused).catch(() => null),
        call(rpc, token, SEL.tokenPaused).catch(() => null),
        call(rpc, token, SEL.oraclePaused).catch(() => null),
      ]);
      const bool = (h: string | null) => (h === null ? null : fromHex(h) === 1n);
      return json({
        address: token,
        genuine: true,
        name: name ? decodeString(name) : null,
        symbol: symbol ? decodeString(symbol) : null,
        decimals: decimals ? Number(fromHex(decimals)) : null,
        uid,
        corporateAction: {
          uiMultiplier: fmt18(fromHex(mult)),
          newUIMultiplier: newMult ? fmt18(fromHex(newMult)) : null,
          effectiveAt: effectiveAt ? Number(fromHex(effectiveAt)) : null,
          pending:
            newMult !== null && effectiveAt !== null && fromHex(effectiveAt) !== 0n
              ? "A multiplier change is scheduled — see check_corporate_action."
              : "none scheduled",
        },
        supply: {
          raw: supply ? fromHex(supply).toString() : null,
          adjusted: supplyUI ? fromHex(supplyUI).toString() : null,
        },
        status: {
          paused: bool(paused[0]),
          tokenPaused: bool(paused[1]),
          oraclePaused: bool(paused[2]),
          transfersLikelyBlocked: bool(paused[0]) === true || bool(paused[1]) === true,
        },
      });
    },
  );

  register(
    "stock_balance",
    "Balance of a Stock Token, reported BOTH raw and multiplier-adjusted. After any corporate action these differ, and the adjusted figure is the one representing economic exposure — reading balanceOf alone is the standard integration bug.",
    { token: z.string(), address: z.string() },
    async ({ token, address }) => {
      const [rawBal, uiBal, mult, symbol] = await Promise.all([
        call(rpc, token, SEL.balanceOf + pad(address)).catch(() => null),
        call(rpc, token, SEL.balanceOfUI + pad(address)).catch(() => null),
        call(rpc, token, SEL.uiMultiplier).catch(() => null),
        call(rpc, token, SEL.symbol).catch(() => null),
      ]);
      if (mult === null) {
        throw new Error(
          "This contract has no uiMultiplier() — not a Stock Token. Use get_token_balance for ordinary ERC-20s.",
        );
      }
      const raw = rawBal ? fromHex(rawBal) : 0n;
      const ui = uiBal ? fromHex(uiBal) : null;
      return json({
        token,
        symbol: symbol ? decodeString(symbol) : null,
        address,
        rawBalance: raw.toString(),
        rawFormatted: fmt18(raw),
        adjustedBalance: ui?.toString() ?? null,
        adjustedFormatted: ui !== null ? fmt18(ui) : null,
        uiMultiplier: fmt18(fromHex(mult)),
        differ: ui !== null && ui !== raw,
        useForDisplay:
          "adjustedBalance — it reflects corporate actions. rawBalance is the ledger entry, not the share count.",
      });
    },
  );

  register(
    "check_corporate_action",
    "Check for a scheduled dividend or split on a Stock Token: the pending multiplier, when it takes effect, and how it will change holdings. Balances will not move — the multiplier does.",
    { token: z.string() },
    async ({ token }) => {
      const [mult, newMult, effectiveAt, symbol] = await Promise.all([
        call(rpc, token, SEL.uiMultiplier).catch(() => null),
        call(rpc, token, SEL.newUIMultiplier).catch(() => null),
        call(rpc, token, SEL.effectiveAt).catch(() => null),
        call(rpc, token, SEL.symbol).catch(() => null),
      ]);
      if (mult === null) throw new Error("Not a Stock Token — no uiMultiplier().");
      const current = fromHex(mult);
      const next = newMult ? fromHex(newMult) : current;
      const at = effectiveAt ? Number(fromHex(effectiveAt)) : 0;
      const now = Math.floor(Date.now() / 1000);
      const changing = next !== current;
      return json({
        token,
        symbol: symbol ? decodeString(symbol) : null,
        currentMultiplier: fmt18(current),
        pendingMultiplier: fmt18(next),
        changing,
        effectiveAt: at || null,
        effectiveAtIso: at ? new Date(at * 1000).toISOString() : null,
        alreadyEffective: at !== 0 && at <= now,
        ratioChange: changing
          ? `${(Number(next) / Number(current)).toFixed(6)}x`
          : "1.000000x (no change)",
        explanation:
          "Corporate actions adjust the shares-per-token ratio via this multiplier. Raw balanceOf values are unchanged by it; balanceOfUI reflects it.",
      });
    },
  );

  register(
    "check_address_blocked",
    "Check whether an address is blocked by the Stock Token AccessControlsRegistry. Blocked addresses cannot transfer, so a transfer that looks fine will revert.",
    { address: z.string() },
    async ({ address }) => {
      // isBlocked(address)
      const raw = await call(rpc, ACCESS_CONTROLS_REGISTRY, "0xfbac3951" + pad(address));
      const blocked = fromHex(raw) === 1n;
      const registryPaused = await call(rpc, ACCESS_CONTROLS_REGISTRY, SEL.paused)
        .then((r) => fromHex(r) === 1n)
        .catch(() => null);
      return json({
        address,
        blocked,
        registry: ACCESS_CONTROLS_REGISTRY,
        registryPaused,
        implication: blocked
          ? "This address is blocked — Stock Token transfers to or from it will revert."
          : "Not blocked at the registry level. Per-token pause flags may still apply; see stock_token_info.",
      });
    },
  );

  register(
    "stock_token_registry",
    "The Stock Token AccessControlsRegistry: address, pause state, and its role. It also serves as the EIP-1967 beacon behind every Stock Token proxy.",
    {},
    async () => {
      const [paused, impl] = await Promise.all([
        call(rpc, ACCESS_CONTROLS_REGISTRY, SEL.paused)
          .then((r) => fromHex(r) === 1n)
          .catch(() => null),
        // implementation() — the shared Stock logic contract behind every proxy.
        call(rpc, ACCESS_CONTROLS_REGISTRY, "0x5c60da1b")
          .then((r) => "0x" + r.slice(-40))
          .catch(() => null),
      ]);
      return json({
        registry: ACCESS_CONTROLS_REGISTRY,
        paused,
        sharedImplementation: impl,
        roles:
          "Access control (isBlocked, hasRole) plus the EIP-1967 beacon for all Stock Token proxies — upgrading it upgrades every stock token at once.",
        note: "This registry does NOT enumerate stock tokens; there is no on-chain list. Use list_stock_tokens, which scans the explorer and filters by uiMultiplier().",
      });
    },
  );

  register(
    "list_stock_tokens",
    "Find genuine Robinhood Stock Tokens by scanning explorer-indexed tokens and keeping only those implementing uiMultiplier(). There is no on-chain enumeration, so this is a scan, not a registry read.",
    {
      query: z.string().optional().describe("Ticker or name filter, e.g. 'AAPL'"),
      limit: z.number().default(15).describe("Max candidates to probe"),
    },
    async ({ query, limit }) => {
      const res = query
        ? await scout.get<{ items?: TokenItem[] }>("/search", { q: query })
        : await scout.get<{ items?: TokenItem[] }>("/tokens", { type: "ERC-20" });
      const candidates = (res.items ?? [])
        .filter((i) => {
          const type = String((i as { type?: string }).type ?? "");
          return type === "token" || type === "" || type === "ERC-20";
        })
        .slice(0, limit);

      const checked = await Promise.all(
        candidates.map(async (c) => {
          const addr = tokenAddress(c);
          if (!addr) return null;
          const mult = await isStockToken(rpc, addr);
          if (mult === null) return null;
          return {
            address: addr,
            symbol: c.symbol ?? null,
            name: c.name ?? null,
            uiMultiplier: fmt18(mult),
            holders: c.holders ?? c.holders_count ?? null,
          };
        }),
      );
      const found = checked.filter(Boolean);
      return json({
        query: query ?? "(top tokens by holders)",
        candidatesProbed: candidates.length,
        stockTokensFound: found.length,
        stockTokens: found,
        caveat:
          "A scan over one explorer page, not an exhaustive list. Absence here is not proof a ticker has no stock token — search for it directly.",
      });
    },
  );

  register(
    "stock_token_terms",
    "Legal terms URI published on-chain by a Stock Token. These are securities issued by Robinhood Assets (Jersey) Limited and are restricted in several jurisdictions.",
    { token: z.string() },
    async ({ token }) => {
      const raw = await call(rpc, token, SEL.terms).catch(() => null);
      return json({
        token,
        terms: raw ? decodeString(raw) : null,
        issuer: "Robinhood Assets (Jersey) Limited",
        restrictions:
          "Not available to U.S. persons; further restrictions apply in Canada, the UK, Switzerland and elsewhere. These are securities, not ordinary tokens.",
      });
    },
  );
}
