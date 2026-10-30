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
 * Coincall options — public REST, no key (verified live 2026-10-28,
 * DATA_SOURCES.md rows 26-27, 33-35):
 *  - GET /open/option/getInstruments/{BASE}  → { code: 0, data: [{ symbolName,
 *    strike, expirationTimestamp (ms, 08:00 UTC), isActive, minQty, tickSize }] }
 *  - GET /open/option/get/v1/{BASE}USD       → whole chain: data is an array of
 *    { strike, callOption | null, putOption | null }, each option carrying
 *    bid/ask/sizes, markPrice, markIv (fraction), greeks, underlyingPrice
 *    (the spot index, same for every expiry). Numbers are JSON numbers.
 *  - A missing side is `bid: null` (bidIv 1e-4 sentinel). Prices are USD(T)
 *    per 1 coin (multiplier 1). Unlisted bases (ZEC) answer code 40034.
 *  - The options WebSocket needs a signed key → polling only. Rate limits
 *    for these endpoints are undocumented: one chain read per underlying per
 *    cycle (up to SNAPSHOT_ATTEMPTS when replayed), instruments cached.
 *  - The chain is served from cache replicas of different ages and carries no
 *    timestamp: from the VPS 41 of 51 reads replayed a snapshot already seen,
 *    up to ~59 s old (row 50). A replayed snapshot is re-asked; quotes are
 *    stamped with when their snapshot first appeared (a lower bound on age),
 *    and one older than SNAPSHOT_FRESH_MS carries `stale`.
 */

export const COINCALL_BASE_URL = 'https://api.coincall.com';
const INSTRUMENT_CACHE_TTL_MS = 10 * 60_000;
/** The backend published a new snapshot every ~11 s in the row-50 sample. */
const SNAPSHOT_FRESH_MS = 20_000;
const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_MEMORY_MS = 10 * 60_000;
const SYMBOL_RE = /^([A-Z0-9]+)USD-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/;

interface RawInstrument {
  symbolName?: string;
  strike?: number;
  expirationTimestamp?: number;
  isActive?: boolean;
}

interface RawOption {
  symbol?: string;
  strike?: number;
  endTime?: number;
  bid?: number | null;
  bidSize?: number | null;
  ask?: number | null;
  askSize?: number | null;
  markPrice?: number | null;
  markIv?: number | null;
  underlyingPrice?: number | null;
  openInterest?: number | null;
  type?: number;
  delta?: number | null;
  gamma?: number | null;
  vega?: number | null;
  theta?: number | null;
  rho?: number | null;
}

type ChainEntry = { callOption?: RawOption | null; putOption?: RawOption | null };

/** Every mark, book and forward in the chain: any republish changes at least one. */
function snapshotFingerprint(data: ChainEntry[]): string {
  return data
    .flatMap((e) => [e.callOption, e.putOption])
    .map((o) => (o ? `${o.symbol}:${o.markPrice}:${o.bid}:${o.ask}:${o.underlyingPrice}` : '-'))
    .join('|');
}

interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const px = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

function expiryDateOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

export function mapCoincallInstrument(raw: RawInstrument, underlying: string): OptionInstrument | null {
  const m = raw.symbolName ? SYMBOL_RE.exec(raw.symbolName) : null;
  if (!m || raw.isActive === false || m[1] !== underlying) return null;
  const expiryTs = num(raw.expirationTimestamp);
  const strike = num(raw.strike) ?? Number(m[5]);
  if (expiryTs == null || !Number.isFinite(strike)) return null;
  return {
    venue: 'coincall',
    instrumentId: raw.symbolName!,
    underlying,
    expiryTs,
    expiryDate: expiryDateOf(expiryTs),
    strike,
    kind: m[6] === 'C' ? 'call' : 'put',
  };
}

export function mapCoincallOption(raw: RawOption, ts: number): OptionQuote | null {
  if (!raw.symbol) return null;
  return {
    venue: 'coincall',
    instrumentId: raw.symbol,
    ts,
    bid: px(raw.bid),
    bidSize: px(raw.bid) != null ? num(raw.bidSize) : null,
    ask: px(raw.ask),
    askSize: px(raw.ask) != null ? num(raw.askSize) : null,
    mark: num(raw.markPrice),
    indexPrice: px(raw.underlyingPrice),
    iv: px(raw.markIv),
    ivSource: 'market',
    greeks: { delta: num(raw.delta), gamma: num(raw.gamma), vega: num(raw.vega), theta: num(raw.theta), rho: num(raw.rho) },
    openInterest: num(raw.openInterest),
    source: 'coincall:rest',
  };
}

export class CoincallAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'coincall';
  private readonly health = new HealthTracker('coincall', 'coincall:rest', 90_000);
  // Undocumented limits: stay well under the documented 10 req / 2 s on config endpoints.
  private readonly limiter = new RateLimiter(250, 2_000, 5);
  private instrumentCache = new Map<string, { ts: number; list: OptionInstrument[] }>();
  /** underlying → snapshot fingerprint → when it was first served. */
  private snapshotsSeen = new Map<string, Map<string, number>>();

  constructor(private readonly baseUrl: string = COINCALL_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  private async get<T>(path: string): Promise<Envelope<T>> {
    await this.limiter.acquire();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Coincall ${path}: HTTP ${res.status}`);
    return (await res.json()) as Envelope<T>;
  }

  async getInstruments(underlying: string): Promise<OptionInstrument[]> {
    const cached = this.instrumentCache.get(underlying);
    if (cached && Date.now() - cached.ts < INSTRUMENT_CACHE_TTL_MS) return cached.list;
    const env = await this.get<RawInstrument[]>(`/open/option/getInstruments/${underlying}`);
    // Not listed (e.g. ZEC → 40034) is an empty chain, not a venue failure.
    const list = env.code === 0 && Array.isArray(env.data)
      ? env.data.map((r) => mapCoincallInstrument(r, underlying)).filter((i): i is OptionInstrument => i != null)
      : [];
    if (env.code !== 0 && env.code !== 40034) throw new Error(`Coincall instruments ${underlying}: code ${env.code} ${env.msg ?? ''}`);
    this.instrumentCache.set(underlying, { ts: Date.now(), list });
    return list;
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    try {
      const instruments = await this.getInstruments(underlying);
      if (instruments.length === 0) {
        this.health.ok();
        return { instruments, quotes: [] };
      }
      const { data, ts } = await this.freshestChain(underlying);
      const stale = Date.now() - ts > SNAPSHOT_FRESH_MS;
      const quotes: OptionQuote[] = [];
      for (const entry of data) {
        for (const raw of [entry.callOption, entry.putOption]) {
          const q = raw ? mapCoincallOption(raw, ts) : null;
          if (q && stale) q.flags = [...(q.flags ?? []), 'stale'];
          if (q) quotes.push(q);
        }
      }
      this.health.ok();
      return { instruments, quotes };
    } catch (err) {
      this.health.fail(err);
      throw err;
    }
  }

  /** The newest snapshot within SNAPSHOT_ATTEMPTS reads, with when it first appeared. */
  private async freshestChain(underlying: string): Promise<{ data: ChainEntry[]; ts: number }> {
    const seen = this.snapshotsSeen.get(underlying) ?? new Map<string, number>();
    this.snapshotsSeen.set(underlying, seen);
    let best: { data: ChainEntry[]; ts: number } | null = null;
    for (let i = 0; i < SNAPSHOT_ATTEMPTS; i++) {
      const env = await this.get<ChainEntry[]>(`/open/option/get/v1/${underlying}USD`);
      if (env.code !== 0 || !Array.isArray(env.data)) throw new Error(`Coincall chain ${underlying}: code ${env.code} ${env.msg ?? ''}`);
      const now = Date.now();
      const fp = snapshotFingerprint(env.data);
      const first = seen.get(fp) ?? now;
      seen.set(fp, first);
      if (best == null || first > best.ts) best = { data: env.data, ts: first };
      if (now - best.ts <= SNAPSHOT_FRESH_MS) break;
    }
    for (const [fp, t] of seen) if (Date.now() - t > SNAPSHOT_MEMORY_MS) seen.delete(fp);
    return best!;
  }

  async getTicker(instrumentId: string): Promise<OptionQuote | null> {
    const underlying = SYMBOL_RE.exec(instrumentId)?.[1];
    if (!underlying) return null;
    const { quotes } = await this.getChain(underlying);
    return quotes.find((q) => q.instrumentId === instrumentId) ?? null;
  }

  async getIVSurface(underlying: string): Promise<IVSurfacePoint[]> {
    const { instruments, quotes } = await this.getChain(underlying);
    const byId = new Map(quotes.map((q) => [q.instrumentId, q]));
    return instruments.flatMap((i) => {
      const q = byId.get(i.instrumentId);
      return q?.iv != null
        ? [{ venue: 'coincall' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: q.iv, forward: null, source: 'coincall:rest' }]
        : [];
    });
  }
}
