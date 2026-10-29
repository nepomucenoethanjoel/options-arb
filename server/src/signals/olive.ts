import { expectedFillVwap, type OptionKind, type OliveRateCurvePoint } from '@options-arb/shared';

/** Olive pool custody for one underlying (market-file on-chain snapshot). */
export interface OliveCustody {
  underlyingFree: number | null;
  usdcFreeUsd: number | null;
  underlyingOwned?: number | null;
  usdcOwnedUsd?: number | null;
  tokenCurve?: OliveRateCurvePoint[] | null;
  usdcCurve?: OliveRateCurvePoint[] | null;
}

/**
 * Size cap from Olive's pool: calls lock 1 underlying each, puts K USDC
 * each. Live custody balances win; the scalar AUM fallback is cruder and
 * flagged `pool_capacity_estimated`.
 */
export function oliveCapacityCap(input: {
  kind: OptionKind;
  strike: number;
  collateral: number;
  custody: OliveCustody | undefined;
  poolLiquidityUsd: number | undefined;
}): { cap: number | null; estimated: boolean } {
  const { kind, strike, collateral, custody, poolLiquidityUsd } = input;
  const custodyCap =
    custody == null
      ? null
      : kind === 'call'
        ? custody.underlyingFree
        : custody.usdcFreeUsd != null && strike > 0
          ? custody.usdcFreeUsd / strike
          : null;
  const fallbackCap = poolLiquidityUsd != null && collateral > 0 ? Math.floor(poolLiquidityUsd / collateral) : null;
  return { cap: custodyCap ?? fallbackCap, estimated: custodyCap == null && poolLiquidityUsd != null };
}

/**
 * Own-impact: a fill moves its custody's utilization, and the borrow curve
 * (hence the AMM's pricing rate) is convex above ~90% — flag rows whose
 * full execution would push past it (observed live 2026-09-29: a ~$50 fill
 * moved the ZEC short rate 30% → 69.5%). When BUYING from Olive with the
 * curve nodes in hand, go further and PRICE the movement: the expected
 * average fill (expectedFillVwap integrates the AMM premium along the
 * curve, 32 tranches) is the honest entry — the quoted one assumes the rate
 * stays put. Guarded by requiring the model's rate-at-current-util premium
 * to reproduce the cycle's quoted premium (≤2% deviation), else inputs are
 * inconsistent and the model is skipped (vwapEntry null).
 */
export function oliveExecutionImpact(input: {
  kind: OptionKind;
  strike: number;
  size: number;
  custody: OliveCustody;
  /** Price the fill only when buying from Olive on a same-contract leg. */
  priceFill: { spot: number | null; vol: number; tauYears: number; quotedMark: number; entryPrice: number | null } | null;
}): { movesRate: boolean; vwapEntry: number | null } {
  const { kind, strike, size, custody } = input;
  const owned = kind === 'call' ? custody.underlyingOwned : custody.usdcOwnedUsd;
  const free = kind === 'call' ? custody.underlyingFree : custody.usdcFreeUsd;
  const perUnit = kind === 'call' ? 1 : strike;
  if (owned == null || owned <= 0 || free == null) return { movesRate: false, vwapEntry: null };
  const endUtil = (owned - free + size * perUnit) / owned;
  const movesRate = endUtil > 0.9;
  const curve = kind === 'call' ? custody.tokenCurve : custody.usdcCurve;
  const p = input.priceFill;
  if (!p || p.entryPrice == null || curve == null || curve.length === 0 || p.spot == null || !(p.vol > 0) || !(p.tauYears > 0)) {
    return { movesRate, vwapEntry: null };
  }
  const fill = expectedFillVwap({
    kind,
    strike,
    spot: p.spot,
    vol: p.vol,
    tauYears: p.tauYears,
    size,
    curve,
    free,
    owned,
    perUnitLocked: perUnit,
  });
  if (fill && p.quotedMark > 0 && Math.abs(fill.quoteEntry - p.quotedMark) <= 0.02 * p.quotedMark) {
    return { movesRate, vwapEntry: fill.vwapEntry };
  }
  return { movesRate, vwapEntry: null };
}

/** Clip sizes tried between 0 and the cap (each costs one fill-model integration). */
export const OLIVE_CLIP_SEARCH_STEPS = 20;

/**
 * Best clip under the fill model: the full-cap clip can lose while a smaller
 * one nets positive (own impact grows with size). Scans `steps` evenly spaced
 * sizes up to `maxSize` — resolution is maxSize/steps — and returns the
 * size with the highest expected total, plus the largest size still > 0.
 * `expectedTotal(size)` returns null when the model cannot price that size.
 */
export function bestOliveClip(
  expectedTotal: (size: number) => number | null,
  maxSize: number,
  steps = OLIVE_CLIP_SEARCH_STEPS,
): { bestSize: number; bestTotal: number; maxProfitableSize: number | null } | null {
  if (!(maxSize > 0)) return null;
  let best: { size: number; total: number } | null = null;
  let maxProfitableSize: number | null = null;
  for (let i = 1; i <= steps; i++) {
    const size = (maxSize * i) / steps;
    const total = expectedTotal(size);
    if (total == null) continue;
    if (best == null || total > best.total) best = { size, total };
    if (total > 0) maxProfitableSize = size;
  }
  return best ? { bestSize: best.size, bestTotal: best.total, maxProfitableSize } : null;
}
