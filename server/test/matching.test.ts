import { describe, expect, it } from 'vitest';
import type { OptionInstrument, OptionQuote } from '@options-arb/shared';
import type { AmmQuoteResult } from '../src/adapters/olive';
import { matchChain as matchVenues, pairKeyOf, type MatchConfig } from '../src/matching/engine';

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const config: MatchConfig & { oliveMaxTenorMs: number } = {
  expiryToleranceMs: 86_400_000,
  maxStrikeRelDist: 0.02,
  oliveMaxTenorMs: 365 * 86_400_000,
};

/** Two-venue harness: Derive anchors the grid, Olive is listed and/or synthesized. */
function matchChain(input: {
  now: number;
  underlying: string;
  deriveInstruments: OptionInstrument[];
  deriveQuotes: Map<string, OptionQuote>;
  oliveInstruments?: OptionInstrument[];
  oliveQuotes?: Map<string, OptionQuote>;
  oliveQuoteProvider?: (strike: number, expiryTs: number, kind: 'call' | 'put') => AmmQuoteResult;
  config: typeof config;
}) {
  const { oliveMaxTenorMs, ...matchConfig } = input.config;
  return matchVenues({
    now: input.now,
    underlying: input.underlying,
    chains: [
      { venue: 'derive', instruments: input.deriveInstruments, quotes: input.deriveQuotes },
      // Olive is always the expected counterpart (absent data → no_olive_data).
      { venue: 'olive' as const, instruments: input.oliveInstruments ?? [], quotes: input.oliveQuotes ?? new Map(), anchor: false },
    ],
    synthesizers: input.oliveQuoteProvider ? [{ venue: 'olive', maxTenorMs: oliveMaxTenorMs, quote: input.oliveQuoteProvider }] : [],
    config: matchConfig,
  });
}

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
    expect(rows[0].legs.olive?.note).toBe('amm_synthetic');
    expect(rows[0].legs.olive?.quote?.iv).toBe(0.55);
    expect(rows[0].legs.derive?.quote?.iv).toBe(0.6);
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
    expect(rows[0].legs.olive?.note).toContain('listed');
    expect(rows[0].legs.olive?.note).toContain('expiry_off_1d');
    expect(rows[0].legs.olive?.instrumentId).toBe('OLIVE-20261031-2900-C');
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
    expect(rows[0].legs.olive?.note).toContain('nearest_strike_2910');
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
    expect(rows[0].unmatchedReason).toBe('no_anchor_listing');
    expect(rows[0].legs.derive).toBeUndefined();
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

describe('matchChain — multiple anchor venues', () => {
  it('unions anchor chains on pairKey and keeps one leg per venue', () => {
    const coincall = (strike: number): OptionInstrument => ({ ...deriveInst(strike), venue: 'coincall', instrumentId: `ETHUSD-30OCT26-${strike}.0-C` });
    const rows = matchVenues({
      now: NOW,
      underlying: 'ETH',
      chains: [
        { venue: 'derive', instruments: [deriveInst(2900)], quotes: new Map() },
        { venue: 'coincall', instruments: [coincall(2900), coincall(3000)], quotes: new Map() },
      ],
      config,
    });
    expect(rows.map((r) => r.pairKey)).toEqual(['ETH-20261030-2900-C', 'ETH-20261030-3000-C']);
    expect(Object.keys(rows[0].legs).sort()).toEqual(['coincall', 'derive']);
    expect(rows[0].matchType).toBe('exact_match');
    expect(rows[1].matchType).toBe('unmatched_no_counterpart');
    expect(rows[1].unmatchedReason).toBe('no_counterpart');
  });
});

describe('matchChain — structured leg offsets', () => {
  it('flags interpolated matches with the strike offset', () => {
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
    expect(rows[0].legs.olive?.strikeOffset).toBe(10);
    expect(rows[0].legs.olive?.expiryOffsetDays).toBeUndefined();
  });

  it('flags expiry-offset matches on the exact-strike branch too', () => {
    const oliveListing: OptionInstrument = {
      ...deriveInst(2900, '20261031'), // same strike, +1 day
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
      config,
    });
    expect(rows[0].legs.olive?.strikeOffset).toBeUndefined();
    expect(rows[0].legs.olive?.expiryOffsetDays).toBe(1);
  });

  it('leaves offsets undefined for same-day AMM synthetics (live behavior)', () => {
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
    expect(rows[0].legs.olive?.strikeOffset).toBeUndefined();
    expect(rows[0].legs.olive?.expiryOffsetDays).toBeUndefined();
  });
});
