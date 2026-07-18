import type { NetworkConfig } from "./networks.js";

/**
 * A transport-level failure (HTTP status), as opposed to an RpcError, which is the
 * chain answering. Callers that interpret errors as negative answers -- "this
 * function does not exist", "this is not a stock token" -- MUST NOT swallow this:
 * a rate-limit is not a fact about a contract.
 */
export class TransportError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(`RPC ${code}: ${message}`);
  }
}

let id = 0;

export class RpcClient {
  constructor(private network: NetworkConfig) {}

  get config(): NetworkConfig {
    return this.network;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    // The public RPC rate-limits bursts with HTTP 429. Retry those (and 5xx) with
    // backoff; never retry 4xx, which are our fault and will fail identically.
    // This matters beyond convenience: callers that treat any thrown error as a
    // negative answer would otherwise report a rate-limit as fact about a contract.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(this.network.rpcUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The Robinhood RPC rejects some default client User-Agents with HTTP 403
          // (Node's urllib UA is refused outright), so set an explicit one.
          "user-agent": "robinhood-chain-mcp",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          result?: T;
          error?: { code: number; message: string; data?: unknown };
        };
        if (body.error) {
          throw new RpcError(body.error.code, body.error.message, body.error.data);
        }
        return body.result as T;
      }

      lastStatus = res.status;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) break;

      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 300 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
    throw new TransportError(
      lastStatus,
      `HTTP ${lastStatus} from ${this.network.rpcUrl}` +
        (lastStatus === 429 ? " (rate limited; retried 4x)" : ""),
    );
  }
}

export function toHex(value: number | bigint | string): string {
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : "0x" + BigInt(value).toString(16);
  }
  return "0x" + BigInt(value).toString(16);
}

export function fromHex(hex: string): bigint {
  return BigInt(hex);
}

/** Format a base-unit amount as a decimal string with its symbol. */
export function formatUnits(
  raw: bigint | string,
  decimals: number,
  symbol: string,
): string {
  const value = typeof raw === "string" ? BigInt(raw) : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const decimal = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return `${decimal} ${symbol} (${value.toString()} base units)`;
}

export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}
