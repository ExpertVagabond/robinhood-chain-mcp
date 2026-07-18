import type { NetworkConfig } from "./networks.js";

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
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${this.network.rpcUrl}`);
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error) {
      throw new RpcError(body.error.code, body.error.message, body.error.data);
    }
    return body.result as T;
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
