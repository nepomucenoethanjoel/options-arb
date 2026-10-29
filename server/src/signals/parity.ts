import { NON_EXECUTABLE_FLAGS, VENUE_ORDER, VENUE_SPECS, type FutureQuote, type MatchRow, type ParitySignal, type Venue } from '@options-arb/shared';
import { effectivePrices } from './bestVenue';
import type { VenueFeeModel } from './fees';

/** Deribit futures taker fee, fraction of notional — taker_commission 0.00035 on every
 *  BTC/ETH future (get_instruments, live 2026-10-29; DATA_SOURCES row 49). */
export const DERIBIT_FUTURE_TAKER = 0.00035;
/** Futures delivery fee assumed at expiry (published schedule, not API-verifiable; row 49). */
export const DERIBIT_FUTURE_DELIVERY = 0.00025;

export interface ParityContext {
  fees: Partial<Record<Venue, VenueFeeModel>>;
  spot: number | null;
  now: number;
  staleQuoteMs: number;
  capitalBorrowRateApr: number;
  nearExpiryDays: number;
}

interface Side {
  venue: Venue;
  price: number;
  size: number | null;
  flags: string[];
}

/** Cheapest effective buy / richest effective sell for one contract row. */
function bestSides(row: MatchRow, ctx: ParityContext): { buy: Side | null; sell: Side | null } {
  let buy: Side | null = null;
  let sell: Side | null = null;
  for (const v of VENUE_ORDER) {
    const q = row.legs[v]?.quote;
    if (!q || (row.legs[v]?.strikeOffset ?? 0) !== 0) continue;
    const eff = effectivePrices(row, v, ctx);
    if (eff.buyEff != null && (buy == null || eff.buyEff < buy.price)) buy = { venue: v, price: eff.buyEff, size: q.askSize ?? null, flags: eff.flags };
    if (eff.sellEff != null && (sell == null || eff.sellEff > sell.price)) sell = { venue: v, price: eff.sellEff, size: q.bidSize ?? null, flags: eff.flags };
  }
  return { buy, sell };
}

const minSize = (a: number | null, b: number | null): number | null => (a == null || b == null ? null : Math.min(a, b));

/**
 * Conversions and reversals across venues for one underlying's rows, hedged
 * with the dated future that expires at the same instant:
 *   conversion: buy call (A) + sell put (B) + sell future → payoff F − K
 *     net = (F_bid,eff − K) − (C_buy − P_sell) − drag
 *   reversal:   sell call (A) + buy put (B) + buy future → payoff K − F
 *     net = (K − F_ask,eff) + (C_sell − P_buy) − drag
 * Option prices are per-contract after fees (effectivePrices); the future
 * pays taker + delivery. Drag = the short option's collateral (put: K, call:
 * spot — conservative, as the pair engine) plus any net premium paid, at the
 * capital rate to expiry. Every row carries reference_venue (the hedge is on
 * Deribit) and hedge_size_unverified (future sizes are not read), so parity
 * is informational — never headline. AMM legs add fill_model_skipped (their
 * own price impact is not priced here), which keeps them out of episodes.
 */
export function computeParity(rows: MatchRow[], futures: FutureQuote[], ctx: ParityContext): ParitySignal[] {
  const futureByExpiry = new Map(futures.map((f) => [f.expiryTs, f]));
  const byContract = new Map<string, { call?: MatchRow; put?: MatchRow }>();
  for (const r of rows) {
    const k = `${r.expiryTs}|${r.strike}`;
    const e = byContract.get(k) ?? {};
    e[r.kind] = r;
    byContract.set(k, e);
  }
  const out: ParitySignal[] = [];
  for (const { call, put } of byContract.values()) {
    if (!call || !put) continue;
    const fut = futureByExpiry.get(call.expiryTs);
    if (!fut || fut.ts < ctx.now - ctx.staleQuoteMs) continue;
    const tau = (call.expiryTs - ctx.now) / (365 * 86_400_000);
    if (!(tau > 0)) continue;
    const K = call.strike;
    const spot = ctx.spot ?? fut.indexPrice ?? K;
    const c = bestSides(call, ctx);
    const p = bestSides(put, ctx);
    const baseFlags = ['reference_venue', 'hedge_size_unverified'];
    if (tau * 365 < ctx.nearExpiryDays) baseFlags.push('near_expiry');
    const emit = (strategy: ParitySignal['strategy'], cs: Side, ps: Side, futPrice: number, locked: number, premium: number, collateral: number) => {
      const capital = (collateral + Math.max(0, -premium)) * ctx.capitalBorrowRateApr * tau;
      const net = locked + premium - capital;
      const size = minSize(cs.size, ps.size);
      const legVenues = new Set([cs.venue, ps.venue]);
      const flags = [...new Set([...baseFlags, ...cs.flags, ...ps.flags])].filter((f) => !NON_EXECUTABLE_FLAGS.has(f));
      // Option legs settle on their venues' indexes, the hedge on Deribit's.
      if ([...legVenues].some((v) => v !== fut.venue)) flags.push('settlement_basis');
      // An AMM leg here trades at its first-unit quote; its own fill impact is
      // not priced in this module (headline-blocking flag, as in the pair engine).
      if ([...legVenues].some((v) => VENUE_SPECS[v].quoteKind === 'amm_synthetic')) flags.push('fill_model_skipped');
      out.push({
        key: `${call.underlying}-${call.expiryDate}-${K}-${strategy}`,
        underlying: call.underlying,
        expiryTs: call.expiryTs,
        expiryDate: call.expiryDate,
        strike: K,
        strategy,
        callVenue: cs.venue,
        callPriceUsdc: round(cs.price),
        putVenue: ps.venue,
        putPriceUsdc: round(ps.price),
        futureVenue: fut.venue,
        futureId: fut.instrumentId,
        futurePriceUsdc: round(futPrice),
        netPerUnitUsdc: round(net),
        capitalCostUsdc: round(capital),
        size,
        totalNetUsdc: size != null && size > 0 ? round(net * size) : null,
        flags,
        ts: ctx.now,
      });
    };
    const futFee = (price: number) => price * (DERIBIT_FUTURE_TAKER + DERIBIT_FUTURE_DELIVERY);
    if (c.buy && p.sell && fut.bid != null) {
      const fBid = fut.bid - futFee(fut.bid);
      emit('conversion', c.buy, p.sell, fBid, fBid - K, p.sell.price - c.buy.price, K);
    }
    if (c.sell && p.buy && fut.ask != null) {
      const fAsk = fut.ask + futFee(fut.ask);
      emit('reversal', c.sell, p.buy, fAsk, K - fAsk, c.sell.price - p.buy.price, spot);
    }
  }
  return out.sort((a, b) => b.netPerUnitUsdc - a.netPerUnitUsdc);
}

const round = (v: number): number => Math.round(v * 1e4) / 1e4;
