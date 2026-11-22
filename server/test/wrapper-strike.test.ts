import { describe, expect, it } from 'vitest';
import type { OptionQuote } from '@options-arb/shared';
import { buildSyntheticAmmQuote } from '../src/adapters/olive/synth';
import { WRAPPER_RATIO_BAND, wrapperAmmQuote, wrapperHedgeSpot } from '../src/scheduler';

const NOW = Date.UTC(2026, 10, 20, 15);
const EXPIRY = Date.UTC(2026, 10, 27, 17);
const TOKEN_SPOT = 706.0;
const ratio = 1.0069; // SPYX / SPY, 2026-10/11 regular-session mean (row 94)
const synth = (spot: number, strike: number) =>
  buildSyntheticAmmQuote({ underlying: 'SPY', strike, expiryTs: EXPIRY, kind: 'put', spot, vol: 0.2, tokenRateApr: 0.03, usdcRateApr: 0.05, now: NOW });

describe('wrapper strike scaling (Olive token vs hedge ETF)', () => {
  it("quotes the token at K·r (to the cent) and prices it per hedge unit — BS at the hedge's own spot and strike", () => {
    let asked: number | null = null;
    const res = wrapperAmmQuote(ratio, 700, (k) => {
      asked = k;
      return { quote: synth(TOKEN_SPOT, k) };
    });
    expect(asked).toBe(704.83);
    if (!('quote' in res)) throw new Error('rejected');
    const rEff = 704.83 / 700;
    const atHedge = synth(TOKEN_SPOT / rEff, 700);
    expect(res.quote.mark!).toBeCloseTo(atHedge.mark!, 9);
    expect(res.quote.indexPrice!).toBeCloseTo(TOKEN_SPOT / rEff, 9);
    expect(res.quote.forward!).toBeCloseTo(atHedge.forward!, 9);
    expect(res.quote.iv).toBe(0.2);
    // The id carries the strike to enter on Olive.
    expect(res.quote.instrumentId).toBe('OLIVE-SYNTH-SPY-20261127-704.83-P');
  });

  it('the unscaled quote at the same strike number would misprice the put by the moneyness gap', () => {
    const res = wrapperAmmQuote(ratio, 700, (k) => ({ quote: synth(TOKEN_SPOT, k) }));
    if (!('quote' in res)) throw new Error('rejected');
    const naive = synth(TOKEN_SPOT, 700).mark!; // the token put at 700 is further OTM than SPY's 700 put
    expect(naive).toBeLessThan(res.quote.mark!);
  });

  it('no ratio, or one outside the band, gives no Olive leg; a rejection at the token strike passes through', () => {
    expect(wrapperAmmQuote(null, 700, () => ({ quote: synth(TOKEN_SPOT, 700) }))).toEqual({ rejected: 'wrapper_ratio_unknown' });
    expect(wrapperAmmQuote(WRAPPER_RATIO_BAND.max + 0.01, 700, () => ({ quote: synth(TOKEN_SPOT, 700) }))).toEqual({ rejected: 'wrapper_ratio_out_of_band' });
    expect(wrapperAmmQuote(10.0, 700, () => ({ quote: synth(TOKEN_SPOT, 700) }))).toEqual({ rejected: 'wrapper_ratio_out_of_band' });
    expect(wrapperAmmQuote(ratio, 700, () => ({ rejected: 'strike_out_of_olive_bounds' }))).toEqual({ rejected: 'strike_out_of_olive_bounds' });
  });

  it('the hedge spot is the first non-Olive venue index price (Derive, then the listed chains)', () => {
    const q = (venue: OptionQuote['venue'], indexPrice: number | null) => ({ venue, indexPrice } as OptionQuote);
    expect(wrapperHedgeSpot(new Map(), [{ quotes: new Map([['a', q('olive', 706)], ['b', q('callput', 701.5)]]) }])).toBe(701.5);
    expect(wrapperHedgeSpot(new Map([['d', q('derive', 700.2)]]), [{ quotes: new Map([['b', q('callput', 701.5)]]) }])).toBe(700.2);
    expect(wrapperHedgeSpot(new Map(), [{ quotes: new Map([['b', q('callput', null)]]) }])).toBeNull();
  });
});
