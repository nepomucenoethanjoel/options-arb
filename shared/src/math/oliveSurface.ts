import { bsPrice } from './bs';

/**
 * Olive's demand surface (live 2026-11-25, DATA_SOURCES row 99): a purchase is
 * priced at σ_oracle·(1 + markup) and pays a "push" on top of the flat
 * (oracle-vol) premium. The push is refunded on sell-back and stays with the
 * pool at expiry/exercise. Port of Olive's own client math (web bundle module
 * `4968`, 2026-11-28) — replayed against all 8 surface-pushing opens on chain:
 * markup within 0.07%, push and contracts within 0.2%.
 *
 *   placement: strike z = ln(K/S)/(σ√τ) on −3…+3 step 0.5 (13 columns), tenor
 *     log-interpolated across 1/7/30/90/180/365 d (6 rows); shares bilinear.
 *   kernel:    K = exp(−((1.5·Δrow)² + Δcol²)/2) (rounded to 1e-9, Olive's table);
 *     day slots k = max(0, 1 − |ln n₁ − ln n₂|), n = days ahead.
 *   depth:     held USD × ATM 30-day call fraction at the oracle vol.
 *   markup:    (√(g/D)·Σ wᵢ(K·pushes)ᵢ + √(e/D)·dateField)/s, s = (days/30)^¼.
 *   push cost: overlap with what stands + ½ self-overlap (pushᵀK·push/2).
 */
export interface OliveDemandSide {
  /** Strengths as fractions (on chain 1e6-scaled). */
  gridStrength: number;
  dateStrength: number;
  /** Depth the side's last purchase was priced at (record only; purchases recompute it from held USD). */
  depthUsd: number;
  halfLifeSeconds: number;
  /** Half-lives of fading applied so far. */
  fadeIndex: number;
  lastFadeAt: number;
  /** 78 grid pushes, row (tenor) by row, 13 strikes each. */
  pushes: number[];
  /** 367 day slots, slot = day % 367. */
  dateLevels: number[];
  /** Wheel day the slots were last brought to (0 = never). */
  dateToday: number;
  enabled: boolean;
}

export interface OliveDemandSurface {
  calls: OliveDemandSide;
  puts: OliveDemandSide;
}

/** One Olive option order on a side's surface. */
export interface OliveSurfaceOrder {
  isCall: boolean;
  strike: number;
  spot: number;
  /** Oracle (model) vol — the surface multiplies it. */
  vol: number;
  expiresAtSec: number;
  /** USD liquidity providers hold on this side: (owned − pending escrow) coin × spot for calls, USDC for puts. */
  heldUsd: number;
}

const TENOR_DAYS = [1, 7, 30, 90, 180, 365];
const COLS = 13;
const NODES = 78;
const SLOTS = 367;
const YEAR_SECONDS = 31_536_000;
const DEPTH_TENOR_YEARS = 30 / 365;

const kGridAt = (a: number, b: number): number => {
  const dr = Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS));
  const dc = Math.abs((a % COLS) - (b % COLS));
  return Math.round(1e9 * Math.exp(-((1.5 * dr) ** 2 + dc * dc) / 2)) / 1e9;
};
const kDate = (n1: number, n2: number): number =>
  Math.max(0, 1e9 - Math.abs(Math.round(1e9 * Math.log(n1)) - Math.round(1e9 * Math.log(n2)))) / 1e9;
const slotOf = (day: number): number => ((day % SLOTS) + SLOTS) % SLOTS;
const floor6 = (x: number): number => Math.floor(x * 1e6) / 1e6;

/** Olive's wheel day: days begin 08:00 UTC. */
export const oliveWheelDay = (tSec: number): number => Math.floor((tSec - 28_800) / 86_400);

/** A side brought to `nowSec`: passed day slots cleared, grid faded by its half-life. */
export function advanceDemandSide(e: OliveDemandSide, nowSec: number): OliveDemandSide {
  const day = Math.max(0, oliveWheelDay(nowSec));
  let { dateLevels, dateToday } = e;
  if (e.dateToday === 0) dateToday = day;
  else if (day > e.dateToday) {
    dateLevels = [...e.dateLevels];
    for (let i = 0; i < Math.min(day - e.dateToday, SLOTS); i++) dateLevels[(e.dateToday + i) % SLOTS] = 0;
    dateToday = day;
  }
  const dt = nowSec - e.lastFadeAt;
  if (!(dt > 0) || !(e.halfLifeSeconds > 0)) return { ...e, dateLevels, dateToday };
  const h = dt / e.halfLifeSeconds;
  const f = 2 ** -h;
  return { ...e, dateLevels, dateToday, fadeIndex: e.fadeIndex + h, lastFadeAt: nowSec, pushes: e.pushes.map((p) => p * f) };
}

/** Depth: held USD × the ATM 30-day call price per $1 at the oracle vol, floored to 1e-6. */
export function oliveSurfaceDepthUsd(heldUsd: number, vol: number): number {
  if (!(heldUsd > 0) || !(vol > 0)) return 0;
  const frac = bsPrice({ forward: 1, strike: 1, tauYears: DEPTH_TENOR_YEARS, vol, discountFactor: 1, kind: 'call' });
  return frac > 0 ? Math.floor(1e6 * heldUsd * frac) / 1e6 : 0;
}

interface Placement { row: number; col: number; shares: [number, number, number, number]; scale: number }

function placementOf(strike: number, spot: number, vol: number, tauSec: number): Placement | null {
  if (![strike, spot, vol, tauSec].every((x) => Number.isFinite(x) && x > 0)) return null;
  const c = Math.min(COLS - 1, Math.max(0, (Math.log(strike / spot) / (vol * Math.sqrt(tauSec / YEAR_SECONDS)) + 3) / 0.5));
  const col = Math.min(COLS - 2, Math.floor(c));
  const p = c - col;
  const days = Math.min(365, Math.max(1, tauSec / 86_400));
  let row = 0;
  while (row < 4 && TENOR_DAYS[row + 1]! < days) row++;
  const lo = Math.log(TENOR_DAYS[row]!);
  const g = Math.min(1, Math.max(0, (Math.log(days) - lo) / (Math.log(TENOR_DAYS[row + 1]!) - lo)));
  return { row, col, shares: [(1 - g) * (1 - p), (1 - g) * p, g * (1 - p), g * p], scale: Math.sqrt(Math.sqrt(days / 30)) };
}

/** Expiry → its wheel day boundary and the hours past the one before (shares split across both). */
function dateOf(expiresAtSec: number): { day: number; shares: [number, number] } {
  const t = 3600 * Math.floor(expiresAtSec / 3600);
  const day = Math.ceil((t - 28_800) / 86_400);
  const hours = (t - (28_800 + (day - 1) * 86_400)) / 3600;
  return { day, shares: [1 - hours / 24, hours / 24] };
}

/** A purchase point on a side, prepared once: everything that does not depend on the order's size. */
export interface OliveSurfacePoint {
  /** Markup standing at the point before the order (σ = σ_oracle·(1 + markup)). */
  markup: number;
  /** Markup added per push dollar. */
  climbPerDollar: number;
  depthUsd: number;
  scale: number;
  sqrtGrid: number;
  sqrtDate: number;
  shares: [number, number, number, number];
  dateShares: [number, number];
  /** Existing field at the 4 grid nodes / 2 day slots, and the self-overlap kernels. */
  nodeField: [number, number, number, number];
  nodeKernel: number[][];
  dateField: [number, number];
  dateValid: [boolean, boolean];
  dateKernel: number;
}

export type OliveSurfacePrep = { kind: 'flat' } | { kind: 'refused' } | { kind: 'point'; point: OliveSurfacePoint };

/**
 * Prepare an order's point on a side at `nowSec`. 'flat' = the surface is off
 * (priced at the oracle vol); 'refused' = depth 0 (Olive refuses: nothing to sell).
 */
export function prepareSurfacePoint(side: OliveDemandSide, order: OliveSurfaceOrder, nowSec: number): OliveSurfacePrep {
  if (!(side.enabled && (side.gridStrength > 0 || side.dateStrength > 0))) return { kind: 'flat' };
  const pl = placementOf(order.strike, order.spot, order.vol, order.expiresAtSec - nowSec);
  if (!pl) return { kind: 'flat' };
  const e = advanceDemandSide(side, nowSec);
  const depth = oliveSurfaceDepthUsd(order.heldUsd, order.vol);
  if (!(depth > 0)) return { kind: 'refused' };
  const sqrtGrid = Math.sqrt(e.gridStrength / depth);
  const sqrtDate = Math.sqrt(e.dateStrength / depth);
  const base = pl.row * COLS + pl.col;
  const nodes = [base, base + 1, base + COLS, base + COLS + 1];
  const fieldAt = (node: number): number => {
    let s = 0;
    for (let l = 0; l < NODES; l++) if (e.pushes[l]) s += kGridAt(node, l) * e.pushes[l]!;
    return s;
  };
  const nodeField = nodes.map(fieldAt) as [number, number, number, number];
  const nodeKernel = nodes.map((a) => nodes.map((b) => kGridAt(a, b)));
  let gridField = 0, gridSelf = 0;
  pl.shares.forEach((w, n) => {
    if (!w) return;
    gridField += w * nodeField[n]!;
    pl.shares.forEach((w2, t) => { gridSelf += w * w2 * nodeKernel[n]![t]!; });
  });
  const date = dateOf(order.expiresAtSec);
  const ahead = (day: number): number | null => { const n = day - e.dateToday + 1; return n >= 1 && n <= SLOTS ? n : null; };
  const idx = [ahead(date.day - 1), ahead(date.day)];
  const dateField: [number, number] = [0, 0];
  for (let t = 1; t <= SLOTS; t++) {
    const lv = e.dateLevels[slotOf(e.dateToday + t - 1)] ?? 0;
    if (lv) idx.forEach((n, i) => { if (n !== null) dateField[i] += kDate(n, t) * lv; });
  }
  const [u0, u1] = date.shares;
  const dateKernel = idx[0] !== null && idx[1] !== null ? kDate(idx[0], idx[1]) : 0;
  const dateSelf = u0 * u0 + u1 * u1 + 2 * u0 * u1 * dateKernel;
  return {
    kind: 'point',
    point: {
      markup: (sqrtGrid * gridField + sqrtDate * (u0 * dateField[0] + u1 * dateField[1])) / pl.scale,
      climbPerDollar: (sqrtGrid * sqrtGrid * gridSelf + sqrtDate * sqrtDate * dateSelf) / pl.scale,
      depthUsd: depth,
      scale: pl.scale,
      sqrtGrid,
      sqrtDate,
      shares: pl.shares,
      dateShares: date.shares,
      nodeField,
      nodeKernel,
      dateField,
      dateValid: [idx[0] !== null, idx[1] !== null],
      dateKernel,
    },
  };
}

export interface OliveSurfaceBuy {
  /** USD paid for the push on top of contracts × flat price. */
  extraUsd: number;
  /** Contracts the budget buys: (budget − extra) / flat. */
  contracts: number;
  markupBefore: number;
  markupAfter: number;
}

/**
 * A premium budget spent at a prepared point (Olive's `AA`): the climb solves
 * v² + 2(m₀ + ρ)v = 2·budget·climb/s with ρ = flat ÷ price slope per unit of
 * markup (Simpson-refined over the climb); push = v / climb dollars, spread
 * over the 4 nodes and 2 day slots (floored to 1e-6 as on chain).
 * `priceAt(m)` is the option's price at σ_oracle·(1 + m) and the order's rate.
 * Null when Olive would refuse (the push alone eats the budget).
 */
export function surfaceBuyForBudget(
  pt: OliveSurfacePoint,
  flatPrice: number,
  priceAt: (markup: number) => number,
  budget: number,
): OliveSurfaceBuy | null {
  if (!(budget > 0) || !(flatPrice > 0)) return null;
  const flat: OliveSurfaceBuy = { extraUsd: 0, contracts: budget / flatPrice, markupBefore: pt.markup, markupAfter: pt.markup };
  if (!(pt.climbPerDollar > 0)) return flat;
  const ratioAt = (m: number): number | null => {
    const mm = Math.max(m, 0.01);
    const slope = (priceAt(mm) - flatPrice) / mm;
    return Number.isFinite(slope) && slope > 0 ? flatPrice / slope : null;
  };
  const climb = (ratio: number): number => {
    const r = pt.markup + ratio;
    const v = Math.sqrt(r * r + (2 * budget * pt.climbPerDollar) / pt.scale) - r;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const r0 = ratioAt(pt.markup);
  if (r0 === null) return flat;
  let ratio = r0;
  for (let k = 0; k < 2; k++) {
    const v = climb(ratio);
    if (v <= 0) break;
    const rm = ratioAt(pt.markup + v / 2), re = ratioAt(pt.markup + v);
    if (rm === null || re === null) break;
    ratio = (r0 + 4 * rm + re) / 6;
  }
  const v = climb(ratio);
  const push = v / pt.climbPerDollar;
  const nodes = pt.shares.map((w) => floor6(pt.sqrtGrid * push * w));
  const date = pt.dateShares.map((w) => floor6(pt.sqrtDate * push * w));
  if (nodes.every((x) => x === 0) && date.every((x) => x === 0)) return flat;
  let gridOverlap = 0, gridSelf = 0;
  nodes.forEach((w, n) => {
    if (!w) return;
    gridOverlap += w * pt.nodeField[n]!;
    nodes.forEach((w2, t) => { gridSelf += w * pt.nodeKernel[n]![t]! * w2; });
  });
  let dateOverlap = 0, dateSelf = 0;
  date.forEach((w, r) => {
    if (!w || !pt.dateValid[r]) return;
    dateOverlap += w * pt.dateField[r]!;
    date.forEach((w2, r2) => { if (w2 && pt.dateValid[r2]) dateSelf += w * (r === r2 ? 1 : pt.dateKernel) * w2; });
  });
  const extraUsd = Math.max(0, gridOverlap + gridSelf / 2) + Math.max(0, dateOverlap + dateSelf / 2);
  if (extraUsd >= budget) return null;
  return { extraUsd, contracts: (budget - extraUsd) / flatPrice, markupBefore: pt.markup, markupAfter: pt.markup + v };
}

/** Markup standing at an order's point now (0 when the surface is off or the point is off-grid). */
export function oliveSurfaceMarkup(side: OliveDemandSide | null | undefined, order: OliveSurfaceOrder, nowSec: number): number {
  if (!side) return 0;
  const prep = prepareSurfacePoint(side, order, nowSec);
  return prep.kind === 'point' ? prep.point.markup : 0;
}
