# AGENTS.md — how to work on this repo

Multi-venue options arbitrage monitor (Derive, Olive, Coincall, Hypercall,
Callput; Bybit/Binance deferred — geo-blocked from the US host). Read this before
changing anything. The short version: **this app's value is that every
number it shows is verified against venue reality — never weaken that to
make a number look better.**

## What this app is

- `server/` — Node ≥22 (built-in `node:sqlite`). Polls both venues every
  ~15s, matches instruments, computes signals, serves API + WebSocket +
  the built dashboard. Single process, no database server.
- `web/` — React dashboard (vite). The server serves its built bundle from
  `web/dist` — there is no second web server.
- `shared/` — types + math shared by both (BS pricing, Olive conventions).
- `deploy/` — VPS deployment kit (systemd unit, bootstrap, runbook).

## Non-negotiable rules

1. **The verification stack is load-bearing.** 188 tests (incl. a golden
   replay of a recorded live Olive × Derive cycle), typechecks in three
   workspaces, and `server/src/scripts/handcheck.ts` /
   `handcheck-books.ts` (live field
   parity against real venue data). Do not skip, weaken, or "fix" tests to
   make a change pass. If a test fails, the code is wrong or the venue
   changed — find out which.
2. **Every new venue assumption gets a DATA_SOURCES.md matrix row** (status
   VERIFIED-LIVE / DOCS-CONFIRMED / DOCUMENTED-ASSUMPTION / UNVERIFIED +
   evidence) in the same commit that introduces the assumption.
3. **Honesty over headline numbers.** Fixes that reduce displayed edge are
   correct fixes (see git history: phantom-row removal, fee corrections,
   marginal-fill pricing). Never remove a flag or a cost to make totals
   prettier.
4. **No secrets in the repo.** `server/.env` (gitignored) holds public
   market config only; keep it that way. Keys/tokens live on machines,
   not in git.
5. **Conventions:** match surrounding code style; comments state
   constraints, not narration; one logical change per commit.

## Commands

```bash
npm install                 # once, at repo root (workspaces)
npm test                    # shared + server test suites — must be green
npx tsc -b shared server web  # typecheck — must be clean
npm run build -w shared -w web  # build dists
npm run handcheck -w server   # LIVE check of an Olive pair vs real venue data (read-only)
npm run handcheck:books -w server  # LIVE check of a book-venue pair (PAIR_KEY=… optional)
bash deploy/deploy.sh root@<vps>  # deploy: build locally + ship + restart
```

## Architecture pointers

- Pricing conventions (verified, do not alter without new evidence):
  Olive calls `F=S·e^(rL·T)`, `df=e^(−rL·T)`; puts `F=S·e^(−rS·T)`,
  `df=e^(+rS·T)`; rates = per-custody borrow curve at `locked/owned`
  utilization; strike band ±1σ (`K_L=S·e^(−rS·T−σ√T)`, `K_U=S·e^(rL·T+σ√T)`).
- `shared/src/venueSpecs.ts` — `VENUE_SPECS`: per-venue quote kind, whether users
  can short there, trading cutoff, settlement asset/window. Every entry is a
  DATA_SOURCES row.
- `server/src/matching/engine.ts` — grid = union of anchor chains by pairKey;
  synthesizers (Olive AMM) fill legs on demand. `MatchRow.legs` is per venue.
- `server/src/signals/engine.ts` — evaluates every vol-consistent venue pair
  per contract, keeps the best (shortable sell venue → clean book → honest
  total) plus `alternatives`. Per-venue fees in `signals/fees.ts`; Olive-only
  capacity caps + marginal-fill VWAP in `signals/olive.ts`.
- `server/src/adapters/{coincall,hypercall,callput}.ts` — extra listed venues
  (`getChain`), enabled by `VENUES`; quote-level `flags` (`single_maker`,
  `indicative_quote`) keep unproven venues out of headline totals.
- Adding a venue: adapter with `getChain` + fixture test from a captured live
  response, a `VENUE_SPECS` entry, a fee model, a raw fetcher in
  `handcheck-books.ts`, and DATA_SOURCES rows — same commit.
- `server/src/scheduler.ts` — cycle orchestration + change-gated persistence.
- `test/golden.test.ts` — replays a recorded live Olive × Derive cycle; any
  change to those numbers fails it (re-record only with evidence).
- `server/src/api/server.ts` — REST + WS + `buildKpis` (pool-aware Σ takes
  `min(quoted, expected)` per clip — the honest headline).
- Olive's market file (`marketFile.ts`) is the primary live data source;
  `.env` pins are fallbacks only.

## Deploy notes

The VPS never compiles: `deploy.sh` ships prebuilt dists and the box runs
`npm ci --omit=dev`. Keep that invariant or update the kit deliberately.
The dashboard is unauthenticated — firewall guidance is in `deploy/README.md`.
