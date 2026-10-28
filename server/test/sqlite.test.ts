import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite';

// Static `import ... from 'node:sqlite'` is mangled by vitest's vite
// transform (it predates the node:sqlite builtin) — load it through
// createRequire instead.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let dir: string | null = null;

function tmpPath(): string {
  dir = dir ?? mkdtempSync(join(tmpdir(), 'options-arb-sqlite-test-'));
  return join(dir, `${crypto.randomUUID()}.db`);
}

afterEach(() => {
  if (dir) {
    // Best-effort: Windows refuses the delete if a leaked connection from a
    // failed test still holds the file — the OS temp cleaner gets it later.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    dir = null;
  }
});

const AUTO_VACUUM_INCREMENTAL = 2;

function pragma(path: string, name: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name] as number;
  } finally {
    db.close();
  }
}

describe('SqliteStorage', () => {
  it('creates a fresh DB with auto_vacuum=INCREMENTAL (no conversion needed)', () => {
    const path = tmpPath();
    const storage = new SqliteStorage(path);
    try {
      expect(storage.countSignals()).toBe(0);
    } finally {
      storage.close();
    }
    expect(pragma(path, 'auto_vacuum')).toBe(AUTO_VACUUM_INCREMENTAL);
  });

  it('migrates a legacy DB: drops the observations archive, adds missing columns, converts auto_vacuum', () => {
    const path = tmpPath();
    // Legacy shape: observations table with data, signals table without the
    // profit-estimate columns, auto_vacuum off (default).
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE observations (ts INTEGER, venue TEXT, strike REAL)');
    raw.exec("INSERT INTO observations VALUES (1, 'derive', 100)");
    raw.exec(`CREATE TABLE signals (
      ts INTEGER NOT NULL, pair_key TEXT NOT NULL, underlying TEXT NOT NULL,
      spread_vols REAL, spread_bps REAL, derive_iv REAL, olive_iv REAL, edge_usdc REAL,
      is_opportunity INTEGER NOT NULL, flags TEXT NOT NULL,
      PRIMARY KEY (ts, pair_key))`);
    raw.prepare('INSERT INTO signals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      1000, 'SOL-20261030-120-C', 'SOL', 5.5, 900, 0.6, 0.55, 1.2, 1, 'amm_pool_depth_unknown',
    );
    raw.close();

    const storage = new SqliteStorage(path);
    try {
      expect(storage.countSignals()).toBe(1);
      // The old signal row survives and is readable through the migrated schema.
      expect(storage.getSpreadHistory('SOL-20261030-120-C', 0)).toEqual([
        // Pre-multi-venue rows: ivs falls back to the derive/olive columns.
        { ts: 1000, spreadVols: 5.5, deriveIv: 0.6, oliveIv: 0.55, ivs: { derive: 0.6, olive: 0.55 }, buyVenue: null, sellVenue: null },
      ]);
    } finally {
      storage.close();
    }
    expect(pragma(path, 'auto_vacuum')).toBe(AUTO_VACUUM_INCREMENTAL);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'")
        .all();
      expect(tables).toHaveLength(0);
    } finally {
      check.close();
    }
  });

  it('round-trips signal records into spread history', () => {
    const storage = new SqliteStorage(tmpPath());
    try {
      storage.recordSignals([
        {
          ts: 2000, pairKey: 'ETH-20261030-2900-C', underlying: 'ETH', spreadVols: -3.2, spreadBps: -550,
          deriveIv: 0.5, oliveIv: 0.532, edgeUsdc: -1.5, netAfterCapitalUsdc: -2.1, totalNetUsdc: -6.3,
          roiApyPct: -12.5, maxSize: 3, costsUsdc: 0.4, score: -6.3, isOpportunity: true, isProfitable: false,
          flags: 'direction_limited', ivs: { derive: 0.5, olive: 0.532, coincall: 0.51 }, buyVenue: 'derive', sellVenue: 'olive',
        },
      ]);
      const points = storage.getSpreadHistory('ETH-20261030-2900-C', 0);
      expect(points).toEqual([
        {
          ts: 2000, spreadVols: -3.2, deriveIv: 0.5, oliveIv: 0.532,
          ivs: { derive: 0.5, olive: 0.532, coincall: 0.51 }, buyVenue: 'derive', sellVenue: 'olive',
        },
      ]);
      expect(storage.getSpreadHistory('SOL-20261030-120-C', 0)).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it('prune() actually returns pages to the filesystem (incremental_vacuum)', () => {
    const path = tmpPath();
    const storage = new SqliteStorage(path);
    const oldTs = Date.now() - 40 * 86_400_000; // beyond 30-day retention
    try {
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        ts: oldTs + i, pairKey: `SOL-20261030-${100 + i}-C`, underlying: 'SOL',
        spreadVols: 1, spreadBps: 100, deriveIv: 0.5, oliveIv: 0.55, edgeUsdc: 0.1,
        netAfterCapitalUsdc: 0.05, totalNetUsdc: 1, roiApyPct: 5, maxSize: 2, costsUsdc: 0.1,
        score: 1, isOpportunity: true, isProfitable: true, flags: '',
        ivs: { derive: 0.5, olive: 0.55 }, buyVenue: 'olive' as const, sellVenue: 'derive' as const,
      }));
      storage.recordSignals(rows);
      expect(storage.countSignals()).toBe(5000);
    } finally {
      storage.close();
    }
    const pagesBefore = pragma(path, 'page_count');

    const pruning = new SqliteStorage(path);
    try {
      pruning.prune(Date.now() - 30 * 86_400_000);
      expect(pruning.countSignals()).toBe(0);
    } finally {
      pruning.close();
    }
    const pagesAfter = pragma(path, 'page_count');
    // 5000 rows ≈ hundreds of pages; incremental_vacuum must give them back.
    expect(pagesAfter).toBeLessThan(pagesBefore);
    expect(pagesBefore - pagesAfter).toBeGreaterThan(100);
  });
});
