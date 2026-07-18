# robinhood-chain-mcp

MCP server for **Robinhood Chain** — an Arbitrum Orbit L2 settling on Ethereum, fully EVM-compatible, gas paid in ETH.

**24 tools**: JSON-RPC reads, explorer-indexed token discovery, EIP-3009/USDG tooling, and unsigned transaction builders.

**Read and build only.** This server never holds keys, never signs, and never broadcasts. Transaction and authorization tools return unsigned payloads for external signing.

## Networks

| Network | Chain ID | RPC | Explorer |
| --- | --- | --- | --- |
| Robinhood Chain | `4663` | `https://rpc.mainnet.chain.robinhood.com/` | robinhoodchain.blockscout.com |
| Testnet | `46630` | `https://rpc.testnet.chain.robinhood.com/` | none published |

Both chain IDs were confirmed via `eth_chainId` against the live RPCs, not taken from docs. Testnet has no published Blockscout instance (`robinhoodchain-testnet.blockscout.com` 404s), so explorer-backed tools fail there with a clear message rather than an obscure network error.

```bash
ROBINHOOD_NETWORK=mainnet|testnet    # default mainnet
ROBINHOOD_RPC_URL=https://...        # override, e.g. a private node
```

## Install

```bash
npm install -g @purplesquirrel/robinhood-chain-mcp
```

```json
{
  "mcpServers": {
    "robinhood-chain": {
      "command": "robinhood-chain-mcp",
      "env": { "ROBINHOOD_NETWORK": "mainnet" }
    }
  }
}
```

## The interesting part: detecting EIP-3009 on a Diamond

USDG is the chain's native stablecoin and matters more than a typical ERC-20, because **Robinhood Chain has no canonical USDC** — USDC bridged in from any of the 13 supported source chains arrives as USDG. So whether USDG supports EIP-3009 `transferWithAuthorization` decides whether gasless, third-party-submitted payments (x402's `exact` scheme, among others) are possible on this chain at all.

Answering that is harder than it looks. **USDG is an EIP-2535 Diamond**: its functions live in facet contracts the proxy delegates to, so scanning the proxy's bytecode for selectors reports *nothing found* — a confident false negative. There's a test in this repo that asserts exactly that failure mode, so the reasoning doesn't get lost.

`probe_token_capabilities` uses the reliable signal instead — **the revert**:

1. Call two selectors that cannot exist (`0xdeadbeef`, `0xbaadf00d`) to learn the chain's unknown-function error empirically, rather than assuming it.
2. Call each real selector with deliberately invalid arguments.
3. Reverting with the unknown-function error → **absent**. Reverting with anything else → **present**, and validating its inputs.

For USDG:

| Call | Revert | Verdict |
| --- | --- | --- |
| `transferWithAuthorization` | `0x0f05f5bf` `AuthorizationExpired()` | present |
| `receiveWithAuthorization` | `0x5454b17d` `CallerMustBePayee()` | present |
| `cancelAuthorization` | `0x8baa579f` `InvalidSignature()` | present |
| `permit` | `0x1a15a3cc` `PermitExpired()` | present (EIP-2612) |
| *controls* | `0x800ab12c` `FacetNotFound()` | — |

### The EIP-712 domain

USDG doesn't expose `version()`, so its domain was **derived by matching the on-chain `DOMAIN_SEPARATOR`** rather than guessed:

```
name="Global Dollar", version="1", chainId=4663,
verifyingContract=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
  → 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036   ✓ exact match
```

`usdg_info` re-checks this against the live contract on every call. A Diamond upgrade that changed the domain would otherwise silently invalidate every signature built from it.

## Tools

**Chain** — `chain_info`, `get_block`, `gas_price`, `estimate_gas`
**Account** — `get_balance`, `get_nonce`, `is_contract`, `get_token_balance`, `list_token_holdings`
**Contract** — `read_contract` (human-readable signatures), `raw_call` (reports revert selectors), `build_transaction`
**Transaction** — `get_transaction`, `get_receipt`, `address_transactions`, `get_logs`
**Token** — `list_tokens`, `token_info`, `known_assets`, `chain_stats`
**USDG / EIP-3009** — `probe_token_capabilities`, `usdg_info`, `check_authorization`, `build_transfer_authorization`

`chain_info` reports `chainIdMatchesConfig` — if an `ROBINHOOD_RPC_URL` override points at a different chain, you find out immediately instead of operating against the wrong network.

## Development

```bash
npm install
npm run build
npm run quality   # typecheck + live tests
```

Tests run against **live mainnet** — no mocks. They assert that the chain IDs still match, that USDG's `DOMAIN_SEPARATOR` hasn't drifted, that the capability probe still finds EIP-3009, and that a bytecode scan still wouldn't. A separate suite drives the server over a real MCP stdio handshake.

The Blockscout client retries 5xx with backoff (public explorer, rate-limited under bursts) and never retries 4xx.

## Status

v0.1.0. Not published. Verify-and-build only; no keys, no signing, no broadcasting.
