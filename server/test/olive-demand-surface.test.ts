import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedFillVwap, type VenueMarketState } from '@options-arb/shared';
import { OliveAdapter } from '../src/adapters/olive';
import { decodeDemandSurface, demandSurfaceAddress } from '../src/adapters/olive/onchain';
import { oliveExecutionImpact } from '../src/signals/olive';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/olive-demand-surface-btc.json', import.meta.url), 'utf8')) as {
  address: string; pool: string; dataBase64: string;
};
const data = Buffer.from(fixture.dataBase64, 'base64');

describe('Olive DemandSurface account (row 99)', () => {
  it('is the PDA ["demand_surface", pool]', () => {
    expect(demandSurfaceAddress(fixture.pool)).toBe(fixture.address);
  });

  it('decodes the BTC pool’s calls push: 4 grid nodes, one day slot, settings', () => {
    const s = decodeDemandSurface(data, fixture.pool)!;
    expect(s.calls).toMatchObject({ gridStrength: 1, dateStrength: 0.5, halfLifeSeconds: 7_776_000, enabled: true, dateToday: 20783, lastFadeAt: 1795718267 });
    expect(s.calls.depthUsd).toBeCloseTo(582.909, 3);
    expect(s.calls.fadeIndex).toBeCloseTo(0.015924, 6);
    const nodes = s.calls.pushes.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
    expect(nodes).toEqual([[47, 4.038365], [48, 1.134805], [60, 2.802876], [61, 0.787625]]);
    expect(s.calls.dateLevels.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0)).toEqual([[351, 6.196852]]);
    expect(s.puts.pushes.every((v) => v === 0)).toBe(true);
    expect(s.puts.enabled).toBe(true);
  });

  it('rejects another account type or another pool', () => {
    const bad = Buffer.from(data);
    bad[0] ^= 1;
    expect(decodeDemandSurface(bad)).toBeNull();
    expect(decodeDemandSurface(data, '8K1JCw3bb1WKh6wcw8ehZW8UUPJti6quqNuDa7gMQRFZ')).toBeNull();
    expect(decodeDemandSurface(data.subarray(0, 7000))).toBeNull();
  });
});

const adapter = () =>
  new OliveAdapter({
    apiBase: 'http://127.0.0.1:1', apiKey: '', mode: 'onchain', staleMs: 60_000, rpcUrl: 'http://127.0.0.1:1',
    tokenRateApr: 0, usdcRateApr: 0, rateOverrides: {}, oliveMaxTenorDays: 400, volOverrides: {}, strikeBoundSigmas: 0,
  });
// The BTC fill's own moment (2026-11-26 18:37:47): oracle vol 55.2662%, held 0.15253058 BTC × spot.
const FILL_MS = 1795718267_000;
const EXPIRY_MS = 1806048000_000;
const state = (ds: VenueMarketState['oliveDemandSurface']): VenueMarketState => ({
  venue: 'olive', underlying: 'BTC', spot: 60542.985, modelVol: 0.552662, tokenRateApr: 0.1413, usdcRateApr: 0, ts: FILL_MS, source: 'test',
  oliveDemandSurface: ds,
});
const live = { status: 'live' as const, surface: decodeDemandSurface(data)!, heldUsd: { calls: 9234.656617, puts: 587.8 } };

describe('Olive quote at the standing markup', () => {
  it('prices the pushed point at σ·(1 + markup) — the fill’s markup_after 27.81%', () => {
    const q = adapter().getAmmQuote('BTC', 86000, EXPIRY_MS, 'call', FILL_MS, state(live));
    if (!('quote' in q)) throw new Error(q.rejected);
    expect(q.quote.oliveSurfaceMarkup).toBeCloseTo(0.278125, 3);
    expect(q.quote.iv).toBeCloseTo(0.552662 * (1 + q.quote.oliveSurfaceMarkup!), 12);
    expect(q.quote.flags ?? []).not.toContain('demand_surface_unknown');
  });

  it('leaves an untouched side (puts) at the oracle vol', () => {
    const q = adapter().getAmmQuote('BTC', 55000, EXPIRY_MS, 'put', FILL_MS, state(live));
    if (!('quote' in q)) throw new Error(q.rejected);
    expect(q.quote.iv).toBe(0.552662);
    expect(q.quote.oliveSurfaceMarkup).toBeUndefined();
  });

  it('flags the quote when the surface could not be read', () => {
    const q = adapter().getAmmQuote('BTC', 86000, EXPIRY_MS, 'call', FILL_MS, state({ status: 'unavailable', surface: null, heldUsd: null }));
    if (!('quote' in q)) throw new Error(q.rejected);
    expect(q.quote.flags).toContain('demand_surface_unknown');
  });

  it('a state without a surface (recordings before 2026-11-25) quotes as before, unflagged', () => {
    const q = adapter().getAmmQuote('BTC', 86000, EXPIRY_MS, 'call', FILL_MS, state(undefined));
    if (!('quote' in q)) throw new Error(q.rejected);
    expect(q.quote.iv).toBe(0.552662);
    expect(q.quote.flags ?? []).toEqual([]);
  });
});

describe('oliveExecutionImpact with the surface', () => {
  const tauYears = (EXPIRY_MS - FILL_MS) / 1000 / (365 * 86_400);
  const tokenCurve = [{ utilizationBps: 0, rateBps: 0 }, { utilizationBps: 7500, rateBps: 2000 }, { utilizationBps: 10000, rateBps: 17000 }];
  const tokenFixedRate = { betaBps: 10000, exposure: 0.05, timeValue: 0.05 * 60 * 86_400 };
  const owned = 0.15253058, free = 0.15253058 - 0.05189017;
  const custody = (ds: VenueMarketState['oliveDemandSurface']) => ({
    underlyingFree: free, usdcFreeUsd: 587.8, underlyingOwned: owned, usdcOwnedUsd: 587.8,
    tokenCurve, tokenFixedRate, curveShape: 'quadratic' as const, demandSurface: ds,
  });
  const empty = { ...live, surface: { calls: { ...live.surface.calls, pushes: Array(78).fill(0), dateLevels: Array(367).fill(0) }, puts: live.surface.puts } };
  const nowSec = FILL_MS / 1000, expiresAtSec = EXPIRY_MS / 1000;
  const model = (ds: VenueMarketState['oliveDemandSurface'], size: number) =>
    expectedFillVwap({
      kind: 'call', strike: 86000, spot: 60542.985, vol: 0.552662, tauYears, size, curve: tokenCurve, free, owned, perUnitLocked: 1,
      fixedRate: tokenFixedRate, curveShape: 'quadratic',
      surface: ds?.surface ? { side: ds.surface.calls, heldUsd: ds.heldUsd!.calls, nowSec, expiresAtSec } : null,
    })!;
  const impact = (ds: VenueMarketState['oliveDemandSurface'], size: number, quotedMark: number) =>
    oliveExecutionImpact({
      kind: 'call', strike: 86000, size, custody: custody(ds),
      priceFill: { spot: 60542.985, vol: 0.552662, tauYears, quotedMark, entryPrice: quotedMark, nowSec, expiresAtSec },
    });

  it('an empty surface: same zero-size quote, dearer fill (the order’s own push)', () => {
    const rateOnly = model(undefined, 0.04), withSurface = model(empty, 0.04);
    expect(withSurface.quoteEntry).toBeCloseTo(rateOnly.quoteEntry, 9);
    expect(impact(empty, 0.04, withSurface.quoteEntry).vwapEntry).toBeCloseTo(withSurface.vwapEntry, 9);
    expect(withSurface.vwapEntry).toBeGreaterThan(rateOnly.vwapEntry * 1.05);
  });

  it('the standing push raises the zero-size quote and the fill further', () => {
    const standing = model(live, 0.04), fresh = model(empty, 0.04);
    expect(standing.quoteEntry).toBeGreaterThan(fresh.quoteEntry * 1.2);
    expect(standing.vwapEntry).toBeGreaterThan(fresh.vwapEntry);
  });

  it('no fill price when the surface is unreadable or the side’s held USD is unknown', () => {
    const q = model(undefined, 0.04).quoteEntry;
    expect(impact({ status: 'unavailable', surface: null, heldUsd: null }, 0.04, q).vwapEntry).toBeNull();
    expect(impact({ ...live, heldUsd: null }, 0.04, q).vwapEntry).toBeNull();
  });
});
