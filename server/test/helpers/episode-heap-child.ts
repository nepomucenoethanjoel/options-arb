/**
 * Child process for the heap regression test (run with a small --max-old-space-size).
 * Fills a temp SQLite DB with N episodes, then summarizes them the way the API does
 * ("stream": paged reads) or the way it used to ("materialize": getEpisodes + one array).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeEpisodes, summarizeStoredEpisodes } from '../../src/episodes';
import { SqliteStorage } from '../../src/storage/sqlite';
import type { EpisodeRecord } from '../../src/storage';

const mode = process.argv[2] ?? 'stream';
const n = Number(process.argv[3] ?? 300_000);
const venues = ['coincall', 'deribit', 'okx', 'paradex', 'derive', 'gate'] as const;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'options-arb-heap-'));
  const storage = new SqliteStorage(join(dir, 'e.db'));
  try {
    const BATCH = 5_000;
    for (let i = 0; i < n; i += BATCH) {
      const rows: EpisodeRecord[] = [];
      for (let j = i; j < Math.min(n, i + BATCH); j++) {
        rows.push({
          pairKey: `ETH-20261120-${2000 + (j % 400)}-C`, underlying: j % 3 === 0 ? 'BTC' : 'ETH', buyVenue: 'olive',
          sellVenue: venues[j % venues.length]!, tier: j % 5 === 0 ? 'quote_only' : 'headline',
          startTs: 1_000_000 + j * 15_000, endTs: 1_000_000 + j * 15_000 + (j % 4) * 15_000,
          peakHonestUsdc: (j % 97) / 10, peakQuotedUsdc: (j % 97) / 9, peakSize: 1, cycles: 1 + (j % 4),
        });
      }
      storage.recordEpisodes(rows);
    }
    const rows = mode === 'materialize'
      ? summarizeEpisodes(storage.getEpisodes(0), 22_500)
      : await summarizeStoredEpisodes(storage, 0, [], 22_500);
    console.log(JSON.stringify({ mode, groups: rows.length, count: rows.reduce((a, r) => a + r.count, 0) }));
  } finally {
    storage.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly
    }
  }
}

void main();
