import { z } from "zod";
import type { Register } from "../types.js";
import { json } from "../rpc.js";
import {
  keccak256,
  toHex as viemToHex,
  getAddress,
  isAddress,
  encodeAbiParameters,
  decodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  type AbiParameter,
  toFunctionSelector,
  toEventSelector,
  formatUnits as viemFormatUnits,
  parseUnits,
  hexToString,
  stringToHex,
  isHex,
  size,
} from "viem";

/**
 * Offline helpers. None of these touch the network — they exist because an agent
 * mid-task otherwise has to guess at encodings, and a wrong selector or a
 * float-rounded amount fails in ways that are expensive to debug on-chain.
 */
export function registerUtilTools(register: Register) {
  register(
    "keccak_hash",
    "keccak256 of a UTF-8 string or hex bytes.",
    {
      input: z.string(),
      inputIsHex: z.boolean().default(false),
    },
    async ({ input, inputIsHex }) =>
      json({
        input,
        keccak256: keccak256(inputIsHex ? (input as `0x${string}`) : stringToHex(input)),
      }),
  );

  register(
    "function_selector",
    "Compute the 4-byte selector for a function signature, e.g. 'transfer(address,uint256)'.",
    { signature: z.string() },
    async ({ signature }) => {
      const sig = signature.startsWith("function ") ? signature : `function ${signature}`;
      return json({ signature, selector: toFunctionSelector(sig) });
    },
  );

  register(
    "event_topic",
    "Compute the topic0 hash for an event signature, e.g. 'Transfer(address,address,uint256)'.",
    { signature: z.string() },
    async ({ signature }) => {
      const sig = signature.startsWith("event ") ? signature : `event ${signature}`;
      return json({ signature, topic0: toEventSelector(sig) });
    },
  );

  register(
    "checksum_address",
    "Validate an address and return its EIP-55 checksummed form.",
    { address: z.string() },
    async ({ address }) => {
      if (!isAddress(address, { strict: false })) {
        return json({ address, valid: false, error: "Not a valid 20-byte hex address" });
      }
      return json({ input: address, valid: true, checksummed: getAddress(address) });
    },
  );

  register(
    "encode_abi",
    "ABI-encode values against a parameter signature, e.g. params='address,uint256'.",
    {
      params: z.string().describe("Comma-separated solidity types"),
      values: z.array(z.string()),
    },
    async ({ params, values }) => {
      // parseAbiParameters cannot infer from a runtime string; widen to the
      // general AbiParameter[] rather than fighting const-generic inference.
      const parsed = parseAbiParameters(params) as readonly AbiParameter[];
      const coerced = values.map((v: string, i: number) => {
        const t = (parsed[i] as { type?: string })?.type ?? "";
        if (t.startsWith("uint") || t.startsWith("int")) return BigInt(v);
        if (t === "bool") return v === "true";
        return v;
      });
      return json({ params, encoded: encodeAbiParameters(parsed, coerced as never) });
    },
  );

  register(
    "decode_abi",
    "ABI-decode a hex blob against a parameter signature.",
    { params: z.string(), data: z.string() },
    async ({ params, data }) => {
      const decoded = decodeAbiParameters(
        parseAbiParameters(params) as readonly AbiParameter[],
        data as `0x${string}`,
      );
      return json({ params, decoded: decoded.map((d) => String(d)) });
    },
  );

  register(
    "decode_calldata",
    "Decode calldata against a known function signature, splitting selector from arguments.",
    { signature: z.string(), data: z.string() },
    async ({ signature, data }) => {
      const sig = signature.startsWith("function ") ? signature : `function ${signature}`;
      const expected = toFunctionSelector(sig);
      const actual = data.slice(0, 10);
      if (expected.toLowerCase() !== actual.toLowerCase()) {
        return json({
          match: false,
          expectedSelector: expected,
          actualSelector: actual,
          error: "Calldata does not match this signature — decoding would produce nonsense.",
        });
      }
      const abi = parseAbi([sig]);
      const fn = abi[0] as { inputs?: readonly { type: string }[] };
      const types = (fn.inputs ?? []).map((i) => i.type).join(",");
      const decoded = types
        ? decodeAbiParameters(
            parseAbiParameters(types) as readonly AbiParameter[],
            ("0x" + data.slice(10)) as `0x${string}`,
          )
        : [];
      return json({
        match: true,
        selector: actual,
        args: decoded.map((d) => String(d)),
      });
    },
  );

  register(
    "to_wei",
    "Convert a decimal amount to base units without floating-point rounding.",
    { amount: z.string(), decimals: z.number().default(18) },
    async ({ amount, decimals }) =>
      json({ amount, decimals, baseUnits: parseUnits(amount, decimals).toString() }),
  );

  register(
    "from_wei",
    "Convert base units to a decimal amount.",
    { baseUnits: z.string(), decimals: z.number().default(18) },
    async ({ baseUnits, decimals }) =>
      json({ baseUnits, decimals, amount: viemFormatUnits(BigInt(baseUnits), decimals) }),
  );

  register(
    "hex_convert",
    "Convert between hex, decimal, and UTF-8 string.",
    { value: z.string() },
    async ({ value }) => {
      const out: Record<string, unknown> = { input: value };
      if (isHex(value)) {
        out.isHex = true;
        out.byteLength = size(value as `0x${string}`);
        try {
          out.asDecimal = BigInt(value).toString();
        } catch {
          out.asDecimal = null;
        }
        try {
          out.asUtf8 = hexToString(value as `0x${string}`).replace(/\0+$/, "");
        } catch {
          out.asUtf8 = null;
        }
      } else {
        out.isHex = false;
        try {
          out.asHex = viemToHex(BigInt(value));
        } catch {
          out.asHex = stringToHex(value);
          out.interpretedAs = "utf-8 string";
        }
      }
      return json(out);
    },
  );

  register(
    "random_nonce",
    "Generate a random 32-byte nonce, suitable for an EIP-3009 authorization. EIP-3009 nonces are random, not sequential.",
    {},
    async () => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return json({
        nonce: "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""),
      });
    },
  );
}
