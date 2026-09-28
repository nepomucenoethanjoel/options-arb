import {
  bsPrice,
  yearsBetween,
  type MatchRow,
  type OptionQuote,
  type Signal,
  type SignalDirection,
} from '@options-arb/shared';

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
   *  (units — each locks 1 underlying); puts by free USDC (each locks K). */
  poolCustodyByAsset: Record<string, { underlyingFree: number | null; usdcFreeUsd: number | null }>;
}

const NON_EXECUTABLE_FLAGS = new Set(['no_book', 'one_sided', 'thin_book', 'wide_book', 'stale']);
/** Derive settles a 30-minute TWAP of the underlying; Olive settles a Stork oracle print. */
const SETTLEMENT_TWAP_HOURS = 0.5;

function round(v: number | null, dp: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/**
 * Turn matched rows into signals with a held-to-expiry profit estimate.
 *
 * Framing: both legs are European options on the same underlying and (within
 * matching tolerance) the same expiry, so their payoffs converge at expiry.
 * Buying the cheap venue and selling the rich venue therefore locks in the
 * price difference — less fees, less the carry drag of Olive's full
 * collateral lock, and excluding the settlement-basis risk of a 30-min TWAP
 * (Derive) versus a Stork print (Olive), which is quantified but not
 * subtracted. Cross-venue legs are NOT risk-equivalent before expiry
 * (collateralized AMM vs margin venue); the UI surfaces those caveats.
 */
export function computeSignals(
  rows: MatchRow[],
  cfg: SignalConfig,
  now: number,
  spotByUnderlying: Record<string, number | null> = {},
): Signal[] {
  const signals: Signal[] = [];

  for (const row of rows) {
    const dq: OptionQuote | null = row.derive.quote;
    const oq: OptionQuote | null = row.olive.quote;
    if (!dq?.iv || !oq?.iv || !oq.mark) continue;

    const flags: string[] = ['amm_pool_depth_unknown'];

    // ── Derive liquidity gating ─────────────────────────────────────────────
    const hasBid = dq.bid != null && dq.bid > 0;
    const hasAsk = dq.ask != null && dq.ask > 0;
    const deriveBid = hasBid ? dq.bid : null;
    const deriveAsk = hasAsk ? dq.ask : null;
    const deriveMark = dq.mark ?? null;
    const deriveMid = hasBid && hasAsk ? (dq.bid! + dq.ask!) / 2 : deriveMark;
    if (hasBid && hasAsk) {
      const width = dq.ask! - dq.bid!;
      if ((dq.bidSize ?? 0) < cfg.minBookSize || (dq.askSize ?? 0) < cfg.minBookSize) {
        flags.push('thin_book');
      }
      if (deriveMid != null && deriveMid > 0 && width / deriveMid > cfg.maxRelBookWidth) {
        flags.push('wide_book');
      }
    } else if (hasBid || hasAsk) {
      flags.push('one_sided');
    } else {
      flags.push('no_book');
    }
    if (dq.ts < now - cfg.staleQuoteMs) flags.push('stale');

    // ── IV spread ───────────────────────────────────────────────────────────
    const spreadVols = (dq.iv - oq.iv) * 100;
    const spreadBps = ((dq.iv - oq.iv) / dq.iv) * 10_000;
    const direction: SignalDirection = spreadVols >= 0 ? 'buy_olive_sell_derive' : 'buy_derive_sell_olive';
    if (direction === 'buy_derive_sell_olive') {
      // Olive's pool sells options; writing fresh shorts to it is an LP role.
      flags.push('direction_limited');
    }

    // ── Time / near-expiry ──────────────────────────────────────────────────
    const tau = yearsBetween(now, row.expiryTs);
    const tteDays = tau * 365;
    if (tteDays < cfg.nearExpiryDays) flags.push('near_expiry');

    const spot = dq.indexPrice ?? spotByUnderlying[row.underlying] ?? dq.forward ?? null;

    // ── Costs ───────────────────────────────────────────────────────────────
    const notionalProxy = row.kind === 'call' ? (spot ?? row.strike) : row.strike;
    const deriveFee = notionalProxy * (cfg.deriveTakerFeeBps / 10_000);
    const oliveFee =
      oq.mark > 0
        ? Math.min(
            notionalProxy * (cfg.oliveFeeNotionalBps / 10_000),
            oq.mark * (cfg.oliveFeePremiumPct / 100),
          )
        : 0;
    const costsUsdc = deriveFee + oliveFee + cfg.solanaFeeUsdc;

    // Olive locks full collateral (call: 1 underlying, put: K USDC) for the
    // whole tenor vs Derive's margin — the carry drag is a real cost.
    // Modeling note (conservative by design): for buy_olive_sell_derive the
    // ARBITRAGEUR posts no Olive collateral (the pool does); their own tied-up
    // capital is the premium + Derive short margin. We still charge full
    // collateral drag on both directions — understating executable-direction
    // attractiveness rather than overstating it. Revisit if executable rows
    // ever approach break-even on this term alone.
    const oliveCollateral = row.kind === 'call' ? (spot ?? row.strike) : row.strike;
    const capitalCostUsdc = oliveCollateral * cfg.capitalBorrowRateApr * tau;

    // ── Profit estimate: executable prices, held-to-expiry convergence ──────
    // Sell the rich leg at its executable price (Derive bid when Derive is
    // rich), buy the cheap leg at its take price (Olive AMM premium / Derive ask).
    let entryPrice: number | null;
    let exitPrice: number | null;
    if (direction === 'buy_olive_sell_derive') {
      entryPrice = oq.mark;
      exitPrice = deriveBid ?? deriveMark;
    } else {
      entryPrice = deriveAsk ?? deriveMark;
      exitPrice = oq.mark;
    }
    const grossEdgeUsdc = entryPrice != null && exitPrice != null ? exitPrice - entryPrice : null;
    const netEdgeUsdc = grossEdgeUsdc != null ? grossEdgeUsdc - costsUsdc : null;
    const netAfterCapitalUsdc = netEdgeUsdc != null ? netEdgeUsdc - capitalCostUsdc : null;

    // Size cap: the binding Derive touch for THIS direction (selling into
    // the bid vs lifting the ask) against the Olive pool's per-custody
    // capacity — calls lock 1 underlying each, puts K USDC each. Live
    // custody balances win; the scalar AUM fallback is cruder and flagged.
    const bookSize =
      direction === 'buy_olive_sell_derive'
        ? hasBid
          ? dq.bidSize ?? 0
          : null
        : hasAsk
          ? dq.askSize ?? 0
          : null;
    const custody = cfg.poolCustodyByAsset[row.underlying];
    const custodyCap =
      custody == null
        ? null
        : row.kind === 'call'
          ? custody.underlyingFree
          : custody.usdcFreeUsd != null && row.strike > 0
            ? custody.usdcFreeUsd / row.strike
            : null;
    const poolLiquidityUsd = cfg.poolLiquidityUsdByAsset[row.underlying];
    const fallbackCap =
      poolLiquidityUsd != null && oliveCollateral > 0
        ? Math.floor(poolLiquidityUsd / oliveCollateral)
        : null;
    let maxExecutableSize = bookSize;
    if (bookSize != null) {
      const capacity = custodyCap ?? fallbackCap;
      if (capacity != null && capacity < bookSize) {
        maxExecutableSize = capacity;
        flags.push('pool_capacity_capped');
        if (custodyCap == null && poolLiquidityUsd != null) {
          flags.push('pool_capacity_estimated');
        }
      }
    }
    const totalNetUsdc =
      maxExecutableSize != null && maxExecutableSize > 0 && netAfterCapitalUsdc != null
        ? netAfterCapitalUsdc * maxExecutableSize
        : null;

    // Annualized ROI on the locked collateral — comparable across expiries.
    const roiApyPct =
      netAfterCapitalUsdc != null && oliveCollateral > 0 && tau > 0
        ? (netAfterCapitalUsdc / oliveCollateral) / tau * 100
        : null;

    // ~1σ settlement basis risk: |delta|·S·σ·sqrt(30min / 1yr) per unit.
    const delta = dq.greeks?.delta;
    const settlementBasisUsdc =
      typeof delta === 'number' && Number.isFinite(delta) && spot != null
        ? Math.abs(delta) * spot * dq.iv * Math.sqrt(SETTLEMENT_TWAP_HOURS / (365 * 24))
        : null;

    // Brief §3.2 cross-check, calibrated live: Derive's MARKS are model-
    // consistent (BS at their IV ≈ mark, verified to $0.09 RMS), so the mark
    // repriced at Olive's vol isolates the pure vol gap (≈ vega×Δσ), while
    // MID − MARK isolates book dislocation — where wide-book "edges" come from.
    let syntheticCrossCheckUsdc: number | null = null;
    let crossCheckDeviationUsdc: number | null = null;
    let bookVsMarkUsdc: number | null = null;
    if (deriveMid != null && deriveMark != null) {
      bookVsMarkUsdc = deriveMid - deriveMark;
    }
    if (deriveMark != null && tau > 0) {
      const forward = dq.forward ?? spot;
      const df = dq.discountFactor ?? 1;
      if (forward != null && forward > 0) {
        // Informational: mark repriced at OLIVE's vol and the vega-linear
        // residual. A large deviation here is expected whenever the vol gap
        // is wide (second-order vol effects) — NOT a data problem, so it no
        // longer raises the flag (it fired on 73% of rows at a 14-pt gap).
        const reprice = bsPrice({ forward, strike: row.strike, tauYears: tau, vol: oq.iv, discountFactor: df, kind: row.kind });
        syntheticCrossCheckUsdc = deriveMark - reprice;
        const vega = dq.greeks?.vega;
        if (typeof vega === 'number' && Number.isFinite(vega)) {
          // Derive reports vega per 1 vol POINT; the IV gap is a fraction —
          // multiply by 100 so both sides are in $ per full-vol unit.
          const expected = vega * 100 * (dq.iv - oq.iv);
          crossCheckDeviationUsdc = syntheticCrossCheckUsdc - expected;
        }
        // The actual consistency test: Derive's mark repriced at Derive's OWN
        // quoted IV. Live audits put this at $0.06-0.21 RMS — flag only real
        // mark/IV breakage, priced relative to the option.
        const selfReprice = bsPrice({ forward, strike: row.strike, tauYears: tau, vol: dq.iv, discountFactor: df, kind: row.kind });
        const markSelfBasisUsdc = deriveMark - selfReprice;
        if (Math.abs(markSelfBasisUsdc) > Math.max(0.3, 0.05 * Math.abs(deriveMark))) {
          flags.push('iv_mark_inconsistent');
        }
      }
    }
    // Dislocated book: the mid sits far off the model curve, so any "edge"
    // computed from executable prices is mostly book noise. Flag when the
    // dislocation rivals the claimed gross edge itself.
    if (bookVsMarkUsdc != null && grossEdgeUsdc != null) {
      if (Math.abs(bookVsMarkUsdc) > Math.max(1.0, 0.5 * Math.abs(grossEdgeUsdc))) {
        flags.push('price_distortion');
      }
    }

    // ── Ranking: USDC-native ────────────────────────────────────────────────
    const executable = !flags.some((f) => NON_EXECUTABLE_FLAGS.has(f));
    const base = totalNetUsdc ?? netAfterCapitalUsdc ?? Math.abs(spreadVols);
    let score = base * (executable ? 1 : 0.4);

    const isOpportunity = executable && Math.abs(spreadVols) >= cfg.ivSpreadThresholdVols;
    const isProfitable = netAfterCapitalUsdc != null && netAfterCapitalUsdc > 0;

    signals.push({
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
      roiApyPct: round(roiApyPct, 2),
      settlementBasisUsdc: round(settlementBasisUsdc, 4),
      syntheticCrossCheckUsdc: round(syntheticCrossCheckUsdc, 4),
      crossCheckDeviationUsdc: round(crossCheckDeviationUsdc, 4),
      bookVsMarkUsdc: round(bookVsMarkUsdc, 4),
      score: round(score, 2) ?? 0,
      isOpportunity,
      isProfitable,
      direction,
      flags,
      ts: now,
    });
  }

  signals.sort(
    (a, b) =>
      (b.isOpportunity ? 1 : 0) - (a.isOpportunity ? 1 : 0) ||
      (b.isProfitable ? 1 : 0) - (a.isProfitable ? 1 : 0) ||
      b.score - a.score,
  );
  return signals;
}
