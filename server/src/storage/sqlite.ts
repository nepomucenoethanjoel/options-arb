import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VenueHealth } from '@options-arb/shared';
import type { ObservationRecord, SignalRecord, SpreadHistoryPoint, Storage } from './index';

/**
 * SQLite-backed Storage using Node's built-in `node:sqlite` (no native addon
 * to compile). WAL mode keeps concurrent reads cheap while the scheduler
 * writes each cycle.
 */
export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  private readonly insertObservation;
  private readonly insertSignal;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        ts INTEGER NOT NULL,
        venue TEXT NOT NULL,
        underlying TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        strike REAL NOT NULL,
        kind TEXT NOT NULL,
        pair_key TEXT,
        iv REAL, mark REAL, bid REAL, ask REAL, bid_size REAL, ask_size REAL,
        source TEXT NOT NULL,
        PRIMARY KEY (ts, venue, underlying, expiry_date, strike, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_obs_pair ON observations(pair_key, ts);
      CREATE INDEX IF NOT EXISTS idx_obs_u ON observations(underlying, ts);
      CREATE TABLE IF NOT EXISTS signals (
        ts INTEGER NOT NULL,
        pair_key TEXT NOT NULL,
        underlying TEXT NOT NULL,
        spread_vols REAL, spread_bps REAL, derive_iv REAL, olive_iv REAL,
        edge_usdc REAL, net_usdc REAL, total_net_usdc REAL, roi_apy_pct REAL,
        max_size REAL, costs_usdc REAL, score REAL,
        is_opportunity INTEGER NOT NULL, is_profitable INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL,
        PRIMARY KEY (ts, pair_key)
      );
      CREATE INDEX IF NOT EXISTS idx_sig_pair ON signals(pair_key, ts);
      CREATE TABLE IF NOT EXISTS venue_health (
        source TEXT PRIMARY KEY,
        last_success_ts INTEGER, last_error TEXT
      );
    `);
    // Migrate before preparing statements that reference migrated columns.
    this.migrate();
    this.insertObservation = this.db.prepare(
      `INSERT OR REPLACE INTO observations
        (ts, venue, underlying, expiry_date, strike, kind, pair_key, iv, mark, bid, ask, bid_size, ask_size, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertSignal = this.db.prepare(
      `INSERT OR REPLACE INTO signals
        (ts, pair_key, underlying, spread_vols, spread_bps, derive_iv, olive_iv, edge_usdc,
         net_usdc, total_net_usdc, roi_apy_pct, max_size, costs_usdc, score,
         is_opportunity, is_profitable, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Additive column migration for DBs created before the profit-estimate fields. */
  private migrate(): void {
    const columns: Array<[string, string]> = [
      ['net_usdc', 'REAL'],
      ['total_net_usdc', 'REAL'],
      ['roi_apy_pct', 'REAL'],
      ['max_size', 'REAL'],
      ['is_profitable', 'INTEGER'],
    ];
    for (const [name, type] of columns) {
      try {
        this.db.exec(`ALTER TABLE signals ADD COLUMN ${name} ${type}`);
      } catch {
        // column already exists
      }
    }
  }

  recordObservations(rows: ObservationRecord[]): void {
    if (rows.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.insertObservation.run(
          r.ts, r.venue, r.underlying, r.expiryDate, r.strike, r.kind, r.pairKey,
          r.iv, r.mark, r.bid, r.ask, r.bidSize, r.askSize, r.source,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  recordSignals(rows: SignalRecord[]): void {
    if (rows.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.insertSignal.run(
          r.ts, r.pairKey, r.underlying, r.spreadVols, r.spreadBps, r.deriveIv, r.oliveIv, r.edgeUsdc,
          r.netAfterCapitalUsdc, r.totalNetUsdc, r.roiApyPct, r.maxSize, r.costsUsdc, r.score,
          r.isOpportunity ? 1 : 0, r.isProfitable ? 1 : 0, r.flags,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  upsertHealth(h: VenueHealth): void {
    this.db
      .prepare(
        `INSERT INTO venue_health (source, last_success_ts, last_error)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET last_success_ts = excluded.last_success_ts, last_error = excluded.last_error`,
      )
      .run(h.source, h.lastSuccessTs, h.lastError);
  }

  getSpreadHistory(pairKey: string, sinceTs: number): SpreadHistoryPoint[] {
    const rows = this.db
      .prepare(
        `SELECT ts, spread_vols, derive_iv, olive_iv FROM signals
         WHERE pair_key = ? AND ts >= ? ORDER BY ts ASC`,
      )
      .all(pairKey, sinceTs) as Array<{
      ts: number;
      spread_vols: number | null;
      derive_iv: number | null;
      olive_iv: number | null;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      spreadVols: r.spread_vols,
      deriveIv: r.derive_iv,
      oliveIv: r.olive_iv,
    }));
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    return row.n;
  }

  prune(olderThanTs: number): void {
    this.db.prepare('DELETE FROM observations WHERE ts < ?').run(olderThanTs);
    this.db.prepare('DELETE FROM signals WHERE ts < ?').run(olderThanTs);
  }

  close(): void {
    this.db.close();
  }
}
