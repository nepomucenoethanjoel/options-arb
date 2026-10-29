import { NON_EXECUTABLE_FLAGS, VENUE_SPECS, type MatchRow, type Venue } from '@options-arb/shared';
import type { VenueFeeModel } from './fees';

const positive = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) && v > 0 ? v : null);

/**
 * One venue's price for ONE contract after its per-contract fees (per-order
 * fees are clip-level and excluded): ask + fee to buy, bid − fee to sell.
 * AMM legs buy at their synthesized mark. Null when not tradable now: stale
 * quote, inside the venue's trading cutoff, a missing side, or (sell) a
 * venue where users cannot short. Quote flags are passed through for
 * badging, not filtered on.
 */
export function effectivePrices(
  row: MatchRow,
  venue: Venue,
  ctx: { fees: Partial<Record<Venue, VenueFeeModel>>; spot: number | null; now: number; staleQuoteMs: number },
): { buyEff: number | null; sellEff: number | null; flags: string[] } {
  const q = row.legs[venue]?.quote;
  const fee = ctx.fees[venue];
  const none = { buyEff: null, sellEff: null, flags: [] };
  if (!q || !fee) return none;
  const spec = VENUE_SPECS[venue];
  const amm = spec.quoteKind === 'amm_synthetic';
  if (!amm && q.ts < ctx.now - ctx.staleQuoteMs) return none;
  if (row.expiryTs - ctx.now < spec.tradingCutoffMs) return none;
  const feeCtx = { notional: ctx.spot ?? row.strike, underlying: row.underlying, kind: row.kind, strike: row.strike, tteDays: (row.expiryTs - ctx.now) / 86_400_000 };
  const ask = amm ? positive(q.mark) : positive(q.ask);
  const bid = amm || !spec.canSell(row.underlying) ? null : positive(q.bid);
  return {
    buyEff: ask != null ? ask + fee.perContract({ ...feeCtx, legPrice: ask, side: 'buy' }) : null,
    sellEff: bid != null ? bid - fee.perContract({ ...feeCtx, legPrice: bid, side: 'sell' }) : null,
    flags: (q.flags ?? []).filter((f) => !NON_EXECUTABLE_FLAGS.has(f)),
  };
}
