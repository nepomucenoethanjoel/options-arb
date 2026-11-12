import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server';
import type { AppConfig } from '../src/config';
import { EpisodeSummarizer, summarizeEpisodeStream, summarizeEpisodes } from '../src/episodes';
import type { Orchestrator } from '../src/scheduler';
import type { EpisodeRecord, EpisodeSummaryRow, EpisodeTier } from '../src/storage';
import { SqliteStorage } from '../src/storage/sqlite';

const here = dirname(fileURLToPath(import.meta.url));

/** The pre-2026-11-11 implementation (materialize, group, sort), kept as the reference the stream must match. */
function referenceSummary(episodes: EpisodeRecord[], joinGapMs: number): EpisodeSummaryRow[] {
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
  const out: EpisodeSummaryRow[] = [];
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

describe('streaming episode summary', () => {
  it('matches the old materializing implementation on random data, open episodes included', () => {
    for (const seed of [1, 2, 3, 42]) {
      const all = randomEpisodes(3_000, seed);
      const open = all.filter((_, i) => i % 50 === 0); // a few still-running episodes, interleaved in time
      const stored = all.filter((_, i) => i % 50 !== 0).sort((a, b) => a.startTs - b.startTs);
      for (const gap of [0, 22_500, 200_000]) {
        const expected = referenceSummary([...stored, ...open], gap);
        expect(summarizeEpisodeStream(stored, open, gap)).toEqual(expected);
        expect(summarizeEpisodes([...stored, ...open], gap)).toEqual(expected);
      }
    }
  });

  it('handles empty input and a single episode', () => {
    expect(summarizeEpisodeStream([], [], 22_500)).toEqual([]);
    const [e] = randomEpisodes(1, 7);
    const [row] = summarizeEpisodeStream([e!], [], 22_500);
    expect(row).toMatchObject({ count: 1, windows: 1, medianCycles: e!.cycles, p90Cycles: e!.cycles, maxCycles: e!.cycles });
    expect(row!.sumWindowPeakUsdc).toBe(Math.round(Math.max(0, e!.peakHonestUsdc) * 100) / 100);
  });

  it('keeps memory bounded by the number of routes, not episodes', () => {
    const s = new EpisodeSummarizer(22_500);
    for (const e of randomEpisodes(2_000, 9).sort((a, b) => a.startTs - b.startTs)) s.add(e);
    expect(s.rows().length).toBeLessThanOrEqual(4 * 2 * 3); // tiers × underlyings × sell venues
  });
});

describe('SqliteStorage.iterateEpisodes', () => {
  it('is lazy, ordered by start, honours sinceTs, and agrees with getEpisodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'options-arb-iter-'));
    const storage = new SqliteStorage(join(dir, 'e.db'));
    try {
      const rows = randomEpisodes(200, 5);
      storage.recordEpisodes(rows);
      const it = storage.iterateEpisodes(0);
      expect(Array.isArray(it)).toBe(false);
      const first = (it as Iterator<EpisodeRecord>).next();
      expect(first.done).toBe(false);
      const all = [...storage.iterateEpisodes(0)];
      expect(all).toHaveLength(200);
      expect(all.map((e) => e.startTs)).toEqual([...all.map((e) => e.startTs)].sort((a, b) => a - b));
      expect(storage.getEpisodes(0)).toEqual(all);
      const cut = 2_000_000;
      expect([...storage.iterateEpisodes(cut)].every((e) => e.endTs >= cut)).toBe(true);
    } finally {
      storage.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold the file briefly
      }
    }
  });
});

describe('/api/episodes/summary', () => {
  it('summarizes through the stream, includes open episodes, and reuses the result briefly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'options-arb-api-'));
    const storage = new SqliteStorage(join(dir, 'e.db'));
    let scans = 0;
    const realIterate = storage.iterateEpisodes.bind(storage);
    storage.iterateEpisodes = (sinceTs: number) => {
      scans++;
      return realIterate(sinceTs);
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
      const a = (await app.inject({ url: '/api/episodes/summary?days=7' })).json();
      expect(a).toMatchObject({ days: 7, pollIntervalMs: 15_000, openCount: 1, trackingSinceTs: 1 });
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0]).toMatchObject({ tier: 'headline', count: 3, windows: 3, sumWindowPeakUsdc: 12 }); // stored 2 + 3, open 7
      const b = (await app.inject({ url: '/api/episodes/summary?days=7' })).json();
      expect(b).toEqual(a);
      expect(scans).toBe(1); // second request served from the cache
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

  it('the streaming path summarizes the same 300k episodes under the same cap', () => {
    const r = run('stream');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split('\n').pop()!)).toMatchObject({ mode: 'stream', count: 300_000 });
  }, 120_000);
});
