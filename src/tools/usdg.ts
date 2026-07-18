import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, TransportError, formatUnits, fromHex, json } from "../rpc.js";
import {
  KNOWN_ASSETS,
  SELECTORS,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  UNKNOWN_FUNCTION_REVERTS,
  resolveAsset,
} from "../assets.js";

const ZERO_WORD = "0".repeat(64);
const word = (hexOrAddr: string) =>
  hexOrAddr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** Probe result for a single selector. */
interface Probe {
  selector: string;
  present: boolean;
  evidence: string;
}

export function registerUsdgTools(register: Register, rpc: RpcClient) {
  /**
   * Capability detection that works on Diamonds.
   *
   * Scanning a proxy's bytecode for selectors gives a FALSE NEGATIVE on EIP-2535,
   * because facet code lives in separate contracts the proxy delegates to. The
   * reliable signal is the revert: an unknown function reverts with the router's own
   * error (FacetNotFound() = 0x800ab12c on USDG), whereas an existing function
   * reverts with a domain error from inside its own body. So we call each selector
   * with deliberately invalid arguments and compare.
   */
  register(
    "probe_token_capabilities",
    "Detect whether a token supports EIP-3009 (gasless transferWithAuthorization) and EIP-2612 (permit). Works correctly on EIP-2535 Diamonds, where scanning proxy bytecode reports false negatives.",
    { token: z.string().describe("Symbol (e.g. USDG) or contract address") },
    async ({ token }) => {
      const known = resolveAsset(token);
      const address = known?.address ?? token;

      // Establish the chain's unknown-function signature empirically, using two
      // selectors that cannot plausibly exist, rather than assuming 0x800ab12c.
      const controls = await Promise.all(
        ["0xdeadbeef", "0xbaadf00d"].map((sel) => probeRaw(rpc, address, sel)),
      );
      const unknownSignature =
        controls[0].revertData && controls[0].revertData === controls[1].revertData
          ? controls[0].revertData
          : null;

      // Argument counts match each signature; all-zero words are deliberately
      // invalid (validBefore=0 is always expired), which is what makes an existing
      // function reject from inside its own body.
      const targets: Array<[string, string]> = [
        ["transferWithAuthorization", SELECTORS.transferWithAuthorization + ZERO_WORD.repeat(9)],
        ["receiveWithAuthorization", SELECTORS.receiveWithAuthorization + ZERO_WORD.repeat(9)],
        ["cancelAuthorization", SELECTORS.cancelAuthorization + ZERO_WORD.repeat(5)],
        ["authorizationState", SELECTORS.authorizationState + ZERO_WORD.repeat(2)],
        ["permit", SELECTORS.permit + ZERO_WORD.repeat(7)],
        ["nonces", SELECTORS.nonces + ZERO_WORD],
        ["DOMAIN_SEPARATOR", SELECTORS.DOMAIN_SEPARATOR],
      ];

      const probes: Record<string, Probe> = {};
      for (const [name, data] of targets) {
        const r = await probeRaw(rpc, address, data);
        const selector = data.slice(0, 10);
        if (r.ok) {
          probes[name] = { selector, present: true, evidence: "returned data" };
        } else if (unknownSignature && r.revertData === unknownSignature) {
          probes[name] = {
            selector,
            present: false,
            evidence: `reverted with the unknown-function error ${r.revertData}`,
          };
        } else {
          probes[name] = {
            selector,
            present: true,
            evidence: `reverted with ${r.revertData ?? "no data"} — a domain error, not unknown-function`,
          };
        }
      }

      const eip3009 =
        probes.transferWithAuthorization.present && probes.authorizationState.present;
      const eip2612 = probes.permit.present && probes.nonces.present;

      return json({
        token: address,
        symbol: known?.symbol ?? null,
        eip3009,
        eip2612,
        usableWithX402ExactScheme: eip3009,
        unknownFunctionRevert: unknownSignature,
        unknownFunctionMeaning: unknownSignature
          ? (UNKNOWN_FUNCTION_REVERTS[unknownSignature] ?? "unrecognised revert selector")
          : "could not establish — controls disagreed; treat results as unreliable",
        probes,
        method:
          "Each selector is called with invalid arguments. Reverting with the chain's unknown-function error means absent; reverting with anything else means present and validating.",
      });
    },
  );

  register(
    "usdg_info",
    "USDG (Global Dollar) details: address, decimals, supply, and its verified EIP-712 domain.",
    {},
    async () => {
      const usdg = KNOWN_ASSETS.USDG;
      const [supplyHex, sepHex] = await Promise.all([
        rpc.call<string>("eth_call", [{ to: usdg.address, data: SELECTORS.totalSupply }, "latest"]),
        rpc
          .call<string>("eth_call", [{ to: usdg.address, data: SELECTORS.DOMAIN_SEPARATOR }, "latest"])
          .catch(() => null),
      ]);
      const matches =
        sepHex !== null &&
        sepHex.toLowerCase() === usdg.expectedDomainSeparator?.toLowerCase();
      return json({
        ...usdg,
        totalSupplyRaw: fromHex(supplyHex).toString(),
        totalSupply: formatUnits(fromHex(supplyHex), usdg.decimals, usdg.symbol),
        onchainDomainSeparator: sepHex,
        domainSeparatorMatches: matches,
        warning: matches
          ? undefined
          : "DOMAIN_SEPARATOR does not match the expected value — the contract may have been upgraded. Signatures built from the stored domain would be rejected.",
      });
    },
  );

  register(
    "check_authorization",
    "Check whether an EIP-3009 authorization nonce has already been used. EIP-3009 nonces are random bytes32, not sequential.",
    {
      token: z.string().default("USDG"),
      authorizer: z.string().describe("The address that signed the authorization"),
      nonce: z.string().describe("32-byte hex nonce"),
    },
    async ({ token, authorizer, nonce }) => {
      const asset = resolveAsset(token);
      const address = asset?.address ?? token;
      const data = SELECTORS.authorizationState + word(authorizer) + word(nonce);
      const raw = await rpc.call<string>("eth_call", [{ to: address, data }, "latest"]);
      const used = fromHex(raw) !== 0n;
      return json({ token: address, authorizer, nonce, used });
    },
  );

  register(
    "build_transfer_authorization",
    "Build the EIP-712 payload for a gasless EIP-3009 transfer, ready for external signing. Returns the typed-data struct — this server never signs.",
    {
      token: z.string().default("USDG"),
      from: z.string(),
      to: z.string(),
      amount: z.string().describe("Human amount, e.g. '1.5' — converted using token decimals"),
      validForSeconds: z.number().default(3600),
      nonce: z.string().optional().describe("32-byte hex; randomly generated if omitted"),
    },
    async ({ token, from, to, amount, validForSeconds, nonce }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) {
        throw new Error(
          `No verified EIP-712 domain on record for "${token}". Run probe_token_capabilities first; building a signature against a guessed domain produces one the contract will reject.`,
        );
      }
      if (!asset.eip3009) {
        throw new Error(`${asset.symbol} does not support EIP-3009.`);
      }

      // Decimal-string -> base units without floating point, which would silently
      // lose precision on amounts a stablecoin cares about.
      const [whole, frac = ""] = amount.split(".");
      if (frac.length > asset.decimals) {
        throw new Error(
          `${amount} has more precision than ${asset.symbol} supports (${asset.decimals} decimals).`,
        );
      }
      const value =
        BigInt(whole || "0") * 10n ** BigInt(asset.decimals) +
        BigInt(frac.padEnd(asset.decimals, "0") || "0");

      const now = Math.floor(Date.now() / 1000);
      const genNonce =
        nonce ??
        "0x" +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

      return json({
        typedData: {
          domain: asset.domain,
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from,
            to,
            value: value.toString(),
            validAfter: String(now - 60),
            validBefore: String(now + validForSeconds),
            nonce: genNonce,
          },
        },
        amountParsed: formatUnits(value, asset.decimals, asset.symbol),
        signing:
          "Sign with eth_signTypedData_v4. The signature plus this message forms an x402 'exact' payment payload. This server holds no keys.",
        note: "validAfter is backdated 60s to tolerate clock skew between signer and node.",
      });
    },
  );
}

/**
 * A revert is the signal this probe reads. A transport failure is not -- it is
 * rethrown, because reporting a rate-limit as "this selector is absent" would turn
 * an outage into a false capability verdict.
 */
async function probeRaw(
  rpc: RpcClient,
  to: string,
  data: string,
): Promise<{ ok: boolean; revertData?: string }> {
  try {
    await rpc.call<string>("eth_call", [{ to, data }, "latest"]);
    return { ok: true };
  } catch (err) {
    if (err instanceof TransportError) throw err;
    const e = err as { data?: unknown };
    return {
      ok: false,
      revertData: typeof e.data === "string" ? e.data : undefined,
    };
  }
}
