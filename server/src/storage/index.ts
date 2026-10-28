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
  prune(olderThanTs: number): void;
  close(): void;
}
