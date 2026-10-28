import type { Signal } from './types';

/** Flags that make a row's quoted prices untradeable as shown. */
export const NON_EXECUTABLE_FLAGS: ReadonlySet<string> = new Set([
  'no_book', 'one_sided', 'thin_book', 'wide_book', 'stale', 'mismatched_legs', 'trading_cutoff',
]);

/** Flags that keep a row out of headline totals/counts (still shown in the table). */
export const HEADLINE_BLOCKING_FLAGS: ReadonlySet<string> = new Set([
  ...NON_EXECUTABLE_FLAGS, 'price_distortion', 'fill_model_skipped',
]);

/**
 * The clip total a fill would actually net: when the marginal-fill model
 * priced the clip's own rate impact, the lower of quote and expected —
 * fills can only hurt the buyer of the cheap leg.
 */
export function honestTotalNetUsdc(s: Pick<Signal, 'totalNetUsdc' | 'expectedTotalNetUsdc'>): number | null {
  if (s.expectedTotalNetUsdc != null) return Math.min(s.totalNetUsdc ?? s.expectedTotalNetUsdc, s.expectedTotalNetUsdc);
  return s.totalNetUsdc;
}

/** Both legs are user-executable: the sell venue lets users short (not an LP-only role). */
export function isTwoLegExecutable(s: Pick<Signal, 'buyVenue' | 'sellVenue' | 'flags'>): boolean {
  return s.buyVenue != null && s.sellVenue != null && !s.flags.includes('direction_limited');
}

/** Profitable at the honest clip total on a clean (headline-eligible) row. */
export function isHeadlineProfitable(s: Signal): boolean {
  const total = honestTotalNetUsdc(s);
  return (
    s.isProfitable &&
    s.netAfterCapitalUsdc != null &&
    total != null &&
    total > 0 &&
    !s.flags.some((f) => HEADLINE_BLOCKING_FLAGS.has(f))
  );
}
