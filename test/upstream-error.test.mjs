// Hermetic guard for the canary's error classifier. No chain access.
//
// The canary downgrades provider-side failures so a Blockscout outage cannot
// turn it red. The risk that creates is the opposite one: a pattern that
// matches too much would file genuine chain drift as "upstream" and leave the
// canary permanently, uselessly green. These cases pin both directions.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isUpstreamError, UPSTREAM_ABORT_RATIO } from "./upstream-error.mjs";

// Verbatim shapes seen from the failing scheduled runs, 2026-08-23 onward.
const UPSTREAM = [
  "Error: Blockscout HTTP 500 for /addresses/0x5fc5360D/transactions (retried 3x)",
  "Error: Blockscout HTTP 502 for /stats",
  "Error: Blockscout HTTP 503 for /tokens",
  "Error: Blockscout HTTP 429 for /tokens",
  "socket hang up",
  "connect ETIMEDOUT 1.2.3.4:443",
  "getaddrinfo ENOTFOUND rh.blockscout.com",
  "read ECONNRESET",
  // 403 = Cloudflare bot management refusing us, per 3dc8b3b. Never a chain change.
  "Error: Blockscout HTTP 403 for /stats",
  "Blockscout returned HTTP 403 for /tokens. The explorer is behind bot protection",
];

// The things this canary exists to catch. If any of these is ever classified
// as upstream, the canary has stopped doing its job.
const REAL_FAILURES = [
  "DOMAIN_SEPARATOR mismatch: expected 0xabc got 0xdef",
  "chainId 4663 does not match configured chain",
  "transferWithAuthorization not found on token",
  "Error: Blockscout HTTP 404 for /tokens/0xdead",
  "Error: Blockscout HTTP 400 for /search",
  "assertion failed: price feed is stale",
];

test("provider-side failures are classified as upstream", () => {
  for (const s of UPSTREAM) {
    assert.equal(isUpstreamError(s), true, `should be upstream: ${s}`);
  }
});

test("real chain and code changes are never classified as upstream", () => {
  for (const s of REAL_FAILURES) {
    assert.equal(isUpstreamError(s), false, `must stay a failure: ${s}`);
  }
});

test("abort ratio leaves the canary able to fail on a total outage", () => {
  assert.ok(UPSTREAM_ABORT_RATIO > 0 && UPSTREAM_ABORT_RATIO < 1);
});
