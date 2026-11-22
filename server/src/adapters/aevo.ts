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
 * Aevo options — public REST, no key (read live 2026-11-22, DATA_SOURCES row 91):
 *  - GET /markets?asset=X&instrument_type=OPTION → every listed option:
 *    instrument_name BTC-27NOV26-60000-C, expiry (ns, 08:00 UTC), strike,
 *    option_type, is_active, amount_step. Cached 10 min (expiry list).
 *  - GET /options-chain?asset=X&expiry=<ns> → per strike: ticker.bid/ask
 *    { price (USD per 1 coin), volume (coin), iv }, mark_price (USD), iv
 *    (fraction), delta. Empty side: price "0". One read per expiry.
 *  - GET /index?asset=X → { price } (Aevo's spot index).
 *  Assets with options: BTC, ETH, SOL, HYPE. Rate limits are per IP and not
 *  published (429 + X-RETRY-AFTER) — reads are spaced like Hypercall's.
 */

export const AEVO_BASE_URL = 'https://api.aevo.xyz';
export const AEVO_ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const MARKETS_TTL_MS = 10 * 60_000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const NAME_RE = /^([A-Z0-9]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/;

interface RawMarket { instrument_name?: string; expiry?: string; strike?: string; option_type?: string; is_active?: boolean; underlying_asset?: string }
interface RawSide { price?: string; volume?: string; iv?: string }
interface RawChainOption { instrument_name?: string; mark_price?: string; iv?: string; delta?: string; strike?: string; expiry?: string; ticker?: { bid?: RawSide; ask?: RawSide } }
export interface AevoChain { asset?: string; options?: { calls?: RawChainOption[] | null; puts?: RawChainOption[] | null } }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/** BTC-27NOV26-60000-C → instrument (expiry from the name, 08:00 UTC). */
export function parseAevoName(name: string, underlying: string): OptionInstrument | null {
  const m = NAME_RE.exec(name);
  if (!m || m[1] !== underlying) return null;
  const month = MONTHS.indexOf(m[3]!);
  const strike = Number(m[5]);
  if (month < 0 || !Number.isFinite(strike)) return null;
  const year = 2000 + Number(m[4]);
  const day = Number(m[2]);
  return {
    venue: 'aevo',
    instrumentId: name,
    underlying,
    expiryTs: Date.UTC(year, month, day, 8),
    expiryDate: `${year}${String(month + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`,
    strike,
    kind: m[6] === 'C' ? 'call' : 'put',
  };
}

/** One expiry's options-chain → instruments + USD quotes (sizes in coin). */
export function mapAevoChain(chain: AevoChain, underlying: string, index: number | null, now: number): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  for (const o of [...(chain.options?.calls ?? []), ...(chain.options?.puts ?? [])]) {
    const inst = o.instrument_name ? parseAevoName(o.instrument_name, underlying) : null;
    if (!inst) continue;
    // The name's date and the row's expiry (ns) must agree.
    const expNs = num(o.expiry);
    if (expNs != null && Math.round(expNs / 1e6) !== inst.expiryTs) continue;
    const bid = pos(o.ticker?.bid?.price);
    const ask = pos(o.ticker?.ask?.price);
    instruments.push(inst);
    quotes.push({
      venue: 'aevo',
      instrumentId: inst.instrumentId,
      ts: now,
      bid,
      bidSize: bid != null ? num(o.ticker?.bid?.volume) ?? 0 : null,
      ask,
      askSize: ask != null ? num(o.ticker?.ask?.volume) ?? 0 : null,
      mark: pos(o.mark_price),
      indexPrice: index,
      iv: pos(o.iv),
      ivSource: 'market',
      greeks: { delta: num(o.delta), gamma: null, vega: null, theta: null, rho: null },
      source: 'aevo:rest',
    });
  }
  return { instruments, quotes };
}

export class AevoAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'aevo';
  private readonly health = new HealthTracker('aevo', 'aevo:rest', 90_000);
  private readonly limiter = new RateLimiter(250, 2_000, 5);
  private readonly markets = new Map<string, { ts: number; expiries: string[] }>();

  constructor(private readonly baseUrl: string = AEVO_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string): Promise<T> {
    await this.limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Aevo ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Active expiries (ns strings), from /markets, cached 10 min. */
  private async expiries(asset: string): Promise<string[]> {
    const cached = this.markets.get(asset);
    if (cached && Date.now() - cached.ts < MARKETS_TTL_MS) return cached.expiries;
    const list = await this.get<RawMarket[]>(`/markets?asset=${asset}&instrument_type=OPTION`);
    if (!Array.isArray(list)) throw new Error(`Aevo /markets ${asset}: not an array`);
    const expiries = [...new Set(list.filter((m) => m.is_active !== false && m.underlying_asset === asset && m.expiry).map((m) => m.expiry!))].sort();
    this.markets.set(asset, { ts: Date.now(), expiries });
    return expiries;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    if (!AEVO_ASSETS.includes(underlying)) return { instruments: [], quotes: [] };
    try {
      const now = Date.now();
      const expiries = (await this.expiries(underlying)).filter((e) => Number(e) / 1e6 > now);
      const index = pos((await this.get<{ price?: string }>(`/index?asset=${underlying}`)).price);
      const instruments: OptionInstrument[] = [];
      const quotes: OptionQuote[] = [];
      for (const expiry of expiries) {
        const chain = await this.get<AevoChain>(`/options-chain?asset=${underlying}&expiry=${expiry}`);
        const mapped = mapAevoChain(chain, underlying, index, Date.now());
        instruments.push(...mapped.instruments);
        quotes.push(...mapped.quotes);
      }
      this.health.ok();
      return { instruments, quotes };
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
      return q?.iv != null ? [{ venue: 'aevo' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: null, source: 'aevo:rest' }] : [];
    });
  }
}
