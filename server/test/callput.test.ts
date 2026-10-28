import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallputAdapter, mapCallputChain } from '../src/adapters/callput';
import { feeModels } from '../src/signals/fees';

/** Trimmed real market-data.json (ETH, one expiry) captured 2026-10-28. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/callput-eth.json', import.meta.url), 'utf8'));

describe('Callput mapping (live fixture)', () => {
  const { instruments, quotes } = mapCallputChain(fixture, 'ETH');
  const q = (id: string) => quotes.find((x) => x.instrumentId === id)!;

  it('parses instruments at 08:00 UTC from the expiry seconds', () => {
    expect(instruments.find((i) => i.instrumentId === 'ETH-30OCT26-2150-P')).toEqual({
      venue: 'callput',
      instrumentId: 'ETH-30OCT26-2150-P',
      underlying: 'ETH',
      expiryTs: Date.UTC(2026, 9, 30, 8),
      expiryDate: '20261030',
      strike: 2150,
      kind: 'put',
    });
  });

  it('derives indicative bid/ask from mark ∓ the vault risk premium; no size; flagged', () => {
    const c = q('ETH-30OCT26-2150-C');
    expect(c.ask).toBeCloseTo(224.22729251643614 * (1 + 0.013905123399015135), 9);
    expect(c.bid).toBeCloseTo(224.22729251643614 * (1 - 0.009517116980555802), 9);
    expect(c.bidSize).toBeNull();
    expect(c.askSize).toBeNull();
    expect(c).toMatchObject({ iv: 0.7092970137738083, indexPrice: 2373.438666666666, forward: 2372.4531279066664, ts: 1793176302806, ivSource: 'model' });
    expect(c.flags).toEqual(['indicative_quote', 'execution_fee_unknown']);
  });

  it('an unavailable option keeps its mark/IV but has no tradable side', () => {
    const u = q('ETH-30OCT26-1600-C');
    expect(u.bid).toBeNull();
    expect(u.ask).toBeNull();
    expect(u.mark).toBeCloseTo(772.8886461486018, 9);
  });

  it('other underlyings come back empty', () => {
    expect(mapCallputChain(fixture, 'SOL')).toEqual({ instruments: [], quotes: [] });
  });
});

describe('CallputAdapter feed reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the shared feed at most once a minute across underlyings', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ etag: '"x"' }), json: async () => fixture }));
    vi.stubGlobal('fetch', fetchMock);
    const a = new CallputAdapter('https://x');
    await Promise.all([a.getChain('ETH'), a.getChain('BTC'), a.getChain('ETH')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.getHealth().status).toBe('ok');
  });
});

describe('Callput fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).callput!;
  const ctx = { notional: 2000, underlying: 'ETH', kind: 'call' as const, strike: 2100, tteDays: 7 };

  it('open-buy 6 bps / open-sell 3 bps plus settle 2 bps of notional, each capped at 12.5% of premium', () => {
    expect(fee.perContract({ ...ctx, legPrice: 100, side: 'buy' })).toBeCloseTo(2000 * 0.0006 + 2000 * 0.0002, 9);
    expect(fee.perContract({ ...ctx, legPrice: 100, side: 'sell' })).toBeCloseTo(2000 * 0.0003 + 2000 * 0.0002, 9);
    expect(fee.perContract({ ...ctx, legPrice: 4, side: 'buy' })).toBeCloseTo(0.5 + 0.4, 9); // 12.5% × 4 caps the 1.2 open fee
  });
});
