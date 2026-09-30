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

  const premiumAtUtil = (utilFraction: number): number => {
    const rateBps = curveRateBpsAt(curve, utilFraction * 10_000);
    const r = rateBps != null ? rateBps / 10_000 : 0;
    return kind === 'call'
      ? bsPrice({ forward: spot * Math.exp(r * tauYears), strike, tauYears, vol, discountFactor: Math.exp(-r * tauYears), kind: 'call' })
      : bsPrice({ forward: spot * Math.exp(-r * tauYears), strike, tauYears, vol, discountFactor: Math.exp(r * tauYears), kind: 'put' });
  };

  const u0 = locked0 / owned;
  const endUtil = Math.min(1, (locked0 + size * perUnitLocked) / owned);
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
