import type { OptionKind } from '../types';

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF — Abramowitz & Stegun 26.2.17 rational approximation.
 * Max absolute error < 7.5e-8, ample for vol-point-level precision.
 */
export function normCdf(x: number): number {
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const poly =
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - normPdf(ax) * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

export interface BsInputs {
  /** Forward price of the underlying to expiry. */
  forward: number;
  strike: number;
  /** Time to expiry in years. */
  tauYears: number;
  /** Volatility as a fraction (0.55 = 55%). */
  vol: number;
  /** Discount factor to expiry (e^(-rT)); 1 = zero rates. */
  discountFactor: number;
  kind: OptionKind;
}

/** European option price in forward/discount-factor form. */
export function bsPrice({ forward: F, strike: K, tauYears: T, vol: s, discountFactor: df, kind }: BsInputs): number {
  if (T <= 0 || s <= 0 || F <= 0 || K <= 0) {
    const intrinsic = kind === 'call' ? Math.max(F - K, 0) : Math.max(K - F, 0);
    return df * intrinsic;
  }
  const sq = s * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * s * s * T) / sq;
  const d2 = d1 - sq;
  return kind === 'call'
    ? df * (F * normCdf(d1) - K * normCdf(d2))
    : df * (K * normCdf(-d2) - F * normCdf(-d1));
}

/** Greeks in forward form (delta w.r.t. forward, vega per 1.0 vol). */
export function bsGreeks(inputs: BsInputs): {
  delta: number;
  gamma: number;
  vega: number;
  thetaPerYear: number;
} {
  const { forward: F, strike: K, tauYears: T, vol: s, discountFactor: df, kind } = inputs;
  if (T <= 0 || s <= 0 || F <= 0 || K <= 0) {
    return { delta: NaN, gamma: NaN, vega: NaN, thetaPerYear: NaN };
  }
  const sq = s * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * s * s * T) / sq;
  const d2 = d1 - sq;
  const nd1 = normPdf(d1);
  const sign = kind === 'call' ? 1 : -1;
  const delta = df * (sign * normCdf(sign * d1));
  const gamma = (df * nd1) / (F * sq);
  const vega = df * F * nd1 * Math.sqrt(T);
  const thetaPerYear =
    df * (-(F * nd1 * s) / (2 * Math.sqrt(T)) + sign * 0) +
    (kind === 'call' ? 0 : 0); // drift-free in forward form; rate terms fold into df
  return { delta, gamma, vega, thetaPerYear };
}

/**
 * Implied vol from a market price via bracketed bisection + Newton polish.
 * Returns null when the price is not attainable (outside [discounted
 * intrinsic, discounted forward] for calls / [df·K, df·K] bounds for puts,
 * or when the bracket fails to converge).
 */
export function impliedVol(
  price: number,
  inputs: Omit<BsInputs, 'vol'>,
  opts: { lo?: number; hi?: number; iterations?: number } = {},
): number | null {
  const { lo = 1e-4, hi = 5, iterations = 200 } = opts;
  if (!(price >= 0) || !Number.isFinite(price)) return null;
  const intrinsic = bsPrice({ ...inputs, vol: 0 });
  const upperBound = inputs.kind === 'call' ? inputs.discountFactor * inputs.forward : inputs.discountFactor * inputs.strike;
  const eps = Math.max(1e-12, upperBound * 1e-9);
  if (price < intrinsic - eps || price > upperBound + eps) return null;

  let a = lo;
  let b = hi;
  let fa = bsPrice({ ...inputs, vol: a }) - price;
  // Even a vol of 5 (500%) can't reach the price → clamp to hi.
  const fb = bsPrice({ ...inputs, vol: b }) - price;
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa > 0 || fb < 0) return null;

  let mid = a;
  for (let i = 0; i < iterations; i++) {
    mid = a + (b - a) / 2;
    const fm = bsPrice({ ...inputs, vol: mid }) - price;
    if (fm === 0 || b - a < 1e-10) break;
    if (fa * fm < 0) {
      b = mid;
    } else {
      a = mid;
      fa = fm;
    }
  }
  // Newton polish for extra digits.
  let sigma = mid;
  for (let i = 0; i < 5; i++) {
    const p = bsPrice({ ...inputs, vol: sigma });
    const v = bsGreeks({ ...inputs, vol: sigma }).vega;
    if (!Number.isFinite(v) || v < 1e-12) break;
    const step = (p - price) / v;
    if (!Number.isFinite(step)) break;
    sigma -= step;
    if (sigma <= 0 || sigma > 10) {
      sigma = mid;
      break;
    }
  }
  return sigma;
}

export function yearsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / (365 * 24 * 60 * 60 * 1000));
}
