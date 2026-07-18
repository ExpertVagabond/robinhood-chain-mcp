import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json, toHex } from "../rpc.js";

export function registerChainTools(register: Register, rpc: RpcClient) {
  register(
    "chain_info",
    "Get Robinhood Chain network identity and live head: chain ID, RPC, explorer, native currency, latest block, gas price.",
    {},
    async () => {
      const [chainIdHex, blockHex, gasHex] = await Promise.all([
        rpc.call<string>("eth_chainId"),
        rpc.call<string>("eth_blockNumber"),
        rpc.call<string>("eth_gasPrice"),
      ]);
      const cfg = rpc.config;
      const onchainId = Number(fromHex(chainIdHex));
      return json({
        name: cfg.name,
        chainId: onchainId,
        // A mismatch means the RPC override points somewhere unexpected — surface it
        // rather than silently operating against the wrong chain.
        chainIdMatchesConfig: onchainId === cfg.chainId,
        configuredChainId: cfg.chainId,
        testnet: cfg.testnet,
        rpcUrl: cfg.rpcUrl,
        explorerUrl: cfg.explorerUrl ?? null,
        nativeCurrency: { symbol: cfg.nativeSymbol, decimals: cfg.nativeDecimals },
        latestBlock: Number(fromHex(blockHex)),
        gasPriceWei: fromHex(gasHex).toString(),
        gasPriceGwei: Number(fromHex(gasHex)) / 1e9,
        stack: "Arbitrum Orbit L2 settling on Ethereum",
      });
    },
  );

  register(
    "get_block",
    "Get a block by number ('latest', 'earliest', a decimal height, or a hex height).",
    {
      block: z.string().default("latest").describe("Block number or tag"),
      includeTransactions: z.boolean().default(false),
    },
    async ({ block, includeTransactions }) => {
      const tag = /^(latest|earliest|pending|safe|finalized)$/.test(block)
        ? block
        : toHex(block);
      const result = await rpc.call("eth_getBlockByNumber", [tag, includeTransactions]);
      return json(result);
    },
  );

  register(
    "gas_price",
    "Current gas price, with an EIP-1559 fee breakdown when the chain provides one.",
    {},
    async () => {
      const gasHex = await rpc.call<string>("eth_gasPrice");
      let feeHistory: unknown = null;
      try {
        feeHistory = await rpc.call("eth_feeHistory", ["0x5", "latest", [10, 50, 90]]);
      } catch {
        // Not all Orbit deployments expose eth_feeHistory; the base price still works.
        feeHistory = null;
      }
      return json({
        gasPriceWei: fromHex(gasHex).toString(),
        gasPriceGwei: Number(fromHex(gasHex)) / 1e9,
        feeHistory,
      });
    },
  );

  register(
    "estimate_gas",
    "Estimate gas for a call without sending it.",
    {
      to: z.string().describe("Target address"),
      from: z.string().optional(),
      data: z.string().optional().describe("Calldata hex"),
      value: z.string().optional().describe("Wei, decimal or hex"),
    },
    async ({ to, from, data, value }) => {
      const tx: Record<string, string> = { to };
      if (from) tx.from = from;
      if (data) tx.data = data;
      if (value) tx.value = toHex(value);
      const gas = await rpc.call<string>("eth_estimateGas", [tx]);
      return json({ gas: Number(fromHex(gas)), gasHex: gas });
    },
  );
}
