import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Venue, VenueHealth } from '@options-arb/shared';
import type { EpisodeBatch, EpisodeCursor, EpisodeRecord, EpisodeTier, SignalRecord, SpreadHistoryPoint, Storage } from './index';

/**
 * SQLite-backed Storage using Node's built-in `node:sqlite` (no native addon
 * to compile). WAL mode keeps concurrent reads cheap while the scheduler
 * writes each cycle. auto_vacuum=INCREMENTAL + post-prune incremental_vacuum
 * keeps the file size tracking live data instead of its historical peak.
 */
const EPISODE_COLUMNS = `id, pair_key, underlying, buy_venue, sell_venue, tier, start_ts, end_ts,
  peak_honest_usdc, peak_quoted_usdc, peak_size, cycles`;
/** Keyset pages in (start_ts, end_ts, id) order = idx_episodes_start_end order: no sort, no OFFSET. */
export const EPISODE_BATCH_FIRST_SQL = `SELECT ${EPISODE_COLUMNS} FROM episodes INDEXED BY idx_episodes_start_end
  WHERE end_ts >= ? ORDER BY start_ts, end_ts, id LIMIT ?`;
export const EPISODE_BATCH_AFTER_SQL = `SELECT ${EPISODE_COLUMNS} FROM episodes INDEXED BY idx_episodes_start_end
  WHERE end_ts >= ? AND (start_ts, end_ts, id) > (?, ?, ?) ORDER BY start_ts, end_ts, id LIMIT ?`;

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
         is_opportunity, is_profitable, flags, ivs_json, buy_venue, sell_venue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_key TEXT NOT NULL, underlying TEXT NOT NULL,
        buy_venue TEXT NOT NULL, sell_venue TEXT NOT NULL, tier TEXT NOT NULL,
        start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
        peak_honest_usdc REAL NOT NULL, peak_quoted_usdc REAL NOT NULL, peak_size REAL,
        cycles INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_end ON episodes(end_ts);
      -- Batched reads in start order (readEpisodeBatch): (start_ts, end_ts, id) is the cursor, and the
      -- index carries end_ts so the window filter never touches table rows it will discard.
      CREATE INDEX IF NOT EXISTS idx_episodes_start_end ON episodes(start_ts, end_ts);
    `);
    const columns: Array<[string, string]> = [
      ['costs_usdc', 'REAL'],
      ['score', 'REAL'],
      ['net_usdc', 'REAL'],
      ['total_net_usdc', 'REAL'],
      ['roi_apy_pct', 'REAL'],
      ['max_size', 'REAL'],
      ['is_profitable', 'INTEGER'],
      ['ivs_json', 'TEXT'],
      ['buy_venue', 'TEXT'],
      ['sell_venue', 'TEXT'],
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
          JSON.stringify(r.ivs), r.buyVenue, r.sellVenue,
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
        `SELECT ts, spread_vols, derive_iv, olive_iv, ivs_json, buy_venue, sell_venue FROM signals
         WHERE pair_key = ? AND ts >= ? ORDER BY ts ASC`,
      )
      .all(pairKey, sinceTs) as Array<{
      ts: number;
      spread_vols: number | null;
      derive_iv: number | null;
      olive_iv: number | null;
      ivs_json: string | null;
      buy_venue: Venue | null;
      sell_venue: Venue | null;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      spreadVols: r.spread_vols,
      deriveIv: r.derive_iv,
      oliveIv: r.olive_iv,
      ivs: r.ivs_json ? (JSON.parse(r.ivs_json) as SpreadHistoryPoint['ivs']) : { derive: r.derive_iv, olive: r.olive_iv },
      buyVenue: r.buy_venue,
      sellVenue: r.sell_venue,
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

  recordEpisodes(rows: EpisodeRecord[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO episodes (pair_key, underlying, buy_venue, sell_venue, tier, start_ts, end_ts,
         peak_honest_usdc, peak_quoted_usdc, peak_size, cycles)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const e of rows) {
        stmt.run(e.pairKey, e.underlying, e.buyVenue, e.sellVenue, e.tier, e.startTs, e.endTs,
          e.peakHonestUsdc, e.peakQuotedUsdc, e.peakSize, e.cycles);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Materializes every match: for small windows and tests only. The API reads in batches. */
  getEpisodes(sinceTs: number): EpisodeRecord[] {
    const out: EpisodeRecord[] = [];
    let cursor: EpisodeCursor | null = null;
    do {
      const batch = this.readEpisodeBatch(sinceTs, cursor, 10_000);
      out.push(...batch.rows);
      cursor = batch.next;
    } while (cursor);
    return out;
  }

  readEpisodeBatch(sinceTs: number, after: EpisodeCursor | null, limit: number): EpisodeBatch {
    const stmt = this.db.prepare(after ? EPISODE_BATCH_AFTER_SQL : EPISODE_BATCH_FIRST_SQL);
    const rows = (after
      ? stmt.all(sinceTs, after.startTs, after.endTs, after.id, limit)
      : stmt.all(sinceTs, limit)) as Array<Record<string, unknown>>;
    const records = rows.map((r) => ({
      pairKey: r.pair_key as string,
      underlying: r.underlying as string,
      buyVenue: r.buy_venue as Venue,
      sellVenue: r.sell_venue as Venue,
      tier: r.tier as EpisodeTier,
      startTs: r.start_ts as number,
      endTs: r.end_ts as number,
      peakHonestUsdc: r.peak_honest_usdc as number,
      peakQuotedUsdc: r.peak_quoted_usdc as number,
      peakSize: (r.peak_size as number | null) ?? null,
      cycles: r.cycles as number,
    }));
    const last = rows[rows.length - 1];
    return {
      rows: records,
      next: rows.length === limit && last
        ? { startTs: last.start_ts as number, endTs: last.end_ts as number, id: last.id as number }
        : null,
    };
  }

  /** Signals only: episodes are small and are the long-run evidence, so they are never pruned. */
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
