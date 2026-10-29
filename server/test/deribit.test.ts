import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHeadlineProfitable, type Signal } from '@options-arb/shared';
import { DeribitAdapter, mapDeribitSummary, mapDeribitTicker, parseDeribitName } from '../src/adapters/deribit';
import { feeModels } from '../src/signals/fees';
import { buildKpis } from '../src/api/server';

/** Trimmed real responses captured 2026-10-29 (BTC inverse book, USDC-linear book, one ticker). */
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const btc = load('deribit-summary-btc.json');
const usdc = load('deribit-summary-usdc.json');
const ticker = load('deribit-ticker-btc.json');

describe('Deribit names', () => {
  it('parses inverse and USDC-linear names at 08:00 UTC; "d" is a decimal point', () => {
    expect(parseDeribitName('BTC-27NOV26-80000-C', 'BTC')).toEqual({
      venue: 'deribit', instrumentId: 'BTC-27NOV26-80000-C', underlying: 'BTC',
      expiryTs: Date.UTC(2026, 10, 27, 8), expiryDate: '20261127', strike: 80000, kind: 'call',
    });
    expect(parseDeribitName('SOL_USDC-6NOV26-98-P', 'SOL')).toMatchObject({ expiryTs: Date.UTC(2026, 10, 6, 8), strike: 98, kind: 'put' });
    expect(parseDeribitName('XRP_USDC-6NOV26-2d5-C', 'XRP')?.strike).toBe(2.5);
    expect(parseDeribitName('BTC-27NOV26-80000-C', 'ETH')).toBeNull();
  });
});

describe('Deribit summary mapping (live fixtures)', () => {
  it('converts inverse coin prices to USD at the index; no sizes; reference flag', () => {
    const { instruments, quotes } = mapDeribitSummary(btc, 'BTC');
    expect(instruments).toHaveLength(3);
    const c = quotes.find((q) => q.instrumentId === 'BTC-27NOV26-80000-C')!;
    expect(c.bid).toBeCloseTo(0.043 * 80232.76, 9);
    expect(c.ask).toBeCloseTo(0.044 * 80232.76, 9);
    expect(c).toMatchObject({ bidSize: null, askSize: null, iv: expect.closeTo(0.3535, 9), indexPrice: 80232.76, forward: 80579.31, ts: 1793251760959, flags: ['reference_venue'] });
    const oneSided = quotes.find((q) => q.instrumentId === 'BTC-31OCT26-87000-C')!;
    expect(oneSided.bid).toBeNull();
    expect(oneSided.ask).toBeCloseTo(0.0002 * 80232.76, 9);
  });

  it('SOL reads the USDC-linear book (USDC per 1 SOL) and ignores other bases in it', () => {
    const sol = mapDeribitSummary(usdc, 'SOL');
    expect(sol.quotes.map((q) => q.instrumentId).sort()).toEqual(['SOL_USDC-25DEC26-96-C', 'SOL_USDC-6NOV26-98-C']);
    expect(sol.quotes.find((q) => q.instrumentId === 'SOL_USDC-6NOV26-98-C')).toMatchObject({ bid: 4.5, ask: 4.8, iv: expect.closeTo(0.5573, 9) });
    // BTC/ETH come from the inverse book only — ETH_USDC in the USDC book is not used.
    expect(mapDeribitSummary(usdc, 'ETH').quotes).toHaveLength(0);
    expect(mapDeribitSummary(btc, 'ZEC').quotes).toHaveLength(0);
  });

  it('ticker carries sizes (coin) in the same USD units', () => {
    const t = mapDeribitTicker(ticker, false)!;
    expect(t.bid).toBeCloseTo(0.043 * 80232.71, 9);
    expect(t).toMatchObject({ bidSize: 9.7, askSize: 35.4, iv: expect.closeTo(0.3535, 9), ts: 1793251761909 });
  });
});

describe('DeribitAdapter.enrichQuotes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tops up sizes from tickers and keeps the quote on a failed ticker', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('80000-C') ? { ok: true, status: 200, json: async () => ticker } : { ok: false, status: 500, json: async () => ({}) },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { quotes } = mapDeribitSummary(btc, 'BTC');
    const out = await new DeribitAdapter('https://x').enrichQuotes(quotes.slice(0, 2));
    expect(out[0]).toMatchObject({ instrumentId: 'BTC-27NOV26-80000-C', bidSize: 9.7, askSize: 35.4, source: 'deribit:ticker', flags: ['reference_venue'] });
    expect(out[1]).toBe(quotes[1]);
  });
});

describe('Deribit fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).deribit!;
  const ctx = { notional: 80_000, underlying: 'BTC', kind: 'call' as const, strike: 80_000, tteDays: 29, side: 'buy' as const };

  it('0.03% of underlying capped at 12.5% of premium, plus delivery on ITM non-dailies', () => {
    expect(fee.perContract({ ...ctx, legPrice: 3500 })).toBeCloseTo(24, 9); // ATM: no intrinsic
    expect(fee.perContract({ ...ctx, legPrice: 40 })).toBeCloseTo(5, 9); // 12.5% × 40 caps 24
    expect(fee.perContract({ ...ctx, strike: 70_000, legPrice: 11_000 })).toBeCloseTo(24 + 12, 9);
    expect(fee.perContract({ ...ctx, strike: 70_000, legPrice: 11_000, tteDays: 0.5 })).toBeCloseTo(24, 9);
  });
});

describe('reference venue stays out of the headline', () => {
  it('a profitable Deribit pair is not headline and not in the KPI', () => {
    const s = {
      pairKey: 'BTC-20261127-80000-C', underlying: 'BTC', expiryDate: '20261127', expiryTs: 0, strike: 80000, kind: 'call',
      ivSpreadVols: 5, ivSpreadBps: 1, entryPriceUsdc: 3400, exitPriceUsdc: 3600, edgeUsdc: 200, netEdgeUsdc: 150,
      netAfterCapitalUsdc: 100, costsUsdc: 50, capitalCostUsdc: 50, maxExecutableSize: 1, totalNetUsdc: 100, roiApyPct: 1,
      expectedEntryUsdc: null, expectedNetAfterCapitalUsdc: null, expectedTotalNetUsdc: null, settlementBasisUsdc: 0,
      syntheticCrossCheckUsdc: null, crossCheckDeviationUsdc: null, bookVsMarkUsdc: null, score: 1, isOpportunity: true,
      isProfitable: true, buyVenue: 'derive', sellVenue: 'deribit', flags: ['reference_venue'], ts: 0,
    } as Signal;
    expect(isHeadlineProfitable(s)).toBe(false);
    expect(buildKpis([s])).toMatchObject({ executableProfitableCount: 0, totalExecutableUsd: 0 });
    expect(isHeadlineProfitable({ ...s, flags: [] })).toBe(true);
  });
});
