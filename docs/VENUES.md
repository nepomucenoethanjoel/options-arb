# Venue reference

One section per venue: what the app reads, units, fees, settlement and the
known gaps. Every fact here has a DATA_SOURCES.md matrix row (cited as
"row N"); when this page and DATA_SOURCES disagree, DATA_SOURCES wins and
this page is out of date.

Conventions used throughout the app: prices are converted to **USD per one
unit of the underlying**, sizes to **units of the underlying**, IV to a
fraction. A quote with no price on a side has that side `null` (never 0).

| Venue | Kind | Underlyings read | Settles | Headline? |
|---|---|---|---|---|
| Derive | order book | BTC ETH SOL ZEC HYPE XRP ADA PUMP VVV ANT NVDA XAUT (+ US500 US100 WTI listed, not mapped) | USDC | ✓ |
| Olive | AMM, model vol | crypto + xStock wrappers + PAXG | USDC (puts) / coin (calls) | ✓ buy side only |
| Coincall | order book | BTC ETH SOL SPY QQQ HYPE XRP XAUT DOGE AAVE WLFI BNB TRUMP | USDT | ✓ |
| Hypercall | RFQ makers | BTC ETH AAPL META MSFT MU NVDA SPCX ANT | USDC | ✗ `single_maker` (maker-quote alerts only) |
| Callput | vault, keeper-filled | BTC ETH + synthetic stocks | USDC / coin | ✗ `indicative_quote`, `spread_only` |
| Deribit | order book | BTC ETH SOL | coin (BTC/ETH), USDC (SOL) | ✓ |
| OKX | order book | BTC ETH (coin-margined), SOL HYPE gold (USD-margined) | coin / USD | ✓ (gold: `wrapper_basis`) |
| Gate | order book | BTC ETH SOL (+ alts listed) | USDT | ✓ |
| Paradex | order book | BTC ETH SOL HYPE ZEC NEAR (08:00) · META NVDA SPCX MU MSTR gold (16:00 UTC) | USDC | ✓ (gold: `wrapper_basis`) |
| Aevo | order book | BTC ETH SOL HYPE | USDC | ✓ |
| Bybit, Binance | — | deferred (geo-block the US host) | — | — |

---

## Derive (EVM / OP-stack)

- **Read:** v3 REST `public/get_all_instruments`, `public/get_tickers` per
  expiry (compact keys: `I` index, `M` mark, `b`/`a` best bid/ask,
  `option_pricing.i` IV, `.f` forward), with the legacy host merged in for
  book fields (rows 11–12). Derive is the **anchor chain**: its listings define
  the grid that other venues are matched against.
- **Fees (row 13):** taker $0.50 per order + min(0.03% × notional, 12.5% ×
  premium); maker min(0.01% × notional, 12.5% × premium).
- **Settlement (row 95, docs):** European, cash in USDC.
  - Crypto: 08:00 UTC, Derive's 30-min TWAP of spot.
  - **US500 / US100: 15:00 CT (16:00 ET)** on the **30-second VWAP of the
    assigned S&P 500 / Nasdaq-100 future** — the cash indices are display only.
  - NVDA: 15:00 CT, 2-min spot TWAP. WTI: 13:30 CT, 2-min futures VWAP.
  - RWA markets trade 23/5 (Sun 17:00 ET → Fri 16:00 ET); no weekend,
    holiday or early-close expiries; forward and vols frozen while closed.
- **Gaps:** ANT and XAUT settlement undocumented. US500/US100 are not mapped
  to SPYX/QQQX (futures carry + token gap, rows 94–95).

## Olive Exchange (Solana)

- **Read:** the public market-state file per market (spot, model vol,
  custody, rate curve, fixed-rate state) is the primary source; on-chain
  reads and the REST API are fallbacks (rows 4, 52, §2d-ter). The app
  **synthesizes** Olive quotes with Olive's own pricing.
- **Pricing (rows 1–2, 4, 10, 16, 78, 79):** Black-Scholes at Olive's per-asset EWMA model
  vol (flat across strikes).
  - Calls: F = S·e^(rL·T), df = e^(−rL·T). Puts: F = S·e^(−rS·T), df = e^(+rS·T).
  - Rate = per-custody borrow curve at locked / (owned − escrow), whole bps,
    floored; **quadratic above the 75% kink since 2026-11-17** (max 170%
    asset / 160% USDC) **plus** the fixed-rate premium β·U2d·t/(t+τ) (β 10000).
  - An order pays the Simpson average rate over its own lock — big orders
    move the price (`execution_moves_rate`, fill model in `signals/olive.ts`).
- **Fees (row 77):** min(5 bp × qty × oracle spot, 10% × premium) since
  2026-10-21; plus a Solana network fee.
- **Rules:** buy only (writing is the LPs' role → `direction_limited`);
  expiry any time between 1 day and 1 year out — **including 17:00 UTC for
  stocks** (row 90); **no opening inside 24 h of expiry** (`trading_cutoff`,
  row 81); strikes within ±1σ of spot (row 6).
- **Capacity:** each pool can only write its free collateral (calls: free
  tokens, puts: free USDC). Often tens to hundreds of dollars — the binding
  constraint on most trades. `/api/olive-pools` shows it per market.
- **Wrappers (rows 63, 94):** stock rows use Olive's xStock (SPY → SPYX …);
  gold uses PAXG for XAUT. A token is not one share (SPYX ≈ 1.0069 × SPY),
  so the Olive leg is quoted at **K × (token / ETF spot)** and priced per
  share; pairs carry `wrapper_basis`.
- **Settlement:** a keeper settles in the expiry second on Olive's oracle
  (row 15). Calls pay out in the underlying token, puts in USDC.
- **Wallet tip:** opening an option creates new Solana accounts (~0.0015–0.003
  SOL rent each). Keep ~0.02 SOL in the wallet or the transaction simulation fails.

## Coincall

- **Read:** public REST, the whole option chain per call (rows 26–27, 33–35).
- **Fees (row 34):** taker 0.03% of index notional (BTC/ETH) / 0.06% (alts), capped at
  12.5% of premium; delivery min(0.015% × index, 12.5% × intrinsic) except dailies.
- **Settles:** USDT; 15-min pre-expiry halt (`trading_cutoff`).
- **Coverage (row 97):** reads any underlying it lists (24 bases); mapped to
  Olive: BTC ETH SOL HYPE XRP XAUT SPY QQQ DOGE AAVE WLFI BNB TRUMP. Silver
  (XAG) is not mapped — Olive's SLVON is a trust share (~0.906 oz).
- **Note:** SPY/QQQ books are often marks only or wide.

## Hypercall (HyperEVM)

- **Read:** `GET /options-summary?currency=X&include_rfq_provider_quotes=true`;
  the tradable quotes are market makers' RFQ quotes (`rfq_provider_quotes[]`),
  `theoretical_price` is Hypercall's own model price (rows 28–29, 82).
  `/markets` lists which underlyings exist (rows 36–37, 80).
- **Flags:** one maker per instrument → `single_maker` (headline-blocking).
  These pairs reach the **maker-quote alert lane** instead (row 82).
- **Fees (row 38):** 0% today; modelled at the published 5 bp taker + 1.5 bp settlement.
- **Expiry:** crypto 08:00 UTC; stocks 21:00 UTC.
- **Margin (row 83):** portfolio margin; IM = max(weighted scanning loss over
  17 scenarios, 1.5% × strike) + 1% × spot within 48 h; MM = 0.85 × IM.
  Resting sell orders reserve more (the unweighted worst scenario price).
  Spot input: Hyperliquid `oraclePx`; vol: Deribit IV. Settlement: trimmed
  median-of-means of `oraclePx` over the last 30 min. Liquidation: health
  check every 5 s, partial buy-back at best ask + 0.5–10% bonus, full after 20 min.

## Callput (Base)

- **Read:** the app's public S3 feed `market-data.json` (mark, markIv, buy/sell
  risk premia, spot/futures indices; rows 39–41).
- **Product: spreads only** (row 87). The protocol encodes single legs, but
  Callput currently offers only call and put spreads — all 71 requests in a
  week were spreads. Every quote carries `spread_only` (non-executable).
- **Execution:** request → keeper fills in 2–13 s or cancels (full refund) if
  your minimum size can't be met (rows 85, 87). Keeper fee **0.00006 ETH per
  request**, cancelled ones included. Requests of $1k–5k were cancelled about
  half the time (row 88).
- **Sell (credit) spreads:** bear call / bull put; you deposit width × size
  (+ ~0.2–0.6/unit fee) and receive the credit in the fill transaction (row 88).
- **Fees (row 42):** open-buy 6 bp / open-sell 3 bp / settle 2 bp of notional,
  each capped at 12.5% of premium (per leg on a spread).
- **Settlement (row 89):** SETTLE_PRICE_FEED posts ~145 s after 08:00 UTC
  (crypto) and ~154 s after 17:00 UTC (stocks), every day incl. weekends.
  Crypto settles **+6 bps above Deribit's delivery price** on average (RMS < 7 bps).
- **Tooling:** `/api/callput-fills` (in-server recorder), `npm run callput:fills`,
  `npm run callput:settlements`.

## Deribit

- **Read:** public REST book summary per currency, ticker sizes for candidate
  pairs (rows 43–48). BTC/ETH from the inverse (coin) book; SOL from the
  USDC-linear book.
- **Fees (row 47):** 0.03% of underlying capped at 12.5% of premium;
  delivery 0.015% capped at 12.5% of intrinsic (none on dailies).
- **Settles:** 08:00 UTC, 30-min TWAP of the Deribit index (delivery price).
  `REFERENCE_VENUES=deribit` makes it reference-only.

## OKX

- **Read:** public v5 `instruments`, `tickers`, `opt-summary`, `mark-price`,
  `index-tickers` per family (rows 53–57, 92).
  - Coin-margined `BTC-USD`, `ETH-USD`: prices in coin → × index.
  - USD-margined `SOL-USD_UM`, `HYPE-USD_UM`, `XAU-USD_UM`: prices already USD.
  - Contract = ctVal × ctMult (BTC 0.01, SOL 0.1, HYPE 0.1, XAU 0.01 oz).
- **Gold:** OKX's XAU index is spot gold, not the XAUT token → `wrapper_basis`.
- **Fees (row 55):** taker 0.03% of notional capped at 7% of premium; exercise
  min(0.02% × notional, 7% × settlement value). Assumed the same for _UM.
- **Gaps:** settlement window and pre-expiry halt undocumented (0.5 h / 30 min assumed).
- **Simple Options (not integrated, row 92):** a separate OKX product with
  options on 12 xStocks (xSPY, xNVDA, xTSLA, xQQQ …), buy and sell. Undocumented
  public endpoints `/priapi/v1/sfp/simple-option/supportedInstFamily` and
  `/products?instFamily=XSPY-USDT`. Empty on weekends; integrate from a
  weekday capture. If they are the same xStock tokens as Olive's, there is no
  wrapper gap.

## Gate

- **Read:** public REST `/options/contracts` + tickers per `{U}_USDT` (rows 58–61).
- **Fees (row 59):** taker 0.03% (BTC/ETH) / 0.05% (others) capped at 12.5% of
  premium; settle 0.015% capped at 12.5% of intrinsic.
- **Settles:** USDT; window and halt assumed (0.5 h / 30 min).

## Paradex

- **Read:** public REST markets + `/markets/summary?market=ALL` (rows 65–68, 96).
- **TradFi (row 96):** equities META NVDA SPCX MU MSTR and XAU gold (→ the
  XAUT row, `wrapper_basis`) expire **16:00 UTC**; US500/US100/CL listed, not
  mapped. Settles on a 30-min TWAP of Paradex's oracle (a weighted median of
  Pyth, Stork and exchange perps); equities trade 24/5, books are empty at weekends.
- **Fees (row 66):** retail 0%; modelled at the Pro/API 0.01% taker capped at
  12.5% + 0.0075% settlement on ITM legs.
- **Settles:** USDC, 30-min TWAP of the Paradex spot oracle ending at expiry.
- **Account note:** "Margin Ratio" = maintenance margin ÷ equity; liquidation
  at 100%. Deposits arrive by Hyperlane (~10 s); the balance updates a little later.

## Aevo

- **Read (row 91):** `GET /markets?asset=X&instrument_type=OPTION` (expiries,
  cached), one `GET /options-chain?asset=X&expiry=<ns>` per expiry (bid/ask
  USD per coin + size in coin + IV), `GET /index?asset=X`. BTC, ETH, SOL, HYPE only.
- **Fees (docs):** taker 0.05% of index notional capped at 12.5% of premium;
  settlement 0.015% capped at 12.5% of payout on Friday expiries (charged
  every expiry, conservative).
- **Settles:** 08:00 UTC, USDC, on the Aevo index (median-filtered CEX spot).
- **Gaps:** settlement averaging window (single print assumed), halt (30 min
  assumed), SOL/HYPE specs and rate limits undocumented. Liquidity: one maker,
  ~1.6 BTC a side near the money.

## Not integrated

- **Panoptic:** perpetual options (streaming premium, no expiry) — their
  payoff never converges with a dated option, so they can't hedge one (row 93).
- **Derive US500/US100 → SPYX/QQQX:** settles on futures; see rows 94–95.
- **Bybit, Binance:** geo-block the US host.
