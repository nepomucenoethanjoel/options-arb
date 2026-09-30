import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VenueHealth } from '@options-arb/shared';
import type { SignalRecord, SpreadHistoryPoint, Storage } from './index';

/**
 * SQLite-backed Storage using Node's built-in `node:sqlite` (no native addon
 * to compile). WAL mode keeps concurrent reads cheap while the scheduler
 * writes each cycle. auto_vacuum=INCREMENTAL + post-prune incremental_vacuum
 * keeps the file size tracking live data instead of its historical peak.
 */
export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  private readonly insertSignal;
  private countCache: { n: number; at: number } | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Left alone, the WAL grows without bound (observed 2026-09-30: 199 MB
    // beside a 369 MB main file) — passive autocheckpoint wasn't reclaiming.
    // Force eager checkpoints and cap the file; prune() also truncates.
    this.db.exec('PRAGMA wal_autocheckpoint = 512;');
    this.db.exec('PRAGMA journal_size_limit = 33554432;'); // 32 MB
    // auto_vacuum must be INCREMENTAL for prune() to ever return disk space.
    // The pragma takes effect immediately on a fresh DB; on an existing DB it
    // reports the old value (0) until a VACUUM converts the file.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    const converted = (this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum === 2;
    // The observations archive was removed 2026-09-28 (write-only, nothing
    // read it) — drop it so the conversion vacuum reclaims the space.
    this.db.exec('DROP TABLE IF EXISTS observations;');
    this.migrate();
    if (!converted) {
      const t0 = Date.now();
      this.db.exec('VACUUM;');
      console.log(`[storage] one-time VACUUM (auto_vacuum conversion) took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
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
    this.db.exec(`
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
    const columns: Array<[string, string]> = [
      ['costs_usdc', 'REAL'],
      ['score', 'REAL'],
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

  /** Row count of the signals table (health/debug display). COUNT(*) scans
   * the whole table (~1.4M rows), so serve a ≤60s-stale cache instead. */
  countSignals(): number {
    if (this.countCache && Date.now() - this.countCache.at < 60_000) return this.countCache.n;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number };
    this.countCache = { n: row.n, at: Date.now() };
    return row.n;
  }

  prune(olderThanTs: number): void {
    this.db.prepare('DELETE FROM signals WHERE ts < ?').run(olderThanTs);
    this.countCache = null;
    // Return the freed pages to the filesystem instead of holding them
    // forever (requires auto_vacuum=INCREMENTAL — see enableAutoVacuum).
    this.db.exec('PRAGMA incremental_vacuum;');
    // Fold the WAL back into the main file and cut it to zero — see the
    // journal_size_limit note in the constructor.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close(): void {
    this.db.close();
  }
}
