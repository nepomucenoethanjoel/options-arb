/**
 * Independent verification of one LIVE book-venue pair signal (no Olive
 * leg): re-fetch each venue's RAW quote (no adapter code), recompute the
 * profit fields with independently written fee formulas, compare against
 * the server's /api/pair signal. Olive pairs are covered by handcheck.ts.
 *
 *   npx tsx src/scripts/handcheck-books.ts            # top book-pair opportunity
 *   PAIR_KEY=SOL-20261106-100-C npx tsx src/scripts/handcheck-books.ts
 */
import { loadConfig } from '../config';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:8799';
const BOOK_VENUES = ['derive', 'coincall'] as const;
type BookVenue = (typeof BOOK_VENUES)[number];

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : null;
};
const pos = (v: unknown): number | null => {
  const x = n(v);
  return x != null && x > 0 ? x : null;
};

interface RawQuote {
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  mark: number | null;
  index: number | null;
}

async function deriveRaw(underlying: string, expiryDate: string, name: string): Promise<RawQuote> {
  const post = (host: string) =>
    fetch(`${host}/public/get_tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument_type: 'option', currency: underlying, expiry_date: Number(expiryDate) }),
    }).then((r) => r.json() as Promise<{ result?: { tickers?: Record<string, any> }; tickers?: Record<string, any> }>);
  const v3 = await post('https://api.derive.xyz/v3');
  let t = v3.result?.tickers?.[name];
  if (!t) throw new Error(`Derive ticker ${name} not found`);
  // Same merge rule as the adapter: v3 books can be zeroed; legacy fills them.
  const legacy = await post('https://api.lyra.finance').catch(() => null);
  const lt = legacy?.result?.tickers?.[name] ?? legacy?.tickers?.[name];
  if (lt && !n(t.b) && !n(t.a) && (n(lt.b) || n(lt.a))) t = { ...t, b: lt.b, B: lt.B, a: lt.a, A: lt.A };
  const bid = pos(t.b);
  const ask = pos(t.a);
  return { bid, bidSize: bid != null ? n(t.B) ?? 0 : null, ask, askSize: ask != null ? n(t.A) ?? 0 : null, mark: n(t.option_pricing?.m), index: pos(t.I) };
}

async function coincallRaw(underlying: string, symbol: string): Promise<RawQuote> {
  const res = await fetch(`https://api.coincall.com/open/option/get/v1/${underlying}USD`);
  const body = (await res.json()) as { data?: Array<{ callOption?: any; putOption?: any }> };
  const o = (body.data ?? []).flatMap((e) => [e.callOption, e.putOption]).find((x) => x?.symbol === symbol);
  if (!o) throw new Error(`Coincall ${symbol} not found`);
  const bid = pos(o.bid);
  const ask = pos(o.ask);
  return { bid, bidSize: bid != null ? n(o.bidSize) : null, ask, askSize: ask != null ? n(o.askSize) : null, mark: n(o.markPrice), index: pos(o.underlyingPrice) };
}

/** Taker fee per contract, written from the venue docs (not fees.ts). */
function feeOf(venue: BookVenue, legPrice: number | null, spot: number, underlying: string, kind: string, strike: number, tteDays: number, deriveBps: number): number {
  if (venue === 'derive') {
    const f = spot * (deriveBps / 10_000);
    return legPrice != null && legPrice > 0 ? Math.min(f, 0.125 * legPrice) : f;
  }
  const rate = underlying === 'BTC' || underlying === 'ETH' ? 0.0003 : 0.0006;
  const trade = legPrice != null && legPrice > 0 ? Math.min(spot * rate, 0.125 * legPrice) : spot * rate;
  const intrinsic = Math.max(0, kind === 'call' ? spot - strike : strike - spot);
  return trade + (tteDays < 1 ? 0 : Math.min(spot * 0.00015, 0.125 * intrinsic));
}
const ORDER_FEE: Record<BookVenue, number> = { derive: 0.5, coincall: 0 };

async function main() {
  const cfg = loadConfig();
  let pairKey = process.env.PAIR_KEY;
  if (!pairKey) {
    // Any live book-pair signal with a size (best score first), not just threshold opportunities.
    const { signals } = (await (await fetch(`${APP}/api/overview`)).json()) as { signals: any[] };
    signals.sort((a, b) => b.score - a.score);
    const pick = signals.find(
      (s) => BOOK_VENUES.includes(s.buyVenue) && BOOK_VENUES.includes(s.sellVenue) && s.maxExecutableSize > 0,
    );
    if (!pick) throw new Error('no sized book-venue pair signal right now (set PAIR_KEY)');
    pairKey = pick.pairKey as string;
  }
  const { row, signal } = (await (await fetch(`${APP}/api/pair?pairKey=${encodeURIComponent(pairKey)}`)).json()) as { row: any; signal: any };
  if (!signal) throw new Error(`no live signal for ${pairKey}`);
  const buy = signal.buyVenue as BookVenue;
  const sell = signal.sellVenue as BookVenue;
  if (!BOOK_VENUES.includes(buy) || !BOOK_VENUES.includes(sell)) throw new Error(`${pairKey} is ${buy}→${sell}; use handcheck.ts for Olive pairs`);
  console.log(`verifying ${pairKey}: buy ${buy} · sell ${sell}`);

  const raw = async (v: BookVenue): Promise<RawQuote> =>
    v === 'derive'
      ? deriveRaw(row.underlying, row.expiryDate, row.legs.derive.instrumentId)
      : coincallRaw(row.underlying, row.legs.coincall.instrumentId);
  const [bq, sq] = await Promise.all([raw(buy), raw(sell)]);
  const pair = BOOK_VENUES.filter((v) => v === buy || v === sell);
  const ref = pair[0] === buy ? bq : sq; // first book venue in venue order (Derive before Coincall)
  const spot = ref.index ?? (bq.index ?? sq.index)!;
  const tau = Math.max(0, (row.expiryTs - Date.now()) / (365 * 86_400_000));
  const tteDays = tau * 365;
  const entry = bq.ask ?? bq.mark;
  const exit = sq.bid ?? sq.mark;
  const gross = entry != null && exit != null ? exit - entry : null;
  const costs =
    feeOf(buy, entry, spot, row.underlying, row.kind, row.strike, tteDays, cfg.deriveTakerFeeBps) +
    feeOf(sell, exit, spot, row.underlying, row.kind, row.strike, tteDays, cfg.deriveTakerFeeBps);
  const collateral = row.kind === 'call' ? spot : row.strike;
  const capital = collateral * cfg.capitalBorrowRateApr * tau;
  const netAfterCapital = gross != null ? gross - costs - capital : null;
  const size = bq.askSize != null && sq.bidSize != null ? Math.min(bq.askSize, sq.bidSize) : null;
  const total = size != null && size > 0 && netAfterCapital != null ? netAfterCapital * size - ORDER_FEE[buy] - ORDER_FEE[sell] : null;

  const cmp = (label: string, mine: number | null, theirs: number | null, tol: number) => {
    if (mine == null || theirs == null) return `${label}: mine=${mine} theirs=${theirs} ${mine === theirs ? '✓' : '(null mismatch?)'}`;
    const ok = Math.abs(mine - theirs) <= tol;
    return `${label}: mine=${mine.toFixed(4)} theirs=${theirs} ${ok ? '✓' : `✗ DIFF ${Math.abs(mine - theirs).toFixed(4)}`}`;
  };
  console.log(cmp('entryPrice', entry, signal.entryPriceUsdc, 0.02));
  console.log(cmp('exitPrice', exit, signal.exitPriceUsdc, 0.02));
  console.log(cmp('grossEdge', gross, signal.edgeUsdc, 0.02));
  console.log(cmp('costs', costs, signal.costsUsdc, 0.02));
  console.log(cmp('capitalCost', capital, signal.capitalCostUsdc, 0.05));
  console.log(cmp('netAfterCapital', netAfterCapital, signal.netAfterCapitalUsdc, 0.05));
  console.log(cmp('maxSize', size, signal.maxExecutableSize, 0.01));
  console.log(cmp('totalNet', total, signal.totalNetUsdc, 1));
}

main().catch((e) => {
  console.error('HANDCHECK FAILED:', e);
  process.exit(1);
});
