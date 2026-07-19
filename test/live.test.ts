/**
 * Live tests against Robinhood Chain mainnet. No mocks — the point is to confirm the
 * server's assumptions still hold against the real chain, particularly the EIP-3009
 * capability detection, which is the one piece of non-obvious logic here.
 */

process.env.ROBINHOOD_MCP_NO_START = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNetwork, NETWORKS } from "../dist/networks.js";
import { RpcClient, fromHex, formatUnits } from "../dist/rpc.js";
import { BlockscoutClient, NoExplorerError } from "../dist/blockscout.js";
import { KNOWN_ASSETS, SELECTORS, resolveAsset } from "../dist/assets.js";

const rpc = new RpcClient(NETWORKS.mainnet);
const scout = new BlockscoutClient(NETWORKS.mainnet);

test("mainnet chain ID matches the configured value", async () => {
  const hex = await rpc.call<string>("eth_chainId");
  assert.equal(Number(fromHex(hex)), 4663);
});

test("testnet chain ID matches the configured value", async () => {
  const hex = await new RpcClient(NETWORKS.testnet).call<string>("eth_chainId");
  assert.equal(Number(fromHex(hex)), 46630);
});

test("resolveNetwork honours ROBINHOOD_NETWORK and RPC override", () => {
  process.env.ROBINHOOD_NETWORK = "testnet";
  assert.equal(resolveNetwork().chainId, 46630);
  process.env.ROBINHOOD_RPC_URL = "https://example.invalid/rpc";
  assert.equal(resolveNetwork().rpcUrl, "https://example.invalid/rpc");
  delete process.env.ROBINHOOD_RPC_URL;
  delete process.env.ROBINHOOD_NETWORK;
  assert.equal(resolveNetwork().chainId, 4663);
});

test("USDG metadata matches the chain", async () => {
  const usdg = KNOWN_ASSETS.USDG;
  const dec = await rpc.call<string>("eth_call", [
    { to: usdg.address, data: SELECTORS.decimals },
    "latest",
  ]);
  assert.equal(Number(fromHex(dec)), usdg.decimals);

  const sym = await rpc.call<string>("eth_call", [
    { to: usdg.address, data: SELECTORS.symbol },
    "latest",
  ]);
  assert.ok(sym.includes("55534447"), "symbol should encode USDG"); // hex for "USDG"
});

test("USDG's on-chain DOMAIN_SEPARATOR matches the recorded EIP-712 domain", async () => {
  const usdg = KNOWN_ASSETS.USDG;
  const sep = await rpc.call<string>("eth_call", [
    { to: usdg.address, data: SELECTORS.DOMAIN_SEPARATOR },
    "latest",
  ]);
  // If this fails, USDG was upgraded and every signature built from the stored
  // domain would be rejected on-chain.
  assert.equal(sep.toLowerCase(), usdg.expectedDomainSeparator!.toLowerCase());
});

test("capability probe rediscovers EIP-3009 on USDG's Diamond", async () => {
  const usdg = KNOWN_ASSETS.USDG;
  const ZERO = "0".repeat(64);

  const probe = async (data: string) => {
    try {
      await rpc.call<string>("eth_call", [{ to: usdg.address, data }, "latest"]);
      return { ok: true as const };
    } catch (err) {
      const e = err as { data?: unknown };
      return { ok: false as const, revertData: typeof e.data === "string" ? e.data : undefined };
    }
  };

  // Controls: two selectors that cannot exist must agree on the unknown-function error.
  const c1 = await probe("0xdeadbeef");
  const c2 = await probe("0xbaadf00d");
  assert.equal(c1.revertData, c2.revertData, "controls must agree");
  const unknown = c1.revertData;
  assert.equal(unknown, "0x800ab12c", "expected FacetNotFound() — USDG is a Diamond");

  // transferWithAuthorization exists: it must NOT revert with the unknown error.
  const twa = await probe(SELECTORS.transferWithAuthorization + ZERO.repeat(9));
  assert.notEqual(twa.revertData, unknown, "transferWithAuthorization should exist");

  // authorizationState is a view that returns cleanly.
  const authState = await probe(SELECTORS.authorizationState + ZERO.repeat(2));
  assert.equal(authState.ok, true);

  // permit (EIP-2612) likewise exists.
  const permit = await probe(SELECTORS.permit + ZERO.repeat(7));
  assert.notEqual(permit.revertData, unknown, "permit should exist");
});

test("a bytecode scan of the proxy would have MISSED EIP-3009", async () => {
  // Documents why probe_token_capabilities exists at all. The EIP-1967 slot points at
  // the Diamond's router, whose bytecode contains none of the facet selectors.
  const usdg = KNOWN_ASSETS.USDG;
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await rpc.call<string>("eth_getStorageAt", [usdg.address, implSlot, "latest"]);
  const impl = "0x" + raw.slice(-40);
  const code = await rpc.call<string>("eth_getCode", [impl, "latest"]);
  assert.ok(code.length > 2, "implementation should have code");
  assert.equal(
    code.includes(SELECTORS.transferWithAuthorization.slice(2)),
    false,
    "selector is absent from proxy bytecode — bytecode scanning is unreliable here",
  );
});

test("resolveAsset accepts symbol and address, case-insensitively", () => {
  assert.equal(resolveAsset("USDG")?.symbol, "USDG");
  assert.equal(resolveAsset("usdg")?.symbol, "USDG");
  assert.equal(resolveAsset(KNOWN_ASSETS.USDG.address.toLowerCase())?.symbol, "USDG");
  assert.equal(resolveAsset("NOPE"), undefined);
});

test("explorer returns tokens, and USDG is among them", async () => {
  const res = await scout.get<{ items?: Array<Record<string, unknown>> }>("/tokens", {
    type: "ERC-20",
  });
  const items = res.items ?? [];
  assert.ok(items.length > 0, "expected tokens");
  const symbols = items.map((t) => String(t.symbol ?? "").toUpperCase());
  assert.ok(symbols.includes("USDG"), `USDG missing from ${symbols.slice(0, 10)}`);
});

test("testnet explorer is configured and live", async () => {
  // This assertion was previously inverted: the testnet explorer was recorded as
  // absent because a GUESSED Blockscout hostname 404'd. The real host was found in
  // the docs-site JS bundle. A guessed URL returning 404 proves nothing.
  const testnetScout = new BlockscoutClient(NETWORKS.testnet);
  assert.equal(testnetScout.available, true);
  const stats = await testnetScout.get<Record<string, unknown>>("/stats");
  assert.ok(stats, "testnet explorer should return stats");
});

test("a network without an explorer fails clearly rather than obscurely", async () => {
  // Synthetic config: the NoExplorerError path must still be exercised even though
  // every real network now has an explorer.
  const noExplorer = new BlockscoutClient({
    ...NETWORKS.testnet,
    explorerUrl: undefined,
    explorerApiUrl: undefined,
  });
  assert.equal(noExplorer.available, false);
  await assert.rejects(() => noExplorer.get("/tokens"), NoExplorerError);
});

test("formatUnits does not lose precision on stablecoin amounts", () => {
  assert.match(formatUnits(1_000_000n, 6, "USDG"), /^1 USDG/);
  assert.match(formatUnits(1_234_567n, 6, "USDG"), /^1\.234567 USDG/);
  assert.match(formatUnits(1n, 6, "USDG"), /^0\.000001 USDG/);
});
