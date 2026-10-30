import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoincallAdapter, mapCoincallInstrument, mapCoincallOption } from '../src/adapters/coincall';
import { feeModels } from '../src/signals/fees';

/** Trimmed real responses captured 2026-10-28 (getInstruments/SOL, get/v1/SOLUSD). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/coincall-sol.json', import.meta.url), 'utf8'));

describe('Coincall mapping (live fixture)', () => {
  it('parses instruments: strike, kind, 08:00 UTC expiry', () => {
    const insts = fixture.instruments.data.map((r: object) => mapCoincallInstrument(r, 'SOL'));
    const put = insts.find((i: { instrumentId: string }) => i.instrumentId === 'SOLUSD-29OCT26-103.0-P');
    expect(put).toEqual({
      venue: 'coincall',
      instrumentId: 'SOLUSD-29OCT26-103.0-P',
      underlying: 'SOL',
      expiryTs: Date.UTC(2026, 9, 29, 8),
      expiryDate: '20261029',
      strike: 103,
      kind: 'put',
    });
    expect(insts.find((i: { instrumentId: string }) => i.instrumentId === 'SOLUSD-25DEC26-190.0-C')?.kind).toBe('call');
    expect(mapCoincallInstrument(fixture.instruments.data[0], 'BTC')).toBeNull(); // wrong base
  });

  it('maps a two-sided quote with sizes, IV fraction, spot index and greeks', () => {
    const raw = fixture.chain.data.map((e: { callOption?: object; putOption?: object }) => e.callOption ?? e.putOption);
    const q = mapCoincallOption(raw.find((o: { symbol: string }) => o.symbol === 'SOLUSD-25DEC26-115.0-P'), 1);
    expect(q).toMatchObject({
      venue: 'coincall', bid: 2, bidSize: 10, ask: 71.74, askSize: 10, mark: 18.09491224,
      iv: 0.6195, indexPrice: 102.4563302, ivSource: 'market', ts: 1,
    });
    expect(q?.greeks?.delta).toBe(-0.63469);
  });

  it('treats a null bid as a missing side (no size either)', () => {
    const raw = fixture.chain.data.map((e: { callOption?: object; putOption?: object }) => e.callOption ?? e.putOption);
    const q = mapCoincallOption(raw.find((o: { symbol: string }) => o.symbol === 'SOLUSD-29OCT26-103.0-P'), 1);
    expect(q?.bid).toBeNull();
    expect(q?.bidSize).toBeNull();
    expect(q?.ask).toBe(8.95);
  });
});

describe('CoincallAdapter.getChain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns instruments + quotes and marks health ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (String(url).includes('getInstruments') ? fixture.instruments : fixture.chain),
      })),
    );
    const a = new CoincallAdapter('https://x');
    const { instruments, quotes } = await a.getChain('SOL');
    expect(instruments).toHaveLength(3);
    expect(quotes).toHaveLength(3);
    expect(a.getHealth().status).toBe('ok');
  });

  it('an unlisted underlying (code 40034) is an empty chain, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 40034, msg: 'The option does not exist' }) })));
    const a = new CoincallAdapter('https://x');
    expect(await a.getChain('ZEC')).toEqual({ instruments: [], quotes: [] });
    expect(a.getHealth().status).toBe('ok');
  });

  it('re-asks a replayed snapshot, stamps quotes when the snapshot first appeared, flags old replays stale', async () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const fresh = structuredClone(fixture.chain);
    fresh.data[0].callOption ? (fresh.data[0].callOption.markPrice += 0.01) : (fresh.data[0].putOption.markPrice += 0.01);
    let served: object[] = [];
    let chainReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        clock += 300; // clears the 250 ms request spacing
        if (String(url).includes('getInstruments')) return { ok: true, json: async () => fixture.instruments };
        chainReads++;
        return { ok: true, json: async () => served.shift() ?? fixture.chain };
      }),
    );
    const a = new CoincallAdapter('https://x');

    served = [fixture.chain];
    const t0 = clock;
    let { quotes } = await a.getChain('SOL');
    expect(chainReads).toBe(1);
    expect(quotes[0].ts).toBeGreaterThan(t0);
    expect(quotes[0].flags).toBeUndefined();
    const firstSeen = quotes[0].ts;

    clock += 30_000;
    chainReads = 0;
    served = [fixture.chain, fixture.chain, fixture.chain];
    ({ quotes } = await a.getChain('SOL'));
    expect(chainReads).toBe(3);
    expect(quotes.every((q) => q.ts === firstSeen && q.flags?.includes('stale'))).toBe(true);

    clock += 30_000;
    chainReads = 0;
    served = [fixture.chain, fresh];
    ({ quotes } = await a.getChain('SOL'));
    expect(chainReads).toBe(2);
    expect(quotes[0].ts).toBe(clock);
    expect(quotes[0].flags).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('an HTTP error fails health and throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    const a = new CoincallAdapter('https://x');
    await expect(a.getChain('SOL')).rejects.toThrow('HTTP 503');
    expect(a.getHealth().status).toBe('error');
  });
});

describe('Coincall fee model', () => {
  const fee = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).coincall!;
  const ctx = { notional: 100, kind: 'call' as const, strike: 110, tteDays: 30, side: 'buy' as const };

  it('altcoins pay 0.06% taker, BTC/ETH 0.03%, capped at 12.5% of premium', () => {
    expect(fee.perContract({ ...ctx, legPrice: 5, underlying: 'SOL' })).toBeCloseTo(0.06, 6);
    expect(fee.perContract({ ...ctx, legPrice: 5, underlying: 'ETH', notional: 1000, strike: 1100 })).toBeCloseTo(0.3, 6);
    expect(fee.perContract({ ...ctx, legPrice: 0.2, underlying: 'SOL' })).toBeCloseTo(0.025, 6); // 12.5% × 0.2 binds
  });

  it('adds the delivery fee for ITM non-dailies only', () => {
    const itm = { ...ctx, strike: 90, legPrice: 12, underlying: 'SOL' };
    expect(fee.perContract(itm)).toBeCloseTo(0.06 + Math.min(100 * 0.00015, 10 * 0.125), 6);
    expect(fee.perContract({ ...itm, tteDays: 0.5 })).toBeCloseTo(0.06, 6); // daily: waived
  });
});
