import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json } from "../rpc.js";
import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  decodeAbiParameters,
  getAddress,
} from "viem";

/**
 * Uniswap v4 on Robinhood Chain.
 *
 * v4 replaces v3's one-contract-per-pool model with a singleton PoolManager holding
 * every pool in its own storage. Pools are addressed by a `poolId` — the keccak of
 * the PoolKey struct — and read through the StateView periphery contract, because
 * PoolManager exposes state via transient/extsload rather than plain getters.
 *
 * Addresses below were verified on-chain rather than taken from a tag: StateView's
 * own poolManager() returns the PoolManager address recorded here, which is
 * self-confirming. The Quoter that Blockscout tags at
 * 0xEf4F57b2Bb6f2C0C8AD0c3962f7649Aaa5b9138d has NO CODE, so quoting tools are
 * deliberately omitted rather than shipped broken.
 */

export const UNISWAP_V4 = {
  PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  StateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  PositionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  UniversalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  Permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

// Selectors computed with `cast sig`. Getting one wrong here returns another
// function's data rather than failing, so these are never written from memory.
const SEL = {
  getSlot0: "0xc815641c",
  getLiquidity: "0xfa6793d5",
  getFeeGrowthGlobals: "0x9ec538c8",
  poolManager: "0xdc4c90d3",
} as const;

const call = (rpc: RpcClient, to: string, data: string) =>
  rpc.call<string>("eth_call", [{ to, data }, "latest"]);

/**
 * v4 poolId = keccak256(abi.encode(PoolKey)).
 * Currency0 must sort below currency1; native ETH is address(0).
 */
export function computePoolId(
  currency0: string,
  currency1: string,
  fee: number,
  tickSpacing: number,
  hooks: string,
): { poolId: `0x${string}`; currency0: string; currency1: string; swapped: boolean } {
  let c0 = getAddress(currency0);
  let c1 = getAddress(currency1);
  let swapped = false;
  if (BigInt(c0) > BigInt(c1)) {
    [c0, c1] = [c1, c0];
    swapped = true;
  }
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [c0 as `0x${string}`, c1 as `0x${string}`, fee, tickSpacing, getAddress(hooks)],
  );
  return { poolId: keccak256(encoded), currency0: c0, currency1: c1, swapped };
}

/** sqrtPriceX96 -> human price of token0 in token1. */
function priceFromSqrtX96(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const q96 = 2 ** 96;
  const ratio = Number(sqrtPriceX96) / q96;
  return ratio * ratio * 10 ** (dec0 - dec1);
}

export function registerUniswapTools(register: Register, rpc: RpcClient) {
  register(
    "uniswap_contracts",
    "Uniswap v4 deployment addresses on Robinhood Chain, each checked for deployed code. Reports which periphery contracts are actually usable.",
    {},
    async () => {
      const entries = Object.entries(UNISWAP_V4);
      const checked = await Promise.all(
        entries.map(async ([name, address]) => {
          const code = await rpc
            .call<string>("eth_getCode", [address, "latest"])
            .catch(() => "0x");
          return { name, address, deployed: code.length > 2, codeSize: (code.length - 2) / 2 };
        }),
      );
      let managerMatches: boolean | null = null;
      try {
        const pm = await call(rpc, UNISWAP_V4.StateView, SEL.poolManager);
        managerMatches =
          ("0x" + pm.slice(-40)).toLowerCase() === UNISWAP_V4.PoolManager.toLowerCase();
      } catch {
        managerMatches = null;
      }
      return json({
        contracts: checked,
        stateViewPointsAtRecordedPoolManager: managerMatches,
        quoter: {
          taggedAddress: "0xEf4F57b2Bb6f2C0C8AD0c3962f7649Aaa5b9138d",
          deployed: false,
          note: "Blockscout tags a Quoter here but the address has no code, so no quoting tools are provided. Simulate swaps against UniversalRouter instead.",
        },
        architecture:
          "v4 is a singleton: one PoolManager holds all pools, addressed by poolId. Read state through StateView — PoolManager itself exposes storage via extsload, not getters.",
      });
    },
  );

  register(
    "uniswap_pool_id",
    "Compute the Uniswap v4 poolId from a PoolKey. Currencies are sorted automatically — an unsorted key yields a different, non-existent poolId, which is the usual reason a pool 'cannot be found'.",
    {
      currency0: z.string().describe("Token address, or 0x0 for native ETH"),
      currency1: z.string(),
      fee: z.number().default(3000).describe("Fee in hundredths of a bip (3000 = 0.30%)"),
      tickSpacing: z.number().default(60),
      hooks: z.string().default("0x0000000000000000000000000000000000000000"),
    },
    async ({ currency0, currency1, fee, tickSpacing, hooks }) => {
      const r = computePoolId(currency0, currency1, fee, tickSpacing, hooks);
      return json({
        ...r,
        fee,
        feePercent: fee / 10_000,
        tickSpacing,
        hooks,
        note: r.swapped
          ? "Currencies were swapped to satisfy currency0 < currency1."
          : "Currencies were already correctly ordered.",
      });
    },
  );

  register(
    "uniswap_pool_state",
    "Read a v4 pool's slot0 via StateView: current sqrt price, tick, protocol fee and LP fee. Accepts a poolId, or a PoolKey to derive one.",
    {
      poolId: z.string().optional().describe("32-byte poolId; omit to derive from a PoolKey"),
      currency0: z.string().optional(),
      currency1: z.string().optional(),
      fee: z.number().default(3000),
      tickSpacing: z.number().default(60),
      hooks: z.string().default("0x0000000000000000000000000000000000000000"),
      decimals0: z.number().default(18),
      decimals1: z.number().default(18),
    },
    async ({ poolId, currency0, currency1, fee, tickSpacing, hooks, decimals0, decimals1 }) => {
      let id = poolId;
      let derived: ReturnType<typeof computePoolId> | null = null;
      if (!id) {
        if (!currency0 || !currency1) {
          throw new Error("Provide either poolId, or both currency0 and currency1.");
        }
        derived = computePoolId(currency0, currency1, fee, tickSpacing, hooks);
        id = derived.poolId;
      }
      const raw = await call(rpc, UNISWAP_V4.StateView, SEL.getSlot0 + id.replace(/^0x/, ""));
      const [sqrtPriceX96, tick, protocolFee, lpFee] = decodeAbiParameters(
        parseAbiParameters("uint160, int24, uint24, uint24"),
        raw as `0x${string}`,
      ) as unknown as [bigint, number, number, number];

      const initialised = sqrtPriceX96 !== 0n;
      return json({
        poolId: id,
        derivedFrom: derived
          ? { currency0: derived.currency0, currency1: derived.currency1, fee, tickSpacing, hooks }
          : null,
        initialised,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        protocolFee,
        lpFee,
        lpFeePercent: lpFee / 10_000,
        price: initialised ? priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1) : null,
        warning: initialised
          ? undefined
          : "sqrtPriceX96 is zero — this pool does not exist or was never initialised. Check the PoolKey ordering, fee and tickSpacing.",
      });
    },
  );

  register(
    "uniswap_pool_liquidity",
    "Current in-range liquidity for a v4 pool.",
    { poolId: z.string().describe("32-byte poolId") },
    async ({ poolId }) => {
      const raw = await call(
        rpc,
        UNISWAP_V4.StateView,
        SEL.getLiquidity + poolId.replace(/^0x/, ""),
      );
      const liquidity = fromHex(raw);
      return json({
        poolId,
        liquidity: liquidity.toString(),
        isZero: liquidity === 0n,
        note:
          liquidity === 0n
            ? "Zero in-range liquidity: either the pool is empty, or all positions sit outside the current tick."
            : undefined,
      });
    },
  );

  register(
    "uniswap_fee_growth",
    "Global fee growth accumulators for a v4 pool — the basis for computing accrued LP fees.",
    { poolId: z.string() },
    async ({ poolId }) => {
      const raw = await call(
        rpc,
        UNISWAP_V4.StateView,
        SEL.getFeeGrowthGlobals + poolId.replace(/^0x/, ""),
      );
      const [g0, g1] = decodeAbiParameters(
        parseAbiParameters("uint256, uint256"),
        raw as `0x${string}`,
      ) as unknown as [bigint, bigint];
      return json({
        poolId,
        feeGrowthGlobal0X128: g0.toString(),
        feeGrowthGlobal1X128: g1.toString(),
        note: "X128 fixed-point. Fees earned by a position derive from the delta between these and the position's last checkpoint.",
      });
    },
  );

  register(
    "uniswap_find_pool",
    "Search for an initialised v4 pool across the standard fee tiers for a token pair, since v4 pools are not enumerable on-chain.",
    {
      currency0: z.string(),
      currency1: z.string(),
      hooks: z.string().default("0x0000000000000000000000000000000000000000"),
    },
    async ({ currency0, currency1, hooks }) => {
      // Canonical Uniswap fee/tickSpacing pairings.
      const tiers: Array<[number, number]> = [
        [100, 1],
        [500, 10],
        [3000, 60],
        [10000, 200],
      ];
      const results = await Promise.all(
        tiers.map(async ([fee, tickSpacing]) => {
          const { poolId } = computePoolId(currency0, currency1, fee, tickSpacing, hooks);
          try {
            const raw = await call(
              rpc,
              UNISWAP_V4.StateView,
              SEL.getSlot0 + poolId.replace(/^0x/, ""),
            );
            const [sqrtPriceX96, tick] = decodeAbiParameters(
              parseAbiParameters("uint160, int24, uint24, uint24"),
              raw as `0x${string}`,
            ) as unknown as [bigint, number];
            return {
              fee,
              feePercent: fee / 10_000,
              tickSpacing,
              poolId,
              initialised: sqrtPriceX96 !== 0n,
              sqrtPriceX96: sqrtPriceX96.toString(),
              tick,
            };
          } catch (err) {
            return { fee, tickSpacing, poolId, initialised: false, error: (err as Error).message.slice(0, 60) };
          }
        }),
      );
      const found = results.filter((r) => r.initialised);
      return json({
        pair: [currency0, currency1],
        hooks,
        tiersProbed: results.length,
        initialisedPools: found.length,
        pools: found,
        allTiers: results,
        caveat:
          "Only default hookless tiers are probed. A pool with a hook contract has a different poolId and will not be found here.",
      });
    },
  );
}
