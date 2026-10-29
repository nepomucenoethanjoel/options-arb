import { VENUE_SPECS, type MatchRow, type Venue } from '@options-arb/shared';

/** A point must sit this many vol points off its neighbours' line... */
export const SMILE_OUTLIER_MIN_VOLS = 5;
/** ...and dominate locally: this many times either neighbour's own deviation (a single bad
 *  strike inflates its neighbours' deviations too; smooth curvature makes them all similar). */
export const SMILE_OUTLIER_LOCAL_MULT = 1.5;
/** Total variance may fall this much (relative) between expiries before it counts as inverted. */
export const CALENDAR_TOLERANCE = 0.02;
/** Expiries closer than this are skipped: last-day IVs are dominated by tick size and pin noise. */
export const SURFACE_MIN_TTE_MS = 86_400_000;

interface Point {
  pairKey: string;
  venue: Venue;
  strike: number;
  expiryTs: number;
  iv: number;
}

/**
 * Informational surface checks on each venue's OWN quoted IVs (one
 * underlying's rows), returned as flags per (pairKey, venue):
 *  - smile_outlier: a strike's IV is far off the line through its two
 *    neighbours on the same venue/expiry/kind — a venue mispricing one
 *    strike against its own smile (a manual strike-spread idea).
 *  - calendar_inversion: total variance (σ²·T) at the same venue, strike and
 *    kind FALLS from an earlier expiry to this one beyond tolerance — a
 *    calendar dislocation on that venue (strike-based: ignores forward drift,
 *    hence the tolerance).
 * AMM legs and expiries under a day out are skipped (Olive quotes one model
 * vol, no smile; last-day IVs are noise). Never
 * headline-relevant: these flags are not in HEADLINE_BLOCKING_FLAGS.
 */
export function surfaceFlags(rows: MatchRow[], now: number): Map<string, Map<Venue, string[]>> {
  const out = new Map<string, Map<Venue, string[]>>();
  const add = (p: Point, flag: string) => {
    const byVenue = out.get(p.pairKey) ?? new Map<Venue, string[]>();
    byVenue.set(p.venue, [...(byVenue.get(p.venue) ?? []), flag]);
    out.set(p.pairKey, byVenue);
  };

  const groups = new Map<string, Point[]>();
  for (const r of rows) {
    for (const [v, leg] of Object.entries(r.legs) as Array<[Venue, NonNullable<MatchRow['legs'][Venue]>]>) {
      const iv = leg.quote?.iv;
      if (iv == null || !(iv > 0) || VENUE_SPECS[v].quoteKind === 'amm_synthetic' || (leg.strikeOffset ?? 0) !== 0) continue;
      if (r.expiryTs - now < SURFACE_MIN_TTE_MS) continue;
      const k = `${v}|${r.kind}`;
      const list = groups.get(k) ?? [];
      list.push({ pairKey: r.pairKey, venue: v, strike: r.strike, expiryTs: r.expiryTs, iv });
      groups.set(k, list);
    }
  }

  for (const points of groups.values()) {
    // Smile: per expiry, sorted by strike.
    const byExpiry = new Map<number, Point[]>();
    for (const p of points) byExpiry.set(p.expiryTs, [...(byExpiry.get(p.expiryTs) ?? []), p]);
    for (const slice of byExpiry.values()) {
      slice.sort((a, b) => a.strike - b.strike);
      if (slice.length < 3) continue;
      const dev: Array<{ p: Point; d: number }> = [];
      for (let i = 1; i < slice.length - 1; i++) {
        const [a, p, b] = [slice[i - 1]!, slice[i]!, slice[i + 1]!];
        const line = a.iv + ((b.iv - a.iv) * (p.strike - a.strike)) / (b.strike - a.strike);
        dev.push({ p, d: Math.abs(p.iv - line) * 100 });
      }
      dev.forEach(({ p, d }, i) => {
        const neighbours = [dev[i - 1]?.d ?? 0, dev[i + 1]?.d ?? 0];
        if (d >= SMILE_OUTLIER_MIN_VOLS && neighbours.every((n) => d >= SMILE_OUTLIER_LOCAL_MULT * n)) add(p, 'smile_outlier');
      });
    }
    // Calendar: per strike, sorted by expiry.
    const byStrike = new Map<number, Point[]>();
    for (const p of points) byStrike.set(p.strike, [...(byStrike.get(p.strike) ?? []), p]);
    for (const line of byStrike.values()) {
      line.sort((a, b) => a.expiryTs - b.expiryTs);
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1]!, line[i]!];
        const tA = (a.expiryTs - now) / (365 * 86_400_000);
        const tB = (b.expiryTs - now) / (365 * 86_400_000);
        if (!(tA > 0) || !(tB > tA)) continue;
        if (b.iv * b.iv * tB < a.iv * a.iv * tA * (1 - CALENDAR_TOLERANCE)) add(b, 'calendar_inversion');
      }
    }
  }
  return out;
}
