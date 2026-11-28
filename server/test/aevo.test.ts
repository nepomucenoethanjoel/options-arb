import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AevoAdapter, mapAevoChain, parseAevoName } from '../src/adapters/aevo';
import { feeModels } from '../src/signals/fees';

/** Trimmed real Aevo BTC responses captured 2026-11-22 (markets, options-chain 27NOV26, index) — row 91. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/aevo-btc.json', import.meta.url), 'utf8'));
const NOV27 = Date.UTC(2026, 10, 27, 8);

describe('Aevo names', () => {
  it('parses BTC-27NOV26-60000-C at 08:00 UTC', () => {
    expect(parseAevoName('BTC-27NOV26-60000-C', 'BTC')).toEqual({
      venue: 'aevo', instrumentId: 'BTC-27NOV26-60000-C', underlying: 'BTC', expiryTs: NOV27, expiryDate: '20261127', strike: 60000, kind: 'call',
    });
    expect(parseAevoName('BTC-4DEC26-58000-P', 'BTC')?.expiryDate).toBe('20261204');
    expect(parseAevoName('BTC-27NOV26-60000-C', 'ETH')).toBeNull();
  });

  it("the name's expiry agrees with the market list's expiry (ns)", () => {
    const m = fixture.markets.find((x: { instrument_name: string }) => x.instrument_name === 'BTC-27NOV26-60000-C');
    expect(Math.round(Number(m.expiry) / 1e6)).toBe(NOV27);
  });
});

describe('Aevo chain mapping (live fixture)', () => {
  const index = Number(fixture.index.price);
  const { instruments, quotes } = mapAevoChain(fixture.chain, 'BTC', index, 0);
  const q = (id: string) => quotes.find((x) => x.instrumentId === id)!;

  it('prices are USD per 1 coin, sizes in coin, IV a fraction', () => {
    expect(instruments).toHaveLength(6);
    expect(q('BTC-27NOV26-60000-C')).toMatchObject({ venue: 'aevo', bid: 1125, bidSize: 1.6, ask: 1290, askSize: 1.6, ivSource: 'market', indexPrice: index, source: 'aevo:rest' });
    expect(q('BTC-27NOV26-60000-C').iv).toBeCloseTo(0.605, 9);
    expect(q('BTC-27NOV26-60000-C').mark).toBeCloseTo(1207.289049, 6);
    expect(q('BTC-27NOV26-58000-P')).toMatchObject({ bid: 1302.5, ask: 1467.5 });
  });

  it('a "0" side is a missing side: no price, no size', () => {
    expect(q('BTC-27NOV26-90000-C')).toMatchObject({ bid: null, bidSize: null, ask: null, askSize: null });
  });

  it('drops a row whose name and expiry disagree', () => {
    const bad = { options: { calls: [{ ...fixture.chain.options.calls[0], expiry: '1795334400000000000' }], puts: [] } };
    expect(mapAevoChain(bad, 'BTC', index, 0).instruments).toHaveLength(0);
  });
});

describe('Aevo fee model (docs options-fees)', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).aevo!;
  const ctx = { underlying: 'BTC', tteDays: 5, side: 'buy' as const };
  it('taker 0.05% of index notional capped at 12.5% of premium, plus 0.015% settlement capped at 12.5% of payout', () => {
    // OTM call: no payout → no settlement fee; 0.05% × 59,000 = 29.5 < 12.5% × 1,290.
    expect(fee.perContract({ ...ctx, legPrice: 1290, notional: 59000, kind: 'call', strike: 60000 })).toBeCloseTo(29.5, 9);
    // Cheap leg: the 12.5% premium cap binds.
    expect(fee.perContract({ ...ctx, legPrice: 40, notional: 59000, kind: 'call', strike: 70000 })).toBeCloseTo(5, 9);
    // ITM put (payout 1,000): + min(0.015% × 59,000 = 8.85, 12.5% × 1,000).
    expect(fee.perContract({ ...ctx, legPrice: 1400, notional: 59000, kind: 'put', strike: 60000 })).toBeCloseTo(29.5 + 8.85, 9);
    expect(fee.perOrder).toBe(0);
  });
});

describe('AevoAdapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('reads the expiry list once, one options-chain per live expiry, and skips assets Aevo does not list', async () => {
    // The fixture's expiries are live only as of its capture: shift the clock back to it, still
    // ticking (a frozen Date stalls the rate limiter).
    const realNow = Date.now.bind(Date);
    const offset = realNow() - Date.parse('2026-11-22T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() - offset);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes('/markets') ? fixture.markets : url.includes('/index') ? fixture.index : url.includes('expiry=1795766400000000000') ? fixture.chain : { asset: 'BTC', options: { calls: null, puts: null } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    const a = new AevoAdapter('https://aevo.test');
    const chain = await a.getChain('BTC');
    expect(chain.quotes.map((x) => x.instrumentId)).toContain('BTC-27NOV26-60000-C');
    expect(urls.filter((u) => u.includes('/markets'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/options-chain')).length).toBeGreaterThanOrEqual(1);
    await a.getChain('BTC');
    expect(urls.filter((u) => u.includes('/markets'))).toHaveLength(1); // cached
    expect(await a.getChain('ZEC')).toEqual({ instruments: [], quotes: [] });
    expect(a.getHealth().status).toBe('ok');
  });
});
