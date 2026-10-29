import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config';
import { Orchestrator } from '../src/scheduler';

/** Orchestrator with the cycle body replaced by a fixed-duration stub. */
class TimedOrchestrator extends Orchestrator {
  starts: number[] = [];
  constructor(private readonly cycleMs: number, private readonly fail = false) {
    super(
      { pollIntervalMs: 15_000, historyRetentionDays: 3, oliveVolOverrides: {}, oliveRealtimeSpotTriggerPct: 0 } as unknown as AppConfig,
      {} as never,
      { onSpot: () => () => {} } as never,
      { prune: () => {} } as never,
    );
  }
  override async runOnce(): Promise<void> {
    this.starts.push(Date.now());
    await new Promise((r) => setTimeout(r, this.cycleMs));
    if (this.fail) throw new Error('boom');
  }
}

describe('Orchestrator cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs back-to-back when a cycle outlasts the interval (was every 30 s under setInterval)', async () => {
    const o = new TimedOrchestrator(15_200);
    o.start();
    await vi.advanceTimersByTimeAsync(61_000);
    o.stop();
    const gaps = o.starts.slice(1).map((t, i) => t - o.starts[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(15_200);
    for (const g of gaps) expect(g).toBeLessThan(15_210); // not ~30 s
  });

  it('keeps the interval measured from cycle start when cycles are short', async () => {
    const o = new TimedOrchestrator(4_000);
    o.start();
    await vi.advanceTimersByTimeAsync(46_000);
    o.stop();
    const gaps = o.starts.slice(1).map((t, i) => t - o.starts[i]!);
    for (const g of gaps) expect(g).toBe(15_000);
  });

  it('keeps cycling after a cycle throws, and stop() ends the chain', async () => {
    const o = new TimedOrchestrator(1_000, true);
    o.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(o.starts.length).toBe(3);
    o.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(o.starts.length).toBe(3);
  });
});

describe('Orchestrator — extra listed venues', () => {
  const NOW = Date.now();
  const expiryTs = NOW + 7 * 86_400_000;
  const d = new Date(expiryTs);
  const expiryDate = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const inst = (venue: 'derive' | 'coincall', strike: number) => ({
    venue, instrumentId: `${venue}-${strike}`, underlying: 'ETH', expiryTs, expiryDate, strike, kind: 'call' as const,
  });
  const quote = (venue: 'derive' | 'coincall', strike: number, iv: number) => ({
    venue, instrumentId: `${venue}-${strike}`, ts: Date.now(), bid: 9, bidSize: 5, ask: 10, askSize: 5, mark: 9.5,
    indexPrice: 3000, iv, ivSource: 'market' as const, source: `${venue}:test`,
  });
  const health = (venue: string) => () => ({ venue, source: `${venue}:test`, status: 'ok' as const, lastSuccessTs: 1, lastError: null });

  it('matches extra venue chains onto the grid and reports their health', async () => {
    const derive = {
      getInstruments: async () => [inst('derive', 3000)],
      getTickers: async () => [quote('derive', 3000, 0.6)],
      getHealth: health('derive'),
    };
    const olive = {
      getMarketState: async () => null,
      getAmmQuote: () => ({ rejected: 'no_olive_state' }),
      getHealth: health('olive'),
      getRealtimeHealth: () => null,
      isVolLive: () => true,
      getCachedLiquidity: () => null,
      getCachedCapacity: () => null,
      onSpot: () => () => {},
    };
    const coincall = {
      venue: 'coincall' as const,
      getChain: async () => ({ instruments: [inst('coincall', 3000), inst('coincall', 3100)], quotes: [quote('coincall', 3000, 0.55)] }),
      getHealth: health('coincall'),
    };
    const o = new Orchestrator(
      { pollIntervalMs: 15_000, historyRetentionDays: 3, oliveVolOverrides: {}, oliveRealtimeSpotTriggerPct: 0, underlyings: ['ETH'],
        deriveMaxExpiries: 0, matchExpiryToleranceDays: 1, matchMaxStrikeRelDist: 0.02, oliveMaxTenorDays: 365, ivSpreadThresholdVols: 3,
        minBookSize: 1, maxRelBookWidth: 0.5, nearExpiryDays: 1, deriveTakerFeeBps: 3, solanaFeeUsdc: 0.05, capitalBorrowRateApr: 0.08,
        olivePoolLiquidityUsd: {} } as unknown as AppConfig,
      derive as never,
      olive as never,
      { recordSignals: () => {}, upsertHealth: () => {}, prune: () => {}, recordEpisodes: () => {} } as never,
      undefined,
      [coincall as never],
    );
    await o.runOnce();
    const rows = o.latest!.rows;
    expect(rows.map((r) => r.pairKey).sort()).toEqual([`ETH-${expiryDate}-3000-C`, `ETH-${expiryDate}-3100-C`]);
    const atm = rows.find((r) => r.strike === 3000)!;
    expect(Object.keys(atm.venues).sort()).toEqual(['coincall', 'derive']);
    expect(o.latest!.health.venues.coincall?.status).toBe('ok');
  });
});
