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
    // No custody snapshot → per-custody fields null, AUM-based liquidity.
    expect(d.underlyingFree).toBeNull();
    expect(d.usdcFreeUsd).toBeNull();
    expect(d.projectionBranch).toBe('blended_update');
    expect(d.volOnChainMs).toBe(1790433787_000);
  });

  it('parses per-custody free balances and recomputes liquidity like their UI', () => {
    // Live SOL values observed 2026-09-28: 29.93 SOL owned / 6.23 locked,
    // $1,296.32 USDC owned / 0 locked. Their "Available Liquidity" card reads
    // free-underlying × spot + free-USDC (≈$4,105 at the time).
    const withCustody = {
      ...fixture,
      state: {
        payload: {
          snapshot: {
            ...fixture.state.payload.snapshot,
            rawOnChainPoolSnapshot: {
              underlyingCustody: { tokenOwned: '29933457843', tokenLocked: '6226564999', decimals: 9 },
              usdcCustody: { tokenOwned: '1296319507', tokenLocked: '0', decimals: 6 },
            },
          },
        },
      },
    };
    const d = parseOliveMarketFile(withCustody, 'SOL')!;
    expect(d.underlyingFree).toBeCloseTo(23.706892844, 9);
    expect(d.usdcFreeUsd).toBeCloseTo(1296.319507, 6);
    expect(d.liquidityUsd).toBeCloseTo(23.706892844 * 123.027118125 + 1296.319507, 6);
  });

  it('clamps negative or malformed custody balances to null/zero', () => {
    const weird = {
      ...fixture,
      state: {
        payload: {
          snapshot: {
            ...fixture.state.payload.snapshot,
            rawOnChainPoolSnapshot: {
              underlyingCustody: { tokenOwned: '1000', tokenLocked: '4000', decimals: 9 }, // locked > owned → 0
              usdcCustody: { tokenOwned: 'nope', decimals: 6 }, // unparseable → null
            },
          },
        },
      },
    };
    const d = parseOliveMarketFile(weird, 'SOL')!;
    expect(d.underlyingFree).toBe(0);
    expect(d.usdcFreeUsd).toBeNull();
    // usdcFreeUsd null → custody liquidity formula not applicable
    expect(d.liquidityUsd).toBeCloseTo(4921.36137 - 131.723248, 4);
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

describe('parseOliveMarketFile — live borrow-curve rates', () => {
  const rateFixture = (underlying: {
    tokenOwned: string; tokenLocked: string;
  }, usdc: { tokenOwned: string; tokenLocked: string }) => ({
    ...fixture,
    state: {
      payload: {
        snapshot: {
          ...fixture.state.payload.snapshot,
          rawOnChainPoolSnapshot: {
            underlyingCustody: {
              tokenOwned: underlying.tokenOwned, tokenLocked: underlying.tokenLocked, decimals: 9,
              borrowRateCurve: { points: [
                { utilizationRateBps: '0', borrowRateBps: '800' },
                { utilizationRateBps: '8000', borrowRateBps: '3500' },
                { utilizationRateBps: '10000', borrowRateBps: '16000' },
              ] },
            },
            usdcCustody: {
              tokenOwned: usdc.tokenOwned, tokenLocked: usdc.tokenLocked, decimals: 6,
              borrowRateCurve: { points: [
                { utilizationRateBps: '0', borrowRateBps: '200' },
                { utilizationRateBps: '8000', borrowRateBps: '1500' },
                { utilizationRateBps: '10000', borrowRateBps: '8000' },
              ] },
            },
          },
        },
      },
    },
  });

  it('interpolates the curve at current utilization (SOL live values 2026-09-28)', () => {
    // 20.80% util → 8% + 27%×(20.8/80) = 15.02% long; USDC 0% util → 2.00%
    const d = parseOliveMarketFile(
      rateFixture({ tokenOwned: '29933457843', tokenLocked: '6226564999' }, { tokenOwned: '1296319507', tokenLocked: '0' }),
      'SOL',
    )!;
    expect(d.rates).not.toBeNull();
    expect(d.rates!.tokenApr).toBeCloseTo(0.1502, 3);
    expect(d.rates!.usdcApr).toBeCloseTo(0.02, 6);
  });

  it('rates move with utilization (BTC USDC custody 88.35% → 42.15% short rate)', () => {
    const d = parseOliveMarketFile(
      rateFixture({ tokenOwned: '851488', tokenLocked: '0' }, { tokenOwned: '424742682', tokenLocked: '375273880' }),
      'BTC',
    )!;
    expect(d.rates!.tokenApr).toBeCloseTo(0.08, 6);
    expect(d.rates!.usdcApr).toBeCloseTo(0.4215, 3);
  });

  it('rates are null when the custody snapshot or curves are absent', () => {
    const d = parseOliveMarketFile(fixture, 'SOL')!;
    expect(d.rates).toBeNull();
  });
});
