import { describe, expect, it } from 'vitest';
import { pickBestVenues, type MatchRow, type OptionQuote, type Venue } from '@options-arb/shared';
import { feeModels } from '../src/signals/fees';
import { toLiteRows } from '../src/scheduler';

const NOW = Date.UTC(2026, 9, 29, 12);
const EXPIRY = Date.UTC(2026, 10, 13, 8);
const fees = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 2.5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 });

const q = (venue: Venue, o: Partial<OptionQuote>): OptionQuote => ({
  venue, instrumentId: `${venue}-x`, ts: NOW - 1_000, bid: null, bidSize: null, ask: null, askSize: null,
  mark: null, iv: 0.6, ivSource: 'market', source: venue, ...o,
});

function row(legs: Partial<Record<Venue, OptionQuote>>, expiryTs = EXPIRY): MatchRow {
  return {
    pairKey: 'ETH-20261113-2250-C', underlying: 'ETH', expiryTs, expiryDate: '20261113', strike: 2250, kind: 'call', matchType: 'exact_match',
    legs: Object.fromEntries(Object.entries(legs).map(([v, quote]) => [v, { venue: v as Venue, instrumentId: quote!.instrumentId, quote }])),
  };
}

const ctx = { fees, spots: { ETH: 2300 }, now: NOW, staleQuoteMs: 60_000 };
/** The full path: server effective prices on the lite row → the shared pick. */
const bestVenues = (r: MatchRow, c: typeof ctx, allowed?: Set<Venue>) => pickBestVenues(toLiteRows([r], c)[0]!.venues, allowed);

describe('best venue (effective prices + pick)', () => {
  it('the venue filter re-picks among allowed venues only', () => {
    const r = row({ derive: q('derive', { ask: 100, bid: 98 }), coincall: q('coincall', { ask: 100.5, bid: 98.4 }) });
    expect(bestVenues(r, ctx, new Set<Venue>(['coincall'])).bestBuy?.venue).toBe('coincall');
    expect(bestVenues(r, ctx, new Set<Venue>(['derive'])).bestSell?.venue).toBe('derive');
    expect(bestVenues(r, ctx, new Set<Venue>())).toEqual({ bestBuy: null, bestSell: null });
  });

  it('ranks by price after per-contract fees, not by the raw quote', () => {
    // Derive ask 100 + 0.03% × 2300 = 100.69; Coincall ask 100.5 + 0.69 + delivery 0.015% × 2300 (ITM by 50) = 101.535.
    const r = row({ derive: q('derive', { ask: 100, askSize: 5, bid: 98, bidSize: 3 }), coincall: q('coincall', { ask: 100.5, askSize: 9, bid: 98.4, bidSize: 2 }) });
    const { bestBuy, bestSell } = bestVenues(r, ctx);
    expect(bestBuy).toMatchObject({ venue: 'derive', price: 100, size: 5 });
    expect(bestBuy!.effectivePrice).toBeCloseTo(100.69, 9);
    expect(bestSell).toMatchObject({ venue: 'coincall', price: 98.4, size: 2 });
    expect(bestSell!.effectivePrice).toBeCloseTo(98.4 - 0.69 - 0.345, 9); // still beats Derive 98 − 0.69
  });

  it('AMM buys at its mark; never a sell venue where users cannot short', () => {
    const r = row({ olive: q('olive', { mark: 90, bid: 200 }), derive: q('derive', { ask: 100, bid: 98 }) });
    const { bestBuy, bestSell } = bestVenues(r, ctx);
    expect(bestBuy).toMatchObject({ venue: 'olive', price: 90, size: null });
    expect(bestSell?.venue).toBe('derive');
  });

  it('skips stale quotes and venues inside their trading cutoff; keeps quote flags', () => {
    const stale = row({ derive: q('derive', { ask: 100, ts: NOW - 120_000 }), deribit: q('deribit', { ask: 101, flags: ['reference_venue'] }) });
    expect(bestVenues(stale, ctx).bestBuy).toMatchObject({ venue: 'deribit', flags: ['reference_venue'] });
    const nearExpiry = row({ coincall: q('coincall', { ask: 1, bid: 0.9 }) }, NOW + 10 * 60_000); // Coincall halts 15 min before
    expect(bestVenues(nearExpiry, ctx)).toEqual({ bestBuy: null, bestSell: null });
  });
});
