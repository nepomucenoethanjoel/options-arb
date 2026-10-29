import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bsPrice, type FutureQuote, type MatchRow, type OptionQuote, type Venue } from '@options-arb/shared';
import { mapDeribitFutures } from '../src/adapters/deribit';
import { computeParity, DERIBIT_FUTURE_DELIVERY, DERIBIT_FUTURE_TAKER } from '../src/signals/parity';
import type { VenueFeeModel } from '../src/signals/fees';
import { EpisodeTracker } from '../src/episodes';
import type { EpisodeRecord } from '../src/storage';

const NOW = Date.UTC(2026, 9, 29, 12);
const EXPIRY = Date.UTC(2026, 10, 27, 8);
const TAU = (EXPIRY - NOW) / (365 * 86_400_000);
const F = 80_500;
const zeroFee: VenueFeeModel = { perContract: () => 0, perOrder: 0 };
const fees: Partial<Record<Venue, VenueFeeModel>> = { derive: zeroFee, coincall: zeroFee, deribit: zeroFee };
const ctx = { fees, spot: 80_100, now: NOW, staleQuoteMs: 60_000, capitalBorrowRateApr: 0, nearExpiryDays: 1 };
const future: FutureQuote = { venue: 'deribit', instrumentId: 'BTC-27NOV26', underlying: 'BTC', expiryTs: EXPIRY, bid: F, ask: F, mark: F, indexPrice: 80_100, ts: NOW };

const quote = (venue: Venue, price: number, size = 1): OptionQuote => ({
  venue, instrumentId: `${venue}-x`, ts: NOW, bid: price, bidSize: size, ask: price, askSize: size, mark: price, iv: 0.4, ivSource: 'market', source: venue,
});
function row(kind: 'call' | 'put', strike: number, legs: Partial<Record<Venue, OptionQuote>>): MatchRow {
  return {
    pairKey: `BTC-20261127-${strike}-${kind === 'call' ? 'C' : 'P'}`, underlying: 'BTC', expiryTs: EXPIRY, expiryDate: '20261127', strike, kind, matchType: 'exact_match',
    legs: Object.fromEntries(Object.entries(legs).map(([v, q]) => [v, { venue: v as Venue, instrumentId: q!.instrumentId, quote: q }])),
  };
}
// Black-76 with one forward and zero rates: C − P = F − K exactly.
const fair = (kind: 'call' | 'put', K: number) => bsPrice({ kind, forward: F, strike: K, vol: 0.4, tauYears: TAU, discountFactor: 1 });

describe('computeParity', () => {
  it('zero edge when every leg is at fair value with one forward (only the future fees remain)', () => {
    const K = 78_000;
    const rows = [row('call', K, { derive: quote('derive', fair('call', K)) }), row('put', K, { coincall: quote('coincall', fair('put', K)) })];
    const out = computeParity(rows, [future], ctx);
    const fut = F * (DERIBIT_FUTURE_TAKER + DERIBIT_FUTURE_DELIVERY);
    expect(out.map((p) => p.strategy).sort()).toEqual(['conversion', 'reversal']);
    for (const p of out) expect(p.netPerUnitUsdc).toBeCloseTo(-fut, 3);
    expect(out[0]!.flags).toEqual(expect.arrayContaining(['reference_venue', 'hedge_size_unverified', 'settlement_basis']));
  });

  it('a cheap call on one venue shows up as a positive conversion', () => {
    const K = 80_000;
    const rows = [
      row('call', K, { derive: quote('derive', fair('call', K) - 100), coincall: quote('coincall', fair('call', K)) }),
      row('put', K, { coincall: quote('coincall', fair('put', K), 3) }),
    ];
    const conv = computeParity(rows, [future], ctx).find((p) => p.strategy === 'conversion')!;
    expect(conv).toMatchObject({ callVenue: 'derive', putVenue: 'coincall', size: 1 });
    expect(conv.netPerUnitUsdc).toBeCloseTo(100 - F * (DERIBIT_FUTURE_TAKER + DERIBIT_FUTURE_DELIVERY), 3);
  });

  it('charges collateral drag on the short option and needs a future at the same expiry', () => {
    const K = 80_000;
    const rows = [row('call', K, { derive: quote('derive', fair('call', K)) }), row('put', K, { derive: quote('derive', fair('put', K)) })];
    const withDrag = computeParity(rows, [future], { ...ctx, capitalBorrowRateApr: 0.08 }).find((p) => p.strategy === 'conversion')!;
    expect(withDrag.capitalCostUsdc).toBeGreaterThanOrEqual(K * 0.08 * TAU - 1e-6);
    expect(computeParity(rows, [{ ...future, expiryTs: EXPIRY + 86_400_000 }], ctx)).toEqual([]);
  });
});

describe('Deribit futures mapping (live fixture)', () => {
  it('maps dated BTC futures at 08:00 UTC and skips the perpetual', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/deribit-futures-btc.json', import.meta.url), 'utf8'));
    const out = mapDeribitFutures(raw, 'BTC');
    expect(out.map((f) => f.instrumentId).sort()).toEqual(['BTC-27NOV26', 'BTC-6NOV26']);
    expect(out.find((f) => f.instrumentId === 'BTC-27NOV26')).toMatchObject({ expiryTs: EXPIRY, bid: 80490, ask: 80500 });
    expect(mapDeribitFutures(raw, 'SOL')).toEqual([]);
  });
});

describe('parity episodes', () => {
  it('records positive parity rows per contract under the parity tier', () => {
    const written: EpisodeRecord[] = [];
    const t = new EpisodeTracker({ recordEpisodes: (r) => written.push(...r) });
    const K = 80_000;
    const rows = [row('call', K, { derive: quote('derive', fair('call', K) - 100) }), row('put', K, { coincall: quote('coincall', fair('put', K)) })];
    t.observe([], NOW, computeParity(rows, [future], ctx));
    t.flush();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ tier: 'parity', buyVenue: 'derive', sellVenue: 'coincall', cycles: 1 });
  });
});

describe('parity with an AMM leg', () => {
  it('flags fill_model_skipped and stays out of the parity episode tier', () => {
    const K = 80_000;
    const rows = [row('call', K, { olive: quote('olive', fair('call', K) - 100) }), row('put', K, { coincall: quote('coincall', fair('put', K)) })];
    const conv = computeParity(rows, [future], { ...ctx, fees: { ...fees, olive: zeroFee } }).find((p) => p.strategy === 'conversion')!;
    expect(conv.callVenue).toBe('olive');
    expect(conv.flags).toContain('fill_model_skipped');
    const written: EpisodeRecord[] = [];
    const t = new EpisodeTracker({ recordEpisodes: (r) => written.push(...r) });
    t.observe([], NOW, [conv]);
    t.flush();
    expect(written).toHaveLength(0);
  });
});
