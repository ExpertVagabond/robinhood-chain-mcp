# robinhood-chain-mcp

[![CI](https://github.com/ExpertVagabond/robinhood-chain-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ExpertVagabond/robinhood-chain-mcp/actions/workflows/ci.yml)
[![Live chain canary](https://github.com/ExpertVagabond/robinhood-chain-mcp/actions/workflows/live.yml/badge.svg)](https://github.com/ExpertVagabond/robinhood-chain-mcp/actions/workflows/live.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server for **Robinhood Chain** — an Arbitrum Orbit L2 settling on Ethereum, fully EVM-compatible, gas paid in ETH.

**105 tools**: JSON-RPC reads, Arbitrum Orbit precompiles, explorer-indexed discovery, ERC-20/721/1155, Robinhood Stock Tokens, Uniswap v4, Chainlink price oracles, EIP-3009/EIP-2612 tooling, x402 payment helpers, offline encoding utilities, and unsigned transaction builders.

**Read and build only.** This server never holds keys, never signs, and never broadcasts. Transaction and authorization tools return unsigned payloads for external signing.

## Networks

| Network | Chain ID | RPC | Explorer |
| --- | --- | --- | --- |
| Robinhood Chain | `4663` | `https://rpc.mainnet.chain.robinhood.com/` | robinhoodchain.blockscout.com |
| Testnet | `46630` | `https://rpc.testnet.chain.robinhood.com/` | explorer.testnet.chain.robinhood.com |

Both chain IDs were confirmed via `eth_chainId` against the live RPCs, not taken from docs. The testnet explorer is not in the documentation — it was found in the docs-site JS bundle and verified live. (An earlier guess at `robinhoodchain-testnet.blockscout.com` 404s, which is a good reminder that a guessed hostname returning 404 proves nothing about whether a service exists.)

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

**Chain (4)** — `chain_info`, `get_block`, `gas_price`, `estimate_gas`
**Arbitrum Orbit (12)** — `arb_block_number`, `block_number_context`, `arb_chain_id`, `arbos_version`, `arb_gas_prices`, `arb_l1_base_fee`, `arb_min_gas_price`, `arb_gas_accounting`, `arb_l1_pricing`, `estimate_l1_component`, `precompile_status`, `build_l2_to_l1_withdrawal`
**Account (5)** — `get_balance`, `get_nonce`, `is_contract`, `get_token_balance`, `list_token_holdings`
**Contract (3)** — `read_contract`, `raw_call`, `build_transaction`
**Transaction (4)** — `get_transaction`, `get_receipt`, `address_transactions`, `get_logs`
**ERC-20 (7)** — `token_metadata`, `token_allowance`, `multi_token_balance` (Multicall3), `build_token_transfer`, `build_token_approve`, `decode_transfer_log`, `token_transfer_history`
**NFT (7)** — `nft_owner`, `nft_token_uri`, `nft_balance`, `nft_collection_info`, `erc1155_balance`, `detect_token_standard`, `address_nfts`
**Token discovery (4)** — `list_tokens`, `token_info`, `known_assets`, `chain_stats`
**Explorer (11)** — `address_info`, `address_token_transfers`, `address_internal_transactions`, `contract_source`, `contract_abi`, `explorer_search`, `token_holders`, `token_transfers`, `latest_blocks`, `block_transactions`, `verified_contracts`
**EIP-3009 / EIP-2612 (12)** — `probe_token_capabilities`, `usdg_info`, `check_authorization`, `build_transfer_authorization`, `verify_authorization_signature`, `build_receive_authorization`, `build_cancel_authorization`, `build_permit`, `build_transfer_authorization_calldata`, `list_eip3009_assets`, `authorization_digest`, `verify_domain_separator`
**x402 (5)** — `x402_network_id`, `x402_build_payment_requirements`, `x402_build_payment_payload`, `x402_check_facilitator`, `x402_decode_payment_header`
**Robinhood Stock Tokens (8)** — `verify_stock_token`, `stock_token_info`, `stock_balance`, `check_corporate_action`, `check_address_blocked`, `stock_token_registry`, `list_stock_tokens`, `stock_token_terms`
**Uniswap v4 (6)** — `uniswap_contracts`, `uniswap_pool_id`, `uniswap_pool_state`, `uniswap_pool_liquidity`, `uniswap_fee_growth`, `uniswap_find_pool`
**Price oracles (6)** — `price_feed_registry`, `get_token_price`, `get_stock_price`, `read_price_feed`, `list_price_feeds`, `check_price_freshness`
**Offline utilities (11)** — `keccak_hash`, `function_selector`, `event_topic`, `checksum_address`, `encode_abi`, `decode_abi`, `decode_calldata`, `to_wei`, `from_wei`, `hex_convert`, `random_nonce`

### Orbit specifics worth knowing

`block_number_context` exists because of a real trap: **`eth_blockNumber` and the `block.number` a contract observes are different numbers on this chain** (~13.1M vs ~25.5M at time of writing). A contract reading `block.number` sees the L1 height, advancing at L1 pace. Deadlines computed from it move ~6x slower than you would expect from L2 block times.

`precompile_status` probes each Arbitrum precompile with a real call rather than trusting that a canonical address implies a working precompile. On this chain ArbSys and ArbGasInfo respond; **ArbOwnerPublic and ArbWasm revert, so there is no Stylus support here.** Tools for those are deliberately absent rather than shipped broken.

### Stock Tokens: two traps

**Corporate actions move the multiplier, not balances.** Dividends and splits are applied through an on-chain `uiMultiplier` (ERC-8056) that changes the shares-per-token ratio while raw balances stay fixed. Reading `balanceOf` and presenting it as a share count is wrong after any corporate action — `stock_balance` returns both, and says which to display.

**Ticker squatting is rampant, and there is no registry to check against.** The explorer lists several contracts per ticker; Robinhood's docs warn that a matching ticker proves nothing but publish no canonical list. `uiMultiplier()` turns out to be a reliable discriminator — the genuine tokens implement it, the copies do not. `verify_stock_token("TSLA")` returns the real `Tesla • Robinhood Token` and separately lists the "TSLA CAT" impostors.

The `AccessControlsRegistry` (`0xe10b6f6B...151b00`) was found by calling a token's own `ACCESS_CONTROLLED_REGISTRY()`, not from docs. It gates transfers via `isBlocked(address)` and doubles as the EIP-1967 beacon behind every Stock Token proxy — so it does *not* enumerate them.

### Price oracles: three systems, easily confused

**`PriceFeedRegistry`** (`0x4C5CE5…f846f`) maps a token address to a Chainlink feed — WETH resolves to `ETH / USD`. It does **not** cover Stock Tokens: `getTokenPrice` on one reverts `PriceFeedNotFound()`.

**Stock prices are standalone aggregators**, discoverable only by their `description()` string, in two conventions — `Robinhood AAPL / USD` *and* `RHTSLA / USD`. Nothing on-chain links a Stock Token to its feed, so the mapping is by ticker, not address. Several proxies front the same underlying aggregator, so `get_stock_price` dedupes on `aggregator()`.

**`PriceFeed`** (`0x4EE2F9…`) is a red herring: it has `endpoint`/`eid`/`estimateFee`, making it a **LayerZero messaging-fee oracle**, unrelated to asset prices.

Two safety findings, both surfaced by the tools:

- **Equity feeds go stale by design.** AAPL was last updated Friday 19:47 UTC and read 1.6 days old on a Sunday. That is correct — markets were closed — but it breaks both naive approaches: a crypto-style staleness threshold rejects every stock price outside trading hours, while an integration that ignores age serves a Friday close as a live quote. `check_price_freshness` classifies the feed as equity and judges accordingly.
- **`sequencerUptimeFeed` is unset (`0x0`).** The registry supports Chainlink's L2 sequencer-uptime gating but has none configured, so no read is protected against post-downtime staleness. Reported by `price_feed_registry`.

### Uniswap v4

Verified on-chain, not from tags: StateView's own `poolManager()` returns the recorded PoolManager, which is self-confirming. **The Quoter that Blockscout tags has no code**, so quoting tools are deliberately omitted rather than shipped broken.

`uniswap_find_pool` sweeps the standard fee tiers, since v4 pools are not enumerable. WETH/USDG is live on all four; the derived price checks out against the explorer's spot ETH price to within 0.4%.

`chain_info` reports `chainIdMatchesConfig` — if an `ROBINHOOD_RPC_URL` override points at a different chain, you find out immediately instead of operating against the wrong network.

## Development

```bash
npm install
npm run build
npm run quality   # typecheck + live tests
```

### CI split

Two workflows, deliberately separated:

- **`ci.yml`** gates every push — typecheck, build, dist shape, and an MCP handshake asserting the tool set is well-formed (count, unique names, description quality). Fully hermetic; no chain access.
- **`live.yml`** runs daily on a schedule. These assert real on-chain state, so a failure means *the chain moved*, not the code — a USDG upgrade changing `DOMAIN_SEPARATOR`, the EIP-3009 probe going dark, a feed disappearing. Running them per-push would just produce red builds from RPC rate limits and weekend-stale equity feeds.

Tests run against **live mainnet** — no mocks. They assert that the chain IDs still match, that USDG's `DOMAIN_SEPARATOR` hasn't drifted, that the capability probe still finds EIP-3009, and that a bytecode scan still wouldn't. A separate suite drives the server over a real MCP stdio handshake.

The Blockscout client retries 5xx with backoff (public explorer, rate-limited under bursts) and never retries 4xx.

## Status

v0.1.0. Not published. Read-and-build only; no keys, no signing, no broadcasting.

`test/smoke-all.mjs` calls **every registered tool** against live mainnet and fails the run on any unexpected error — a tool count means nothing if the tools do not work. Current: 102 pass, 3 expected-error (NFT calls against a non-NFT contract), 0 fail.

The RPC client retries 429/5xx with backoff and distinguishes `TransportError` from `RpcError`. That distinction is load-bearing: capability probes read *reverts* as evidence, so a swallowed rate-limit would be reported as "this selector is absent" or "this is not a stock token" — an outage turned into a false claim about a contract.
