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
  /** Legacy signal shape (direction enum) — compared via toLegacySignal. */
  signals: Array<Record<string, unknown>>;
}

/** Fields added after the recording (additive): compared by their own test below, not against the golden file. */
const POST_RECORDING_FIELDS = ['bestClipSize', 'bestClipExpectedTotalUsdc', 'maxProfitableSize'] as const;

/** Project a venue-keyed row onto the recorded two-leg shape. */
function toLegacyRow(r: MatchRow): Record<string, unknown> {
  const { legs, ...rest } = r;
  return {
    ...rest,
    derive: legs.derive ?? { venue: 'derive', instrumentId: null, quote: null },
    olive: legs.olive ?? { venue: 'olive', instrumentId: null, quote: null },
  };
}

/** The recorded two-venue direction from the venue pair. */
function toLegacySignal(s: Signal): Record<string, unknown> {
  const { buyVenue, sellVenue, alternatives: _alt, ...rest } = s as Signal & Record<string, unknown>;
  for (const k of POST_RECORDING_FIELDS) delete rest[k];
  const direction =
    buyVenue === 'olive' && sellVenue === 'derive' ? 'buy_olive_sell_derive' : buyVenue === 'derive' && sellVenue === 'olive' ? 'buy_derive_sell_olive' : null;
  return { ...rest, direction };
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
      expect(signals.map(toLegacySignal)).toEqual(c.signals);
    });
  }

  it('best Olive clip: never worse than the full clip, within the cap, only on fill-priced rows', () => {
    let searched = 0;
    for (const c of golden.cases) {
      for (const s of replay(c).signals) {
        if (s.bestClipSize == null) continue;
        searched++;
        expect(s.buyVenue).toBe('olive');
        expect(s.expectedTotalNetUsdc).not.toBeNull();
        expect(s.bestClipSize).toBeGreaterThan(0);
        expect(s.bestClipSize).toBeLessThanOrEqual(s.maxExecutableSize! + 1e-9);
        expect(s.bestClipExpectedTotalUsdc!).toBeGreaterThanOrEqual(s.expectedTotalNetUsdc! - 0.01);
        if (s.maxProfitableSize != null) expect(s.maxProfitableSize).toBeLessThanOrEqual(s.maxExecutableSize! + 1e-9);
      }
    }
    expect(searched).toBeGreaterThan(0);
  });
});
