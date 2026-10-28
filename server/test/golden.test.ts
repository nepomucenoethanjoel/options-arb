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
  matchConfig: MatchConfig;
  signalConfig: SignalConfig;
  spots: Record<string, number | null>;
  rows: MatchRow[];
  signals: Signal[];
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
    deriveInstruments: c.deriveInstruments,
    deriveQuotes: new Map(c.deriveQuotes.map((q) => [q.instrumentId, q])),
    oliveQuoteProvider: (strike, expiryTs, kind) => {
      const r = amm.get(ammKey(strike, expiryTs, kind));
      if (!r) throw new Error(`unrecorded AMM call ${ammKey(strike, expiryTs, kind)}`);
      return r;
    },
    config: c.matchConfig,
  });
  return { rows, signals: computeSignals(rows, c.signalConfig, c.now, c.spots) };
}

describe('golden Olive × Derive cycle', () => {
  for (const c of golden.cases) {
    it(`${c.underlying}: reproduces every row and signal`, () => {
      const { rows, signals } = replay(c);
      expect(rows).toEqual(c.rows);
      expect(signals).toEqual(c.signals);
    });
  }
});
