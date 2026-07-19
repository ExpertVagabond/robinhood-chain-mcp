/**
 * Hermetic CI check: the server must start, complete an MCP handshake, and advertise
 * a well-formed tool set — without touching the chain.
 *
 * Guards two regressions that a typecheck cannot catch: a module silently failing to
 * register (tool count drops), and a tool shipped with a description too thin for a
 * model to choose it correctly.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MIN_TOOLS = 100;
const MIN_DESCRIPTION = 25;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "ci", version: "0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered`);

let failed = false;

if (tools.length < MIN_TOOLS) {
  console.error(`FAIL: expected >= ${MIN_TOOLS} tools, got ${tools.length}`);
  failed = true;
}

const weak = tools.filter(
  (t) => !t.description || t.description.length < MIN_DESCRIPTION,
);
if (weak.length) {
  console.error(`FAIL: ${weak.length} tools with weak descriptions:`);
  for (const t of weak) console.error(`  - ${t.name}`);
  failed = true;
}

const dupes = tools
  .map((t) => t.name)
  .filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) {
  console.error(`FAIL: duplicate tool names: ${[...new Set(dupes)].join(", ")}`);
  failed = true;
}

await transport.close();

if (failed) process.exit(1);
console.log("OK: tool set is well-formed");
