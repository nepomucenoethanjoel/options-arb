/**
 * Olive strike bounds: σ-band around oracle spot. Their docs describe ±1σ
 * (n = m = 1), but the live UI quotes strikes to 2.5× spot (verified
 * 2026-09-28), so the multiplier is caller-configurable.
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
