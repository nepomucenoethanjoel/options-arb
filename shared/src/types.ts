export type OptionKind = 'call' | 'put';
export type Venue = 'derive' | 'olive';

export const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** A single listed option contract on a venue. */
export interface OptionInstrument {
  venue: Venue;
  /** Venue-native instrument name, e.g. `ETH-20261030-2900-C`. */
  instrumentId: string;
  /** Normalized underlying ticker, e.g. `ETH`. */
  underlying: string;
  /** Expiry timestamp, ms UTC. */
  expiryTs: number;
  /** Expiry date `YYYYMMDD` (venue calendar day). */
  expiryDate: string;
  strike: number;
  kind: OptionKind;
}

export interface OptionGreeks {
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
}

/**
 * A quote for one option. `iv` is a fraction (0.55 = 55%).
 * `ivSource` distinguishes market-implied IV (Derive) from model vol
 * (Olive's EWMA realized-vol oracle) — the dashboard labels these differently.
 */
export interface OptionQuote {
  venue: Venue;
  instrumentId: string;
  ts: number;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  mark: number | null;
  /** Underlying index/spot price as seen by the venue, if published. */
  indexPrice?: number | null;
  iv: number | null;
  ivSource: 'market' | 'model';
  greeks?: OptionGreeks;
  forward?: number | null;
  discountFactor?: number | null;
  openInterest?: number | null;
  /** Where this quote came from, e.g. `derive:v3-rest`, `olive:synthetic-amm`. */
  source: string;
}

export interface IVSurfacePoint {
  venue: Venue;
  underlying: string;
  expiryTs: number;
  strike: number;
  iv: number;
  forward: number | null;
  source: string;
}

/** Live per-underlying market context from a venue. */
export interface VenueMarketState {
  venue: Venue;
  underlying: string;
  spot: number | null;
  /** Olive only: per-asset EWMA realized vol (their BS pricing input). */
  modelVol?: number | null;
  /** Olive only: fixed rates used by their pricer (null = unknown, priced flat). */
  tokenRateApr?: number | null;
  usdcRateApr?: number | null;
  /** Strike bounds if the venue enforces them (Olive ±1σ bands). */
  strikeBounds?: { lower: number | null; upper: number | null };
  ts: number;
  source: string;
  /** Set when values were derived heuristically or with unknown inputs. */
  caveats?: string[];
}

export type VenueHealthStatus = 'ok' | 'stale' | 'error' | 'unknown';

export interface VenueHealth {
  venue: Venue;
  /** Data path identifier, e.g. `derive:v3-rest`, `olive:onchain`. */
  source: string;
  status: VenueHealthStatus;
  lastSuccessTs: number | null;
  lastError: string | null;
  detail?: string;
}

export type MatchType = 'exact_match' | 'interpolated' | 'unmatched_no_counterpart';

export interface LegSnapshot {
  venue: Venue;
  instrumentId: string | null;
  quote: OptionQuote | null;
  /** Provenance/semantics note, e.g. `amm_synthetic`, `nearest_strike`. */
  note?: string;
  /** Strike offset vs this row's contract when matched to a different strike
   *  (interpolated match). Non-zero legs are NOT the same payoff. */
  strikeOffset?: number;
  /** Expiry offset in days vs this row's contract (matched within the
   *  ±tolerance window). Non-zero legs settle at different times. */
  expiryOffsetDays?: number;
}

/** One comparison row: the same economic contract on both venues. */
export interface MatchRow {
  pairKey: string;
  underlying: string;
  expiryTs: number;
  expiryDate: string;
  strike: number;
  kind: OptionKind;
  matchType: MatchType;
  /** Why a counterpart was not found, e.g. `strike_out_of_olive_bounds`. */
  unmatchedReason?: string;
  derive: LegSnapshot;
  olive: LegSnapshot;
}

/** Compact row projection for the WS cycle push — everything the table/cards
 * render without nested quotes. Full detail lives behind GET /api/pair. */
export interface MatchRowLite {
  pairKey: string;
  underlying: string;
  expiryTs: number;
  expiryDate: string;
  strike: number;
  kind: OptionKind;
  matchType: MatchType;
  deriveIv: number | null;
  oliveIv: number | null;
  deriveBid: number | null;
  deriveAsk: number | null;
  olivePremium: number | null;
  note?: string;
  unmatchedReason?: string;
}

export type SignalDirection = 'buy_olive_sell_derive' | 'buy_derive_sell_olive';

export interface Signal {
  pairKey: string;
  underlying: string;
  expiryDate: string;
  expiryTs: number;
  strike: number;
  kind: OptionKind;
  /** Derive IV − Olive model vol, in vol points (3.5 = 3.5%). */
  ivSpreadVols: number | null;
  /** Relative spread vs Derive IV, in bps. */
  ivSpreadBps: number | null;
  /** Executable entry price (cheap venue, what you pay) per unit, USDC. */
  entryPriceUsdc: number | null;
  /** Executable exit price (rich venue, what you receive) per unit, USDC. */
  exitPriceUsdc: number | null;
  /** Gross edge (exit − entry) per unit, USDC. Held-to-expiry framing:
   * both legs are European on the same underlying, so payoffs converge and
   * the price difference locks in (settlement basis aside). */
  edgeUsdc: number | null;
  /** Gross edge minus round-trip fees/gas per unit, USDC. */
  netEdgeUsdc: number | null;
  /** Net edge minus Olive collateral opportunity cost per unit, USDC. */
  netAfterCapitalUsdc: number | null;
  /** Round-trip costs (fees + gas) per unit, USDC. */
  costsUsdc: number;
  /** Opportunity cost of Olive's full collateral lock, USDC per unit. */
  capitalCostUsdc: number;
  /** Executable size at the Derive touch (min of bid/ask size); the Olive
   * AMM quotes any size but its depth is unknown (flagged). */
  maxExecutableSize: number | null;
  /** netAfterCapitalUsdc × maxExecutableSize — size-capped total estimate. */
  totalNetUsdc: number | null;
  /** Net-after-capital ROI on Olive's locked collateral, annualized %. */
  roiApyPct: number | null;
  /** ~1σ settlement basis risk (Derive 30-min TWAP vs Olive Stork print) per unit, USDC. A risk figure, not a cost. */
  settlementBasisUsdc: number | null;
  /** Derive MARK minus the Derive leg repriced at Olive's vol — the pure
   * vol-gap measure (their marks are model-consistent; verified live). */
  syntheticCrossCheckUsdc: number | null;
  /** Cross-check minus its vega×Δσ expectation — large |values| flag
   * price distortion (stale/wide/deep-ITM books) rather than vol mispricing. */
  crossCheckDeviationUsdc: number | null;
  /** Derive quoted MID minus Derive MARK — book dislocation from the model
   * curve. Large values mean the displayed edge is book noise, not vol mispricing. */
  bookVsMarkUsdc: number | null;
  /** USDC-native ranking score: size-capped net when size is known, else net per unit. */
  score: number;
  isOpportunity: boolean;
  /** True when netAfterCapitalUsdc > 0 — the profitability estimate. */
  isProfitable: boolean;
  direction: SignalDirection | null;
  flags: string[];
  ts: number;
}

export interface VenueHealthSnapshot {
  derive: VenueHealth;
  olive: VenueHealth;
  serverTime: number;
  pollIntervalMs: number;
  lastCycleMs: number | null;
  lastCycleDurationMs: number | null;
}

/**
 * Cross-asset KPI digest computed server-side once per cycle. Lets the
 * dashboard render the header, KPI strip and top clips without receiving
 * every underlying's signals (the WS push is per-underlying subscription).
 */
export interface SignalKpis {
  /** Top profitable clips in the two-leg-executable direction (buy Olive / sell Derive), by total. */
  topExecutable: Signal[];
  /** Top profitable clips in any direction (the LP-only fallback headline). */
  topAny: Signal[];
  /** Profitable rows in the executable direction. */
  executableProfitableCount: number;
  /** Profitable rows in LP-only directions (writing to the Olive pool). */
  lpOnlyProfitableCount: number;
  /** Rows currently flagged as threshold opportunities (either direction). */
  opportunitiesCount: number;
  /** Σ of each pool's BEST single executable clip — rows on the same
   *  underlying share custody collateral, so per-row totals can't be summed. */
  totalExecutableUsd: number;
  /** Closest-to-profitable executable-direction row (clean book), best net/contract. */
  closest: Signal | null;
}
