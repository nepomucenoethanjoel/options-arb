/**
 * Raw SVI (stochastic volatility inspired) parameterization used by Derive's
 * signed vol feeds. Total variance as a function of log-moneyness:
 *
 *   w(k) = a + b · ( ρ·(k − m) + √((k − m)² + σ²) ),   k = ln(K / F)
 *
 * Implied vol at the reference tenor: IV = √(w / refTau).
 */
export interface SviSlice {
  /** Expiry timestamp, ms UTC. */
  expiryTs: number;
  currency: string;
  /** Reference tenor the params were fit at, years. */
  refTau: number;
  forward: number;
  a: number;
  b: number;
  m: number;
  rho: number;
  sigma: number;
  /** Feed publication time, ms UTC. */
  ts?: number;
  /** Signed-feed confidence field when present. */
  confidence?: number | null;
}

export function sviTotalVariance(
  k: number,
  p: { a: number; b: number; m: number; rho: number; sigma: number },
): number {
  const km = k - p.m;
  return p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
}

/** IV (fraction) at `strike` for a slice, evaluated at its reference tenor. */
export function sviImpliedVol(slice: SviSlice, strike: number, tauYears?: number): number | null {
  const tau = tauYears ?? slice.refTau;
  if (!(tau > 0) || !(strike > 0) || !(slice.forward > 0)) return null;
  const k = Math.log(strike / slice.forward);
  const w = sviTotalVariance(k, slice);
  if (!Number.isFinite(w) || w <= 0) return null;
  const iv = Math.sqrt(w / tau);
  return Number.isFinite(iv) && iv > 0 && iv < 10 ? iv : null;
}

/** Sample a slice across strikes at ±`range` around the forward. */
export function sampleSviSlice(slice: SviSlice, range = 0.35, points = 41): { strike: number; iv: number }[] {
  const out: { strike: number; iv: number }[] = [];
  for (let i = 0; i < points; i++) {
    const m = -range + (2 * range * i) / (points - 1);
    const strike = slice.forward * Math.exp(m);
    const iv = sviImpliedVol(slice, strike);
    if (iv != null) out.push({ strike, iv });
  }
  return out;
}
