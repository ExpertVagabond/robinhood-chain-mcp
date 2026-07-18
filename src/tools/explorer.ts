import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, json } from "../rpc.js";
import { BlockscoutClient, tokenAddress } from "../blockscout.js";

/** Blockscout-indexed queries. Mainnet only; testnet has no published explorer. */
export function registerExplorerTools(
  register: Register,
  rpc: RpcClient,
  scout: BlockscoutClient,
) {
  register(
    "address_info",
    "Explorer summary for an address: balance, contract status, verification, transaction count.",
    { address: z.string() },
    async ({ address }) => json(await scout.get(`/addresses/${address}`)),
  );

  register(
    "address_token_transfers",
    "Token transfers involving an address, from the explorer index.",
    { address: z.string(), limit: z.number().default(25) },
    async ({ address, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/addresses/${address}/token-transfers`,
      );
      const items = (res.items ?? []).slice(0, limit);
      return json({
        address,
        count: items.length,
        transfers: items.map((t) => ({
          token: (t.token as Record<string, unknown>)?.symbol ?? null,
          tokenAddress: tokenAddress((t.token ?? {}) as never),
          from: (t.from as Record<string, unknown>)?.hash ?? null,
          to: (t.to as Record<string, unknown>)?.hash ?? null,
          value: (t.total as Record<string, unknown>)?.value ?? null,
          decimals: (t.total as Record<string, unknown>)?.decimals ?? null,
          txHash: t.transaction_hash,
          timestamp: t.timestamp,
        })),
      });
    },
  );

  register(
    "address_internal_transactions",
    "Internal transactions (contract-initiated value transfers) for an address.",
    { address: z.string(), limit: z.number().default(25) },
    async ({ address, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/addresses/${address}/internal-transactions`,
      );
      return json({ address, items: (res.items ?? []).slice(0, limit) });
    },
  );

  register(
    "contract_source",
    "Verified source code and ABI for a contract, if the explorer has it.",
    { address: z.string() },
    async ({ address }) => {
      const info = await scout.get<Record<string, unknown>>(`/smart-contracts/${address}`);
      return json({
        address,
        name: info.name ?? null,
        compiler: info.compiler_version ?? null,
        optimizationEnabled: info.optimization_enabled ?? null,
        isVerified: info.is_verified ?? false,
        isProxy: info.proxy_type ? true : false,
        proxyType: info.proxy_type ?? null,
        implementations: info.implementations ?? null,
        abi: info.abi ?? null,
        sourceCodeAvailable: Boolean(info.source_code),
      });
    },
  );

  register(
    "contract_abi",
    "Fetch just the ABI of a verified contract — feed it to read_contract to call methods without knowing signatures in advance.",
    { address: z.string() },
    async ({ address }) => {
      const info = await scout.get<Record<string, unknown>>(`/smart-contracts/${address}`);
      const abi = (info.abi ?? []) as Array<Record<string, unknown>>;
      return json({
        address,
        verified: Boolean(info.is_verified),
        functionCount: abi.filter((x) => x.type === "function").length,
        functions: abi
          .filter((x) => x.type === "function")
          .map((f) => {
            const inputs = ((f.inputs ?? []) as Array<{ type: string }>)
              .map((i) => i.type)
              .join(",");
            return `${f.name}(${inputs})${f.stateMutability === "view" ? " view" : ""}`;
          }),
        abi,
      });
    },
  );

  register(
    "explorer_search",
    "Search the explorer for an address, token, transaction, or block.",
    { query: z.string() },
    async ({ query }) => json(await scout.get("/search", { q: query })),
  );

  register(
    "token_holders",
    "Largest holders of a token, from the explorer index.",
    { token: z.string(), limit: z.number().default(20) },
    async ({ token, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/tokens/${token}/holders`,
      );
      const items = (res.items ?? []).slice(0, limit);
      return json({
        token,
        count: items.length,
        holders: items.map((h) => ({
          address: (h.address as Record<string, unknown>)?.hash ?? null,
          value: h.value ?? null,
        })),
      });
    },
  );

  register(
    "token_transfers",
    "Recent transfers of a specific token.",
    { token: z.string(), limit: z.number().default(25) },
    async ({ token, limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        `/tokens/${token}/transfers`,
      );
      return json({ token, items: (res.items ?? []).slice(0, limit) });
    },
  );

  register(
    "latest_blocks",
    "Most recent blocks with transaction counts and gas usage.",
    { limit: z.number().default(10) },
    async ({ limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>("/blocks");
      const items = (res.items ?? []).slice(0, limit);
      return json({
        blocks: items.map((b) => ({
          height: b.height,
          hash: b.hash,
          txCount: b.transactions_count ?? b.transaction_count ?? null,
          gasUsed: b.gas_used,
          timestamp: b.timestamp,
        })),
      });
    },
  );

  register(
    "block_transactions",
    "All transactions in a given block, from the explorer index.",
    {
      block: z.string().default("latest").describe("Block height, hash, or 'latest'"),
      limit: z.number().default(25),
    },
    async ({ block, limit }) => {
      // Blockscout rejects tag names with a 422, so 'latest' must become a height.
      // Two further wrinkles, both observed live:
      //   1. eth_blockNumber can be ahead of the indexer, so its head 404s.
      //   2. Blockscout's own index tables are eventually consistent with each other —
      //      a block is listed in /blocks before its /transactions sub-resource exists,
      //      so even the explorer's self-reported newest block intermittently 404s.
      // So: start from the explorer's newest and walk back until one resolves.
      const isTag = /^(latest|pending|safe|finalized)$/i.test(block);
      let res: { items?: Array<Record<string, unknown>> } | undefined;
      let target = block;

      if (!isTag) {
        res = await scout.get(`/blocks/${target}/transactions`);
      } else {
        const recent = await scout.get<{ items?: Array<{ height?: number }> }>("/blocks");
        let newest = recent.items?.[0]?.height;
        if (newest === undefined) {
          const hex = await rpc.call<string>("eth_blockNumber");
          newest = Number(BigInt(hex));
        }
        let lastErr: unknown;
        for (let back = 0; back < 5; back++) {
          const candidate = newest - back;
          try {
            res = await scout.get(`/blocks/${candidate}/transactions`);
            target = String(candidate);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!res) {
          throw new Error(
            `No indexed block found within 5 of the explorer head (${newest}). Last error: ${(lastErr as Error)?.message}`,
          );
        }
      }
      const items = (res?.items ?? []).slice(0, limit);
      return json({
        block: target,
        count: items.length,
        transactions: items.map((t) => ({
          hash: t.hash,
          from: (t.from as Record<string, unknown>)?.hash ?? null,
          to: (t.to as Record<string, unknown>)?.hash ?? null,
          value: t.value,
          method: t.method,
          status: t.status,
        })),
      });
    },
  );

  register(
    "verified_contracts",
    "Contracts with verified source on this chain — a quick map of what is actually deployed and public.",
    { limit: z.number().default(25) },
    async ({ limit }) => {
      const res = await scout.get<{ items?: Array<Record<string, unknown>> }>(
        "/smart-contracts",
      );
      const items = (res.items ?? []).slice(0, limit);
      return json({
        count: items.length,
        contracts: items.map((c) => ({
          address: (c.address as Record<string, unknown>)?.hash ?? c.address ?? null,
          name: c.name ?? null,
          compiler: c.compiler_version ?? null,
          verifiedAt: c.verified_at ?? null,
        })),
      });
    },
  );
}
