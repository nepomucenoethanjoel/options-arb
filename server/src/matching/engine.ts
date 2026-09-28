import type { MatchRow, MatchType, OptionInstrument, OptionQuote } from '@options-arb/shared';
import type { AmmQuoteResult } from '../adapters/olive';

export interface MatchConfig {
  /** Max |expiryTs difference| between venues to consider the same tenor. */
  expiryToleranceMs: number;
  /** Max relative strike distance for a nearest-strike match. */
  maxStrikeRelDist: number;
  /** Olive AMM max tenor (docs: 365 days). */
  oliveMaxTenorMs: number;
}

export type OliveQuoteProvider = (
  strike: number,
  expiryTs: number,
  kind: 'call' | 'put',
) => AmmQuoteResult;

export interface MatchInput {
  now: number;
  underlying: string;
  deriveInstruments: OptionInstrument[];
  deriveQuotes: Map<string, OptionQuote>;
  /** Active Olive listings, if a discrete chain is discovered later. */
  oliveInstruments?: OptionInstrument[];
  oliveQuotes?: Map<string, OptionQuote>;
  oliveQuoteProvider?: OliveQuoteProvider;
  config: MatchConfig;
}

export function pairKeyOf(
  underlying: string,
  expiryDate: string,
  strike: number,
  kind: 'call' | 'put',
): string {
  return `${underlying}-${expiryDate}-${strike}-${kind === 'call' ? 'C' : 'P'}`;
}

function expiryOffsetDays(a: number, b: number): number {
  return Math.round((a - b) / 86_400_000);
}

/**
 * Build comparison rows for one underlying. Derive's chain drives the grid;
 * each row pairs it with the best Olive counterpart:
 *  1. exact strike within expiry tolerance → exact_match (listed)
 *  2. nearest strike within maxStrikeRelDist → interpolated (Olive vol is
 *     strike-independent today, so interpolation is exact in practice)
 *  3. AMM synthetic quote at Derive's (K, T) → exact_match, note amm_synthetic
 *  4. otherwise unmatched_no_counterpart with a machine-readable reason
 * Olive-only listings with no Derive counterpart become unmatched rows too.
 */
export function matchChain(input: MatchInput): MatchRow[] {
  const { now, underlying, config } = input;
  const rows: MatchRow[] = [];
  const matchedOliveIds = new Set<string>();
  const oliveList = (input.oliveInstruments ?? []).filter((o) => o.underlying === underlying);

  const deriveRows = input.deriveInstruments.filter((d) => d.underlying === underlying && d.expiryTs > now);

  for (const d of deriveRows) {
    const deriveLeg = {
      venue: 'derive' as const,
      instrumentId: d.instrumentId,
      quote: input.deriveQuotes.get(d.instrumentId) ?? null,
    };

    let matchType: MatchType = 'unmatched_no_counterpart';
    let reason: string | undefined;
    let note: string | undefined;
    let oliveLeg: MatchRow['olive'] = { venue: 'olive', instrumentId: null, quote: null };

    const sameKindAndTenor = oliveList.filter(
      (o) => o.kind === d.kind && Math.abs(o.expiryTs - d.expiryTs) <= config.expiryToleranceMs,
    );
    const exact = sameKindAndTenor.find((o) => o.strike === d.strike);
    const offDays = exact ? expiryOffsetDays(exact.expiryTs, d.expiryTs) : 0;

    if (exact) {
      matchedOliveIds.add(exact.instrumentId);
      matchType = 'exact_match';
      note = 'listed' + (offDays !== 0 ? `,expiry_off_${offDays}d` : '');
      oliveLeg = {
        venue: 'olive',
        instrumentId: exact.instrumentId,
        quote: input.oliveQuotes?.get(exact.instrumentId) ?? null,
        expiryOffsetDays: offDays || undefined,
      };
    } else {
      let nearest: OptionInstrument | null = null;
      let nearestDist = Infinity;
      for (const o of sameKindAndTenor) {
        const dist = Math.abs(o.strike - d.strike);
        if (dist < nearestDist) {
          nearest = o;
          nearestDist = dist;
        }
      }
      if (nearest && nearestDist <= config.maxStrikeRelDist * d.strike) {
        matchedOliveIds.add(nearest.instrumentId);
        matchType = 'interpolated';
        note = `nearest_strike_${nearest.strike}`;
        const nOff = expiryOffsetDays(nearest.expiryTs, d.expiryTs);
        if (nOff !== 0) note += `,expiry_off_${nOff}d`;
        oliveLeg = {
          venue: 'olive',
          instrumentId: nearest.instrumentId,
          quote: input.oliveQuotes?.get(nearest.instrumentId) ?? null,
          strikeOffset: nearest.strike - d.strike,
          expiryOffsetDays: nOff || undefined,
        };
      } else if (input.oliveQuoteProvider) {
        if (d.expiryTs - now > config.oliveMaxTenorMs) {
          reason = 'beyond_olive_max_tenor';
        } else {
          const result = input.oliveQuoteProvider(d.strike, d.expiryTs, d.kind);
          if ('quote' in result) {
            matchType = 'exact_match';
            note = 'amm_synthetic';
            oliveLeg = { venue: 'olive', instrumentId: result.quote.instrumentId, quote: result.quote };
          } else {
            reason = result.rejected;
          }
        }
      } else {
        reason = 'no_olive_data';
      }
    }

    rows.push({
      pairKey: pairKeyOf(underlying, d.expiryDate, d.strike, d.kind),
      underlying,
      expiryTs: d.expiryTs,
      expiryDate: d.expiryDate,
      strike: d.strike,
      kind: d.kind,
      matchType,
      unmatchedReason: reason,
      derive: deriveLeg,
      olive: { ...oliveLeg, note },
    });
  }

  for (const o of oliveList) {
    if (matchedOliveIds.has(o.instrumentId)) continue;
    if (o.expiryTs <= now) continue;
    rows.push({
      pairKey: pairKeyOf(underlying, o.expiryDate, o.strike, o.kind),
      underlying,
      expiryTs: o.expiryTs,
      expiryDate: o.expiryDate,
      strike: o.strike,
      kind: o.kind,
      matchType: 'unmatched_no_counterpart',
      unmatchedReason: 'no_derive_listing',
      derive: { venue: 'derive', instrumentId: null, quote: null },
      olive: {
        venue: 'olive',
        instrumentId: o.instrumentId,
        quote: input.oliveQuotes?.get(o.instrumentId) ?? null,
      },
    });
  }

  return rows;
}
