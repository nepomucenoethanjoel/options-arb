import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server';
import type { AppConfig } from '../src/config';
import {
  EpisodeSummarizer, SUSTAINED_MIN_MS, SUSTAINED_MIN_USDC, flickerGapMs, summarizeEpisodes, summarizeStoredEpisodes,
} from '../src/episodes';
import type { Orchestrator } from '../src/scheduler';
import type { EpisodeCursor, EpisodeRecord, EpisodeSummaryRow, EpisodeTier } from '../src/storage';
import { EPISODE_BATCH_AFTER_SQL, EPISODE_BATCH_FIRST_SQL, SqliteStorage } from '../src/storage/sqlite';

const here = dirname(fileURLToPath(import.meta.url));

type LegacyRow = Omit<EpisodeSummaryRow, 'oneCycleCount' | 'mergedCount' | 'sustainedCount'>;
const legacy = (rows: EpisodeSummaryRow[]): LegacyRow[] =>
  rows.map(({ oneCycleCount: _o, mergedCount: _m, sustainedCount: _s, ...rest }) => rest);

/** Independent reference for the flicker metrics: group by route and contract, sort, merge, count. */
function referenceFlicker(episodes: EpisodeRecord[], flickerGap: number) {
  const out = new Map<string, { oneCycle: number; merged: number; sustained: number }>();
  const routes = new Map<string, EpisodeRecord[]>();
  for (const e of episodes) {
    const k = `${e.tier}|${e.underlying}|${e.buyVenue}|${e.sellVenue}`;
    routes.set(k, [...(routes.get(k) ?? []), e]);
  }
  for (const [k, g] of routes) {
    const acc = { oneCycle: g.filter((e) => e.cycles === 1).length, merged: 0, sustained: 0 };
    const byContract = new Map<string, EpisodeRecord[]>();
    for (const e of g) byContract.set(e.pairKey, [...(byContract.get(e.pairKey) ?? []), e]);
    for (const list of byContract.values()) {
      const sorted = [...list].sort((a, b) => a.startTs - b.startTs);
      let cur: { start: number; end: number; peak: number } | null = null;
      const close = () => {
        if (!cur) return;
        acc.merged++;
        if (cur.end - cur.start >= SUSTAINED_MIN_MS && cur.peak >= SUSTAINED_MIN_USDC) acc.sustained++;
      };
      for (const e of sorted) {
        if (cur && e.startTs <= cur.end + flickerGap) {
          cur.end = Math.max(cur.end, e.endTs);
          cur.peak = Math.max(cur.peak, e.peakHonestUsdc);
        } else {
          close();
          cur = { start: e.startTs, end: e.endTs, peak: e.peakHonestUsdc };
        }
      }
      close();
    }
    out.set(k, acc);
  }
  return out;
}

/** The pre-2026-11-11 implementation (materialize, group, sort), kept as the reference the paged one must match. */
function referenceSummary(episodes: EpisodeRecord[], joinGapMs: number): LegacyRow[] {
  const quantile = (sorted: number[], q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  const windowPeaks = (g: EpisodeRecord[]) => {
    const peaks: number[] = [];
    let end = -Infinity;
    for (const e of [...g].sort((a, b) => a.startTs - b.startTs)) {
      if (e.startTs > end + joinGapMs) peaks.push(0);
      peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1]!, e.peakHonestUsdc);
      end = Math.max(end, e.endTs);
    }
    return peaks;
  };
  const groups = new Map<string, EpisodeRecord[]>();
  for (const e of episodes) {
    const k = `${e.tier}|${e.underlying}|${e.buyVenue}|${e.sellVenue}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out: LegacyRow[] = [];
  for (const g of groups.values()) {
    const cycles = g.map((e) => e.cycles).sort((a, b) => a - b);
    const best = g.reduce((a, b) => (b.peakHonestUsdc > a.peakHonestUsdc ? b : a));
    out.push({
      tier: g[0]!.tier, underlying: g[0]!.underlying, buyVenue: g[0]!.buyVenue, sellVenue: g[0]!.sellVenue,
      count: g.length, medianCycles: quantile(cycles, 0.5), p90Cycles: quantile(cycles, 0.9), maxCycles: cycles[cycles.length - 1]!,
      windows: windowPeaks(g).length,
      sumWindowPeakUsdc: Math.round(windowPeaks(g).reduce((a, p) => a + Math.max(0, p), 0) * 100) / 100,
      best,
    });
  }
  const tierOrder: Record<EpisodeTier, number> = { headline: 0, parity: 1, reference: 2, quote_only: 3 };
  return out.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.count - a.count);
}

/** Small deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function randomEpisodes(n: number, seed: number): EpisodeRecord[] {
  const r = rng(seed);
  const tiers: EpisodeTier[] = ['headline', 'parity', 'reference', 'quote_only'];
  const venues = ['coincall', 'deribit', 'okx'] as const;
  return Array.from({ length: n }, (_, i) => {
    const startTs = Math.floor(r() * 4_000_000);
    const cycles = 1 + Math.floor(r() * 9);
    // a negative peak and a unique-valued positive one: ties for `best` are a documented difference
    const peak = r() < 0.1 ? -r() : r() * 50 + i * 1e-9;
    return {
      pairKey: `ETH-${i % 40}`, underlying: r() < 0.5 ? 'ETH' : 'BTC', buyVenue: 'olive', sellVenue: venues[Math.floor(r() * 3)]!,
      tier: tiers[Math.floor(r() * 4)]!, startTs, endTs: startTs + (cycles - 1) * 15_000,
      peakHonestUsdc: peak, peakQuotedUsdc: peak, peakSize: 1, cycles,
    } satisfies EpisodeRecord;
  });
}

async function withStorage<T>(fn: (storage: SqliteStorage, file: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'options-arb-paged-'));
  const file = join(dir, 'e.db');
  const storage = new SqliteStorage(file);
  try {
    return await fn(storage, file);
  } finally {
    storage.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly
    }
  }
}

const noYield = async () => {};

describe('paged episode summary', () => {
  it('matches the old materializing implementation on random data, open episodes included', async () => {
    for (const seed of [1, 2, 3, 42]) {
      await withStorage(async (storage) => {
        const all = randomEpisodes(3_000, seed);
        const open = all.filter((_, i) => i % 50 === 0); // a few still-running episodes, interleaved in time
        const stored = all.filter((_, i) => i % 50 !== 0);
        storage.recordEpisodes(stored);
        const ordered = [...stored].sort((a, b) => a.startTs - b.startTs);
        for (const gap of [0, 22_500, 200_000]) {
          const expected = referenceSummary([...ordered, ...open], gap);
          for (const batch of [7, 97, 10_000]) { // page boundaries mid-window, mid-tie, and a single page
            expect(legacy(await summarizeStoredEpisodes(storage, 0, open, gap, batch, noYield))).toEqual(expected);
          }
          expect(legacy(summarizeEpisodes([...ordered, ...open], gap))).toEqual(expected);
        }
      });
    }
  });

  it('handles empty input and a single episode', async () => {
    await withStorage(async (storage) => {
      expect(await summarizeStoredEpisodes(storage, 0, [], 22_500)).toEqual([]);
      const [e] = randomEpisodes(1, 7);
      storage.recordEpisodes([e!]);
      const [row] = await summarizeStoredEpisodes(storage, 0, [], 22_500);
      expect(row).toMatchObject({ count: 1, windows: 1, medianCycles: e!.cycles, p90Cycles: e!.cycles, maxCycles: e!.cycles });
      expect(row!.sumWindowPeakUsdc).toBe(Math.round(Math.max(0, e!.peakHonestUsdc) * 100) / 100);
    });
  });

  it('yields to the event loop between pages', async () => {
    await withStorage(async (storage) => {
      storage.recordEpisodes(randomEpisodes(25, 11));
      let yields = 0;
      await summarizeStoredEpisodes(storage, 0, [], 22_500, 10, async () => {
        yields++;
      });
      expect(yields).toBe(2); // pages of 10, 10, 5: control goes back after each full page
    });
  });

  it('does not count an open episode twice when it closes mid-pass', async () => {
    await withStorage(async (storage) => {
      const base = randomEpisodes(40, 13).map((e) => ({
        ...e, tier: 'headline' as const, buyVenue: 'olive' as const, sellVenue: 'coincall' as const, underlying: 'ETH',
      }));
      storage.recordEpisodes(base);
      const open: EpisodeRecord = { ...base[0]!, pairKey: 'ETH-OPEN', startTs: 9_000_000, endTs: 9_000_000, peakHonestUsdc: 1, cycles: 1 };
      let closed = false;
      const rows = await summarizeStoredEpisodes(storage, 0, [open], 22_500, 8, async () => {
        if (!closed) {
          // the open episode finishes while we are between pages: it is written to the table
          closed = true;
          storage.recordEpisodes([{ ...open, endTs: 9_030_000, peakHonestUsdc: 2, cycles: 3 }]);
        }
      });
      expect(closed).toBe(true);
      expect(rows.reduce((a, r) => a + r.count, 0)).toBe(41); // 40 stored + the open one, once
    });
  });

  it('keeps memory bounded by the number of routes, not episodes', () => {
    const s = new EpisodeSummarizer(22_500);
    for (const e of randomEpisodes(2_000, 9).sort((a, b) => a.startTs - b.startTs)) s.add(e);
    expect(s.rows().length).toBeLessThanOrEqual(4 * 2 * 3); // tiers × underlyings × sell venues
  });
});

describe('flicker-merged counts', () => {
  const ep = (pairKey: string, startTs: number, endTs: number, peak: number, over: Partial<EpisodeRecord> = {}): EpisodeRecord => ({
    pairKey, underlying: 'ETH', buyVenue: 'olive', sellVenue: 'coincall', tier: 'headline',
    startTs, endTs, peakHonestUsdc: peak, peakQuotedUsdc: peak, peakSize: 1, cycles: 1 + (endTs - startTs) / 15_000, ...over,
  });

  it('merges one contract across a short gap, takes the peak across it, and uses the span as its duration', () => {
    // three one-cycle blips each 2 missed cycles apart (45 s start-to-start), then a long quiet spell and one more blip
    const blips = [ep('ETH-A', 0, 0, 2), ep('ETH-A', 45_000, 45_000, 6), ep('ETH-A', 90_000, 90_000, 1), ep('ETH-A', 700_000, 700_000, 9)];
    const [row] = summarizeEpisodes(blips, 22_500, flickerGapMs(15_000));
    expect(row).toMatchObject({ count: 4, oneCycleCount: 4, mergedCount: 2 });
    expect(row!.sustainedCount).toBe(0); // the first merged span is 90 s, the second a single blip
    // a merged span lasting 10+ minutes with a peak of $5+ counts; long but low does not; high but short does not
    const times = Array.from({ length: 15 }, (_, i) => i * 45_000);
    const long = times.map((t, i) => ep('ETH-LONG', t, t, i === 7 ? 6 : 1));
    const lowLong = times.map((t) => ep('ETH-LOW', t, t, 1));
    const [r2] = summarizeEpisodes([...long, ...lowLong, ep('ETH-SHORT', 0, 0, 50)], 22_500, flickerGapMs(15_000));
    expect(r2).toMatchObject({ count: 31, mergedCount: 3, sustainedCount: 1 }); // only ETH-LONG: 630 s and peak 6
  });

  it('does not merge across contracts, tiers or venue pairs; with no flicker gap only overlaps merge', () => {
    const eps = [ep('ETH-A', 0, 30_000, 3), ep('ETH-B', 15_000, 15_000, 4), ep('ETH-A', 45_000, 45_000, 2)];
    expect(summarizeEpisodes(eps, 22_500, flickerGapMs(15_000))[0]).toMatchObject({ count: 3, mergedCount: 2 }); // A with A, B alone
    expect(summarizeEpisodes(eps, 22_500)[0]).toMatchObject({ count: 3, mergedCount: 3 }); // no gap allowed: A ends at 30 s, restarts at 45 s
    const rows = summarizeEpisodes([ep('ETH-A', 0, 0, 3), ep('ETH-A', 15_000, 15_000, 3, { tier: 'parity' })], 22_500, 90_000);
    expect(rows.map((r) => r.mergedCount)).toEqual([1, 1]);
  });

  it('counts one-cycle episodes per route (the parity tier flickers most)', () => {
    const rows = summarizeEpisodes(
      [ep('P-1', 0, 0, 20, { tier: 'parity' }), ep('P-2', 5_000, 5_000, 20, { tier: 'parity' }), ep('P-3', 10_000, 40_000, 20, { tier: 'parity', cycles: 3 })],
      22_500, flickerGapMs(15_000));
    expect(rows[0]).toMatchObject({ tier: 'parity', count: 3, oneCycleCount: 2 });
  });

  it('flickerGapMs is about two missed cycles but never under 90 s', () => {
    expect(flickerGapMs(15_000)).toBe(90_000);
    expect(flickerGapMs(20_000)).toBe(90_000);
    expect(flickerGapMs(60_000)).toBe(180_000);
  });

  it('matches an independent reference on random data across page sizes, open episodes included', async () => {
    for (const seed of [4, 8, 15]) {
      await withStorage(async (storage) => {
        // few contracts and compressed start times so contracts really do repeat and flicker
        const all = randomEpisodes(2_500, seed).map((e, i) => {
          const startTs = Math.floor(e.startTs / 40);
          return { ...e, pairKey: `ETH-${i % 9}`, startTs, endTs: startTs + (e.cycles - 1) * 15_000 };
        });
        const open = all.filter((_, i) => i % 60 === 0);
        storage.recordEpisodes(all.filter((_, i) => i % 60 !== 0));
        for (const gap of [0, 45_000, 90_000, 400_000]) {
          const ref = referenceFlicker(all, gap);
          for (const batch of [11, 3_000]) {
            const rows = await summarizeStoredEpisodes(storage, 0, open, 22_500, batch, noYield, gap);
            for (const r of rows) {
              const want = ref.get(`${r.tier}|${r.underlying}|${r.buyVenue}|${r.sellVenue}`)!;
              expect({ one: r.oneCycleCount, merged: r.mergedCount, sustained: r.sustainedCount }, `${r.tier} gap=${gap} batch=${batch}`)
                .toEqual({ one: want.oneCycle, merged: want.merged, sustained: want.sustained });
            }
          }
        }
      });
    }
  });
});

describe('SqliteStorage.readEpisodeBatch', () => {
  it('pages through every row exactly once, in (start, end, id) order, for any page size, ties included', async () => {
    await withStorage((storage) => {
      // many episodes sharing a start (and some sharing start and end): the cursor must break ties by id
      const rows = randomEpisodes(300, 5).map((e, i) => ({
        ...e, startTs: 1_000 * Math.floor(i / 7), endTs: 1_000 * Math.floor(i / 7) + (i % 3) * 15_000,
      }));
      storage.recordEpisodes(rows);
      for (const limit of [1, 2, 7, 50, 299, 300, 301, 10_000]) {
        const seen: EpisodeRecord[] = [];
        let cursor: EpisodeCursor | null = null;
        let pages = 0;
        do {
          const page = storage.readEpisodeBatch(0, cursor, limit);
          expect(page.rows.length).toBeLessThanOrEqual(limit);
          seen.push(...page.rows);
          cursor = page.next;
          pages++;
        } while (cursor);
        expect(seen).toHaveLength(300);
        const keys = seen.map((e) => [e.startTs, e.endTs] as const);
        expect(keys).toEqual([...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
        expect(pages).toBe(Math.floor(300 / limit) + 1); // a page that is exactly full still hands back a cursor
      }
      expect(storage.getEpisodes(0)).toHaveLength(300);
    });
  });

  it('honours sinceTs on end_ts (an episode that started earlier but ends inside the window counts)', async () => {
    await withStorage((storage) => {
      const e = (startTs: number, endTs: number): EpisodeRecord => ({
        pairKey: 'ETH-A', underlying: 'ETH', buyVenue: 'olive', sellVenue: 'coincall', tier: 'headline',
        startTs, endTs, peakHonestUsdc: 1, peakQuotedUsdc: 1, peakSize: 1, cycles: 1,
      });
      storage.recordEpisodes([e(0, 100), e(50, 250), e(300, 300)]);
      expect(storage.getEpisodes(200).map((x) => [x.startTs, x.endTs])).toEqual([[50, 250], [300, 300]]);
      expect(storage.getEpisodes(301)).toEqual([]);
    });
  });

  it('plans both queries on the (start_ts, end_ts) index without a sort', async () => {
    await withStorage((_storage, file) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const cases: Array<[string, string, number[]]> = [
          ['first', EPISODE_BATCH_FIRST_SQL, [0, 100]],
          ['after', EPISODE_BATCH_AFTER_SQL, [0, 1, 2, 3, 100]],
        ];
        for (const [name, sql, args] of cases) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => String(r.detail)).join(' | ');
          expect(plan, name).toContain('idx_episodes_start_end');
          expect(plan, name).not.toMatch(/TEMP B-TREE/i);
        }
      } finally {
        db.close();
      }
    });
  });
});

describe('/api/episodes/summary', () => {
  it('summarizes in pages, includes open episodes, and shares one computation between concurrent and repeated requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'options-arb-api-'));
    const storage = new SqliteStorage(join(dir, 'e.db'));
    let scans = 0;
    const realBatch = storage.readEpisodeBatch.bind(storage);
    storage.readEpisodeBatch = (sinceTs, after, limit) => {
      if (after === null) scans++; // one scan = one pass from the first page
      return realBatch(sinceTs, after, limit);
    };
    const now = Date.now();
    const ep = (startTs: number, peak: number): EpisodeRecord => ({
      pairKey: 'ETH-20261120-2150-C', underlying: 'ETH', buyVenue: 'olive', sellVenue: 'coincall', tier: 'headline',
      startTs, endTs: startTs, peakHonestUsdc: peak, peakQuotedUsdc: peak, peakSize: 1, cycles: 1,
    });
    storage.recordEpisodes([ep(now - 600_000, 2), ep(now - 300_000, 3)]);
    const orch = new EventEmitter() as unknown as Orchestrator;
    Object.assign(orch, { latest: null, startedAt: 1, episodes: { snapshotOpen: () => [ep(now - 10_000, 7)] } });
    const cfg = { underlyings: ['ETH'], pollIntervalMs: 15_000 } as unknown as AppConfig;
    const app = await buildServer({ cfg, orchestrator: orch, storage });
    try {
      const both = await Promise.all([
        app.inject({ url: '/api/episodes/summary?days=7' }),
        app.inject({ url: '/api/episodes/summary?days=7' }),
      ]);
      expect(scans).toBe(1); // two concurrent requests, one pass
      const a = both[0].json();
      expect(both[1].json()).toEqual(a);
      expect(a).toMatchObject({ days: 7, pollIntervalMs: 15_000, openCount: 1, trackingSinceTs: 1 });
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0]).toMatchObject({ tier: 'headline', count: 3, windows: 3, sumWindowPeakUsdc: 12 }); // stored 2 + 3, open 7
      const b = (await app.inject({ url: '/api/episodes/summary?days=7' })).json();
      expect(b).toEqual(a);
      expect(scans).toBe(1); // served from the cache
      await app.inject({ url: '/api/episodes/summary?days=1' });
      expect(scans).toBe(2); // another window is its own entry
    } finally {
      await app.close();
      storage.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold the file briefly
      }
    }
  });
});

describe('heap regression (the 2026-11-11 crash)', () => {
  // One GET /api/episodes/summary ran the production server out of its 256 MB heap: it loaded a week of
  // episodes (457k rows) into arrays. Same shape here, scaled down: 300k rows under a 48 MB heap cap.
  const child = join(here, 'helpers', 'episode-heap-child.ts');
  const run = (mode: string) => {
    try {
      const out = execFileSync(process.execPath, ['--max-old-space-size=48', '--import', 'tsx', child, mode, '300000'],
        { cwd: join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('control: loading every episode into arrays runs out of heap under the cap', () => {
    const r = run('materialize');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/heap out of memory/i);
  }, 120_000);

  it('the paged path summarizes the same 300k episodes under the same cap', () => {
    const r = run('stream');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split('\n').pop()!)).toMatchObject({ mode: 'stream', count: 300_000 });
  }, 120_000);
});
