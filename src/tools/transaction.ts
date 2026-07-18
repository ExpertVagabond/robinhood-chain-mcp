import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, fromHex, json } from "../rpc.js";
import { BlockscoutClient } from "../blockscout.js";

export function registerTransactionTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "get_transaction",
    "Get a transaction by hash.",
    { hash: z.string() },
    async ({ hash }) => json(await rpc.call("eth_getTransactionByHash", [hash])),
  );

  register(
    "get_receipt",
    "Get a transaction receipt, including status and logs.",
    { hash: z.string() },
    async ({ hash }) => {
      const receipt = await rpc.call<Record<string, unknown> | null>(
        "eth_getTransactionReceipt",
        [hash],
      );
      if (!receipt) {
        return json({ hash, found: false, note: "Not mined yet, or unknown hash." });
      }
      return json({
        ...receipt,
        succeeded: receipt.status === "0x1",
        gasUsedDecimal: receipt.gasUsed ? Number(fromHex(receipt.gasUsed as string)) : null,
      });
    },
  );

  register(
    "address_transactions",
    "Recent transactions for an address, via the explorer index. Mainnet only.",
    { address: z.string(), limit: z.number().default(20) },
    async ({ address, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/addresses/${address}/transactions`,
      );
      const items = (res.items ?? []).slice(0, limit);
      return json({
        address,
        count: items.length,
        transactions: items.map((t) => ({
          hash: t.hash,
          from: (t.from as Record<string, unknown>)?.hash ?? t.from,
          to: (t.to as Record<string, unknown>)?.hash ?? t.to,
          value: t.value,
          status: t.status,
          method: t.method,
          timestamp: t.timestamp,
        })),
      });
    },
  );

  register(
    "get_logs",
    "Query event logs by address and/or topics.",
    {
      address: z.string().optional(),
      fromBlock: z.string().default("latest"),
      toBlock: z.string().default("latest"),
      topics: z.array(z.string()).optional(),
    },
    async ({ address, fromBlock, toBlock, topics }) => {
      const filter: Record<string, unknown> = { fromBlock, toBlock };
      if (address) filter.address = address;
      if (topics?.length) filter.topics = topics;
      return json(await rpc.call("eth_getLogs", [filter]));
    },
  );
}
