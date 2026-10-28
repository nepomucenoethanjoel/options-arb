import type { LegSnapshot, MatchRow, MatchType, OptionInstrument, OptionQuote, Venue } from '@options-arb/shared';
import type { AmmQuoteResult } from '../adapters/olive';

export interface MatchConfig {
  /** Max |expiryTs difference| for a non-anchor LISTED instrument to count as the same tenor. */
  expiryToleranceMs: number;
  /** Max relative strike distance for a non-anchor nearest-strike match. */
  maxStrikeRelDist: number;
}

/** A venue's listed chain for one underlying. */
export interface ListedChain {
  venue: Venue;
  instruments: OptionInstrument[];
  quotes: Map<string, OptionQuote>;
  /** Anchor chains define the contract grid (exact expiry + strike). A
   *  non-anchor chain is matched onto that grid with expiry tolerance and
   *  nearest-strike fallback. Default true. */
  anchor?: boolean;
}

/** A venue that quotes any (K, T) on demand instead of listing (Olive AMM). */
export interface QuoteSynthesizer {
  venue: Venue;
  maxTenorMs: number;
  quote(strike: number, expiryTs: number, kind: 'call' | 'put'): AmmQuoteResult;
}

export interface MatchInput {
  now: number;
  underlying: string;
  chains: ListedChain[];
  synthesizers?: QuoteSynthesizer[];
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

interface GridPoint {
  pairKey: string;
  expiryTs: number;
  expiryDate: string;
  strike: number;
  kind: 'call' | 'put';
  legs: Partial<Record<Venue, LegSnapshot>>;
}

/**
 * Build comparison rows for one underlying.
 *
 * The grid is the union of every anchor chain's live contracts, keyed by
 * pairKey (all anchor venues expire 08:00 UTC, so the same contract matches
 * exactly). Each non-anchor venue then fills its leg per grid point:
 *  1. exact listed strike within expiry tolerance → leg note `listed`
 *  2. nearest listed strike within maxStrikeRelDist → interpolated (offsets
 *     recorded — not the same payoff; signals null the profit)
 *  3. its synthesizer at the grid's exact (K, T) → note `amm_synthetic`
 *  4. otherwise no leg, with a machine-readable reason
 * A row with ≥2 legs is matched; fewer is unmatched_no_counterpart.
 * Non-anchor listings with no grid point become unmatched rows too.
 */
export function matchChain(input: MatchInput): MatchRow[] {
  const { now, underlying, config } = input;
  const grid = new Map<string, GridPoint>();

  const anchors = input.chains.filter((c) => c.anchor !== false);
  for (const chain of anchors) {
    for (const inst of chain.instruments) {
      if (inst.underlying !== underlying || inst.expiryTs <= now) continue;
      const key = pairKeyOf(underlying, inst.expiryDate, inst.strike, inst.kind);
      let point = grid.get(key);
      if (!point) {
        point = { pairKey: key, expiryTs: inst.expiryTs, expiryDate: inst.expiryDate, strike: inst.strike, kind: inst.kind, legs: {} };
        grid.set(key, point);
      }
      point.legs[chain.venue] = {
        venue: chain.venue,
        instrumentId: inst.instrumentId,
        quote: chain.quotes.get(inst.instrumentId) ?? null,
      };
    }
  }

  // Non-anchor venues, in a stable order: listed chains and/or synthesizers.
  const secondaryVenues: Venue[] = [];
  for (const c of input.chains) if (c.anchor === false && !secondaryVenues.includes(c.venue)) secondaryVenues.push(c.venue);
  for (const s of input.synthesizers ?? []) if (!secondaryVenues.includes(s.venue)) secondaryVenues.push(s.venue);

  const rows: MatchRow[] = [];
  const matchedSecondaryIds = new Set<string>();
  for (const point of grid.values()) {
    let reason: string | undefined;
    for (const venue of secondaryVenues) {
      const chain = input.chains.find((c) => c.anchor === false && c.venue === venue);
      const synth = input.synthesizers?.find((s) => s.venue === venue);
      const listed = (chain?.instruments ?? []).filter((o) => o.underlying === underlying);
      const sameKindAndTenor = listed.filter(
        (o) => o.kind === point.kind && Math.abs(o.expiryTs - point.expiryTs) <= config.expiryToleranceMs,
      );
      const exact = sameKindAndTenor.find((o) => o.strike === point.strike);
      if (exact) {
        matchedSecondaryIds.add(exact.instrumentId);
        const offDays = expiryOffsetDays(exact.expiryTs, point.expiryTs);
        point.legs[venue] = {
          venue,
          instrumentId: exact.instrumentId,
          quote: chain?.quotes.get(exact.instrumentId) ?? null,
          expiryOffsetDays: offDays || undefined,
          note: 'listed' + (offDays !== 0 ? `,expiry_off_${offDays}d` : ''),
        };
        continue;
      }
      let nearest: OptionInstrument | null = null;
      let nearestDist = Infinity;
      for (const o of sameKindAndTenor) {
        const dist = Math.abs(o.strike - point.strike);
        if (dist < nearestDist) {
          nearest = o;
          nearestDist = dist;
        }
      }
      if (nearest && nearestDist <= config.maxStrikeRelDist * point.strike) {
        matchedSecondaryIds.add(nearest.instrumentId);
        const nOff = expiryOffsetDays(nearest.expiryTs, point.expiryTs);
        let note = `nearest_strike_${nearest.strike}`;
        if (nOff !== 0) note += `,expiry_off_${nOff}d`;
        point.legs[venue] = {
          venue,
          instrumentId: nearest.instrumentId,
          quote: chain?.quotes.get(nearest.instrumentId) ?? null,
          strikeOffset: nearest.strike - point.strike,
          expiryOffsetDays: nOff || undefined,
          note,
        };
        continue;
      }
      if (!synth) {
        reason ??= `no_${venue}_data`;
        continue;
      }
      if (point.expiryTs - now > synth.maxTenorMs) {
        reason ??= `beyond_${venue}_max_tenor`;
        continue;
      }
      const result = synth.quote(point.strike, point.expiryTs, point.kind);
      if ('quote' in result) {
        point.legs[venue] = { venue, instrumentId: result.quote.instrumentId, quote: result.quote, note: 'amm_synthetic' };
      } else {
        reason ??= result.rejected;
      }
    }

    const legs = Object.values(point.legs);
    let matchType: MatchType = 'unmatched_no_counterpart';
    if (legs.length >= 2) matchType = legs.some((l) => l?.strikeOffset) ? 'interpolated' : 'exact_match';
    rows.push({
      pairKey: point.pairKey,
      underlying,
      expiryTs: point.expiryTs,
      expiryDate: point.expiryDate,
      strike: point.strike,
      kind: point.kind,
      matchType,
      unmatchedReason: matchType === 'unmatched_no_counterpart' ? (reason ?? 'no_counterpart') : undefined,
      legs: point.legs,
    });
  }

  for (const chain of input.chains) {
    if (chain.anchor !== false) continue;
    for (const o of chain.instruments) {
      if (o.underlying !== underlying || matchedSecondaryIds.has(o.instrumentId) || o.expiryTs <= now) continue;
      rows.push({
        pairKey: pairKeyOf(underlying, o.expiryDate, o.strike, o.kind),
        underlying,
        expiryTs: o.expiryTs,
        expiryDate: o.expiryDate,
        strike: o.strike,
        kind: o.kind,
        matchType: 'unmatched_no_counterpart',
        unmatchedReason: 'no_anchor_listing',
        legs: {
          [chain.venue]: { venue: chain.venue, instrumentId: o.instrumentId, quote: chain.quotes.get(o.instrumentId) ?? null },
        },
      });
    }
  }

  return rows;
}
