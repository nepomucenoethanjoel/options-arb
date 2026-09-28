import type { VenueHealth } from '@options-arb/shared';

export interface ObservationRecord {
  ts: number;
  venue: 'derive' | 'olive';
  underlying: string;
  expiryDate: string;
  strike: number;
  kind: string;
  pairKey: string | null;
  iv: number | null;
  mark: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  source: string;
}

export interface SignalRecord {
  ts: number;
  pairKey: string;
  underlying: string;
  spreadVols: number | null;
  spreadBps: number | null;
  deriveIv: number | null;
  oliveIv: number | null;
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
}

/**
 * Persistence seam — implemented by SqliteStorage today; a later
 * Postgres/Timescale swap only needs to implement this interface.
 */
export interface Storage {
  recordObservations(rows: ObservationRecord[]): void;
  recordSignals(rows: SignalRecord[]): void;
  upsertHealth(h: VenueHealth): void;
  getSpreadHistory(pairKey: string, sinceTs: number): SpreadHistoryPoint[];
  countObservations(): number;
  prune(olderThanTs: number): void;
  close(): void;
}
