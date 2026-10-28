import type {
  IVSurfacePoint,
  OptionInstrument,
  OptionQuote,
  OptionsVenueAdapter,
  Venue,
  VenueHealth,
} from '@options-arb/shared';
import { HealthTracker, fetchWithTimeout } from '../util';

/**
 * Callput (Base, OLP-vault counterparty, keeper-executed requests) — the
 * app's own public market feed, no key (verified live 2026-10-28,
 * DATA_SOURCES.md rows 30-31, 39-41):
 *  - GET https://app-data-base.s3.ap-southeast-1.amazonaws.com/market-data.json
 *    (~3.5 MB, all assets, ETag + Last-Modified, Cache-Control no-cache):
 *    data.market[U].options[expirySec].{call,put}[] = { instrument
 *    "ETH-30OCT26-1600-C", strikePrice, markPrice, markIv (fraction),
 *    riskPremiumRateForBuy/ForSell, greeks, isOptionAvailable, expiry (sec,
 *    08:00 UTC) }; data.spotIndices[U]; data.futuresIndices[U]; timestamp (ms).
 *  - Execution price is mark ± a vault risk premium (docs pricing-mechanism):
 *    ask = mark·(1 + rpBuy), bid = mark·(1 − rpSell). That is OUR reading of
 *    the formula — the keeper fills later at its own price — so every quote
 *    is `indicative_quote` (headline-blocking) with no published size.
 *  - BTC/ETH only (plus synthetic stocks we don't track).
 */

export const CALLPUT_FEED_URL = 'https://app-data-base.s3.ap-southeast-1.amazonaws.com/market-data.json';
/** The feed is one multi-MB file for every asset: read it at most this often. */
const FEED_MIN_INTERVAL_MS = 60_000;
const NAME_RE = /^([A-Z0-9]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/;

interface RawOption {
  instrument?: string;
  strikePrice?: number;
  markPrice?: number | null;
  markIv?: number | null;
  riskPremiumRateForBuy?: number | null;
  riskPremiumRateForSell?: number | null;
  delta?: number | null;
  gamma?: number | null;
  vega?: number | null;
  theta?: number | null;
  openInterest?: string | number | null;
  isOptionAvailable?: boolean;
  expiry?: number;
}

export interface CallputFeed {
  data?: {
    market?: Record<string, { options?: Record<string, { call?: RawOption[]; put?: RawOption[] }> }>;
    spotIndices?: Record<string, number>;
    futuresIndices?: Record<string, number>;
  };
  timestamp?: number;
}

const num = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : null;
};
const pos = (v: unknown): number | null => {
  const x = num(v);
  return x != null && x > 0 ? x : null;
};

export function mapCallputChain(feed: CallputFeed, underlying: string): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  const market = feed.data?.market?.[underlying];
  const ts = num(feed.timestamp) ?? Date.now();
  const spot = pos(feed.data?.spotIndices?.[underlying]);
  const forward = pos(feed.data?.futuresIndices?.[underlying]);
  for (const byKind of Object.values(market?.options ?? {})) {
    for (const raw of [...(byKind.call ?? []), ...(byKind.put ?? [])]) {
      const m = raw.instrument ? NAME_RE.exec(raw.instrument) : null;
      const expirySec = num(raw.expiry);
      if (!m || m[1] !== underlying || expirySec == null) continue;
      const expiryTs = expirySec * 1000;
      const instrument: OptionInstrument = {
        venue: 'callput',
        instrumentId: raw.instrument!,
        underlying,
        expiryTs,
        expiryDate: new Date(expiryTs).toISOString().slice(0, 10).replace(/-/g, ''),
        strike: num(raw.strikePrice) ?? Number(m[5]),
        kind: m[6] === 'C' ? 'call' : 'put',
      };
      const mark = pos(raw.markPrice);
      const rpBuy = num(raw.riskPremiumRateForBuy);
      const rpSell = num(raw.riskPremiumRateForSell);
      const tradable = raw.isOptionAvailable !== false && mark != null;
      instruments.push(instrument);
      quotes.push({
        venue: 'callput',
        instrumentId: instrument.instrumentId,
        ts,
        bid: tradable && rpSell != null ? pos(mark! * (1 - rpSell)) : null,
        bidSize: null,
        ask: tradable && rpBuy != null ? pos(mark! * (1 + rpBuy)) : null,
        askSize: null,
        mark,
        indexPrice: spot,
        forward,
        iv: pos(raw.markIv),
        ivSource: 'model',
        greeks: { delta: num(raw.delta), gamma: num(raw.gamma), vega: num(raw.vega), theta: num(raw.theta), rho: null },
        openInterest: num(raw.openInterest),
        source: 'callput:s3-feed',
        flags: ['indicative_quote', 'execution_fee_unknown'],
      });
    }
  }
  return { instruments, quotes };
}

export class CallputAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'callput';
  private readonly health = new HealthTracker('callput', 'callput:s3-feed', 3 * FEED_MIN_INTERVAL_MS);
  private feed: CallputFeed | null = null;
  private fetchedAt = 0;
  private etag: string | null = null;
  private inflight: Promise<CallputFeed> | null = null;

  constructor(private readonly feedUrl: string = CALLPUT_FEED_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  /** One shared read for every underlying; conditional GET skips the body when unchanged. */
  private async getFeed(): Promise<CallputFeed> {
    if (this.feed && Date.now() - this.fetchedAt < FEED_MIN_INTERVAL_MS) return this.feed;
    this.inflight ??= (async () => {
      try {
        const res = await fetchWithTimeout(
          this.feedUrl,
          { headers: { Accept: 'application/json', ...(this.etag && this.feed ? { 'If-None-Match': this.etag } : {}) } },
          20_000,
        );
        if (res.status === 304 && this.feed) {
          this.fetchedAt = Date.now();
          return this.feed;
        }
        if (!res.ok) throw new Error(`Callput feed: HTTP ${res.status}`);
        this.feed = (await res.json()) as CallputFeed;
        this.etag = res.headers.get('etag');
        this.fetchedAt = Date.now();
        return this.feed;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    try {
      const chain = mapCallputChain(await this.getFeed(), underlying);
      this.health.ok();
      return chain;
    } catch (err) {
      this.health.fail(err);
      throw err;
    }
  }

  async getInstruments(underlying: string): Promise<OptionInstrument[]> {
    return (await this.getChain(underlying)).instruments;
  }

  async getTicker(instrumentId: string): Promise<OptionQuote | null> {
    const underlying = NAME_RE.exec(instrumentId)?.[1];
    if (!underlying) return null;
    return (await this.getChain(underlying)).quotes.find((q) => q.instrumentId === instrumentId) ?? null;
  }

  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const { instruments, quotes } = await this.getChain(underlying);
    return instruments.flatMap((i, k) =>
      quotes[k]?.iv != null
        ? [{ venue: 'callput' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: quotes[k].iv!, forward: quotes[k].forward ?? null, source: 'callput:s3-feed' }]
        : [],
    );
  }
}
