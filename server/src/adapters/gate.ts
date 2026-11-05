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
 * Gate options — public REST v4, no key (verified live from the US host
 * 2026-11-05, DATA_SOURCES.md rows 58-61). USDT-margined, one family per
 * underlying ({U}_USDT): BTC, ETH, SOL, XRP, BNB, DOGE, HYPE, XAUT, SUI, ADA,
 * LTC, CL (no ZEC).
 *  - GET /options/contracts?underlying=U_USDT (cached 10 min) → name
 *    BTC_USDT-20261109-79500-C, strike_price, is_call, expiration_time (s,
 *    08:00 UTC), multiplier (coin per contract: BTC 0.01, SOL 1, XRP 10, DOGE
 *    1000), per-contract fee fields.
 *  - GET /options/tickers?underlying=U_USDT → bid1/ask1 price (USDT per 1
 *    coin) + size (contracts), mark_price, mark_iv (fraction), index_price,
 *    underlying_price (the expiry's forward). Empty side = price "0", size 0.
 *  Public limit 200 req / 10 s per endpoint per IP; one tickers read per
 *  underlying per cycle.
 */

export const GATE_BASE_URL = 'https://api.gateio.ws/api/v4';
const CONTRACT_CACHE_TTL_MS = 10 * 60_000;
const NAME_RE = /^([A-Z0-9]+)_USDT-(\d{4})(\d{2})(\d{2})-([\d.]+)-([CP])$/;

interface RawContract { name?: string; strike_price?: string; is_call?: boolean; expiration_time?: number; multiplier?: string; is_active?: boolean }
interface RawTicker { name?: string; bid1_price?: string; bid1_size?: number; ask1_price?: string; ask1_size?: number; mark_price?: string; mark_iv?: string; index_price?: string; underlying_price?: string; delta?: string; gamma?: string; vega?: string; theta?: string }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

export function parseGateName(name: string, underlying: string): OptionInstrument | null {
  const m = NAME_RE.exec(name);
  if (!m || m[1] !== underlying) return null;
  const expiryTs = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), 8);
  const strike = Number(m[5]);
  if (!Number.isFinite(strike)) return null;
  return { venue: 'gate', instrumentId: name, underlying, expiryTs, expiryDate: `${m[2]}${m[3]}${m[4]}`, strike, kind: m[6] === 'C' ? 'call' : 'put' };
}

/** Contracts + tickers → instruments + USD(T) quotes with sizes in coin. */
export function mapGateChain(contracts: RawContract[], tickers: RawTicker[], underlying: string, now: number): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const tick = new Map(tickers.map((t) => [t.name, t]));
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  for (const c of contracts) {
    const inst = c.name && c.is_active !== false ? parseGateName(c.name, underlying) : null;
    const coinPerContract = num(c.multiplier);
    const t = tick.get(c.name);
    if (!inst || !(coinPerContract && coinPerContract > 0) || !t) continue;
    const bid = pos(t.bid1_price);
    const ask = pos(t.ask1_price);
    instruments.push(inst);
    quotes.push({
      venue: 'gate',
      instrumentId: inst.instrumentId,
      ts: now,
      bid,
      bidSize: bid != null ? (num(t.bid1_size) ?? 0) * coinPerContract : null,
      ask,
      askSize: ask != null ? (num(t.ask1_size) ?? 0) * coinPerContract : null,
      mark: pos(t.mark_price),
      indexPrice: pos(t.index_price),
      forward: pos(t.underlying_price),
      iv: pos(t.mark_iv),
      ivSource: 'market',
      greeks: { delta: num(t.delta), gamma: num(t.gamma), vega: num(t.vega), theta: num(t.theta), rho: null },
      source: 'gate:rest',
    });
  }
  return { instruments, quotes };
}

export class GateAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'gate';
  private readonly health = new HealthTracker('gate', 'gate:rest', 90_000);
  // A tenth of the documented 200 req / 10 s per endpoint.
  private readonly limiter = new RateLimiter(100, 10_000, 20);
  private contractCache = new Map<string, { ts: number; list: RawContract[] }>();

  constructor(private readonly baseUrl: string = GATE_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string): Promise<T> {
    await this.limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    // An unlisted underlying (ZEC) answers 400 CONTRACT_NOT_FOUND — an empty chain, not a failure.
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { label?: string } | null;
      if (body?.label === 'CONTRACT_NOT_FOUND') return [] as T;
      throw new Error(`Gate ${path}: HTTP 400 ${body?.label ?? ''}`);
    }
    if (!res.ok) throw new Error(`Gate ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async contracts(underlying: string): Promise<RawContract[]> {
    const cached = this.contractCache.get(underlying);
    if (cached && Date.now() - cached.ts < CONTRACT_CACHE_TTL_MS) return cached.list;
    const list = await this.get<RawContract[]>(`/options/contracts?underlying=${underlying}_USDT`);
    this.contractCache.set(underlying, { ts: Date.now(), list: Array.isArray(list) ? list : [] });
    return Array.isArray(list) ? list : [];
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    try {
      // Unlisted underlyings have no contracts; their tickers read answers 400 INVALID_PARAM_VALUE.
      const contracts = await this.contracts(underlying);
      if (contracts.length === 0) {
        this.health.ok();
        return { instruments: [], quotes: [] };
      }
      const tickers = await this.get<RawTicker[]>(`/options/tickers?underlying=${underlying}_USDT`);
      const chain = mapGateChain(contracts, Array.isArray(tickers) ? tickers : [], underlying, Date.now());
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
      return q?.iv != null ? [{ venue: 'gate' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: q.forward ?? null, source: 'gate:rest' }] : [];
    });
  }
}
