# DATA_SOURCES.md — Venue data provenance

Everything in this file was verified against live endpoints on **2026-09-27**.
Update this file whenever a discovery step is re-run (`npm run probe:olive`) or
an endpoint changes behavior.

---

## 1. Derive.xyz (EVM / OP-Stack) — documented + live-verified

Docs: `https://docs.derive.xyz` (API v3). Machine-readable specs:
`https://docs.derive.xyz/openapi.json`, `websocket.asyncapi.json`.

| Item | Value |
|---|---|
| HTTP base (mainnet) | `https://api.derive.xyz/v3` |
| HTTP base (testnet) | `https://testnet.api.derive.xyz/v3` |
| WS (mainnet) | `wss://api.derive.xyz/v3/ws` |
| Legacy host (v2, still live) | `https://api.lyra.finance` / `wss://api.lyra.finance/ws` |
| Auth | none for `public/*` |

### Calling convention (IMPORTANT)

- **HTTP**: `POST https://api.derive.xyz/v3/<method>` with the **flat params
  object as the JSON body**. A `{"jsonrpc","id","method","params"}` envelope is
  silently mis-parsed on HTTP — envelope form is **WebSocket only**.
- Example: `POST /v3/public/get_time` → `{"id":"<uuid>","result":1790533334393}`

### Endpoints used by this app

| Method | Notes |
|---|---|
| `public/get_all_instruments` | Params: `instrument_type:'option'`, `expired:false`, `currency`, `page`, `page_size` (max 1000). Returns `{instruments, pagination}`. `public/get_instruments` (plural) does **not** exist on v3 — only on the legacy host. |
| `public/get_tickers` | Params: `instrument_type:'option'`, `currency`, `expiry_date` (int `YYYYMMDD`). Returns `{tickers: {<name>: <ticker>}}`. **Abbreviated keys** — see below. |
| `public/get_latest_signed_feeds` | Params: `currency`, `expiry` (optional). Returns `spot_data`, `fwd_data`, `vol_data` (SVI), `rate_data`. |
| `public/get_option_settlement_prices` | Broken on v3 (`-32603`); works on legacy host. Only needed for expired-option reconciliation — not used at runtime. |

### Ticker response shape (abbreviated / "slim" keys)

Per instrument: `t` (ts ms), `b`/`B` (best bid px/size), `a`/`A` (best ask
px/size), `M` (mark), `I` (index), `stats` (`oi`, volume, …), and
`option_pricing`: `d` delta, `g` gamma, `v` vega, `t` theta, `r` rho,
**`i` implied vol** (fraction, e.g. `0.55`), `bi`/`ai` bid/ask IV, `f` forward,
`m` mark, `df` discount factor.

### SVI surface

`vol_data` entries: `currency`, `expiry` (ts sec), `timestamp`, `deadline`,
`confidence`, `SVI_a`, `SVI_b`, `SVI_m`, `SVI_rho`, `SVI_sigma`, `SVI_fwd`,
`SVI_refTau`, plus oracle `signatures`/`signers`.
Total variance `w(k) = a + b·(ρ(k−m) + √((k−m)² + σ²))`, `k = ln(K/F)`,
`IV = √(w / refTau)`.

### WebSocket

`ticker.<name>.<interval>` is **deprecated and rejected**; use
`ticker_slim.<instrument_name>.<100|1000>`. Subscribe:
`{"id":1,"method":"subscribe","params":{"channels":[...]}}`.
This app uses REST polling in v1 (rate-limit headroom is fine); WS is a future
optimization.

### Rate limits (docs.derive.xyz/rate-limits.md)

Public: **5 TPS / 25 requests per 5 s window per IP**; max 4 concurrent WS
clients per IP. The adapter enforces a global token bucket.

### Observed quirks (as of 2026-09-27)

- v3 REST tickers returned **zeroed books/stats** (b/B/a/A/stats = 0) for ETH
  options while the **legacy host showed real quotes/OI** for the same
  instruments (marks identical). → `DERIVE_BOOK_SOURCE=merge` default.
- Quote currency is **USDC**. Options settle 08:00 UTC; Derive settlement uses
  a 30-min TWAP of the underlying (per Derive docs) — differs from Olive's
  Stork oracle print (see caveats in the UI).

### Instrument naming

`{CURRENCY}-{YYYYMMDD}-{STRIKE}-{C|P}` e.g. `ETH-20261030-2900-C`;
fractional strikes use `_` decimals (`2400_5` = 2400.5).
Currencies verified via `public/get_all_currencies`: include **BTC, ETH, SOL,
ZEC** (overlap with Olive), plus many more.

---

## 2. Olive Exchange (Solana) — discovered (no public API docs)

Docs `https://docs.olive.exchange` describe protocol mechanics only — **no
REST/GraphQL spec, no program IDs, no SDK**. The following was recovered from
the production frontend's embedded deployment manifest
(`olive.exchange/_next/static/chunks/6394-*.js`).

### 2a. Backend REST API (primary path)

| Item | Value |
|---|---|
| Base | `https://olive.exchange/api/v1` |
| Auth gate | Requires headers `X-API-Key` (**any non-empty value** accepted) and `X-Request-ID` (uuid). Without them: `400 {"message":"Missing required security headers"}`. |

Verified live routes:

- `GET /health` → `{status:"healthy", runtimeRole:"api", version, buildSha}`
- `GET /status` → runtime status incl. `activeFlags` (e.g.
  `realtimeIndexing`, `websocketRedisAdapter`, `executionOracleProvider:
  "stork-fast"`) and indexer metrics
- `GET /pools` → `{success:true, data:[…]}` — **was empty at first probe**
  (indexer had 0 signatures scanned after a fresh deploy
  `olive-mainnet-elfk-20260919`, uptime ~85 min). Route exists; data expected
  once indexing populates.
- `GET /pools/<PDA>` → `{"message":"Pool not found"}` (same reason)
- Unknown routes → helpful 404 echoing the path. No `/openapi`, `/swagger.json`,
  `/docs`.

**Status: RE-PROBE REGULARLY** — run `npm run probe:olive` and append findings
below. Market-data routes (chains/quotes) are expected under this router.

### 2b. WebSocket

Socket.io v4 gateway at `https://olive.exchange/socket.io/` (handshake verified,
no header gate). Event names not yet captured — requires a live browser session.
Not used in v1.

### 2c. On-chain (fallback path — fully permissionless)

| Item | Value |
|---|---|
| Program ID | `ELfKgKXLdcnLaq3oHzJJHRCKUat9q2tJsxvr3NMbELbB` (mainnet) |
| Program data | `4f8hcDtxfxwGByDSGSCdgJ4PeXMCr2x6jS4bureQ61EV` |
| IDL | Anchor IDL account PDA (`DJuyEixrCzA4pYc1aXgtEQTvijNhHtv2om6zL6MRZgWw`) **verified absent** — no published IDL |

Pool accounts (owner = program, verified live):

| Underlying | Pool PDA |
|---|---|
| SOL | `8K1JCw3bb1WKh6wcw8ehZW8UUPJti6quqNuDa7gMQRFZ` |
| BTC | `Cu5SM3wBGbzgEcYt4PqiQPC8NgsowL6eegWx7KaV91wH` |
| ETH | `6NsPFDcRzih2CuJyDTLmD3DcLgxrMt2sCJQJGmWzb4yJ` |
| PAXG | `DiTdbnG5wQxVdw38zXt46Kf6hbqQ3dFHtENy51e67nkN` |
| JUP | `5UoG1xiy8Kh1PqncYm9qfTmGLVaFK9c8oGdEmXN1zsTD` |
| NVDAX | `C5pLamu5reyo3fAeycTEPBXaorGK8TaESYzYhQPGSkeL` |
| ZEC | `2EKB39dNctokhTeE7XLLeJcTCWhs71qZ4FKXufSpEiJL` |

Underlying-custody volatility-oracle accounts (deployment manifest, 2026-09-19
redeploy; each pool also has a stable-custody oracle not listed):

| Underlying | Vol-oracle PDA |
|---|---|
| SOL | `94Qdd6omWrybikFNvuREMTxFLaGL8L6MLzDukQJbBYjg` |
| BTC | `7S4AU2vvBTSfXmaHdky1FpepPJttPp8FLZtPbsoLXkBG` |
| ETH | `43ydXzwdaWmiAAPWAbQA2iAKjpPxqFXkw34Yxsw8YWZD` |
| PAXG | `GrepgKevNmJqCvW2qPqHDqjsP92NCQakVsjA7nSTUm98` |
| JUP | `GCuGWHCP2KeAgpdbc5sGPECPDLQ3RjEZF1xpwZxVEVwW` |
| NVDAX | `7y1E7tDYJNrEPrsrLvnatppJsYDQLM4cKMDs8GrnDJBd` |
| ZEC | `CXr4JBnZdMLqSkqycRMPMo6Pu2CDvLuem6PHETp3w6J6` |

**Vol-oracle account layout (145 bytes, reverse-engineered from live accounts):**

```
0x00  8    Anchor discriminator
0x08  32   pubkey (price account)
0x28  32   pubkey (authority)
0x48  32   opaque/hash-like state
0x68  u64  tau window, seconds        (observed 1,296,000 = 15 days — matches docs)
0x70  u64  min refresh interval, s    (observed 900 — matches docs)
0x78  u64  last update, unix seconds
0x80  u64  last oracle price × 1e6    (BTC 81362.57 / ETH 2614.39 / USDC 0.999825 observed)
0x88  u64  variance floor/seed × 1e8  (observed 100,000 → 0.001)
0x90  u8   flags (0xff)
```

**Operational finding (2026-09-27): the volatility keeper is inactive since
the 2026-09-19 redeploy.** `/health` reports `keeperAutoStart: false` and all
vol-oracle timestamps are 11–209 h old (SOL's underlying oracle is closed
entirely; two independent RPCs agree). The variance word is therefore a seed
value, not live vol. Consequences encoded in the app:

- Model vol is treated as **unavailable** unless the oracle is fresh OR an
  explicit `OLIVE_VOL_OVERRIDES` env entry pins it; the UI shows
  `model_vol_unavailable_keeper_inactive` and signals are suppressed honestly.
- The oracle's `lastPrice × 1e6` (with staleness flag) and Derive's index
  price serve as spot fallbacks for AMM synthesis.
- When Olive restarts their keeper, `npm run probe:olive` should be re-run and
  the live-variance word re-verified (offset 0x88 is the candidate).

### 2d. Protocol semantics (affect signal interpretation)

- **AMM, not an order book**: options are minted/sold by the liquidity pool.
  Any strike within live bounds can be quoted at any expiry 1–365 d, so the
  Derive chain drives the comparison grid.
- **Pricing** (convention **verified against their live production UI on
  2026-09-27**, see §3): Black-Scholes in forward form with
  `F = S·e^(r_long·T)` for calls and `F = S·e^(−r_USDC·T)` for puts,
  discount factor ≈ 1, expiry at **08:00 UTC** (TradingView symbol timestamp
  1791100800000 = 2026-10-04T08:00Z). Rates are per-custody admin-set values
  surfaced in their UI as "Fixed Rate (L/S)" (SOL: 15.07% / 2.00%). Their UI
  displays vega per 1% vol and theta/day including the carry term.
- **Model vol**: per-asset EWMA realized vol. Their frontend shows it live
  (SOL ≈ 69% on 2026-09-27) via socket.io streaming; the on-chain vol-oracle
  word is only maintained by the (currently inactive) keeper.
- **Strike bounds**: ±1σ bands around oracle spot:
  `K_L = S·e^(−r_USDC·T − σ√T)`, `K_U = S·e^(r_token·T + σ√T)` (docs use n=m=1).
- **Fully collateralized** (calls backed by underlying, puts by USDC); keeper
  auto-exercises ITM at expiry; effectively European (manual ITM exercise
  allowed pre-expiry).
- **Fees**: `min(2.5 bps of notional, 10% of premium)`, split 25/75 company/pool.
- **Settlement price**: Stork oracle (`stork-fast`), with Pyth symbols as
  fallback — vs Derive's 30-min TWAP. Encoded as a signal caveat.
- **Directionality caveat**: users buy options from the pool and sell them
  back; writing fresh options to the pool is an LP role. "Sell vol on Olive"
  signals are flagged `direction_limited`.

### 2d-ter. THE live data source: the market-state file (2026-09-27)

Found by hooking the frontend's own `fetch` calls. Everything the UI displays
flows from here:

```
GET https://olive.exchange/public/market/{SYM}%2FUSDC.json
```

Plain CDN file, **no auth**, regenerated every ~5 s by their reader-2 service.
Contents (top-level keys): `asOf`, `ticker` (all 7 Stork prices + USDC),
`market` (24h volume/OI activity), `trades`, `state` (the live pool snapshot),
`utilization`, `marketEnvelope`. The important paths:

- `state.payload.snapshot.volatility.volatility` — **live model vol**. Their
  backend PROJECTS the EWMA forward (`projectionBranch: "blended_update"`)
  from the last on-chain write using live prices — which is why the UI vol
  ticks while the on-chain word sits stale. Also carries `volatilityScaled`
  (×1e6), `tau`, `minUpdateIntervalSeconds: 900`.
- `state.payload.snapshot.poolSummary` — `aumUsd`, `openPositionEntryClaimsUsd`
  (→ available-liquidity proxy), utilization, LP pricing; `rawOnChainPoolSnapshot`
  has the E6-scaled equivalents + fixed-rate-wheel state.
- `state.payload.snapshot.executionOracle` — Stork price freshness/health.
- `state.payload.snapshot.rawOnChainPoolSnapshot.{underlyingCustody,usdcCustody}` —
  **per-custody free collateral** (decoded 2026-09-28): each custody carries
  `tokenOwned`, `tokenLocked` (raw integers) and `decimals` (underlying 9, USDC 6);
  `free = (owned − locked) / 10^decimals`. Calls lock the underlying custody
  (1 underlying each), puts the USDC custody (K USDC each) — these are the real
  per-kind capacity limits, and their UI's "Available Liquidity" card is exactly
  `freeUnderlying × spot + freeUSDC` (verified live: 23.7 SOL × $118.5 + $1,296 ≈
  $4,105). Wired into signal sizing 2026-09-28 (`poolCustodyByAsset`; the scalar
  AUM pin remains a fallback, flagged `pool_capacity_estimated`).

Live pool AUM observed 2026-09-27 ~21:30 UTC: SOL $4,921 · BTC $1,107 ·
ETH $1,510 — the BTC/ETH pools cannot collateralize a single new option at
those sizes.

### 2d-quat. socket.io realtime — INTEGRATED (2026-09-28)

Fully decoded and wired into the server (`adapters/olive/realtime.ts`):

- **Connect** `wss://olive.exchange/socket.io/?EIO=4&transport=websocket`,
  on engine `0{...}` open send `40{"realtimeVersion":2}` — a plain `40`
  gets `realtime_upgrade_required {requiredVersion:2}` and the server drops
  the connection.
- On `40{...sid}` namespace-connect, emit `42["subscribe_ticker",{}]` —
  **an empty payload is accepted; no wallet/auth needed**. (`subscribe_options`
  IS user-scoped: returns `subscription_error {error:"user must be a valid
  Solana address"}`.)
- Server then pushes `42["tickerPriceSnapshot",[…]]` **~1/s** with all Stork
  feeds: `[{symbol:"SOL/USD", price:118.52, publishTime:1790579647.42,
  fetchedAt:"2026-09-28T07:14:07.539Z"}, …]` (SOL, BTC, ETH, PAXG, JUP, ZEC,
  NVDAX).
- Engine keepalive: server `2` ping → reply `3` (pingInterval 25 s).
- The `connected` ack lists supported events: subscribe_ticker,
  subscribe_ticker_fast, subscribe_chat, subscribe_positions, subscribe_options,
  subscribe_tpsl, set_activity_scopes, realtime_frontier_repair_started,
  unsubscribe, ping. `subscribe_ticker_fast` pushed nothing in a 10 s probe.

App usage: one passive connection (like a browser tab), spot priority becomes
socket (~1 s) → market file (~5 s) → Pyth → on-chain oracle; caveat
`spot_realtime_socket`. A ≥1 % spot move vs the last cycle's print triggers an
early re-price (30 s cooldown). Config: `OLIVE_REALTIME`,
`OLIVE_REALTIME_SPOT_TRIGGER_PCT`, `OLIVE_REALTIME_MAX_SPOT_AGE_MS`,
`OLIVE_REALTIME_URL`. Status: `/api/health` → `oliveRealtime`, header badge
"Olive RT".

### 2d-bis. Other live endpoints discovered from their frontend (2026-09-27)

- `GET /api/v1/oracle/stork-fast-pair?poolName=<SYM>%2FUSDC` — **works for
  all pools** (verified SOL/BTC/ETH): signed Stork price packet
  (`data.member.value.payloadHex`, proof + expiry). Price is decodable from
  the payload; supersedes the dead public Pyth path for spot.
- `GET /api/v1/deployment/identity` — deployment manifest.
- Their frontend also streams vol/quotes/greeks over socket.io and reads
  chain state directly via Helius RPC with an embedded API key (not reused
  here). `/options/*` REST routes are a `:user` wildcard — not market data.

### 2e-bis. Per-pool snapshots (historical; superseded by the live market file §2d-ter)

Read from their pool menu 2026-09-27 ~20:50 UTC — kept for reference; the
market file now streams these values live:

| Pool | Oracle price | Fixed Rate (L/S) | Model vol |
|---|---|---|---|
| SOL | $122.78 | 15.07% / 2.00% | 68.98% |
| BTC | $84,571.62 | 8.00% / 2.00% | 49.10% |
| ETH | $2,687.62 | 8.00% / 2.00% | 53.35% |
| PAXG | $4,275.06 | 8.00% / 2.00% | 40.15% |
| JUP | $0.3441 | 8.00% / 2.00% | 146.14% |
| NVDAX | $225.78 | 8.00% / 2.00% | 55.84% |
| ZEC | $1,601.93 | 8.00% / 27.18% | 98.82% |

**Cross-venue coverage (2026-09-28):** of Olive's 7 pools, only SOL/BTC/ETH
and **ZEC** have a Derive options chain. Derive lists 7 ZEC expiries
(20261002…20270326, ~69 strikes $200-$8500; `public/get_all_instruments`
currency=ZEC). PAXG/JUP/NVDAX are Olive-only — no arb comparison possible.
ZEC wired into the scanner 2026-09-28 (rates 8%/27.18% — the odd 27% short
rate is their UI reading; pool AUM ~$1.1k cannot fund a single call, so all
ZEC rows are size-0 `pool_capacity_capped`). Note Derive ZEC IVs run
~120-150% vs Olive's ~101% — the one asset where the RICH side is Derive,
i.e. the executable direction (`buy_olive_sell_derive`).

These are the values wired via `OLIVE_VOL_OVERRIDES` / `OLIVE_RATE_OVERRIDES`.
**They are static snapshots** — Olive's EWMA only refreshes on ≥15 min or ≥5%
moves, so drift is slow, but re-read (or wire the socket.io feed) after big
market moves.

### 2e. Reference prices

- Pyth Hermes (spot, no key): `https://hermes.pyth.network/v2/updates/price/latest?ids[]=<feed_id>`
  — **unreachable from the build machine on 2026-09-27** (`api.pyth.network` DNS fails; hermes returns 401). The app hardcodes canonical feed IDs for SOL/BTC/ETH and also tries Olive's own proxy `https://pyth.dourolabs.app` (404 on the hermes path today). Effective fallback chain: Pyth → on-chain oracle `lastPrice` → Derive index price.
- Feed-id lookup (when reachable): `https://api.pyth.network/v2/price_feeds?query=<SYM>&asset_type=crypto`

### 2f. GitHub / SDK

No public org/repos found (`github.com/olive-exchange`, `oliveexchange` 404;
`olivefinance` has 0 repos; `Olive-Finance` is an unrelated EVM project).
No published SDK or IDL reference.

---

## 3. Probe log

| Date | Route / check | Result |
|---|---|---|
| 2026-09-27 | Derive v3 methods listed above | All verified live (see §1) |
| 2026-09-27 | Derive v3 books zeroed; legacy populated | Observed, ETH options |
| 2026-09-27 | Derive numerics arrive as **strings**; `get_latest_signed_feeds` nests `vol_data.{CCY}.{expirySec}.vol_data.SVI_*`; SVI normalized by `SVI_refTau` (IV=√(w/refTau) reproduces quote IVs) | Encoded in DeriveAdapter |
| 2026-09-27 | Olive `/api/v1/health`, `/status` | OK; full deployment manifest in payload (Mongo/Redis/Helius/Stork; `keeperAutoStart: false`) |
| 2026-09-27 | Olive `/api/v1/pools` | Route OK, data empty (indexer cold start) |
| 2026-09-27 | Olive `/api/v1/options/chain` | **Not a market route** — matches a wildcard `:user` param (validation error names field `user`, value `chain`); other candidate routes 404 |
| 2026-09-27 | Olive program + all 7 pools + IDL PDA | Pools verified live (350 B); IDL account absent |
| 2026-09-27 | Olive vol-oracle accounts (all 14 custodies) | Layout decoded (see §2c); **keeper inactive** — timestamps 11–209 h stale; SOL underlying oracle closed |
| 2026-09-27 | Pyth Hermes / api.pyth.network from build machine | Unreachable (DNS / 401); fallbacks wired |
| 2026-09-27 | Olive frontend discovered live despite cold indexer: UI shows live vol (SOL ≈ 69%), oracle px, rates (15.07%/2.00%), quotes + greeks via socket.io + Helius reads | Verified by watching values tick |
| 2026-09-27 | **Pricing accuracy verified vs Olive production**: SOL 120.17C — our BS reproduces delta 0.6266 (theirs 0.6265), gamma/vega/PITM to 4th dp, price within $0.019 (display rounding). Convention `F=S·e^(rL·T)`, df≈1, expiry 08:00 UTC | Encoded in synth pricer + this doc |
| 2026-09-27 | **Pricing accuracy verified vs Derive production**: 57 live SOL options — our BS at their IV/forward/df vs their marks: RMS $0.089, within their 0.1 mark tick rounding | `npm run verify:pricing -w server` |
| 2026-09-27 | `/api/v1/oracle/stork-fast-pair?poolName=X/USDC` works for all pools (signed Stork packets) | Route documented §2d-bis |
| 2026-09-28 | **Strike bounds: docs' ±1σ rule NOT enforced in live deployment** — their UI quotes strikes from deep OTM to 2.5× spot (300P on SOL ≈ $118 spot priced at pure intrinsic, no error). Default switched to unbounded (`OLIVE_STRIKE_BOUND_SIGMAS=0`) | Probe via UI strike input |
| 2026-09-28 | **Per-custody pool capacity decoded** (market file `rawOnChainPoolSnapshot`): SOL pool free = 23.7 SOL + $1,296 USDC vs total AUM $4,839 — their UI rejects a 22.8-put order ($2,739 collateral) with "exceeds available liquidity for USDC" while total AUM would suggest headroom. "Available Liquidity" card = freeUnderlying×spot + freeUSDC | Wired into sizing; see §2d-ter |
| 2026-09-28 | **Pricing convention re-verified live vs their production UI** (browser session): SOL-05OCT26-120C $3.8317 / δ 0.4740 and 120P $5.1951 / δ −0.5306 — our BS (`F=S·e^(rL·T)` calls, `F=S·e^(−rS·T)` puts, df=1, expiry 08:00 UTC per TV symbol 1791187200000) reproduces call δ exactly, prices within $0.012/$0.003; no AMM spread on top of model premium; put locks exactly K USDC each | Encoded in synth pricer + this doc |
| | *(append new probe results here)* | |
