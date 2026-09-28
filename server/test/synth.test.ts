import { describe, expect, it } from 'vitest';
import { buildSyntheticAmmQuote } from '../src/adapters/olive/synth';

/**
 * Fixtures are LIVE Olive production UI quotes (see DATA_SOURCES.md §2d and
 * verify-pricing.ts). The 269d tenor is the discriminator: at 7d the
 * discount factors are ≈1 and the old flat-df convention also fit; at 269d
 * it was off by $3.81 on the call.
 */
const fixtures = [
  {
    label: '7d call (2026-09-27 UI)',
    kind: 'call' as const,
    strike: 120.17,
    expiryTs: Date.UTC(2026, 9, 4, 8),
    now: Date.parse('2026-09-27T20:45:46.665Z'),
    theirPrice: 6.1631,
    spot: 122.94,
    vol: 0.6906,
    tokenRateApr: 0.1507,
    usdcRateApr: 0.02,
    tol: 0.01,
  },
  {
    label: '269d call (2026-09-28 UI)',
    kind: 'call' as const,
    strike: 120,
    expiryTs: Date.UTC(2027, 5, 25, 8),
    now: Date.parse('2026-09-28T13:23:00Z'),
    theirPrice: 32.4057,
    spot: 119.81,
    vol: 0.6697,
    tokenRateApr: 0.1504,
    usdcRateApr: 0.02,
    tol: 0.01,
  },
  {
    label: '269d put (2026-09-28 UI)',
    kind: 'put' as const,
    strike: 120,
    expiryTs: Date.UTC(2027, 5, 25, 8),
    now: Date.parse('2026-09-28T13:20:00Z'),
    theirPrice: 28.3989,
    spot: 119.75,
    vol: 0.6701,
    tokenRateApr: 0.1504,
    usdcRateApr: 0.02,
    tol: 0.015, // put quote captured ~3 min before its displayed vol print
  },
];

describe('buildSyntheticAmmQuote — verified Olive convention', () => {
  for (const f of fixtures) {
    it(`reproduces the live UI quote: ${f.label}`, () => {
      const q = buildSyntheticAmmQuote({
        underlying: 'SOL',
        strike: f.strike,
        expiryTs: f.expiryTs,
        kind: f.kind,
        spot: f.spot,
        vol: f.vol,
        tokenRateApr: f.tokenRateApr,
        usdcRateApr: f.usdcRateApr,
        now: f.now,
      });
      expect(q.mark).not.toBeNull();
      expect(Math.abs(q.mark! - f.theirPrice)).toBeLessThan(f.tol);
      // The convention's own semantics:
      const tau = (f.expiryTs - f.now) / (365 * 86_400_000);
      const expectedDf =
        f.kind === 'call' ? Math.exp(-f.tokenRateApr * tau) : Math.exp(f.usdcRateApr * tau);
      expect(q.discountFactor).toBeCloseTo(expectedDf, 8);
      expect(q.forward).toBeCloseTo(
        f.spot * Math.exp((f.kind === 'call' ? f.tokenRateApr : -f.usdcRateApr) * tau),
        8,
      );
      expect(q.iv).toBe(f.vol);
      expect(q.source).toBe('olive:synthetic-amm');
    });
  }

  it('the old flat-df convention would MISS the long-dated call by ~$3.8 (regression guard)', () => {
    const f = fixtures[1]!;
    const q = buildSyntheticAmmQuote({
      underlying: 'SOL',
      strike: f.strike,
      expiryTs: f.expiryTs,
      kind: f.kind,
      spot: f.spot,
      vol: f.vol,
      tokenRateApr: f.tokenRateApr,
      usdcRateApr: f.usdcRateApr,
      now: f.now,
    });
    // If someone reverts the discount factor to 1, the mark jumps to ~36.2.
    expect(Math.abs(q.mark! - 36.21)).toBeGreaterThan(3);
  });
});
