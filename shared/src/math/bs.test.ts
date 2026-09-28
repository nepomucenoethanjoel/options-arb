import { describe, expect, it } from 'vitest';
import { bsGreeks, bsPrice, impliedVol, normCdf } from './bs';

describe('normCdf', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975002, 4);
    expect(normCdf(-1.96)).toBeCloseTo(0.024998, 4);
    expect(normCdf(6)).toBeCloseTo(1, 8);
  });
});

describe('bsPrice (forward form)', () => {
  const base = { forward: 100, strike: 100, tauYears: 1, vol: 0.2, discountFactor: 1 };

  it('ATM call with df=1 matches hand-computed 7.9656', () => {
    // d1 = 0.1 → 2N(0.1)−1 = 0.079656
    expect(bsPrice({ ...base, kind: 'call' })).toBeCloseTo(7.965584, 4);
  });

  it('ATM put equals ATM call when F=K and df=1 (parity)', () => {
    expect(bsPrice({ ...base, kind: 'put' })).toBeCloseTo(bsPrice({ ...base, kind: 'call' }), 10);
  });

  it('OTM call matches hand-computed value', () => {
    // F=100, K=110, σ=0.2, T=1, df=1 → call ≈ 4.2920
    expect(bsPrice({ ...base, strike: 110, kind: 'call' })).toBeCloseTo(4.2920, 3);
  });

  it('respects put-call parity C − P = df·(F − K)', () => {
    const c = bsPrice({ forward: 105, strike: 93, tauYears: 0.5, vol: 0.35, discountFactor: 0.97, kind: 'call' });
    const p = bsPrice({ forward: 105, strike: 93, tauYears: 0.5, vol: 0.35, discountFactor: 0.97, kind: 'put' });
    expect(c - p).toBeCloseTo(0.97 * (105 - 93), 8);
  });

  it('degenerates to discounted intrinsic at zero vol/tenor', () => {
    expect(bsPrice({ ...base, vol: 0, kind: 'call' })).toBeCloseTo(0, 10);
    expect(bsPrice({ ...base, vol: 0, strike: 80, kind: 'put' })).toBeCloseTo(0, 10);
    expect(bsPrice({ forward: 130, strike: 100, tauYears: 0, vol: 0.2, discountFactor: 0.9, kind: 'call' })).toBeCloseTo(27, 10);
  });
});

describe('bsGreeks', () => {
  it('signs and parity sanity', () => {
    const call = bsGreeks({ forward: 100, strike: 100, tauYears: 0.5, vol: 0.4, discountFactor: 1, kind: 'call' });
    const put = bsGreeks({ forward: 100, strike: 100, tauYears: 0.5, vol: 0.4, discountFactor: 1, kind: 'put' });
    expect(call.delta).toBeGreaterThan(0);
    expect(call.delta).toBeLessThan(1);
    expect(put.delta).toBeLessThan(0);
    expect(call.delta - put.delta).toBeCloseTo(1, 6); // df=1
    expect(call.gamma).toBeGreaterThan(0);
    expect(call.vega).toBeGreaterThan(0);
    expect(call.vega).toBeCloseTo(put.vega, 10);
  });
});

describe('impliedVol', () => {
  it('round-trips prices back to the original vol', () => {
    for (const vol of [0.08, 0.2, 0.55, 1.2]) {
      const inputs = { forward: 2100, strike: 2000, tauYears: 0.25, discountFactor: 0.99, kind: 'call' as const };
      const price = bsPrice({ ...inputs, vol });
      const recovered = impliedVol(price, inputs);
      expect(recovered).not.toBeNull();
      expect(recovered!).toBeCloseTo(vol, 4);
    }
  });

  it('round-trips puts too', () => {
    const inputs = { forward: 145, strike: 160, tauYears: 0.1, discountFactor: 1, kind: 'put' as const };
    const price = bsPrice({ ...inputs, vol: 0.9 });
    expect(impliedVol(price, inputs)).toBeCloseTo(0.9, 4);
  });

  it('returns null for unattainable prices', () => {
    const inputs = { forward: 100, strike: 100, tauYears: 1, discountFactor: 1, kind: 'call' as const };
    expect(impliedVol(120, inputs)).toBeNull(); // above df·F
    expect(impliedVol(-1, inputs)).toBeNull();
    expect(impliedVol(0, inputs)).toBeNull(); // below discounted intrinsic (0 here) — degenerate
  });
});
