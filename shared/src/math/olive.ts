import { bsPrice } from './bs';

/**
 * Olive strike bounds: σ-band around oracle spot — K_L = S·e^(−rS·τ − σ√τ),
 * K_U = S·e^(rL·τ + σ√τ) with n = m = 1 per their docs. Verified live
 * 2026-09-29: the UI refuses strikes outside exactly this ±1σ band
 * (ZEC rejection message implied 1.000σ; the earlier "2.5× spot" probe
 * conclusion was a cold-session artifact — see DATA_SOURCES.md).
 */
export function oliveStrikeBounds(
  spot: number,
  vol: number,
  tauYears: number,
  rates: { tokenApr: number; usdcApr: number },
  sigmas = 1,
): { lower: number; upper: number } {
  const rootT = Math.sqrt(Math.max(tauYears, 0));
  return {
    lower: spot * Math.exp(-rates.usdcApr * tauYears - sigmas * vol * rootT),
    upper: spot * Math.exp(rates.tokenApr * tauYears + sigmas * vol * rootT),
  };
}

/** One node of a custody's published borrowRateCurve. */
export interface OliveRateCurvePoint {
  utilizationBps: number;
  rateBps: number;
}

/**
 * Borrow rate (bps) at a utilization (bps) via piecewise-linear interpolation
 * over the curve nodes, clamped to the end rates outside the node range —
 * the same evaluation their pricer performs (verified 2026-09-28: SOL curve
 * at 20.8% util = 15.02% vs UI 15.04%; BTC USDC custody 88% util = 42.15%).
 */
export function curveRateBpsAt(points: OliveRateCurvePoint[], utilizationBps: number): number | null {
  if (points.length === 0) return null;
  const u = Math.min(10_000, Math.max(0, utilizationBps));
  if (u <= points[0]!.utilizationBps) return points[0]!.rateBps;
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i]!;
    if (u <= p1.utilizationBps) {
      const p0 = points[i - 1]!;
      return p0.rateBps + ((p1.rateBps - p0.rateBps) * (u - p0.utilizationBps)) / (p1.utilizationBps - p0.utilizationBps);
    }
  }
  return points[points.length - 1]!.rateBps;
}

/** Seconds in Olive's protocol year (U2d denominator). */
const PROTOCOL_YEAR_SECONDS = 365 * 86_400;

/**
 * One custody side's live fixed-rate exposure, from the market file's
 * `rawOnChainPoolSnapshot.poolAccount` (`fixedRateBetaBps`, `fixedRateStates[0]`
 * token side / `[1]` USDC side), in the custody's display units (tokens, or USD).
 */
export interface OliveFixedRateSide {
  betaBps: number;
  /** `liveExposureNative` / 10^decimals. */
  exposure: number;
  /** `timeValueNative` / 10^decimals — exposure × seconds to its expiries. */
  timeValue: number;
}

/**
 * Fixed-rate premium (bps) on top of the variable curve, docs
 * liquidity/interest-rates "Fixed Rates and 2D Utilization":
 *   premium = round_half_up(β·U2d·t / (10000·(t+τ))),
 *   U2d = timeValue / (owned·365 d) (bps, floored), τ = timeValue / exposure (s, floored),
 * evaluated with `extra` more units locked that retire at the order's expiry
 * (t seconds out). τ = 0 saturates to β·U2d. Verified live 2026-11-15:
 * SOL r(0) at 30 d = 9684 + 138 bp (state-history fixedRateLongBps 9822).
 */
export function fixedRatePremiumBps(side: OliveFixedRateSide, owned: number, tSeconds: number, extra = 0): number {
  if (!(owned > 0) || !(tSeconds > 0) || !(side.betaBps > 0)) return 0;
  const timeValue = side.timeValue + extra * tSeconds;
  const exposure = side.exposure + extra;
  const u2dBps = Math.floor((timeValue * 10_000) / (owned * PROTOCOL_YEAR_SECONDS));
  if (u2dBps <= 0) return 0;
  const tau = exposure > 0 ? Math.floor(timeValue / exposure) : 0;
  if (tau === 0) return Math.floor((side.betaBps * u2dBps) / 10_000 + 0.5);
  return Math.floor((side.betaBps * u2dBps * tSeconds) / (10_000 * (tSeconds + tau)) + 0.5);
}

/**
 * The pool's fixed-rate quote r(x) in bps with `extra` more locked: variable
 * curve + premium. On chain utilization and the variable rate are whole bps,
 * rounded down (docs interest-rates); the curve-only path keeps the
 * continuous curve.
 */
export function oliveFixedQuoteBps(
  curve: OliveRateCurvePoint[],
  fixedRate: OliveFixedRateSide | null,
  owned: number,
  locked: number,
  tSeconds: number,
  extra = 0,
): number {
  const utilBps = Math.floor(((locked + extra) / owned) * 10_000 + 1e-9);
  return (
    Math.floor((curveRateBpsAt(curve, utilBps) ?? 0) + 1e-9) +
    (fixedRate ? fixedRatePremiumBps(fixedRate, owned, tSeconds, extra) : 0)
  );
}

/**
 * The rate (bps) an Olive order pays: the pool's fixed-rate quote r(x)
 * (variable curve at (locked+x)/owned + fixed-rate premium) averaged over the
 * order's own lock [0, L] by Simpson's rule (weights 1-4-1), split at every
 * curve node the order crosses, floored at r(0) — docs "The Rate Your Order
 * Pays". Units of locked/owned/L must match (custody display units).
 * Verified live: 20/21 expiry-future fills since 2026-10-26 exact (a $241 SOL
 * long: r(0) 877 → 959 bp), 50/73 option fills exact with the option window
 * rule (see expectedFillVwap).
 */
export function oliveOrderRateBps(
  curve: OliveRateCurvePoint[],
  fixedRate: OliveFixedRateSide | null,
  owned: number,
  locked: number,
  tSeconds: number,
  lock: number,
): number | null {
  if (curve.length === 0 || !(owned > 0)) return null;
  const r = (x: number): number => oliveFixedQuoteBps(curve, fixedRate, owned, locked, tSeconds, x);
  const r0 = r(0);
  if (!(lock > 0)) return r0;
  // Breakpoints: interior curve nodes (the kink) strictly inside the lock window. Olive does not
  // split at the 100% end node: an option's oversized window can run past it (clamped rate) and the
  // last step's Simpson average keeps that shape (live 73-C fill: 8517 bp only without that split).
  const cuts = [0];
  for (const p of curve.slice(1, -1)) {
    const x = (p.utilizationBps / 10_000) * owned - locked;
    if (x > 0 && x < lock && x > cuts[cuts.length - 1]!) cuts.push(x);
  }
  cuts.push(lock);
  let weighted = 0;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]!, b = cuts[i]!;
    weighted += ((b - a) * (r(a) + 4 * r((a + b) / 2) + r(b))) / 6;
  }
  return Math.max(r0, Math.floor(weighted / lock + 0.5));
}

export interface MarginalFillInput {
  kind: 'call' | 'put';
  strike: number;
  spot: number;
  /** Olive model vol (fraction) — the AMM's σ. */
  vol: number;
  tauYears: number;
  /** Contracts the clip would fill. */
  size: number;
  /** Borrow curve of the custody the buys consume (calls: token, puts: USDC). */
  curve: OliveRateCurvePoint[];
  /** Custody state in the curve's own units. */
  free: number;
  owned: number;
  /** Collateral each unit locks into that custody (calls: 1 underlying, puts: K USDC). */
  perUnitLocked: number;
  /**
   * Live fixed-rate exposure of that custody side. When present the fill is
   * priced with Olive's exact order mechanics (oliveOrderRateBps incl. the
   * fixed-rate premium, one rate for the whole order, option window rule);
   * when absent, the original curve-only tranche integration.
   */
  fixedRate?: OliveFixedRateSide | null;
}

export interface MarginalFillResult {
  /** Premium at the CURRENT utilization — the quote the cycle priced at. */
  quoteEntry: number;
  /** Average premium actually paid across the fill (utilization-integrated). */
  vwapEntry: number;
  /** Premium at the END utilization — the last marginal unit's price. */
  endEntry: number;
  /** Utilization after the fill (fraction 0..1). */
  endUtilization: number;
}

/**
 * Expected average fill price for BUYING `size` contracts from the Olive AMM
 * when the fill itself moves the pricing rate. Each unit locks
 * `perUnitLocked` into the custody, pushing utilization along the published
 * borrowRateCurve; the AMM reprices continuously (verified convention: calls
 * use F = S·e^(rL·τ), df = e^(−rL·τ); puts F = S·e^(−rS·τ), df = e^(+rS·τ)).
 * The fill is integrated in 32 tranches at each tranche's midpoint
 * utilization. Model notes (conservative, DATA_SOURCES.md): put premium
 * recycling into USDC `owned` is excluded; rates clamp at the top node.
 */
export function expectedFillVwap(input: MarginalFillInput): MarginalFillResult | null {
  const { kind, strike, spot, vol, tauYears, size, curve, free, owned, perUnitLocked } = input;
  if (
    !(size > 0) || !(owned > 0) || free < 0 || curve.length === 0 ||
    !(strike > 0) || !(spot > 0) || !(vol > 0) || !(tauYears > 0) || !(perUnitLocked > 0)
  ) {
    return null;
  }
  const locked0 = Math.max(0, owned - free);

  const premiumAtRate = (r: number): number =>
    kind === 'call'
      ? bsPrice({ forward: spot * Math.exp(r * tauYears), strike, tauYears, vol, discountFactor: Math.exp(-r * tauYears), kind: 'call' })
      : bsPrice({ forward: spot * Math.exp(-r * tauYears), strike, tauYears, vol, discountFactor: Math.exp(r * tauYears), kind: 'put' });
  const premiumAtUtil = (utilFraction: number): number => {
    const rateBps = curveRateBpsAt(curve, utilFraction * 10_000);
    return premiumAtRate(rateBps != null ? rateBps / 10_000 : 0);
  };

  const u0 = locked0 / owned;
  const endUtil = Math.min(1, (locked0 + size * perUnitLocked) / owned);

  if (input.fixedRate) {
    // Olive sizes an option by premium budget with one re-pricing step (docs
    // trading/options/open-option "The Option's Fixed Rate"): the window is the
    // lock of q0 = budget / p(r0), larger than the real lock, and every contract
    // pays p1 = p(r_avg over that window). For a target of `size` contracts the
    // budget is size·p1, so the window size·p1/p0 is solved by fixed point.
    const tSeconds = tauYears * PROTOCOL_YEAR_SECONDS;
    const rate = (lock: number): number => (oliveOrderRateBps(curve, input.fixedRate!, owned, locked0, tSeconds, lock) ?? 0) / 10_000;
    const p0 = premiumAtRate(rate(0));
    if (!(p0 > 0)) return null;
    let p1 = p0;
    for (let i = 0; i < 12; i++) {
      const next = premiumAtRate(rate((size * p1 * perUnitLocked) / p0));
      if (Math.abs(next - p1) <= 1e-12 * p1) { p1 = next; break; }
      p1 = next;
    }
    const endRate = oliveFixedQuoteBps(curve, input.fixedRate, owned, locked0, tSeconds, size * perUnitLocked) / 10_000;
    return { quoteEntry: p0, vwapEntry: p1, endEntry: premiumAtRate(endRate), endUtilization: endUtil };
  }
  const TRANCHE_COUNT = 32;
  const step = size / TRANCHE_COUNT;
  let sum = 0;
  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const xMid = (i + 0.5) * step;
    sum += premiumAtUtil((locked0 + xMid * perUnitLocked) / owned);
  }
  return {
    quoteEntry: premiumAtUtil(u0),
    vwapEntry: sum / TRANCHE_COUNT,
    endEntry: premiumAtUtil(endUtil),
    endUtilization: endUtil,
  };
}
