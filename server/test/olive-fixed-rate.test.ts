import { describe, expect, it } from 'vitest';
import { bsPrice, type VenueMarketState } from '@options-arb/shared';
import { OliveAdapter } from '../src/adapters/olive';
import { oliveExecutionImpact } from '../src/signals/olive';

const adapter = () =>
  new OliveAdapter({
    apiBase: 'http://127.0.0.1:1', apiKey: '', mode: 'onchain', staleMs: 60_000, rpcUrl: 'http://127.0.0.1:1',
    tokenRateApr: 0, usdcRateApr: 0, rateOverrides: {}, oliveMaxTenorDays: 365, volOverrides: {}, strikeBoundSigmas: 0,
  });

// SOL pool, live market file 2026-11-15 08:41 UTC: variable rates 96.84% / 43.34%; fixed-rate state per side.
const NOW = Date.parse('2026-11-15T08:00:00Z');
const state = (withFixed: boolean): VenueMarketState => ({
  venue: 'olive', underlying: 'SOL', spot: 70.58, modelVol: 0.605, tokenRateApr: 0.9684, usdcRateApr: 0.4334, ts: NOW, source: 'test',
  oliveFixedRate: withFixed
    ? {
        token: { betaBps: 2500, exposure: 61.661767, timeValue: 402716025.749638, owned: 65.671025202 },
        usdc: { betaBps: 2500, exposure: 3063.562823, timeValue: 1492554189.343622, owned: 3341.817862 },
      }
    : null,
});
const oliveCall = (r: number, S: number, K: number, T: number, vol: number) =>
  bsPrice({ forward: S * Math.exp(r * T), strike: K, tauYears: T, vol, discountFactor: Math.exp(-r * T), kind: 'call' });

describe('Olive zero-size quote includes the fixed-rate premium for its tenor (DATA_SOURCES row 78)', () => {
  const expiry = NOW + 30 * 86_400_000; // 30 d: premium 138 bp on the token side (live display 9822 = 9684 + 138)
  it('prices a call at variable + premium', () => {
    const q = adapter().getAmmQuote('SOL', 70, expiry, 'call', NOW, state(true));
    expect('quote' in q).toBe(true);
    if ('quote' in q) expect(q.quote.mark).toBeCloseTo(oliveCall(0.9684 + 0.0138, 70.58, 70, 30 / 365, 0.605), 10);
  });
  it('keeps the variable-only price when the market file carries no fixed-rate state (prior model, golden replay)', () => {
    const q = adapter().getAmmQuote('SOL', 70, expiry, 'call', NOW, state(false));
    if ('quote' in q) expect(q.quote.mark).toBeCloseTo(oliveCall(0.9684, 70.58, 70, 30 / 365, 0.605), 10);
  });
});

describe('oliveExecutionImpact uses Olive’s order mechanics when custody carries fixed-rate state', () => {
  it('reproduces the live SOL 73-C fill (2026-11-16 20:04:59, 18.944568 contracts at $1.371571)', () => {
    const S = 71.58227, K = 73, vol = 0.623879;
    const tauYears = (Date.UTC(2026, 10, 20, 8) - Date.parse('2026-11-16T20:04:59Z')) / 1000 / (365 * 86_400);
    const custody = {
      underlyingFree: 106.651550202 - 87.258241999, usdcFreeUsd: 1000, underlyingOwned: 106.651550202, usdcOwnedUsd: 1000,
      tokenCurve: [{ utilizationBps: 0, rateBps: 0 }, { utilizationBps: 7500, rateBps: 2000 }, { utilizationBps: 10000, rateBps: 12000 }],
      tokenFixedRate: { betaBps: 2500, exposure: 61.66176763180714, timeValue: 394859515.03067494 },
    };
    // Zero-size quote at the pre-trade state (r0 4737 bp) — what the cycle would have shown as the Olive mark.
    const quotedMark = oliveCall(0.4737, S, K, tauYears, vol);
    const r = oliveExecutionImpact({
      kind: 'call', strike: K, size: 18.944568, custody,
      priceFill: { spot: S, vol, tauYears, quotedMark, entryPrice: quotedMark },
    });
    expect(r.movesRate).toBe(true);
    expect(r.vwapEntry).toBeCloseTo(1.371571, 3);
  });
});
