export type OptionKind = 'call' | 'put';
/** Every venue the app knows; which are polled is config (VENUES). */
export type Venue = 'derive' | 'olive' | 'coincall' | 'hypercall' | 'callput' | 'bybit' | 'binance';

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

/** One comparison row: the same economic contract across venues. */
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
  /** One leg per venue that lists (or synthesizes) this contract. */
  legs: Partial<Record<Venue, LegSnapshot>>;
}

/** A venue's quote in the compact WS projection. */
export interface LiteQuote {
  iv: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
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
  /** Every venue's quote summary for this contract. */
  venues: Partial<Record<Venue, LiteQuote>>;
  note?: string;
  unmatchedReason?: string;
}

/** A runner-up venue pair for the same contract (compact). */
export interface PairAlternative {
  buyVenue: Venue;
  sellVenue: Venue;
  ivSpreadVols: number | null;
  entryPriceUsdc: number | null;
  exitPriceUsdc: number | null;
  netAfterCapitalUsdc: number | null;
  maxExecutableSize: number | null;
  totalNetUsdc: number | null;
  honestTotalNetUsdc: number | null;
  flags: string[];
}

export interface Signal {
  pairKey: string;
  underlying: string;
  expiryDate: string;
  expiryTs: number;
  strike: number;
  kind: OptionKind;
  /** Sell-venue IV − buy-venue IV, in vol points (3.5 = 3.5%); ≥ 0. */
  ivSpreadVols: number | null;
  /** Relative spread vs the sell venue's IV, in bps. */
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
  /** Net edge minus full-collateral opportunity cost per unit, USDC. */
  netAfterCapitalUsdc: number | null;
  /** Round-trip costs (fees + gas) per unit, USDC. */
  costsUsdc: number;
  /** Opportunity cost of a full collateral lock, USDC per unit (conservative). */
  capitalCostUsdc: number;
  /** Executable size: the binding book touch on each book leg (buy venue's
   * ask, sell venue's bid), capped by Olive pool capacity when Olive is a
   * leg (AMM depth beyond collateral is unknown — flagged). */
  maxExecutableSize: number | null;
  /** netAfterCapitalUsdc × maxExecutableSize — size-capped total estimate. */
  totalNetUsdc: number | null;
  /** Expected AVERAGE fill price when the clip's own size moves the pricing
   * rate along the pool's borrow curve (execution_moves_rate) — the quote
   * above understates what a full fill actually costs. Null when the model
   * doesn't apply (no curve/custody data, LP-only direction, mismatch). */
  expectedEntryUsdc: number | null;
  /** netAfterCapitalUsdc re-derived at expectedEntryUsdc, per unit. */
  expectedNetAfterCapitalUsdc: number | null;
  /** expectedNetAfterCapitalUsdc × size − order fee — the honest clip total. */
  expectedTotalNetUsdc: number | null;
  /** Net-after-capital ROI on Olive's locked collateral, annualized %. */
  roiApyPct: number | null;
  /** ~1σ settlement basis risk between the two venues' settlement prices, per unit, USDC. A risk figure, not a cost. */
  settlementBasisUsdc: number | null;
  /** Reference book leg's MARK minus that leg repriced at the other venue's
   * vol — the pure vol-gap measure (Derive marks are model-consistent; verified live). */
  syntheticCrossCheckUsdc: number | null;
  /** Cross-check minus its vega×Δσ expectation — large |values| flag
   * price distortion (stale/wide/deep-ITM books) rather than vol mispricing. */
  crossCheckDeviationUsdc: number | null;
  /** Reference book leg's MID minus its MARK — book dislocation from the model
   * curve. Large values mean the displayed edge is book noise, not vol mispricing. */
  bookVsMarkUsdc: number | null;
  /** USDC-native ranking score: size-capped net when size is known, else net per unit. */
  score: number;
  isOpportunity: boolean;
  /** True when netAfterCapitalUsdc > 0 — the profitability estimate. */
  isProfitable: boolean;
  /** Venue you buy on (pay its ask / AMM premium). */
  buyVenue: Venue | null;
  /** Venue you sell on (hit its bid). `direction_limited` when users can't short there. */
  sellVenue: Venue | null;
  /** Runner-up vol-consistent venue pairs for this contract, best first. */
  alternatives?: PairAlternative[];
  flags: string[];
  ts: number;
}

export interface VenueHealthSnapshot {
  /** One entry per polled venue. */
  venues: Partial<Record<Venue, VenueHealth>>;
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
  /** Top headline-profitable clips (see isHeadlineProfitable) in the
   *  two-leg-executable direction (buy Olive / sell Derive), by honest total. */
  topExecutable: Signal[];
  /** Top headline-profitable clips in any direction (the LP-only fallback headline). */
  topAny: Signal[];
  /** Headline-profitable rows in the executable direction. */
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
