# Findings and playbook

What the research behind this app has established, in plain terms, plus how
to act on what the dashboard and alerts show. Measured facts cite their
DATA_SOURCES.md row; dates are UTC. Nothing here is trading advice — it is
what the data showed when it was checked.

## 1. Where the edge comes from

- **Olive is usually the cheap side.** Its AMM prices every strike at one
  model vol (an EWMA of realized vol), which has run well below market
  implied vol — e.g. BTC 45.5% vs ~61–62% on OKX/Coincall/Hypercall on
  2026-11-20; QQQ 31.5% vs ~52% (Callput) / ~57% (Coincall). The trade is:
  buy on Olive, sell the same option on a venue that lets you short.
- **Olive's capacity is the bottleneck, not the hedge venue.** A pool can
  only write its free collateral. On 2026-11-21 the largest was SOL calls
  ≈ $1,001; BTC calls $34; most xStock pools $0–$240. Per-contract edges can
  be large (BTC puts ~$150/contract vs OKX) while the honest clip total is
  a few dollars. The pool watcher alerts when capacity appears on a market
  you can hedge.
- **When Olive's pools are nearly full, Olive is expensive.** Its borrow
  rate climbs the quadratic curve toward 170% (tokens) / 160% (USDC), and
  that rate goes straight into the option price — on 2026-11-23 Olive priced
  an ETH Feb-27 3400 put at $3,147 (intrinsic ~$1,605) and a BTC Dec-25 71k
  call at $3,851 vs Hypercall's $954. Those rows only "profit" by selling to
  Olive (`direction_limited`); there is nothing to buy until pools free up.
- **A brokerage hedge doesn't help yet.** One US-listed option covers 100
  shares ($35k+ of TSLA, $62k of QQQ); Olive's whole TSLAX pool was ~4 shares
  of capacity. US options are also American-style and physically settled.
  Revisit if Olive's stock pools reach ~$50k.

## 2. Olive (Solana)

- **Rates changed 2026-11-17** (no announcement): β 2500 → 10000 and the
  borrow curve became quadratic above the 75% kink (rows 78–79). Big orders
  pay noticeably more than the quoted price — the app's fill model prices this.
- **Fee:** min(5 bp × qty × spot, 10% × premium) since 2026-10-21 (row 77).
  Visible in Olive's "Breakeven" column (breakeven − entry ≈ fee per contract).
- **Can't open inside 24 h of expiry** (row 81). The app flags those legs
  `trading_cutoff`.
- **Expiry can be any time 1 day–1 year out, including 17:00 UTC for stocks**
  (row 90) — so an Olive leg can expire with Callput's (17:00) or a US close
  (21:00 UTC in winter).
- **Wrapper tokens:** stock rows trade Olive's xStocks (SPYX, QQQX, TSLAX …).
  One token ≠ one share; see §6. The app now quotes Olive at K × (token/ETF
  spot) and prices per share (row 94).
- **Wallet:** opening an option creates new Solana accounts (~0.0015–0.003 SOL
  rent each). With too little SOL the transaction simulation fails — the
  console shows only a "Program data:" event line, not the reason.
  Keep ~0.02 SOL.
- **Settlement:** Olive's keeper settles in the expiry second; calls pay the
  token, puts USDC (row 15). (`VENUE_SPECS.olive.settlementAsset` still says
  USDC for calls — known, cosmetic for now.)

## 3. Hypercall (single market makers)

- **Mispricings happen and fill.** On 2026-11-20 the only BTC maker bid
  $195.03 for BTC-20261127-46000-P when Hypercall's own model said ~$48; a
  0.01 RFQ sale filled at the quote with zero fees; the maker withdrew the
  strike ~40 min later (row 82). One small fill is not size evidence, so
  `single_maker` stays headline-blocking.
- **Maker-quote alerts** catch these: a separate Discord message when a
  single-maker quote crosses a clean book after fees (≥ $5/contract, ≥ $10
  total by default), with the maker's size, Hypercall's model price and an
  estimated margin. Detection latency ≈ one cycle (~35 s) + up to one more.
- **IV direction blind spot (fixed, row 84):** a maker venue's IV is its
  oracle (Deribit's), not the maker's quote — the engine now also evaluates
  pairs whose *prices* cross (`iv_inverted`).
- **Margin & liquidation (row 83):** portfolio margin, MM = 0.85 × IM;
  IM = max(weighted 17-scenario loss, 1.5% × strike) (+1% × spot inside 48 h).
  Resting sell orders reserve far more than filled RFQ positions (~$11.5k vs
  ~$3.8k per BTC 46000-P contract). Spot input is Hyperliquid's `oraclePx`
  (every 2 s), vol is Deribit IV; liquidation checks every 5 s, buys shorts
  back at best ask + 0.5–10% bonus, full liquidation after 20 min.

## 4. Callput (Base)

- **Spreads only** (row 87): the product offers call/put spreads; single-leg
  feed quotes are not fills (`spread_only`). Every one of 71 requests in a
  week was a spread.
- **Mechanics (rows 85, 88):** a request fills in 2–13 s or is cancelled with
  a full refund; 0.00006 ETH keeper fee per request either way. $1k–5k
  requests were cancelled ~50% of the time (size limit). Sell (credit)
  spreads deposit width × size + a small fee and are paid the credit in the
  fill transaction.
- **Fees bite on cheap spreads:** the 12.5%-of-premium cap applies per leg,
  so a $0.80 spread paid ~$0.10 fee + ~$0.10 keeper fee (≈25%).
- **Settlement (row 89):** posts ~2.5 min after expiry, every day; crypto
  settles ~+6 bps above Deribit's delivery price, consistently.
- **Open question:** does a spread's price equal the sum of its legs' feed
  quotes (bought at mark·(1+rpBuy), sold at mark·(1−rpSell))? The in-server
  recorder (`/api/callput-fills`) captures the feed at each request to answer
  this; check its summary after a few weekdays.
- **The structure worth building if that holds:** buy an Olive call at A,
  sell a Callput call spread A/B — the A legs cancel, you keep a free long
  call at B and lock credit − Olive premium − fees − capital. Mainly useful
  for stocks, where Callput is the only hedge.

## 5. Other venues

- **Derive (row 95):** US500/US100 options settle on the 30-s VWAP of the
  assigned **future** at 16:00 ET, not the cash index; NVDA on a 2-min spot
  TWAP. Its RWA markets trade 23/5.
- **Aevo (row 91):** BTC/ETH/SOL/HYPE; one maker ~1.6 BTC a side near the
  money; settlement window undocumented.
- **OKX (row 92):** USD-margined SOL/HYPE/gold options alongside BTC/ETH.
  **Simple Options** lists 12 xStock options you can buy and sell — not yet
  integrated (empty on weekends; build from a weekday capture). If they are
  the same xStock tokens as Olive's, there is no wrapper gap.
- **Paradex:** "Margin Ratio" = maintenance margin ÷ equity; liquidation at
  100%, not when it gets low. Its stock/gold options expire **16:00 UTC** and
  settle on its own oracle TWAP (row 96); MSTR is the only hedge for Olive's MSTRX.
- **Expiry times differ by venue for stocks** (Paradex 16:00, Callput 17:00,
  Hypercall/Derive 21:00 UTC); rows are now split by expiry time, so a pair's
  legs always settle at the same instant (row 96).
- **Panoptic:** perpetual options — can't hedge a dated option.

## 6. Tokens vs ETFs vs indices (row 94)

One month of hourly data (2026-10-22 → 11-21):

| Pair | Ratio (NYSE hours) | Noise | Notes |
|---|---|---|---|
| S&P 500 / SPY | 10.029 | 6.6 bps | slow dividend/fee drift |
| Nasdaq-100 / QQQ | 41.104 | 7.0 bps | same |
| SPYX / SPY | 1.0069 | 46 bps (27 near close) | max gap 2.8% |
| QQQX / QQQ | 1.0034 | 65 bps (43 near close) | max gap 3.8% |

- **Index ↔ ETF is tiny and predictable; token ↔ ETF is the real basis.**
- **Weekends are where it bites:** tokens (and Derive's indices) keep trading;
  SPY/QQQ gapped −2.3%…+2.8% at Monday opens while the tokens' Sunday prices
  had moved −0.7%…+0.65%.
- **For hedging:** settle at a weekday US close if you can (1σ basis ≈ $1.9 per
  SPYX unit, $2.7 per QQQX unit); weekend/overnight expiries carry 1–3%.

## 7. Bridging notes

- **Jumper → NEAR Intents stuck at "pending":** the deposit can sit unnoticed
  at the deposit address. Submitting the deposit tx hash to NEAR Intents'
  1Click API (`POST /v0/deposit/submit` with `txHash` + `depositAddress`)
  got it processed within ~1 minute. Refunds go back to the origin address.
- **Hyperlane → Paradex:** delivered in ~10 s; the Paradex balance appears a
  little later under Transfers.

## 8. Reading the dashboard

- **Headline totals** count only clean, tradable rows at the honest clip size
  (fill-model aware). Everything else is still in the table with its flags.
- **Flags** (full list in the README): non-executable (`thin_book`,
  `spread_only`, `trading_cutoff` …), headline-blocking (`single_maker`,
  `wrapper_basis`, `market_closed`, `size_unknown` …), informational
  (`iv_inverted`, `execution_moves_rate`, `settlement_asset_mismatch` …).
- **Matched pairs aren't risk-free:** both legs converge at expiry only if
  they settle on the same price. Each signal carries a settlement-basis
  estimate; venues settle on different averages (row 89: Callput vs Deribit
  ≈ 6 bps; Paradex 30-min TWAP vs Olive's single print ≈ ±$25 on 0.1 BTC).
- **Margin on the short venue** is the one real risk of a matched pair: the
  short leg can be liquidated before expiry while the Olive long is still
  open. Watch the short venue's margin ratio.

## 9. Open items

| Item | What closes it |
|---|---|
| Callput spread pricing vs feed | a few weekdays of `/api/callput-fills` records |
| OKX Simple Options adapter | a weekday capture of `/priapi/v1/sfp/simple-option/products` |
| MSTR, DOGE, LTC, AAVE, WLFI, BNB, TRUMP on the box | add them to `UNDERLYINGS` in `/opt/options-arb/server/.env`, restart |
| Paradex TradFi weekday books | check META/NVDA/MSTR rows on a weekday (weekend capture had marks only) |
| Silver (Olive SLVON ↔ Coincall XAG) | a measured, stable SLVON/XAG ratio (~0.906 on one snapshot) |
| Wrapper basis at Olive's own oracle | Pyth history (needs a key) or Olive's own history |
| Hypercall `single_maker` lift | more fills at size (see docs/live-fill-checklist.md) |
| Derive ANT/XAUT settlement | undocumented — ask Derive |
| Olive call settlement asset in `VENUE_SPECS` | set calls → underlying (golden replay needs re-recording) |
