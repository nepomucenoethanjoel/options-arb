import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bsPrice } from '@options-arb/shared';
import { ParadexAdapter, mapParadexChain, parseParadexMarket } from '../src/adapters/paradex';
import { feeModels } from '../src/signals/fees';

/** Trimmed real responses captured 2026-11-06 (GET /v1/markets + /v1/markets/summary?market=ALL). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/paradex-btc.json', import.meta.url), 'utf8'));
const markets = fixture.markets.results;
const summary = fixture.summary.results;

describe('Paradex markets', () => {
  it('parses dated crypto options at their 08:00 UTC expiry', () => {
    const m = markets.find((x: { symbol: string }) => x.symbol === 'BTC-USD-7NOV26-76000-C');
    expect(parseParadexMarket(m, 'BTC')).toEqual({
      venue: 'paradex', instrumentId: 'BTC-USD-7NOV26-76000-C', underlying: 'BTC',
      expiryTs: Date.UTC(2026, 10, 7, 8), expiryDate: '20261107', strike: 76000, kind: 'call',
    });
    expect(parseParadexMarket(m, 'ETH')).toBeNull();
  });

  it('skips TradFi expiries (16:00 UTC), perpetual options and RFQ-only markets', () => {
    const m = markets.find((x: { symbol: string }) => x.symbol === 'BTC-USD-7NOV26-76000-C');
    expect(parseParadexMarket({ ...m, symbol: 'XAU-USD-7NOV26-4000-C', base_currency: 'XAU', expiry_at: Date.UTC(2026, 10, 7, 16) }, 'XAU')).toBeNull();
    expect(parseParadexMarket({ ...m, expiry_at: Date.UTC(2026, 10, 7, 16) }, 'BTC')).toBeNull();
    expect(parseParadexMarket({ ...m, funding_period_hours: 8 }, 'BTC')).toBeNull();
    expect(parseParadexMarket({ ...m, trading_mode: 'RFQ_ONLY' }, 'BTC')).toBeNull();
  });
});

describe('Paradex chain mapping (live fixture)', () => {
  const { instruments, quotes } = mapParadexChain(markets, summary, 'BTC', 0);

  it('prices are USD per coin, sizes in coin; a blank bid is a missing side', () => {
    expect(instruments).toHaveLength(3);
    const p = quotes.find((q) => q.instrumentId === 'BTC-USD-10NOV26-76000-P')!;
    expect(p).toMatchObject({ venue: 'paradex', bid: 1063.24, bidSize: 1, ask: 1277.99, askSize: 1, source: 'paradex:rest' });
    const c = quotes.find((q) => q.instrumentId === 'BTC-USD-25DEC26-135000-C')!;
    expect(c).toMatchObject({ bid: null, bidSize: null, ask: 620, askSize: 1 });
  });

  it('marks are Black-Scholes-consistent per coin at Paradex\'s spot and IV (units check)', () => {
    const at = Date.parse(fixture.capturedAt);
    for (const id of ['BTC-USD-10NOV26-76000-P', 'BTC-USD-7NOV26-76000-C']) {
      const q = quotes.find((x) => x.instrumentId === id)!;
      const i = instruments.find((x) => x.instrumentId === id)!;
      const bs = bsPrice({ forward: q.indexPrice!, strike: i.strike, tauYears: (i.expiryTs - at) / (365 * 86_400_000), vol: q.iv!, discountFactor: 1, kind: i.kind });
      expect(Math.abs(bs / q.mark! - 1)).toBeLessThan(0.03);
    }
  });
});

describe('ParadexAdapter.getChain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('one ALL-summary read serves every underlying in the same cycle; TradFi bases are not read', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => (String(url).includes('/summary') ? fixture.summary : fixture.markets) }));
    vi.stubGlobal('fetch', fetchMock);
    const a = new ParadexAdapter('https://x');
    await Promise.all([a.getChain('BTC'), a.getChain('ETH'), a.getChain('SOL')]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/summary'))).toHaveLength(1);
    expect(await a.getChain('XAU')).toEqual({ instruments: [], quotes: [] });
    expect(a.getHealth().status).toBe('ok');
  });
});

describe('Paradex fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).paradex!;
  const ctx = { notional: 80_000, underlying: 'BTC', kind: 'call' as const, strike: 82_000, tteDays: 7, side: 'buy' as const };

  it('0.01% of notional capped at 12.5% of premium, plus 0.0075% settlement in the money', () => {
    expect(fee.perContract({ ...ctx, legPrice: 500 })).toBeCloseTo(8, 9);
    expect(fee.perContract({ ...ctx, legPrice: 40 })).toBeCloseTo(5, 9);
    expect(fee.perContract({ ...ctx, strike: 70_000, legPrice: 10_500 })).toBeCloseTo(8 + 6, 9);
  });
});
