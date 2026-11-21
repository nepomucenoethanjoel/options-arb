import { appendFile } from 'node:fs/promises';
import {
  CALLPUT_POSITION_MANAGER,
  creditRawIn,
  decodeCallputLog,
  isCreditSpread,
  describeLegs,
  sizeDecimals,
  toUnits,
  type CallputEvent,
  type CallputLeg,
  type RawLog,
} from './adapters/callputEvents';
import { fetchWithTimeout } from './util';

/**
 * Records every Callput request on Base with the feed's leg quotes captured
 * when the request is seen, so spread fills can later be compared with the
 * feed (DATA_SOURCES row 88). Read-only: public RPC + Callput's public feed.
 * Informational only — nothing here reaches signals, alerts or the KPI.
 *
 * Timing: requests are found by polling (~15 s) and keepers execute 2–13 s
 * after a request (row 87), so the feed snapshot is typically taken up to one
 * poll after the request; each record keeps the request time, the snapshot
 * time and the feed's own timestamp so the gap is visible.
 *
 * Prediction (unverified — the point of recording): a spread's premium per
 * unit = Σ over legs (bought: mark·(1 + rpBuy), sold: −mark·(1 − rpSell)) —
 * the docs' single-leg formula (row 40) applied leg by leg. Debit opens pay
 * premium + fee (amountIn / size); credit opens deposit width × size (+ fee)
 * and are paid the credit in the execution transaction (row 87).
 */

export interface CallputLegQuote extends CallputLeg {
  mark: number | null;
  rpBuy: number | null;
  rpSell: number | null;
  iv: number | null;
}

export interface CallputFeedSnapshot {
  takenAt: number;
  feedTs: number | null;
  spot: number | null;
  legs: CallputLegQuote[];
}

export interface CallputFillRecord {
  kind: 'open' | 'close';
  outcome: 'executed' | 'cancelled';
  account: string;
  underlying: string;
  expiryTs: number;
  legs: string;
  requestTx: string | null;
  requestTs: number | null;
  outcomeTx: string;
  outcomeTs: number;
  latencyMs: number | null;
  size: number | null;
  /** Open: USDC paid in. Close: USDC paid out. */
  usdc: number;
  /** Open with a credit (sell spread): USDC paid back to the account in the execution transaction. */
  creditUsdc: number | null;
  /** Debit open: usdc / size (premium + fee). Credit open: credit / size. Close: usdc / size. */
  perUnit: number | null;
  /** Σ legs from the snapshot, signed so it compares with perUnit (debit/credit/close). */
  predictedPerUnit: number | null;
  snapshot: CallputFeedSnapshot | null;
}

export interface RecorderOptions {
  rpcUrl: string;
  feedUrl: string;
  file: string | null;
  pollMs?: number;
  /** Blocks re-read on the first poll, so requests just before a restart are seen (Base: ~2–5 blocks/s). */
  backfillBlocks?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  keep?: number;
}

const MAX_RANGE = 5_000;

type FeedOption = { strikePrice?: number; markPrice?: number; markIv?: number; riskPremiumRateForBuy?: number; riskPremiumRateForSell?: number; optionId?: string };
type Feed = {
  lastUpdatedAt?: string;
  data?: { spotIndices?: Record<string, number>; market?: Record<string, { options?: Record<string, { call?: FeedOption[]; put?: FeedOption[] }> }> };
};
type Pending = { event: Extract<CallputEvent, { type: 'openRequest' | 'closeRequest' }>; ts: number; tx: string; snapshot: CallputFeedSnapshot | null };


/** Per-unit premium from a snapshot: bought legs at the ask, sold legs at the bid. Null if any leg is unquoted. */
export function legSum(legs: CallputLegQuote[], side: 'open' | 'close'): number | null {
  let sum = 0;
  for (const l of legs) {
    if (l.mark == null || l.rpBuy == null || l.rpSell == null) return null;
    // Closing reverses each leg: a held long is sold (bid), a held short is bought back (ask).
    const paying = side === 'open' ? l.isBuy : !l.isBuy;
    sum += paying ? l.mark * (1 + l.rpBuy) : -l.mark * (1 - l.rpSell);
  }
  return sum;
}

export class CallputRecorder {
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly records: CallputFillRecord[] = [];
  private readonly pending = new Map<string, Pending[]>();
  private readonly blockTimes = new Map<number, number>();
  private lastBlock: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private feed: { at: number; body: Feed } | null = null;
  private symbols = new Map<number, string>();
  private rpcId = 0;
  lastError: string | null = null;

  constructor(private readonly opts: RecorderOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init));
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Newest first. */
  latest(limit = 200): CallputFillRecord[] {
    return this.records.slice(-limit).reverse();
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = parseInt(await this.rpc<string>('eth_blockNumber', []), 16);
      let from = this.lastBlock == null ? Math.max(0, head - (this.opts.backfillBlocks ?? 3_000)) : this.lastBlock + 1;
      while (from <= head) {
        const to = Math.min(head, from + MAX_RANGE - 1);
        const logs = await this.rpc<RawLog[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: CALLPUT_POSITION_MANAGER }]);
        for (const log of logs) await this.handle(log);
        this.lastBlock = to;
        from = to + 1;
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private async handle(log: RawLog): Promise<void> {
    const e = decodeCallputLog(log);
    if (!e || e.type === 'requestKey') return;
    // Some RPCs include the block time on logs (hex), most don't.
    const bts = log.blockTimestamp;
    const ts = bts != null ? (typeof bts === 'string' ? parseInt(bts, 16) : bts) * 1000 : await this.blockTime(parseInt(log.blockNumber, 16));
    const key = (kind: 'open' | 'close') => `${kind}|${e.account}|${e.token.expiryTs}|${describeLegs(e.token.legs)}`;
    if (e.type === 'openRequest' || e.type === 'closeRequest') {
      const kind = e.type === 'openRequest' ? 'open' : 'close';
      const snapshot = await this.snapshot(e.token.underlyingIndex, e.token.expiryTs, e.token.legs).catch(() => null);
      const list = this.pending.get(key(kind)) ?? [];
      list.push({ event: e, ts, tx: log.transactionHash, snapshot });
      this.pending.set(key(kind), list);
      return;
    }
    const kind = e.type === 'closeExecuted' ? 'close' : 'open';
    const req = this.pending.get(key(kind))?.shift() ?? null;
    if (req && this.pending.get(key(kind))?.length === 0) this.pending.delete(key(kind));
    await this.symbolsReady();
    const underlying = this.symbols.get(e.token.underlyingIndex) ?? `#${e.token.underlyingIndex}`;
    const dec = sizeDecimals(underlying);
    const size = e.type === 'openCancelled' ? null : toUnits(e.sizeRaw, dec);
    const usdc = toUnits(e.type === 'closeExecuted' ? e.amountOutRaw : e.amountInRaw, 6);
    let creditUsdc: number | null = null;
    if (e.type === 'openExecuted' && isCreditSpread(e.token.legs)) creditUsdc = await this.creditIn(log.transactionHash, e.account).catch(() => null);
    const credit = creditUsdc != null && creditUsdc > 0;
    const perUnit = size != null && size > 0 ? (credit ? creditUsdc! / size : usdc / size) : null;
    const sum = req?.snapshot ? legSum(req.snapshot.legs, kind) : null;
    // Debit opens compare with the leg sum; credit opens with −sum (the credit); closes with −sum (paid out).
    const predictedPerUnit = sum == null ? null : kind === 'open' && !credit ? sum : -sum;
    const record: CallputFillRecord = {
      kind,
      outcome: e.type === 'openCancelled' ? 'cancelled' : 'executed',
      account: e.account,
      underlying,
      expiryTs: e.token.expiryTs,
      legs: describeLegs(e.token.legs),
      requestTx: req?.tx ?? null,
      requestTs: req?.ts ?? null,
      outcomeTx: log.transactionHash,
      outcomeTs: ts,
      latencyMs: req ? ts - req.ts : null,
      size,
      usdc,
      creditUsdc: credit ? creditUsdc : null,
      perUnit,
      predictedPerUnit,
      snapshot: req?.snapshot ?? null,
    };
    this.records.push(record);
    if (this.records.length > (this.opts.keep ?? 500)) this.records.shift();
    if (this.opts.file) await appendFile(this.opts.file, `${JSON.stringify(record)}\n`).catch(() => undefined);
  }

  /** USDC sent from the PositionManager to the account in this transaction (a sell spread's credit). */
  private async creditIn(tx: string, account: string): Promise<number> {
    const receipt = await this.rpc<{ logs: Array<{ address: string; topics: string[]; data: string }> }>('eth_getTransactionReceipt', [tx]);
    return toUnits(creditRawIn(receipt.logs, account), 6);
  }

  private async snapshot(index: number, expiryTs: number, legs: CallputLeg[]): Promise<CallputFeedSnapshot | null> {
    const feed = await this.readFeed();
    const underlying = this.symbols.get(index);
    if (!underlying) return null;
    const chain = feed.data?.market?.[underlying]?.options?.[String(expiryTs / 1000)];
    return {
      takenAt: Date.now(),
      feedTs: feed.lastUpdatedAt ? Date.parse(feed.lastUpdatedAt) : null,
      spot: feed.data?.spotIndices?.[underlying] ?? null,
      legs: legs.map((l) => {
        const o = (l.isCall ? chain?.call : chain?.put)?.find((x) => x.strikePrice === l.strike);
        return { ...l, mark: o?.markPrice ?? null, rpBuy: o?.riskPremiumRateForBuy ?? null, rpSell: o?.riskPremiumRateForSell ?? null, iv: o?.markIv ?? null };
      }),
    };
  }

  /** The feed, read at most once per 10 s; also refreshes the index → symbol map. */
  private async readFeed(): Promise<Feed> {
    if (this.feed && Date.now() - this.feed.at < 10_000) return this.feed.body;
    const res = await this.fetchImpl(this.opts.feedUrl);
    if (!res.ok) throw new Error(`Callput feed HTTP ${res.status}`);
    const body = (await res.json()) as Feed;
    this.feed = { at: Date.now(), body };
    for (const [symbol, m] of Object.entries(body.data?.market ?? {})) {
      for (const chain of Object.values(m.options ?? {})) {
        const first = [...(chain.call ?? []), ...(chain.put ?? [])].find((o) => o.optionId);
        if (first?.optionId) {
          this.symbols.set(parseInt(first.optionId.slice(2, 6), 16), symbol);
          break;
        }
      }
    }
    return body;
  }

  private async symbolsReady(): Promise<void> {
    if (this.symbols.size === 0) await this.readFeed().catch(() => undefined);
  }

  private async blockTime(n: number): Promise<number> {
    const cached = this.blockTimes.get(n);
    if (cached != null) return cached;
    const b = await this.rpc<{ timestamp: string }>('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    const ts = parseInt(b.timestamp, 16) * 1000;
    this.blockTimes.set(n, ts);
    if (this.blockTimes.size > 1_000) this.blockTimes.delete(this.blockTimes.keys().next().value!);
    return ts;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.opts.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  }
}

/** Fill-vs-feed summary for the API: executed records with a snapshot taken within `maxAgeMs` of the request. */
export function summarizeCallputFills(records: CallputFillRecord[], maxAgeMs = 60_000) {
  const usable = records.filter(
    (r) => r.outcome === 'executed' && r.perUnit != null && r.predictedPerUnit != null && r.snapshot && r.requestTs != null && r.snapshot.takenAt - r.requestTs <= maxAgeMs,
  );
  const diffs = usable.map((r) => r.perUnit! - r.predictedPerUnit!).sort((a, b) => a - b);
  const rel = usable.filter((r) => Math.abs(r.predictedPerUnit!) > 0).map((r) => (r.perUnit! - r.predictedPerUnit!) / Math.abs(r.predictedPerUnit!)).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length === 0 ? null : xs[Math.floor(xs.length / 2)]!);
  return {
    records: records.length,
    executed: records.filter((r) => r.outcome === 'executed').length,
    cancelled: records.filter((r) => r.outcome === 'cancelled').length,
    comparable: usable.length,
    medianDiffPerUnit: median(diffs),
    medianRelDiff: median(rel),
  };
}
