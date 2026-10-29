import type {
  IVSurfacePoint,
  OptionInstrument,
  OptionQuote,
  OptionsVenueAdapter,
  Venue,
  VenueHealth,
} from '@options-arb/shared';
import { HealthTracker, RateLimiter, fetchWithTimeout } from '../util';

/**
 * Deribit options — public JSON-RPC over GET, no key (verified live from the
 * US host 2026-10-29, DATA_SOURCES.md rows 43-48). REFERENCE ONLY: the user
 * cannot trade Deribit, so every quote carries `reference_venue` (headline
 * blocking) — its prices inform the table, views and episodes, never the KPI.
 *  - GET /api/v2/public/get_book_summary_by_currency?currency=C&kind=option
 *    → whole chain, no sizes. BTC/ETH use the INVERSE book (currency=BTC|ETH:
 *    prices in coin per 1 coin, × index → USD; the liquid Deribit market);
 *    SOL has only the USDC-linear book (currency=USDC, base_currency SOL:
 *    prices in USDC per 1 SOL). ZEC is not listed.
 *  - Names: BTC-27NOV26-80000-C / SOL_USDC-6NOV26-98-C ("d" = decimal point
 *    in strikes); expiry 08:00 UTC on the named date. Empty side = null.
 *  - Sizes only via GET /public/ticker (best_bid_amount / best_ask_amount, in
 *    coin) — one request per instrument, so they are fetched only for rows
 *    where a Deribit leg makes a candidate pair (enrichQuotes).
 */

export const DERIBIT_BASE_URL = 'https://www.deribit.com/api/v2';
/** Size top-ups per enrich call (one ticker request each). */
export const DERIBIT_MAX_ENRICH = 20;
const NAME_RE = /^([A-Z]+)(_USDC)?-(\d{1,2})([A-Z]{3})(\d{2})-([\dd]+)-([CP])$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface RawSummary {
  instrument_name?: string;
  bid_price?: number | null;
  ask_price?: number | null;
  mark_price?: number | null;
  mark_iv?: number | null;
  estimated_delivery_price?: number | null;
  underlying_price?: number | null;
  open_interest?: number | null;
  creation_timestamp?: number;
}

interface RawTicker {
  instrument_name?: string;
  timestamp?: number;
  best_bid_price?: number | null;
  best_bid_amount?: number | null;
  best_ask_price?: number | null;
  best_ask_amount?: number | null;
  mark_price?: number | null;
  mark_iv?: number | null;
  index_price?: number | null;
  underlying_price?: number | null;
  open_interest?: number | null;
  greeks?: { delta?: number; gamma?: number; vega?: number; theta?: number; rho?: number };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const px = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/** Which summary book an underlying is read from. */
export function deribitCurrency(underlying: string): { currency: string; linear: boolean } | null {
  if (underlying === 'BTC' || underlying === 'ETH') return { currency: underlying, linear: false };
  if (underlying === 'SOL') return { currency: 'USDC', linear: true };
  return null;
}

export function parseDeribitName(name: string, underlying: string): OptionInstrument | null {
  const m = NAME_RE.exec(name);
  if (!m || m[1] !== underlying) return null;
  const month = MONTHS.indexOf(m[4]!);
  const strike = Number(m[6]!.replace('d', '.'));
  if (month < 0 || !Number.isFinite(strike)) return null;
  const expiryTs = Date.UTC(2000 + Number(m[5]), month, Number(m[3]), 8);
  return {
    venue: 'deribit',
    instrumentId: name,
    underlying,
    expiryTs,
    expiryDate: new Date(expiryTs).toISOString().slice(0, 10).replace(/-/g, ''),
    strike,
    kind: m[7] === 'C' ? 'call' : 'put',
  };
}

export function mapDeribitSummary(raw: { result?: RawSummary[] }, underlying: string): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const book = deribitCurrency(underlying);
  if (!book) return { instruments: [], quotes: [] };
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  for (const r of raw.result ?? []) {
    const inst = r.instrument_name ? parseDeribitName(r.instrument_name, underlying) : null;
    // The USDC book also lists BTC_USDC/ETH_USDC; only the book chosen above counts.
    if (!inst || r.instrument_name!.includes('_USDC') !== book.linear) continue;
    const index = px(r.estimated_delivery_price);
    // Inverse prices are coin per coin → USD at the index; linear are already USDC.
    const fx = book.linear ? 1 : index;
    if (fx == null) continue;
    const usd = (v: unknown) => {
      const p = px(v);
      return p != null ? p * fx : null;
    };
    instruments.push(inst);
    quotes.push({
      venue: 'deribit',
      instrumentId: inst.instrumentId,
      ts: num(r.creation_timestamp) ?? Date.now(),
      bid: usd(r.bid_price),
      bidSize: null,
      ask: usd(r.ask_price),
      askSize: null,
      mark: num(r.mark_price) != null ? num(r.mark_price)! * fx : null,
      indexPrice: index,
      forward: px(r.underlying_price),
      iv: px(r.mark_iv) != null ? px(r.mark_iv)! / 100 : null,
      ivSource: 'market',
      openInterest: num(r.open_interest),
      source: 'deribit:rest',
      flags: ['reference_venue'],
    });
  }
  return { instruments, quotes };
}

/** A ticker read: fresh top of book WITH sizes, same units as the summary mapping. */
export function mapDeribitTicker(raw: { result?: RawTicker }, linear: boolean): Partial<OptionQuote> | null {
  const t = raw.result;
  if (!t?.instrument_name) return null;
  const index = px(t.index_price);
  const fx = linear ? 1 : index;
  if (fx == null) return null;
  const bid = px(t.best_bid_price);
  const ask = px(t.best_ask_price);
  return {
    ts: num(t.timestamp) ?? Date.now(),
    bid: bid != null ? bid * fx : null,
    bidSize: bid != null ? num(t.best_bid_amount) : null,
    ask: ask != null ? ask * fx : null,
    askSize: ask != null ? num(t.best_ask_amount) : null,
    mark: num(t.mark_price) != null ? num(t.mark_price)! * fx : null,
    indexPrice: index,
    forward: px(t.underlying_price),
    iv: px(t.mark_iv) != null ? px(t.mark_iv)! / 100 : null,
    greeks: {
      delta: num(t.greeks?.delta),
      gamma: num(t.greeks?.gamma),
      vega: num(t.greeks?.vega),
      theta: num(t.greeks?.theta),
      rho: num(t.greeks?.rho),
    },
  };
}

export class DeribitAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'deribit';
  private readonly health = new HealthTracker('deribit', 'deribit:rest', 90_000);
  // Public non-matching-engine requests are credit-limited (~20 req/s); stay ≤ 10 req/s.
  private readonly limiter = new RateLimiter(100, 1_000, 10);

  constructor(private readonly baseUrl: string = DERIBIT_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string): Promise<T> {
    await this.limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Deribit ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    const book = deribitCurrency(underlying);
    if (!book) return { instruments: [], quotes: [] };
    try {
      const raw = await this.get<{ result?: RawSummary[] }>(`/public/get_book_summary_by_currency?currency=${book.currency}&kind=option`);
      if (!Array.isArray(raw.result)) throw new Error(`Deribit summary ${book.currency}: no result`);
      const chain = mapDeribitSummary(raw, underlying);
      this.health.ok();
      return chain;
    } catch (err) {
      this.health.fail(err);
      throw err;
    }
  }

  /**
   * Replace summary quotes (no sizes) with ticker reads (sizes), at most
   * DERIBIT_MAX_ENRICH per call. A failed ticker leaves that quote as it was
   * (size null → no clip total), never fails the cycle.
   */
  async enrichQuotes(quotes: OptionQuote[]): Promise<OptionQuote[]> {
    const out: OptionQuote[] = [];
    for (const q of quotes.slice(0, DERIBIT_MAX_ENRICH)) {
      try {
        const raw = await this.get<{ result?: RawTicker }>(`/public/ticker?instrument_name=${encodeURIComponent(q.instrumentId)}`);
        const t = mapDeribitTicker(raw, q.instrumentId.includes('_USDC'));
        out.push(t ? { ...q, ...t, source: 'deribit:ticker' } : q);
      } catch (err) {
        console.warn(`[deribit] ticker ${q.instrumentId} failed:`, err instanceof Error ? err.message : err);
        out.push(q);
      }
    }
    return out.concat(quotes.slice(DERIBIT_MAX_ENRICH));
  }

  async getInstruments(underlying: string): Promise<OptionInstrument[]> {
    return (await this.getChain(underlying)).instruments;
  }

  async getTicker(instrumentId: string): Promise<OptionQuote | null> {
    const underlying = NAME_RE.exec(instrumentId)?.[1];
    if (!underlying) return null;
    const q = (await this.getChain(underlying)).quotes.find((x) => x.instrumentId === instrumentId);
    return q ? ((await this.enrichQuotes([q]))[0] ?? null) : null;
  }

  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const { instruments, quotes } = await this.getChain(underlying);
    const byId = new Map(quotes.map((q) => [q.instrumentId, q]));
    return instruments.flatMap((i) => {
      const q = byId.get(i.instrumentId);
      return q?.iv != null
        ? [{ venue: 'deribit' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: q.forward ?? null, source: 'deribit:rest' }]
        : [];
    });
  }
}
