import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { Signal } from '@options-arb/shared';
import { buildHealthRollup, buildKpis, buildServer } from '../src/api/server';
import type { AppConfig } from '../src/config';
import type { Orchestrator } from '../src/scheduler';
import type { Storage } from '../src/storage';

const cfg = {
  underlyings: ['SOL', 'ETH'],
  ivSpreadThresholdVols: 3,
  pollIntervalMs: 15_000,
  deriveTakerFeeBps: 3,
  solanaFeeUsdc: 0.05,
  capitalBorrowRateApr: 0.08,
} as unknown as AppConfig;

const storage = { countSignals: () => 0 } as unknown as Storage;

function sig(pairKey: string, underlying: string, overrides: Partial<Signal> = {}): Signal {
  return {
    pairKey, underlying, expiryDate: '20261030', expiryTs: 0, strike: 100, kind: 'call',
    ivSpreadVols: 5, ivSpreadBps: 800, entryPriceUsdc: 1, exitPriceUsdc: 2, edgeUsdc: 1,
    netEdgeUsdc: 0.9, netAfterCapitalUsdc: 0.5, costsUsdc: 0.1, capitalCostUsdc: 0.4,
    maxExecutableSize: 5, totalNetUsdc: 2.5, roiApyPct: 10, settlementBasisUsdc: 0.1,
    expectedEntryUsdc: null, expectedNetAfterCapitalUsdc: null, expectedTotalNetUsdc: null,
    syntheticCrossCheckUsdc: 0, crossCheckDeviationUsdc: 0, bookVsMarkUsdc: 0, score: 5,
    isOpportunity: true, isProfitable: true, buyVenue: 'olive', sellVenue: 'derive', flags: [], ts: 0,
    ...overrides,
  };
}

const signals = [
  sig('SOL-20261030-100-C', 'SOL', { totalNetUsdc: 10 }),
  sig('SOL-20261030-110-C', 'SOL', { buyVenue: 'derive', sellVenue: 'olive', flags: ['direction_limited'], totalNetUsdc: 50 }),
  sig('ETH-20261030-2000-C', 'ETH', { totalNetUsdc: 20, isProfitable: false, isOpportunity: false, netAfterCapitalUsdc: -1 }),
];

function stubOrchestrator(): Orchestrator {
  const orch = new EventEmitter() as unknown as Orchestrator;
  (orch as unknown as { latest: unknown }).latest = {
    ts: 123,
    durationMs: 5,
    rows: [
      { pairKey: 'SOL-20261030-100-C', underlying: 'SOL', expiryTs: 0, expiryDate: '20261030', strike: 100, kind: 'call', matchType: 'exact_match', venues: { derive: { iv: 0.6, bid: 1, ask: 2, mark: 1.5 }, olive: { iv: 0.55, bid: null, ask: null, mark: 1.5 } }, note: 'amm_synthetic', unmatchedReason: undefined },
      { pairKey: 'ETH-20261030-2000-C', underlying: 'ETH', expiryTs: 0, expiryDate: '20261030', strike: 2000, kind: 'call', matchType: 'exact_match', venues: { derive: { iv: 0.5, bid: 1, ask: 2, mark: 1.5 }, olive: { iv: 0.55, bid: null, ask: null, mark: 1.5 } }, note: 'amm_synthetic', unmatchedReason: undefined },
    ],
    signals,
    health: { venues: {}, serverTime: 0, pollIntervalMs: 15000, lastCycleMs: null, lastCycleDurationMs: null },
    spots: { SOL: 100, ETH: 2000 },
    realtime: null,
    oliveCaveats: [],
    config: { ivSpreadThresholdVols: 3, pollIntervalMs: 15000, underlyings: ['SOL', 'ETH'], fees: {}, volPinnedAt: null },
  };
  (orch as unknown as { fullRows: Map<string, unknown> }).fullRows = new Map();
  (orch as unknown as { getSurface: unknown }).getSurface = async () => ({});
  return orch;
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
}

describe('buildKpis', () => {
  it('headlines executable clips, counts LP-only rows, and finds the closest non-profitable', () => {
    const k = buildKpis(signals);
    expect(k.topExecutable.map((s) => s.pairKey)).toEqual(['SOL-20261030-100-C']);
    expect(k.topAny.map((s) => s.pairKey)).toEqual(['SOL-20261030-110-C', 'SOL-20261030-100-C']); // by total desc
    expect(k.executableProfitableCount).toBe(1);
    expect(k.lpOnlyProfitableCount).toBe(1);
    expect(k.opportunitiesCount).toBe(2);
    expect(k.totalExecutableUsd).toBe(10);
    expect(k.closest?.pairKey).toBe('ETH-20261030-2000-C');
  });

  it('headlines the expected (marginal-fill) total when it is lower than the quote', () => {
    // The quote says $10 but the fill's own rate impact prices it at $4 —
    // the KPI must headline the honest number and rank by it.
    const withExpected = [
      sig('SOL-20261030-100-C', 'SOL', { totalNetUsdc: 10, expectedTotalNetUsdc: 4 }),
      sig('SOL-20261030-110-C', 'SOL', { totalNetUsdc: 3, expectedTotalNetUsdc: null }),
    ];
    const k = buildKpis(withExpected);
    expect(k.totalExecutableUsd).toBe(4); // not 10, not 13
    expect(k.topExecutable.map((s) => s.pairKey)).toEqual(['SOL-20261030-100-C', 'SOL-20261030-110-C']); // 4 > 3
    // Expected ABOVE the quote (model says the fill is fine) changes nothing.
    const withBetter = [sig('SOL-20261030-100-C', 'SOL', { totalNetUsdc: 10, expectedTotalNetUsdc: 12 })];
    expect(buildKpis(withBetter).totalExecutableUsd).toBe(10);
  });

  it('skips price-distorted rows for the closest signal', () => {
    const withNoise = [
      ...signals,
      sig('SOL-20261030-120-C', 'SOL', { isProfitable: false, isOpportunity: false, netAfterCapitalUsdc: -0.1, flags: ['price_distortion'] }),
    ];
    expect(buildKpis(withNoise).closest?.pairKey).toBe('ETH-20261030-2000-C');
  });
});

describe('/ws per-underlying subscription', () => {
  it('sends a digest-only message on connect, then the subscribed underlying only', async () => {
    const app = await buildServer({ cfg, orchestrator: stubOrchestrator(), storage });
    await app.listen({ port: 0, host: '127.0.0.1' });
    servers.push({ close: () => app.close() });
    const { port } = app.server!.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const first = await nextMessage(ws); // digest-only on connect
    expect(first.type).toBe('cycle');
    expect(first.rows).toEqual([]);
    expect(first.signals).toEqual([]);
    expect(first.underlying).toBeNull();
    expect(first.kpi.executableProfitableCount).toBe(1);

    ws.send(JSON.stringify({ type: 'subscribe', underlying: 'sol' })); // case-insensitive
    const second = await nextMessage(ws);
    expect(second.underlying).toBe('SOL');
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].underlying).toBe('SOL');
    // both SOL signals (executable + LP-only), never ETH's
    expect(second.signals).toHaveLength(2);
    expect(second.signals.map((s: Signal) => s.underlying)).toEqual(['SOL', 'SOL']);
    expect(second.kpi.totalExecutableUsd).toBe(10); // digest stays global
    ws.close();
  });

  it('broadcasts per-cycle messages filtered per subscription and keeps invalid ones on the digest', async () => {
    const orch = stubOrchestrator();
    const app = await buildServer({ cfg, orchestrator: orch, storage });
    await app.listen({ port: 0, host: '127.0.0.1' });
    servers.push({ close: () => app.close() });
    const { port } = app.server!.address() as AddressInfo;

    const subbed = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(subbed); // connect digest
    subbed.send(JSON.stringify({ type: 'subscribe', underlying: 'ETH' }));
    await nextMessage(subbed); // subscribe echo

    const idle = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(idle); // connect digest

    // invalid underlying must not change the subscription
    subbed.send(JSON.stringify({ type: 'subscribe', underlying: 'DOGE' }));

    // Arm the listeners BEFORE emitting — the broadcast is synchronous and
    // the messages can arrive before a post-emit once() listener attaches.
    const subbedNext = nextMessage(subbed);
    const idleNext = nextMessage(idle);
    (orch as unknown as EventEmitter).emit('cycle', {
      ts: 456, durationMs: 6,
      rows: [
        { pairKey: 'SOL-20261030-100-C', underlying: 'SOL' },
        { pairKey: 'ETH-20261030-2000-C', underlying: 'ETH' },
      ],
      signals,
      health: null, spots: {}, realtime: null, oliveCaveats: [],
      config: { ivSpreadThresholdVols: 3, pollIntervalMs: 15000, underlyings: ['SOL', 'ETH'], fees: {}, volPinnedAt: null },
    });

    const subbedMsg = await subbedNext;
    expect(subbedMsg.underlying).toBe('ETH'); // DOGE did not override
    expect(subbedMsg.rows).toHaveLength(1);
    expect(subbedMsg.rows[0].underlying).toBe('ETH');

    const idleMsg = await idleNext;
    expect(idleMsg.underlying).toBeNull();
    expect(idleMsg.rows).toEqual([]);
    expect(idleMsg.kpi).toBeDefined();

    subbed.close();
    idle.close();
  });

  it('filters /api/overview?underlying= and keeps the no-param form full', async () => {
    const app = await buildServer({ cfg, orchestrator: stubOrchestrator(), storage });
    await app.listen({ port: 0, host: '127.0.0.1' });
    servers.push({ close: () => app.close() });
    const { port } = app.server!.address() as AddressInfo;

    const filtered = await (await fetch(`http://127.0.0.1:${port}/api/overview?underlying=SOL`)).json();
    expect(filtered.underlying).toBe('SOL');
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.signals).toHaveLength(2); // both SOL signals
    expect(filtered.kpi.executableProfitableCount).toBe(1);

    const invalid = await (await fetch(`http://127.0.0.1:${port}/api/overview?underlying=DOGE`)).json();
    expect(invalid.underlying).toBe('SOL'); // normalized to the first configured

    const full = await (await fetch(`http://127.0.0.1:${port}/api/overview`)).json();
    expect(full.underlying).toBeNull();
    expect(full.rows).toHaveLength(2);
    expect(full.signals).toHaveLength(3);
  });

  it('rejects /api/surface for unconfigured underlyings (no upstream call per junk value)', async () => {
    const orch = stubOrchestrator();
    const asked: string[] = [];
    (orch as unknown as { getSurface: unknown }).getSurface = async (u: string) => (asked.push(u), {});
    const app = await buildServer({ cfg, orchestrator: orch, storage });
    await app.listen({ port: 0, host: '127.0.0.1' });
    servers.push({ close: () => app.close() });
    const { port } = app.server!.address() as AddressInfo;

    expect((await fetch(`http://127.0.0.1:${port}/api/surface?underlying=junk123`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/surface?underlying=eth`)).status).toBe(200);
    expect(asked).toEqual(['ETH']);
  });
});

describe('buildKpis — pool-aware Σ', () => {
  it('sums each pool\'s best clip, not per-row totals (shared custody)', () => {
    const rows = [
      sig('SOL-20261030-100-C', 'SOL', { totalNetUsdc: 10 }),
      sig('SOL-20261030-110-C', 'SOL', { totalNetUsdc: 7 }),   // same pool — must NOT add
      sig('ETH-20261030-2000-C', 'ETH', { totalNetUsdc: 4 }),
      sig('ETH-20261030-2100-C', 'ETH', { buyVenue: 'derive', sellVenue: 'olive', flags: ['direction_limited'], totalNetUsdc: 99 }), // not executable
    ];
    const k = buildKpis(rows);
    expect(k.totalExecutableUsd).toBe(14); // SOL best 10 + ETH best 4
    expect(k.executableProfitableCount).toBe(3);
  });

  it('a pool whose best clip loses at the expected fill contributes nothing (live 2026-10-27 regression)', () => {
    // Live: every BTC/ZEC row was quote-profitable but priced at a loss by
    // the marginal-fill model; Σ headlined −$16.87 and the count read 28.
    const rows = [
      sig('BTC-20261106-80000-C', 'BTC', { totalNetUsdc: 3, expectedTotalNetUsdc: -16.12 }),
      sig('ZEC-20261106-1300-C', 'ZEC', { totalNetUsdc: 1, expectedTotalNetUsdc: -2.21 }),
      sig('ETH-20261106-2200-P', 'ETH', { totalNetUsdc: 2.19, expectedTotalNetUsdc: 1.46 }),
      sig('ETH-20261106-2200-C', 'ETH', { totalNetUsdc: 2.98, expectedTotalNetUsdc: -5.21 }),
    ];
    const k = buildKpis(rows);
    expect(k.totalExecutableUsd).toBe(1.46);
    expect(k.executableProfitableCount).toBe(1);
    expect(k.topExecutable.map((s) => s.pairKey)).toEqual(['ETH-20261106-2200-P']);
  });

  it('keeps untradeable and price-distorted rows out of the headline', () => {
    const rows = [
      sig('SOL-20261030-100-C', 'SOL', { totalNetUsdc: 50, flags: ['stale'] }),
      sig('SOL-20261030-110-C', 'SOL', { totalNetUsdc: 40, flags: ['wide_book'] }),
      sig('SOL-20261030-120-C', 'SOL', { totalNetUsdc: 30, flags: ['price_distortion'] }),
      sig('SOL-20261030-125-C', 'SOL', { totalNetUsdc: 20, flags: ['fill_model_skipped'] }),
      sig('SOL-20261030-130-C', 'SOL', { totalNetUsdc: 2 }),
    ];
    const k = buildKpis(rows);
    expect(k.totalExecutableUsd).toBe(2);
    expect(k.executableProfitableCount).toBe(1);
    expect(k.topAny.map((s) => s.pairKey)).toEqual(['SOL-20261030-130-C']);
  });
});

describe('buildHealthRollup', () => {
  const NOW = 10_000_000;
  const venue = (status: string) => ({ venue: 'x', source: 'x', status, lastSuccessTs: NOW, lastError: null });
  const health = (over: Record<string, unknown> = {}, venues: Record<string, unknown> = {}) => ({
    venues: { derive: venue('ok'), olive: venue('ok'), ...venues }, serverTime: NOW, pollIntervalMs: 15_000,
    lastCycleMs: NOW - 5_000, lastCycleDurationMs: 15_000, ...over,
  }) as never;
  const base = { oliveCaveats: [] as string[], pollIntervalMs: 15_000, now: NOW };

  it('is ok when venues, cycle and stream are all fresh', () => {
    const r = buildHealthRollup({ ...base, health: health(), realtime: { status: 'live', statusSinceMs: NOW - 1e6, lastFrameAgeMs: 100, assets: [] } });
    expect(r).toEqual({ status: 'ok', reasons: [], warnings: [] });
  });

  it('degrades on a realtime stream stuck reconnecting (the 7.6-day live case)', () => {
    const r = buildHealthRollup({ ...base, health: health(), realtime: { status: 'reconnecting', statusSinceMs: NOW - 659_926_729, lastFrameAgeMs: 659_926_729, assets: [] } });
    expect(r.status).toBe('degraded');
    expect(r.reasons[0]).toMatch(/^realtime_reconnecting_/);
  });

  it('tolerates a brief reconnect', () => {
    const r = buildHealthRollup({ ...base, health: health(), realtime: { status: 'reconnecting', statusSinceMs: NOW - 10_000, lastFrameAgeMs: 10_000, assets: [] } });
    expect(r.status).toBe('ok');
  });

  it('degrades on a stale cycle, a non-ok venue, or a frozen market file', () => {
    const r = buildHealthRollup({ ...base, oliveCaveats: ['market_file_stale'], realtime: null,
      health: health({ lastCycleMs: NOW - 60_000 }, { derive: venue('stale') }) });
    expect(r.status).toBe('degraded');
    expect(r.reasons).toEqual(['derive_stale', 'cycle_stale_60s', 'market_file_stale']);
  });

  it('an additional venue being down warns but does not degrade (a restart cannot fix it)', () => {
    const r = buildHealthRollup({ ...base, realtime: null, health: health({}, { hypercall: venue('error') }) });
    expect(r).toEqual({ status: 'ok', reasons: [], warnings: ['hypercall_error'] });
  });

  it('reports starting before the first cycle', () => {
    expect(buildHealthRollup({ ...base, health: null, realtime: null }).status).toBe('starting');
  });
});
