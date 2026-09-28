import { describe, expect, it } from 'vitest';
import { parseOliveMarketFile } from '../src/adapters/olive/marketFile';

const fixture = {
  asOf: '2026-09-27T21:26:24.284Z',
  ticker: [
    { symbol: 'SOL/USD', price: 123.027118125 },
    { symbol: 'BTC/USD', price: 84660.96 },
    { symbol: 'USDC/USD', price: 0.99989496375 },
  ],
  state: {
    payload: {
      snapshot: {
        poolSummary: {
          aumUsd: 4921.36137,
          openPositionEntryClaimsUsd: 131.723248,
        },
        volatility: {
          volatility: 0.690187,
          volatilityPercent: 69.0187,
          timestamp: 1790433787,
          tau: 1296000,
          projectionBranch: 'blended_update',
        },
      },
    },
  },
};

describe('parseOliveMarketFile', () => {
  it('extracts spot, live vol, and the liquidity proxy', () => {
    const d = parseOliveMarketFile(fixture, 'SOL')!;
    expect(d.venue).toBe('olive');
    expect(d.spot).toBeCloseTo(123.027118125, 8);
    expect(d.vol).toBeCloseTo(0.690187, 8);
    expect(d.aumUsd).toBeCloseTo(4921.36137, 4);
    expect(d.entryClaimsUsd).toBeCloseTo(131.723248, 4);
    expect(d.liquidityUsd).toBeCloseTo(4921.36137 - 131.723248, 4);
    expect(d.projectionBranch).toBe('blended_update');
    expect(d.volOnChainMs).toBe(1790433787_000);
  });

  it('handles E6-scaled on-chain projection amounts', () => {
    const alt = {
      asOf: fixture.asOf,
      ticker: fixture.ticker,
      state: {
        payload: {
          snapshot: {
            poolAccount: { aumUsd: '4921361370', openPositionEntryClaimsUsd: '131723248' },
            volatility: fixture.state.payload.snapshot.volatility,
          },
        },
      },
    };
    const d = parseOliveMarketFile(alt, 'SOL')!;
    expect(d.aumUsd).toBeCloseTo(4921.36137, 4);
    expect(d.liquidityUsd).toBeCloseTo(4789.638, 3);
  });

  it('returns null when neither spot nor vol is present', () => {
    expect(parseOliveMarketFile({ ticker: [], state: {} }, 'SOL')).toBeNull();
    expect(parseOliveMarketFile(null, 'SOL')).toBeNull();
  });
});
