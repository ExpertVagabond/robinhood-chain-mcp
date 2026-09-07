// Shared by the live canary (smoke-all.mjs) and its hermetic guard
// (upstream-error.test.mjs).
//
// Splits a tool failure into "the provider is having a bad day" and "something
// about the chain or our code actually changed". Only the second kind should
// turn the canary red — but a pattern that is too broad silently swallows real
// breakage, which is worse than the daily noise it replaces. Hence the guard.

/**
 * Provider-side failures: transport died, or the host said 5xx / 429 / 403.
 *
 * 403 is included on the evidence in 3dc8b3b — this Blockscout instance sits
 * behind Cloudflare bot management, so a 403 is the edge turning us away and
 * never a statement about the chain. src/blockscout.ts raises
 * ExplorerBlockedError for it and live.test.ts skips; this keeps smoke-all
 * consistent with that decision. Other 4xx stay real failures: a 404 or 400
 * means we asked for something that is no longer there.
 */
export const UPSTREAM_ERROR =
  /\bHTTP (5\d\d|429|403)\b|ExplorerBlockedError|behind bot protection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network (error|timeout)|rate.?limit/i;

/**
 * Fraction of the tool surface that may be upstream-unavailable before the run
 * is considered to have asserted nothing at all, and fails rather than
 * reporting a green canary that checked nothing.
 */
export const UPSTREAM_ABORT_RATIO = 0.5;

/** True when `text` describes a provider-side failure rather than a real change. */
export function isUpstreamError(text) {
  return UPSTREAM_ERROR.test(String(text));
}
