import { z } from "zod";
import type { Register } from "../types.js";
import { RpcClient, json } from "../rpc.js";
import { KNOWN_ASSETS, TRANSFER_WITH_AUTHORIZATION_TYPES, resolveAsset } from "../assets.js";
import { verifyTypedData, hashTypedData, recoverAddress, keccak256, encodeAbiParameters, parseAbiParameters, stringToHex } from "viem";

const pad = (v: string) => v.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const padNum = (v: string | bigint) => BigInt(v).toString(16).padStart(64, "0");

/**
 * Extended EIP-3009 / EIP-2612 tooling beyond the basics in usdg.ts.
 *
 * All builders return unsigned typed-data or calldata. Signing happens elsewhere —
 * this server holds no keys.
 */
export function registerEip3009Tools(register: Register, rpc: RpcClient) {
  register(
    "verify_authorization_signature",
    "Verify an EIP-3009 signature offline: does it recover to the claimed signer, for this exact token and chain? Catches wrong-domain and cross-chain-replay signatures before they cost gas.",
    {
      token: z.string().default("USDG"),
      from: z.string(),
      to: z.string(),
      value: z.string().describe("Base units"),
      validAfter: z.string(),
      validBefore: z.string(),
      nonce: z.string(),
      signature: z.string(),
    },
    async ({ token, from, to, value, validAfter, validBefore, nonce, signature }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) {
        throw new Error(`No verified EIP-712 domain on record for "${token}".`);
      }
      const message = {
        from: from as `0x${string}`,
        to: to as `0x${string}`,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as `0x${string}`,
      };
      const digest = hashTypedData({
        domain: asset.domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message,
      });
      let valid = false;
      let recovered: string | null = null;
      try {
        valid = await verifyTypedData({
          address: from as `0x${string}`,
          domain: asset.domain,
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message,
          signature: signature as `0x${string}`,
        });
        recovered = await recoverAddress({ hash: digest, signature: signature as `0x${string}` });
      } catch (e) {
        return json({ valid: false, error: (e as Error).message.slice(0, 160) });
      }
      const now = Math.floor(Date.now() / 1000);
      return json({
        valid,
        digest,
        claimedSigner: from,
        recoveredSigner: recovered,
        domain: asset.domain,
        timeWindow: {
          validAfter: Number(validAfter),
          validBefore: Number(validBefore),
          now,
          active: Number(validAfter) <= now && now < Number(validBefore),
        },
        hint: valid
          ? undefined
          : "A signature valid on another chain will fail here — chainId is part of the EIP-712 domain.",
      });
    },
  );

  register(
    "build_receive_authorization",
    "Build the EIP-712 payload for receiveWithAuthorization. Unlike transferWithAuthorization, only the payee may submit it — which closes the front-running window where anyone can relay a valid authorization.",
    {
      token: z.string().default("USDG"),
      from: z.string(),
      to: z.string(),
      amount: z.string(),
      validForSeconds: z.number().default(3600),
      nonce: z.string().optional(),
    },
    async ({ token, from, to, amount, validForSeconds, nonce }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) throw new Error(`No verified EIP-712 domain for "${token}".`);
      const [whole, frac = ""] = amount.split(".");
      if (frac.length > asset.decimals)
        throw new Error(`${amount} exceeds ${asset.symbol}'s ${asset.decimals} decimals.`);
      const value =
        BigInt(whole || "0") * 10n ** BigInt(asset.decimals) +
        BigInt(frac.padEnd(asset.decimals, "0") || "0");
      const now = Math.floor(Date.now() / 1000);
      const n =
        nonce ??
        "0x" +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
      return json({
        typedData: {
          domain: asset.domain,
          // Same field layout as TransferWithAuthorization; only the type name differs.
          types: {
            ReceiveWithAuthorization:
              TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization,
          },
          primaryType: "ReceiveWithAuthorization",
          message: {
            from,
            to,
            value: value.toString(),
            validAfter: String(now - 60),
            validBefore: String(now + validForSeconds),
            nonce: n,
          },
        },
        submitterConstraint: `Only ${to} may submit this — the contract enforces caller == payee (CallerMustBePayee()).`,
        signing: "Sign with eth_signTypedData_v4. This server holds no keys.",
      });
    },
  );

  register(
    "build_cancel_authorization",
    "Build the EIP-712 payload to cancel an unused EIP-3009 authorization before it can be redeemed.",
    { token: z.string().default("USDG"), authorizer: z.string(), nonce: z.string() },
    async ({ token, authorizer, nonce }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) throw new Error(`No verified EIP-712 domain for "${token}".`);
      return json({
        typedData: {
          domain: asset.domain,
          types: {
            CancelAuthorization: [
              { name: "authorizer", type: "address" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "CancelAuthorization",
          message: { authorizer, nonce },
        },
        note: "Cancellation only works while the authorization is still unused. Check with check_authorization first.",
        signing: "Sign with eth_signTypedData_v4.",
      });
    },
  );

  register(
    "build_permit",
    "Build an EIP-2612 permit payload (gasless approval). Requires the token's current nonce, which is read on-chain.",
    {
      token: z.string().default("USDG"),
      owner: z.string(),
      spender: z.string(),
      amount: z.string(),
      validForSeconds: z.number().default(3600),
    },
    async ({ token, owner, spender, amount, validForSeconds }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) throw new Error(`No verified EIP-712 domain for "${token}".`);
      if (!asset.eip2612) throw new Error(`${asset.symbol} does not support EIP-2612 permit.`);
      // EIP-2612 nonces ARE sequential (unlike EIP-3009's random nonces), so it must
      // be read fresh — a stale nonce produces a signature the contract rejects.
      const raw = await rpc.call<string>("eth_call", [
        { to: asset.address, data: "0x7ecebe00" + pad(owner) },
        "latest",
      ]);
      const nonce = BigInt(raw);
      const [whole, frac = ""] = amount.split(".");
      if (frac.length > asset.decimals)
        throw new Error(`${amount} exceeds ${asset.symbol}'s ${asset.decimals} decimals.`);
      const value =
        BigInt(whole || "0") * 10n ** BigInt(asset.decimals) +
        BigInt(frac.padEnd(asset.decimals, "0") || "0");
      const deadline = Math.floor(Date.now() / 1000) + validForSeconds;
      return json({
        typedData: {
          domain: asset.domain,
          types: {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          primaryType: "Permit",
          message: {
            owner,
            spender,
            value: value.toString(),
            nonce: nonce.toString(),
            deadline: String(deadline),
          },
        },
        nonceReadOnchain: nonce.toString(),
        warning:
          "EIP-2612 nonces are sequential. Any other permit signed by this owner and submitted first invalidates this one.",
        signing: "Sign with eth_signTypedData_v4.",
      });
    },
  );

  register(
    "build_transfer_authorization_calldata",
    "Assemble the final transferWithAuthorization CALLDATA from a signed authorization, ready for a relayer to submit.",
    {
      token: z.string().default("USDG"),
      from: z.string(),
      to: z.string(),
      value: z.string().describe("Base units"),
      validAfter: z.string(),
      validBefore: z.string(),
      nonce: z.string(),
      signature: z.string().describe("65-byte signature"),
    },
    async ({ token, from, to, value, validAfter, validBefore, nonce, signature }) => {
      const asset = resolveAsset(token);
      const address = asset?.address ?? token;
      const sig = signature.replace(/^0x/, "");
      if (sig.length !== 130) {
        throw new Error(`Expected a 65-byte signature (130 hex chars), got ${sig.length}.`);
      }
      const r = sig.slice(0, 64);
      const s = sig.slice(64, 128);
      let v = parseInt(sig.slice(128, 130), 16);
      // Normalise legacy 0/1 recovery ids to 27/28, which is what the contract expects.
      if (v < 27) v += 27;
      const data =
        "0xe3ee160e" +
        pad(from) +
        pad(to) +
        padNum(value) +
        padNum(validAfter) +
        padNum(validBefore) +
        nonce.replace(/^0x/, "").padStart(64, "0") +
        padNum(BigInt(v)) +
        r +
        s;
      return json({
        unsigned: { to: address, data, value: "0x0" },
        decodedSignature: { v, r: "0x" + r, s: "0x" + s },
        relayer:
          "Any address may submit this — the payer's signature authorises the transfer and the submitter pays gas.",
      });
    },
  );

  register(
    "list_eip3009_assets",
    "Assets on this chain known to support EIP-3009, and therefore usable for gasless, relayer-submitted payments.",
    {},
    async () =>
      json({
        assets: Object.values(KNOWN_ASSETS)
          .filter((a) => a.eip3009)
          .map((a) => ({
            symbol: a.symbol,
            address: a.address,
            decimals: a.decimals,
            domain: a.domain,
          })),
        note: "Use probe_token_capabilities to test an asset not listed here — bytecode scanning gives false negatives on Diamonds.",
      }),
  );

  register(
    "authorization_digest",
    "Compute the EIP-712 digest a wallet will be asked to sign for a given authorization, without signing it.",
    {
      token: z.string().default("USDG"),
      from: z.string(),
      to: z.string(),
      value: z.string(),
      validAfter: z.string(),
      validBefore: z.string(),
      nonce: z.string(),
    },
    async ({ token, from, to, value, validAfter, validBefore, nonce }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) throw new Error(`No verified EIP-712 domain for "${token}".`);
      const digest = hashTypedData({
        domain: asset.domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: from as `0x${string}`,
          to: to as `0x${string}`,
          value: BigInt(value),
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
          nonce: nonce as `0x${string}`,
        },
      });
      const typeHash = keccak256(
        stringToHex(
          "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
        ),
      );
      return json({ digest, typeHash, domain: asset.domain });
    },
  );

  register(
    "verify_domain_separator",
    "Recompute a token's EIP-712 DOMAIN_SEPARATOR from its stored domain and compare it against the live contract. A mismatch means the contract was upgraded and stored signatures would be rejected.",
    { token: z.string().default("USDG") },
    async ({ token }) => {
      const asset = resolveAsset(token);
      if (!asset?.domain) throw new Error(`No verified EIP-712 domain for "${token}".`);
      const typeHash = keccak256(
        stringToHex(
          "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        ),
      );
      const computed = keccak256(
        encodeAbiParameters(
          parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
          [
            typeHash,
            keccak256(stringToHex(asset.domain.name)),
            keccak256(stringToHex(asset.domain.version)),
            BigInt(asset.domain.chainId),
            asset.domain.verifyingContract,
          ],
        ),
      );
      const onchain = await rpc
        .call<string>("eth_call", [{ to: asset.address, data: "0x3644e515" }, "latest"])
        .catch(() => null);
      return json({
        token: asset.symbol,
        domain: asset.domain,
        computed,
        onchain,
        matches: onchain !== null && onchain.toLowerCase() === computed.toLowerCase(),
        recorded: asset.expectedDomainSeparator ?? null,
      });
    },
  );
}
