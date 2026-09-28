import { describe, expect, it } from 'vitest';
import type { OptionInstrument, OptionQuote } from '@options-arb/shared';
import { matchChain, pairKeyOf, type MatchConfig } from '../src/matching/engine';

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const config: MatchConfig = {
  expiryToleranceMs: 86_400_000,
  maxStrikeRelDist: 0.02,
  oliveMaxTenorMs: 365 * 86_400_000,
};

function deriveInst(strike: number, expiryDate = '20261030', kind: 'call' | 'put' = 'call'): OptionInstrument {
  const [y, m, d] = [expiryDate.slice(0, 4), expiryDate.slice(4, 6), expiryDate.slice(6, 8)];
  return {
    venue: 'derive',
    instrumentId: `ETH-${expiryDate}-${strike}-${kind === 'call' ? 'C' : 'P'}`,
    underlying: 'ETH',
    expiryTs: Date.UTC(Number(y), Number(m) - 1, Number(d), 8),
    expiryDate,
    strike,
    kind,
  };
}

function quote(venue: 'derive' | 'olive', id: string, iv: number, mark = 10): OptionQuote {
  return {
    venue,
    instrumentId: id,
    ts: NOW,
    bid: venue === 'derive' ? mark - 1 : null,
    bidSize: venue === 'derive' ? 5 : null,
    ask: venue === 'derive' ? mark + 1 : null,
    askSize: venue === 'derive' ? 5 : null,
    mark,
    iv,
    ivSource: venue === 'derive' ? 'market' : 'model',
    source: `${venue}:test`,
  };
}

describe('pairKeyOf', () => {
  it('is canonical', () => {
    expect(pairKeyOf('ETH', '20261030', 2900, 'call')).toBe('ETH-20261030-2900-C');
    expect(pairKeyOf('ETH', '20261030', 2900, 'put')).toBe('ETH-20261030-2900-P');
  });
});

describe('matchChain', () => {
  it('pairs AMM synthetic quotes as exact_match at Derive grid points', () => {
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900)],
      deriveQuotes: new Map([['ETH-20261030-2900-C', quote('derive', 'ETH-20261030-2900-C', 0.6)]]),
      oliveQuoteProvider: (strike, expiryTs, kind) => ({
        quote: quote('olive', `SYNTH-${strike}-${expiryTs}-${kind}`, 0.55),
      }),
      config,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].matchType).toBe('exact_match');
    expect(rows[0].olive.note).toBe('amm_synthetic');
    expect(rows[0].olive.quote?.iv).toBe(0.55);
    expect(rows[0].derive.quote?.iv).toBe(0.6);
  });

  it('marks out-of-bounds strikes as unmatched with reason', () => {
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(10_000)],
      deriveQuotes: new Map(),
      oliveQuoteProvider: () => ({ rejected: 'strike_out_of_olive_bounds' }),
      config,
    });
    expect(rows[0].matchType).toBe('unmatched_no_counterpart');
    expect(rows[0].unmatchedReason).toBe('strike_out_of_olive_bounds');
  });

  it('marks beyond-tenor expiries as unmatched', () => {
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900, '20280101')],
      deriveQuotes: new Map(),
      oliveQuoteProvider: () => ({ rejected: 'strike_out_of_olive_bounds' }),
      config: { ...config, oliveMaxTenorMs: 30 * 86_400_000 },
    });
    expect(rows[0].unmatchedReason).toBe('beyond_olive_max_tenor');
  });

  it('prefers an exact listed Olive strike over AMM synthesis', () => {
    const oliveListing: OptionInstrument = {
      ...deriveInst(2900, '20261031'), // 1 day offset, within tolerance
      venue: 'olive',
      instrumentId: 'OLIVE-20261031-2900-C',
    };
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900)],
      deriveQuotes: new Map(),
      oliveInstruments: [oliveListing],
      oliveQuotes: new Map([['OLIVE-20261031-2900-C', quote('olive', 'OLIVE-20261031-2900-C', 0.52)]]),
      oliveQuoteProvider: () => ({ quote: quote('olive', 'SYNTH', 0.55) }),
      config,
    });
    expect(rows[0].matchType).toBe('exact_match');
    expect(rows[0].olive.note).toContain('listed');
    expect(rows[0].olive.note).toContain('expiry_off_1d');
    expect(rows[0].olive.instrumentId).toBe('OLIVE-20261031-2900-C');
  });

  it('falls back to nearest-strike interpolation within maxStrikeRelDist', () => {
    const oliveListing: OptionInstrument = {
      ...deriveInst(2910, '20261030'),
      venue: 'olive',
      instrumentId: 'OLIVE-20261030-2910-C',
    };
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900)],
      deriveQuotes: new Map(),
      oliveInstruments: [oliveListing],
      oliveQuotes: new Map([['OLIVE-20261030-2910-C', quote('olive', 'OLIVE-20261030-2910-C', 0.52)]]),
      config,
    });
    expect(rows[0].matchType).toBe('interpolated');
    expect(rows[0].olive.note).toContain('nearest_strike_2910');
  });

  it('does not interpolate beyond maxStrikeRelDist', () => {
    const oliveListing: OptionInstrument = {
      ...deriveInst(3200, '20261030'),
      venue: 'olive',
      instrumentId: 'OLIVE-20261030-3200-C',
    };
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900)],
      deriveQuotes: new Map(),
      oliveInstruments: [oliveListing],
      oliveQuotes: new Map(),
      oliveQuoteProvider: () => ({ rejected: 'strike_out_of_olive_bounds' }),
      config,
    });
    expect(rows[0].matchType).toBe('unmatched_no_counterpart');
  });

  it('emits olive-only unmatched rows for listings with no Derive counterpart', () => {
    const oliveListing: OptionInstrument = {
      ...deriveInst(1234, '20270115'),
      venue: 'olive',
      instrumentId: 'OLIVE-20270115-1234-C',
    };
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [],
      deriveQuotes: new Map(),
      oliveInstruments: [oliveListing],
      oliveQuotes: new Map([['OLIVE-20270115-1234-C', quote('olive', 'OLIVE-20270115-1234-C', 0.4)]]),
      config,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].unmatchedReason).toBe('no_derive_listing');
    expect(rows[0].derive.quote).toBeNull();
  });

  it('skips expired Derive instruments', () => {
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900, '20260101')],
      deriveQuotes: new Map(),
      config,
    });
    expect(rows).toHaveLength(0);
  });

  it('reports no_olive_data when the provider is absent', () => {
    const rows = matchChain({
      now: NOW,
      underlying: 'ETH',
      deriveInstruments: [deriveInst(2900)],
      deriveQuotes: new Map(),
      config,
    });
    expect(rows[0].unmatchedReason).toBe('no_olive_data');
  });
});
