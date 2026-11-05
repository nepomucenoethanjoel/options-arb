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
 * OKX options — public REST v5, no key (verified live from the US host
 * 2026-11-05, DATA_SOURCES.md rows 53-57). Coin-margined families only
 * ({U}-USD: BTC, ETH; no SOL, no USDC family).
 *  - GET /api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD →
 *    instId BTC-USD-261106-79750-C, stk, optType, expTime (ms, 08:00 UTC),
 *    ctVal 1 × ctMult 0.01 → one contract = 0.01 coin; settleCcy BTC.
 *  - GET /api/v5/market/tickers?instType=OPTION&instFamily=… → bidPx/askPx
 *    (coin per 1 coin) + bidSz/askSz (contracts) for the whole family.
 *  - GET /api/v5/public/opt-summary?instFamily=… → markVol (fraction), fwdPx.
 *  - GET /api/v5/public/mark-price?instType=OPTION&instFamily=… → markPx (coin).
 *  - GET /api/v5/market/index-tickers?instId={U}-USD → idxPx (USD).
 *  USD = coin price × index (BS at fwdPx/markVol reproduces markPx × idxPx
 *  within $0.25 on the captured fixture). Empty side = "" or "0".
 *  Rate limits (docs): tickers 20 / 2 s, opt-summary 2 / 2 s, mark-price
 *  10 / 2 s, index-tickers 20 / 2 s — 4 reads per underlying per cycle.
 */

export const OKX_BASE_URL = 'https://www.okx.com';
const INSTRUMENT_CACHE_TTL_MS = 10 * 60_000;
const ID_RE = /^([A-Z]+)-USD-(\d{2})(\d{2})(\d{2})-([\d.]+)-([CP])$/;

interface Envelope<T> {
  code?: string;
  msg?: string;
  data?: T[];
}
interface RawInstrument { instId?: string; stk?: string; optType?: string; expTime?: string; ctVal?: string; ctMult?: string; state?: string }
interface RawTicker { instId?: string; bidPx?: string; bidSz?: string; askPx?: string; askSz?: string; ts?: string }
interface RawSummary { instId?: string; markVol?: string; fwdPx?: string; delta?: string; gamma?: string; vega?: string; theta?: string }
interface RawMark { instId?: string; markPx?: string }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

export function parseOkxId(instId: string, underlying: string): OptionInstrument | null {
  const m = ID_RE.exec(instId);
  if (!m || m[1] !== underlying) return null;
  const expiryTs = Date.UTC(2000 + Number(m[2]), Number(m[3]) - 1, Number(m[4]), 8);
  const strike = Number(m[5]);
  if (!Number.isFinite(strike)) return null;
  return {
    venue: 'okx',
    instrumentId: instId,
    underlying,
    expiryTs,
    expiryDate: `20${m[2]}${m[3]}${m[4]}`,
    strike,
    kind: m[6] === 'C' ? 'call' : 'put',
  };
}

export interface OkxRaw {
  instruments: Envelope<RawInstrument>;
  tickers: Envelope<RawTicker>;
  optSummary: Envelope<RawSummary>;
  markPrice: Envelope<RawMark>;
  index: Envelope<{ idxPx?: string }>;
}

/** One family's reads → instruments + USD quotes with sizes in coin. */
export function mapOkxChain(raw: OkxRaw, underlying: string, now: number): { instruments: OptionInstrument[]; quotes: OptionQuote[] } {
  const index = pos(raw.index.data?.[0]?.idxPx);
  if (index == null) return { instruments: [], quotes: [] };
  const tick = new Map((raw.tickers.data ?? []).map((t) => [t.instId, t]));
  const summ = new Map((raw.optSummary.data ?? []).map((s) => [s.instId, s]));
  const mark = new Map((raw.markPrice.data ?? []).map((m) => [m.instId, m]));
  const instruments: OptionInstrument[] = [];
  const quotes: OptionQuote[] = [];
  for (const r of raw.instruments.data ?? []) {
    const inst = r.instId && r.state === 'live' ? parseOkxId(r.instId, underlying) : null;
    // Contract size in coin: ctVal × ctMult (0.01 BTC on every BTC-USD option).
    const coinPerContract = (num(r.ctVal) ?? 0) * (num(r.ctMult) ?? 0);
    if (!inst || !(coinPerContract > 0)) continue;
    const t = tick.get(r.instId);
    const s = summ.get(r.instId);
    const bid = pos(t?.bidPx);
    const ask = pos(t?.askPx);
    const markPx = pos(mark.get(r.instId)?.markPx);
    instruments.push(inst);
    quotes.push({
      venue: 'okx',
      instrumentId: inst.instrumentId,
      ts: num(t?.ts) ?? now,
      bid: bid != null ? bid * index : null,
      bidSize: bid != null ? (num(t?.bidSz) ?? 0) * coinPerContract : null,
      ask: ask != null ? ask * index : null,
      askSize: ask != null ? (num(t?.askSz) ?? 0) * coinPerContract : null,
      mark: markPx != null ? markPx * index : null,
      indexPrice: index,
      forward: pos(s?.fwdPx),
      iv: pos(s?.markVol),
      ivSource: 'market',
      greeks: { delta: num(s?.delta), gamma: num(s?.gamma), vega: num(s?.vega), theta: num(s?.theta), rho: null },
      source: 'okx:rest',
    });
  }
  return { instruments, quotes };
}

export class OkxAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'okx';
  private readonly health = new HealthTracker('okx', 'okx:rest', 90_000);
  // Half the documented per-IP limits: opt-summary 2 / 2 s (its own limiter), the rest ≥ 10 / 2 s.
  private readonly limiter = new RateLimiter(100, 2_000, 5);
  private readonly summaryLimiter = new RateLimiter(1_000, 2_000, 1);
  private instrumentCache = new Map<string, { ts: number; data: Envelope<RawInstrument> }>();

  constructor(private readonly baseUrl: string = OKX_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string, limiter: RateLimiter = this.limiter): Promise<Envelope<T>> {
    await limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`OKX ${path}: HTTP ${res.status}`);
    const env = (await res.json()) as Envelope<T>;
    if (env.code !== '0' || !Array.isArray(env.data)) throw new Error(`OKX ${path}: code ${env.code} ${env.msg ?? ''}`);
    return env;
  }

  private async instruments(family: string): Promise<Envelope<RawInstrument>> {
    const cached = this.instrumentCache.get(family);
    if (cached && Date.now() - cached.ts < INSTRUMENT_CACHE_TTL_MS) return cached.data;
    const data = await this.get<RawInstrument>(`/api/v5/public/instruments?instType=OPTION&instFamily=${family}`);
    this.instrumentCache.set(family, { ts: Date.now(), data });
    return data;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    if (underlying !== 'BTC' && underlying !== 'ETH') return { instruments: [], quotes: [] };
    const family = `${underlying}-USD`;
    try {
      const [instruments, tickers, optSummary, markPrice, index] = await Promise.all([
        this.instruments(family),
        this.get<RawTicker>(`/api/v5/market/tickers?instType=OPTION&instFamily=${family}`),
        this.get<RawSummary>(`/api/v5/public/opt-summary?instFamily=${family}`, this.summaryLimiter),
        this.get<RawMark>(`/api/v5/public/mark-price?instType=OPTION&instFamily=${family}`),
        this.get<{ idxPx?: string }>(`/api/v5/market/index-tickers?instId=${family}`),
      ]);
      const chain = mapOkxChain({ instruments, tickers, optSummary, markPrice, index }, underlying, Date.now());
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
    const underlying = ID_RE.exec(instrumentId)?.[1];
    if (!underlying) return null;
    return (await this.getChain(underlying)).quotes.find((q) => q.instrumentId === instrumentId) ?? null;
  }

  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const { instruments, quotes } = await this.getChain(underlying);
    const byId = new Map(quotes.map((q) => [q.instrumentId, q]));
    return instruments.flatMap((i) => {
      const q = byId.get(i.instrumentId);
      return q?.iv != null ? [{ venue: 'okx' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: q.forward ?? null, source: 'okx:rest' }] : [];
    });
  }
}
