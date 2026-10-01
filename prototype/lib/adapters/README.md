# DeFi Protocol Adapters

This directory contains protocol-specific adapters that turn raw on-chain
positions into the unified DeFi-position shape consumed by `server.js`
and the frontend's DeFi tab.

## Two distinct decimal concepts

When working in this directory, keep these straight:

### 1. Asset decimals (per-token, comes from the token)

How many digits of precision a SEP-41 token uses to represent 1 unit of
itself on-chain. **A property of the token contract.** Examples:

| Token              | Decimals | Why |
|--------------------|----------|-----|
| XLM (native + SAC) | 7        | Stellar default |
| USDC, EURC, PYUSD  | 7        | Stellar Asset Contract convention |
| **SolvBTC**        | **8**    | Bitcoin convention (caused a real 10× bug in PR #4) |
| **xSolvBTC**       | **8**    | Same |
| Centrifuge tokens  | 18       | EVM-style |

Resolution path (already implemented by adapters):

1. Check `token-universe.js` for an explicit entry — these are canonical.
2. If not found, call `getTokenMetadata()` on the Soroban contract.
3. Fall back to 7 as a last resort and emit a warning.

**Never hardcode 7 in an adapter.** Every position must trace its decimals
back to the actual token, or you will silently misreport 8-decimal tokens
by 10× and 18-decimal tokens by 10^11.

### 2. Protocol-internal scalars (per-protocol, baked into the protocol)

Fixed-point math each DeFi protocol uses internally for things like
interest accrual, price-of-LP-share, and exchange rates between protocol
tokens (bTokens, dTokens, vault shares) and the underlying asset.

| Protocol      | Internal scalar  | Notes |
|---------------|------------------|-------|
| Blend V2      | 10^12            | `b_rate` and `d_rate` in `reserveData.data` |
| Aave-style    | 10^27 ("ray")    | Standard EVM lending-pool convention |
| SushiSwap V3  | 2^96 (Q96)       | `sqrtPriceX96` is sqrt(price)<<96 |
| Compound V2   | 10^18 (exchange rate) | |

These are **protocol invariants**, not configuration. They live as named
constants inside the adapter that knows the protocol. If a protocol ships
a new version with different math (e.g. Blend V3), the new version gets
its own adapter (or a versioned scalar inside the existing adapter),
**never** an environment variable — env vars on these are a footgun
because a typo silently corrupts every wallet's reported balance.

## Adapter contract

Every adapter exports an object with:

- `name: string` — display name shown in the UI
- `isConfigured(): boolean` — true if the adapter has any pools/contracts to query
- `getPositions(address): Promise<Position[]>` — returns the wallet's positions

Each `Position` object must include:

- `protocol`, `type`, `subtype` — taxonomy used by the frontend renderer
- `asset`, `decimals` — for display formatting
- `underlyingAmount: number` — the human-readable amount, already divided by 10^decimals
- `valueUSD: number` — already enriched with price; **negative for debt** so that
  summing positions gives the correct net-of-debt total
- `price: { usd, source } | null` — optional price metadata for display

Server.js sums `valueUSD` across all positions into `totalValueUSD` and
makes the array available as `defiPositions` in the API response.

## When adding a new adapter

1. **Find the protocol's actual internal scalar.** Look at the protocol's
   Rust source or a known-good integrator's code. Don't guess — the
   default value of "seems reasonable" will be wrong, sometimes by 1000×
   or more (this happened in PR #18 → PR #20).
2. **Make the protocol's pool/contract list explicit.** Either statically
   in the adapter or via a documented env var. Discovery via the protocol's
   factory contract is better long-term, but not required to ship.
3. **Resolve token decimals through the token universe**, not by
   hardcoding 7. See `blend.js`'s `_resolveAssetMetadata` helper for the
   pattern.
4. **Add a "future canary" warning** like the one in `blend.js` — log
   loudly when a non-zero protocol-token amount produces a zero underlying
   amount, since that's the failure mode that means the protocol changed
   shape or our scalar is wrong.
5. **Negate `valueUSD` for liability/borrow positions.** Net worth is
   supplied − borrowed, and the simplest way to make that come out right
   is for borrows to contribute negative dollars to the sum.
6. **Return `[]` only when the chain says there is nothing. THROW when you
   could not ask.** An RPC 429, a protocol API 5xx, or a ledger entry you
   cannot decode is not "no position" — `collectDefiPositions` in
   server.js turns a rejection into the last-known-good result (10 min) or
   a `defiDegraded` entry the UI shows. Catching those into `[]` or `"0"`
   caches a confidently wrong empty answer: this is how Sentora deposits
   vanished for three weeks after the stellar-sdk 17 bump, and how Soroswap
   and SushiSwap positions blinked in and out with the public RPC's rate
   limits. Use `getTokenBalanceStrict`, let `simulateContractCall` throw,
   and decode ledger entries with `contractDataScVal`. See
   `test/defi-adapters.test.js` for the contract.
