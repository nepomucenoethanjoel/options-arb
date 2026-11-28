import { describe, expect, it } from 'vitest';
import { bsPrice } from './bs';
import { expectedFillVwap } from './olive';
import {
  advanceDemandSide,
  oliveSurfaceDepthUsd,
  oliveSurfaceMarkup,
  prepareSurfacePoint,
  surfaceBuyForBudget,
  type OliveDemandSide,
} from './oliveSurface';

/**
 * Every option open that pushed an Olive demand surface, 2026-11-25 → 11-26
 * (`OptionPositionOpened` + `OptionDemandSurfaceChanged` events, DATA_SOURCES
 * row 99). Inputs: the event's strike, entry spot, oracle vol, order rate, the
 * locked custody's (owned − pending) before the fill in USD, and the premium
 * budget after fee (two paid in the coin: converted at spot). All eight found
 * an empty surface (`markup_before_e6` 0).
 */
const FILLS = [
  { tx: '4qLW3gizks', isCall: true, strike: 372.5, spot: 373.351041, vol: 0.528604, openedAt: 1795607046, expiresAt: 1796198400, rateBps: 671, heldUsd: 1622.390004, budget: 7.591769, chain: { contracts: 0.607077, extraUsd: 0.653499, markupAfter: 0.200476 } },
  { tx: '5y6U11A2ji', isCall: true, strike: 375, spot: 375.562306, vol: 0.528536, openedAt: 1795604996, expiresAt: 1796198400, rateBps: 678, heldUsd: 1639.779325, budget: 7.88165, chain: { contracts: 0.630138, extraUsd: 0.715695, markupAfter: 0.20977 } },
  { tx: '5mZSXksUrU', isCall: true, strike: 377.5, spot: 377.884615, vol: 0.527884, openedAt: 1795593505, expiresAt: 1796198400, rateBps: 679, heldUsd: 1645.025569, budget: 7.88191, chain: { contracts: 0.624878, extraUsd: 0.727841, markupAfter: 0.211935 } },
  { tx: 'onc9Nz2yqZ', isCall: true, strike: 0.4, spot: 0.2369, vol: 1.049988, openedAt: 1795724717, expiresAt: 1813910400, rateBps: 15117, heldUsd: 543.230271, budget: 269.740168, chain: { contracts: 2193.299549, extraUsd: 43.950084, markupAfter: 0.762137 } },
  { tx: '28QSwc9bx6', isCall: true, strike: 2.25, spot: 1.303, vol: 0.96556, openedAt: 1795714057, expiresAt: 1806048000, rateBps: 16442, heldUsd: 399.196611, budget: 129.801961, chain: { contracts: 303.929334, extraUsd: 44.735768, markupAfter: 1.088273 } },
  { tx: '2coHdiosze', isCall: false, strike: 67, spot: 67.855, vol: 0.733128, openedAt: 1795595136, expiresAt: 1795766400, rateBps: 9587, heldUsd: 8342.137631, budget: 5.284257, chain: { contracts: 4.24856, extraUsd: 0.110554, markupAfter: 0.036082 } },
  { tx: 'TS2b42bxio', isCall: false, strike: 1550, spot: 1635.86, vol: 0.676632, openedAt: 1795600383, expiresAt: 1795852800, rateBps: 533, heldUsd: 3850.034623, budget: 19.520704, chain: { contracts: 1.253693, extraUsd: 6.99439, markupAfter: 0.402787 } },
  { tx: '5YJufe7Zfj', isCall: true, strike: 86000, spot: 60542.985, vol: 0.552662, openedAt: 1795718267, expiresAt: 1806048000, rateBps: 11980, heldUsd: 9234.656617, budget: 398.763296, chain: { contracts: 0.040848, extraUsd: 41.572946, markupAfter: 0.278125 } },
] as const;

const SURFACE_ON = { gridStrength: 1, dateStrength: 0.5, halfLifeSeconds: 7_776_000, enabled: true };
const emptySide = (t: number): OliveDemandSide => ({
  ...SURFACE_ON, depthUsd: 0, fadeIndex: 0, lastFadeAt: t, pushes: Array(78).fill(0), dateLevels: Array(367).fill(0), dateToday: 0,
});

/** Olive's convention: calls F = S·e^(rT), df = e^(−rT); puts F = S·e^(−rT), df = e^(rT). */
function price(f: (typeof FILLS)[number], markup: number): number {
  const T = (f.expiresAt - f.openedAt) / 31_536_000, r = f.rateBps / 1e4, vol = f.vol * (1 + markup);
  return f.isCall
    ? bsPrice({ forward: f.spot * Math.exp(r * T), strike: f.strike, tauYears: T, vol, discountFactor: Math.exp(-r * T), kind: 'call' })
    : bsPrice({ forward: f.spot * Math.exp(-r * T), strike: f.strike, tauYears: T, vol, discountFactor: Math.exp(r * T), kind: 'put' });
}

describe('Olive demand surface vs chain fills (row 99)', () => {
  for (const f of FILLS) {
    it(`${f.tx}: push, contracts and markup reproduce the chain`, () => {
      const prep = prepareSurfacePoint(emptySide(f.openedAt), { ...f, expiresAtSec: f.expiresAt }, f.openedAt);
      expect(prep.kind).toBe('point');
      if (prep.kind !== 'point') return;
      expect(prep.point.markup).toBe(0);
      const buy = surfaceBuyForBudget(prep.point, price(f, 0), (m) => price(f, m), f.budget)!;
      expect(Math.abs(buy.markupAfter / f.chain.markupAfter - 1)).toBeLessThan(10e-4);
      expect(Math.abs(buy.extraUsd / f.chain.extraUsd - 1)).toBeLessThan(25e-4);
      expect(Math.abs(buy.contracts / f.chain.contracts - 1)).toBeLessThan(10e-4);
    });
  }

  it('depth: held USD × ATM 30-day call fraction (BTC calls depth_usd on chain 582.909)', () => {
    expect(oliveSurfaceDepthUsd(9234.656617, 0.552662)).toBeCloseTo(582.909, 0);
  });
});

describe('demand surface state', () => {
  // BTC calls after the 5YJufe7Zfj fill (account GqNXpu…, slot 475050485): nodes 47/48/60/61 and day slot 351.
  const btc = (): OliveDemandSide => {
    const pushes = Array(78).fill(0);
    pushes[47] = 4.038365; pushes[48] = 1.134805; pushes[60] = 2.802876; pushes[61] = 0.787625;
    const dateLevels = Array(367).fill(0);
    dateLevels[351] = 6.196852;
    return { ...SURFACE_ON, depthUsd: 582.909, fadeIndex: 0.015924, lastFadeAt: 1795718267, pushes, dateLevels, dateToday: 20783 };
  };
  const at = { isCall: true, strike: 86000, spot: 60542.985, vol: 0.552662, expiresAtSec: 1806048000, heldUsd: 9234.656617 };

  it('the standing markup at the pushed point is the fill’s markup_after', () => {
    expect(oliveSurfaceMarkup(btc(), at, 1795718267)).toBeCloseTo(0.278125, 3);
  });

  it('grid pushes halve over the half-life; day slots do not fade', () => {
    const later = advanceDemandSide(btc(), 1795718267 + 7_776_000);
    expect(later.pushes[47]).toBeCloseTo(4.038365 / 2, 9);
    expect(later.dateLevels[351]).toBe(6.196852);
    expect(later.fadeIndex).toBeCloseTo(1.015924, 9);
  });

  it('day slots before today are cleared', () => {
    const after = advanceDemandSide(btc(), 1806048000 + 86_400);
    expect(after.dateLevels[351]).toBe(0);
  });

  it('a disabled side prices flat', () => {
    expect(prepareSurfacePoint({ ...btc(), enabled: false }, at, 1795718267).kind).toBe('flat');
  });

  it('no held liquidity: refused', () => {
    expect(prepareSurfacePoint(btc(), { ...at, heldUsd: 0 }, 1795718267).kind).toBe('refused');
  });
});

describe('expectedFillVwap with a surface', () => {
  const curve = [{ utilizationBps: 0, rateBps: 0 }, { utilizationBps: 7500, rateBps: 2000 }, { utilizationBps: 10000, rateBps: 17000 }];
  const base = {
    kind: 'call' as const, strike: 70000, spot: 60000, vol: 0.55, tauYears: 30 / 365, curve, owned: 1, free: 0.8,
    perUnitLocked: 1, fixedRate: { betaBps: 10000, exposure: 0.2, timeValue: 0.2 * 30 * 86400 }, curveShape: 'quadratic' as const,
  };
  const nowSec = 1795718267;
  const surface = { side: emptySide(nowSec), heldUsd: 60000, nowSec, expiresAtSec: nowSec + 30 * 86400 };

  it('costs more than the rate-only fill and grows with size', () => {
    const small = expectedFillVwap({ ...base, size: 0.01, surface })!;
    const big = expectedFillVwap({ ...base, size: 0.2, surface })!;
    const rateOnly = expectedFillVwap({ ...base, size: 0.2 })!;
    expect(big.vwapEntry).toBeGreaterThan(rateOnly.vwapEntry);
    expect(big.vwapEntry).toBeGreaterThan(small.vwapEntry);
    expect(big.endEntry).toBeGreaterThan(big.vwapEntry);
  });

  it('an empty surface quotes flat at zero size', () => {
    const r = expectedFillVwap({ ...base, size: 0.05, surface })!;
    expect(r.quoteEntry).toBeCloseTo(expectedFillVwap({ ...base, size: 0.05 })!.quoteEntry, 9);
  });

  it('a standing markup raises the zero-size quote', () => {
    const side = emptySide(nowSec);
    const loaded = { ...side, pushes: side.pushes.map((_, i) => (i >= 26 && i <= 52 ? 3 : 0)) };
    const r = expectedFillVwap({ ...base, size: 0.05, surface: { ...surface, side: loaded } })!;
    expect(r.quoteEntry).toBeGreaterThan(expectedFillVwap({ ...base, size: 0.05 })!.quoteEntry * 1.01);
  });

  it('the solved budget buys exactly the size: contracts = (B − push) / p(r)', () => {
    // A flat 10% curve and β 0: the order rate is 10% whatever the window.
    const flatCurve = [{ utilizationBps: 0, rateBps: 1000 }, { utilizationBps: 10000, rateBps: 1000 }];
    const size = 0.1;
    const r = expectedFillVwap({ ...base, curve: flatCurve, fixedRate: { betaBps: 0, exposure: 0, timeValue: 0 }, size, surface })!;
    const T = base.tauYears;
    const p = (m: number) => bsPrice({ forward: 60000 * Math.exp(0.1 * T), strike: 70000, tauYears: T, vol: 0.55 * (1 + m), discountFactor: Math.exp(-0.1 * T), kind: 'call' });
    const prep = prepareSurfacePoint(surface.side, { isCall: true, strike: 70000, spot: 60000, vol: 0.55, expiresAtSec: surface.expiresAtSec, heldUsd: 60000 }, nowSec);
    if (prep.kind !== 'point') throw new Error('expected a surface point');
    const buy = surfaceBuyForBudget(prep.point, p(0), p, r.vwapEntry * size)!;
    expect(buy.contracts).toBeCloseTo(size, 8);
    expect(buy.extraUsd).toBeGreaterThan(0);
    expect(r.vwapEntry * size).toBeCloseTo(size * p(0) + buy.extraUsd, 8);
  });
});

