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
 * Paradex dated options — public REST, no key (verified live from the US
 * host 2026-11-06, DATA_SOURCES.md rows 65-68).
 *  - GET /v1/markets (cached 10 min) → symbol BTC-USD-10NOV26-65000-C,
 *    base_currency, option_type CALL|PUT, strike_price, expiry_at (ms),
 *    settlement_currency USDC, funding_period_hours 0 (dated), trading_mode.
 *  - GET /v1/markets/summary?market=ALL → bid/ask (USD per 1 coin),
 *    bid_size/ask_size (coin), mark_price, mark_iv (fraction),
 *    underlying_price (spot). One read shared by every underlying per cycle.
 *  - Crypto options expire 08:00 UTC; TradFi ones (XAU, CL, US100, US500,
 *    stocks) at 16:00 UTC — only CRYPTO_BASES are read, since the grid keys
 *    contracts on the 08:00 expiry.
 *  - Empty side = "" (bid and size both blank). RFQ_ONLY markets have no book.
 */

export const PARADEX_BASE_URL = 'https://api.prod.paradex.trade/v1';
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'NEAR']);
const MARKETS_CACHE_TTL_MS = 10 * 60_000;
/** The ALL summary is one budgeted read; underlyings in the same cycle share it. */
const SUMMARY_TTL_MS = 5_000;
const NAME_RE = /^([A-Z0-9]+)-USD-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface RawMarket { symbol?: string; base_currency?: string; asset_kind?: string; option_type?: string; strike_price?: string; expiry_at?: number; funding_period_hours?: number; trading_mode?: string; settlement_currency?: string }
interface RawSummary { symbol?: string; bid?: string; bid_size?: string; ask?: string; ask_size?: string; mark_price?: string; mark_iv?: string; underlying_price?: string; created_at?: number; delta?: string; greeks?: { gamma?: string; vega?: string; theta?: string; rho?: string } }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

export function parseParadexMarket(m: RawMarket, underlying: string): OptionInstrument | null {
  const n = m.symbol ? NAME_RE.exec(m.symbol) : null;
  if (!n || m.asset_kind !== 'OPTION' || m.base_currency !== underlying || !CRYPTO_BASES.has(underlying)) return null;
  if (num(m.funding_period_hours) !== 0 || m.trading_mode === 'RFQ_ONLY') return null;
  const expiryTs = num(m.expiry_at);
  const strike = num(m.strike_price);
  const month = MONTHS.indexOf(n[3]!);
  if (expiryTs == null || strike == null || month < 0) return null;
  // The name's date at 08:00 UTC must be the market's own expiry (TradFi expires 16:00).
  if (Date.UTC(2000 + Number(n[4]), month, Number(n[2]), 8) !== expiryTs) return null;
  return {
    venue: 'paradex',
    instrumentId: m.symbol!,
    underlying,
    expiryTs,
    expiryDate: new Date(expiryTs).toISOString().slice(0, 10).replace(/-/g, ''),
    strike,
    kind: m.option_type === 'CALL' ? 'call' : 'put',
  };
}

export function mapParadexChain(markets: RawMarket[], summary: RawSummary[], underlying: string, now: number): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const bySymbol = new Map(summary.map((s) => [s.symbol, s]));
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  for (const m of markets) {
    const inst = parseParadexMarket(m, underlying);
    const s = inst ? bySymbol.get(inst.instrumentId) : undefined;
    if (!inst || !s) continue;
    const bid = pos(s.bid);
    const ask = pos(s.ask);
    instruments.push(inst);
    quotes.push({
      venue: 'paradex',
      instrumentId: inst.instrumentId,
      ts: num(s.created_at) ?? now,
      bid,
      bidSize: bid != null ? num(s.bid_size) ?? 0 : null,
      ask,
      askSize: ask != null ? num(s.ask_size) ?? 0 : null,
      mark: pos(s.mark_price),
      indexPrice: pos(s.underlying_price),
      iv: pos(s.mark_iv),
      ivSource: 'market',
      greeks: { delta: num(s.delta), gamma: num(s.greeks?.gamma), vega: num(s.greeks?.vega), theta: num(s.greeks?.theta), rho: num(s.greeks?.rho) },
      source: 'paradex:rest',
    });
  }
  return { instruments, quotes };
}

export class ParadexAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'paradex';
  private readonly health = new HealthTracker('paradex', 'paradex:rest', 90_000);
  // Far under the documented 1500 req / min per IP.
  private readonly limiter = new RateLimiter(200, 10_000, 10);
  private markets: { ts: number; list: RawMarket[] } | null = null;
  private summary: { ts: number; read: Promise<RawSummary[]> } | null = null;

  constructor(private readonly baseUrl: string = PARADEX_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string): Promise<T> {
    await this.limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Paradex ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async marketList(): Promise<RawMarket[]> {
    if (this.markets && Date.now() - this.markets.ts < MARKETS_CACHE_TTL_MS) return this.markets.list;
    const { results } = await this.get<{ results?: RawMarket[] }>('/markets');
    this.markets = { ts: Date.now(), list: results ?? [] };
    return this.markets.list;
  }

  private summaryAll(): Promise<RawSummary[]> {
    if (this.summary && Date.now() - this.summary.ts < SUMMARY_TTL_MS) return this.summary.read;
    const read = this.get<{ results?: RawSummary[] }>('/markets/summary?market=ALL').then((r) => r.results ?? []);
    this.summary = { ts: Date.now(), read };
    read.catch(() => (this.summary = null));
    return read;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    if (!CRYPTO_BASES.has(underlying)) return { instruments: [], quotes: [] };
    try {
      const [markets, summary] = await Promise.all([this.marketList(), this.summaryAll()]);
      const chain = mapParadexChain(markets, summary, underlying, Date.now());
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
    const byId = new Map(quotes.map((q) => [q.instrumentId, q]));
    return instruments.flatMap((i) => {
      const q = byId.get(i.instrumentId);
      return q?.iv != null ? [{ venue: 'paradex' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: null, source: 'paradex:rest' }] : [];
    });
  }
}
