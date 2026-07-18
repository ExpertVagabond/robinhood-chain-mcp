import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, json, toHex } from "../rpc.js";
import {
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  type Abi,
  type AbiFunction,
} from "viem";

export function registerContractTools(register: Register, rpc: RpcClient) {
  register(
    "read_contract",
    "Call a read-only contract function using a human-readable signature, e.g. 'function balanceOf(address) view returns (uint256)'.",
    {
      address: z.string().describe("Contract address"),
      signature: z
        .string()
        .describe("Full function signature, e.g. 'function symbol() view returns (string)'"),
      args: z.array(z.string()).default([]).describe("Arguments as strings"),
      block: z.string().default("latest"),
    },
    async ({ address, signature, args, block }) => {
      // parseAbi cannot infer a type from a runtime string, so widen to the general
      // Abi type rather than fighting the const-generic inference.
      const abi = parseAbi([signature]) as Abi;
      const fn = abi[0];
      if (!fn || fn.type !== "function") {
        throw new Error(`Not a function signature: ${signature}`);
      }
      const abiFn = fn as AbiFunction;
      // Coerce string args to the types the ABI expects; MCP arguments arrive as
      // strings, but viem needs real bigints/booleans to encode correctly.
      const coerced: unknown[] = args.map((a: string, i: number) => {
        const t = abiFn.inputs[i]?.type ?? "";
        if (t.startsWith("uint") || t.startsWith("int")) return BigInt(a);
        if (t === "bool") return a === "true";
        return a;
      });
      const data = encodeFunctionData({ abi, functionName: abiFn.name, args: coerced });
      const raw = await rpc.call<string>("eth_call", [{ to: address, data }, block]);
      const decoded = decodeFunctionResult({
        abi,
        functionName: abiFn.name,
        data: raw as `0x${string}`,
      });
      return json({ address, function: abiFn.name, raw, decoded });
    },
  );

  register(
    "raw_call",
    "Low-level eth_call with hand-built calldata. Returns raw returndata, and identifies the revert selector when the call reverts — useful for probing whether a function exists on a Diamond.",
    {
      to: z.string(),
      data: z.string().describe("Calldata hex, including the 4-byte selector"),
      from: z.string().optional(),
      block: z.string().default("latest"),
    },
    async ({ to, data, from, block }) => {
      const tx: Record<string, string> = { to, data };
      if (from) tx.from = from;
      try {
        const raw = await rpc.call<string>("eth_call", [tx, block]);
        return json({ ok: true, returnData: raw });
      } catch (err) {
        const e = err as { code?: number; message?: string; data?: unknown };
        return json({
          ok: false,
          error: e.message,
          revertData: e.data ?? null,
          hint: "A revert selector that differs from the chain's unknown-function error means the function EXISTS and rejected the arguments.",
        });
      }
    },
  );

  register(
    "build_transaction",
    "Build an UNSIGNED transaction for external signing. This server never holds keys and cannot broadcast.",
    {
      from: z.string(),
      to: z.string(),
      value: z.string().default("0").describe("Wei, decimal or hex"),
      data: z.string().default("0x"),
    },
    async ({ from, to, value, data }) => {
      const [nonceHex, gasPriceHex, chainIdHex] = await Promise.all([
        rpc.call<string>("eth_getTransactionCount", [from, "pending"]),
        rpc.call<string>("eth_gasPrice"),
        rpc.call<string>("eth_chainId"),
      ]);
      const tx = { from, to, value: toHex(value), data, nonce: nonceHex, chainId: chainIdHex };
      let gas: string | null = null;
      try {
        gas = await rpc.call<string>("eth_estimateGas", [tx]);
      } catch (err) {
        // A failed estimate usually means the call itself would revert. Report it
        // instead of emitting a transaction that is guaranteed to fail on-chain.
        return json({
          unsigned: null,
          error: `Gas estimation failed — this transaction would likely revert: ${(err as Error).message}`,
        });
      }
      return json({
        unsigned: { ...tx, gas, gasPrice: gasPriceHex },
        signing: "Unsigned. Sign externally (cast, viem, a wallet) and broadcast — this server holds no keys.",
      });
    },
  );
}
