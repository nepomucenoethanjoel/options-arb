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

/** Position after the last row of a page (the table's sort key). */
export interface EpisodeCursor {
  startTs: number;
  endTs: number;
  id: number;
}

export interface EpisodeBatch {
  rows: EpisodeRecord[];
  /** Cursor for the next page, or null when this page was the last. */
  next: EpisodeCursor | null;
}

export interface EpisodeSummaryRow {
  tier: EpisodeTier;
  underlying: string;
  buyVenue: Venue;
  sellVenue: Venue;
  count: number;
  /** How many of `count` lasted a single cycle (flicker, or a one-tick quote). */
  oneCycleCount: number;
  /** Episodes of one contract separated by a short flicker gap, counted once (see EpisodeSummarizer). */
  mergedCount: number;
  /** Merged episodes lasting 10+ minutes with a peak of $5+ honest — the slice a person could act on. */
  sustainedCount: number;
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
  /** Materializes every match: only for small windows and tests. The API reads in batches. */
  getEpisodes(sinceTs: number): EpisodeRecord[];
  /**
   * One page of episodes ending at or after sinceTs, in ascending (startTs, endTs, id) order, after the
   * cursor of the previous page (null = from the start). The table gains ~65k rows/day; materializing a
   * week of them overran the 256 MB heap, and one long synchronous pass froze the server for 7-14 s on
   * the VPS. Each page is a complete query, so callers can yield between pages.
   */
  readEpisodeBatch(sinceTs: number, after: EpisodeCursor | null, limit: number): EpisodeBatch;
  prune(olderThanTs: number): void;
  close(): void;
}
