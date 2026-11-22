import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bsPrice } from '@options-arb/shared';
import { OKX_FAMILIES, OkxAdapter, mapOkxChain, parseOkxId } from '../src/adapters/okx';
import { feeModels } from '../src/signals/fees';

/** Trimmed real BTC-USD responses captured 2026-11-05 13:16 UTC (instruments, tickers, opt-summary, mark-price, index). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/okx-btc.json', import.meta.url), 'utf8'));
const INDEX = 79669;

describe('OKX ids', () => {
  it('parses BTC-USD-YYMMDD-K-C/P at 08:00 UTC', () => {
    expect(parseOkxId('BTC-USD-261106-79750-C', 'BTC')).toEqual({
      venue: 'okx', instrumentId: 'BTC-USD-261106-79750-C', underlying: 'BTC',
      expiryTs: Date.UTC(2026, 10, 6, 8), expiryDate: '20261106', strike: 79750, kind: 'call',
    });
    expect(parseOkxId('BTC-USD-261106-79750-C', 'ETH')).toBeNull();
    // The instrument's own expTime agrees with the name.
    expect(Number(fixture.instruments.data[0].expTime)).toBe(Date.UTC(2026, 10, 6, 8));
  });
});

describe('OKX chain mapping (live fixture)', () => {
  const { instruments, quotes } = mapOkxChain(fixture, 'BTC', 0);
  const byId = (id: string) => quotes.find((q) => q.instrumentId === id)!;

  it('prices are coin per coin × index; sizes are contracts × 0.01 coin', () => {
    expect(instruments).toHaveLength(3);
    const c = byId('BTC-USD-261106-79750-C');
    expect(c.bid).toBeCloseTo(0.0055 * INDEX, 9);
    expect(c.ask).toBeCloseTo(0.006 * INDEX, 9);
    expect(c.bidSize).toBeCloseTo(32.84, 9);
    expect(c.askSize).toBeCloseTo(19.54, 9);
    expect(c).toMatchObject({ venue: 'okx', indexPrice: INDEX, ivSource: 'market', ts: 1793884582084, source: 'okx:rest' });
    expect(c.iv).toBeCloseTo(0.3368607228685091, 12);
    expect(c.forward).toBeCloseTo(79682.46174237422, 6);
  });

  it('the mark is consistent with Black-Scholes at OKX\'s own forward and mark vol (units check)', () => {
    for (const id of ['BTC-USD-261106-79750-C', 'BTC-USD-261106-79750-P']) {
      const q = byId(id);
      const i = instruments.find((x) => x.instrumentId === id)!;
      const tau = (i.expiryTs - q.ts) / (365 * 86_400_000);
      const bs = bsPrice({ forward: q.forward!, strike: i.strike, tauYears: tau, vol: q.iv!, discountFactor: 1, kind: i.kind });
      expect(Math.abs(bs - q.mark!)).toBeLessThan(0.5); // $462 / $530 marks
    }
  });

  it('an empty bid is a missing side: no price, no size', () => {
    const p = byId('BTC-USD-261127-48000-P');
    expect(p.bid).toBeNull();
    expect(p.bidSize).toBeNull();
    expect(p.ask).toBeCloseTo(0.0001 * INDEX, 9);
    expect(p.askSize).toBeCloseTo(30, 9);
  });

  it('no index → no quotes (never priced in coin)', () => {
    expect(mapOkxChain({ ...fixture, index: { code: '0', data: [] } }, 'BTC', 0).quotes).toEqual([]);
  });
});

describe('OkxAdapter.getChain', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (url: string) =>
    url.includes('/public/instruments') ? fixture.instruments
      : url.includes('/market/tickers') ? fixture.tickers
        : url.includes('/opt-summary') ? fixture.optSummary
          : url.includes('/mark-price') ? fixture.markPrice
            : fixture.index;

  it('reads the family and marks health ok; SOL is not listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => serve(String(url)) })));
    const a = new OkxAdapter('https://x');
    expect((await a.getChain('BTC')).quotes).toHaveLength(3);
    expect(a.getHealth().status).toBe('ok');
    expect(await a.getChain('SOL')).toEqual({ instruments: [], quotes: [] });
  });

  it('a non-zero OKX code fails health and throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: '50011', msg: 'Too Many Requests', data: [] }) })));
    const a = new OkxAdapter('https://x');
    await expect(a.getChain('ETH')).rejects.toThrow('code 50011');
    expect(a.getHealth().status).toBe('error');
  });
});

describe('OKX fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).okx!;
  const ctx = { notional: 80_000, underlying: 'BTC', kind: 'call' as const, strike: 82_000, tteDays: 7, side: 'buy' as const };

  it('taker 0.03% of notional, capped at 7% of premium; no exercise fee out of the money', () => {
    expect(fee.perContract({ ...ctx, legPrice: 500 })).toBeCloseTo(24, 9); // 0.03% × 80k < 7% × 500 = 35
    expect(fee.perContract({ ...ctx, legPrice: 100 })).toBeCloseTo(7, 9); // capped: 7% × 100
  });

  it('adds the exercise fee in the money: min(0.02% notional, 7% intrinsic)', () => {
    expect(fee.perContract({ ...ctx, strike: 70_000, legPrice: 10_500 })).toBeCloseTo(24 + 16, 9);
    expect(fee.perContract({ ...ctx, strike: 79_900, legPrice: 600 })).toBeCloseTo(24 + 7, 9); // 7% × $100 intrinsic
  });
});

/** Trimmed real SOL-USD_UM (USD-margined) responses captured 2026-11-22 — row 92. */
const solUm = JSON.parse(readFileSync(new URL('./fixtures/okx-sol-um.json', import.meta.url), 'utf8'));

describe('OKX USD-margined families (SOL, HYPE, gold)', () => {
  it("parses _UM ids; the XAU prefix maps to the app's XAUT row", () => {
    expect(parseOkxId('SOL-USD_UM-261127-70-C', 'SOL')).toMatchObject({ underlying: 'SOL', strike: 70, kind: 'call', expiryTs: Date.UTC(2026, 10, 27, 8) });
    expect(parseOkxId('XAU-USD_UM-261124-3450-C', 'XAUT', 'XAU')).toMatchObject({ underlying: 'XAUT', instrumentId: 'XAU-USD_UM-261124-3450-C', strike: 3450 });
    expect(parseOkxId('XAU-USD_UM-261124-3450-C', 'XAUT')).toBeNull();
    expect(OKX_FAMILIES.XAUT).toMatchObject({ family: 'XAU-USD_UM', index: 'XAU-USD', usd: true, flags: ['wrapper_basis'] });
  });

  it('prices are already USD (no × index); sizes are contracts × 0.1 SOL', () => {
    const { quotes } = mapOkxChain(solUm, 'SOL', 0, OKX_FAMILIES.SOL);
    const c = quotes.find((q) => q.instrumentId === 'SOL-USD_UM-261127-70-C')!;
    expect(c).toMatchObject({ bid: 1.91, ask: 2.49, indexPrice: 68.87 });
    expect(c.bidSize).toBeCloseTo(500, 9);
    expect(c.askSize).toBeCloseTo(500, 9);
    expect(c.flags).toBeUndefined();
  });

  it('gold quotes carry wrapper_basis (OKX XAU index vs the XAUT token)', () => {
    const xau = { ...solUm, instruments: { code: '0', data: [{ instId: 'XAU-USD_UM-261124-3450-C', stk: '3450', optType: 'C', ctVal: '1', ctMult: '0.01', state: 'live' }] }, tickers: { code: '0', data: [{ instId: 'XAU-USD_UM-261124-3450-C', bidPx: '104.5', bidSz: '198', askPx: '117.5', askSz: '198' }] }, optSummary: { code: '0', data: [] }, markPrice: { code: '0', data: [] }, index: { code: '0', data: [{ idxPx: '3540.84' }] } };
    const [q] = mapOkxChain(xau, 'XAUT', 0, OKX_FAMILIES.XAUT).quotes;
    expect(q).toMatchObject({ bid: 104.5, ask: 117.5, flags: ['wrapper_basis'] });
    expect(q!.bidSize).toBeCloseTo(1.98, 9);
  });
});
