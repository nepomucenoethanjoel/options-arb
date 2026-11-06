import { describe, expect, it, vi } from 'vitest';
import type { OliveMarketFileData } from '../src/adapters/olive/marketFile';
import { OlivePoolWatcher, poolAlerts, snapshotPool } from '../src/olivePools';

const file = (over: Partial<OliveMarketFileData>): OliveMarketFileData =>
  ({ venue: 'olive', underlying: 'X', spot: 1, vol: 0.5, underlyingFree: 0, usdcFreeUsd: 0, ...over }) as OliveMarketFileData;

describe('Olive pool snapshots', () => {
  it('call capacity is free underlying × oracle spot; puts are free USDC; hedges come from the map', () => {
    // Live BNB 2026-11-05: 0 BNB free, $10 USDC free, spot 715.555.
    expect(snapshotPool('BNB', file({ spot: 715.555, underlyingFree: 0, usdcFreeUsd: 10 }), 1)).toEqual({
      symbol: 'BNB', hedgeUnderlying: 'BNB', hedgeVenues: ['coincall', 'gate'], spot: 715.555, callCapacityUsd: 0, putCapacityUsd: 10, ts: 1,
    });
    // A dead oracle (PAXG) has no spot, so call capacity is unknown, not zero.
    expect(snapshotPool('PAXG', file({ spot: null, underlyingFree: 0.163116, usdcFreeUsd: 311 }), 1)).toMatchObject({ hedgeUnderlying: 'XAUT', spot: null, callCapacityUsd: null, putCapacityUsd: 311 });
    expect(snapshotPool('JUP', null, 1)).toMatchObject({ hedgeVenues: [], callCapacityUsd: null, putCapacityUsd: null });
  });
});

describe('poolAlerts', () => {
  const opts = { thresholdUsd: 1_000, tracked: ['SOL', 'BTC', 'ETH', 'ZEC'] };
  const prev = new Map([
    ['XRP', snapshotPool('XRP', file({ spot: 1.3, underlyingFree: 0, usdcFreeUsd: 0 }), 0)],
    ['BTC', snapshotPool('BTC', file({ spot: 80_000, underlyingFree: 0, usdcFreeUsd: 0 }), 0)],
    ['JUP', snapshotPool('JUP', file({ spot: 0.26, underlyingFree: 0, usdcFreeUsd: 0 }), 0)],
    ['PAXG', snapshotPool('PAXG', file({ spot: null, usdcFreeUsd: 311 }), 0)],
  ]);

  it('the first sweep only sets the baseline', () => {
    expect(poolAlerts(null, [snapshotPool('XRP', file({ spot: 1.3, underlyingFree: 5_000 }), 1)], opts)).toEqual([]);
  });

  it('alerts a hedgeable, untracked pool crossing the threshold — once', () => {
    const funded = snapshotPool('XRP', file({ spot: 1.3, underlyingFree: 1_000, usdcFreeUsd: 0 }), 1);
    const [a] = poolAlerts(prev, [funded], opts);
    expect(a).toContain('Olive XRP pool funded');
    expect(a).toContain('coincall, deribit, gate');
    expect(poolAlerts(new Map([['XRP', funded]]), [funded], opts)).toEqual([]); // still above: no repeat
  });

  it('never alerts tracked underlyings or pools with no hedge venue', () => {
    expect(poolAlerts(prev, [snapshotPool('BTC', file({ spot: 80_000, underlyingFree: 1 }), 1)], opts)).toEqual([]);
    expect(poolAlerts(prev, [snapshotPool('JUP', file({ spot: 0.26, underlyingFree: 100_000 }), 1)], opts)).toEqual([]);
  });

  it('alerts when a dead execution oracle comes back', () => {
    const [a] = poolAlerts(prev, [snapshotPool('PAXG', file({ spot: 4_100, underlyingFree: 0.16, usdcFreeUsd: 311 }), 1)], opts);
    expect(a).toContain('PAXG execution oracle is live again');
  });
});

describe('OlivePoolWatcher', () => {
  it('sweeps every market, notifies on the second sweep, and serves the latest snapshots', async () => {
    let xrpFree = 0;
    const notify = vi.fn(async () => true);
    const w = new OlivePoolWatcher({
      thresholdUsd: 1_000, sweepIntervalMs: 60_000, tracked: ['BTC'], notify,
      fetchMarkets: async () => ['BTC', 'XRP'],
      fetchFile: async (s) => (s === 'XRP' ? file({ spot: 1.3, underlyingFree: xrpFree }) : file({ spot: 80_000, underlyingFree: 0.03 })),
    });
    await w.sweep(1);
    expect(notify).not.toHaveBeenCalled();
    xrpFree = 2_000;
    await w.sweep(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(w.latest().map((s) => s.symbol)).toEqual(['XRP', 'BTC']); // largest capacity first
  });
});
