import type { Venue, VenueHealth } from '@options-arb/shared';

export interface SignalRecord {
  ts: number;
  pairKey: string;
  underlying: string;
  spreadVols: number | null;
  spreadBps: number | null;
  deriveIv: number | null;
  oliveIv: number | null;
  /** Every venue's IV for this contract (derive/olive columns kept for chart continuity). */
  ivs: Partial<Record<Venue, number | null>>;
  buyVenue: Venue | null;
  sellVenue: Venue | null;
  edgeUsdc: number | null;
  netAfterCapitalUsdc: number | null;
  totalNetUsdc: number | null;
  roiApyPct: number | null;
  maxSize: number | null;
  costsUsdc: number | null;
  score: number | null;
  isOpportunity: boolean;
  isProfitable: boolean;
  flags: string;
}

export interface SpreadHistoryPoint {
  ts: number;
  spreadVols: number | null;
  deriveIv: number | null;
  oliveIv: number | null;
  /** Per-venue IVs; rows written before multi-venue carry only derive/olive. */
  ivs: Partial<Record<Venue, number | null>>;
  buyVenue: Venue | null;
  sellVenue: Venue | null;
}

export type EpisodeTier = 'headline' | 'reference' | 'quote_only' | 'parity';

/** One continuous run of cycles in which a venue pair showed a gap of a tier. */
export interface EpisodeRecord {
  pairKey: string;
  underlying: string;
  buyVenue: Venue;
  sellVenue: Venue;
  tier: EpisodeTier;
  startTs: number;
  /** Last cycle the gap was seen (equals startTs for a one-cycle episode). */
  endTs: number;
  peakHonestUsdc: number;
  peakQuotedUsdc: number;
  peakSize: number | null;
  cycles: number;
}

export interface EpisodeSummaryRow {
  tier: EpisodeTier;
  underlying: string;
  buyVenue: Venue;
  sellVenue: Venue;
  count: number;
  medianCycles: number;
  p90Cycles: number;
  maxCycles: number;
  /** Overlapping / back-to-back episodes merged (see summarizeEpisodes). */
  windows: number;
  /** Best peak honest per window, summed — at most one clip per window. */
  sumWindowPeakUsdc: number;
  best: EpisodeRecord;
}

/**
 * Persistence seam — implemented by SqliteStorage today; a later
 * Postgres/Timescale swap only needs to implement this interface.
 * Signals only: the write-only observations archive was removed 2026-09-28
 * (nothing read it; the spread-history charts live on the signals table).
 */
export interface Storage {
  recordSignals(rows: SignalRecord[]): void;
  upsertHealth(h: VenueHealth): void;
  getSpreadHistory(pairKey: string, sinceTs: number): SpreadHistoryPoint[];
  countSignals(): number;
  recordEpisodes(rows: EpisodeRecord[]): void;
  getEpisodes(sinceTs: number): EpisodeRecord[];
  prune(olderThanTs: number): void;
  close(): void;
}
