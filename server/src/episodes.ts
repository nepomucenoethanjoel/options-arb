import { HEADLINE_BLOCKING_FLAGS, honestTotalNetUsdc, type Signal, type Venue } from '@options-arb/shared';
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

  observe(signals: Signal[], ts: number): void {
    this.cycle++;
    for (const s of signals) {
      for (const p of pairsOf(s)) {
        const tier = classifyPair(p);
        if (!tier) continue;
        const key = `${s.pairKey}|${p.buyVenue}|${p.sellVenue}|${tier}`;
        const honest = p.honestTotalNetUsdc ?? 0;
        const e = this.open.get(key);
        if (e) {
          e.endTs = ts;
          e.cycles++;
          e.seenCycle = this.cycle;
          if (honest > e.peakHonestUsdc) {
            e.peakHonestUsdc = honest;
            e.peakQuotedUsdc = p.totalNetUsdc ?? 0;
            e.peakSize = p.maxExecutableSize;
          }
        } else {
          this.open.set(key, {
            pairKey: s.pairKey,
            underlying: s.underlying,
            buyVenue: p.buyVenue!,
            sellVenue: p.sellVenue!,
            tier,
            startTs: ts,
            endTs: ts,
            peakHonestUsdc: honest,
            peakQuotedUsdc: p.totalNetUsdc ?? 0,
            peakSize: p.maxExecutableSize,
            cycles: 1,
            seenCycle: this.cycle,
          });
        }
      }
    }
    const closed: EpisodeRecord[] = [];
    for (const [key, e] of this.open) {
      if (e.seenCycle === this.cycle) continue;
      this.open.delete(key);
      closed.push(strip(e));
    }
    if (closed.length > 0) this.storage.recordEpisodes(closed);
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
export function summarizeEpisodes(episodes: EpisodeRecord[]): EpisodeSummaryRow[] {
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
      sumPeakHonestUsdc: Math.round(g.reduce((a, e) => a + Math.max(0, e.peakHonestUsdc), 0) * 100) / 100,
      best,
    });
  }
  const tierOrder: Record<EpisodeTier, number> = { headline: 0, parity: 1, reference: 2, quote_only: 3 };
  return out.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.count - a.count);
}
