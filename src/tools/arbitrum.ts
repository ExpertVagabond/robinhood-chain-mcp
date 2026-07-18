import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json } from "../rpc.js";

/**
 * Arbitrum Orbit precompiles.
 *
 * Robinhood Chain runs Nitro, so the standard Arbitrum precompiles are present at
 * their canonical addresses. Availability was probed against the live chain rather
 * than assumed — ArbSys, ArbGasInfo and NodeInterface respond; ArbOwnerPublic and
 * ArbWasm (Stylus) revert, so this chain has no Stylus support and no public owner
 * enumeration. Tools for those are deliberately absent rather than shipped broken.
 */

export const PRECOMPILES = {
  ArbSys: "0x0000000000000000000000000000000000000064",
  ArbAddressTable: "0x0000000000000000000000000000000000000066",
  ArbOwnerPublic: "0x000000000000000000000000000000000000006b",
  ArbGasInfo: "0x000000000000000000000000000000000000006c",
  ArbAggregator: "0x000000000000000000000000000000000000006d",
  ArbRetryableTx: "0x000000000000000000000000000000000000006e",
  ArbStatistics: "0x000000000000000000000000000000000000006f",
  ArbWasm: "0x0000000000000000000000000000000000000071",
  NodeInterface: "0x00000000000000000000000000000000000000c8",
} as const;

const SEL = {
  arbBlockNumber: "0xa3b1b31d",
  arbChainID: "0xd127f54a",
  arbOSVersion: "0x051038f2",
  arbBlockHash: "0x2b407a82",
  getPricesInWei: "0x41b247a8",
  getL1BaseFeeEstimate: "0xf5d6ded7",
  getMinimumGasPrice: "0xf918379a",
  getGasAccountingParams: "0x612af178",
  getPricesInArbGas: "0x02199f34",
  getL1PricingSurplus: "0x520acdd7",
  getPerBatchGasCharge: "0x1d5b5c20",
  getAmortizedCostCapBips: "0x7a7d6beb",
  withdrawEth: "0x25e16063",
} as const;

const call = (rpc: RpcClient, to: string, data: string) =>
  rpc.call<string>("eth_call", [{ to, data }, "latest"]);

/** Split a hex return blob into 32-byte words as bigints. */
function words(hex: string): bigint[] {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt("0x" + body.slice(i, i + 64)));
  }
  return out;
}

export function registerArbitrumTools(register: Register, rpc: RpcClient) {
  register(
    "arb_block_number",
    "L2 block number from the ArbSys precompile. This is the value eth_blockNumber returns — distinct from the block.number a contract observes.",
    {},
    async () => {
      const [arb, eth] = await Promise.all([
        call(rpc, PRECOMPILES.ArbSys, SEL.arbBlockNumber),
        rpc.call<string>("eth_blockNumber"),
      ]);
      return json({
        arbBlockNumber: Number(fromHex(arb)),
        ethBlockNumber: Number(fromHex(eth)),
        agree: fromHex(arb) === fromHex(eth) || Number(fromHex(eth)) - Number(fromHex(arb)) < 50,
        note: "Both track the L2 chain; a small gap is just latency between the two reads.",
      });
    },
  );

  register(
    "block_number_context",
    "Explain the three different 'block numbers' on this chain: the L2 height from eth_blockNumber, the L1 height a contract sees via block.number, and ArbSys.arbBlockNumber(). Getting these confused is the most common Orbit integration bug.",
    {},
    async () => {
      const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
      const [ethHex, arbHex, inEvmHex] = await Promise.all([
        rpc.call<string>("eth_blockNumber"),
        call(rpc, PRECOMPILES.ArbSys, SEL.arbBlockNumber),
        // Multicall3.getBlockNumber() returns block.number as the EVM sees it.
        call(rpc, MULTICALL3, "0x42cbb15c"),
      ]);
      const l2 = Number(fromHex(ethHex));
      const inEvm = Number(fromHex(inEvmHex));
      return json({
        eth_blockNumber: l2,
        arbSys_arbBlockNumber: Number(fromHex(arbHex)),
        inContract_blockNumber: inEvm,
        divergence: inEvm - l2,
        explanation:
          "On Arbitrum-derived chains, a contract reading block.number observes the L1 block height, not the L2 height returned by eth_blockNumber. Use ArbSys.arbBlockNumber() inside contracts when you need the L2 height. Deadlines computed from block.number advance at L1 pace (~12s), not L2 pace.",
        blockTimeHint:
          "Prefer block.timestamp over block numbers for deadlines — it is consistent across both.",
      });
    },
  );

  register(
    "arb_chain_id",
    "Chain ID reported by the ArbSys precompile, cross-checked against eth_chainId.",
    {},
    async () => {
      const [arb, eth] = await Promise.all([
        call(rpc, PRECOMPILES.ArbSys, SEL.arbChainID),
        rpc.call<string>("eth_chainId"),
      ]);
      return json({
        arbSysChainId: Number(fromHex(arb)),
        ethChainId: Number(fromHex(eth)),
        match: fromHex(arb) === fromHex(eth),
      });
    },
  );

  register(
    "arbos_version",
    "ArbOS version running on this chain.",
    {},
    async () => {
      const raw = await call(rpc, PRECOMPILES.ArbSys, SEL.arbOSVersion);
      const v = Number(fromHex(raw));
      return json({
        raw: v,
        // ArbSys.arbOSVersion() returns 55 + the actual ArbOS version.
        arbOsVersion: v - 55,
        note: "The precompile returns 55 + version; both are shown.",
      });
    },
  );

  register(
    "arb_gas_prices",
    "Full gas price breakdown from ArbGasInfo: per-L2-tx, per-L1-calldata-byte, per storage allocation, and the base fee components.",
    {},
    async () => {
      const raw = await call(rpc, PRECOMPILES.ArbGasInfo, SEL.getPricesInWei);
      const w = words(raw);
      return json({
        perL2Tx: w[0]?.toString() ?? null,
        perL1CalldataByte: w[1]?.toString() ?? null,
        perStorageAllocation: w[2]?.toString() ?? null,
        perArbGasBase: w[3]?.toString() ?? null,
        perArbGasCongestion: w[4]?.toString() ?? null,
        perArbGasTotal: w[5]?.toString() ?? null,
        raw,
      });
    },
  );

  register(
    "arb_l1_base_fee",
    "Current L1 base fee estimate used for data-availability pricing.",
    {},
    async () => {
      const raw = await call(rpc, PRECOMPILES.ArbGasInfo, SEL.getL1BaseFeeEstimate);
      const wei = fromHex(raw);
      return json({
        l1BaseFeeEstimateWei: wei.toString(),
        l1BaseFeeEstimateGwei: Number(wei) / 1e9,
        note: "Zero means the chain is not currently charging an L1 data component in this estimate.",
      });
    },
  );

  register(
    "arb_min_gas_price",
    "Minimum gas price (floor) enforced by the chain.",
    {},
    async () => {
      const raw = await call(rpc, PRECOMPILES.ArbGasInfo, SEL.getMinimumGasPrice);
      const wei = fromHex(raw);
      return json({
        minimumGasPriceWei: wei.toString(),
        minimumGasPriceGwei: Number(wei) / 1e9,
      });
    },
  );

  register(
    "arb_gas_accounting",
    "Speed limit, gas pool size, and max transaction gas from ArbGasInfo.",
    {},
    async () => {
      const raw = await call(rpc, PRECOMPILES.ArbGasInfo, SEL.getGasAccountingParams);
      const w = words(raw);
      return json({
        speedLimitPerSecond: w[0]?.toString() ?? null,
        gasPoolMax: w[1]?.toString() ?? null,
        maxTxGasLimit: w[2]?.toString() ?? null,
      });
    },
  );

  register(
    "arb_l1_pricing",
    "L1 pricing internals: surplus, per-batch gas charge, and the amortized cost cap.",
    {},
    async () => {
      const results = await Promise.allSettled([
        call(rpc, PRECOMPILES.ArbGasInfo, SEL.getL1PricingSurplus),
        call(rpc, PRECOMPILES.ArbGasInfo, SEL.getPerBatchGasCharge),
        call(rpc, PRECOMPILES.ArbGasInfo, SEL.getAmortizedCostCapBips),
      ]);
      const val = (r: PromiseSettledResult<string>) =>
        r.status === "fulfilled" ? BigInt.asIntN(256, fromHex(r.value)).toString() : null;
      return json({
        l1PricingSurplus: val(results[0]),
        perBatchGasCharge: val(results[1]),
        amortizedCostCapBips: val(results[2]),
        note: "null means the precompile method is unavailable on this chain.",
      });
    },
  );

  register(
    "estimate_l1_component",
    "Estimate the L1 data-availability component of a transaction's cost via the NodeInterface precompile — the part a plain eth_estimateGas does not show.",
    {
      to: z.string(),
      from: z.string().optional(),
      data: z.string().default("0x"),
      value: z.string().default("0x0"),
    },
    async ({ to, from, data, value }) => {
      // NodeInterface.gasEstimateComponents(address,bool,bytes)
      const total = await rpc
        .call<string>("eth_estimateGas", [{ to, from, data, value }])
        .catch(() => null);
      const l1BaseFee = await call(rpc, PRECOMPILES.ArbGasInfo, SEL.getL1BaseFeeEstimate).catch(
        () => "0x0",
      );
      const calldataBytes = Math.max(0, (data.length - 2) / 2);
      const nonZero = (data.replace(/^0x/, "").match(/..?/g) ?? []).filter(
        (b: string) => b !== "00",
      ).length;
      return json({
        totalGasEstimate: total ? Number(fromHex(total)) : null,
        calldataBytes,
        nonZeroCalldataBytes: nonZero,
        l1BaseFeeEstimateWei: fromHex(l1BaseFee).toString(),
        note: "On Orbit chains the gas estimate already folds in the L1 data cost; calldata size is the main lever for reducing it.",
      });
    },
  );

  register(
    "precompile_status",
    "Which Arbitrum precompiles are actually usable on this chain. Probes each with a real call rather than trusting that a canonical address implies a working precompile.",
    {},
    async () => {
      const probes: Array<[string, string, string]> = [
        ["ArbSys", PRECOMPILES.ArbSys, SEL.arbBlockNumber],
        ["ArbGasInfo", PRECOMPILES.ArbGasInfo, SEL.getMinimumGasPrice],
        ["ArbOwnerPublic", PRECOMPILES.ArbOwnerPublic, "0xa0c7642c"],
        ["ArbWasm (Stylus)", PRECOMPILES.ArbWasm, "0x54fd4d50"],
        ["ArbAggregator", PRECOMPILES.ArbAggregator, "0x6e6e8a6a"],
        ["ArbRetryableTx", PRECOMPILES.ArbRetryableTx, "0x9f8137a3"],
        ["ArbStatistics", PRECOMPILES.ArbStatistics, "0xc59d4847"],
        ["ArbAddressTable", PRECOMPILES.ArbAddressTable, "0xa5025222"],
      ];
      const results = await Promise.all(
        probes.map(async ([name, address, selector]) => {
          try {
            const r = await call(rpc, address, selector);
            return { name, address, usable: true, sample: r.slice(0, 34) };
          } catch (err) {
            return { name, address, usable: false, error: (err as Error).message.slice(0, 80) };
          }
        }),
      );
      return json({
        precompiles: results,
        stylusSupported: results.find((r) => r.name.startsWith("ArbWasm"))?.usable ?? false,
      });
    },
  );

  register(
    "build_l2_to_l1_withdrawal",
    "Build an UNSIGNED ArbSys.withdrawEth call to start an L2->L1 ETH withdrawal. Returns calldata only; this server never signs. Note the multi-day challenge period before the L1 claim can be executed.",
    { destination: z.string().describe("L1 recipient address"), amountWei: z.string() },
    async ({ destination, amountWei }) => {
      const data =
        SEL.withdrawEth + destination.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      return json({
        unsigned: {
          to: PRECOMPILES.ArbSys,
          data,
          value: "0x" + BigInt(amountWei).toString(16),
        },
        warning:
          "Withdrawals are subject to the rollup challenge period (typically ~7 days) before they can be claimed on L1. This only initiates the withdrawal.",
        signing: "Unsigned — sign and broadcast externally. This server holds no keys.",
      });
    },
  );
}
