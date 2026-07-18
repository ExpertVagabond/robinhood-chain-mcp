#!/usr/bin/env node
/**
 * Robinhood Chain MCP Server
 *
 * Robinhood Chain is an Arbitrum Orbit L2 settling on Ethereum (mainnet chain ID
 * 4663, testnet 46630), fully EVM-compatible with ETH as the gas token.
 *
 * Read and build only: this server never holds keys, never signs, and never
 * broadcasts. Transaction and EIP-3009 authorization tools return unsigned payloads
 * for external signing.
 *
 * Environment:
 *   ROBINHOOD_NETWORK   mainnet (default) | testnet
 *   ROBINHOOD_RPC_URL   override the RPC endpoint (e.g. a private node)
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveNetwork } from "./networks.js";
import { RpcClient } from "./rpc.js";
import { BlockscoutClient } from "./blockscout.js";
import { registerChainTools } from "./tools/chain.js";
import { registerAccountTools } from "./tools/account.js";
import { registerContractTools } from "./tools/contract.js";
import { registerTransactionTools } from "./tools/transaction.js";
import { registerTokenTools } from "./tools/token.js";
import { registerUsdgTools } from "./tools/usdg.js";
import { registerArbitrumTools } from "./tools/arbitrum.js";
import { registerUtilTools } from "./tools/utils.js";
import { registerErc20Tools } from "./tools/erc20.js";
import { registerNftTools } from "./tools/nft.js";
import { registerEip3009Tools } from "./tools/eip3009.js";
import { registerExplorerTools } from "./tools/explorer.js";
import { registerX402Tools } from "./tools/x402.js";
import { registerStockTokenTools } from "./tools/stocktokens.js";
import { registerUniswapTools } from "./tools/uniswap.js";

const network = resolveNetwork();
const rpc = new RpcClient(network);
const scout = new BlockscoutClient(network);

export const server = new McpServer({
  name: "robinhood-chain-mcp",
  version: "0.1.0",
});

export const toolNames: string[] = [];

const register = (
  name: string,
  description: string,
  shape: Record<string, z.ZodType>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string>,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(name, description, shape, async (args: any) => {
    try {
      return { content: [{ type: "text" as const, text: await handler(args) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });
  toolNames.push(name);
};

registerChainTools(register, rpc);
registerAccountTools(register, rpc, scout);
registerContractTools(register, rpc);
registerTransactionTools(register, rpc, scout);
registerTokenTools(register, rpc, scout);
registerUsdgTools(register, rpc);
registerArbitrumTools(register, rpc);
registerUtilTools(register);
registerErc20Tools(register, rpc);
registerNftTools(register, rpc, scout);
registerEip3009Tools(register, rpc);
registerExplorerTools(register, rpc, scout);
registerX402Tools(register, rpc);
registerStockTokenTools(register, rpc, scout);
registerUniswapTools(register, rpc);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport — diagnostics must go to stderr or they corrupt it.
  console.error(
    `robinhood-chain-mcp: ${toolNames.length} tools on ${network.name} (chainId ${network.chainId})` +
      (scout.available ? "" : " — explorer-backed tools unavailable on this network"),
  );
}

// Only start the transport when run as a binary, so tests can import the module.
if (process.env.ROBINHOOD_MCP_NO_START !== "1") {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
