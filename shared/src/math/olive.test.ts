import { describe, expect, it } from 'vitest';
import { oliveStrikeBounds } from './olive';

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
    expect(far.upper / far.lower).toBeGreaterThan(near.upper / near.lower);
    const wide = oliveStrikeBounds(100, 0.5, 0.5, { tokenApr: 0.08, usdcApr: 0.02 }, 2);
    expect(wide.upper).toBeGreaterThan(far.upper * 0.9);
  });
});
