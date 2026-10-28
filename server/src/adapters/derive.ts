import {
  type IVSurfacePoint,
  type OptionInstrument,
  type OptionQuote,
  type OptionsVenueAdapter,
  type SviSlice,
  type Venue,
  type VenueHealth,
  type VenueMarketState,
  sampleSviSlice,
} from '@options-arb/shared';
import { HealthTracker, RateLimiter, fetchWithTimeout } from '../util';

/**
 * Derive.xyz public API client (v3) + legacy-host fallback.
 *
 * Conventions verified live (see DATA_SOURCES.md §1):
 *  - HTTP is POST with the flat params object as the body (NO JSON-RPC envelope).
 *  - public/get_instruments does not exist on v3; use public/get_all_instruments.
 *  - Tickers come back with abbreviated keys (b/B/a/A/M/I, option_pricing.i …)
 *    and ALL numerics serialized as strings.
 *  - get_latest_signed_feeds nests: spot_data.{CCY}.price and
 *    vol_data.{CCY}.{expirySec}.vol_data.SVI_*; SVI params are normalized by
 *    SVI_refTau (IV = sqrt(w/refTau) at any strike).
 *  - v3 REST was observed returning zeroed books; the legacy host populates
 *    them, so bid/ask/OI can be merged from there.
 *  - Public rate limits: 5 TPS / 25 req per 5s per IP.
 */

const INSTRUMENT_NAME_RE = /^([A-Z0-9]+)-(\d{8})-([\d_]+)-([CP])(?:-\d+)?$/;
const INSTRUMENT_CACHE_TTL_MS = 60 * 60 * 1000;
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

/** Derive serializes every numeric as a string — parse defensively. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toPx(v: unknown): number | null {
  const n = toNum(v);
  return n != null && n > 0 ? n : null;
}

export interface RawTickerSlim {
  t?: unknown;
  b?: unknown;
  B?: unknown;
  a?: unknown;
  A?: unknown;
  M?: unknown;
  I?: unknown;
  minp?: unknown;
  maxp?: unknown;
  f?: unknown;
  stats?: { oi?: unknown } & Record<string, unknown> | null;
  option_pricing?: Record<string, unknown> | null;
}

interface RawInstrument {
  instrument_name?: string;
  is_active?: boolean;
  option_details?: {
    strike?: unknown;
    expiry?: unknown;
  } | null;
}

type VolFeedEntry = {
  currency?: string;
  expiry?: unknown;
  timestamp?: unknown;
  confidence?: unknown;
  vol_data?: Record<string, unknown>;
};

type FeedsResponse = {
  spot_data?: Record<string, Record<string, unknown>>;
  fwd_data?: Record<string, Record<string, Record<string, unknown>>>;
  vol_data?: Record<string, Record<string, VolFeedEntry>>;
  rate_data?: unknown;
};

/** Parse `{CURRENCY}-{YYYYMMDD}-{STRIKE}-{C|P}` (fractional strikes use `_`). */
export function parseDeriveInstrumentName(name: string): {
  underlying: string;
  expiryDate: string;
  strike: number;
  kind: 'call' | 'put';
} | null {
  const m = INSTRUMENT_NAME_RE.exec(name.trim().toUpperCase());
  if (!m) return null;
  const strike = Number(m[3].replace('_', '.'));
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying: m[1],
    expiryDate: m[2],
    strike,
    kind: m[4] === 'C' ? 'call' : 'put',
  };
}

/** Coerce a venue timestamp that may arrive as string sec/ms or number. */
function toMs(v: unknown): number | null {
  const n = toNum(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Derive's canonical expiry time is 08:00 UTC on the expiry date. */
export function expiryDateToTs(expiryDate: string): number {
  const y = Number(expiryDate.slice(0, 4));
  const mo = Number(expiryDate.slice(4, 6));
  const d = Number(expiryDate.slice(6, 8));
  return Date.UTC(y, mo - 1, d, 8, 0, 0);
}

/** Map an abbreviated slim ticker into the normalized OptionQuote shape. */
export function mapDeriveTicker(instrumentName: string, raw: RawTickerSlim, source: string): OptionQuote {
  const op = raw.option_pricing ?? {};
  // Zero prices/sizes mean "no quote" (seen on v3's zeroed books), not a real 0.
  return {
    venue: 'derive',
    instrumentId: instrumentName,
    ts: toMs(raw.t) ?? Date.now(),
    bid: toPx(raw.b),
    bidSize: toPx(raw.B),
    ask: toPx(raw.a),
    askSize: toPx(raw.A),
    mark: toNum(op.m) ?? toNum(raw.M),
    indexPrice: toPx(raw.I),
    iv: toNum(op.i),
    ivSource: 'market',
    greeks: {
      delta: toNum(op.d),
      gamma: toNum(op.g),
      vega: toNum(op.v),
      theta: toNum(op.t),
      rho: toNum(op.r),
    },
    forward: toNum(op.f),
    discountFactor: toNum(op.df),
    openInterest: toNum(raw.stats?.oi),
    source,
  };
}

function mapInstrument(raw: RawInstrument): OptionInstrument | null {
  const name = raw.instrument_name;
  if (!name || raw.is_active === false) return null;
  const parsed = parseDeriveInstrumentName(name);
  if (!parsed) return null;
  const detailsTs = toMs(raw.option_details?.expiry);
  const detailsStrike = toNum(raw.option_details?.strike);
  return {
    venue: 'derive',
    instrumentId: name,
    underlying: parsed.underlying,
    expiryTs: detailsTs ?? expiryDateToTs(parsed.expiryDate),
    expiryDate: parsed.expiryDate,
    strike: detailsStrike != null && detailsStrike > 0 ? detailsStrike : parsed.strike,
    kind: parsed.kind,
  };
}

class DeriveHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly limiter: RateLimiter,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.limiter.acquire();
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      this.onError?.(err);
      throw new Error(`Derive ${method}: network error (${String(err)})`);
    }
    const text = await res.text();
    let json: { result?: T; error?: { message?: string; data?: string } } & Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      this.onError?.(new Error(text.slice(0, 200)));
      throw new Error(`Derive ${method}: non-JSON response (${res.status})`);
    }
    if (!res.ok || json.error) {
      const msg = json.error?.message ?? json.error?.data ?? text.slice(0, 200);
      this.onError?.(new Error(String(msg)));
      throw new Error(`Derive ${method}: ${res.status} ${String(msg)}`);
    }
    return json.result ?? (json as unknown as T);
  }
}

export interface DeriveAdapterOptions {
  baseUrl: string;
  legacyUrl: string;
  /** merge: fill zeroed v3 books from legacy; v3: v3 only; legacy: legacy only. */
  bookSource: 'merge' | 'v3' | 'legacy';
}

export class DeriveAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'derive';

  private readonly client: DeriveHttpClient;
  private readonly legacy: DeriveHttpClient;
  private readonly health = new HealthTracker('derive', 'derive:v3-rest', 90_000);
  private readonly legacyHealth = new HealthTracker('derive', 'derive:legacy-rest', 90_000);
  private readonly bookSource: 'merge' | 'v3' | 'legacy';

  private instrumentCache = new Map<string, { ts: number; rows: OptionInstrument[] }>();
  private feedCache = new Map<string, { ts: number; feeds: FeedsResponse }>();

  constructor(opts: DeriveAdapterOptions) {
    const limiter = new RateLimiter(210, 5_000, 24);
    this.client = new DeriveHttpClient(opts.baseUrl, limiter, (e) => this.health.fail(e));
    this.legacy = new DeriveHttpClient(opts.legacyUrl, limiter, (e) => this.legacyHealth.fail(e));
    this.bookSource = opts.bookSource;
  }

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  getLegacyHealth(): VenueHealth {
    return this.legacyHealth.snapshot();
  }

  async getInstruments(underlying: string): Promise<OptionInstrument[]> {
    const cached = this.instrumentCache.get(underlying);
    if (cached && Date.now() - cached.ts < INSTRUMENT_CACHE_TTL_MS) return cached.rows;

    const rows: OptionInstrument[] = [];
    let page = 1;
    let numPages = 1;
    do {
      const res = await this.client.call<{ instruments?: RawInstrument[]; pagination?: { num_pages?: number } }>(
        'public/get_all_instruments',
        { instrument_type: 'option', expired: false, currency: underlying, page, page_size: 1000 },
      );
      for (const raw of res.instruments ?? []) {
        const inst = mapInstrument(raw);
        if (inst && inst.underlying === underlying) rows.push(inst);
      }
      numPages = Math.max(1, toNum(res.pagination?.num_pages) ?? 1);
      page++;
    } while (page <= numPages);

    rows.sort((a, b) => a.expiryTs - b.expiryTs || a.strike - b.strike);
    this.instrumentCache.set(underlying, { ts: Date.now(), rows });
    this.health.ok();
    return rows;
  }

  async getTickers(underlying: string, expiryDate: string): Promise<OptionQuote[]> {
    const params = {
      instrument_type: 'option',
      currency: underlying,
      expiry_date: Number(expiryDate),
    };
    const v3 = await this.client.call<{ tickers?: Record<string, RawTickerSlim> }>(
      'public/get_tickers',
      params,
    );
    this.health.ok();
    let entries = Object.entries(v3.tickers ?? {});

    if (this.bookSource !== 'v3' && entries.length > 0) {
      try {
        const legacy = await this.legacy.call<{ tickers?: Record<string, RawTickerSlim> }>(
          'public/get_tickers',
          params,
        );
        this.legacyHealth.ok();
        const legacyEntries = Object.entries(legacy.tickers ?? {});
        if (legacyEntries.length > 0) {
          if (this.bookSource === 'legacy') {
            entries = legacyEntries;
          } else {
            // merge: v3 marks/IV are trustworthy; books may be zeroed there.
            const legacyMap = new Map(legacyEntries);
            entries = entries.map(([name, t]) => {
              const lt = legacyMap.get(name);
              if (!lt) return [name, t] as const;
              const v3BookEmpty = !toPx(t.b) && !toPx(t.a);
              const legacyBookLive = toPx(lt.b) != null || toPx(lt.a) != null;
              if (v3BookEmpty && legacyBookLive) {
                return [name, { ...t, b: lt.b, B: lt.B, a: lt.a, A: lt.A, stats: lt.stats ?? t.stats }] as const;
              }
              return [name, t] as const;
            });
          }
        }
      } catch {
        // legacy merge is best-effort; keep v3 data
      }
    }

    return entries.map(([name, raw]) =>
      mapDeriveTicker(name, raw, this.bookSource === 'legacy' ? 'derive:legacy-rest' : 'derive:v3-rest'),
    );
  }

  async getTicker(instrumentId: string): Promise<OptionQuote | null> {
    const parsed = parseDeriveInstrumentName(instrumentId);
    if (!parsed) return null;
    const quotes = await this.getTickers(parsed.underlying, parsed.expiryDate);
    return quotes.find((q) => q.instrumentId === instrumentId) ?? null;
  }

  async getSVISlices(underlying: string): Promise<SviSlice[]> {
    const feeds = await this.getFeeds(underlying);
    const byExpiry = feeds.vol_data?.[underlying] ?? {};
    const slices: SviSlice[] = [];
    for (const entry of Object.values(byExpiry)) {
      const svi = entry.vol_data ?? {};
      const expiryTs = toMs(entry.expiry);
      const fwd = toNum(svi.SVI_fwd);
      const refTau = toNum(svi.SVI_refTau);
      const a = toNum(svi.SVI_a);
      const b = toNum(svi.SVI_b);
      const m = toNum(svi.SVI_m);
      const rho = toNum(svi.SVI_rho);
      const sigma = toNum(svi.SVI_sigma);
      if (
        expiryTs == null ||
        fwd == null || fwd <= 0 ||
        refTau == null || refTau <= 0 ||
        a == null || b == null || m == null || rho == null || sigma == null
      ) {
        continue;
      }
      slices.push({
        expiryTs,
        currency: entry.currency ?? underlying,
        refTau,
        forward: fwd,
        a, b, m, rho, sigma,
        ts: toMs(entry.timestamp) ?? undefined,
        confidence: toNum(entry.confidence),
      });
    }
    slices.sort((a, b) => a.expiryTs - b.expiryTs);
    return slices;
  }

  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const slices = await this.getSVISlices(underlying);
    const points: IVSurfacePoint[] = [];
    for (const slice of slices) {
      for (const { strike, iv } of sampleSviSlice(slice)) {
        points.push({
          venue: 'derive',
          underlying,
          expiryTs: slice.expiryTs,
          strike,
          iv,
          forward: slice.forward,
          source: 'derive:svi-signed-feed',
        });
      }
    }
    return points;
  }

  async getMarketState(underlying: string): Promise<VenueMarketState | null> {
    const feeds = await this.getFeeds(underlying);
    const spot = toPx(feeds.spot_data?.[underlying]?.price);
    if (spot == null) return null;
    return {
      venue: 'derive',
      underlying,
      spot,
      ts: Date.now(),
      source: 'derive:svi-signed-feed',
    };
  }

  private async getFeeds(underlying: string): Promise<FeedsResponse> {
    const cached = this.feedCache.get(underlying);
    if (cached && Date.now() - cached.ts < FEED_CACHE_TTL_MS) return cached.feeds;
    const feeds = await this.client.call<FeedsResponse>('public/get_latest_signed_feeds', {
      currency: underlying,
    });
    this.health.ok();
    this.feedCache.set(underlying, { ts: Date.now(), feeds });
    return feeds;
  }
}
