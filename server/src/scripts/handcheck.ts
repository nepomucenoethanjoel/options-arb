/**
 * Independent verification of one live signal: fetch the raw Derive ticker
 * directly, rebuild the Olive AMM premium with our own BS math, and recompute
 * every profit field from scratch. Any mismatch vs /api/opportunities means
 * the pipeline lies.
 */
import { bsPrice } from '@options-arb/shared';

const API = 'https://api.derive.xyz/v3';

async function call(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

async function main() {
  // Server-reported signal (the thing being verified)
  const target = JSON.parse(
    (await import('node:fs')).readFileSync('../handcheck-target.json', 'utf8'),
  ) as {
    pairKey: string; underlying: string; expiryDate: string; strike: number; kind: 'call' | 'put';
    ivSpreadVols: number | null; entryPriceUsdc: number | null; exitPriceUsdc: number | null;
    edgeUsdc: number | null; netEdgeUsdc: number | null; netAfterCapitalUsdc: number | null;
    costsUsdc: number; capitalCostUsdc: number; maxExecutableSize: number | null;
    totalNetUsdc: number | null; roiApyPct: number | null; settlementBasisUsdc: number | null;
    syntheticCrossCheckUsdc: number | null; isProfitable: boolean;
  };

  const raw = (await call('public/get_tickers', {
    instrument_type: 'option',
    currency: target.underlying,
    expiry_date: Number(target.expiryDate),
  })) as { result?: { tickers?: Record<string, any> } };
  let t = raw.result?.tickers?.[target.pairKey];
  if (!t) throw new Error(`ticker not found for ${target.pairKey}`);

  // Replicate the adapter's book merge: v3 books are often zeroed; the legacy
  // host carries live bid/ask/OI. If v3 shows no book, take legacy's.
  const legacyRes = await fetch('https://api.lyra.finance/public/get_tickers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrument_type: 'option',
      currency: target.underlying,
      expiry_date: Number(target.expiryDate),
    }),
  })
    .then((r) => r.json() as Promise<{ result?: { tickers?: Record<string, any> }; tickers?: Record<string, any> }>)
    .catch(() => null);
  const lt = legacyRes?.result?.tickers?.[target.pairKey] ?? legacyRes?.tickers?.[target.pairKey];
  if (lt) {
    const v3Empty = !n(t.b) && !n(t.a);
    const legacyLive = n(lt.b) || n(lt.a);
    if (v3Empty && legacyLive) {
      t = { ...t, b: lt.b, B: lt.B, a: lt.a, A: lt.A, stats: lt.stats ?? t.stats };
    }
  }

  const op = t.option_pricing ?? {};

  const bid = n(t.b) ?? 0;
  const ask = n(t.a) ?? 0;
  const bidSize = n(t.B) ?? 0;
  const askSize = n(t.A) ?? 0;
  const deriveIv = n(op.i) ?? 0;
  const index = n(t.I) ?? 0;
  const forward = n(op.f) ?? index;
  const df = n(op.df) ?? 1;
  const delta = n(op.d) ?? 0;

  // Olive side (verified convention: per-asset carry F = S·e^(rL·T), df = 1)
  const OLIVE = {
    SOL: { vol: 0.6898, rateL: 0.1507 },
    BTC: { vol: 0.4910, rateL: 0.08 },
    ETH: { vol: 0.5335, rateL: 0.08 },
  }[target.underlying] ?? { vol: 0.6898, rateL: 0.1507 };
  const OLIVE_VOL = OLIVE.vol;
  const expiryTs = Date.UTC(
    Number(target.expiryDate.slice(0, 4)),
    Number(target.expiryDate.slice(4, 6)) - 1,
    Number(target.expiryDate.slice(6, 8)),
    8,
  );
  const now = Date.now();
  const tau = Math.max(0, (expiryTs - now) / (365 * 86_400_000));
  const olivePremium = bsPrice({
    forward: index * Math.exp(OLIVE.rateL * tau),
    strike: target.strike,
    tauYears: tau,
    vol: OLIVE_VOL,
    discountFactor: 1,
    kind: target.kind,
  });

  // Cost model (defaults from .env.example)
  const deriveTakerFeeBps = 3;
  const solanaFeeUsdc = 0.05;
  const capitalBorrowRateApr = 0.08;
  const notional = target.kind === 'call' ? index : target.strike;
  const deriveFee = notional * (deriveTakerFeeBps / 10_000);
  const oliveFee = Math.min(notional * 0.00025, olivePremium * 0.1);
  const costs = deriveFee + oliveFee + solanaFeeUsdc;
  const collateral = target.kind === 'call' ? index : target.strike;
  const capital = collateral * capitalBorrowRateApr * tau;

  const spreadVols = (deriveIv - OLIVE_VOL) * 100;
  const direction = spreadVols >= 0 ? 'buy_olive_sell_derive' : 'buy_derive_sell_olive';
  const entry = direction === 'buy_olive_sell_derive' ? olivePremium : ask;
  const exit = direction === 'buy_olive_sell_derive' ? bid : olivePremium;
  const gross = exit - entry;
  const net = gross - costs;
  const netAfterCapital = net - capital;
  const size = bidSize > 0 && askSize > 0 ? Math.min(bidSize, askSize) : null;
  const total = size ? netAfterCapital * size : null;
  const apy = netAfterCapital / collateral / tau * 100;
  const basis = Math.abs(delta) * index * deriveIv * Math.sqrt(0.5 / (365 * 24));
  const mid = (bid + ask) / 2;
  const xchk = mid - bsPrice({ forward, strike: target.strike, tauYears: tau, vol: OLIVE_VOL, discountFactor: df, kind: target.kind });

  const cmp = (label: string, mine: number | null, theirs: number | null, tol = 0.02) => {
    if (mine == null || theirs == null) return `${label}: mine=${mine} theirs=${theirs} (null mismatch?)`;
    const ok = Math.abs(mine - theirs) <= tol;
    return `${label}: mine=${mine.toFixed(4)} theirs=${theirs} ${ok ? '✓' : `✗ DIFF ${Math.abs(mine - theirs).toFixed(4)}`}`;
  };
  console.log(`hand-check of ${target.pairKey} (tau=${tau.toFixed(6)}y, spot=${index})`);
  console.log(cmp('spreadVols', spreadVols, target.ivSpreadVols, 0.05));
  console.log(cmp('entryPrice', entry, target.entryPriceUsdc, 0.02));
  console.log(cmp('exitPrice', exit, target.exitPriceUsdc, 0.02));
  console.log(cmp('grossEdge', gross, target.edgeUsdc, 0.02));
  console.log(cmp('costs', costs, target.costsUsdc, 0.02));
  console.log(cmp('capitalCost', capital, target.capitalCostUsdc, 0.05));
  console.log(cmp('netEdge', net, target.netEdgeUsdc, 0.03));
  console.log(cmp('netAfterCapital', netAfterCapital, target.netAfterCapitalUsdc, 0.05));
  console.log(cmp('maxSize', size, target.maxExecutableSize, 0.5));
  console.log(cmp('totalNet', total, target.totalNetUsdc, 1));
  console.log(cmp('roiApyPct', apy, target.roiApyPct, 0.5));
  console.log(cmp('settlementBasis', basis, target.settlementBasisUsdc, 0.01));
  console.log(cmp('syntheticCrossCheck', xchk, target.syntheticCrossCheckUsdc, 0.03));
}

main().catch((e) => {
  console.error('HANDCHECK FAILED:', e);
  process.exit(1);
});
