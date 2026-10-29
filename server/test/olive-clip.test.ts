import { describe, expect, it } from 'vitest';
import { bestOliveClip } from '../src/signals/olive';

describe('bestOliveClip', () => {
  // Per-contract edge 10 minus own impact growing linearly with size (k·s), minus a 0.05 order fee.
  const total = (k: number) => (s: number) => (10 - k * s) * s - 0.05;

  it('finds the interior optimum when the full clip loses', () => {
    const r = bestOliveClip(total(20), 1, 20)!; // optimum at s = 0.25, zero crossing ≈ 0.495
    expect(total(20)(1)).toBeLessThan(0);
    expect(r.bestSize).toBeCloseTo(0.25, 9);
    expect(r.bestTotal).toBeCloseTo(1.2, 9);
    expect(r.maxProfitableSize).toBeCloseTo(0.45, 9);
  });

  it('keeps the full clip when impact never bites, and reports no profitable size when none is', () => {
    expect(bestOliveClip(total(0), 2, 20)).toMatchObject({ bestSize: 2, maxProfitableSize: 2 });
    const none = bestOliveClip(() => -1, 1, 10)!;
    expect(none.maxProfitableSize).toBeNull();
    expect(none.bestTotal).toBe(-1);
  });

  it('skips sizes the model cannot price; nothing priced or no cap → null', () => {
    expect(bestOliveClip((s) => (s > 0.5 ? null : s), 1, 10)).toMatchObject({ bestSize: 0.5 });
    expect(bestOliveClip(() => null, 1)).toBeNull();
    expect(bestOliveClip(total(1), 0)).toBeNull();
  });
});

describe('honest total with a best clip', () => {
  it('uses the best clip when it beats the full clip, never above the quoted total', async () => {
    const { honestTotalNetUsdc, honestClipSize } = await import('@options-arb/shared');
    const base = { totalNetUsdc: 4.21, expectedTotalNetUsdc: -8.52, maxExecutableSize: 0.6868 };
    expect(honestTotalNetUsdc(base)).toBe(-8.52);
    const withBest = { ...base, bestClipSize: 0.1717, bestClipExpectedTotalUsdc: 0.9 };
    expect(honestTotalNetUsdc(withBest)).toBe(0.9);
    expect(honestClipSize(withBest)).toBe(0.1717);
    // The full clip is best: unchanged, and the size stays the cap.
    const fullBest = { ...base, expectedTotalNetUsdc: 2, bestClipSize: 0.6868, bestClipExpectedTotalUsdc: 2 };
    expect(honestTotalNetUsdc(fullBest)).toBe(2);
    expect(honestClipSize(fullBest)).toBe(0.6868);
    // Clamp: never above the quoted full-clip total.
    expect(honestTotalNetUsdc({ ...withBest, bestClipExpectedTotalUsdc: 9 })).toBe(4.21);
  });
});
