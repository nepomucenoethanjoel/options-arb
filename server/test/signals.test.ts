import { describe, expect, it } from 'vitest';
import { bsPrice, isHeadlineProfitable, type MatchRow, type OptionQuote, type Signal } from '@options-arb/shared';
import { toLiteRows } from '../src/scheduler';
import { computeSignals, isPersistWorthy, type SignalConfig } from '../src/signals/engine';

describe('toLiteRows (WS payload projection)', () => {
  it('projects flat fields without nested quotes', () => {
    const row: MatchRow = {
      pairKey: 'ETH-20261030-2900-C',
      underlying: 'ETH',
      expiryTs: 1,
      expiryDate: '20261030',
      strike: 2900,
      kind: 'call',
      matchType: 'exact_match',
      legs: {
        derive: {
          venue: 'derive',
          instrumentId: 'ETH-20261030-2900-C',
          quote: {
            venue: 'derive', instrumentId: 'x', ts: 0, bid: 79, bidSize: 5, ask: 81, askSize: 5,
            mark: 80, iv: 0.6, ivSource: 'market', source: 't',
          },
        },
        olive: {
          venue: 'olive',
          instrumentId: 'o',
          quote: {
            venue: 'olive', instrumentId: 'y', ts: 0, bid: null, bidSize: null, ask: null, askSize: null,
            mark: 70.5, iv: 0.55, ivSource: 'model', source: 't',
          },
          note: 'amm_synthetic',
        },
      },
    };
    const [lite] = toLiteRows([row]);
    expect(lite.pairKey).toBe(row.pairKey);
    expect(lite.venues.derive).toEqual({ iv: 0.6, bid: 79, ask: 81, mark: 80 });
    expect(lite.venues.olive).toEqual({ iv: 0.55, bid: null, ask: null, mark: 70.5 });
    expect(lite.note).toBe('amm_synthetic');
    expect(JSON.stringify(lite)).not.toContain('greeks');
    expect(JSON.stringify(lite)).not.toContain('instrumentId');
  });
});

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

const cfg: SignalConfig = {
  ivSpreadThresholdVols: 3,
  minBookSize: 0.1,
  maxRelBookWidth: 0.2,
  nearExpiryDays: 2,
  staleQuoteMs: 60_000,
  deriveTakerFeeBps: 3,
  oliveFeeNotionalBps: 2.5,
  oliveFeePremiumPct: 10,
  solanaFeeUsdc: 0.05,
  capitalBorrowRateApr: 0.08,
  poolLiquidityUsdByAsset: {},
  poolCustodyByAsset: {},
};

function deriveQuote(overrides: Partial<OptionQuote> = {}): OptionQuote {
  return {
    venue: 'derive',
    instrumentId: 'ETH-20261030-2900-C',
    ts: NOW,
    bid: 79,
    bidSize: 5,
    ask: 81,
    askSize: 5,
    mark: 80,
    indexPrice: 3000,
    iv: 0.6,
    ivSource: 'market',
    greeks: { delta: 0.41, gamma: 0.002, vega: 1000, theta: -120, rho: 5 },
    forward: 3005,
    discountFactor: 0.99,
    source: 'derive:v3-rest',
    ...overrides,
  };
}

function oliveQuote(mark = 70, iv = 0.55): OptionQuote {
  return {
    venue: 'olive',
    instrumentId: 'OLIVE-SYNTH-ETH-20261030-2900-C',
    ts: NOW,
    bid: null,
    bidSize: null,
    ask: null,
    askSize: null,
    mark,
    indexPrice: 3000,
    iv,
    ivSource: 'model',
    forward: 3000,
    discountFactor: 1,
    source: 'olive:synthetic-amm',
  };
}

function row(
  dq: OptionQuote | null,
  oq: OptionQuote | null,
  expiryTs = NOW + 30 * 86_400_000,
  overrides: Partial<MatchRow> = {},
): MatchRow {
  return {
    pairKey: 'ETH-20261030-2900-C',
    underlying: 'ETH',
    expiryTs,
    expiryDate: '20261030',
    strike: 2900,
    kind: 'call',
    matchType: 'exact_match',
    legs: {
      derive: { venue: 'derive', instrumentId: dq?.instrumentId ?? null, quote: dq },
      olive: { venue: 'olive', instrumentId: oq?.instrumentId ?? null, quote: oq },
    },
    ...overrides,
  };
}

describe('computeSignals — profit estimates', () => {
  it('prices the Derive sell side at the bid (conservative executable)', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    expect([s.buyVenue, s.sellVenue]).toEqual(['olive', 'derive']);
    expect(s.entryPriceUsdc).toBe(70); // Olive AMM premium
    expect(s.exitPriceUsdc).toBe(79); // Derive BID, not mid (80)
    expect(s.edgeUsdc).toBeCloseTo(9, 6);
  });

  it('nets fees and collateral drag into the per-contract profit', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    const costs = 3000 * 0.0003 + Math.min(3000 * 0.00025, 70 * 0.1); // 0.9 + 0.75 (Solana tx fee is per clip)
    expect(s.costsUsdc).toBeCloseTo(costs, 4);
    const capital = 3000 * 0.08 * (30 / 365);
    expect(s.capitalCostUsdc).toBeCloseTo(capital, 4);
    expect(s.netEdgeUsdc).toBeCloseTo(9 - costs, 4);
    expect(s.netAfterCapitalUsdc).toBeCloseTo(9 - costs - capital, 4);
    // With an 8% APR drag on full collateral, this trade is NOT profitable.
    expect(s.isProfitable).toBe(false);
  });

  it('flags profitable when gross edge beats costs + drag', () => {
    const [s] = computeSignals([row(deriveQuote({ bid: 100, ask: 104, mark: 102 }), oliveQuote(70))], cfg, NOW);
    // gross 30; costs 1.7; capital 19.73 → net ≈ +8.57
    expect(s.edgeUsdc).toBeCloseTo(30, 6);
    expect(s.isProfitable).toBe(true);
    expect(s.netAfterCapitalUsdc).toBeGreaterThan(0);
  });

  it('caps the size at the Derive touch and totals the profit', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 3, askSize: 7 }), oliveQuote())], cfg, NOW);
    expect(s.maxExecutableSize).toBe(3);
    expect(s.totalNetUsdc).toBeCloseTo(s.netAfterCapitalUsdc! * 3 - 0.5 - 0.05, 2); // − $0.50 Derive order fee − Solana tx
    // score is USDC-native: the size-capped total ranks first
    expect(s.score).toBeCloseTo(s.totalNetUsdc!, 2);
  });

  it('sizes by the direction-relevant book side, not the min of both', () => {
    // Derive richer (iv 0.6 > 0.55) → buy Olive / sell Derive → exit into the
    // BID: 300 contracts available there; the 3-lot ask must not cap it.
    const [sellIntoBid] = computeSignals([row(deriveQuote({ bidSize: 300, askSize: 3 }), oliveQuote())], cfg, NOW);
    expect([sellIntoBid.buyVenue, sellIntoBid.sellVenue]).toEqual(['olive', 'derive']);
    expect(sellIntoBid.maxExecutableSize).toBe(300);
    // Olive richer → buy Derive / sell Olive → entry lifts the ASK: 3 lots.
    const [liftAsk] = computeSignals(
      [row(deriveQuote({ bidSize: 300, askSize: 3, iv: 0.5 }), oliveQuote(70, 0.55))],
      cfg,
      NOW,
    );
    expect([liftAsk.buyVenue, liftAsk.sellVenue]).toEqual(['derive', 'olive']);
    expect(liftAsk.maxExecutableSize).toBe(3);
  });

  it('caps size by the scalar pool fallback when it binds (estimated)', () => {
    // Pool has $4,195; collateral per call = spot 3000 → capacity 1 contract
    // vs book size 5 → capped to 1 with the flag. No custody data → the
    // AUM-based estimate is flagged pool_capacity_estimated.
    const capped = { ...cfg, poolLiquidityUsdByAsset: { ETH: 4195 } };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 5, askSize: 5 }), oliveQuote())], capped, NOW);
    expect(s.maxExecutableSize).toBe(1);
    expect(s.flags).toContain('pool_capacity_capped');
    expect(s.flags).toContain('pool_capacity_estimated');
    expect(s.totalNetUsdc).toBeCloseTo(s.netAfterCapitalUsdc! * 1 - 0.5 - 0.05, 2);
  });

  it('caps calls by the free underlying custody (live market-file data)', () => {
    // 2 SOL-equivalents of free underlying custody vs book size 5 → 2 calls,
    // capped by the exact custody number (not the AUM estimate, no flag).
    const custody = { ...cfg, poolCustodyByAsset: { ETH: { underlyingFree: 2, usdcFreeUsd: 1_000_000 } } };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 5, askSize: 5 }), oliveQuote())], custody, NOW);
    expect(s.maxExecutableSize).toBe(2);
    expect(s.flags).toContain('pool_capacity_capped');
    expect(s.flags).not.toContain('pool_capacity_estimated');
  });

  it('caps puts by the free USDC custody (each put locks K USDC)', () => {
    // $5,000 free USDC, K = 2900 → 5000/2900 ≈ 1.72 puts vs book size 5.
    // Fractional, like the call side — the AMM mints fractional options
    // (their UI quotes e.g. "30.905 Calls").
    const custody = { ...cfg, poolCustodyByAsset: { ETH: { underlyingFree: 50, usdcFreeUsd: 5000 } } };
    const [s] = computeSignals(
      [row(deriveQuote({ bidSize: 5, askSize: 5, iv: 0.6 }), oliveQuote(70, 0.55), NOW + 30 * 86_400_000, { kind: 'put', pairKey: 'ETH-20261030-2900-P' })],
      custody,
      NOW,
    );
    expect(s.maxExecutableSize).toBeCloseTo(5000 / 2900, 4);
    expect(s.flags).toContain('pool_capacity_capped');
  });

  it('prefers the custody cap over the looser scalar fallback', () => {
    // Custody allows 2 calls; the AUM scalar would allow 33 — custody wins.
    const both = {
      ...cfg,
      poolLiquidityUsdByAsset: { ETH: 100_000 },
      poolCustodyByAsset: { ETH: { underlyingFree: 2, usdcFreeUsd: 1_000_000 } },
    };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 5, askSize: 5 }), oliveQuote())], both, NOW);
    expect(s.maxExecutableSize).toBe(2);
    expect(s.flags).not.toContain('pool_capacity_estimated');
  });

  it('falls back to the scalar only when the custody value for that kind is unknown', () => {
    // Custody snapshot carries USDC only; a CALL has no underlying cap →
    // the scalar applies (and is flagged estimated when it binds).
    const partial = {
      ...cfg,
      poolLiquidityUsdByAsset: { ETH: 4195 },
      poolCustodyByAsset: { ETH: { underlyingFree: null, usdcFreeUsd: 5000 } },
    };
    const [call] = computeSignals([row(deriveQuote({ bidSize: 5, askSize: 5 }), oliveQuote())], partial, NOW);
    expect(call.maxExecutableSize).toBe(1); // floor(4195 / 3000)
    expect(call.flags).toContain('pool_capacity_estimated');
    // A PUT in the same pool is capped by the live USDC custody instead:
    // 5000/2900 ≈ 1.72 puts, exact — not estimated.
    const [put] = computeSignals(
      [row(deriveQuote({ bidSize: 5, askSize: 5, iv: 0.6 }), oliveQuote(70, 0.55), NOW + 30 * 86_400_000, { kind: 'put', pairKey: 'ETH-20261030-2900-P' })],
      partial,
      NOW,
    );
    expect(put.maxExecutableSize).toBeCloseTo(5000 / 2900, 4);
    expect(put.flags).not.toContain('pool_capacity_estimated');
  });

  it('does not cap when the pool liquidity is unknown for the asset', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 5, askSize: 5 }), oliveQuote())], cfg, NOW);
    expect(s.maxExecutableSize).toBe(5);
    expect(s.flags).not.toContain('pool_capacity_capped');
  });

  it('reports ROI APY on the locked collateral', () => {
    const [s] = computeSignals([row(deriveQuote({ bid: 100, ask: 104, mark: 102 }), oliveQuote(70))], cfg, NOW);
    const tau = 30 / 365;
    expect(s.roiApyPct).toBeCloseTo((s.netAfterCapitalUsdc! / 3000 / tau) * 100, 1);
  });

  it('quantifies ~1σ settlement basis risk', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    const expected = 0.41 * 3000 * 0.6 * Math.sqrt(0.5 / (365 * 24));
    expect(s.settlementBasisUsdc).toBeCloseTo(expected, 4);
    expect(s.settlementBasisUsdc!).toBeGreaterThan(0);
  });

  it('reprices the Derive leg at Olive vol for the §3.2 cross-check', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    const tau = 30 / 365;
    const reprice = bsPrice({ forward: 3005, strike: 2900, tauYears: tau, vol: 0.55, discountFactor: 0.99, kind: 'call' });
    expect(s.syntheticCrossCheckUsdc).toBeCloseTo(80 - reprice, 3);
  });

  it('computes the vega-linear residual in consistent units (vega per vol point × 100)', () => {
    // Small vol gap → the exact reprice ≈ vega-linear estimate; Derive's
    // vega is per 1 vol POINT, so the estimator must scale by 100 to match.
    const tau = 30 / 365;
    const fair = bsPrice({ forward: 3005, strike: 2900, tauYears: tau, vol: 0.55, discountFactor: 0.99, kind: 'call' });
    const perPoint = 3.3; // $ per 1 vol point, Derive's convention
    const q = deriveQuote({ iv: 0.55, mark: fair, greeks: { delta: 0.41, gamma: 0.002, vega: perPoint, theta: -120, rho: 5 } });
    const [s] = computeSignals([row(q, oliveQuote(fair, 0.545))], cfg, NOW);
    expect(s.crossCheckDeviationUsdc).not.toBeNull();
    expect(Math.abs(s.crossCheckDeviationUsdc!)).toBeLessThan(0.1); // ≈$1.6 estimate, well under 10% off
  });

  it('flags price_distortion when the book mid dislocates from the model mark', () => {
    // Small vol gap (edge ~$7) but bid/ask pushed $30 above the model mark:
    // the mid-vs-mark dislocation dominates the claimed edge.
    const tau = 30 / 365;
    const fair = bsPrice({ forward: 3005, strike: 2900, tauYears: tau, vol: 0.6, discountFactor: 0.99, kind: 'call' });
    const q = deriveQuote({ mark: fair, bid: fair + 30, ask: fair + 32 });
    const [s] = computeSignals([row(q, oliveQuote(fair - 7, 0.58))], cfg, NOW);
    expect(s.flags).toContain('price_distortion');
    expect(s.bookVsMarkUsdc).toBeCloseTo(31, 4);
  });

  it('does not flag distortion when the mark is consistent with its IV', () => {
    // Mark IS the BS price at its IV and the book brackets it tightly.
    const tau = 30 / 365;
    const fair = bsPrice({ forward: 3005, strike: 2900, tauYears: tau, vol: 0.6, discountFactor: 0.99, kind: 'call' });
    const q = deriveQuote({ mark: fair, bid: fair - 0.5, ask: fair + 0.5 });
    const [s] = computeSignals([row(q, oliveQuote())], cfg, NOW);
    expect(s.flags).not.toContain('price_distortion');
    expect(s.bookVsMarkUsdc).toBeCloseTo(0, 4);
  });

  it('uses the ask when Derive is the cheap leg', () => {
    const [s] = computeSignals([row(deriveQuote({ iv: 0.5 }), oliveQuote(75, 0.55))], cfg, NOW);
    expect([s.buyVenue, s.sellVenue]).toEqual(['derive', 'olive']);
    expect(s.flags).toContain('direction_limited');
    expect(s.entryPriceUsdc).toBe(81); // Derive ask
    expect(s.exitPriceUsdc).toBe(75); // Olive AMM premium
    expect(s.edgeUsdc).toBeCloseTo(-6, 6);
  });
});

describe('computeSignals — gating and sorting (unchanged semantics)', () => {
  it('computes spread and flags threshold opportunities', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    expect(s.ivSpreadVols).toBeCloseTo(5, 5);
    expect(s.ivSpreadBps).toBeCloseTo(833.3, 1);
    expect(s.isOpportunity).toBe(true);
    expect(s.flags).toContain('amm_pool_depth_unknown');
  });

  it('does not flag below threshold', () => {
    const [s] = computeSignals([row(deriveQuote({ iv: 0.56 }), oliveQuote(70, 0.55))], cfg, NOW);
    expect(s.isOpportunity).toBe(false);
    expect(s.ivSpreadVols).toBeCloseTo(1, 5);
  });

  it('marks non-executable when the Derive book is empty (v3 zero-book case)', () => {
    const q = deriveQuote({ bid: null, ask: null, bidSize: null, askSize: null });
    const [s] = computeSignals([row(q, oliveQuote())], cfg, NOW);
    expect(s.flags).toContain('no_book');
    expect(s.isOpportunity).toBe(false);
    expect(s.maxExecutableSize).toBeNull();
    expect(s.totalNetUsdc).toBeNull();
    expect(s.score).toBeCloseTo(s.netAfterCapitalUsdc! * 0.4, 2); // discounted
  });

  it('marks thin and wide books', () => {
    const thin = deriveQuote({ bidSize: 0.01, askSize: 0.01 });
    const [s1] = computeSignals([row(thin, oliveQuote())], cfg, NOW);
    expect(s1.flags).toContain('thin_book');
    expect(s1.isOpportunity).toBe(false);

    const wide = deriveQuote({ bid: 50, ask: 120 });
    const [s2] = computeSignals([row(wide, oliveQuote())], cfg, NOW);
    expect(s2.flags).toContain('wide_book');
  });

  it('marks stale quotes and near-expiry rows', () => {
    const stale = deriveQuote({ ts: NOW - 120_000 });
    const [s1] = computeSignals([row(stale, oliveQuote())], cfg, NOW);
    expect(s1.flags).toContain('stale');

    const [s2] = computeSignals([row(deriveQuote(), oliveQuote(), NOW + 1 * 86_400_000)], cfg, NOW);
    expect(s2.flags).toContain('near_expiry');
  });

  it('skips rows without both IVs', () => {
    expect(computeSignals([row(null, oliveQuote())], cfg, NOW)).toHaveLength(0);
    expect(computeSignals([row(deriveQuote({ iv: null }), oliveQuote())], cfg, NOW)).toHaveLength(0);
  });

  it('sorts opportunities first, then profitable, then by USDC score', () => {
    const rows = [
      row(deriveQuote(), oliveQuote()), // opportunity, unprofitable after capital drag
      row(deriveQuote({ bid: 100, ask: 104, mark: 102 }), oliveQuote(70)), // opportunity + profitable
      row(deriveQuote({ bid: null, ask: null }), oliveQuote()), // not executable
    ];
    const signals = computeSignals(rows, cfg, NOW);
    expect(signals[0].isProfitable).toBe(true);
    expect(signals[signals.length - 1].isOpportunity).toBe(false);
  });
});

describe('isPersistWorthy — 1/min burst-persistence gate', () => {
  const sig = (overrides: Partial<Signal>): Signal => ({
    pairKey: 'X', underlying: 'SOL', expiryDate: '20261030', expiryTs: 0, strike: 100,
    kind: 'call', ivSpreadVols: 5, ivSpreadBps: 800, entryPriceUsdc: 1, exitPriceUsdc: 2,
    edgeUsdc: 1, netEdgeUsdc: 0.9, netAfterCapitalUsdc: 0.5, costsUsdc: 0.1, capitalCostUsdc: 0.4,
    maxExecutableSize: 10, totalNetUsdc: 5, roiApyPct: 10, settlementBasisUsdc: 0.1,
    expectedEntryUsdc: null, expectedNetAfterCapitalUsdc: null, expectedTotalNetUsdc: null,
    syntheticCrossCheckUsdc: 0, crossCheckDeviationUsdc: 0, bookVsMarkUsdc: 0, score: 5,
    isOpportunity: true, isProfitable: true, buyVenue: 'olive', sellVenue: 'derive', flags: [], ts: 0,
    ...overrides,
  });

  it('keeps executable-direction opportunity/profitable rows with size', () => {
    expect(isPersistWorthy(sig({}))).toBe(true);
    expect(isPersistWorthy(sig({ isOpportunity: false, isProfitable: true }))).toBe(true);
    expect(isPersistWorthy(sig({ isOpportunity: true, isProfitable: false }))).toBe(true);
  });

  it('drops LP-only directions and price-distorted books to the 10-min floor', () => {
    expect(isPersistWorthy(sig({ buyVenue: 'derive', sellVenue: 'olive', flags: ['direction_limited'] }))).toBe(false);
    expect(isPersistWorthy(sig({ flags: ['price_distortion'] }))).toBe(false);
  });

  it('drops zero/null-size and uninteresting rows', () => {
    expect(isPersistWorthy(sig({ maxExecutableSize: 0 }))).toBe(false);
    expect(isPersistWorthy(sig({ maxExecutableSize: null }))).toBe(false);
    expect(isPersistWorthy(sig({ isOpportunity: false, isProfitable: false }))).toBe(false);
  });
});

describe('computeSignals — mismatched-legs guard', () => {
  // Nearest-strike / expiry-offset matches pair contracts whose payoffs do
  // NOT converge — the vol spread stays, the profit estimate must not.
  it('keeps the IV spread but nulls every profit field for a strike-mismatched leg', () => {
    const r = row(deriveQuote(), oliveQuote());
    r.legs.olive!.strikeOffset = 10; // interpolated match, e.g. 2910 vs 2900
    const [s] = computeSignals([r], cfg, NOW);
    expect(s.ivSpreadVols).toBeCloseTo(5, 5);
    expect([s.buyVenue, s.sellVenue]).toEqual(['olive', 'derive']);
    expect(s.flags).toContain('mismatched_legs');
    expect(s.entryPriceUsdc).toBeNull();
    expect(s.exitPriceUsdc).toBeNull();
    expect(s.edgeUsdc).toBeNull();
    expect(s.netEdgeUsdc).toBeNull();
    expect(s.netAfterCapitalUsdc).toBeNull();
    expect(s.maxExecutableSize).toBeNull();
    expect(s.totalNetUsdc).toBeNull();
    expect(s.roiApyPct).toBeNull();
    expect(s.isProfitable).toBe(false);
    expect(s.isOpportunity).toBe(false); // NON_EXECUTABLE_FLAGS includes mismatched_legs
  });

  it('nulls profit for an expiry-offset match even at the same strike', () => {
    const r = row(deriveQuote(), oliveQuote());
    r.legs.olive!.expiryOffsetDays = 1; // exact strike, ±1-day tolerance match
    const [s] = computeSignals([r], cfg, NOW);
    expect(s.flags).toContain('mismatched_legs');
    expect(s.edgeUsdc).toBeNull();
    expect(s.isOpportunity).toBe(false);
  });

  it('same-contract AMM rows (no offsets) keep full profit estimates', () => {
    const [s] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW);
    expect(s.flags).not.toContain('mismatched_legs');
    expect(s.edgeUsdc).toBeCloseTo(9, 6);
    expect(s.maxExecutableSize).toBe(5);
  });
});

describe('fee models — verified against venue docs + a live fill (2026-09-29)', () => {
  it('Derive taker: min(3bps × notional, 12.5% × leg premium) — the cap binds on cheap legs', () => {
    // Deep-OTM put, derive ask $2.1: 3bps of $3000 notional = $0.90, but
    // 12.5% of the $2.1 premium = $0.2625 binds.
    const q = deriveQuote({ bid: 1.9, ask: 2.1, mark: 2, iv: 0.4, bidSize: 5, askSize: 5 });
    const [s] = computeSignals([row(q, oliveQuote(3, 0.55))], cfg, NOW);
    const deriveFee = Math.min(3000 * 0.0003, 2.1 * 0.125);
    const oliveFee = Math.min(3000 * 0.00025, 3 * 0.1); // 10% premium cap binds
    expect(s.costsUsdc).toBeCloseTo(deriveFee + oliveFee, 6); // Solana tx fee is per clip
  });

  it('Olive fee uses ORACLE-SPOT notional for both kinds (live-fill fixture)', () => {
    // ZEC put filled 2026-09-29: qty 0.031854, oracle spot $1,460.30 — the
    // venue charged $0.011628 = min(2.5bps × qty × SPOT, 10% × premium).
    // The old strike-based base (K≈1,670) would have charged $0.0133.
    const qty = 0.031854, spot = 1460.30, premium = 10.99;
    expect(Math.min(qty * spot * 0.00025, qty * premium * 0.1)).toBeCloseTo(0.011628, 5);
  });

  it('charges the $0.50 Derive order fee and the Solana tx fee once per clip, not per contract', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 3, askSize: 7 }), oliveQuote())], cfg, NOW);
    expect(s.totalNetUsdc).toBeCloseTo(s.netAfterCapitalUsdc! * 3 - 0.5 - 0.05, 1); // totals round to 2dp
  });
});

describe('execution own-impact + pool-aware totals (2026-09-29)', () => {
  it('flags execution_moves_rate when a full fill pushes the custody past 90% utilization', () => {
    // 50% utilized pool (5 free of 10 owned): a 5-call max fill → 100% —
    // the convex borrow curve reprices the AMM mid-fill (observed live:
    // a ~$50 ZEC fill moved the short rate 30% → 69.5%).
    const custody = { ...cfg, poolCustodyByAsset: { ETH: { underlyingFree: 5, underlyingOwned: 10, usdcFreeUsd: 1e6 } } };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20 }), oliveQuote())], custody, NOW);
    expect(s.maxExecutableSize).toBe(5);
    expect(s.flags).toContain('execution_moves_rate');
  });

  it('does not flag when plenty of headroom remains', () => {
    const custody = { ...cfg, poolCustodyByAsset: { ETH: { underlyingFree: 95, underlyingOwned: 100, usdcFreeUsd: 1e6 } } };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 3, askSize: 3 }), oliveQuote())], custody, NOW);
    expect(s.maxExecutableSize).toBe(3);
    expect(s.flags).not.toContain('execution_moves_rate');
  });

  it('flags puts via USDC-owned utilization at the strike collateral', () => {
    // USDC custody: $3,000 owned, $500 free; K=2900 put, book 5 → size 0.172;
    // end util = (3000-500+0.172×2900)/3000 = 99.9% → flag.
    const custody = { ...cfg, poolCustodyByAsset: { ETH: { underlyingFree: 50, usdcFreeUsd: 500, usdcOwnedUsd: 3000 } } };
    const [s] = computeSignals(
      [row(deriveQuote({ bidSize: 5, askSize: 5, iv: 0.6 }), oliveQuote(70, 0.55), NOW + 30 * 86_400_000, { kind: 'put', pairKey: 'ETH-20261030-2900-P' })],
      custody,
      NOW,
    );
    expect(s.maxExecutableSize).toBeCloseTo(500 / 2900, 4);
    expect(s.flags).toContain('execution_moves_rate');
  });
});

describe('marginal-fill pricing — expected VWAP when the fill moves the rate (2026-09-30)', () => {
  // Curve flat at 500bps to 50% util, then convex to 5000bps at 100% —
  // shaped like the live ZEC/SOL token curves above the 90% knee.
  const curve = [
    { utilizationBps: 0, rateBps: 500 },
    { utilizationBps: 5_000, rateBps: 500 },
    { utilizationBps: 9_000, rateBps: 800 },
    { utilizationBps: 10_000, rateBps: 5_000 },
  ];
  const tau = 30 / 365;
  // Premium at the CURRENT (50%) utilization with the verified call
  // convention — this is what the cycle's synthetic quote would be.
  const quote = bsPrice({
    forward: 3000 * Math.exp(0.05 * tau),
    strike: 2900,
    tauYears: tau,
    vol: 0.55,
    discountFactor: Math.exp(-0.05 * tau),
    kind: 'call',
  });
  const custody = {
    ...cfg,
    poolCustodyByAsset: {
      ETH: { underlyingFree: 5, underlyingOwned: 10, usdcFreeUsd: 1e6, tokenCurve: curve },
    },
  };

  it('prices the expected average fill above the quote and nets it into the totals', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20 }), oliveQuote(quote, 0.55))], custody, NOW);
    expect(s.maxExecutableSize).toBe(5);
    expect(s.flags).toContain('execution_moves_rate');
    expect(s.expectedEntryUsdc).not.toBeNull();
    expect(s.expectedEntryUsdc!).toBeGreaterThan(s.entryPriceUsdc!); // quote assumes the rate stays put
    expect(s.expectedNetAfterCapitalUsdc!).toBeLessThan(s.netAfterCapitalUsdc!);
    expect(s.expectedNetAfterCapitalUsdc).toBeCloseTo(s.netAfterCapitalUsdc! - (s.expectedEntryUsdc! - s.entryPriceUsdc!), 3);
    expect(s.expectedTotalNetUsdc!).toBeLessThan(s.totalNetUsdc!);
    expect(s.expectedTotalNetUsdc).toBeCloseTo(s.expectedNetAfterCapitalUsdc! * 5 - 0.5 - 0.05, 1);
  });

  it('leaves the expected fields null without curve data (flag-only, as before)', () => {
    const noCurve = {
      ...cfg,
      poolCustodyByAsset: { ETH: { underlyingFree: 5, underlyingOwned: 10, usdcFreeUsd: 1e6 } },
    };
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20 }), oliveQuote(quote, 0.55))], noCurve, NOW);
    expect(s.flags).toContain('execution_moves_rate');
    expect(s.expectedEntryUsdc).toBeNull();
    expect(s.expectedTotalNetUsdc).toBeNull();
    expect(s.flags).toContain('fill_model_skipped');
  });

  it('does not flag fill_model_skipped when the model priced the clip', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20 }), oliveQuote(quote, 0.55))], custody, NOW);
    expect(s.expectedTotalNetUsdc).not.toBeNull();
    expect(s.flags).not.toContain('fill_model_skipped');
  });

  it('skips the model when the quoted premium is inconsistent with the curve inputs', () => {
    // mark 70 ≠ BS at 5% rate (~$189) → inputs disagree; flag-only fallback.
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20 }), oliveQuote(70, 0.55))], custody, NOW);
    expect(s.flags).toContain('execution_moves_rate');
    expect(s.expectedEntryUsdc).toBeNull();
    expect(s.flags).toContain('fill_model_skipped');
  });

  it('does not model LP-only directions (the user never pays the AMM premium)', () => {
    const [s] = computeSignals([row(deriveQuote({ bidSize: 20, askSize: 20, iv: 0.5 }), oliveQuote(quote, 0.55))], custody, NOW);
    expect([s.buyVenue, s.sellVenue]).toEqual(['derive', 'olive']);
    expect(s.expectedEntryUsdc).toBeNull();
    expect(s.flags).not.toContain('fill_model_skipped');
  });
});

describe('computeSignals — N venues (best vol-consistent pair per contract)', () => {
  // Flat test fee for a second book venue: $0.10/contract, $0 per order.
  const coincallFees = { coincall: { perContract: () => 0.1, perOrder: 0 } };
  const cfgN = { ...cfg, extraFeeModels: coincallFees };
  const coincallQuote = (overrides: Partial<OptionQuote> = {}): OptionQuote => ({
    ...deriveQuote(),
    venue: 'coincall',
    instrumentId: 'ETHUSD-30OCT26-2900.0-C',
    bid: 74,
    bidSize: 7,
    ask: 76,
    askSize: 4,
    mark: 75,
    iv: 0.58,
    source: 'coincall:test',
    ...overrides,
  });
  const rowN = (legs: Partial<Record<'derive' | 'olive' | 'coincall', OptionQuote>>, expiryTs = NOW + 30 * 86_400_000): MatchRow => ({
    ...row(null, null, expiryTs),
    legs: Object.fromEntries(
      Object.entries(legs).map(([v, q]) => [v, { venue: v as 'derive', instrumentId: q!.instrumentId, quote: q! }]),
    ),
  });

  it('prices a book-vs-book pair: ask on the buy venue, bid on the sell venue, both fee models', () => {
    const [s] = computeSignals([rowN({ derive: deriveQuote(), coincall: coincallQuote() })], cfgN, NOW);
    expect([s.buyVenue, s.sellVenue]).toEqual(['coincall', 'derive']);
    expect(s.entryPriceUsdc).toBe(76); // coincall ASK
    expect(s.exitPriceUsdc).toBe(79); // derive BID
    expect(s.ivSpreadVols).toBeCloseTo(2, 5); // 0.60 − 0.58
    const deriveFee = Math.min(3000 * 0.0003, 79 * 0.125);
    expect(s.costsUsdc).toBeCloseTo(deriveFee + 0.1, 4);
    expect(s.maxExecutableSize).toBe(4); // min(coincall ask 4, derive bid 5)
    expect(s.flags).not.toContain('amm_pool_depth_unknown');
    expect(s.totalNetUsdc).toBeCloseTo(s.netAfterCapitalUsdc! * 4 - 0.5, 1); // Derive $0.50 order fee, coincall none
  });

  it('chooses the best pair across three venues and keeps the runners-up', () => {
    const [s] = computeSignals(
      [rowN({ derive: deriveQuote(), olive: oliveQuote(70, 0.55), coincall: coincallQuote() })],
      cfgN,
      NOW,
    );
    // Vol-consistent candidates: olive→coincall, olive→derive, coincall→derive.
    const all = [[s.buyVenue, s.sellVenue], ...(s.alternatives ?? []).map((a) => [a.buyVenue, a.sellVenue])];
    expect(all).toHaveLength(3);
    expect(all).toContainEqual(['olive', 'derive']);
    expect(all).toContainEqual(['olive', 'coincall']);
    expect(all).toContainEqual(['coincall', 'derive']);
    // Ranked by honest total, best first.
    const totals = [s.totalNetUsdc!, ...s.alternatives!.map((a) => a.honestTotalNetUsdc!)];
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });

  it('prefers a pair users can execute over an LP-only pair with a bigger edge', () => {
    // Olive richest: selling there is LP-only; coincall→derive is executable.
    const [s] = computeSignals(
      [rowN({ derive: deriveQuote({ iv: 0.6 }), olive: oliveQuote(95, 0.7), coincall: coincallQuote() })],
      cfgN,
      NOW,
    );
    expect([s.buyVenue, s.sellVenue]).toEqual(['coincall', 'derive']);
    expect(s.flags).not.toContain('direction_limited');
    expect(s.alternatives?.some((a) => a.sellVenue === 'olive' && a.flags.includes('direction_limited'))).toBe(true);
  });

  it('marks quotes inside a venue trading cutoff non-executable (Coincall halts 15 min before expiry)', () => {
    const [s] = computeSignals([rowN({ derive: deriveQuote(), coincall: coincallQuote() }, NOW + 10 * 60_000)], cfgN, NOW);
    expect(s.flags).toContain('trading_cutoff');
    expect(s.isOpportunity).toBe(false);
  });

  it('flags legs that settle in different assets (Derive USDC vs Coincall USDT)', () => {
    const [s] = computeSignals([rowN({ derive: deriveQuote(), coincall: coincallQuote() })], cfgN, NOW);
    expect(s.flags).toContain('settlement_asset_mismatch');
    const [o] = computeSignals([row(deriveQuote(), oliveQuote())], cfg, NOW); // both USDC
    expect(o.flags).not.toContain('settlement_asset_mismatch');
  });

  it('applies book-quality flags to every book leg', () => {
    const [s] = computeSignals([rowN({ derive: deriveQuote(), coincall: coincallQuote({ bid: null }) })], cfgN, NOW);
    expect(s.flags).toContain('one_sided');
  });
});

describe('computeSignals — venue quote flags', () => {
  it('carries a leg quote flag (single_maker) into the pair and keeps it out of the headline', () => {
    const hq: OptionQuote = { ...deriveQuote(), venue: 'hypercall', instrumentId: 'ETH-20261030-2900-C', bid: 48, ask: 50, iv: 0.5, flags: ['single_maker'] };
    const r: MatchRow = {
      ...row(null, null),
      legs: {
        derive: { venue: 'derive', instrumentId: 'd', quote: deriveQuote() },
        hypercall: { venue: 'hypercall', instrumentId: 'h', quote: hq },
      },
    };
    const [s] = computeSignals([r], cfg, NOW);
    expect([s.buyVenue, s.sellVenue]).toEqual(['hypercall', 'derive']);
    expect(s.flags).toContain('single_maker');
    expect(s.isProfitable).toBe(true);
    expect(isHeadlineProfitable(s)).toBe(false);
  });
});
