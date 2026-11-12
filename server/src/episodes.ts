import { HEADLINE_BLOCKING_FLAGS, honestTotalNetUsdc, type ParitySignal, type Signal, type Venue } from '@options-arb/shared';
import type { EpisodeRecord, EpisodeSummaryRow, EpisodeTier, Storage } from './storage';

/** The fields a tier decision needs — present on both a Signal and its alternatives. */
interface PairResult {
  buyVenue: Venue | null;
  sellVenue: Venue | null;
  netAfterCapitalUsdc: number | null;
  totalNetUsdc: number | null;
  honestTotalNetUsdc: number | null;
  maxExecutableSize: number | null;
  flags: string[];
}

/**
 * Which kind of gap a venue pair shows this cycle, or null for none.
 *  - headline: what the KPI counts (honest clip total > 0, clean, two-leg executable).
 *  - reference: would be headline but a leg is on a reference-only venue.
 *  - quote_only: quoted clip total > 0 on clean books, but the fill model
 *    prices the clip at ≤ 0 (the quoted gap a trade erases).
 */
export function classifyPair(p: PairResult): EpisodeTier | null {
  if (p.buyVenue == null || p.sellVenue == null || p.flags.includes('direction_limited')) return null;
  if (p.netAfterCapitalUsdc == null || p.netAfterCapitalUsdc <= 0) return null;
  if (p.totalNetUsdc == null || p.totalNetUsdc <= 0) return null;
  if (p.flags.some((f) => f !== 'reference_venue' && HEADLINE_BLOCKING_FLAGS.has(f))) return null;
  const reference = p.flags.includes('reference_venue');
  if (p.honestTotalNetUsdc != null && p.honestTotalNetUsdc > 0) return reference ? 'reference' : 'headline';
  return reference ? null : 'quote_only';
}

function pairsOf(s: Signal): PairResult[] {
  return [
    { ...s, honestTotalNetUsdc: honestTotalNetUsdc(s) },
    ...(s.alternatives ?? []),
  ];
}

interface OpenEpisode extends EpisodeRecord {
  seenCycle: number;
}

/**
 * Tracks how long each venue-pair gap lasts at cycle resolution. Persisted
 * signal history is change-gated (not a uniform sample) and lacks expected
 * totals, so durations can only be measured live. An episode closes on the
 * first cycle the gap is absent and is written once, on close.
 */
export class EpisodeTracker {
  private open = new Map<string, OpenEpisode>();
  private cycle = 0;

  constructor(private readonly storage: Pick<Storage, 'recordEpisodes'>) {}

  observe(signals: Signal[], ts: number, parity: ParitySignal[] = []): void {
    this.cycle++;
    for (const s of signals) {
      for (const p of pairsOf(s)) {
        const tier = classifyPair(p);
        if (!tier) continue;
        this.see(`${s.pairKey}|${p.buyVenue}|${p.sellVenue}|${tier}`, ts, {
          pairKey: s.pairKey, underlying: s.underlying, buyVenue: p.buyVenue!, sellVenue: p.sellVenue!, tier,
          honest: p.honestTotalNetUsdc ?? 0, quoted: p.totalNetUsdc ?? 0, size: p.maxExecutableSize,
        });
      }
    }
    // Parity gaps are measured PER CONTRACT (the hedge future's size is not read).
    for (const p of parity) {
      if (!(p.netPerUnitUsdc > 0) || p.flags.some((f) => HEADLINE_BLOCKING_FLAGS.has(f) && f !== 'reference_venue')) continue;
      const [buyVenue, sellVenue] = p.strategy === 'conversion' ? [p.callVenue, p.putVenue] : [p.putVenue, p.callVenue];
      this.see(`${p.key}|${buyVenue}|${sellVenue}|parity`, ts, {
        pairKey: p.key, underlying: p.underlying, buyVenue, sellVenue, tier: 'parity',
        honest: p.netPerUnitUsdc, quoted: p.netPerUnitUsdc, size: p.size,
      });
    }
    const closed: EpisodeRecord[] = [];
    for (const [key, e] of this.open) {
      if (e.seenCycle === this.cycle) continue;
      this.open.delete(key);
      closed.push(strip(e));
    }
    if (closed.length > 0) this.storage.recordEpisodes(closed);
  }

  private see(
    key: string,
    ts: number,
    o: { pairKey: string; underlying: string; buyVenue: Venue; sellVenue: Venue; tier: EpisodeTier; honest: number; quoted: number; size: number | null },
  ): void {
    const e = this.open.get(key);
    if (e) {
      e.endTs = ts;
      e.cycles++;
      e.seenCycle = this.cycle;
      if (o.honest > e.peakHonestUsdc) {
        e.peakHonestUsdc = o.honest;
        e.peakQuotedUsdc = o.quoted;
        e.peakSize = o.size;
      }
      return;
    }
    this.open.set(key, {
      pairKey: o.pairKey,
      underlying: o.underlying,
      buyVenue: o.buyVenue,
      sellVenue: o.sellVenue,
      tier: o.tier,
      startTs: ts,
      endTs: ts,
      peakHonestUsdc: o.honest,
      peakQuotedUsdc: o.quoted,
      peakSize: o.size,
      cycles: 1,
      seenCycle: this.cycle,
    });
  }

  /** Close everything still open (shutdown) — an episode cut short is still evidence. */
  flush(): void {
    const all = [...this.open.values()].map(strip);
    this.open.clear();
    if (all.length > 0) this.storage.recordEpisodes(all);
  }

  /** Episodes still running (not yet written) — included in summaries so a live gap is not invisible. */
  snapshotOpen(): EpisodeRecord[] {
    return [...this.open.values()].map(strip);
  }
}

function strip({ seenCycle: _seen, ...rest }: OpenEpisode): EpisodeRecord {
  return rest;
}

/** k-th smallest of a histogram {value -> count} with the same index rule as indexing a sorted array. */
function histQuantile(hist: Map<number, number>, n: number, q: number): number {
  if (n === 0) return 0;
  let k = Math.min(n - 1, Math.floor(q * n));
  for (const v of [...hist.keys()].sort((a, b) => a - b)) {
    const m = hist.get(v)!;
    if (k < m) return v;
    k -= m;
  }
  return 0;
}

interface GroupAcc {
  first: EpisodeRecord;
  count: number;
  cycleHist: Map<number, number>;
  maxCycles: number;
  best: EpisodeRecord;
  windows: number;
  windowPeakSum: number;
  windowPeak: number;
  windowEnd: number;
}

/**
 * Per (tier, underlying, venue pair): how often a gap appeared, how long it lasted (cycles), what it peaked at.
 *
 * Streaming: folds one episode at a time into running totals, so memory is bounded by the number of
 * routes, not episodes (the table gains ~65k rows/day; materializing a week of them crashed the 256 MB
 * heap). Episodes must arrive in ascending startTs order.
 *
 * Episodes of one route that overlap in time (or follow on the next cycle, within joinGapMs) are one
 * window: they share pools and books, so taking one clip closes the rest. Σ = best peak per window — not
 * a sum over contracts. Ties for `best` go to the earliest start.
 */
export class EpisodeSummarizer {
  private readonly groups = new Map<string, GroupAcc>();

  constructor(private readonly joinGapMs = 0) {}

  add(e: EpisodeRecord): void {
    const k = `${e.tier}|${e.underlying}|${e.buyVenue}|${e.sellVenue}`;
    let g = this.groups.get(k);
    if (!g) {
      g = { first: e, count: 0, cycleHist: new Map(), maxCycles: 0, best: e, windows: 0, windowPeakSum: 0, windowPeak: 0, windowEnd: -Infinity };
      this.groups.set(k, g);
    }
    g.count++;
    g.cycleHist.set(e.cycles, (g.cycleHist.get(e.cycles) ?? 0) + 1);
    if (e.cycles > g.maxCycles) g.maxCycles = e.cycles;
    if (e.peakHonestUsdc > g.best.peakHonestUsdc) g.best = e;
    if (e.startTs > g.windowEnd + this.joinGapMs) {
      g.windowPeakSum += g.windowPeak;
      g.windows++;
      g.windowPeak = 0;
    }
    g.windowPeak = Math.max(g.windowPeak, e.peakHonestUsdc);
    g.windowEnd = Math.max(g.windowEnd, e.endTs);
  }

  rows(): EpisodeSummaryRow[] {
    const out: EpisodeSummaryRow[] = [];
    for (const g of this.groups.values()) {
      out.push({
        tier: g.first.tier,
        underlying: g.first.underlying,
        buyVenue: g.first.buyVenue,
        sellVenue: g.first.sellVenue,
        count: g.count,
        medianCycles: histQuantile(g.cycleHist, g.count, 0.5),
        p90Cycles: histQuantile(g.cycleHist, g.count, 0.9),
        maxCycles: g.maxCycles,
        windows: g.windows,
        sumWindowPeakUsdc: Math.round((g.windowPeakSum + g.windowPeak) * 100) / 100,
        best: g.best,
      });
    }
    const tierOrder: Record<EpisodeTier, number> = { headline: 0, parity: 1, reference: 2, quote_only: 3 };
    return out.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.count - a.count);
  }
}

/** Summary over an in-memory list (tests, small windows). Sorts by start; see EpisodeSummarizer. */
export function summarizeEpisodes(episodes: EpisodeRecord[], joinGapMs = 0): EpisodeSummaryRow[] {
  const s = new EpisodeSummarizer(joinGapMs);
  for (const e of [...episodes].sort((a, b) => a.startTs - b.startTs)) s.add(e);
  return s.rows();
}

/**
 * Summary over the stored episodes without materializing them: `stored` must yield ascending startTs
 * (SqliteStorage.iterateEpisodes) and is consumed lazily; the few still-open episodes are merged in by
 * start time, stored first on ties.
 */
export function summarizeEpisodeStream(stored: Iterable<EpisodeRecord>, open: EpisodeRecord[], joinGapMs = 0): EpisodeSummaryRow[] {
  const s = new EpisodeSummarizer(joinGapMs);
  const pending = [...open].sort((a, b) => a.startTs - b.startTs);
  let i = 0;
  for (const e of stored) {
    while (i < pending.length && pending[i]!.startTs < e.startTs) s.add(pending[i++]!);
    s.add(e);
  }
  while (i < pending.length) s.add(pending[i++]!);
  return s.rows();
}
