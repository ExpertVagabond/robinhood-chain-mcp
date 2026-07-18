import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, formatUnits, fromHex, json } from "../rpc.js";
import { KNOWN_ASSETS, SELECTORS, resolveAsset } from "../assets.js";
import { decodeAbiParameters, parseAbiParameters, encodeFunctionData, parseAbi } from "viem";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const pad = (v: string) => v.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const padNum = (v: string | bigint) => BigInt(v).toString(16).padStart(64, "0");

const call = (rpc: RpcClient, to: string, data: string) =>
  rpc.call<string>("eth_call", [{ to, data }, "latest"]);

/** Decode an ABI-encoded string return, tolerating tokens that return bytes32. */
function decodeString(hex: string): string | null {
  try {
    return decodeAbiParameters(parseAbiParameters("string"), hex as `0x${string}`)[0] as string;
  } catch {
    try {
      const s = Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8").replace(/\0+/g, "");
      return s.length ? s : null;
    } catch {
      return null;
    }
  }
}

async function resolveTokenAddress(token: string): Promise<string> {
  return resolveAsset(token)?.address ?? token;
}

export function registerErc20Tools(register: Register, rpc: RpcClient) {
  register(
    "token_metadata",
    "Read name, symbol, decimals and total supply directly from a token contract. Tolerates tokens that return bytes32 instead of string.",
    { token: z.string() },
    async ({ token }) => {
      const address = await resolveTokenAddress(token);
      const [name, symbol, decimals, supply] = await Promise.all([
        call(rpc, address, SELECTORS.name).catch(() => null),
        call(rpc, address, SELECTORS.symbol).catch(() => null),
        call(rpc, address, SELECTORS.decimals).catch(() => null),
        call(rpc, address, SELECTORS.totalSupply).catch(() => null),
      ]);
      const dec = decimals ? Number(fromHex(decimals)) : null;
      return json({
        address,
        name: name ? decodeString(name) : null,
        symbol: symbol ? decodeString(symbol) : null,
        decimals: dec,
        totalSupplyRaw: supply ? fromHex(supply).toString() : null,
        totalSupply:
          supply && dec !== null
            ? formatUnits(fromHex(supply), dec, decodeString(symbol ?? "") ?? "units")
            : null,
      });
    },
  );

  register(
    "token_allowance",
    "ERC-20 allowance an owner has granted a spender.",
    { token: z.string(), owner: z.string(), spender: z.string() },
    async ({ token, owner, spender }) => {
      const address = await resolveTokenAddress(token);
      // allowance(address,address)
      const data = "0xdd62ed3e" + pad(owner) + pad(spender);
      const raw = await call(rpc, address, data);
      const known = resolveAsset(token);
      const value = fromHex(raw);
      const MAX = (1n << 256n) - 1n;
      return json({
        token: address,
        owner,
        spender,
        raw: value.toString(),
        formatted: known ? formatUnits(value, known.decimals, known.symbol) : null,
        unlimited: value === MAX,
      });
    },
  );

  register(
    "multi_token_balance",
    "Read one address's balance across several tokens in a single Multicall3 round-trip.",
    { address: z.string(), tokens: z.array(z.string()).describe("Symbols or addresses") },
    async ({ address, tokens }) => {
      const resolved = await Promise.all(tokens.map(resolveTokenAddress));
      const abi = parseAbi([
        "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
      ]);
      const calls = resolved.map((t) => ({
        target: t as `0x${string}`,
        allowFailure: true,
        callData: (SELECTORS.balanceOf + pad(address)) as `0x${string}`,
      }));
      const data = encodeFunctionData({ abi, functionName: "aggregate3", args: [calls] });
      const raw = await call(rpc, MULTICALL3, data);
      const [results] = decodeAbiParameters(
        parseAbiParameters("(bool success, bytes returnData)[]"),
        raw as `0x${string}`,
      ) as unknown as Array<Array<{ success: boolean; returnData: string }>>;
      return json({
        address,
        balances: resolved.map((t, i) => {
          const r = results[i];
          const known = Object.values(KNOWN_ASSETS).find(
            (a) => a.address.toLowerCase() === t.toLowerCase(),
          );
          const value = r?.success && r.returnData !== "0x" ? BigInt(r.returnData) : null;
          return {
            token: t,
            symbol: known?.symbol ?? null,
            raw: value?.toString() ?? null,
            formatted:
              value !== null && known ? formatUnits(value, known.decimals, known.symbol) : null,
            ok: r?.success ?? false,
          };
        }),
        via: "Multicall3 aggregate3 — one RPC round-trip regardless of token count.",
      });
    },
  );

  register(
    "build_token_transfer",
    "Build UNSIGNED calldata for an ERC-20 transfer. Amount is parsed against the token's real decimals; over-precise amounts are refused rather than truncated.",
    { token: z.string(), to: z.string(), amount: z.string() },
    async ({ token, to, amount }) => {
      const address = await resolveTokenAddress(token);
      const known = resolveAsset(token);
      let decimals = known?.decimals;
      if (decimals === undefined) {
        const d = await call(rpc, address, SELECTORS.decimals);
        decimals = Number(fromHex(d));
      }
      const [whole, frac = ""] = amount.split(".");
      if (frac.length > decimals) {
        throw new Error(
          `${amount} exceeds the token's ${decimals} decimals — refusing to truncate silently.`,
        );
      }
      const value =
        BigInt(whole || "0") * 10n ** BigInt(decimals) +
        BigInt(frac.padEnd(decimals, "0") || "0");
      return json({
        unsigned: { to: address, data: "0xa9059cbb" + pad(to) + padNum(value), value: "0x0" },
        amountBaseUnits: value.toString(),
        decimals,
        signing: "Unsigned — sign and broadcast externally. This server holds no keys.",
      });
    },
  );

  register(
    "build_token_approve",
    "Build UNSIGNED calldata for an ERC-20 approve. Set unlimited=true for the max-uint256 allowance.",
    {
      token: z.string(),
      spender: z.string(),
      amount: z.string().default("0"),
      unlimited: z.boolean().default(false),
    },
    async ({ token, spender, amount, unlimited }) => {
      const address = await resolveTokenAddress(token);
      const known = resolveAsset(token);
      let decimals = known?.decimals;
      if (decimals === undefined) {
        const d = await call(rpc, address, SELECTORS.decimals);
        decimals = Number(fromHex(d));
      }
      const value = unlimited
        ? (1n << 256n) - 1n
        : BigInt(amount.split(".")[0] || "0") * 10n ** BigInt(decimals) +
          BigInt((amount.split(".")[1] ?? "").padEnd(decimals, "0") || "0");
      return json({
        unsigned: { to: address, data: "0x095ea7b3" + pad(spender) + padNum(value), value: "0x0" },
        approvalBaseUnits: value.toString(),
        unlimited,
        caution: unlimited
          ? "Unlimited approval lets the spender move the entire balance, indefinitely."
          : undefined,
        signing: "Unsigned — sign and broadcast externally.",
      });
    },
  );

  register(
    "decode_transfer_log",
    "Decode an ERC-20 Transfer event log into from/to/value.",
    {
      topics: z.array(z.string()).describe("Log topics; topic0 must be the Transfer hash"),
      data: z.string(),
    },
    async ({ topics, data }) => {
      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
        return json({
          decoded: false,
          error: `topic0 is not Transfer(address,address,uint256) — expected ${TRANSFER_TOPIC}`,
        });
      }
      return json({
        decoded: true,
        from: "0x" + (topics[1] ?? "").slice(-40),
        to: "0x" + (topics[2] ?? "").slice(-40),
        value: data && data !== "0x" ? BigInt(data).toString() : "0",
      });
    },
  );

  register(
    "token_transfer_history",
    "ERC-20 transfer events involving an address, read from chain logs rather than the explorer, so it works on any network.",
    {
      address: z.string(),
      token: z.string().optional(),
      fromBlock: z.string().default("latest"),
      toBlock: z.string().default("latest"),
      direction: z.enum(["sent", "received", "both"]).default("both"),
    },
    async ({ address, token, fromBlock, toBlock, direction }) => {
      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const padded = "0x" + pad(address);
      const filters: Array<(string | null)[]> = [];
      if (direction === "sent" || direction === "both")
        filters.push([TRANSFER_TOPIC, padded, null]);
      if (direction === "received" || direction === "both")
        filters.push([TRANSFER_TOPIC, null, padded]);

      const tokenAddress = token ? await resolveTokenAddress(token) : undefined;
      const batches = await Promise.all(
        filters.map((topics) => {
          const f: Record<string, unknown> = { fromBlock, toBlock, topics };
          if (tokenAddress) f.address = tokenAddress;
          return rpc.call<Array<Record<string, unknown>>>("eth_getLogs", [f]);
        }),
      );
      const logs = batches.flat();
      return json({
        address,
        count: logs.length,
        transfers: logs.map((l) => ({
          token: l.address,
          from: "0x" + String((l.topics as string[])[1] ?? "").slice(-40),
          to: "0x" + String((l.topics as string[])[2] ?? "").slice(-40),
          value: l.data && l.data !== "0x" ? BigInt(l.data as string).toString() : "0",
          block: l.blockNumber ? Number(fromHex(l.blockNumber as string)) : null,
          txHash: l.transactionHash,
        })),
      });
    },
  );
}
