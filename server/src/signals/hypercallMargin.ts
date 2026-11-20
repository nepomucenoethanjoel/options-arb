import { bsPrice, type OptionKind } from '@options-arb/shared';

/**
 * Hypercall portfolio-margin requirement for ONE short option contract held as
 * a filled position (docs margining/portfolio-margin, pm-risk-parameters,
 * margin-floor; read 2026-11-20 — DATA_SOURCES row 83):
 *  - mark = Black-Scholes at the venue's mark IV, 5% rate;
 *  - scanning risk = the largest weighted loss over 17 (spot move, vol move,
 *    weight) scenarios — the ±25% / ±40% tails weigh 0.6 / 0.35;
 *  - IM = max(scanning risk, 1.5% × strike) + 1% × spot within 48 h of expiry;
 *  - MM = 0.85 × IM.
 * Resting sell orders reserve more (the unweighted highest scenario price) —
 * this is the requirement after an RFQ fill. Calibrated against Hypercall's
 * own portfolio API on a live 0.01 short BTC-20261127-46000-P (scanning $38.04).
 */
const SCENARIOS: ReadonlyArray<readonly [spotMove: number, volMove: number, weight: number]> = [
  [0.12, 0.35, 1], [0.08, 0, 1], [0.04, -0.15, 1], [0, 0.35, 1], [0, 0, 1], [0, -0.15, 1],
  [-0.04, -0.15, 1], [-0.08, 0, 1], [-0.12, 0.45, 1], [0.12, 0, 1], [-0.12, 0, 1], [0.08, 0.25, 1],
  [-0.08, 0.35, 1], [-0.25, 0.7, 0.6], [0.25, 0.55, 0.6], [-0.4, 0.9, 0.35], [0.4, 0.7, 0.35],
];
const RATE = 0.05;
const STRIKE_FLOOR = 0.015;
const GAMMA_OVERLAY_SPOT = 0.01;
const GAMMA_OVERLAY_HOURS = 48;
const MM_FRACTION = 0.85;

export interface HypercallShortMarginInput {
  spot: number;
  strike: number;
  kind: OptionKind;
  tauYears: number;
  /** Mark IV as a fraction. */
  vol: number;
}

export function hypercallShortMargin({ spot, strike, kind, tauYears, vol }: HypercallShortMarginInput): { imUsd: number; mmUsd: number; scanningUsd: number } {
  const price = (s: number, v: number) => {
    const t = Math.max(tauYears, 0);
    return bsPrice({ forward: s * Math.exp(RATE * t), strike, tauYears: t, vol: v, discountFactor: Math.exp(-RATE * t), kind });
  };
  const mark = price(spot, vol);
  const scanningUsd = Math.max(0, ...SCENARIOS.map(([ds, dv, w]) => w * (price(spot * (1 + ds), vol * (1 + dv)) - mark)));
  const overlay = tauYears * 8760 <= GAMMA_OVERLAY_HOURS ? GAMMA_OVERLAY_SPOT * spot : 0;
  const imUsd = Math.max(scanningUsd, STRIKE_FLOOR * strike) + overlay;
  return { imUsd, mmUsd: MM_FRACTION * imUsd, scanningUsd };
}
