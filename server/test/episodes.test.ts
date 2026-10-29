import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '@options-arb/shared';
import { classifyPair, EpisodeTracker, summarizeEpisodes } from '../src/episodes';
import type { EpisodeRecord } from '../src/storage';
import { SqliteStorage } from '../src/storage/sqlite';

function sig(overrides: Partial<Signal> = {}): Signal {
  return {
    pairKey: 'ETH-20261113-2250-C', underlying: 'ETH', expiryDate: '20261113', expiryTs: 0,
    strike: 2250, kind: 'call', ivSpreadVols: 6, ivSpreadBps: 900,
    entryPriceUsdc: 131, exitPriceUsdc: 147, edgeUsdc: 16, netEdgeUsdc: 14,
    netAfterCapitalUsdc: 6, costsUsdc: 1.6, capitalCostUsdc: 8,
    maxExecutableSize: 0.5, totalNetUsdc: 3, roiApyPct: 5,
    expectedEntryUsdc: null, expectedNetAfterCapitalUsdc: null, expectedTotalNetUsdc: null,
    settlementBasisUsdc: 1, syntheticCrossCheckUsdc: null, crossCheckDeviationUsdc: null,
    bookVsMarkUsdc: null, score: 1, isOpportunity: true, isProfitable: true,
    buyVenue: 'derive', sellVenue: 'coincall', flags: [], ts: 0,
    ...overrides,
  };
}

const pair = (o: Partial<Parameters<typeof classifyPair>[0]> = {}) => ({
  buyVenue: 'derive' as const, sellVenue: 'coincall' as const, netAfterCapitalUsdc: 5, totalNetUsdc: 3,
  honestTotalNetUsdc: 3, maxExecutableSize: 1, flags: [] as string[], ...o,
});

describe('classifyPair', () => {
  it('headline: honest > 0 on clean, two-leg executable books', () => {
    expect(classifyPair(pair())).toBe('headline');
  });
  it('quote_only: quoted > 0 but the fill model prices the clip at ≤ 0', () => {
    expect(classifyPair(pair({ honestTotalNetUsdc: -8.5 }))).toBe('quote_only');
  });
  it('reference: a reference-only venue leg never counts as headline', () => {
    expect(classifyPair(pair({ flags: ['reference_venue'] }))).toBe('reference');
    expect(classifyPair(pair({ flags: ['reference_venue'], honestTotalNetUsdc: -1 }))).toBeNull();
  });
  it('nothing on blocked books, LP-only direction or no quoted profit', () => {
    expect(classifyPair(pair({ flags: ['no_book'] }))).toBeNull();
    expect(classifyPair(pair({ flags: ['single_maker'] }))).toBeNull();
    expect(classifyPair(pair({ flags: ['direction_limited'] }))).toBeNull();
    expect(classifyPair(pair({ totalNetUsdc: 0 }))).toBeNull();
    expect(classifyPair(pair({ netAfterCapitalUsdc: -1 }))).toBeNull();
  });
});

describe('EpisodeTracker', () => {
  it('opens, extends, closes on the first missed cycle, and re-opens as a new episode', () => {
    const written: EpisodeRecord[] = [];
    const t = new EpisodeTracker({ recordEpisodes: (r) => written.push(...r) });
    t.observe([sig({ totalNetUsdc: 2 })], 1_000);
    t.observe([sig({ totalNetUsdc: 4, maxExecutableSize: 0.7 })], 16_000);
    t.observe([sig({ totalNetUsdc: 1 })], 31_000);
    expect(written).toHaveLength(0);
    expect(t.snapshotOpen()).toHaveLength(1);
    t.observe([], 46_000);
    expect(written).toEqual([
      {
        pairKey: 'ETH-20261113-2250-C', underlying: 'ETH', buyVenue: 'derive', sellVenue: 'coincall', tier: 'headline',
        startTs: 1_000, endTs: 31_000, peakHonestUsdc: 4, peakQuotedUsdc: 4, peakSize: 0.7, cycles: 3,
      },
    ]);
    t.observe([sig()], 61_000);
    t.flush();
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ startTs: 61_000, endTs: 61_000, cycles: 1 });
  });

  it('tracks alternatives as their own venue-pair episodes', () => {
    const written: EpisodeRecord[] = [];
    const t = new EpisodeTracker({ recordEpisodes: (r) => written.push(...r) });
    const alt = {
      buyVenue: 'olive' as const, sellVenue: 'coincall' as const, ivSpreadVols: 9, entryPriceUsdc: 130, exitPriceUsdc: 147,
      netAfterCapitalUsdc: 5, maxExecutableSize: 0.69, totalNetUsdc: 4.2, honestTotalNetUsdc: -8.5, flags: [],
    };
    t.observe([sig({ alternatives: [alt] })], 1_000);
    t.flush();
    expect(written.map((e) => `${e.buyVenue}>${e.sellVenue}:${e.tier}`).sort()).toEqual(['derive>coincall:headline', 'olive>coincall:quote_only']);
  });
});

describe('episode storage + summary', () => {
  it('round-trips through SQLite and summarizes per tier and venue pair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'options-arb-episodes-'));
    const storage = new SqliteStorage(join(dir, 'e.db'));
    try {
      const e = (cycles: number, peak: number, startTs: number): EpisodeRecord => ({
        pairKey: 'ETH-20261113-2250-C', underlying: 'ETH', buyVenue: 'derive', sellVenue: 'coincall', tier: 'headline',
        startTs, endTs: startTs + (cycles - 1) * 15_000, peakHonestUsdc: peak, peakQuotedUsdc: peak, peakSize: 1, cycles,
      });
      storage.recordEpisodes([e(1, 0.5, 1_000), e(4, 3, 100_000), e(2, 1, 200_000)]);
      const all = storage.getEpisodes(0);
      expect(all).toHaveLength(3);
      expect(all[1]).toEqual(e(4, 3, 100_000));
      expect(storage.getEpisodes(150_000)).toHaveLength(1);
      const [row] = summarizeEpisodes(all);
      expect(row).toMatchObject({ tier: 'headline', count: 3, medianCycles: 2, maxCycles: 4, sumPeakHonestUsdc: 4.5 });
      expect(row!.best.peakHonestUsdc).toBe(3);
      storage.prune(Number.MAX_SAFE_INTEGER);
      expect(storage.getEpisodes(0)).toHaveLength(3); // episodes are never pruned
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
