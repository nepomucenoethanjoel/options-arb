import { describe, expect, it } from 'vitest';
import { sampleSviSlice, sviImpliedVol, sviTotalVariance } from './svi';

const slice = {
  expiryTs: Date.UTC(2026, 11, 26, 8),
  currency: 'ETH',
  refTau: 0.25,
  forward: 3000,
  a: 0.01,
  b: 0.1,
  m: 0,
  rho: -0.3,
  sigma: 0.2,
};

describe('sviTotalVariance', () => {
  it('evaluates w(k) = a + b(ρ(k−m) + √((k−m)²+σ²))', () => {
    // k=0: w = 0.01 + 0.1·(0 + 0.2) = 0.03
    expect(sviTotalVariance(0, slice)).toBeCloseTo(0.03, 10);
    // k=0.2: w = 0.01 + 0.1·(−0.06 + √(0.04+0.04)) = 0.01 + 0.1·0.22285
    expect(sviTotalVariance(0.2, slice)).toBeCloseTo(0.01 + 0.1 * (-0.3 * 0.2 + Math.sqrt(0.04 + 0.04)), 10);
  });
});

describe('sviImpliedVol', () => {
  it('returns √(w/refTau) at the forward', () => {
    const iv = sviImpliedVol(slice, 3000);
    expect(iv).toBeCloseTo(Math.sqrt(0.03 / 0.25), 10);
  });

  it('evaluates at a custom tenor', () => {
    const iv = sviImpliedVol(slice, 3000, 0.5);
    expect(iv).toBeCloseTo(Math.sqrt(0.03 / 0.5), 10);
  });

  it('returns null for invalid inputs', () => {
    expect(sviImpliedVol(slice, -1)).toBeNull();
    expect(sviImpliedVol(slice, 3000, 0)).toBeNull();
  });
});

describe('sampleSviSlice', () => {
  it('produces strikes around the forward with positive vols', () => {
    const pts = sampleSviSlice(slice);
    expect(pts.length).toBeGreaterThan(10);
    expect(pts[0].strike).toBeLessThan(3000);
    expect(pts[pts.length - 1].strike).toBeGreaterThan(3000);
    for (const p of pts) expect(p.iv).toBeGreaterThan(0);
  });
});
