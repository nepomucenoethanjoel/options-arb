import { VENUE_ORDER } from './venueSpecs';
import type { BestVenueQuote, LiteQuote, Venue } from './types';

/**
 * Where to buy and where to sell one contract, among `allowed` venues (all
 * when omitted): lowest buyEff and highest sellEff. The effective prices are
 * computed server-side (fees live there); this pick is shared so the
 * dashboard's venue filter re-picks exactly as the server would.
 */
export function pickBestVenues(
  venues: Partial<Record<Venue, LiteQuote>>,
  allowed?: ReadonlySet<Venue>,
): { bestBuy: BestVenueQuote | null; bestSell: BestVenueQuote | null } {
  let bestBuy: BestVenueQuote | null = null;
  let bestSell: BestVenueQuote | null = null;
  for (const v of VENUE_ORDER) {
    const q = venues[v];
    if (!q || (allowed && !allowed.has(v))) continue;
    const flags = q.flags ?? [];
    if (q.buyEff != null && (bestBuy == null || q.buyEff < bestBuy.effectivePrice)) {
      bestBuy = { venue: v, price: q.ask ?? q.mark ?? q.buyEff, effectivePrice: q.buyEff, iv: q.iv, size: q.askSize ?? null, flags };
    }
    if (q.sellEff != null && (bestSell == null || q.sellEff > bestSell.effectivePrice)) {
      bestSell = { venue: v, price: q.bid ?? q.sellEff, effectivePrice: q.sellEff, iv: q.iv, size: q.bidSize ?? null, flags };
    }
  }
  return { bestBuy, bestSell };
}
