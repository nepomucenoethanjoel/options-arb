# options-arb — multi-venue options arbitrage monitor

Read-only, real-time dashboard that prices the same option across ten venues
and surfaces the gaps worth a manual trade: buy where it's cheap (usually
Olive's AMM), sell where you can short it. **It never places orders.** Every
number it shows is checked against venue reality — the verification rules
are in [AGENTS.md](./AGENTS.md), the evidence in [DATA_SOURCES.md](./DATA_SOURCES.md).

> Live at http://192.236.184.31:8799 — auto-deploys from `main` via CI + the box cron.

## Documentation map

| Doc | For |
|---|---|
| [docs/FINDINGS.md](./docs/FINDINGS.md) | What the research established, how to read the alerts, open items |
| [docs/VENUES.md](./docs/VENUES.md) | Per-venue reference: endpoints, units, fees, settlement, gaps |
| [DATA_SOURCES.md](./DATA_SOURCES.md) | The evidence matrix — every venue assumption, its status and proof |
| [AGENTS.md](./AGENTS.md) | Rules for changing the code (tests, rows, honesty) and architecture pointers |
| [deploy/README.md](./deploy/README.md) | The VPS: install, cron deploys, firewall, operations |
| [docs/live-fill-checklist.md](./docs/live-fill-checklist.md) | How a real fill lifts `single_maker` / `indicative_quote` |

## Venues

| Venue | Kind | What the app reads | In headline totals |
|---|---|---|---|
| **Derive** | order book | BTC ETH SOL ZEC HYPE XRP ADA PUMP VVV ANT NVDA XAUT | ✓ |
| **Olive** (Solana) | AMM, one model vol | crypto, xStock wrappers (SPYX …), PAXG | ✓ (buy side only) |
| **Coincall** | order book | BTC ETH SOL SPY QQQ HYPE XRP XAUT DOGE AAVE WLFI BNB TRUMP | ✓ |
| **Hypercall** (HyperEVM) | RFQ market makers | BTC ETH AAPL META MSFT MU NVDA SPCX ANT | ✗ `single_maker` → maker-quote alerts |
| **Callput** (Base) | vault, keeper-filled, **spreads only** | BTC ETH + synthetic stocks | ✗ `spread_only` |
| **Deribit** | order book | BTC ETH SOL | ✓ |
| **OKX** | order book | BTC ETH (coin), SOL HYPE gold (USD-margined) | ✓ |
| **Gate** | order book | BTC ETH SOL (+ alts) | ✓ |
| **Paradex** | order book | BTC ETH SOL HYPE ZEC NEAR · META NVDA SPCX MU MSTR gold (16:00 UTC) | ✓ |
| **Aevo** | order book | BTC ETH SOL HYPE | ✓ |
| Bybit, Binance | — | deferred: geo-block the US host | — |

Enable venues with `VENUES`; choose underlyings with `UNDERLYINGS`. Details per
venue: [docs/VENUES.md](./docs/VENUES.md).

## How it works

```
every ~30 s, per underlying:
  adapters (Derive anchor chain + listed venues + Olive synthesizer)
    → matching (same underlying, expiry ±1 day, strike; Olive quoted on demand)
    → signals (every vol-consistent venue pair per contract; best pair + alternatives)
    → flags (book quality, cutoffs, venue caveats, market hours, wrappers)
    → SQLite (change-gated) + WebSocket + alerts
  side jobs: Olive pool watcher (capacity per market), Callput fill recorder
```

- **Pairs:** for each contract the engine tries every ordered venue pair whose
  IVs point the right way (sell IV ≥ buy IV), plus single-maker quotes whose
  prices cross another book (`iv_inverted`). It keeps the best by: shortable
  sell venue → clean book → honest total.
- **Olive** is synthesized with Olive's own pricing (model vol × the
  demand-surface markup at that point, per-custody rate curve + fixed-rate
  premium) at whatever strike the row needs, within its ±1σ band. Wrapper rows (SPY → SPYX) quote Olive at K × (token/ETF spot)
  and price per share.

## Profit estimate — methodology

```
entry   = cheap leg's take price       (Olive premium, or the book's ask)
exit    = rich leg's executable price  (the book's bid — never mid)
net     = exit − entry − fees            (per-venue models in signals/fees.ts)
profit  = net − capital cost             (full collateral × borrow APR × tenor; conservative)
total   = profit × size − per-order fees (size = binding book touch, capped by Olive's pool capacity)
honest  = min(quoted total, fill-model total)   (Olive's rate and demand-surface markup move with order size)
```

Both legs are European options on the same underlying and expiry, so held to
expiry their payoffs converge and the price gap locks in. What does **not**
lock in, and how the app treats it:

- **Settlement basis:** venues settle on different prices (30-min TWAPs, single
  prints, futures VWAPs). Each signal carries a ~1σ estimate from both venues'
  settlement windows — a risk figure, not subtracted.
- **Wrapper basis:** an xStock is not the stock (SPYX ≈ 1.0069 × SPY, noise
  30–65 bps, more over weekends) → `wrapper_basis`, headline-blocking.
- **Short-leg margin:** the short venue can liquidate before expiry while the
  Olive long stays open. Watch its margin.
- **Direction:** you can only buy on Olive; selling there is the LPs' role →
  `direction_limited`.

The KPI headline sums only clean rows at the honest clip size.

## Flags

**Non-executable** (row isn't tradable as shown; never an opportunity):
`no_book`, `one_sided`, `thin_book`, `wide_book`, `stale`, `mismatched_legs`,
`trading_cutoff` (venue halt or Olive's 24 h rule), `spread_only` (Callput).

**Headline-blocking** (shown, excluded from totals and normal alerts): the
above plus `price_distortion`, `fill_model_skipped`, `single_maker`,
`indicative_quote`, `reference_venue`, `size_unknown` (venue publishes no
size), `market_closed` (stock outside the NYSE session), `wrapper_basis`,
`demand_surface_unknown` (Olive's demand surface could not be read).

**Informational:** `amm_pool_depth_unknown`, `pool_capacity_capped`,
`pool_capacity_estimated`, `execution_moves_rate`, `direction_limited`,
`near_expiry`, `settlement_asset_mismatch`, `iv_inverted`,
`iv_mark_inconsistent`, `smile_outlier`, `calendar_inversion`,
`hedge_size_unverified`.

## Alerts

Transport: Discord webhook (`DISCORD_WEBHOOK_URL`), else Telegram, else a
generic webhook. `ALERTS_ENABLED=true` turns them on;
`npm run alert:test -w server` proves delivery.

| Lane | Fires when | Settings |
|---|---|---|
| **Opportunities** | a clean, executable pair's honest total clears the threshold; one digest per cycle, best first | `ALERT_MIN_TOTAL_USDC`, `ALERT_COOLDOWN_MS` |
| **Maker quotes** | a single-maker RFQ quote (Hypercall) crosses a clean book after fees — shows the maker's size, the venue's model price, an estimated margin | `MAKER_ALERTS`, `MAKER_ALERT_MIN_NET_USDC` (5), `MAKER_ALERT_MIN_TOTAL_USDC` (10), `MAKER_ALERT_MIN_THEO_MULTIPLE` (0 = off), `MAKER_ALERT_COOLDOWN_MS` |
| **Olive pools** | a hedgeable Olive market the app doesn't track gets free capacity | `OLIVE_POOL_WATCH`, `OLIVE_POOL_ALERT_USD` |

## Dashboard and API

| Tab | Answers |
|---|---|
| Profit | Best venue pair per contract, honest clip totals |
| Best venue | Cheapest place to buy / richest to sell each contract after fees |
| Vol by venue | Each venue's IV vs the cross-venue median; smile and calendar flags |
| Parity | Conversions / reversals hedged with Deribit futures (informational) |
| Analysis | Smile and term structure |
| Gaps | How often and how long gaps actually lasted (episodes) |

REST: `/api/overview`, `/api/opportunities`, `/api/pair?pairKey=…`,
`/api/history`, `/api/surface`, `/api/parity`, `/api/episodes/summary`,
`/api/olive-pools`, `/api/callput-fills`, `/api/health`. WebSocket pushes each cycle.

## Verification

```bash
npm test                               # shared + server suites (golden replay included)
npx tsc -b shared server web           # typecheck
npm run handcheck -w server            # LIVE: one Olive pair vs raw venue data, independent math
npm run handcheck:books -w server      # LIVE: one book-venue pair (PAIR_KEY=… optional)
npm run callput:fills -w server        # LIVE: recent Callput requests/fills on Base
npm run callput:settlements -w server  # LIVE: Callput settlement prices vs Deribit delivery
```

The box re-runs both handchecks daily (`deploy/options-arb-handcheck.sh`).

## Configuration

All settings are environment variables — the full list with comments is in
[.env.example](./.env.example). The ones you'll touch:

| Var | Meaning |
|---|---|
| `UNDERLYINGS` | Which underlyings to price (the box reads its own `server/.env`) |
| `VENUES` | Extra venues to read (default: all ten) |
| `REFERENCE_VENUES` | Venues shown for reference only (never headline) |
| `OLIVE_SYMBOL_MAP` / `STOCK_UNDERLYINGS` | Wrapper mappings (SPY → SPYX …) and NYSE-hours underlyings |
| `IV_SPREAD_THRESHOLD_VOLS` | Opportunity threshold in vol points (3) |
| `OLIVE_FEE_NOTIONAL_BPS` / `OLIVE_FEE_PREMIUM_PCT` / `OLIVE_RATE_CURVE_SHAPE` | Olive fee and rate-curve config (5 bp, 10%, quadratic) |
| `CAPITAL_BORROW_RATE_APR` | Capital charge on collateral (8%) |
| `CALLPUT_EXECUTION_FEE_ETH` / `CALLPUT_RECORDER` / `CALLPUT_RPC_URL` | Callput keeper fee, fill recorder, Base RPC |
| `ALERTS_ENABLED`, `DISCORD_WEBHOOK_URL`, `ALERT_*`, `MAKER_ALERT_*` | Alerts (above) |

## Operations

- **Deploy:** merge to `main` → CI tests and publishes the `deploy` branch with
  the built dashboard → the box pulls it within a minute, runs
  `npm ci --omit=dev` and restarts. The box never compiles.
- **Config on the box:** `/opt/options-arb/server/.env`, then
  `systemctl restart options-arb`. `UNDERLYINGS` there overrides
  `.env.example` — new underlyings need adding on the box.
- **Data:** SQLite at `DATA_DIR/options-arb.db`; Callput fill records at
  `DATA_DIR/callput-fills.jsonl`.
- **Health:** `/api/health` (per-venue status, warnings). The dashboard is
  unauthenticated — firewall guidance in deploy/README.md.

## Local development

```bash
npm install
cp .env.example .env
npm run dev:server     # API + scheduler on http://127.0.0.1:8799
npm run dev:web        # dashboard on http://127.0.0.1:5173 (proxies /api)
```

## Caveats

1. **Signals only** — no execution logic exists in this codebase, by design.
2. **Olive "IV" is a model vol** (EWMA realized) times its demand-surface
   markup at that strike/expiry (0 where nobody has bought); spreads shown are
   market IV minus that, labelled as such.
3. **Not risk-equivalent venues:** Olive is fully collateralized and settles on
   a single oracle print by its keeper; most others are margin venues settling
   on averages. Capital and settlement differences are priced or flagged, not ignored.
4. **Unproven venues stay out of totals** until real fills prove their quotes
   (`single_maker`, `indicative_quote`, `spread_only`, `size_unknown`).
5. **Freshness:** stale feeds are flagged and drop out of totals.
