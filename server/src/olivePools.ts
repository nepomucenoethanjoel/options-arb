import { fetchOliveMarketFile, type OliveMarketFileData } from './adapters/olive/marketFile';
import { fetchWithTimeout, sleep } from './util';

/**
 * Olive lists ~70 markets but only a few pools hold collateral; the
 * mispricing is often largest where the pool is empty (BNB/XRP 11–15 vols
 * under Coincall/Gate on 2026-11-05, pools $0–$10). This watcher sweeps every
 * market file, keeps the free capacity per pool, and alerts once when a pool
 * that has a hedge venue gets funded — or when a dead execution oracle
 * (PAXG) comes back — so that underlying can be added to UNDERLYINGS.
 * Informational only: nothing here reaches signals or the KPI.
 */

export const OLIVE_MARKETS_URL = 'https://olive.exchange/public/markets.json';

/**
 * Where an Olive market can be hedged: the venue-side underlying name and the
 * venues listing options on it. Measured from each venue's public API on
 * 2026-11-05/06 (DATA_SOURCES row 62); PAXG→XAUT is a different gold token.
 */
export const OLIVE_HEDGES: Record<string, { underlying: string; venues: string[] }> = {
  BTC: { underlying: 'BTC', venues: ['derive', 'coincall', 'deribit', 'okx', 'gate', 'callput'] },
  ETH: { underlying: 'ETH', venues: ['derive', 'coincall', 'deribit', 'okx', 'gate', 'callput'] },
  SOL: { underlying: 'SOL', venues: ['derive', 'coincall', 'deribit', 'gate'] },
  ZEC: { underlying: 'ZEC', venues: ['derive'] },
  XRP: { underlying: 'XRP', venues: ['coincall', 'deribit', 'gate'] },
  BNB: { underlying: 'BNB', venues: ['coincall', 'gate'] },
  DOGE: { underlying: 'DOGE', venues: ['coincall', 'gate'] },
  HYPE: { underlying: 'HYPE', venues: ['coincall', 'deribit', 'gate'] },
  TRX: { underlying: 'TRX', venues: ['deribit'] },
  AVAX: { underlying: 'AVAX', venues: ['deribit'] },
  LTC: { underlying: 'LTC', venues: ['gate'] },
  ADA: { underlying: 'ADA', venues: ['gate'] },
  AAVE: { underlying: 'AAVE', venues: ['coincall'] },
  TRUMP: { underlying: 'TRUMP', venues: ['coincall'] },
  PAXG: { underlying: 'XAUT', venues: ['coincall', 'gate'] },
  SPYX: { underlying: 'SPY', venues: ['coincall', 'callput'] },
  QQQX: { underlying: 'QQQ', venues: ['coincall', 'callput'] },
  TSLAX: { underlying: 'TSLA', venues: ['callput'] },
  NVDAX: { underlying: 'NVDA', venues: ['callput'] },
  METAX: { underlying: 'META', venues: ['callput'] },
  GOOGLX: { underlying: 'GOOGL', venues: ['callput'] },
  AAPLX: { underlying: 'AAPL', venues: ['callput'] },
  AMZNX: { underlying: 'AMZN', venues: ['callput'] },
  MSFTX: { underlying: 'MSFT', venues: ['callput'] },
  COINX: { underlying: 'COIN', venues: ['callput'] },
  HOODX: { underlying: 'HOOD', venues: ['callput'] },
  CRCLX: { underlying: 'CRCL', venues: ['callput'] },
  MUX: { underlying: 'MU', venues: ['callput'] },
  SKHY: { underlying: 'SKHY', venues: ['callput'] },
  SPCXX: { underlying: 'SPCX', venues: ['callput'] },
};

export interface OlivePoolSnapshot {
  symbol: string;
  /** Venue-side underlying and venues with options on it (empty: no hedge). */
  hedgeUnderlying: string | null;
  hedgeVenues: string[];
  /** Olive's execution-oracle spot; null when Olive marks it stale/unavailable. */
  spot: number | null;
  /** Free collateral the pool can write against: calls (underlying × spot), puts (USDC). */
  callCapacityUsd: number | null;
  putCapacityUsd: number | null;
  ts: number;
}

export interface PoolWatcherOptions {
  thresholdUsd: number;
  sweepIntervalMs: number;
  /** Underlyings the app already prices — never alerted. */
  tracked: string[];
  notify?: (text: string) => Promise<boolean>;
  fetchMarkets?: () => Promise<string[]>;
  fetchFile?: (symbol: string) => Promise<OliveMarketFileData | null>;
  /** Pause between market-file reads within a sweep. */
  spacingMs?: number;
}

export function snapshotPool(symbol: string, file: OliveMarketFileData | null, now: number): OlivePoolSnapshot {
  const hedge = OLIVE_HEDGES[symbol];
  const spot = file?.spot ?? null;
  return {
    symbol,
    hedgeUnderlying: hedge?.underlying ?? null,
    hedgeVenues: hedge?.venues ?? [],
    spot,
    callCapacityUsd: file?.underlyingFree != null && spot != null ? file.underlyingFree * spot : null,
    putCapacityUsd: file?.usdcFreeUsd ?? null,
    ts: now,
  };
}

const capacity = (s: OlivePoolSnapshot): number => Math.max(s.callCapacityUsd ?? 0, s.putCapacityUsd ?? 0);

/**
 * What changed between two sweeps that is worth one alert: a hedgeable,
 * untracked pool crossing the threshold upward, or its oracle coming back.
 * The first sweep only sets the baseline (a restart must not re-alert).
 */
export function poolAlerts(prev: Map<string, OlivePoolSnapshot> | null, next: OlivePoolSnapshot[], opts: Pick<PoolWatcherOptions, 'thresholdUsd' | 'tracked'>): string[] {
  if (prev == null) return [];
  const out: string[] = [];
  for (const s of next) {
    if (s.hedgeVenues.length === 0 || opts.tracked.includes(s.hedgeUnderlying ?? s.symbol)) continue;
    const before = prev.get(s.symbol);
    if (!before) continue;
    const usd = (v: number | null) => (v == null ? '–' : `$${Math.round(v).toLocaleString('en-US')}`);
    if (capacity(s) >= opts.thresholdUsd && capacity(before) < opts.thresholdUsd) {
      out.push(`🌱 Olive ${s.symbol} pool funded: calls ${usd(s.callCapacityUsd)} · puts ${usd(s.putCapacityUsd)} free (was ${usd(Math.max(before.callCapacityUsd ?? 0, before.putCapacityUsd ?? 0))}) — hedge on ${s.hedgeVenues.join(', ')} (${s.hedgeUnderlying}). Add it to UNDERLYINGS to price it.`);
    }
    if (s.spot != null && before.spot == null) {
      out.push(`🔌 Olive ${s.symbol} execution oracle is live again (spot ${s.spot}) — capacity calls ${usd(s.callCapacityUsd)} · puts ${usd(s.putCapacityUsd)}; hedge on ${s.hedgeVenues.join(', ')}.`);
    }
  }
  return out;
}

export class OlivePoolWatcher {
  private latestByPool: Map<string, OlivePoolSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: PoolWatcherOptions) {}

  latest(): OlivePoolSnapshot[] {
    return [...(this.latestByPool?.values() ?? [])].sort((a, b) => capacity(b) - capacity(a));
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const symbols = await (this.opts.fetchMarkets ?? fetchOliveMarkets)();
      const next: OlivePoolSnapshot[] = [];
      for (const sym of symbols) {
        const file = await (this.opts.fetchFile ?? ((s: string) => fetchOliveMarketFile('https://olive.exchange/public/market', s)))(sym).catch(() => null);
        next.push(snapshotPool(sym, file, now));
        if (this.opts.spacingMs) await sleep(this.opts.spacingMs);
      }
      const alerts = poolAlerts(this.latestByPool, next, this.opts);
      this.latestByPool = new Map(next.map((s) => [s.symbol, s]));
      for (const text of alerts) {
        console.log(`[olive-pools] ${text}`);
        await this.opts.notify?.(text);
      }
    } catch (err) {
      console.warn('[olive-pools] sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}

/** Olive's market list: `[{ symbol: 'SOL/USD', … }]` → ['SOL', …] (USDC/EURC are quote assets). */
export async function fetchOliveMarkets(): Promise<string[]> {
  const res = await fetchWithTimeout(OLIVE_MARKETS_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Olive markets.json: HTTP ${res.status}`);
  const list = (await res.json()) as Array<{ symbol?: string }>;
  return list
    .map((m) => m.symbol?.split('/')[0] ?? '')
    .filter((s) => s !== '' && s !== 'USDC' && s !== 'EURC');
}
