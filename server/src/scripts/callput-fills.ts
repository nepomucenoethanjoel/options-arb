/**
 * Read-only: decode recent Callput requests and fills on Base from the
 * PositionManager's public events (DATA_SOURCES rows 85, 87).
 *
 *   npm run callput:fills -w server            # last 7 days
 *   HOURS=48 npm run callput:fills -w server
 *   CALLPUT_RPC_URL=https://… npm run callput:fills -w server
 *
 * Prints each request with its outcome (executed / cancelled, latency, size,
 * all-in USDC per unit; for a sell spread the credit paid back in the
 * execution transaction), a tally of strategies (single legs vs spreads,
 * debit vs credit), and cancellation rates by request size. The public RPC needs an address filter and caps ranges, so
 * logs are read in 10k-block chunks; block times come from the chain (Base's
 * block interval is not constant — never derive a block from a time by
 * arithmetic).
 */
import { CALLPUT_FEED_URL } from '../adapters/callput';
import {
  CALLPUT_POSITION_MANAGER,
  creditRawIn,
  decodeCallputLog,
  isCreditSpread,
  describeLegs,
  sizeDecimals,
  toUnits,
  type CallputEvent,
  type RawLog,
} from '../adapters/callputEvents';

const RPC = process.env.CALLPUT_RPC_URL ?? 'https://base-rpc.publicnode.com';
const HOURS = Number(process.env.HOURS ?? 168);
const CHUNK = 10_000;

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { result?: T } | null) : null;
    if (body && body.result !== undefined) return body.result;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(`${method} failed after retries`);
}
const hex = (n: number) => `0x${n.toString(16)}`;
const blockTimes = new Map<number, number>();
async function blockTime(n: number): Promise<number> {
  const cached = blockTimes.get(n);
  if (cached != null) return cached;
  const b = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [hex(n), false]);
  const ts = parseInt(b.timestamp, 16) * 1000;
  blockTimes.set(n, ts);
  return ts;
}
/** First block at or after `ts` (binary search on real block times). */
async function blockAtOrAfter(ts: number, latest: number): Promise<number> {
  // Start a bounded window back (old blocks can be pruned on public nodes), widening if needed.
  let span = Math.ceil(((latest > 0 ? Date.now() - ts : 0) / 1000) * 3) + 1000;
  let lo = Math.max(0, latest - span);
  while (lo > 0 && (await blockTime(lo)) > ts) {
    span *= 2;
    lo = Math.max(0, latest - span);
  }
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(mid)) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Underlying index → symbol, from the optionId prefixes in Callput's own feed. */
async function underlyingMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await fetch(CALLPUT_FEED_URL);
    const body = (await res.json()) as { data?: { market?: Record<string, { options?: Record<string, Record<string, Array<{ optionId?: string }>>> }> } };
    for (const [symbol, m] of Object.entries(body.data?.market ?? {})) {
      for (const expiry of Object.values(m.options ?? {})) {
        const first = [...(expiry.call ?? []), ...(expiry.put ?? [])].find((o) => o.optionId);
        if (first?.optionId) {
          map.set(parseInt(first.optionId.slice(2, 6), 16), symbol);
          break;
        }
      }
    }
  } catch {
    // Symbols then print as their index.
  }
  return map;
}

type Timed = Exclude<CallputEvent, { type: 'requestKey' }> & { ts: number; tx: string };

async function main(): Promise<void> {
  const latest = parseInt(await rpc<string>('eth_blockNumber', []), 16);
  const from = await blockAtOrAfter(Date.now() - HOURS * 3_600_000, latest);
  const symbols = await underlyingMap();
  const events: Timed[] = [];
  for (let b = from; b <= latest; b += CHUNK) {
    const logs = await rpc<RawLog[]>('eth_getLogs', [{ fromBlock: hex(b), toBlock: hex(Math.min(b + CHUNK - 1, latest)), address: CALLPUT_POSITION_MANAGER }]);
    for (const log of logs) {
      const e = decodeCallputLog(log);
      if (!e || e.type === 'requestKey') continue;
      events.push({ ...e, ts: await blockTime(parseInt(log.blockNumber, 16)), tx: log.transactionHash });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  const sym = (i: number) => symbols.get(i) ?? `#${i}`;
  const fmtTime = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
  const tally = new Map<string, number>();
  const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

  console.log(`Callput PositionManager, last ${HOURS} h (blocks ${from}..${latest}), ${events.length} events\n`);
  const pending: Timed[] = [];
  const sizes: Array<{ usdc: number; cancelled: boolean }> = [];
  for (const e of events) {
    if (e.type === 'openRequest' || e.type === 'closeRequest') {
      pending.push(e);
      const shape = `${e.token.legs.length === 1 ? 'single' : 'spread'} ${e.token.legs.map((l) => (l.isBuy ? 'buy' : 'sell')).join('+')}`;
      count(`${e.type === 'openRequest' ? 'open' : 'close'} · ${shape}`);
      continue;
    }
    const wantType = e.type === 'closeExecuted' ? 'closeRequest' : 'openRequest';
    const i = pending.findIndex((p) => p.type === wantType && p.account === e.account && describeLegs(p.token.legs) === describeLegs(e.token.legs) && p.token.expiryTs === e.token.expiryTs);
    const req = i >= 0 ? pending.splice(i, 1)[0] : undefined;
    const u = sym(e.token.underlyingIndex);
    const dec = sizeDecimals(u);
    const head = `${fmtTime(e.ts)}  ${u} ${new Date(e.token.expiryTs).toISOString().slice(0, 13)}h  ${describeLegs(e.token.legs).padEnd(26)}`;
    const latency = req ? `${((e.ts - req.ts) / 1000).toFixed(0)}s` : '?';
    if (e.type === 'openExecuted') {
      const size = toUnits(e.sizeRaw, dec);
      const usdc = toUnits(e.amountInRaw, 6);
      const credit = isCreditSpread(e.token.legs)
        ? toUnits(creditRawIn((await rpc<{ logs: Array<{ address: string; topics: string[]; data: string }> }>('eth_getTransactionReceipt', [e.tx])).logs, e.account), 6)
        : 0;
      if (credit > 0) {
        console.log(`${head}  OPEN  filled  ${size.toPrecision(6)} CREDIT ${(credit / size).toFixed(4)}/unit (${credit.toFixed(2)} paid out; ${(usdc / size).toFixed(4)}/unit deposited)  after ${latency}  ${e.tx}`);
        count('open executed · credit');
      } else {
        console.log(`${head}  OPEN  filled  ${size.toPrecision(6)} @ ${(usdc / size).toFixed(4)} USDC all-in (${usdc.toFixed(2)} in)  after ${latency}  ${e.tx}`);
        count('open executed · debit');
      }
      sizes.push({ usdc, cancelled: false });
    } else if (e.type === 'openCancelled') {
      const usdc = toUnits(e.amountInRaw, 6);
      console.log(`${head}  OPEN  cancelled  ${usdc.toFixed(2)} USDC refunded  after ${latency}  ${e.tx}`);
      count('open cancelled');
      sizes.push({ usdc, cancelled: true });
    } else if (e.type === 'closeExecuted') {
      const size = toUnits(e.sizeRaw, dec);
      const usdc = toUnits(e.amountOutRaw, 6);
      console.log(`${head}  CLOSE filled  ${size.toPrecision(6)} @ ${(usdc / size).toFixed(4)} USDC net (${usdc.toFixed(2)} out)  after ${latency}  ${e.tx}`);
      count('close executed');
    }
  }
  for (const p of pending) console.log(`${fmtTime(p.ts)}  ${sym(p.token.underlyingIndex)}  ${describeLegs(p.token.legs)}  ${p.type === 'openRequest' ? 'OPEN' : 'CLOSE'} request still pending/unmatched  ${p.tx}`);
  console.log('\nTally:');
  for (const [k, n] of [...tally].sort()) console.log(`  ${k.padEnd(28)} ${n}`);
  console.log('\nOpen requests by USDC in (cancelled / total):');
  for (const [lo, hi] of [[0, 10], [10, 100], [100, 500], [500, 1_000], [1_000, 5_000], [5_000, Infinity]] as const) {
    const bucket = sizes.filter((x) => x.usdc >= lo && x.usdc < hi);
    if (bucket.length > 0) console.log(`  ${`${lo}–${hi === Infinity ? '…' : hi}`.padEnd(12)} ${bucket.filter((x) => x.cancelled).length} / ${bucket.length}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
