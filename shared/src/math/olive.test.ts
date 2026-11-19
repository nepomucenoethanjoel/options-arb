import { describe, expect, it } from 'vitest';
import {
  curveRateBpsAt,
  expectedFillVwap,
  fixedRatePremiumBps,
  oliveFixedQuoteBps,
  oliveOrderRateBps,
  oliveStrikeBounds,
  type OliveRateCurvePoint,
} from './olive';

describe('oliveStrikeBounds — venue strike band (docs + live-UI verified)', () => {
  it('computes the documented ±1σ band: K_L = S·e^(−r_USDC·T − σ√T), K_U = S·e^(r_TOKEN·T + σ√T)', () => {
    const b = oliveStrikeBounds(100, 0.5, 0.5, { tokenApr: 0.08, usdcApr: 0.02 }, 1);
    expect(b.lower).toBeCloseTo(100 * Math.exp(-0.01 - 0.5 * Math.sqrt(0.5)), 10);
    expect(b.upper).toBeCloseTo(100 * Math.exp(0.04 + 0.5 * Math.sqrt(0.5)), 10);
  });

  it('reproduces the live UI rejection band (ZEC Dec-25, verified 2026-09-29)', () => {
    // The UI refused strike 2800 with: "Pick between $727.74 and $2,563.15".
    // With same-instant market-file inputs (spot 1457.46, vol 111.43%,
    // rL 8.00%, rS 69.51%, T 87.4d) the upper bound implies EXACTLY 1.000σ;
    // the lower bound matches within vol/rS timing drift (their read moved
    // minutes apart — ZEC vol ranged 104→111% that day and rS jumped at the
    // user's own fill).
    const T = 87.4 / 365;
    const b = oliveStrikeBounds(1457.46, 1.1143, T, { tokenApr: 0.08, usdcApr: 0.6951 }, 1);
    expect(b.upper).toBeCloseTo(2563.1, 0); // UI said 2563.15
    expect(b.lower).toBeLessThan(730); // UI said 727.74 (timing-tolerant)
    expect(b.lower).toBeGreaterThan(690);
    // 2800 is above the band → the venue refuses it, so the app must not
    // price it (OLIVE_STRIKE_BOUND_SIGMAS=1 rejects in getAmmQuote).
    expect(2800).toBeGreaterThan(b.upper);
  });

  it('widens with tenor and sigmas', () => {
    const near = oliveStrikeBounds(100, 0.5, 0.1, { tokenApr: 0.08, usdcApr: 0.02 }, 1);
    const far = oliveStrikeBounds(100, 0.5, 1.0, { tokenApr: 0.08, usdcApr: 0.02 }, 1);
    expect(far.upper / far.lower).toBeGreaterThan(near.upper / far.lower);
    const wide = oliveStrikeBounds(100, 0.5, 0.5, { tokenApr: 0.08, usdcApr: 0.02 }, 2);
    expect(wide.upper).toBeGreaterThan(far.upper * 0.9);
  });
});

describe('curveRateBpsAt — per-custody borrow curve evaluation', () => {
  const curve: OliveRateCurvePoint[] = [
    { utilizationBps: 0, rateBps: 200 },
    { utilizationBps: 5_000, rateBps: 500 },
    { utilizationBps: 9_000, rateBps: 800 },
    { utilizationBps: 10_000, rateBps: 5_000 },
  ];

  it('interpolates piecewise-linearly between nodes', () => {
    expect(curveRateBpsAt(curve, 5_000)).toBe(500);
    expect(curveRateBpsAt(curve, 7_000)).toBeCloseTo(650, 6); // halfway 500→800
    expect(curveRateBpsAt(curve, 9_500)).toBeCloseTo(2_900, 6); // halfway 800→5000
  });

  it('clamps to the end rates outside the node range', () => {
    expect(curveRateBpsAt(curve, 0)).toBe(200);
    expect(curveRateBpsAt(curve, -1_000)).toBe(200);
    expect(curveRateBpsAt(curve, 15_000)).toBe(5_000);
  });

  it('returns null for an empty curve', () => {
    expect(curveRateBpsAt([], 5_000)).toBeNull();
  });
});

describe('expectedFillVwap — marginal-fill pricing along the borrow curve', () => {
  const base = {
    kind: 'call' as const,
    strike: 100,
    spot: 100,
    vol: 0.55,
    tauYears: 30 / 365,
    owned: 10,
    free: 5, // 50% utilized now
    perUnitLocked: 1,
  };

  it('returns the flat quote when the curve is flat (rate never moves)', () => {
    const flat: OliveRateCurvePoint[] = [{ utilizationBps: 0, rateBps: 500 }, { utilizationBps: 10_000, rateBps: 500 }];
    const r = expectedFillVwap({ ...base, size: 5, curve: flat })!;
    expect(r.quoteEntry).toBeCloseTo(r.vwapEntry, 8);
    expect(r.vwapEntry).toBeCloseTo(r.endEntry, 8);
    expect(r.endUtilization).toBeCloseTo(1, 8);
  });

  it('bounds the VWAP between the start and end premiums on a steep curve', () => {
    const steep: OliveRateCurvePoint[] = [
      { utilizationBps: 0, rateBps: 500 },
      { utilizationBps: 5_000, rateBps: 500 },
      { utilizationBps: 9_000, rateBps: 800 },
      { utilizationBps: 10_000, rateBps: 5_000 },
    ];
    const r = expectedFillVwap({ ...base, size: 5, curve: steep })!;
    // Buying 5 of 5 free locks the custody to 100%: every marginal unit after
    // 90% reprices toward a 50% APR rate — the average fill exceeds the quote.
    expect(r.endEntry).toBeGreaterThan(r.vwapEntry);
    expect(r.vwapEntry).toBeGreaterThan(r.quoteEntry);
    expect(r.endUtilization).toBeCloseTo(1, 8);
  });

  it('grows the VWAP penalty with fill size (convexity above 90% util)', () => {
    const steep: OliveRateCurvePoint[] = [
      { utilizationBps: 0, rateBps: 500 },
      { utilizationBps: 5_000, rateBps: 500 },
      { utilizationBps: 9_000, rateBps: 800 },
      { utilizationBps: 10_000, rateBps: 5_000 },
    ];
    const small = expectedFillVwap({ ...base, size: 1, curve: steep })!; // 50→60% util: rate barely moves
    const big = expectedFillVwap({ ...base, size: 5, curve: steep })!; // 50→100%: through the steep leg
    expect(small.vwapEntry - small.quoteEntry).toBeLessThan(big.vwapEntry - big.quoteEntry);
    expect(small.endUtilization).toBeCloseTo(0.6, 8);
  });

  it('prices puts with the accreting convention (higher rS → richer put)', () => {
    const curve: OliveRateCurvePoint[] = [
      { utilizationBps: 0, rateBps: 0 },
      { utilizationBps: 5_000, rateBps: 0 },
      { utilizationBps: 10_000, rateBps: 6_000 },
    ];
    // USDC custody: $1,000 owned, $500 free (50% util); 5 puts × K=100 lock
    // $500 → 100% at the end of the fill.
    const r = expectedFillVwap({
      ...base,
      kind: 'put',
      strike: 100,
      size: 5,
      owned: 1_000,
      free: 500,
      perUnitLocked: 100,
      curve,
    })!;
    expect(r.endEntry).toBeGreaterThan(r.quoteEntry);
    expect(r.vwapEntry).toBeGreaterThan(r.quoteEntry);
    expect(r.vwapEntry).toBeLessThan(r.endEntry);
    expect(r.endUtilization).toBeCloseTo(1, 8);
  });

  it('returns null on invalid inputs', () => {
    const curve: OliveRateCurvePoint[] = [{ utilizationBps: 0, rateBps: 500 }];
    expect(expectedFillVwap({ ...base, size: 0, curve })).toBeNull();
    expect(expectedFillVwap({ ...base, size: 5, curve: [] })).toBeNull();
    expect(expectedFillVwap({ ...base, size: 5, curve, owned: 0 })).toBeNull();
    expect(expectedFillVwap({ ...base, size: 5, curve, tauYears: 0 })).toBeNull();
  });
});

// Live Olive asset-side curve (every pool, docs protocol/pool-parameters; market file borrowRateCurve).
const ASSET_CURVE: OliveRateCurvePoint[] = [
  { utilizationBps: 0, rateBps: 0 },
  { utilizationBps: 7500, rateBps: 2000 },
  { utilizationBps: 10000, rateBps: 12000 },
];

describe('fixedRatePremiumBps — fixed-rate premium on top of the curve (docs interest-rates)', () => {
  // SOL pool 2026-11-15 08:41 UTC market file: owned 65.671025202 SOL, poolAccount.fixedRateStates[0]
  // timeValueNative 402716025749638000, liveExposureNative 61661767000, fixedRateBetaBps 2500.
  const sol = { betaBps: 2500, exposure: 61.661767, timeValue: 402716025.749638 };
  it('reproduces the live 30-day display quote (state-history fixedRateLongBps 9822 = 9684 + 138)', () => {
    expect(fixedRatePremiumBps(sol, 65.671025202, 30 * 86_400)).toBe(138);
  });
  it('is small at short tenors and saturates toward β·U2d at long ones', () => {
    expect(fixedRatePremiumBps(sol, 65.671025202, 5 * 86_400)).toBe(30);
    expect(fixedRatePremiumBps(sol, 65.671025202, 365 * 86_400)).toBe(403);
  });
  it('is zero for an idle side', () => {
    expect(fixedRatePremiumBps({ betaBps: 2500, exposure: 0, timeValue: 0 }, 0.6868, 30 * 86_400)).toBe(0);
  });
});

describe('oliveOrderRateBps — the rate an order pays (docs "The Rate Your Order Pays")', () => {
  it('reproduces a live expiry-future fill exactly: SOL long $241, 2026-10-26 10:49:04, stored 959 bp', () => {
    // transactions.json canonical.custodyEffects: owned 40906098015, locked 13307406471, lockedDelta 2399852021 (lamports);
    // fixed-rate state from the 10:00 state-history bucket aged to the fill.
    const side = { betaBps: 2500, exposure: 2.910077, timeValue: 15056319.346912 };
    const owned = 40.906098015, locked = 13.307406471, tSeconds = 2_754_656;
    expect(oliveFixedQuoteBps(ASSET_CURVE, side, owned, locked, tSeconds)).toBe(877);
    expect(oliveOrderRateBps(ASSET_CURVE, side, owned, locked, tSeconds, 2.399852021)).toBe(959);
  });
  it('splits at the kink: an order across 75% pays the exact piecewise average', () => {
    // 70% → 90% utilization, no premium: docs example "pays a variable part of 42.33%".
    expect(oliveOrderRateBps(ASSET_CURVE, null, 100, 70, 86_400, 20)).toBe(4233);
  });
  it('never pays less than r(0)', () => {
    expect(oliveOrderRateBps(ASSET_CURVE, null, 100, 10, 86_400, 0)).toBe(oliveFixedQuoteBps(ASSET_CURVE, null, 100, 10, 86_400));
  });
});

describe('expectedFillVwap with fixed-rate state — Olive order mechanics (option window rule)', () => {
  it('reproduces a live option fill: SOL 73-C 20NOV26, 2026-11-16 20:04:59, 18.944568 contracts at $1.371571 (stored 8517 bp)', () => {
    // canonical.custodyEffects: owned 106651550202, locked 87258241999 (lamports); fixed-rate state from the
    // 19:59:55 state-history bucket aged 304 s. Utilization 81.8% → 99.6%: the curve-only model misses badly.
    const input = {
      kind: 'call' as const, strike: 73, spot: 71.58227, vol: 0.623879,
      tauYears: (Date.UTC(2026, 10, 20, 8) - Date.parse('2026-11-16T20:04:59Z')) / 1000 / (365 * 86_400),
      size: 18.944568, curve: ASSET_CURVE, owned: 106.651550202, free: 106.651550202 - 87.258241999, perUnitLocked: 1,
    };
    const exact = expectedFillVwap({ ...input, fixedRate: { betaBps: 2500, exposure: 61.66176763180714, timeValue: 394859515.03067494 } })!;
    expect(exact.vwapEntry).toBeCloseTo(1.371571, 3);
    const curveOnly = expectedFillVwap(input)!;
    expect(curveOnly.vwapEntry).toBeLessThan(exact.vwapEntry);
  });
});

describe('quadratic curve shape above the kink (docs interest-rates since 2026-11-17, DATA_SOURCES row 79)', () => {
  const ASSET_NEW: OliveRateCurvePoint[] = [
    { utilizationBps: 0, rateBps: 0 }, { utilizationBps: 7500, rateBps: 2000 }, { utilizationBps: 10000, rateBps: 17000 },
  ];
  const USDC_NEW: OliveRateCurvePoint[] = [
    { utilizationBps: 0, rateBps: 0 }, { utilizationBps: 7500, rateBps: 1000 }, { utilizationBps: 10000, rateBps: 16000 },
  ];
  it('reproduces the docs table', () => {
    const table: Array<[number, number, number]> = [[2500, 666.67, 333.33], [8000, 2600, 1600], [8500, 4400, 3400], [9000, 7400, 6400], [9500, 11600, 10600], [9800, 14696, 13696], [10000, 17000, 16000]];
    for (const [u, a, s] of table) {
      expect(curveRateBpsAt(ASSET_NEW, u, 'quadratic')).toBeCloseTo(a, 1);
      expect(curveRateBpsAt(USDC_NEW, u, 'quadratic')).toBeCloseTo(s, 1);
    }
  });
  it('matches Olive’s own variable rate live (SOL state-history 2026-11-19 10:19 UTC: 86.15% → 4983 bp, USDC 91.69% → 7677 bp)', () => {
    expect(oliveFixedQuoteBps(ASSET_NEW, null, 123.273331918, 106.202809999, 86_400, 0, 'quadratic')).toBe(4983);
    expect(oliveFixedQuoteBps(USDC_NEW, null, 6889.357269, 6316.836027, 86_400, 0, 'quadratic')).toBe(7677);
  });
  it('averages exactly across the kink: 70% → 90% pays a variable part of 33.33% (docs example)', () => {
    expect(oliveOrderRateBps(ASSET_NEW, null, 100, 70, 86_400, 20, 'quadratic')).toBe(3333);
  });
  it('defaults to the linear shape every earlier recording used', () => {
    expect(curveRateBpsAt(ASSET_NEW, 9000)).toBeCloseTo(11000, 6);
  });
});
