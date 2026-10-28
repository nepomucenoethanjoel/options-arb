# options-arb — Options IV Arbitrage Monitor

Read-only, real-time analytics dashboard comparing options implied volatility
across venues, surfacing relative IV mispricings for **manual review**. This is
a signal tool — it does not route or execute orders.

| Venue | Kind | Underlyings | How quotes are read | Headline-eligible |
|---|---|---|---|---|
| **Derive.xyz** (EVM) | order book | SOL BTC ETH ZEC | v3 REST (+ legacy-host book merge) | ✓ |
| **Olive Exchange** (Solana) | AMM, model vol | SOL BTC ETH ZEC | market file + our own BS synthesis | ✓ (buy side only) |
| **Coincall** | order book | SOL BTC ETH | public REST, whole chain per call | ✓ |
| **Hypercall** (HyperEVM) | RFQ makers | BTC ETH | `options-summary` RFQ provider quotes | ✗ `single_maker` |
| **Callput** (Base) | vault, keeper-filled | BTC ETH | app S3 feed, mark ± risk premium | ✗ `indicative_quote` |
| Bybit, Binance | order book | — | deferred: they geo-block the US host | — |

Every contract (same underlying, 08:00 UTC expiry, strike, kind) is compared
across all venues that list it; the row shows the best **vol-consistent pair**
(buy the lower-IV venue at its ask, sell the higher-IV venue at its bid), with
runner-up pairs in the detail panel. Enable venues with `VENUES`.

Data-source provenance and discovery history: [DATA_SOURCES.md](./DATA_SOURCES.md).

## What it shows

- **Overview table**: per (underlying, expiry, strike, kind) — Derive
  market-implied IV vs Olive model vol, spread in vol points/bps, liquidity
  flags, match type, freshness.
- **IV smile chart — the crossover view**: Derive's quote smile vs Olive's flat
  model vol, with green dots marking strikes where Derive IV > Olive (the
  two-leg-executable side), shaded bands for the profitable strikes that fall
  inside Olive's ±1σ quotable range, and an ATM term-structure strip showing
  which expiry is closest to flipping the whole surface.
- **Opportunity feed**: threshold-crossing mispricings ranked by
  liquidity/cost-adjusted score, with theoretical edge in USDC. A
  `price_distortion` guard flags rows whose quoted edge is mostly book-vs-mark
  dislocation rather than vol mispricing; the Direction filter isolates the
  executable buy-Olive/sell-Derive rows.
- **Spread history**: per-contract time series (persisted in SQLite).
- **Health badges + caveat banner**: per-venue data freshness, and the
  risk-equivalence warnings the brief requires (collateralized AMM vs margin
  venue, Stork oracle vs 30-min TWAP settlement, model vol vs market IV).

## Stack

- **shared**: framework-free TypeScript types + Black-Scholes and SVI math.
- **server**: Node 22+ / Fastify; venue adapters (`OptionsVenueAdapter`),
  matching + signal engines, SQLite persistence (`node:sqlite`), REST + WS API,
  polling scheduler, optional webhook alerts.
- **web**: React + Vite + Recharts + TanStack Table.

## Quickstart

```bash
npm install
cp .env.example .env        # defaults work out of the box

npm run dev:server          # API + scheduler on http://127.0.0.1:8799
npm run dev:web             # dashboard on http://127.0.0.1:5173 (proxies /api)
```

The server also serves `web/dist` statically when present
(`npm run build -w web` then visit :8799 directly).

## Useful scripts

```bash
npm run verify:derive       # dump a live Derive option chain with IV/greeks/books
npm run probe:olive         # re-run Olive discovery (REST probes + on-chain reads);
                            # append findings to DATA_SOURCES.md
npm test                    # vitest across shared + server
```

## Configuration

All settings are environment variables — see [.env.example](./.env.example).
Key ones:

| Var | Default | Meaning |
|---|---|---|
| `UNDERLYINGS` | `SOL,BTC,ETH` | Normalized underlyings present on both venues (ZEC also overlaps) |
| `POLL_INTERVAL_MS` | `15000` | Scheduler cycle; effective rate is also capped by Derive limits |
| `DERIVE_BOOK_SOURCE` | `merge` | v3 books were observed zeroed; merge fills bid/ask/OI from legacy host |
| `OLIVE_MODE` | `auto` | `rest` \| `onchain` \| `auto` (REST first, on-chain fallback) |
| `OLIVE_REALTIME` | `1` | Subscribe to Olive's socket.io ticker stream (~1 s Stork spot; see DATA_SOURCES.md §2d-quat) |
| `OLIVE_REALTIME_SPOT_TRIGGER_PCT` | `1` | Re-price early when spot moves ≥ this % vs the last cycle (0 = off; 30 s cooldown) |
| `IV_SPREAD_THRESHOLD_VOLS` | `3` | Flag threshold in vol points |
| `ALERTS_ENABLED` / `ALERT_WEBHOOK_URL` | off | POST a JSON alert when a pair crosses threshold (per-pair cooldown) |

## Architecture

```
scheduler ──▶ adapters (DeriveAdapter | OliveAdapter)   [health-tracked]
        ──▶ matching engine  ──▶ signal engine ──▶ SQLite + WS broadcast + webhook
                                    │
                          Fastify REST (/api/*) ──▶ React dashboard
```

- `server/src/adapters/` — `OptionsVenueAdapter` implementations; nothing
  downstream touches venue-specific logic.
- `server/src/matching/` — pure functions; expiry bucketing (±tolerance),
  strike matching (exact → interpolated), AMM-continuum handling for Olive,
  match-type + reason flags.
- `server/src/signals/` — pure functions; IV spread, Black-Scholes synthetic
  cross-check, liquidity gating, round-trip cost + capital-efficiency
  adjustment, ranking, threshold flagging.
- `server/src/storage/` — `Storage` interface over `node:sqlite`
  (swappable for Postgres/Timescale later).

## Testing

```bash
npm test
```

Covers: BS pricing/IV inversion round-trips, SVI evaluation, Derive slim-ticker
mapping + instrument-name parsing (incl. fractional strikes), matching engine
cases (exact / interpolated / unmatched / out-of-bounds / tenor), and signal
engine gating/costs/direction logic.

## Profit estimates — methodology

Every signal carries a held-to-expiry profit estimate in USDC:

```
entry  = cheap leg's take price   (Olive AMM premium, or Derive ask)
exit   = rich leg's executable px (Derive BID when Derive vol is rich — not mid)
gross  = exit − entry
net    = gross − fees − gas                     (Derive taker bps, Olive min(2.5bps, 10% premium), Solana fee)
profit = net − collateral drag                  (Olive locks full collateral × borrow APR × tenor)
total  = profit × size cap                      (min of Derive bid/ask touch size; Olive AMM depth unknown)
```

Why held-to-expiry works: both legs are European options on the same
underlying and (within ±1 day tolerance) the same expiry, so their payoffs
converge and the price difference locks in. What it does **not** lock in:

- **Settlement basis** — Derive settles a 30-minute TWAP, Olive a Stork oracle
  print. Each signal carries a ~1σ divergence estimate
  (`|Δ|·S·σ·√(30min/1yr)`), shown as a risk, not subtracted.
- **Direction** — options are bought *from* the Olive pool; writing fresh
  shorts to it is an LP role. "Sell vol on Olive" directions are flagged
  `direction_limited`.
- **`syntheticCrossCheckUsdc`** — Derive mid minus the same leg repriced at
  Olive's vol. Should sit near vega × Δσ; large deviations hint at
  quote/settlement distortion rather than pure IV mispricing.

`npm run handcheck -w server` re-verifies one live Olive-pair signal against raw venue
APIs with independent math — every field must reproduce. The pair comes from
`handcheck-target.json` (pairKey only) when present, else the top executable
opportunity; all inputs are live (market-file vol/spot/custody, config rates),
never pinned snapshots.

`npm run handcheck:books -w server` does the same for book-vs-book pairs
(Derive / Coincall / Hypercall / Callput): raw REST quotes are compared with the
quotes the cycle used (drift reported), and every money field is recomputed
from them with independently written fee formulas (`PAIR_KEY=…` to pick one).

## Caveats encoded in the app

1. **Not risk-equivalent venues**: Olive is fully collateralized (calls backed
   by underlying, puts by USDC); Derive is margin-based. Capital efficiency,
   liquidation mechanics, and settlement (Stork oracle print vs 30-min TWAP)
   differ. Surfaced in the UI banner and as a capital-cost line on each signal.
2. **Olive "IV" is a model vol**: their AMM prices with an EWMA realized-vol
   oracle (per-asset, flat across strikes). The spread this dashboard shows is
   market-implied (Derive) minus model (Olive) vol — labeled as such.
3. **Directionality**: options are bought from the Olive pool (LPs are the
   sellers). "Sell vol on Olive" directions are flagged `direction_limited`.
4. **Data freshness**: on-chain/indexer data can lag; per-source freshness is
   tracked and stale feeds downgrade signals and show a warning badge.
5. **Settlement depends on Olive's keeper**: payoffs settle on a single oracle
   print submitted by their backend keeper — which has been observed inactive
   (2026-09-19+ redeploy). ITM positions may settle late if it stays down.
6. **Signal generation and manual review only** — no execution logic exists in
   this codebase by design.

> Live at http://192.236.184.31:8799 — auto-deploys from `main` via CI + the box cron.
