import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchRow, OptionInstrument, OptionQuote, Signal } from '@options-arb/shared';
import type { AmmQuoteResult } from '../src/adapters/olive';
import { matchChain, type MatchConfig } from '../src/matching/engine';
import { computeSignals, type SignalConfig } from '../src/signals/engine';

/**
 * Regression guard recorded from a live Olive × Derive cycle
 * (src/scripts/record-golden.ts). Replaying the recorded venue inputs must
 * reproduce every money field and flag exactly — refactors may reshape
 * types, never change numbers.
 */
interface GoldenCase {
  underlying: string;
  now: number;
  deriveInstruments: OptionInstrument[];
  deriveQuotes: OptionQuote[];
  ammCalls: Array<{ strike: number; expiryTs: number; kind: 'call' | 'put'; result: AmmQuoteResult }>;
  /** Recorded with the pre-refactor config shape (oliveMaxTenorMs inside). */
  matchConfig: MatchConfig & { oliveMaxTenorMs?: number };
  oliveMaxTenorMs?: number;
  signalConfig: SignalConfig;
  spots: Record<string, number | null>;
  /** Legacy row shape (fixed derive/olive legs) — compared via toLegacyRow. */
  rows: Array<Record<string, unknown>>;
  signals: Signal[];
}

/** Project a venue-keyed row onto the recorded two-leg shape. */
function toLegacyRow(r: MatchRow): Record<string, unknown> {
  const { legs, ...rest } = r;
  return {
    ...rest,
    derive: legs.derive ?? { venue: 'derive', instrumentId: null, quote: null },
    olive: legs.olive ?? { venue: 'olive', instrumentId: null, quote: null },
  };
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/golden-olive-derive.json', import.meta.url), 'utf8'),
) as { cases: GoldenCase[] };

const ammKey = (strike: number, expiryTs: number, kind: string) => `${strike}|${expiryTs}|${kind}`;

function replay(c: GoldenCase): { rows: MatchRow[]; signals: Signal[] } {
  const amm = new Map(c.ammCalls.map((a) => [ammKey(a.strike, a.expiryTs, a.kind), a.result]));
  const rows = matchChain({
    now: c.now,
    underlying: c.underlying,
    chains: [{ venue: 'derive', instruments: c.deriveInstruments, quotes: new Map(c.deriveQuotes.map((q) => [q.instrumentId, q])) }],
    synthesizers: [
      {
        venue: 'olive',
        maxTenorMs: c.oliveMaxTenorMs ?? c.matchConfig.oliveMaxTenorMs ?? 365 * 86_400_000,
        quote: (strike, expiryTs, kind) => {
          const r = amm.get(ammKey(strike, expiryTs, kind));
          if (!r) throw new Error(`unrecorded AMM call ${ammKey(strike, expiryTs, kind)}`);
          return r;
        },
      },
    ],
    config: { expiryToleranceMs: c.matchConfig.expiryToleranceMs, maxStrikeRelDist: c.matchConfig.maxStrikeRelDist },
  });
  return { rows, signals: computeSignals(rows, c.signalConfig, c.now, c.spots) };
}

describe('golden Olive × Derive cycle', () => {
  for (const c of golden.cases) {
    it(`${c.underlying}: reproduces every row and signal`, () => {
      const { rows, signals } = replay(c);
      expect(rows.map(toLegacyRow)).toEqual(c.rows);
      expect(signals).toEqual(c.signals);
    });
  }
});
