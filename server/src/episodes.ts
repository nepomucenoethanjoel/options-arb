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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Per (tier, underlying, venue pair): how often a gap appeared, how long it lasted (cycles), what it peaked at. */
/**
 * Episodes of one route that overlap in time (or follow on the next cycle,
 * within joinGapMs) are one window: they share pools and books, so taking one
 * clip closes the rest. Σ = best peak per window — not a sum over contracts.
 */
function windowPeaks(g: EpisodeRecord[], joinGapMs: number): number[] {
  const peaks: number[] = [];
  let end = -Infinity;
  for (const e of [...g].sort((a, b) => a.startTs - b.startTs)) {
    if (e.startTs > end + joinGapMs) peaks.push(0);
    peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1]!, e.peakHonestUsdc);
    end = Math.max(end, e.endTs);
  }
  return peaks;
}

export function summarizeEpisodes(episodes: EpisodeRecord[], joinGapMs = 0): EpisodeSummaryRow[] {
  const groups = new Map<string, EpisodeRecord[]>();
  for (const e of episodes) {
    const k = `${e.tier}|${e.underlying}|${e.buyVenue}|${e.sellVenue}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const out: EpisodeSummaryRow[] = [];
  for (const g of groups.values()) {
    const cycles = g.map((e) => e.cycles).sort((a, b) => a - b);
    const best = g.reduce((a, b) => (b.peakHonestUsdc > a.peakHonestUsdc ? b : a));
    out.push({
      tier: g[0]!.tier,
      underlying: g[0]!.underlying,
      buyVenue: g[0]!.buyVenue,
      sellVenue: g[0]!.sellVenue,
      count: g.length,
      medianCycles: quantile(cycles, 0.5),
      p90Cycles: quantile(cycles, 0.9),
      maxCycles: cycles[cycles.length - 1]!,
      windows: windowPeaks(g, joinGapMs).length,
      sumWindowPeakUsdc: Math.round(windowPeaks(g, joinGapMs).reduce((a, p) => a + Math.max(0, p), 0) * 100) / 100,
      best,
    });
  }
  const tierOrder: Record<EpisodeTier, number> = { headline: 0, parity: 1, reference: 2, quote_only: 3 };
  return out.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.count - a.count);
}
