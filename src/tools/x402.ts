import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, json } from "../rpc.js";
import { KNOWN_ASSETS, resolveAsset } from "../assets.js";

/**
 * x402 payment-protocol helpers.
 *
 * x402 settles the `exact` EVM scheme through EIP-3009, so Robinhood Chain is a
 * viable x402 network via USDG. The hosted facilitator at x402.org serves only
 * eip155:84532 (Base Sepolia) — confirmed by querying its /supported endpoint — so
 * anything on this chain needs a self-hosted facilitator. These tools build and
 * inspect payloads; they never move funds.
 */

const HOSTED_FACILITATOR = "https://x402.org/facilitator";

export function registerX402Tools(register: Register, rpc: RpcClient) {
  register(
    "x402_network_id",
    "The CAIP-2 network identifier for this chain, as x402 payloads must express it.",
    {},
    async () => {
      const cfg = rpc.config;
      return json({
        caip2: `eip155:${cfg.chainId}`,
        chainId: cfg.chainId,
        network: cfg.name,
        settlementAssets: Object.values(KNOWN_ASSETS)
          .filter((a) => a.eip3009)
          .map((a) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals })),
      });
    },
  );

  register(
    "x402_build_payment_requirements",
    "Build the paymentRequirements object a resource server returns in its HTTP 402 response.",
    {
      payTo: z.string().describe("Address that receives payment"),
      amount: z.string().describe("Human amount, e.g. '0.01'"),
      asset: z.string().default("USDG"),
      resource: z.string().optional().describe("URL of the paid resource"),
      description: z.string().optional(),
      maxTimeoutSeconds: z.number().default(60),
    },
    async ({ payTo, amount, asset, resource, description, maxTimeoutSeconds }) => {
      const a = resolveAsset(asset);
      if (!a) throw new Error(`Unknown asset "${asset}".`);
      if (!a.eip3009)
        throw new Error(
          `${a.symbol} does not support EIP-3009, so it cannot settle the x402 'exact' scheme.`,
        );
      const [whole, frac = ""] = amount.split(".");
      if (frac.length > a.decimals)
        throw new Error(`${amount} exceeds ${a.symbol}'s ${a.decimals} decimals.`);
      const base =
        BigInt(whole || "0") * 10n ** BigInt(a.decimals) +
        BigInt(frac.padEnd(a.decimals, "0") || "0");
      return json({
        paymentRequirements: {
          scheme: "exact",
          network: `eip155:${rpc.config.chainId}`,
          payTo,
          maxAmountRequired: base.toString(),
          asset: a.address,
          ...(resource ? { resource } : {}),
          ...(description ? { description } : {}),
          maxTimeoutSeconds,
        },
        humanAmount: `${amount} ${a.symbol}`,
        usage: "Return this in the HTTP 402 body so the client knows what to sign.",
      });
    },
  );

  register(
    "x402_build_payment_payload",
    "Assemble the x402 paymentPayload from a signed EIP-3009 authorization, ready to send in the X-PAYMENT header.",
    {
      from: z.string(),
      to: z.string(),
      value: z.string().describe("Base units"),
      validAfter: z.string(),
      validBefore: z.string(),
      nonce: z.string(),
      signature: z.string(),
    },
    async ({ from, to, value, validAfter, validBefore, nonce, signature }) => {
      const payload = {
        x402Version: 2,
        scheme: "exact",
        network: `eip155:${rpc.config.chainId}`,
        payload: {
          signature,
          authorization: { from, to, value, validAfter, validBefore, nonce },
        },
      };
      return json({
        paymentPayload: payload,
        header: Buffer.from(JSON.stringify(payload)).toString("base64"),
        usage: "Send the base64 value as the X-PAYMENT request header.",
      });
    },
  );

  register(
    "x402_check_facilitator",
    "Query an x402 facilitator's /supported endpoint and report whether it can settle for this chain. Defaults to the hosted facilitator, which does not support Robinhood Chain.",
    { facilitatorUrl: z.string().default(HOSTED_FACILITATOR) },
    async ({ facilitatorUrl }) => {
      const url = facilitatorUrl.replace(/\/$/, "") + "/supported";
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Facilitator returned HTTP ${res.status} for ${url}`);
      const body = (await res.json()) as { kinds?: Array<Record<string, unknown>> };
      const target = `eip155:${rpc.config.chainId}`;
      const kinds = body.kinds ?? [];
      const supported = kinds.some((k) => k.network === target);
      return json({
        facilitator: facilitatorUrl,
        thisChain: target,
        supportsThisChain: supported,
        evmNetworks: kinds
          .map((k) => String(k.network ?? ""))
          .filter((n) => n.startsWith("eip155:")),
        allNetworks: [...new Set(kinds.map((k) => String(k.network ?? "")))],
        implication: supported
          ? "This facilitator can verify and settle payments on this chain."
          : "This facilitator cannot settle here — you need a facilitator that serves this network.",
      });
    },
  );

  register(
    "x402_decode_payment_header",
    "Decode a base64 X-PAYMENT header into its payload, and sanity-check it against this chain.",
    { header: z.string() },
    async ({ header }) => {
      let decoded: Record<string, unknown>;
      try {
        decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        throw new Error("Header is not valid base64-encoded JSON.");
      }
      const expected = `eip155:${rpc.config.chainId}`;
      return json({
        payload: decoded,
        networkMatchesThisChain: decoded.network === expected,
        expectedNetwork: expected,
        scheme: decoded.scheme ?? null,
        warning:
          decoded.network !== expected
            ? `Payload targets ${decoded.network}, not ${expected} — it would be rejected here.`
            : undefined,
      });
    },
  );
}
