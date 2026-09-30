import {
  type IVSurfacePoint,
  type OliveRateCurvePoint,
  type OptionInstrument,
  type OptionKind,
  type OptionQuote,
  type Venue,
  type VenueHealth,
  type VenueMarketState,
  yearsBetween,
} from '@options-arb/shared';
import { HealthTracker } from '../../util';
import { OliveOnChainReader, getPythSpot, oliveStrikeBounds } from './onchain';
import { OliveRestClient } from './rest';
import { buildSyntheticAmmQuote } from './synth';
import { OLIVE_MARKET_FILE_BASE, fetchOliveMarketFile, type OliveMarketFileData } from './marketFile';
import type { OliveRealtimeClient } from './realtime';
export type AmmQuoteResult =
  | { quote: OptionQuote }
  | { rejected: 'strike_out_of_olive_bounds' | 'beyond_max_tenor' | 'no_market_state' | 'no_vol' };

export interface OliveAdapterOptions {
  apiBase: string;
  apiKey: string;
  /** auto: REST health-check + on-chain values; rest: as auto (no market routes discovered yet); onchain: skip REST. */
  mode: 'auto' | 'rest' | 'onchain';
  staleMs: number;
  rpcUrl: string;
  tokenRateApr: number;
  usdcRateApr: number;
  /** Per-custody fixed rates (verified per-pool in Olive's UI); take precedence over the global pair. */
  rateOverrides: Record<string, { token: number; usdc: number }>;
  oliveMaxTenorDays: number;
  volOverrides: Record<string, number>;
  /** Strike band in sigmas; 0 = unbounded (live UI quotes to 2.5× spot). */
  strikeBoundSigmas: number;
  /** Optional realtime ticker stream (~1 s Stork spot); preferred over the
   * market-file spot while fresh. */
  realtime?: OliveRealtimeClient;
  realtimeMaxSpotAgeMs?: number;
}

const STATE_CACHE_TTL_MS = 10_000;
const MARKET_FILE_CACHE_TTL_MS = 10_000;

/**
 * Olive data adapter.
 *
 * Olive is an AMM: there is no discrete chain or order book to fetch. The
 * adapter therefore exposes market state (spot + per-asset model vol via
 * permissionless on-chain reads) and produces deterministic synthetic quotes
 * at arbitrary (strike, expiry, kind) within the live bounds. If/when the
 * backend REST API grows market-data routes (probe-olive.ts tracks this),
 * getInstruments/getTickers can be populated without downstream changes.
 */
export class OliveAdapter {
  readonly venue: Venue = 'olive';

  private readonly rest: OliveRestClient | null;
  private readonly onchain: OliveOnChainReader;
  private readonly restHealth: HealthTracker;
  private readonly onchainHealth: HealthTracker;
  private readonly opts: OliveAdapterOptions;
  private stateCache = new Map<string, { ts: number; state: VenueMarketState }>();
  private marketFileCache = new Map<string, { ts: number; data: OliveMarketFileData | null }>();
  private lastDetail: string | null = null;
  /** True when at least one underlying's vol comes from the live market file. */
  private volLive = false;

  /** Live market-state file (their frontend's own source), 10s-cached. */
  private async getMarketFile(underlying: string): Promise<OliveMarketFileData | null> {
    const cached = this.marketFileCache.get(underlying);
    if (cached && Date.now() - cached.ts < MARKET_FILE_CACHE_TTL_MS) return cached.data;
    const data = await fetchOliveMarketFile(OLIVE_MARKET_FILE_BASE, underlying).catch(() => null);
    this.marketFileCache.set(underlying, { ts: Date.now(), data });
    if (data) this.volLive = true;
    return data;
  }

  /** Live pool available-liquidity proxy from the market file (USD), or null. */
  async getPoolLiquidityUsd(underlying: string): Promise<number | null> {
    const data = await this.getMarketFile(underlying).catch(() => null);
    return data?.liquidityUsd ?? null;
  }

  /** Synchronous variant over the 10s cache — no fetch. */
  getCachedLiquidity(underlying: string): number | null {
    const cached = this.marketFileCache.get(underlying.toUpperCase());
    return cached?.ts && Date.now() - cached.ts < 60_000 ? cached?.data?.liquidityUsd ?? null : null;
  }

  /**
   * Live per-custody capacity over the 10s cache — no fetch. Calls are capped
   * by free underlying custody (units), puts by free USDC (÷ strike). `owned`
   * values enable post-execution utilization math (fills move the borrow
   * rate — the curve is convex near 100%). Null when the market file is
   * stale or omits the custody snapshot.
   */
  getCachedCapacity(
    underlying: string,
  ): {
    underlyingFree: number | null;
    usdcFreeUsd: number | null;
    underlyingOwned?: number | null;
    usdcOwnedUsd?: number | null;
    tokenCurve?: OliveRateCurvePoint[] | null;
    usdcCurve?: OliveRateCurvePoint[] | null;
  } | null {
    const cached = this.marketFileCache.get(underlying.toUpperCase());
    if (!cached?.ts || Date.now() - cached.ts > 60_000) return null;
    const d = cached.data;
    if (!d || (d.underlyingFree == null && d.usdcFreeUsd == null)) return null;
    return {
      underlyingFree: d.underlyingFree,
      usdcFreeUsd: d.usdcFreeUsd,
      underlyingOwned: d.underlyingOwned,
      usdcOwnedUsd: d.usdcOwnedUsd,
      tokenCurve: d.curves?.token ?? null,
      usdcCurve: d.curves?.usdc ?? null,
    };
  }

  isVolLive(): boolean {
    return this.volLive;
  }

  /** Realtime socket status for health reporting (null when disabled). */
  getRealtimeHealth(): { status: string; lastFrameAgeMs: number | null; assets: string[] } | null {
    return this.opts.realtime?.healthSummary() ?? null;
  }

  /** Subscribe to realtime spot ticks — returns an unsubscribe fn. */
  onSpot(cb: (tick: { asset: string; price: number; prevPrice: number | null }) => void): () => void {
    const client = this.opts.realtime;
    if (!client) return () => undefined;
    client.on('spot', cb);
    return () => client.off('spot', cb);
  }

  /** Per-custody fixed rates for an asset (fallback: the global pair). */
  private ratesFor(underlying: string): { tokenApr: number; usdcApr: number } {
    const u = underlying.toUpperCase();
    const o = this.opts.rateOverrides[u];
    if (o) return { tokenApr: o.token, usdcApr: o.usdc };
    return { tokenApr: this.opts.tokenRateApr, usdcApr: this.opts.usdcRateApr };
  }

  constructor(opts: OliveAdapterOptions) {
    this.opts = opts;
    this.rest = opts.mode === 'onchain' ? null : new OliveRestClient(opts.apiBase, opts.apiKey);
    this.onchain = new OliveOnChainReader(opts.rpcUrl);
    this.restHealth = new HealthTracker('olive', 'olive:rest', opts.staleMs);
    this.onchainHealth = new HealthTracker('olive', 'olive:onchain', opts.staleMs * 3);
  }

  /** No discrete chain (AMM continuum) until REST market routes are discovered. */
  async getInstruments(_underlying: string): Promise<OptionInstrument[]> {
    return [];
  }

  async getTickers(_underlying: string, _expiryDate: string): Promise<OptionQuote[]> {
    return [];
  }

  async getTicker(_instrumentId: string): Promise<OptionQuote | null> {
    return null;
  }

  /**
   * Spot (Pyth → on-chain oracle lastPrice) + model vol. The on-chain
   * volatility keeper is inactive since Olive's 2026-09-19 redeploy, so model
   * vol currently comes only from an explicit OLIVE_VOL_OVERRIDES entry; the
   * state carries that as a caveat so the UI can explain it. REST is probed
   * for health/indexer status only — no market-data routes documented yet
   * (DATA_SOURCES.md §2a).
   */
  async getMarketState(underlying: string): Promise<VenueMarketState | null> {
    const cached = this.stateCache.get(underlying);
    const rtTick = this.opts.realtime?.getSpot(underlying.toUpperCase()) ?? null;
    // Bust the cache when the realtime stream has moved away from the price
    // the cached state was built on (fast markets must not serve 10s-old spot).
    const movedSinceCache =
      cached && rtTick && cached.state.spot != null
        ? Math.abs(rtTick.price - cached.state.spot) / cached.state.spot > 0.0005
        : false;
    if (cached && !movedSinceCache && Date.now() - cached.ts < STATE_CACHE_TTL_MS) return cached.state;

    const caveats: string[] = [];
    if (this.rest) {
      try {
        await this.rest.health();
        this.restHealth.ok();
      } catch (e) {
        this.restHealth.fail(e);
        caveats.push('rest_unreachable');
      }
    }

    const u = underlying.toUpperCase();

    // Priority 1: the live market-state file (their frontend's own source —
    // live projected vol, live Stork spot, live pool AUM). Falls back to the
    // on-chain reader + Pyth + pinned overrides when unreachable.
    const file = await this.getMarketFile(u).catch(() => null);
    const [pythSpot, volResult] = await Promise.all([
      file?.spot != null ? Promise.resolve(null) : getPythSpot(u).catch(() => null),
      file?.vol != null ? Promise.resolve(null) : this.onchain.readModelVol(u, this.opts.volOverrides[u]).catch(() => null),
    ]);

    const oracle = volResult?.oracle;
    // Spot priority: realtime socket (~1 s) → market file (~5 s) → Pyth →
    // on-chain oracle lastPrice (stale-flagged).
    const rt = this.opts.realtime?.getSpot(u);
    let spot = rt?.price ?? file?.spot ?? pythSpot;
    if (rt) caveats.push('spot_realtime_socket');
    if (spot == null && oracle?.lastPrice != null) {
      spot = oracle.lastPrice;
      caveats.push(oracle.fresh ? 'spot_from_onchain_oracle' : 'spot_from_stale_onchain_oracle');
    }
    const vol = file?.vol ?? (volResult && 'vol' in volResult ? volResult.vol : null);

    if (file) this.onchainHealth.ok();
    else if (volResult != null) this.onchainHealth.ok();
    else this.onchainHealth.fail(new Error('market file + on-chain read failed'));

    if (file?.vol != null) {
      caveats.push('model_vol_live');
    } else if (volResult && 'vol' in volResult && volResult.vol != null) {
      caveats.push('model_vol_manual_override');
    } else if (volResult && 'reason' in volResult) {
      caveats.push(`model_vol_unavailable_${volResult.reason}`);
    } else {
      caveats.push('model_vol_unavailable_oracle_error');
    }

    // Pricing rates: live from the market file's per-custody borrow curves
    // at current utilization (their UI's "Fixed Rate (L/S)") when present;
    // the config pins are the fallback.
    const liveRates = file?.rates ?? null;
    if (liveRates) caveats.push('rates_live');

    const state: VenueMarketState = {
      venue: 'olive',
      underlying: u,
      spot,
      modelVol: vol,
      tokenRateApr: liveRates?.tokenApr ?? this.ratesFor(u).tokenApr,
      usdcRateApr: liveRates?.usdcApr ?? this.ratesFor(u).usdcApr,
      ts: Date.now(),
      source: file ? 'olive:market-file(live)' : this.rest ? 'olive:rest-health+onchain' : 'olive:onchain',
      caveats,
    };
    {
      const { tokenApr, usdcApr } = this.ratesFor(u);
      if (!liveRates && tokenApr === 0 && usdcApr === 0) state.caveats?.push('rates_unknown_priced_flat');
    }

    this.stateCache.set(underlying, { ts: Date.now(), state });
    this.lastDetail = caveats.join(', ') || null;
    return state;
  }

  /** Flat vol "surface" — honest representation of Olive's single per-asset σ. */
  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const state = await this.getMarketState(underlying);
    if (!state?.spot || state.modelVol == null) return [];
    const points: IVSurfacePoint[] = [];
    for (let i = 0; i <= 20; i++) {
      const strike = state.spot * (0.65 + (0.7 * i) / 20);
      points.push({
        venue: 'olive',
        underlying,
        expiryTs: 0,
        strike: Math.round(strike * 100) / 100,
        iv: state.modelVol,
        forward: state.spot,
        source: 'olive:model-vol',
      });
    }
    return points;
  }

  getCachedState(underlying: string): VenueMarketState | null {
    const cached = this.stateCache.get(underlying);
    if (!cached || Date.now() - cached.ts > this.opts.staleMs) return null;
    return cached.state;
  }

  /** Rates for pricing: the state's rates (live borrow-curve when the market
   * file is reachable — getMarketState resolves them) with the config pins
   * as the fallback. */
  private pricingRates(underlying: string, state: VenueMarketState | null): { tokenApr: number; usdcApr: number } {
    if (state?.tokenRateApr != null && state?.usdcRateApr != null) {
      return { tokenApr: state.tokenRateApr, usdcApr: state.usdcRateApr };
    }
    return this.ratesFor(underlying);
  }

  /** Live quotable strike band for an expiry, or null when unbounded. */
  getBounds(underlying: string, expiryTs: number, now = Date.now()): { lower: number; upper: number } | null {
    if (this.opts.strikeBoundSigmas <= 0) return null;
    const state = this.getCachedState(underlying);
    if (!state?.spot || state.modelVol == null) return null;
    return oliveStrikeBounds(state.spot, state.modelVol, yearsBetween(now, expiryTs), this.pricingRates(underlying, state), this.opts.strikeBoundSigmas);
  }

  /** Deterministic AMM quote at an arbitrary grid point. */
  getAmmQuote(
    underlying: string,
    strike: number,
    expiryTs: number,
    kind: OptionKind,
    now = Date.now(),
    stateOverride?: VenueMarketState | null,
  ): AmmQuoteResult {
    const state = stateOverride ?? this.getCachedState(underlying);
    if (!state || state.spot == null) return { rejected: 'no_market_state' };
    if (state.modelVol == null) return { rejected: 'no_vol' };
    const tau = yearsBetween(now, expiryTs);
    if (tau * 365 > this.opts.oliveMaxTenorDays) return { rejected: 'beyond_max_tenor' };
    const rates = this.pricingRates(underlying, state);
    if (this.opts.strikeBoundSigmas > 0) {
      const bounds = oliveStrikeBounds(state.spot, state.modelVol, tau, rates, this.opts.strikeBoundSigmas);
      if (strike < bounds.lower || strike > bounds.upper) {
        return { rejected: 'strike_out_of_olive_bounds' };
      }
    }
    return {
      quote: buildSyntheticAmmQuote({
        underlying,
        strike,
        expiryTs,
        kind,
        spot: state.spot,
        vol: state.modelVol,
        tokenRateApr: rates.tokenApr,
        usdcRateApr: rates.usdcApr,
        now,
      }),
    };
  }

  getHealth(): VenueHealth {
    const rest = this.restHealth.snapshot();
    const onchain = this.onchainHealth.snapshot();
    if (this.opts.mode === 'onchain') return this.decorate(onchain);
    if (this.rest == null) return this.decorate(onchain);
    // In auto mode the on-chain path is the value source; REST is advisory.
    // A live RPC read that still yields no model vol is a data gap, not an
    // outage — report 'stale' with the reason in detail.
    const status =
      onchain.status === 'ok' && this.lastDetail?.includes('model_vol_unavailable')
        ? 'stale'
        : onchain.status === 'ok'
          ? 'ok'
          : onchain.status === 'unknown'
            ? rest.status
            : onchain.status;
    return {
      venue: 'olive',
      source: 'olive:onchain(+rest)',
      status,
      lastSuccessTs: onchain.lastSuccessTs ?? rest.lastSuccessTs,
      lastError: onchain.lastError ?? rest.lastError,
      detail: `onchain:${onchain.status} rest:${rest.status}${this.lastDetail ? ` — ${this.lastDetail}` : ''}`,
    };
  }

  private decorate(h: VenueHealth): VenueHealth {
    return { ...h, detail: this.lastDetail ?? h.detail };
  }

  getDetailedHealth(): { rest: VenueHealth; onchain: VenueHealth } {
    return { rest: this.restHealth.snapshot(), onchain: this.onchainHealth.snapshot() };
  }
}
