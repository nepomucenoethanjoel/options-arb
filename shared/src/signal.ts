import type { Signal } from './types';

/** Flags that make a row's quoted prices untradeable as shown. */
export const NON_EXECUTABLE_FLAGS: ReadonlySet<string> = new Set([
  'no_book', 'one_sided', 'thin_book', 'wide_book', 'stale', 'mismatched_legs', 'trading_cutoff',
]);

/** Flags that keep a row out of headline totals/counts (still shown in the table). */
export const HEADLINE_BLOCKING_FLAGS: ReadonlySet<string> = new Set([
  ...NON_EXECUTABLE_FLAGS, 'price_distortion', 'fill_model_skipped',
  // Unproven fillability: lifted per venue only with live-fill evidence.
  'single_maker', 'indicative_quote',
  // A venue the user cannot trade (Deribit): shown for reference, never headline.
  'reference_venue',
]);

type ClipFields = Pick<Signal, 'totalNetUsdc' | 'expectedTotalNetUsdc' | 'maxExecutableSize'> &
  Partial<Pick<Signal, 'bestClipSize' | 'bestClipExpectedTotalUsdc'>>;

/**
 * The clip total a fill would actually net: when the marginal-fill model
 * priced the clip's own rate impact, the lower of quote and expected —
 * fills can only hurt the buyer of the cheap leg. When the fill model found
 * a better (smaller) clip, that clip's expected total: it is the same
 * model at a smaller size, and never above the quoted full-clip total
 * (per-contract net only falls with size).
 */
export function honestTotalNetUsdc(s: Partial<ClipFields> & Pick<Signal, 'totalNetUsdc' | 'expectedTotalNetUsdc'>): number | null {
  if (s.bestClipExpectedTotalUsdc != null && s.bestClipSize != null && s.expectedTotalNetUsdc != null) {
    return Math.min(s.totalNetUsdc ?? s.bestClipExpectedTotalUsdc, Math.max(s.expectedTotalNetUsdc, s.bestClipExpectedTotalUsdc));
  }
  if (s.expectedTotalNetUsdc != null) return Math.min(s.totalNetUsdc ?? s.expectedTotalNetUsdc, s.expectedTotalNetUsdc);
  return s.totalNetUsdc;
}

/** The clip size honestTotalNetUsdc refers to. */
export function honestClipSize(s: Partial<ClipFields>): number | null {
  if (s.bestClipExpectedTotalUsdc != null && s.bestClipSize != null && s.expectedTotalNetUsdc != null && s.bestClipExpectedTotalUsdc > s.expectedTotalNetUsdc) {
    return s.bestClipSize;
  }
  return s.maxExecutableSize ?? null;
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
