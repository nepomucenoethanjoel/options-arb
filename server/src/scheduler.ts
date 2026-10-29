import { EventEmitter } from 'node:events';
import {
  HEADLINE_BLOCKING_FLAGS,
  sampleSviSlice,
  type MatchRow,
  type MatchRowLite,
  type OptionQuote,
  type Signal,
  type Venue,
  type VenueHealthSnapshot,
} from '@options-arb/shared';
import type { OptionsVenueAdapter } from '@options-arb/shared';
import type { AppConfig } from './config';
import type { DeriveAdapter } from './adapters/derive';
import type { OliveAdapter } from './adapters/olive';
import { matchChain } from './matching/engine';
import { computeSignals, isPersistWorthy } from './signals/engine';
import { effectivePrices } from './signals/bestVenue';
import { surfaceFlags } from './signals/surfaceChecks';
import { feeModels } from './signals/fees';
import type { Storage } from './storage';
import type { Alerter } from './alerts';
import { EpisodeTracker } from './episodes';

/** Compact projection for the WS push — full rows stay server-side. */
export function toLiteRows(rows: MatchRow[], pricing?: Omit<Parameters<typeof effectivePrices>[2], 'spot'> & { spots: Record<string, number | null> }): MatchRowLite[] {
  return rows.map((r) => ({
    pairKey: r.pairKey,
    underlying: r.underlying,
    expiryTs: r.expiryTs,
    expiryDate: r.expiryDate,
    strike: r.strike,
    kind: r.kind,
    matchType: r.matchType,
    venues: Object.fromEntries(
      Object.entries(r.legs).map(([v, leg]) => {
        const base = { iv: leg?.quote?.iv ?? null, bid: leg?.quote?.bid ?? null, ask: leg?.quote?.ask ?? null, mark: leg?.quote?.mark ?? null };
        if (!pricing) return [v, base];
        const eff = effectivePrices(r, v as Venue, { ...pricing, spot: pricing.spots[r.underlying] ?? null });
        return [
          v,
          {
            ...base,
            buyEff: eff.buyEff != null ? Math.round(eff.buyEff * 1e4) / 1e4 : null,
            sellEff: eff.sellEff != null ? Math.round(eff.sellEff * 1e4) / 1e4 : null,
            askSize: leg?.quote?.askSize ?? null,
            bidSize: leg?.quote?.bidSize ?? null,
            ...(eff.flags.length > 0 ? { flags: eff.flags } : {}),
          },
        ];
      }),
    ),
    note: r.legs.olive?.note,
    unmatchedReason: r.unmatchedReason,
  }));
}

export interface CyclePayload {
  ts: number;
  durationMs: number;
  rows: MatchRowLite[];
  signals: Signal[];
  health: VenueHealthSnapshot;
  spots: Record<string, number | null>;
  /** Olive socket.io ticker stream status (null when disabled). */
  realtime: { status: string; statusSinceMs?: number; lastFrameAgeMs: number | null; assets: string[] } | null;
  oliveCaveats: string[];
  config: {
    ivSpreadThresholdVols: number;
    pollIntervalMs: number;
    underlyings: string[];
    fees: Record<string, unknown>;
  /** When static vol overrides are in use: when they were pinned (ms), for staleness display. Null when vol is live. */
  volPinnedAt: number | null;
  };
}

export interface SurfacePayload {
  underlying: string;
  expiryDate: string | null;
  deriveQuotes: Array<{ strike: number; kind: 'call' | 'put'; iv: number | null; bid: number | null; ask: number | null }>;
  deriveSvi: Array<{ strike: number; iv: number }>;
  oliveModelVol: number | null;
  oliveSpot: number | null;
  oliveBounds: { lower: number; upper: number } | null;
}

interface UnderlyingResult {
  underlying: string;
  rows: MatchRow[];
  signals: Signal[];
  spot: number | null;
  oliveCaveats: string[];
}

/** At most one realtime-triggered early cycle per 30 s (Derive rate budget). */
const EARLY_CYCLE_COOLDOWN_MS = 30_000;
/** Full-sweep cadence: unchanged rows get re-persisted at least this often. */
const PERSIST_FULL_INTERVAL_MS = 10 * 60_000;
/** Min spacing between "interesting row" persistence bursts. */
const PERSIST_INTERESTING_INTERVAL_MS = 60_000;
/** Hard floor for UNCHANGED non-worthy rows (every pair keeps ≥1 point/hour
 * even when its 0.05-vol signature never moves — enough for trend context,
 * while the 10-min sweep × ~900 rows alone was 131k writes/day). */
const PERSIST_HARD_FLOOR_MS = 60 * 60_000;

/**
 * Burst-change signature: chart-visible resolution of the spread plus the
 * profitability/opportunity regime, flags and clip total. Rows whose
 * signature is unchanged since their last persist skip the write (they
 * would be duplicate flat points — persistence was writing ~100-160k
 * rows/day, most of them identical). Retention default is 7 days: the
 * history charts max out at a 7-day window, so anything older is dead
 * weight nothing reads.
 */
function burstSignature(s: Signal): string {
  return [
    Math.round((s.ivSpreadVols ?? 0) * 5), // 0.2-vol chart resolution
    s.isOpportunity ? 1 : 0,
    s.isProfitable ? 1 : 0,
    Math.round((s.totalNetUsdc ?? 0) * 5),
    s.flags.join(','),
  ].join('|');
}

/**
 * Orchestrates one polling cycle:
 *   fetch Derive chain + tickers + Olive market state → match → signal →
 *   persist → broadcast (WS) → alerts.
 * Never throws; venue failures land in the health snapshot.
 */
export class Orchestrator extends EventEmitter {
  latest: CyclePayload | null = null;
  /** Full-detail rows (quotes, greeks) keyed by pair — served via /api/pair. */
  fullRows = new Map<string, MatchRow>();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pruneTimer: NodeJS.Timeout | null = null;
  readonly episodes: EpisodeTracker;

  constructor(
    private readonly cfg: AppConfig,
    private readonly derive: DeriveAdapter,
    private readonly olive: OliveAdapter,
    private readonly storage: Storage,
    private readonly alerter?: Alerter,
    /** Additional listed venues (whole-chain getChain), polled alongside Derive. */
    private readonly extraVenues: OptionsVenueAdapter[] = [],
  ) {
    super();
    this.episodes = new EpisodeTracker(storage);
    // Static vol pins age — surface when they were set so the UI can nag.
    this.volPinnedAt = Object.keys(cfg.oliveVolOverrides).length > 0 ? Date.now() : null;
  }

  private readonly volPinnedAt: number | null;

  /** Process start — episodes are only measured while the process runs. */
  startedAt: number | null = null;

  start(): void {
    this.running = true;
    this.startedAt = Date.now();
    void this.loop();
    const pruneMs = this.cfg.historyRetentionDays * 86_400_000;
    this.pruneTimer = setInterval(() => {
      try {
        this.storage.prune(Date.now() - pruneMs);
      } catch (err) {
        console.warn('[scheduler] prune failed:', err instanceof Error ? err.message : err);
      }
    }, 3_600_000);
    this.watchRealtime();
  }

  /**
   * Self-chaining cadence: the next cycle is scheduled from when this one
   * STARTED, never overlapping. setInterval dropped every tick that landed
   * while a cycle was still busy — a 15.2 s cycle on a 15 s interval ran
   * every 30 s.
   */
  private async loop(): Promise<void> {
    const t0 = Date.now();
    try {
      await this.runOnce();
    } catch (err) {
      // A throwing cycle must not end the chain (setInterval never did).
      console.warn('[scheduler] cycle failed:', err instanceof Error ? err.message : err);
    }
    if (!this.running) return;
    const delay = Math.max(0, this.cfg.pollIntervalMs - (Date.now() - t0));
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    this.spotUnsub?.();
    this.spotUnsub = null;
    try {
      this.episodes.flush();
    } catch (err) {
      console.warn('[scheduler] episode flush failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Re-price early when the realtime Olive spot jumps away from the price the
   * last cycle priced at (AMM quotes move with spot immediately; a ≥1% gap
   * makes the cycle's premiums materially stale). Rate-limited by cooldown;
   * runOnce's busy-guard prevents pile-ups.
   */
  private watchRealtime(): void {
    if (this.cfg.oliveRealtimeSpotTriggerPct <= 0) return;
    const trigger = this.cfg.oliveRealtimeSpotTriggerPct / 100;
    this.spotUnsub = this.olive.onSpot(({ asset, price }) => {
      if (this.busy) return;
      const anchor = this.lastCycleSpots.get(asset);
      if (anchor == null || anchor <= 0) return;
      const move = Math.abs(price - anchor) / anchor;
      const sinceCycle = Date.now() - (this.latest?.ts ?? 0);
      if (move < trigger) return;
      if (Date.now() - this.lastEarlyCycleMs < EARLY_CYCLE_COOLDOWN_MS || sinceCycle < 5_000) return;
      this.lastEarlyCycleMs = Date.now();
      console.log(
        `[scheduler] ${asset} moved ${(move * 100).toFixed(2)}% since last cycle (${anchor.toFixed(2)} → ${price.toFixed(2)}) — early re-price`,
      );
      void this.runOnce();
    });
  }

  private spotUnsub: (() => void) | null = null;
  private lastCycleSpots = new Map<string, number>();
  private lastEarlyCycleMs = 0;
  private lastFullPersistMs = 0;
  private lastInterestingPersistMs = 0;
  private lastBurstByPair = new Map<string, { sig: string; ts: number }>();

  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const now = Date.now();
      // Per-underlying work runs concurrently: the Derive rate limiter still
      // serializes Derive calls, but Olive's Solana/Pyth/REST waits overlap
      // with Derive fetches instead of adding to the cycle's tail.
      const results = await Promise.all(
        this.cfg.underlyings.map((u) =>
          this.processUnderlying(u, now).catch((err) => {
            console.error(`[scheduler] cycle for ${u} failed:`, err);
            return null;
          }),
        ),
      );

      const allRows: MatchRow[] = [];
      const allSignals: Signal[] = [];
      const spots: Record<string, number | null> = {};
      const oliveCaveats = new Set<string>();
      for (const r of results) {
        if (!r) continue;
        allRows.push(...r.rows);
        allSignals.push(...r.signals);
        spots[r.underlying] = r.spot;
        for (const c of r.oliveCaveats) oliveCaveats.add(c);
      }

      const health: VenueHealthSnapshot = {
        venues: {
          derive: this.derive.getHealth(),
          olive: this.olive.getHealth(),
          ...Object.fromEntries(this.extraVenues.map((v) => [v.venue, v.getHealth()])),
        },
        serverTime: Date.now(),
        pollIntervalMs: this.cfg.pollIntervalMs,
        lastCycleMs: now,
        lastCycleDurationMs: Date.now() - t0,
      };
      for (const [u, s] of Object.entries(spots)) {
        if (s != null) this.lastCycleSpots.set(u, s);
      }

      try {
        // Persistence sampling: a full-chain cycle carries ~2.3k signals and
        // cycles run every ~15-20s — writing everything every cycle is ~9M
        // rows/day, far more than SQLite (or the history charts) need. Every
        // write is change-gated on the burst signature (0.2-vol chart
        // resolution + regime/flags/total): changed persist-worthy rows
        // (executable-direction opportunity/profitable with size —
        // isPersistWorthy) write at up to 1/min; changed non-worthy rows at
        // the 10-min sweep; UNCHANGED rows fall to 10-min (worthy) / 1-hour
        // (rest) staleness floors. Charts keep full resolution exactly where
        // the spread is moving and ≥1 point/hour everywhere else.
        const persistAll = now - this.lastFullPersistMs >= PERSIST_FULL_INTERVAL_MS;
        if (persistAll) this.lastFullPersistMs = now;
        const persistInteresting = persistAll || now - this.lastInterestingPersistMs >= PERSIST_INTERESTING_INTERVAL_MS;
        if (persistInteresting) this.lastInterestingPersistMs = now;
        const ivsByPair = new Map(
          allRows.map((r) => [
            r.pairKey,
            Object.fromEntries(Object.entries(r.legs).map(([v, leg]) => [v, leg?.quote?.iv ?? null])) as Partial<Record<Venue, number | null>>,
          ]),
        );
        const toRecord = (s: Signal) => ({
          ts: s.ts,
          pairKey: s.pairKey,
          underlying: s.underlying,
          spreadVols: s.ivSpreadVols,
          spreadBps: s.ivSpreadBps,
          deriveIv: ivsByPair.get(s.pairKey)?.derive ?? null,
          oliveIv: ivsByPair.get(s.pairKey)?.olive ?? null,
          ivs: ivsByPair.get(s.pairKey) ?? {},
          buyVenue: s.buyVenue,
          sellVenue: s.sellVenue,
          edgeUsdc: s.edgeUsdc,
          netAfterCapitalUsdc: s.netAfterCapitalUsdc,
          totalNetUsdc: s.totalNetUsdc,
          roiApyPct: s.roiApyPct,
          maxSize: s.maxExecutableSize,
          costsUsdc: s.costsUsdc,
          score: s.score,
          isOpportunity: s.isOpportunity,
          isProfitable: s.isProfitable,
          flags: s.flags.join(','),
        });
        const toPersist: Signal[] = [];
        for (const s of allSignals) {
          const worthy = isPersistWorthy(s);
          if (!persistInteresting && !persistAll) continue; // worthy rows are considered 1×/min
          if (!worthy && !persistAll) continue; // the rest only on the 10-min sweep
          // Opportunity-but-unprofitable rows (the LP-only/unprofitable mass
          // on SOL/BTC/ETH) are context, not trade candidates — half cadence.
          if (worthy && !s.isProfitable && now - (this.lastBurstByPair.get(s.pairKey)?.ts ?? 0) < 2 * PERSIST_INTERESTING_INTERVAL_MS) {
            continue;
          }
          const sig = burstSignature(s);
          const prev = this.lastBurstByPair.get(s.pairKey);
          if (prev && prev.sig === sig && now - prev.ts < (worthy ? PERSIST_FULL_INTERVAL_MS : PERSIST_HARD_FLOOR_MS)) {
            continue;
          }
          this.lastBurstByPair.set(s.pairKey, { sig, ts: now });
          toPersist.push(s);
        }
        if (persistAll) {
          // Expired pairs must not linger in the gate map forever.
          for (const [key, entry] of this.lastBurstByPair) {
            if (now - entry.ts > 2 * PERSIST_HARD_FLOOR_MS) this.lastBurstByPair.delete(key);
          }
        }
        this.storage.recordSignals(toPersist.map(toRecord));
        for (const h of Object.values(health.venues)) if (h) this.storage.upsertHealth(h);
      } catch (err) {
        console.warn('[scheduler] persistence failed:', err instanceof Error ? err.message : err);
      }
      try {
        this.episodes.observe(allSignals, now);
      } catch (err) {
        console.warn('[scheduler] episode tracking failed:', err instanceof Error ? err.message : err);
      }

      this.fullRows = new Map(allRows.map((r) => [r.pairKey, r]));
      const payload: CyclePayload = {
        ts: Date.now(),
        durationMs: Date.now() - t0,
        rows: toLiteRows(allRows, { fees: feeModels(this.feeConfig()), spots, now, staleQuoteMs: this.staleQuoteMs() }),
        signals: allSignals,
        health,
        spots,
        realtime: this.olive.getRealtimeHealth(),
        oliveCaveats: [...oliveCaveats],
        config: {
          ivSpreadThresholdVols: this.cfg.ivSpreadThresholdVols,
          pollIntervalMs: this.cfg.pollIntervalMs,
          underlyings: this.cfg.underlyings,
          fees: {
            deriveTakerFeeBps: this.cfg.deriveTakerFeeBps,
            oliveFee: 'min(2.5 bps notional, 10% premium)',
            solanaFeeUsdc: this.cfg.solanaFeeUsdc,
            capitalBorrowRateApr: this.cfg.capitalBorrowRateApr,
          },
          volPinnedAt: this.olive.isVolLive() ? null : this.volPinnedAt,
        },
      };
      this.latest = payload;
      this.emit('cycle', payload);

      if (this.alerter) void this.alerter.process(allSignals);
    } finally {
      this.busy = false;
    }
  }

  private staleQuoteMs(): number {
    return Math.max(60_000, this.cfg.pollIntervalMs * 3);
  }

  private feeConfig() {
    return { deriveTakerFeeBps: this.cfg.deriveTakerFeeBps, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: this.cfg.solanaFeeUsdc };
  }

  private async processUnderlying(underlying: string, now: number): Promise<UnderlyingResult> {
    const rows: MatchRow[] = [];
    const signals: Signal[] = [];
    const oliveCaveats: string[] = [];

    const [instruments, oliveState, extraChains] = await Promise.all([
      this.derive.getInstruments(underlying).catch((err) => {
        console.warn(`[scheduler] Derive instruments ${underlying} failed:`, err instanceof Error ? err.message : err);
        return [];
      }),
      this.olive.getMarketState(underlying).catch((err) => {
        console.warn(`[scheduler] Olive state ${underlying} failed:`, err instanceof Error ? err.message : err);
        return null;
      }),
      // A failing extra venue only empties its own chain (its health says why).
      Promise.all(
        this.extraVenues.map(async (v) => {
          const chain = await v.getChain?.(underlying).catch((err) => {
            console.warn(`[scheduler] ${v.venue} chain ${underlying} failed:`, err instanceof Error ? err.message : err);
            return null;
          });
          return { venue: v.venue, instruments: chain?.instruments ?? [], quotes: new Map((chain?.quotes ?? []).map((q) => [q.instrumentId, q])) };
        }),
      ),
    ]);
    oliveCaveats.push(...(oliveState?.caveats ?? []));
    if (instruments.length === 0 && extraChains.every((c) => c.instruments.length === 0)) {
      return { underlying, rows, signals, spot: null, oliveCaveats };
    }

    const expiryDates = [...new Set(instruments.map((i) => i.expiryDate))].sort();
    const limited = this.cfg.deriveMaxExpiries > 0 ? expiryDates.slice(0, this.cfg.deriveMaxExpiries) : expiryDates;
    const quotes = new Map<string, OptionQuote>();
    for (const expiryDate of limited) {
      try {
        const qs = await this.derive.getTickers(underlying, expiryDate);
        for (const q of qs) quotes.set(q.instrumentId, q);
      } catch (err) {
        console.warn(`[scheduler] Derive tickers ${underlying} ${expiryDate} failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Underlying spot: a venue index price (Derive first), else Olive's own feeds.
    let spot: number | null = null;
    for (const q of [...quotes.values(), ...extraChains.flatMap((c) => [...c.quotes.values()])]) {
      if (q.indexPrice != null) {
        spot = q.indexPrice;
        break;
      }
    }
    if (spot == null && oliveState?.spot != null) spot = oliveState.spot;

    // Olive spot: prefer a live reference. A stale on-chain oracle print
    // (keeper inactive) must never price the AMM leg against live Derive
    // quotes — a few % of spot mismatch fabricates huge false edges. When the
    // only Olive-native spot is stale, substitute Derive's index and flag it.
    if (oliveState && spot != null) {
      const usingStaleOracle = oliveState.caveats?.includes('spot_from_stale_onchain_oracle') ?? false;
      if (oliveState.spot == null || usingStaleOracle) {
        oliveState.spot = spot;
        oliveState.caveats = [
          ...new Set(
            (oliveState.caveats ?? [])
              .filter((c) => c !== 'spot_from_stale_onchain_oracle')
              .concat('spot_from_derive_index'),
          ),
        ];
        // The pre-substitution caveat was captured above — retract it here so
        // the UI banner reflects what is actually in effect.
        const idx = oliveCaveats.indexOf('spot_from_stale_onchain_oracle');
        if (idx >= 0) oliveCaveats.splice(idx, 1);
        oliveCaveats.push('spot_from_derive_index');
      }
    }

    const matched = matchChain({
      now,
      underlying,
      chains: [{ venue: 'derive', instruments: instruments.filter((i) => limited.includes(i.expiryDate)), quotes }, ...extraChains],
      synthesizers: [
        {
          venue: 'olive',
          maxTenorMs: this.cfg.oliveMaxTenorDays * 86_400_000,
          quote: (strike, expiryTs, kind) => this.olive.getAmmQuote(underlying, strike, expiryTs, kind, now, oliveState),
        },
      ],
      config: {
        expiryToleranceMs: this.cfg.matchExpiryToleranceDays * 86_400_000,
        maxStrikeRelDist: this.cfg.matchMaxStrikeRelDist,
      },
    });
    // Informational surface flags on each venue's own smile/term structure;
    // copies, since adapters may cache the quote objects.
    const matchedByKey = new Map(matched.map((r) => [r.pairKey, r]));
    for (const [pairKey, byVenue] of surfaceFlags(matched, now)) {
      const row = matchedByKey.get(pairKey);
      for (const [v, flags] of byVenue) {
        const leg = row?.legs[v];
        if (leg?.quote) leg.quote = { ...leg.quote, flags: [...(leg.quote.flags ?? []), ...flags] };
      }
    }
    rows.push(...matched);

    const signalCfg = {
          ivSpreadThresholdVols: this.cfg.ivSpreadThresholdVols,
          minBookSize: this.cfg.minBookSize,
          maxRelBookWidth: this.cfg.maxRelBookWidth,
          nearExpiryDays: this.cfg.nearExpiryDays,
          staleQuoteMs: this.staleQuoteMs(),
          ...this.feeConfig(),
          capitalBorrowRateApr: this.cfg.capitalBorrowRateApr,
          // Live pool capacity from the market file wins; config pins are the fallback.
          poolLiquidityUsdByAsset: (() => {
            const map = { ...this.cfg.olivePoolLiquidityUsd };
            const live = oliveState ? this.olive.getCachedLiquidity?.(underlying) : null;
            if (live != null) map[underlying] = live;
            return map;
          })(),
          // Per-custody free balances (calls: underlying, puts: USDC) — the
          // real per-kind caps; absent when the market file is unreachable.
          poolCustodyByAsset: (() => {
            const cap = oliveState ? this.olive.getCachedCapacity(underlying) : null;
            return cap ? { [underlying]: cap } : {};
          })(),
        };
    const spots = { [underlying]: spot };
    let computed = computeSignals(matched, signalCfg, now, spots);

    // Size top-up: venues whose chain read carries no sizes re-read only the
    // legs of pairs that net positive per contract, then those rows re-price.
    const enrichers = this.extraVenues.filter((v) => v.enrichQuotes);
    if (enrichers.length > 0) {
      const rowsByKey = new Map(matched.map((r) => [r.pairKey, r]));
      const touched = new Set<string>();
      for (const v of enrichers) {
        const candidates = computed
          .flatMap((s) => [s, ...(s.alternatives ?? [])].map((p) => ({ s, p })))
          .filter(({ p }) => (p.buyVenue === v.venue || p.sellVenue === v.venue) && (p.netAfterCapitalUsdc ?? 0) > 0)
          // Only pairs a size could matter for: two-leg executable, no blocking flag besides the reference one.
          .filter(({ p }) => !p.flags.includes('direction_limited') && !p.flags.some((fl) => fl !== 'reference_venue' && HEADLINE_BLOCKING_FLAGS.has(fl)))
          .sort((a, b) => (b.p.netAfterCapitalUsdc ?? 0) - (a.p.netAfterCapitalUsdc ?? 0));
        const quotes = [...new Set(candidates.map(({ s }) => s.pairKey))]
          .map((k) => rowsByKey.get(k)?.legs[v.venue]?.quote)
          .filter((q): q is OptionQuote => q != null && q.bidSize == null && q.askSize == null);
        if (quotes.length === 0) continue;
        const enriched = await v.enrichQuotes!(quotes).catch(() => quotes);
        const byId = new Map(enriched.map((q) => [q.instrumentId, q]));
        for (const row of matched) {
          const leg = row.legs[v.venue];
          const q = leg?.quote ? byId.get(leg.quote.instrumentId) : undefined;
          if (leg && q && q !== leg.quote) {
            leg.quote = q;
            touched.add(row.pairKey);
          }
        }
      }
      if (touched.size > 0) {
        const repriced = new Map(computeSignals(matched.filter((r) => touched.has(r.pairKey)), signalCfg, now, spots).map((s) => [s.pairKey, s]));
        computed = computed.flatMap((s) => (touched.has(s.pairKey) ? (repriced.has(s.pairKey) ? [repriced.get(s.pairKey)!] : []) : [s]));
      }
    }
    signals.push(...computed);

    return { underlying, rows, signals, spot, oliveCaveats };
  }

  /** Chart payload: Derive quote smile + SVI curve vs Olive flat model vol. */
  async getSurface(underlying: string, expiryDate?: string): Promise<SurfacePayload> {
    const payload: SurfacePayload = {
      underlying,
      expiryDate: expiryDate ?? null,
      deriveQuotes: [],
      deriveSvi: [],
      oliveModelVol: null,
      oliveSpot: null,
      oliveBounds: null,
    };
    const rows = this.latest?.rows.filter((r) => r.underlying === underlying) ?? [];
    const expDate = expiryDate ?? rows[0]?.expiryDate ?? null;
    payload.expiryDate = expDate;
    for (const row of rows) {
      if (row.expiryDate !== expDate) continue;
      payload.deriveQuotes.push({
        strike: row.strike,
        kind: row.kind,
        iv: row.venues.derive?.iv ?? null,
        bid: row.venues.derive?.bid ?? null,
        ask: row.venues.derive?.ask ?? null,
      });
    }
    try {
      const slices = await this.derive.getSVISlices(underlying);
      const slice =
        slices.find((s) => new Date(s.expiryTs).toISOString().slice(0, 10).replace(/-/g, '') === expDate) ??
        slices[0];
      if (slice) {
        payload.deriveSvi = sampleSviSlice(slice).map((p) => ({ strike: p.strike, iv: p.iv }));
      }
    } catch {
      // SVI is decorative for the chart; quotes may suffice
    }
    const state = await this.olive.getMarketState(underlying).catch(() => null);
    payload.oliveModelVol = state?.modelVol ?? null;
    // Prefer the spot the current cycle actually used for synthesis so the
    // chart's reference line can't diverge from it via state-cache expiry.
    payload.oliveSpot = this.latest?.spots[underlying] ?? state?.spot ?? null;
    if (payload.expiryDate) {
      const ts = Date.UTC(
        Number(payload.expiryDate.slice(0, 4)),
        Number(payload.expiryDate.slice(4, 6)) - 1,
        Number(payload.expiryDate.slice(6, 8)),
        8,
      );
      payload.oliveBounds = this.olive.getBounds(underlying, ts);
    }
    return payload;
  }
}
