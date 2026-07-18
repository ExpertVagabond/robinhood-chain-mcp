/**
 * Exercise every registered tool against live Robinhood Chain.
 *
 * A tool count is meaningless if the tools don't work, so this calls all of them with
 * realistic arguments and reports which succeed. Tools that are *expected* to error
 * for a given input (e.g. a non-token address) are marked so a red result is a real
 * regression rather than noise.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WHALE = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH contract, holds balances
const DEAD = "0x000000000000000000000000000000000000dEaD";
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"; // canonical Robinhood Stock Token

// name -> args. Anything omitted here is called with {}.
const ARGS = {
  get_block: { block: "latest" },
  estimate_gas: { to: USDG, data: "0x313ce567" },
  get_balance: { address: WHALE },
  get_nonce: { address: WHALE },
  is_contract: { address: USDG },
  get_token_balance: { address: WHALE, token: "USDG" },
  list_token_holdings: { address: USDG },
  read_contract: { address: USDG, signature: "function symbol() view returns (string)", args: [] },
  raw_call: { to: USDG, data: "0x313ce567" },
  build_transaction: { from: DEAD, to: DEAD, value: "0", data: "0x" },
  get_transaction: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000" },
  get_receipt: { hash: "0x0000000000000000000000000000000000000000000000000000000000000000" },
  address_transactions: { address: USDG, limit: 3 },
  get_logs: { address: USDG, fromBlock: "latest", toBlock: "latest" },
  list_tokens: { limit: 5 },
  token_info: { token: USDG },
  probe_token_capabilities: { token: "USDG" },
  check_authorization: { token: "USDG", authorizer: DEAD, nonce: "0x" + "11".repeat(32) },
  build_transfer_authorization: { token: "USDG", from: DEAD, to: WHALE, amount: "1.5" },
  estimate_l1_component: { to: USDG, data: "0x313ce567" },
  build_l2_to_l1_withdrawal: { destination: DEAD, amountWei: "1000" },
  keccak_hash: { input: "hello" },
  function_selector: { signature: "transfer(address,uint256)" },
  event_topic: { signature: "Transfer(address,address,uint256)" },
  checksum_address: { address: USDG.toLowerCase() },
  encode_abi: { params: "address,uint256", values: [DEAD, "1000"] },
  decode_abi: { params: "uint256", data: "0x" + "0".repeat(63) + "5" },
  decode_calldata: { signature: "transfer(address,uint256)", data: "0xa9059cbb" + "0".repeat(24) + DEAD.slice(2) + "0".repeat(63) + "1" },
  to_wei: { amount: "1.5", decimals: 6 },
  from_wei: { baseUnits: "1500000", decimals: 6 },
  hex_convert: { value: "0x1237" },
  token_metadata: { token: "USDG" },
  token_allowance: { token: "USDG", owner: WHALE, spender: DEAD },
  multi_token_balance: { address: WHALE, tokens: ["USDG", "WETH"] },
  build_token_transfer: { token: "USDG", to: DEAD, amount: "1.0" },
  build_token_approve: { token: "USDG", spender: DEAD, amount: "1.0" },
  decode_transfer_log: {
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
             "0x" + "0".repeat(24) + DEAD.slice(2), "0x" + "0".repeat(24) + WHALE.slice(2)],
    data: "0x" + "0".repeat(63) + "5",
  },
  token_transfer_history: { address: USDG, fromBlock: "latest", toBlock: "latest" },
  nft_owner: { contract: USDG, tokenId: "1", expectError: true },
  nft_token_uri: { contract: USDG, tokenId: "1", expectError: true },
  nft_balance: { contract: USDG, owner: WHALE },
  nft_collection_info: { contract: USDG },
  erc1155_balance: { contract: USDG, account: WHALE, tokenId: "1", expectError: true },
  detect_token_standard: { contract: USDG },
  address_nfts: { address: WHALE },
  verify_authorization_signature: {
    token: "USDG", from: DEAD, to: WHALE, value: "1000000",
    validAfter: "0", validBefore: "99999999999", nonce: "0x" + "22".repeat(32),
    signature: "0x" + "11".repeat(65),
  },
  build_receive_authorization: { token: "USDG", from: DEAD, to: WHALE, amount: "1.0" },
  build_cancel_authorization: { token: "USDG", authorizer: DEAD, nonce: "0x" + "33".repeat(32) },
  build_permit: { token: "USDG", owner: DEAD, spender: WHALE, amount: "1.0" },
  build_transfer_authorization_calldata: {
    token: "USDG", from: DEAD, to: WHALE, value: "1000000",
    validAfter: "0", validBefore: "99999999999", nonce: "0x" + "44".repeat(32),
    signature: "0x" + "11".repeat(65),
  },
  authorization_digest: {
    token: "USDG", from: DEAD, to: WHALE, value: "1000000",
    validAfter: "0", validBefore: "99999999999", nonce: "0x" + "55".repeat(32),
  },
  verify_domain_separator: { token: "USDG" },
  address_info: { address: USDG },
  address_token_transfers: { address: USDG, limit: 3 },
  address_internal_transactions: { address: USDG, limit: 3 },
  contract_source: { address: USDG },
  contract_abi: { address: USDG },
  explorer_search: { query: "USDG" },
  token_holders: { token: USDG, limit: 3 },
  token_transfers: { token: USDG, limit: 3 },
  latest_blocks: { limit: 3 },
  block_transactions: { block: "latest", limit: 3 },
  verified_contracts: { limit: 3 },
  x402_build_payment_requirements: { payTo: WHALE, amount: "0.01", asset: "USDG" },
  x402_build_payment_payload: {
    from: DEAD, to: WHALE, value: "10000", validAfter: "0",
    validBefore: "99999999999", nonce: "0x" + "66".repeat(32), signature: "0x" + "11".repeat(65),
  },
  x402_check_facilitator: {},
  verify_stock_token: { token: AAPL },
  stock_token_info: { token: AAPL },
  stock_balance: { token: AAPL, address: DEAD },
  check_corporate_action: { token: AAPL },
  check_address_blocked: { address: DEAD },
  stock_token_registry: {},
  list_stock_tokens: { query: "AAPL", limit: 5 },
  stock_token_terms: { token: AAPL },
  uniswap_contracts: {},
  uniswap_pool_id: { currency0: WHALE, currency1: USDG },
  uniswap_pool_state: { currency0: WHALE, currency1: USDG, fee: 3000, tickSpacing: 60, decimals0: 18, decimals1: 6 },
  uniswap_pool_liquidity: { poolId: "0x77c25b9386d47de62e0155c393696e9f43f7e6d036c6ca52f66735ccbb8808a7" },
  uniswap_fee_growth: { poolId: "0x77c25b9386d47de62e0155c393696e9f43f7e6d036c6ca52f66735ccbb8808a7" },
  uniswap_find_pool: { currency0: USDG, currency1: WHALE },
  x402_decode_payment_header: {
    header: Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:4663" })).toString("base64"),
  },
};

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();

const pass = [], fail = [], expected = [];
for (const t of tools) {
  const raw = ARGS[t.name] ?? {};
  const { expectError, ...args } = raw;
  try {
    const res = await client.callTool({ name: t.name, arguments: args });
    const text = (res.content?.[0]?.text ?? "").slice(0, 100).replace(/\s+/g, " ");
    if (res.isError) {
      (expectError ? expected : fail).push([t.name, text]);
    } else {
      pass.push([t.name, text]);
    }
  } catch (e) {
    (expectError ? expected : fail).push([t.name, String(e.message).slice(0, 100)]);
  }
}

console.log(`\n${"=".repeat(78)}`);
console.log(`PASS ${pass.length}  |  EXPECTED-ERROR ${expected.length}  |  FAIL ${fail.length}  |  TOTAL ${tools.length}`);
console.log("=".repeat(78));
if (fail.length) {
  console.log("\nFAILURES:");
  for (const [n, e] of fail) console.log(`  ✖ ${n.padEnd(38)} ${e}`);
} else {
  console.log("\nNo unexpected failures.");
}
console.log("\nSample output:");
for (const [n, t] of pass.slice(0, 6)) console.log(`  ✔ ${n.padEnd(34)} ${t.slice(0, 62)}`);
await transport.close();
process.exit(fail.length ? 1 : 0);
