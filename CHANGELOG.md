# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Not yet published to npm.

## [0.1.0] — 2026-07-19

Initial build. 105 tools against Robinhood Chain (Arbitrum Orbit L2, chain ID 4663). Read-and-build only: no keys, no signing, no broadcasting.

### Added

- **Chain, account, contract, transaction** (16 tools) — JSON-RPC reads plus unsigned transaction builders.
- **Arbitrum Orbit** (12) — ArbSys / ArbGasInfo precompiles, L1 cost components, unsigned L2→L1 withdrawal, and `block_number_context`.
- **ERC-20 / NFT** (14) — metadata, allowances, Multicall3 batch balances, ERC-721/1155, standard detection.
- **Robinhood Stock Tokens** (8) — impostor detection, corporate-action multiplier, transfer blocklist, on-chain terms.
- **EIP-3009 / EIP-2612** (12) — capability probing, authorization build/verify/cancel, permit, domain verification.
- **Uniswap v4** (6) — pool ID derivation, slot0, liquidity, fee growth, fee-tier sweep.
- **Price oracles** (6) — registry lookup, stock prices by ticker, freshness assessment.
- **Explorer** (11) and **offline utilities** (11).

### Verified against live mainnet, not assumed

Every address and chain ID was confirmed on-chain rather than taken from documentation. Several documented or inferred facts turned out wrong:

- **USDG is an EIP-2535 Diamond.** Scanning the proxy bytecode for EIP-3009 selectors returns a confident false negative, because facet code lives in separate contracts. `probe_token_capabilities` discriminates on revert data instead, learning the chain's unknown-function error empirically rather than assuming it.
- **USDG's EIP-712 domain was derived, not read.** The contract exposes no `version()`, so the domain was recovered by matching the on-chain `DOMAIN_SEPARATOR`.
- **The testnet explorer exists** at `explorer.testnet.chain.robinhood.com`, undocumented — found in the docs-site JS bundle. An earlier guessed Blockscout hostname 404s, which proves nothing.
- **The Uniswap v4 Quoter has no code** despite carrying a Blockscout tag, so no quoting tools ship.
- **Stylus is unsupported** — ArbWasm reverts. No Stylus tools ship.
- **The stock-token registry is `AccessControlsRegistry`**, resolved via a token's own `ACCESS_CONTROLLED_REGISTRY()`. It gates transfers and doubles as the beacon, but does not enumerate tokens.

### Known behaviours that look like bugs

- `eth_blockNumber` (~13.1M) and the `block.number` a contract observes (~25.5M) differ — contracts see the L1 height. See `block_number_context`.
- Equity price feeds stop updating when markets close; a multi-day age outside trading hours is correct, not stale data.
- `sequencerUptimeFeed` is unset on the price registry, so no read is protected against post-downtime staleness.

### Infrastructure

- Two-tier CI: hermetic checks gate every push; live-chain suites run as a daily canary, where a failure means the chain changed rather than the code.
- `test/smoke-all.mjs` exercises all 105 tools against mainnet.
- RPC client retries 429/5xx with backoff and distinguishes `TransportError` from `RpcError`, so a rate-limit is never reported as a fact about a contract.

[unreleased]: https://github.com/ExpertVagabond/robinhood-chain-mcp/compare/main...HEAD
[0.1.0]: https://github.com/ExpertVagabond/robinhood-chain-mcp/releases/tag/v0.1.0
