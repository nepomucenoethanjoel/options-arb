import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bsPrice } from '@options-arb/shared';
import { GateAdapter, mapGateChain, parseGateName } from '../src/adapters/gate';
import { feeModels } from '../src/signals/fees';

/** Trimmed real responses captured 2026-11-05 (contracts + tickers, BTC_USDT and SOL_USDT). */
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const btc = load('gate-btc.json');
const sol = load('gate-sol.json');

describe('Gate names', () => {
  it('parses U_USDT-YYYYMMDD-K-C/P at 08:00 UTC, matching expiration_time', () => {
    expect(parseGateName('BTC_USDT-20261109-79500-C', 'BTC')).toEqual({
      venue: 'gate', instrumentId: 'BTC_USDT-20261109-79500-C', underlying: 'BTC',
      expiryTs: Date.UTC(2026, 10, 9, 8), expiryDate: '20261109', strike: 79500, kind: 'call',
    });
    expect(parseGateName('BTC_USDT-20261109-79500-C', 'SOL')).toBeNull();
    const c = btc.contracts.find((x: { name: string }) => x.name === 'BTC_USDT-20261109-79500-C');
    expect(c.expiration_time * 1000).toBe(Date.UTC(2026, 10, 9, 8));
  });
});

describe('Gate chain mapping (live fixtures)', () => {
  it('prices are USDT per coin; sizes are contracts × multiplier (BTC 0.01, SOL 1)', () => {
    const b = mapGateChain(btc.contracts, btc.tickers, 'BTC', 5);
    const c = b.quotes.find((q) => q.instrumentId === 'BTC_USDT-20261109-79500-C')!;
    expect(c).toMatchObject({ venue: 'gate', bid: 994, ask: 1080, bidSize: 0.01, askSize: 0.01, mark: 1033.4, indexPrice: 79673.62, ts: 5, source: 'gate:rest' });
    const s = mapGateChain(sol.contracts, sol.tickers, 'SOL', 5);
    const p = s.quotes.find((q) => q.instrumentId === 'SOL_USDT-20261120-95-P')!;
    expect(p).toMatchObject({ bid: 1.89, bidSize: 172, ask: 5.42, askSize: 194, mark: 3.66 });
  });

  it('marks are Black-Scholes-consistent per coin at Gate\'s own forward and IV (units check)', () => {
    const at = Date.parse(btc.capturedAt);
    const { instruments, quotes } = mapGateChain(btc.contracts, btc.tickers, 'BTC', at);
    for (const id of ['BTC_USDT-20261109-79500-C', 'BTC_USDT-20261109-79500-P']) {
      const q = quotes.find((x) => x.instrumentId === id)!;
      const i = instruments.find((x) => x.instrumentId === id)!;
      const bs = bsPrice({ forward: q.forward!, strike: i.strike, tauYears: (i.expiryTs - at) / (365 * 86_400_000), vol: q.iv!, discountFactor: 1, kind: i.kind });
      expect(Math.abs(bs / q.mark! - 1)).toBeLessThan(0.03); // ~$1,000 per 1 BTC, not per 0.01-BTC contract
    }
  });

  it('a "0" price is a missing side: no price, no size', () => {
    const { quotes } = mapGateChain(btc.contracts, btc.tickers, 'BTC', 0);
    const p = quotes.find((q) => q.instrumentId === 'BTC_USDT-20261108-73000-P')!;
    expect(p.bid).toBeNull();
    expect(p.bidSize).toBeNull();
    expect(p).toMatchObject({ ask: 24, askSize: 1.8 });
  });
});

describe('GateAdapter.getChain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads contracts + tickers and marks health ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).includes('/contracts') ? sol.contracts : sol.tickers) })));
    const a = new GateAdapter('https://x');
    expect((await a.getChain('SOL')).quotes).toHaveLength(3);
    expect(a.getHealth().status).toBe('ok');
  });

  it('an unlisted underlying (contracts: 400 CONTRACT_NOT_FOUND) is an empty chain without a tickers read; other 400s fail', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ label: 'CONTRACT_NOT_FOUND' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const a = new GateAdapter('https://x');
    expect(await a.getChain('ZEC')).toEqual({ instruments: [], quotes: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1); // live: tickers?underlying=ZEC_USDT answers INVALID_PARAM_VALUE
    expect(a.getHealth().status).toBe('ok');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ label: 'INVALID_PARAM_VALUE' }) })));
    await expect(new GateAdapter('https://x').getChain('BTC')).rejects.toThrow('INVALID_PARAM_VALUE');
  });
});

describe('Gate fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).gate!;
  const base = { notional: 80_000, kind: 'call' as const, strike: 82_000, tteDays: 7, side: 'buy' as const };

  it('taker 3 bps BTC/ETH, 5 bps others, capped at 12.5% of premium', () => {
    expect(fee.perContract({ ...base, underlying: 'BTC', legPrice: 500 })).toBeCloseTo(24, 9);
    expect(fee.perContract({ ...base, underlying: 'BTC', legPrice: 100 })).toBeCloseTo(12.5, 9);
    expect(fee.perContract({ ...base, notional: 100, strike: 110, underlying: 'SOL', legPrice: 2 })).toBeCloseTo(0.05, 9);
  });

  it('adds the settlement fee in the money: min(1.5 bps notional, 12.5% intrinsic)', () => {
    expect(fee.perContract({ ...base, underlying: 'BTC', strike: 70_000, legPrice: 10_500 })).toBeCloseTo(24 + 12, 9);
  });
});
