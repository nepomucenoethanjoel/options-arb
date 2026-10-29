import {
  bsPrice,
  honestTotalNetUsdc,
  NON_EXECUTABLE_FLAGS,
  VENUE_ORDER,
  VENUE_SPECS,
  yearsBetween,
  type MatchRow,
  type OptionQuote,
  type PairAlternative,
  type Signal,
  type Venue,
} from '@options-arb/shared';
import { feeModels, type VenueFeeModel } from './fees';
import { oliveCapacityCap, oliveExecutionImpact, type OliveCustody } from './olive';

export interface SignalConfig {
  ivSpreadThresholdVols: number;
  minBookSize: number;
  maxRelBookWidth: number;
  nearExpiryDays: number;
  /** Quotes older than this are flagged stale. */
  staleQuoteMs: number;
  deriveTakerFeeBps: number;
  oliveFeeNotionalBps: number;
  oliveFeePremiumPct: number;
  solanaFeeUsdc: number;
  capitalBorrowRateApr: number;
  /** Per-pool available liquidity in USD (fallback estimate). Each call locks
   * 1 underlying of pool collateral, each put locks K USDC — the pool is the
   * binding size constraint, not the Derive book. Superseded per-kind by
   * `poolCustodyByAsset` when live custody balances are available. */
  poolLiquidityUsdByAsset: Record<string, number>;
  /** Live per-custody pool capacity from the market file's on-chain snapshot
   *  (null = unknown for that asset). Calls cap by free underlying custody
   *  (units — each locks 1 underlying); puts by free USDC (each locks K).
   *  `owned` values flag rows whose execution would push the custody past
   *  90% utilization, where the convex borrow curve moves the pricing rate;
   *  `tokenCurve`/`usdcCurve` (the published borrowRateCurve nodes) let the
   *  engine PRICE that movement instead of only warning about it. */
  poolCustodyByAsset: Record<string, OliveCustody>;
  /** Extra venue fee models (new venues); Derive/Olive come from the fields above. */
  extraFeeModels?: Partial<Record<Venue, VenueFeeModel>>;
}

/**
 * Burst-persistence gate: only rows a user could actually capture are worth
 * charting at 1/min. LP-only directions (writing to the Olive pool is an LP
 * role) and price-distorted books (edge is book noise) drop to the 10-min
 * full-sweep floor.
 */
export function isPersistWorthy(s: Signal): boolean {
  return (
    (s.isOpportunity || s.isProfitable) &&
    s.maxExecutableSize != null &&
    s.maxExecutableSize > 0 &&
    !s.flags.includes('direction_limited') &&
    !s.flags.includes('price_distortion')
  );
}

function round(v: number | null, dp: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

const positive = (v: number | null | undefined): number | null => (v != null && v > 0 ? v : null);
const isAmm = (venue: Venue) => VENUE_SPECS[venue].quoteKind === 'amm_synthetic';

/**
 * Turn matched rows into signals with a held-to-expiry profit estimate.
 *
 * Framing: both legs are European options on the same underlying and the
 * same expiry, so their payoffs converge at expiry. Buying the cheap venue
 * and selling the rich venue therefore locks in the price difference — less
 * fees, less the carry drag of full collateral, and excluding settlement-
 * basis risk between the venues' settlement prices (quantified, not
 * subtracted). Cross-venue legs are NOT risk-equivalent before expiry
 * (collateralized AMM vs margin venue); the UI surfaces those caveats.
 *
 * Every ordered venue pair on a row is a candidate when it is
 * vol-consistent (sell-venue IV ≥ buy-venue IV). The row's signal is the
 * best candidate: user-shortable sell venue first, then clean books, then
 * the honest clip total. Remaining candidates ride along as `alternatives`.
 */
export function computeSignals(
  rows: MatchRow[],
  cfg: SignalConfig,
  now: number,
  spotByUnderlying: Record<string, number | null> = {},
): Signal[] {
  const fees = { ...feeModels(cfg), ...cfg.extraFeeModels };
  const signals: Signal[] = [];

  for (const row of rows) {
    const venues = VENUE_ORDER.filter((v) => {
      const q = row.legs[v]?.quote;
      return q?.iv && fees[v] && (!isAmm(v) || q.mark);
    });
    const candidates: Signal[] = [];
    for (const buy of venues) {
      for (const sell of venues) {
        if (buy === sell) continue;
        const bq = row.legs[buy]!.quote!;
        const sq = row.legs[sell]!.quote!;
        // Vol-consistent direction only; a tie buys the AMM / sells the book
        // (the original two-venue rule: spread ≥ 0 → buy Olive).
        if (sq.iv! < bq.iv!) continue;
        if (sq.iv === bq.iv && isAmm(sell)) continue;
        candidates.push(evaluatePair(row, buy, sell, cfg, fees, now, spotByUnderlying));
      }
    }
    if (candidates.length === 0) continue;
    candidates.sort(comparePairs);
    const [best, ...rest] = candidates;
    if (rest.length > 0) best.alternatives = rest.slice(0, 3).map(toAlternative);
    signals.push(best);
  }

  signals.sort(
    (a, b) =>
      (b.isOpportunity ? 1 : 0) - (a.isOpportunity ? 1 : 0) ||
      (b.isProfitable ? 1 : 0) - (a.isProfitable ? 1 : 0) ||
      b.score - a.score,
  );
  return signals;
}

function comparePairs(a: Signal, b: Signal): number {
  const limited = (s: Signal) => (s.flags.includes('direction_limited') ? 1 : 0);
  const blocked = (s: Signal) => (s.flags.some((f) => NON_EXECUTABLE_FLAGS.has(f)) ? 1 : 0);
  const honest = (s: Signal) => honestTotalNetUsdc(s) ?? -Infinity;
  return (
    limited(a) - limited(b) ||
    blocked(a) - blocked(b) ||
    honest(b) - honest(a) ||
    (b.netAfterCapitalUsdc ?? -Infinity) - (a.netAfterCapitalUsdc ?? -Infinity) ||
    (b.ivSpreadVols ?? 0) - (a.ivSpreadVols ?? 0)
  );
}

function toAlternative(s: Signal): PairAlternative {
  return {
    buyVenue: s.buyVenue!,
    sellVenue: s.sellVenue!,
    ivSpreadVols: s.ivSpreadVols,
    entryPriceUsdc: s.entryPriceUsdc,
    exitPriceUsdc: s.exitPriceUsdc,
    netAfterCapitalUsdc: s.netAfterCapitalUsdc,
    maxExecutableSize: s.maxExecutableSize,
    totalNetUsdc: s.totalNetUsdc,
    honestTotalNetUsdc: honestTotalNetUsdc(s),
    flags: s.flags,
  };
}

function evaluatePair(
  row: MatchRow,
  buy: Venue,
  sell: Venue,
  cfg: SignalConfig,
  fees: Partial<Record<Venue, VenueFeeModel>>,
  now: number,
  spotByUnderlying: Record<string, number | null>,
): Signal {
  const bq = row.legs[buy]!.quote!;
  const sq = row.legs[sell]!.quote!;
  const pair = VENUE_ORDER.filter((v) => v === buy || v === sell);
  const flags: string[] = [];
  const flag = (f: string) => {
    if (!flags.includes(f)) flags.push(f);
  };
  if (pair.some(isAmm)) flag('amm_pool_depth_unknown');

  // ── Book-venue liquidity gating (each non-AMM leg) ──────────────────────
  for (const v of pair) {
    if (isAmm(v)) continue;
    const q = row.legs[v]!.quote!;
    const bid = positive(q.bid);
    const ask = positive(q.ask);
    if (bid != null && ask != null) {
      const mid = (bid + ask) / 2;
      if ((q.bidSize ?? 0) < cfg.minBookSize || (q.askSize ?? 0) < cfg.minBookSize) flag('thin_book');
      if (mid > 0 && (ask - bid) / mid > cfg.maxRelBookWidth) flag('wide_book');
    } else if (bid != null || ask != null) {
      flag('one_sided');
    } else {
      flag('no_book');
    }
  }
  for (const v of pair) {
    if (!isAmm(v) && row.legs[v]!.quote!.ts < now - cfg.staleQuoteMs) flag('stale');
  }
  for (const v of pair) for (const f of row.legs[v]!.quote!.flags ?? []) flag(f);
  // Informational: the legs pay out in different assets (USDC / USDT / the
  // coin itself) — convergence holds in USD terms only at those rates.
  if (VENUE_SPECS[buy].settlementAsset(row.kind, row.underlying) !== VENUE_SPECS[sell].settlementAsset(row.kind, row.underlying)) {
    flag('settlement_asset_mismatch');
  }

  // ── IV spread (sell − buy: ≥ 0 by construction) ─────────────────────────
  const spreadVols = (sq.iv! - bq.iv!) * 100;
  const spreadBps = ((sq.iv! - bq.iv!) / sq.iv!) * 10_000;
  if (!VENUE_SPECS[sell].canSell(row.underlying)) {
    // e.g. Olive: writing fresh shorts to the pool is an LP role.
    flag('direction_limited');
  }

  // ── Time / near-expiry / venue trading cutoffs ──────────────────────────
  const tau = yearsBetween(now, row.expiryTs);
  const tteDays = tau * 365;
  if (tteDays < cfg.nearExpiryDays) flag('near_expiry');
  if (pair.some((v) => row.expiryTs - now < VENUE_SPECS[v].tradingCutoffMs)) flag('trading_cutoff');

  // Reference leg for spot / greeks / mark checks: the first book leg in
  // venue order (Derive when present), else the buy leg.
  const refVenue = pair.find((v) => !isAmm(v)) ?? buy;
  const rq = row.legs[refVenue]!.quote!;
  const otherQ = refVenue === buy ? sq : bq;
  const spot = rq.indexPrice ?? spotByUnderlying[row.underlying] ?? rq.forward ?? null;

  // ── Executable prices: buy at the ask (AMM: its premium), sell at the bid ─
  const takePrice = (v: Venue, q: OptionQuote) => (isAmm(v) ? q.mark : positive(q.ask) ?? q.mark ?? null);
  const hitPrice = (v: Venue, q: OptionQuote) => (isAmm(v) ? q.mark : positive(q.bid) ?? q.mark ?? null);
  const buyLegPrice = takePrice(buy, bq);
  const sellLegPrice = hitPrice(sell, sq);

  // ── Costs (per contract; fixed per-order costs at the clip total) ──────
  const feeNotional = spot ?? row.strike;
  let costsUsdc = 0;
  for (const v of pair) {
    const legPrice = v === buy ? buyLegPrice : sellLegPrice;
    costsUsdc += fees[v]!.perContract({
      legPrice,
      notional: feeNotional,
      underlying: row.underlying,
      kind: row.kind,
      strike: row.strike,
      tteDays,
      side: v === buy ? 'buy' : 'sell',
    });
  }
  const orderFees = (total: number) => pair.reduce((t, v) => t - fees[v]!.perOrder, total);

  // Full collateral (call: 1 underlying, put: K USDC) for the whole tenor.
  // Conservative by design: the arbitrageur's own capital is the premium +
  // the short leg's margin, but the full-collateral drag is charged on every
  // pair — understating attractiveness rather than overstating it.
  const collateral = row.kind === 'call' ? (spot ?? row.strike) : row.strike;
  const capitalCostUsdc = collateral * cfg.capitalBorrowRateApr * tau;

  // ── Profit estimate: executable prices, held-to-expiry convergence ──────
  // Mismatched legs (different strike or expiry — interpolated / offset
  // matches) never converge at expiry: the vol spread stays meaningful, the
  // profit estimate does not.
  const mismatchedLegs = pair.some(
    (v) => (row.legs[v]!.strikeOffset ?? 0) !== 0 || (row.legs[v]!.expiryOffsetDays ?? 0) !== 0,
  );
  if (mismatchedLegs) flag('mismatched_legs');
  const entryPrice = mismatchedLegs ? null : buyLegPrice;
  const exitPrice = mismatchedLegs ? null : sellLegPrice;
  const grossEdgeUsdc = entryPrice != null && exitPrice != null ? exitPrice - entryPrice : null;
  const netEdgeUsdc = grossEdgeUsdc != null ? grossEdgeUsdc - costsUsdc : null;
  const netAfterCapitalUsdc = netEdgeUsdc != null ? netEdgeUsdc - capitalCostUsdc : null;

  // Size cap: the binding book touch on each non-AMM leg (lifting the buy
  // venue's ask, hitting the sell venue's bid), then Olive's pool capacity.
  let bookSize: number | null = null;
  let anyBookLeg = false;
  let missingSide = false;
  for (const v of pair) {
    if (isAmm(v)) continue;
    anyBookLeg = true;
    const q = row.legs[v]!.quote!;
    const side = v === buy ? (positive(q.ask) != null ? q.askSize ?? 0 : null) : positive(q.bid) != null ? q.bidSize ?? 0 : null;
    if (side == null) missingSide = true;
    else bookSize = bookSize == null ? side : Math.min(bookSize, side);
  }
  if (!anyBookLeg || missingSide) bookSize = null;

  const custody = pair.includes('olive') ? cfg.poolCustodyByAsset[row.underlying] : undefined;
  let maxExecutableSize = mismatchedLegs ? null : bookSize;
  if (!mismatchedLegs && bookSize != null && pair.includes('olive')) {
    const { cap, estimated } = oliveCapacityCap({
      kind: row.kind,
      strike: row.strike,
      collateral,
      custody,
      poolLiquidityUsd: cfg.poolLiquidityUsdByAsset[row.underlying],
    });
    if (cap != null && cap < bookSize) {
      maxExecutableSize = cap;
      flag('pool_capacity_capped');
      if (estimated) flag('pool_capacity_estimated');
    }
  }

  let expectedEntryUsdc: number | null = null;
  let expectedNetAfterCapitalUsdc: number | null = null;
  let expectedTotalNetUsdc: number | null = null;
  if (custody != null && maxExecutableSize != null && maxExecutableSize > 0) {
    const impact = oliveExecutionImpact({
      kind: row.kind,
      strike: row.strike,
      size: maxExecutableSize,
      custody,
      priceFill:
        buy === 'olive' && !mismatchedLegs
          ? { spot, vol: bq.iv!, tauYears: tau, quotedMark: bq.mark ?? 0, entryPrice }
          : null,
    });
    if (impact.movesRate) flag('execution_moves_rate');
    if (impact.vwapEntry != null && entryPrice != null) {
      expectedEntryUsdc = impact.vwapEntry;
      if (netAfterCapitalUsdc != null) {
        expectedNetAfterCapitalUsdc = netAfterCapitalUsdc - (impact.vwapEntry - entryPrice);
        expectedTotalNetUsdc = orderFees(expectedNetAfterCapitalUsdc * maxExecutableSize);
      }
    }
  }
  // Buying from Olive without a priced fill only has the quote-based total,
  // which assumes the rate stays put — mark it so headlines don't trust it.
  if (
    buy === 'olive' &&
    expectedTotalNetUsdc == null &&
    maxExecutableSize != null &&
    maxExecutableSize > 0 &&
    netAfterCapitalUsdc != null
  ) {
    flag('fill_model_skipped');
  }
  const totalNetUsdc =
    maxExecutableSize != null && maxExecutableSize > 0 && netAfterCapitalUsdc != null
      ? orderFees(netAfterCapitalUsdc * maxExecutableSize)
      : null;

  // Annualized ROI on the locked collateral — comparable across expiries.
  const roiApyPct =
    netAfterCapitalUsdc != null && collateral > 0 && tau > 0 ? (netAfterCapitalUsdc / collateral) / tau * 100 : null;

  // ~1σ settlement basis risk: |delta|·S·σ·sqrt(window / 1yr) per unit, the
  // window being the longer of the two venues' settlement averaging windows.
  const windowHours = Math.max(...pair.map((v) => VENUE_SPECS[v].settlementWindowHours));
  const delta = rq.greeks?.delta;
  const settlementBasisUsdc =
    typeof delta === 'number' && Number.isFinite(delta) && spot != null
      ? Math.abs(delta) * spot * rq.iv! * Math.sqrt(windowHours / (365 * 24))
      : null;

  // Brief §3.2 cross-check, calibrated live on Derive: book MARKS are model-
  // consistent (BS at their IV ≈ mark, verified to $0.09 RMS), so the
  // reference mark repriced at the other venue's vol isolates the pure vol
  // gap (≈ vega×Δσ), while MID − MARK isolates book dislocation — where
  // wide-book "edges" come from.
  const refBid = positive(rq.bid);
  const refAsk = positive(rq.ask);
  const refMark = rq.mark ?? null;
  const refMid = refBid != null && refAsk != null ? (refBid + refAsk) / 2 : refMark;
  let syntheticCrossCheckUsdc: number | null = null;
  let crossCheckDeviationUsdc: number | null = null;
  const bookVsMarkUsdc = refMid != null && refMark != null ? refMid - refMark : null;
  if (refMark != null && tau > 0) {
    const forward = rq.forward ?? spot;
    const df = rq.discountFactor ?? 1;
    if (forward != null && forward > 0) {
      // Informational: mark repriced at the OTHER venue's vol and the
      // vega-linear residual. A large deviation is expected whenever the vol
      // gap is wide (second-order vol effects) — NOT a data problem.
      const reprice = bsPrice({ forward, strike: row.strike, tauYears: tau, vol: otherQ.iv!, discountFactor: df, kind: row.kind });
      syntheticCrossCheckUsdc = refMark - reprice;
      const vega = rq.greeks?.vega;
      if (typeof vega === 'number' && Number.isFinite(vega)) {
        // Vega is per 1 vol POINT; the IV gap is a fraction — × 100 so both
        // sides are in $ per full-vol unit.
        crossCheckDeviationUsdc = syntheticCrossCheckUsdc - vega * 100 * (rq.iv! - otherQ.iv!);
      }
      // The actual consistency test: the mark repriced at its OWN quoted IV.
      // Live audits put this at $0.06-0.21 RMS — flag only real breakage.
      const selfReprice = bsPrice({ forward, strike: row.strike, tauYears: tau, vol: rq.iv!, discountFactor: df, kind: row.kind });
      if (Math.abs(refMark - selfReprice) > Math.max(0.3, 0.05 * Math.abs(refMark))) flag('iv_mark_inconsistent');
    }
  }
  // Dislocated book: the mid sits far off the model curve, so any "edge"
  // computed from executable prices is mostly book noise.
  if (bookVsMarkUsdc != null && grossEdgeUsdc != null) {
    if (Math.abs(bookVsMarkUsdc) > Math.max(1.0, 0.5 * Math.abs(grossEdgeUsdc))) flag('price_distortion');
  }

  // ── Ranking: USDC-native ────────────────────────────────────────────────
  const executable = !flags.some((f) => NON_EXECUTABLE_FLAGS.has(f));
  const base = totalNetUsdc ?? netAfterCapitalUsdc ?? Math.abs(spreadVols);
  const score = base * (executable ? 1 : 0.4);

  return {
    pairKey: row.pairKey,
    underlying: row.underlying,
    expiryDate: row.expiryDate,
    expiryTs: row.expiryTs,
    strike: row.strike,
    kind: row.kind,
    ivSpreadVols: round(spreadVols, 2),
    ivSpreadBps: round(spreadBps, 1),
    entryPriceUsdc: round(entryPrice, 4),
    exitPriceUsdc: round(exitPrice, 4),
    edgeUsdc: round(grossEdgeUsdc, 4),
    netEdgeUsdc: round(netEdgeUsdc, 4),
    netAfterCapitalUsdc: round(netAfterCapitalUsdc, 4),
    costsUsdc: round(costsUsdc, 4) ?? 0,
    capitalCostUsdc: round(capitalCostUsdc, 4) ?? 0,
    maxExecutableSize: maxExecutableSize != null ? round(maxExecutableSize, 4) : null,
    totalNetUsdc: round(totalNetUsdc, 2),
    expectedEntryUsdc: round(expectedEntryUsdc, 4),
    expectedNetAfterCapitalUsdc: round(expectedNetAfterCapitalUsdc, 4),
    expectedTotalNetUsdc: round(expectedTotalNetUsdc, 2),
    roiApyPct: round(roiApyPct, 2),
    settlementBasisUsdc: round(settlementBasisUsdc, 4),
    syntheticCrossCheckUsdc: round(syntheticCrossCheckUsdc, 4),
    crossCheckDeviationUsdc: round(crossCheckDeviationUsdc, 4),
    bookVsMarkUsdc: round(bookVsMarkUsdc, 4),
    score: round(score, 2) ?? 0,
    isOpportunity: executable && Math.abs(spreadVols) >= cfg.ivSpreadThresholdVols,
    isProfitable: netAfterCapitalUsdc != null && netAfterCapitalUsdc > 0,
    buyVenue: buy,
    sellVenue: sell,
    flags,
    ts: now,
  };
}
