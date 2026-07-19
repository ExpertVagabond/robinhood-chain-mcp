import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json } from "../rpc.js";
import { BlockscoutClient } from "../blockscout.js";
import { decodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Price oracles on Robinhood Chain.
 *
 * There are two distinct systems, and conflating them is easy:
 *
 *   1. PriceFeedRegistry (0x4C5CE5...) maps a TOKEN address to a Chainlink feed.
 *      It covers assets like WETH. It does NOT cover Stock Tokens — getTokenPrice
 *      on a stock token reverts with PriceFeedNotFound().
 *
 *   2. Stock prices live in standalone Chainlink aggregators, discoverable only by
 *      their description() string: "Robinhood AAPL / USD" or "RHTSLA / USD" — both
 *      conventions are in use. Nothing on-chain links a Stock Token to its feed, so
 *      the mapping is by ticker, not by address.
 *
 * Do not confuse either with the PriceFeed contract at 0x4EE2F9..., which is a
 * LayerZero messaging-fee oracle and has nothing to do with asset prices.
 *
 * STALENESS. Equity feeds stop updating when the market is closed, so a stock price
 * is routinely many hours old — observed at ~39h across a weekend, well beyond the
 * registry's 90,000s defaultMaxAge. That is correct behaviour for equities, but it
 * means a staleness rule tuned for crypto will reject every stock price outside
 * trading hours, while a naive integration will serve a Friday close as if live.
 * Every price tool here returns the age and lets the caller decide.
 */

export const PRICE_FEED_REGISTRY = "0x4C5CE59E7047b65ad8F91eA1c27E685f397f846f";

// Selectors computed with `cast sig`, never written from memory.
const SEL = {
  // PriceFeedRegistry
  FEED_DECIMALS: "0x679c1eda",
  defaultMaxAge: "0x1c172c11",
  sequencerUptimeFeed: "0xa7264705",
  sequencerGracePeriod: "0x26a97b94",
  hasTokenPriceFeed: "0xb8ca5b2f",
  getTokenPriceFeed: "0x274a1a00",
  getTokenPrice: "0xd02641a0",
  maxAgeFor: "0xda26ceb7",
  // Chainlink AggregatorV3
  description: "0x7284e416",
  decimals: "0x313ce567",
  version: "0x54fd4d50",
  latestRoundData: "0xfeaf968c",
  aggregator: "0x245a7bfc",
  latestAnswer: "0x50d25bcd",
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

/** Scale an integer price by its feed decimals. */
function scale(answer: bigint, decimals: number): number {
  return Number(answer) / 10 ** decimals;
}

interface RoundData {
  roundId: string;
  answer: bigint;
  startedAt: number;
  updatedAt: number;
  answeredInRound: string;
}

async function latestRound(rpc: RpcClient, feed: string): Promise<RoundData> {
  const raw = await call(rpc, feed, SEL.latestRoundData);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeAbiParameters(
    parseAbiParameters("uint80, int256, uint256, uint256, uint80"),
    raw as `0x${string}`,
  ) as unknown as [bigint, bigint, bigint, bigint, bigint];
  return {
    roundId: roundId.toString(),
    answer,
    startedAt: Number(startedAt),
    updatedAt: Number(updatedAt),
    answeredInRound: answeredInRound.toString(),
  };
}

function ageReport(updatedAt: number) {
  const now = Math.floor(Date.now() / 1000);
  const age = now - updatedAt;
  return {
    updatedAt,
    updatedAtIso: new Date(updatedAt * 1000).toISOString(),
    ageSeconds: age,
    ageHuman:
      age < 3600
        ? `${Math.round(age / 60)}m`
        : age < 86400
          ? `${(age / 3600).toFixed(1)}h`
          : `${(age / 86400).toFixed(1)}d`,
  };
}

export function registerOracleTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "price_feed_registry",
    "Configuration of the PriceFeedRegistry: feed decimals, default staleness bound, and L2 sequencer-uptime protection status.",
    {},
    async () => {
      const [feedDec, maxAge, seqFeed, grace] = await Promise.all([
        call(rpc, PRICE_FEED_REGISTRY, SEL.FEED_DECIMALS).catch(() => null),
        call(rpc, PRICE_FEED_REGISTRY, SEL.defaultMaxAge).catch(() => null),
        call(rpc, PRICE_FEED_REGISTRY, SEL.sequencerUptimeFeed).catch(() => null),
        call(rpc, PRICE_FEED_REGISTRY, SEL.sequencerGracePeriod).catch(() => null),
      ]);
      const seq = seqFeed ? "0x" + seqFeed.slice(-40) : null;
      const seqSet = seq !== null && seq !== "0x0000000000000000000000000000000000000000";
      return json({
        registry: PRICE_FEED_REGISTRY,
        feedDecimals: feedDec ? Number(fromHex(feedDec)) : null,
        defaultMaxAgeSeconds: maxAge ? Number(fromHex(maxAge)) : null,
        defaultMaxAgeHuman: maxAge ? `${(Number(fromHex(maxAge)) / 3600).toFixed(1)}h` : null,
        sequencerUptimeFeed: seq,
        sequencerUptimeConfigured: seqSet,
        sequencerGracePeriod: grace ? Number(fromHex(grace)) : null,
        warning: seqSet
          ? undefined
          : "No sequencer uptime feed is configured. On an L2, prices read immediately after sequencer downtime can be stale while appearing fresh; Chainlink's standard guidance is to gate reads on an uptime feed. There is no such protection here.",
        coverage:
          "Covers assets like WETH. Stock Tokens are NOT in this registry — getTokenPrice reverts PriceFeedNotFound() for them. Use get_stock_price instead.",
      });
    },
  );

  register(
    "get_token_price",
    "USD price for a token via the PriceFeedRegistry, with the feed's age. Reverts with PriceFeedNotFound for unregistered tokens, including all Stock Tokens.",
    { token: z.string().describe("Token contract address") },
    async ({ token }) => {
      const has = await call(rpc, PRICE_FEED_REGISTRY, SEL.hasTokenPriceFeed + pad(token))
        .then((r) => fromHex(r) === 1n)
        .catch(() => false);
      if (!has) {
        return json({
          token,
          hasFeed: false,
          error: "No price feed registered for this token (PriceFeedNotFound).",
          hint: "Stock Tokens are never in this registry — their feeds are standalone aggregators. Try get_stock_price with the ticker.",
        });
      }
      const feedRaw = await call(rpc, PRICE_FEED_REGISTRY, SEL.getTokenPriceFeed + pad(token));
      const feed = "0x" + feedRaw.slice(-40);
      const [round, decRaw, descRaw, maxAgeRaw] = await Promise.all([
        latestRound(rpc, feed),
        call(rpc, feed, SEL.decimals).catch(() => null),
        call(rpc, feed, SEL.description).catch(() => null),
        call(rpc, PRICE_FEED_REGISTRY, SEL.maxAgeFor + pad(token)).catch(() => null),
      ]);
      const decimals = decRaw ? Number(fromHex(decRaw)) : 8;
      const age = ageReport(round.updatedAt);
      const maxAge = maxAgeRaw ? Number(fromHex(maxAgeRaw)) : null;
      return json({
        token,
        hasFeed: true,
        feed,
        description: descRaw ? decodeString(descRaw) : null,
        price: scale(round.answer, decimals),
        answerRaw: round.answer.toString(),
        decimals,
        ...age,
        maxAgeSeconds: maxAge,
        stale: maxAge !== null ? age.ageSeconds > maxAge : null,
        roundId: round.roundId,
      });
    },
  );

  register(
    "get_stock_price",
    "USD price for a Robinhood Stock Token by ticker. Stock feeds are standalone Chainlink aggregators discoverable only by their description string — both 'Robinhood AAPL / USD' and 'RHAAPL / USD' conventions exist, and this checks for either.",
    {
      ticker: z.string().describe("Equity ticker, e.g. AAPL, TSLA, SPY"),
      maxAgeSeconds: z
        .number()
        .optional()
        .describe("Flag the price stale beyond this age. Omit for no staleness verdict."),
    },
    async ({ ticker, maxAgeSeconds }) => {
      const t = ticker.trim().toUpperCase();
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>("/search", {
        q: `RH${t}`,
      });
      const alt = await scout.get<{ items?: Array<Record<string, unknown>> }>("/search", {
        q: `Robinhood ${t}`,
      });
      const addrs = [...(res.items ?? []), ...(alt.items ?? [])]
        .map((i) => String(i.address ?? i.address_hash ?? ""))
        .filter(Boolean);

      const wanted = [`ROBINHOOD ${t} / USD`, `RH${t} / USD`];
      const seenAggregators = new Set<string>();
      const matches: Array<Record<string, unknown>> = [];

      for (const a of [...new Set(addrs)].slice(0, 12)) {
        const descRaw = await call(rpc, a, SEL.description).catch(() => null);
        const desc = descRaw ? decodeString(descRaw) : null;
        if (!desc || !wanted.includes(desc.trim().toUpperCase())) continue;
        // Several proxies front the same aggregator; dedupe on the underlying.
        const aggRaw = await call(rpc, a, SEL.aggregator).catch(() => null);
        const agg = aggRaw ? "0x" + aggRaw.slice(-40) : a;
        if (seenAggregators.has(agg)) continue;
        seenAggregators.add(agg);
        const [round, decRaw] = await Promise.all([
          latestRound(rpc, a),
          call(rpc, a, SEL.decimals).catch(() => null),
        ]);
        const decimals = decRaw ? Number(fromHex(decRaw)) : 8;
        const age = ageReport(round.updatedAt);
        matches.push({
          feed: a,
          underlyingAggregator: agg,
          description: desc,
          price: scale(round.answer, decimals),
          decimals,
          ...age,
          stale: maxAgeSeconds !== undefined ? age.ageSeconds > maxAgeSeconds : null,
          roundId: round.roundId,
        });
      }

      if (matches.length === 0) {
        return json({
          ticker: t,
          found: false,
          error: `No Chainlink feed found matching "Robinhood ${t} / USD" or "RH${t} / USD".`,
          hint: "Feeds are discovered via the explorer's index. Use list_price_feeds to see what exists.",
        });
      }
      const oldest = Math.max(...matches.map((m) => Number(m.ageSeconds)));
      return json({
        ticker: t,
        found: true,
        feeds: matches,
        price: matches[0].price,
        marketHoursNote:
          oldest > 21600
            ? `This price is ${matches[0].ageHuman} old. Equity feeds do not update while the market is closed, so a large age is normal outside trading hours — it does not by itself mean the feed is broken. Do not treat it as a live quote.`
            : undefined,
      });
    },
  );

  register(
    "read_price_feed",
    "Read any Chainlink AggregatorV3 feed directly: description, decimals, latest round, and age.",
    { feed: z.string().describe("Aggregator or proxy address") },
    async ({ feed }) => {
      const [descRaw, decRaw, verRaw, aggRaw] = await Promise.all([
        call(rpc, feed, SEL.description).catch(() => null),
        call(rpc, feed, SEL.decimals).catch(() => null),
        call(rpc, feed, SEL.version).catch(() => null),
        call(rpc, feed, SEL.aggregator).catch(() => null),
      ]);
      const round = await latestRound(rpc, feed);
      const decimals = decRaw ? Number(fromHex(decRaw)) : 8;
      const age = ageReport(round.updatedAt);
      return json({
        feed,
        description: descRaw ? decodeString(descRaw) : null,
        decimals,
        version: verRaw ? Number(fromHex(verRaw)) : null,
        underlyingAggregator: aggRaw ? "0x" + aggRaw.slice(-40) : null,
        price: scale(round.answer, decimals),
        answerRaw: round.answer.toString(),
        roundId: round.roundId,
        answeredInRound: round.answeredInRound,
        ...age,
        roundComplete: round.updatedAt > 0,
        incompleteRoundWarning:
          round.updatedAt === 0
            ? "updatedAt is zero — this round never completed and the answer must not be used."
            : undefined,
      });
    },
  );

  register(
    "list_price_feeds",
    "Discover Chainlink price feeds on this chain by reading each candidate's description(). Deduplicates proxies that front the same underlying aggregator.",
    {
      query: z.string().default("EACAggregatorProxy").describe("Explorer search term"),
      limit: z.number().default(20),
    },
    async ({ query, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>("/search", {
        q: query,
      });
      const addrs = [
        ...new Set(
          (res.items ?? []).map((i) => String(i.address ?? i.address_hash ?? "")).filter(Boolean),
        ),
      ].slice(0, limit);

      const seen = new Set<string>();
      const feeds: Array<Record<string, unknown>> = [];
      for (const a of addrs) {
        const descRaw = await call(rpc, a, SEL.description).catch(() => null);
        const desc = descRaw ? decodeString(descRaw) : null;
        if (!desc) continue;
        const aggRaw = await call(rpc, a, SEL.aggregator).catch(() => null);
        const agg = aggRaw ? "0x" + aggRaw.slice(-40) : a;
        if (seen.has(agg)) continue;
        seen.add(agg);
        const answerRaw = await call(rpc, a, SEL.latestAnswer).catch(() => null);
        const decRaw = await call(rpc, a, SEL.decimals).catch(() => null);
        const decimals = decRaw ? Number(fromHex(decRaw)) : 8;
        feeds.push({
          feed: a,
          underlyingAggregator: agg,
          description: desc,
          price: answerRaw ? scale(BigInt(answerRaw), decimals) : null,
          decimals,
        });
      }
      return json({
        query,
        candidatesProbed: addrs.length,
        uniqueFeeds: feeds.length,
        feeds,
        note: "Discovery is a scan over one explorer page, not an on-chain enumeration. Absence here does not prove a feed does not exist.",
      });
    },
  );

  register(
    "check_price_freshness",
    "Assess whether a feed's price is safe to use: age, round completeness, and the L2 sequencer-uptime caveat. Equity feeds are expected to be stale outside market hours.",
    {
      feed: z.string(),
      maxAgeSeconds: z.number().default(3600),
    },
    async ({ feed, maxAgeSeconds }) => {
      const [round, descRaw] = await Promise.all([
        latestRound(rpc, feed),
        call(rpc, feed, SEL.description).catch(() => null),
      ]);
      const desc = descRaw ? decodeString(descRaw) : null;
      const age = ageReport(round.updatedAt);
      const isEquity = Boolean(desc && /^(ROBINHOOD |RH)/i.test(desc.trim()));
      const seqRaw = await call(rpc, PRICE_FEED_REGISTRY, SEL.sequencerUptimeFeed).catch(
        () => null,
      );
      const seqSet =
        seqRaw !== null &&
        "0x" + seqRaw.slice(-40) !== "0x0000000000000000000000000000000000000000";
      return json({
        feed,
        description: desc,
        ...age,
        maxAgeSeconds,
        exceedsMaxAge: age.ageSeconds > maxAgeSeconds,
        roundComplete: round.updatedAt > 0,
        staleRoundAnswer: BigInt(round.answeredInRound) < BigInt(round.roundId),
        assetClass: isEquity ? "equity" : "crypto/other",
        verdict:
          round.updatedAt === 0
            ? "UNUSABLE — round never completed."
            : age.ageSeconds <= maxAgeSeconds
              ? "Fresh within the requested bound."
              : isEquity
                ? "Exceeds the bound, but this is an equity feed: it stops updating when the market closes. Judge against trading hours, not a fixed crypto-style threshold."
                : "Exceeds the bound — treat as stale.",
        sequencerUptimeConfigured: seqSet,
        sequencerCaveat: seqSet
          ? undefined
          : "The registry has no sequencer uptime feed configured, so no read here is protected against post-downtime staleness on this L2.",
      });
    },
  );
}
