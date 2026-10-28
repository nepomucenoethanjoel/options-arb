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
 * Hypercall (HyperEVM options, off-chain matching) — public REST, no key
 * (verified live 2026-10-28, DATA_SOURCES.md rows 28-29, 36-38):
 *  - GET /options-summary?currency=X&kind=option&include_rfq_provider_quotes=true
 *    → JSON-RPC-style { result: [...] }. The resting book (bid_price /
 *    ask_price) is empty; the tradable quotes are the market makers'
 *    `rfq_provider_quotes[]` { wallet, bid_price, ask_price, max_bid_size,
 *    max_ask_size (strings), updated_at (ms) } — what the app UI shows.
 *  - mark_iv is Hypercall's vol oracle (BTC/ETH read from Deribit) — not an
 *    independent market; mark_price 0 means "no mark".
 *  - Prices USD per 1 coin; expiry 08:00 UTC; BTC/ETH only (SOL/ZEC: []).
 *  - Size units: max_*_size (e.g. "7.30") vs indicative_*_size (7.3e-6)
 *    differ by 1e6 — UNVERIFIED which is contracts; we use the maker's own
 *    max_*_size and every quote carries `single_maker` while one wallet
 *    quotes, which keeps it out of headline totals.
 */

export const HYPERCALL_BASE_URL = 'https://api.hypercall.xyz';
const NAME_RE = /^([A-Z0-9]+)-(\d{8})-([\d.]+)-([CP])$/;

interface RfqQuote {
  wallet?: string;
  bid_price?: string | number | null;
  ask_price?: string | number | null;
  max_bid_size?: string | number | null;
  max_ask_size?: string | number | null;
  updated_at?: number;
}

interface RawSummary {
  instrument_name?: string;
  expiration_timestamp?: number;
  mark_price?: number | null;
  mark_iv?: number | null;
  underlying_price?: number | null;
  open_interest?: number | null;
  rfq_provider_quotes?: RfqQuote[] | null;
  greeks?: { delta?: number; gamma?: number; vega?: number; theta?: number; rho?: number } | null;
}

const num = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : null;
};
const pos = (v: unknown): number | null => {
  const x = num(v);
  return x != null && x > 0 ? x : null;
};

export function mapHypercallSummary(
  raw: RawSummary,
  underlying: string,
): { instrument: OptionInstrument; quote: OptionQuote } | null {
  const m = raw.instrument_name ? NAME_RE.exec(raw.instrument_name) : null;
  const expiryTs = num(raw.expiration_timestamp);
  if (!m || m[1] !== underlying || expiryTs == null) return null;
  const instrument: OptionInstrument = {
    venue: 'hypercall',
    instrumentId: raw.instrument_name!,
    underlying,
    expiryTs,
    expiryDate: m[2],
    strike: Number(m[3]),
    kind: m[4] === 'C' ? 'call' : 'put',
  };

  // Best maker bid / ask across RFQ providers, each with its own max size.
  let bid: number | null = null;
  let bidSize: number | null = null;
  let ask: number | null = null;
  let askSize: number | null = null;
  let ts: number | null = null;
  const wallets = new Set<string>();
  for (const q of raw.rfq_provider_quotes ?? []) {
    const b = pos(q.bid_price);
    const a = pos(q.ask_price);
    if (b == null && a == null) continue;
    if (q.wallet) wallets.add(q.wallet.toLowerCase());
    if (b != null && (bid == null || b > bid)) {
      bid = b;
      bidSize = num(q.max_bid_size);
    }
    if (a != null && (ask == null || a < ask)) {
      ask = a;
      askSize = num(q.max_ask_size);
    }
    const u = num(q.updated_at);
    if (u != null) ts = ts == null ? u : Math.min(ts, u);
  }
  const g = raw.greeks ?? {};
  const quote: OptionQuote = {
    venue: 'hypercall',
    instrumentId: instrument.instrumentId,
    // The OLDEST contributing maker update: a stale maker must read stale.
    ts: ts ?? Date.now(),
    bid,
    bidSize,
    ask,
    askSize,
    mark: pos(raw.mark_price),
    indexPrice: pos(raw.underlying_price),
    iv: pos(raw.mark_iv),
    ivSource: 'model',
    greeks: { delta: num(g.delta), gamma: num(g.gamma), vega: num(g.vega), theta: num(g.theta), rho: num(g.rho) },
    openInterest: num(raw.open_interest),
    source: 'hypercall:rfq',
    flags: wallets.size === 1 ? ['single_maker'] : undefined,
  };
  return { instrument, quote };
}

export class HypercallAdapter implements OptionsVenueAdapter {
  readonly venue: Venue = 'hypercall';
  private readonly health = new HealthTracker('hypercall', 'hypercall:rfq', 90_000);
  private readonly limiter = new RateLimiter(250, 2_000, 5);

  constructor(private readonly baseUrl: string = HYPERCALL_BASE_URL) {}

  getHealth(): VenueHealth {
    return this.health.snapshot();
  }

  async getChain(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }> {
    try {
      await this.limiter.acquire();
      const res = await fetchWithTimeout(
        `${this.baseUrl}/options-summary?currency=${encodeURIComponent(underlying)}&kind=option&include_rfq_provider_quotes=true`,
        { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } },
      );
      if (!res.ok) throw new Error(`Hypercall options-summary ${underlying}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: RawSummary[] };
      if (!Array.isArray(body.result)) throw new Error(`Hypercall options-summary ${underlying}: no result array`);
      const instruments: OptionInstrument[] = [];
      const quotes: OptionQuote[] = [];
      for (const raw of body.result) {
        const mapped = mapHypercallSummary(raw, underlying);
        if (!mapped) continue;
        instruments.push(mapped.instrument);
        quotes.push(mapped.quote);
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
    return instruments.flatMap((i, k) =>
      quotes[k]?.iv != null
        ? [{ venue: 'hypercall' as const, underlying, expiryTs: i.expiryTs, strike: i.strike, iv: quotes[k].iv!, forward: null, source: 'hypercall:rfq' }]
        : [],
    );
  }
}
