import { describe, expect, it } from 'vitest';
import { MARKET_FILE_MAX_AGE_MS, isMarketFileFresh, parseOliveMarketFile } from '../src/adapters/olive/marketFile';

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
  it('takes spot from the fresh execution oracle when the ticker list is empty (live shape 2026-11-05)', () => {
    const oracle = (over: object) => ({
      ...fixture,
      ticker: [],
      state: { payload: { snapshot: { ...fixture.state.payload.snapshot, executionOracle: { base: { label: 'SOL/USD', price: 96.534655625, status: 'fresh', isFresh: true, ...over } } } } },
    });
    expect(parseOliveMarketFile(oracle({}), 'SOL')!.spot).toBeCloseTo(96.534655625, 8);
    expect(parseOliveMarketFile(oracle({ isFresh: false, status: 'stale' }), 'SOL')!.spot).toBeNull();
    expect(parseOliveMarketFile(oracle({ label: 'BTC/USD' }), 'SOL')!.spot).toBeNull();
  });


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

describe('market-file freshness', () => {
  const asOf = Date.parse(fixture.asOf);

  it('carries the file asOf, and null (not "now") when it is missing', () => {
    expect(parseOliveMarketFile(fixture, 'SOL')!.asOfMs).toBe(asOf);
    const { asOf: _omit, ...noAsOf } = fixture;
    expect(parseOliveMarketFile(noAsOf, 'SOL')!.asOfMs).toBeNull();
  });

  it('treats a frozen or undated file as not live', () => {
    expect(isMarketFileFresh({ asOfMs: asOf }, asOf + 1_000)).toBe(true);
    expect(isMarketFileFresh({ asOfMs: asOf }, asOf + MARKET_FILE_MAX_AGE_MS + 1)).toBe(false);
    expect(isMarketFileFresh({ asOfMs: null }, asOf)).toBe(false);
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

  it('exposes the raw curve nodes (deduped, sorted) for marginal-fill pricing', () => {
    const d = parseOliveMarketFile(
      rateFixture({ tokenOwned: '29933457843', tokenLocked: '6226564999' }, { tokenOwned: '1296319507', tokenLocked: '0' }),
      'SOL',
    )!;
    expect(d.curves.token).toEqual([
      { utilizationBps: 0, rateBps: 800 },
      { utilizationBps: 8000, rateBps: 3500 },
      { utilizationBps: 10000, rateBps: 16000 },
    ]);
    expect(d.curves.usdc).toEqual([
      { utilizationBps: 0, rateBps: 200 },
      { utilizationBps: 8000, rateBps: 1500 },
      { utilizationBps: 10000, rateBps: 8000 },
    ]);
    // No snapshot → no curves, without breaking the rest of the parse.
    const bare = parseOliveMarketFile(fixture, 'SOL')!;
    expect(bare.curves.token).toBeNull();
    expect(bare.curves.usdc).toBeNull();
  });
});

describe('parseOliveMarketFile — fixed-rate state and escrow (DATA_SOURCES row 78)', () => {
  // Live SOL market file 2026-11-15 08:41 UTC (rawOnChainPoolSnapshot excerpt).
  const live = (escrowNative = '0') => ({
    ...fixture,
    state: {
      payload: {
        snapshot: {
          ...fixture.state.payload.snapshot,
          rawOnChainPoolSnapshot: {
            poolAccount: {
              fixedRateBetaBps: '2500',
              fixedRateStates: [
                { liveExposureNative: '61661767000', timeValueNative: '402716025749638000' },
                { liveExposureNative: '3063562823', timeValueNative: '1492554189343622' },
              ],
            },
            underlyingCustody: {
              decimals: 9, tokenOwned: '65671025202', tokenLocked: '61871766999', pendingEscrowNative: escrowNative,
              borrowRateCurve: { points: [
                { utilizationRateBps: '0', borrowRateBps: '0' },
                { utilizationRateBps: '7500', borrowRateBps: '2000' },
                { utilizationRateBps: '10000', borrowRateBps: '12000' },
              ] },
            },
            usdcCustody: {
              decimals: 6, tokenOwned: '3341817862', tokenLocked: '3063562823', pendingEscrowNative: '0',
              borrowRateCurve: { points: [
                { utilizationRateBps: '0', borrowRateBps: '0' },
                { utilizationRateBps: '7500', borrowRateBps: '1000' },
                { utilizationRateBps: '10000', borrowRateBps: '6000' },
              ] },
            },
          },
        },
      },
    },
  });

  it('exposes each side’s fixed-rate exposure in display units', () => {
    const d = parseOliveMarketFile(live(), 'SOL')!;
    expect(d.fixedRate.token).toEqual({ betaBps: 2500, exposure: 61.661767, timeValue: 402716025.749638 });
    expect(d.fixedRate.usdc!.exposure).toBeCloseTo(3063.562823, 6);
    expect(d.fixedRate.usdc!.timeValue).toBeCloseTo(1492554189.343622, 3);
    // Variable part unchanged: 94.21% token utilization → 96.85%; the premium is added per tenor at pricing.
    expect(d.rates!.tokenApr).toBeCloseTo(0.9685, 3);
  });

  it('is null when the pool account carries no fixed-rate state', () => {
    expect(parseOliveMarketFile(fixture, 'SOL')!.fixedRate).toEqual({ token: null, usdc: null });
  });

  it('excludes pending limit-order escrow from owned, free and utilization', () => {
    const d = parseOliveMarketFile(live('1000000000'), 'SOL')!; // 1 SOL escrowed
    expect(d.underlyingOwned).toBeCloseTo(64.671025202, 9);
    expect(d.underlyingFree).toBeCloseTo(64.671025202 - 61.871766999, 9);
    expect(d.rates!.tokenApr).toBeGreaterThan(parseOliveMarketFile(live(), 'SOL')!.rates!.tokenApr);
  });
});

describe('parseOliveMarketFile — curve shape (DATA_SOURCES row 79)', () => {
  // Live SOL market file 2026-11-19 10:19 UTC; Olive's own state-history variable rates: 4983 / 7677 bp.
  const live = {
    ...fixture,
    state: { payload: { snapshot: { ...fixture.state.payload.snapshot, rawOnChainPoolSnapshot: {
      underlyingCustody: { decimals: 9, tokenOwned: '123273331918', tokenLocked: '106202809999', pendingEscrowNative: '0',
        borrowRateCurve: { points: [{ utilizationRateBps: '0', borrowRateBps: '0' }, { utilizationRateBps: '7500', borrowRateBps: '2000' }, { utilizationRateBps: '10000', borrowRateBps: '17000' }, { utilizationRateBps: '10000', borrowRateBps: '17000' }] } },
      usdcCustody: { decimals: 6, tokenOwned: '6889357269', tokenLocked: '6316836027', pendingEscrowNative: '0',
        borrowRateCurve: { points: [{ utilizationRateBps: '0', borrowRateBps: '0' }, { utilizationRateBps: '7500', borrowRateBps: '1000' }, { utilizationRateBps: '10000', borrowRateBps: '16000' }, { utilizationRateBps: '10000', borrowRateBps: '16000' }] } },
    } } } },
  };
  it('reproduces Olive’s variable rates with the quadratic shape, to the bp', () => {
    const d = parseOliveMarketFile(live, 'SOL', 'quadratic')!;
    expect(d.curveShape).toBe('quadratic');
    expect(Math.round(d.rates!.tokenApr * 1e4)).toBe(4983);
    expect(Math.round(d.rates!.usdcApr * 1e4)).toBe(7677);
  });
  it('the linear shape overstates them badly above the kink (what the app priced before this fix)', () => {
    const d = parseOliveMarketFile(live, 'SOL', 'linear')!;
    expect(d.rates!.tokenApr).toBeGreaterThan(0.86);
    expect(d.rates!.usdcApr).toBeGreaterThan(1.1);
  });
});
