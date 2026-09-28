import { EventEmitter } from 'node:events';
import {
  sampleSviSlice,
  type MatchRow,
  type MatchRowLite,
  type OptionQuote,
  type Signal,
  type VenueHealthSnapshot,
} from '@options-arb/shared';
import type { AppConfig } from './config';
import type { DeriveAdapter } from './adapters/derive';
import type { OliveAdapter } from './adapters/olive';
import { matchChain } from './matching/engine';
import { computeSignals } from './signals/engine';
import type { ObservationRecord, Storage } from './storage';
import type { Alerter } from './alerts';

/** Compact projection for the WS push — full rows stay server-side. */
export function toLiteRows(rows: MatchRow[]): MatchRowLite[] {
  return rows.map((r) => ({
    pairKey: r.pairKey,
    underlying: r.underlying,
    expiryTs: r.expiryTs,
    expiryDate: r.expiryDate,
    strike: r.strike,
    kind: r.kind,
    matchType: r.matchType,
    deriveIv: r.derive.quote?.iv ?? null,
    oliveIv: r.olive.quote?.iv ?? null,
    deriveBid: r.derive.quote?.bid ?? null,
    deriveAsk: r.derive.quote?.ask ?? null,
    olivePremium: r.olive.quote?.mark ?? null,
    note: r.olive.note,
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
  realtime: { status: string; lastFrameAgeMs: number | null; assets: string[] } | null;
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
  observations: ObservationRecord[];
  spot: number | null;
  oliveCaveats: string[];
}

/** At most one realtime-triggered early cycle per 30 s (Derive rate budget). */
const EARLY_CYCLE_COOLDOWN_MS = 30_000;
/** Full-sweep persistence cadence — see the sampling note in runOnce(). */
const PERSIST_FULL_INTERVAL_MS = 10 * 60_000;
/** Min spacing between "interesting row" persistence bursts. */
const PERSIST_INTERESTING_INTERVAL_MS = 60_000;

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
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly derive: DeriveAdapter,
    private readonly olive: OliveAdapter,
    private readonly storage: Storage,
    private readonly alerter?: Alerter,
  ) {
    super();
    // Static vol pins age — surface when they were set so the UI can nag.
    this.volPinnedAt = Object.keys(cfg.oliveVolOverrides).length > 0 ? Date.now() : null;
  }

  private readonly volPinnedAt: number | null;

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.cfg.pollIntervalMs);
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    this.spotUnsub?.();
    this.spotUnsub = null;
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
      const observations: ObservationRecord[] = [];
      const spots: Record<string, number | null> = {};
      const oliveCaveats = new Set<string>();
      for (const r of results) {
        if (!r) continue;
        allRows.push(...r.rows);
        allSignals.push(...r.signals);
        observations.push(...r.observations);
        spots[r.underlying] = r.spot;
        for (const c of r.oliveCaveats) oliveCaveats.add(c);
      }

      const health: VenueHealthSnapshot = {
        derive: this.derive.getHealth(),
        olive: this.olive.getHealth(),
        serverTime: Date.now(),
        pollIntervalMs: this.cfg.pollIntervalMs,
        lastCycleMs: now,
        lastCycleDurationMs: Date.now() - t0,
      };
      for (const [u, s] of Object.entries(spots)) {
        if (s != null) this.lastCycleSpots.set(u, s);
      }

      try {
        // Persistence sampling: a full-chain cycle carries ~7k rows and cycles
        // run every ~15-20s — writing everything every cycle is ~34M rows/day,
        // which a single SQLite file cannot absorb at 30-day retention.
        // Rows worth charting at high resolution (opportunity/profitable with
        // non-zero executable size) persist at most once per minute; the full
        // sweep persists every PERSIST_FULL_INTERVAL_MS. History charts keep
        // ≥1 point/10min for every pair and ~1/min for live candidates.
        const persistAll = now - this.lastFullPersistMs >= PERSIST_FULL_INTERVAL_MS;
        if (persistAll) this.lastFullPersistMs = now;
        const persistInteresting = persistAll || now - this.lastInterestingPersistMs >= PERSIST_INTERESTING_INTERVAL_MS;
        if (persistInteresting) this.lastInterestingPersistMs = now;
        const isInteresting = (s: typeof allSignals[number]) =>
          (s.isOpportunity || s.isProfitable) && s.maxExecutableSize !== 0 && s.maxExecutableSize != null;
        if (persistAll) {
          this.storage.recordObservations(observations);
        } else if (persistInteresting) {
          const activePairs = new Set(allSignals.filter(isInteresting).map((s) => s.pairKey));
          this.storage.recordObservations(observations.filter((o) => o.pairKey != null && activePairs.has(o.pairKey)));
        }
        const ivsByPair = new Map(
          allRows.map((r) => [r.pairKey, { d: r.derive.quote?.iv ?? null, o: r.olive.quote?.iv ?? null }]),
        );
        this.storage.recordSignals(
          allSignals
            .filter((s) => persistAll || (persistInteresting && isInteresting(s)))
            .map((s) => ({
              ts: s.ts,
              pairKey: s.pairKey,
              underlying: s.underlying,
              spreadVols: s.ivSpreadVols,
              spreadBps: s.ivSpreadBps,
              deriveIv: ivsByPair.get(s.pairKey)?.d ?? null,
              oliveIv: ivsByPair.get(s.pairKey)?.o ?? null,
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
            })),
        );
        this.storage.upsertHealth(health.derive);
        this.storage.upsertHealth(health.olive);
      } catch (err) {
        console.warn('[scheduler] persistence failed:', err instanceof Error ? err.message : err);
      }

      this.fullRows = new Map(allRows.map((r) => [r.pairKey, r]));
      const payload: CyclePayload = {
        ts: Date.now(),
        durationMs: Date.now() - t0,
        rows: toLiteRows(allRows),
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

  private async processUnderlying(underlying: string, now: number): Promise<UnderlyingResult> {
    const rows: MatchRow[] = [];
    const signals: Signal[] = [];
    const observations: ObservationRecord[] = [];
    const oliveCaveats: string[] = [];

    const [instruments, oliveState] = await Promise.all([
      this.derive.getInstruments(underlying).catch((err) => {
        console.warn(`[scheduler] Derive instruments ${underlying} failed:`, err instanceof Error ? err.message : err);
        return [];
      }),
      this.olive.getMarketState(underlying).catch((err) => {
        console.warn(`[scheduler] Olive state ${underlying} failed:`, err instanceof Error ? err.message : err);
        return null;
      }),
    ]);
    oliveCaveats.push(...(oliveState?.caveats ?? []));
    if (instruments.length === 0) {
      return { underlying, rows, signals, observations, spot: null, oliveCaveats };
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

    // Underlying spot: venue index price, else Olive's own feeds.
    let spot: number | null = null;
    for (const q of quotes.values()) {
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
      deriveInstruments: instruments.filter((i) => limited.includes(i.expiryDate)),
      deriveQuotes: quotes,
      oliveQuoteProvider: (strike, expiryTs, kind) =>
        this.olive.getAmmQuote(underlying, strike, expiryTs, kind, now, oliveState),
      config: {
        expiryToleranceMs: this.cfg.matchExpiryToleranceDays * 86_400_000,
        maxStrikeRelDist: this.cfg.matchMaxStrikeRelDist,
        oliveMaxTenorMs: this.cfg.oliveMaxTenorDays * 86_400_000,
      },
    });
    rows.push(...matched);

    signals.push(
      ...computeSignals(
        matched,
        {
          ivSpreadThresholdVols: this.cfg.ivSpreadThresholdVols,
          minBookSize: this.cfg.minBookSize,
          maxRelBookWidth: this.cfg.maxRelBookWidth,
          nearExpiryDays: this.cfg.nearExpiryDays,
          staleQuoteMs: Math.max(60_000, this.cfg.pollIntervalMs * 3),
          deriveTakerFeeBps: this.cfg.deriveTakerFeeBps,
          oliveFeeNotionalBps: 2.5,
          oliveFeePremiumPct: 10,
          solanaFeeUsdc: this.cfg.solanaFeeUsdc,
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
        },
        now,
        { [underlying]: spot },
      ),
    );

    const pairKeyByInstrument = new Map<string, string>();
    for (const row of matched) {
      if (row.derive.instrumentId) pairKeyByInstrument.set(row.derive.instrumentId, row.pairKey);
      if (row.olive.instrumentId) pairKeyByInstrument.set(row.olive.instrumentId, row.pairKey);
    }
    for (const q of quotes.values()) {
      const parsed = q.instrumentId;
      observations.push({
        ts: now,
        venue: 'derive',
        underlying,
        expiryDate: parsed.split('-')[1] ?? '',
        strike: Number((parsed.split('-')[2] ?? '0').replace('_', '.')),
        kind: parsed.endsWith('-P') ? 'put' : 'call',
        pairKey: pairKeyByInstrument.get(parsed) ?? null,
        iv: q.iv,
        mark: q.mark,
        bid: q.bid,
        ask: q.ask,
        bidSize: q.bidSize,
        askSize: q.askSize,
        source: q.source,
      });
    }
    for (const row of matched) {
      const oq = row.olive.quote;
      if (!oq) continue;
      observations.push({
        ts: now,
        venue: 'olive',
        underlying,
        expiryDate: row.expiryDate,
        strike: row.strike,
        kind: row.kind,
        pairKey: row.pairKey,
        iv: oq.iv,
        mark: oq.mark,
        bid: oq.bid,
        ask: oq.ask,
        bidSize: oq.bidSize,
        askSize: oq.askSize,
        source: oq.source,
      });
    }

    return { underlying, rows, signals, observations, spot, oliveCaveats };
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
        iv: row.deriveIv,
        bid: row.deriveBid,
        ask: row.deriveAsk,
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
