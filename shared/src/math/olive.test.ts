import { describe, expect, it } from 'vitest';
import { curveRateBpsAt, expectedFillVwap, oliveStrikeBounds, type OliveRateCurvePoint } from './olive';

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
