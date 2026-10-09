# AGENTS.md — how to work on this repo

Olive Exchange × Derive.xyz options arbitrage monitor. Read this before
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

1. **The verification stack is load-bearing.** 128 tests, typechecks in
   three workspaces, and `server/src/scripts/handcheck.ts` (live field
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
npm run handcheck -w server   # LIVE check vs real venue data (read-only)
bash deploy/deploy.sh root@<vps>  # deploy: build locally + ship + restart
```

## Architecture pointers

- Pricing conventions (verified, do not alter without new evidence):
  Olive calls `F=S·e^(rL·T)`, `df=e^(−rL·T)`; puts `F=S·e^(−rS·T)`,
  `df=e^(+rS·T)`; rates = per-custody borrow curve at `locked/owned`
  utilization; strike band ±1σ (`K_L=S·e^(−rS·T−σ√T)`, `K_U=S·e^(rL·T+σ√T)`).
- `server/src/signals/engine.ts` — signal computation. `NON_EXECUTABLE_FLAGS`,
  fee models (both venues, live-fill verified), capacity caps (calls: free
  underlying custody; puts: free USDC ÷ strike), marginal-fill VWAP.
- `server/src/scheduler.ts` — cycle orchestration + change-gated persistence.
- `server/src/api/server.ts` — REST + WS + `buildKpis` (pool-aware Σ takes
  `min(quoted, expected)` per clip — the honest headline).
- Olive's market file (`marketFile.ts`) is the primary live data source;
  `.env` pins are fallbacks only.

## Deploy notes

The VPS never compiles: `deploy.sh` ships prebuilt dists and the box runs
`npm ci --omit=dev`. Keep that invariant or update the kit deliberately.
The dashboard is unauthenticated — firewall guidance is in `deploy/README.md`.
