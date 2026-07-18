/** End-to-end MCP handshake over stdio against the built server. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, ROBINHOOD_NETWORK: "mainnet" },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test("server starts and advertises its tools", async () => {
  const { client, transport } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`  ${tools.length} tools: ${names.join(", ")}`);
    assert.ok(tools.length >= 15, `expected >=15 tools, got ${tools.length}`);
    for (const expected of ["chain_info", "usdg_info", "probe_token_capabilities",
      "build_transfer_authorization", "list_tokens", "read_contract", "build_transaction"]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    for (const t of tools) assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`);
  } finally { await transport.close(); }
});

test("chain_info returns live chain state", async () => {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "chain_info", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    const data = JSON.parse(text);
    assert.equal(data.chainId, 4663);
    assert.equal(data.chainIdMatchesConfig, true);
    assert.ok(data.latestBlock > 13_000_000);
    console.log(`  chain ${data.chainId} @ block ${data.latestBlock}, gas ${data.gasPriceGwei} gwei`);
  } finally { await transport.close(); }
});

test("probe_token_capabilities detects EIP-3009 on USDG through MCP", async () => {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "probe_token_capabilities", arguments: { token: "USDG" } });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    assert.equal(data.eip3009, true);
    assert.equal(data.eip2612, true);
    assert.equal(data.usableWithX402ExactScheme, true);
    assert.equal(data.unknownFunctionRevert, "0x800ab12c");
    console.log(`  USDG: eip3009=${data.eip3009} eip2612=${data.eip2612} (${data.unknownFunctionMeaning})`);
  } finally { await transport.close(); }
});

test("build_transfer_authorization emits a signable EIP-712 payload", async () => {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "build_transfer_authorization", arguments: {
      token: "USDG", from: "0x000000000000000000000000000000000000dEaD",
      to: "0x0000000000000000000000000000000000000001", amount: "1.5" } });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    assert.equal(data.typedData.domain.chainId, 4663);
    assert.equal(data.typedData.domain.name, "Global Dollar");
    assert.equal(data.typedData.message.value, "1500000"); // 1.5 at 6 decimals
    assert.match(data.typedData.message.nonce, /^0x[0-9a-f]{64}$/);
    console.log(`  value=${data.typedData.message.value} (${data.amountParsed})`);
  } finally { await transport.close(); }
});

test("over-precise amounts are refused, not silently truncated", async () => {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "build_transfer_authorization", arguments: {
      token: "USDG", from: "0x000000000000000000000000000000000000dEaD",
      to: "0x0000000000000000000000000000000000000001", amount: "1.1234567" } }); // 7dp vs 6
    assert.equal(res.isError, true);
    assert.match((res.content as Array<{ text: string }>)[0].text, /more precision/);
  } finally { await transport.close(); }
});
