/**
 * Independent verification of one LIVE signal: pick a pair (manual
 * ../handcheck-target.json when present, else the top executable opportunity
 * from /api/opportunities), then re-fetch the raw Derive ticker, rebuild the
 * Olive AMM premium from the live market file with our own BS math, and
 * recompute every profit field from scratch. Any mismatch vs the server's
 * current /api/pair signal means the pipeline lies.
 *
 * Inputs are LIVE (never pinned): market-file vol + Stork spot + per-custody
 * balances; rates and fee assumptions come from server config (.env), the
 * same source the running server uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { bsPrice, oliveStrikeBounds } from '@options-arb/shared';
import { loadConfig } from '../config';

const API = 'https://api.derive.xyz/v3';
const LEGACY = 'https://api.lyra.finance';
const MARKET_FILE = 'https://olive.exchange/public/market';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8799';

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

interface TargetPick {
  pairKey: string;
  underlying: string;
  expiryDate: string;
  strike: number;
  kind: 'call' | 'put';
  how: string;
}

interface MarketFile {
  spot: number;
  vol: number;
  underlyingFree: number | null;
  usdcFreeUsd: number | null;
  liquidityUsd: number | null;
  rates: { tokenApr: number; usdcApr: number } | null;
}

async function call(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function fetchMarketFile(sym: string): Promise<MarketFile> {
  let lastErr = 'unknown error';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${MARKET_FILE}/${sym}%2FUSDC.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as any;
      const tk = (j.ticker ?? []).find((t: any) => t?.symbol === `${sym}/USD`);
      const snap = j.state?.payload?.snapshot;
      const vol = n(snap?.volatility?.volatility);
      const spot = n(tk?.price);
      if (spot == null || vol == null) throw new Error('spot or vol missing from file');
      const custodyFree = (c: any): number | null => {
        const owned = n(c?.tokenOwned);
        const locked = n(c?.tokenLocked) ?? 0;
        const dec = n(c?.decimals);
        if (owned == null || dec == null || dec < 0 || dec > 18) return null;
        return Math.max(0, (owned - locked) / Math.pow(10, dec));
      };
      const raw = snap?.rawOnChainPoolSnapshot;
      const underlyingFree = custodyFree(raw?.underlyingCustody);
      const usdcFreeUsd = custodyFree(raw?.usdcCustody);
      // Live pricing rates: per-custody borrow curve at current utilization
      // (their UI's "Fixed Rate (L/S)") — independent reimplementation of
      // the adapter's parse.
      const curveRate = (c: any): number | null => {
        const pts = Array.isArray(c?.borrowRateCurve?.points) ? c.borrowRateCurve.points : [];
        const byUtil = new Map<number, number>();
        for (const p of pts) {
          const x = n(p?.utilizationRateBps);
          const y = n(p?.borrowRateBps);
          if (x != null && y != null) byUtil.set(x, y);
        }
        const uniq = [...byUtil.entries()].sort((a, b) => a[0] - b[0]);
        if (uniq.length === 0) return null;
        const owned = n(c?.tokenOwned);
        const locked = n(c?.tokenLocked) ?? 0;
        if (owned == null || owned <= 0) return null;
        const util = Math.min(10_000, Math.max(0, (locked / owned) * 10_000));
        if (util <= uniq[0]![0]) return uniq[0]![1];
        for (let i = 1; i < uniq.length; i++) {
          const [x1, y1] = uniq[i]!;
          if (util <= x1) {
            const [x0, y0] = uniq[i - 1]!;
            return y0 + ((y1 - y0) * (util - x0)) / (x1 - x0);
          }
        }
        return uniq[uniq.length - 1]![1];
      };
      const tokenRateBps = raw?.underlyingCustody ? curveRate(raw.underlyingCustody) : null;
      const usdcRateBps = raw?.usdcCustody ? curveRate(raw.usdcCustody) : null;
      const rates =
        tokenRateBps != null && usdcRateBps != null
          ? { tokenApr: tokenRateBps / 10_000, usdcApr: usdcRateBps / 10_000 }
          : null;
      const aum = n(snap?.poolSummary?.aumUsd);
      const claims = n(snap?.poolSummary?.openPositionEntryClaimsUsd);
      const liquidityUsd =
        underlyingFree != null && usdcFreeUsd != null
          ? underlyingFree * spot + usdcFreeUsd
          : aum != null && claims != null
            ? Math.max(0, aum - claims)
            : null;
      return { spot, vol, underlyingFree, usdcFreeUsd, liquidityUsd, rates };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`market file ${sym} unreachable (${lastErr}) — refusing to verify against pinned inputs`);
}

async function pickTarget(): Promise<TargetPick> {
  // Manual focus file wins; it only selects the pair (the numbers compared
  // against are always the server's LIVE signal for that pair).
  if (existsSync('../handcheck-target.json')) {
    const t = JSON.parse(readFileSync('../handcheck-target.json', 'utf8')) as TargetPick;
    if (!t.pairKey) throw new Error('handcheck-target.json has no pairKey');
    return { ...t, how: 'manual handcheck-target.json' };
  }
  const res = await fetch(`${APP}/api/opportunities`);
  if (!res.ok) throw new Error(`/api/opportunities unreachable (${res.status}) — is the server running?`);
  const { signals } = (await res.json()) as { signals: any[] };
  const executable = signals.filter((s) => s.direction === 'buy_olive_sell_derive');
  const pick = executable[0] ?? [...signals].sort((a, b) => b.score - a.score)[0];
  if (!pick) throw new Error('no opportunities to verify (and no handcheck-target.json)');
  return {
    pairKey: pick.pairKey,
    underlying: pick.underlying,
    expiryDate: pick.expiryDate,
    strike: pick.strike,
    kind: pick.kind,
    how: executable[0]
      ? 'top executable opportunity (/api/opportunities)'
      : 'top-scoring signal — NO executable-direction rows right now (/api/opportunities)',
  };
}

async function main() {
  const cfg = loadConfig();
  const target = await pickTarget();
  console.log(`verifying ${target.pairKey} (${target.how})`);

  const market = await fetchMarketFile(target.underlying);
  // Live borrow-curve rates when present; config pins only as fallback.
  const rates = market.rates
    ? { token: market.rates.tokenApr, usdc: market.rates.usdcApr }
    : (cfg.oliveRateOverrides[target.underlying] ??
      { token: cfg.oliveTokenRateApr, usdc: cfg.oliveUsdcRateApr });
  console.log(
    `live inputs: Stork spot ${market.spot} · model vol ${(market.vol * 100).toFixed(2)}% · rates L/S ${(rates.token * 100).toFixed(2)}%/${(rates.usdc * 100).toFixed(2)}%${market.rates ? ' (borrow-curve, live)' : ' (config pins)'} · custody free: ${market.underlyingFree ?? '?'} ${target.underlying} / $${market.usdcFreeUsd ?? '?'}`,
  );

  const raw = (await call('public/get_tickers', {
    instrument_type: 'option',
    currency: target.underlying,
    expiry_date: Number(target.expiryDate),
  })) as { result?: { tickers?: Record<string, any> } };
  let t = raw.result?.tickers?.[target.pairKey];
  if (!t) throw new Error(`ticker not found for ${target.pairKey} (expired or delisted?)`);

  // Replicate the adapter's book merge: v3 books are often zeroed; the legacy
  // host carries live bid/ask/OI. If v3 shows no book, take legacy's.
  const legacyRes = await fetch(`${LEGACY}/public/get_tickers`, {
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
  // Zero prices mean "no quote" on Derive (v3 zeroed books), same rule as the adapter.
  const bid = n(t.b) != null && n(t.b)! > 0 ? n(t.b)! : null;
  const ask = n(t.a) != null && n(t.a)! > 0 ? n(t.a)! : null;
  const bidSize = bid != null ? n(t.B) ?? 0 : null;
  const askSize = ask != null ? n(t.A) ?? 0 : null;
  const deriveIv = n(op.i) ?? 0;
  const deriveMark = n(op.m) ?? 0;
  const index = n(t.I) ?? market.spot;
  const forward = n(op.f) ?? index;
  const df = n(op.df) ?? 1;
  const delta = n(op.d) ?? 0;

  // The server's own synth inputs for the AMM leg — reusing its exact spot
  // print isolates pipeline correctness from spot drift between fetches.
  const pairRes = await fetch(`${APP}/api/pair?pairKey=${encodeURIComponent(target.pairKey)}`);
  if (!pairRes.ok) throw new Error(`/api/pair unreachable (${pairRes.status})`);
  const { row, signal } = (await pairRes.json()) as { row: any; signal: any };
  if (!signal) throw new Error(`no live signal for ${target.pairKey} in the current cycle`);
  const serverSynthSpot = n(row?.legs?.olive?.quote?.indexPrice) ?? market.spot;

  // ── Independent recomputation (engine semantics, live inputs) ────────────
  const expiryTs = Date.UTC(
    Number(target.expiryDate.slice(0, 4)),
    Number(target.expiryDate.slice(4, 6)) - 1,
    Number(target.expiryDate.slice(6, 8)),
    8,
  );
  const now = Date.now();
  const tau = Math.max(0, (expiryTs - now) / (365 * 86_400_000));
  const r = target.kind === 'call' ? rates.token : -rates.usdc;
  const oliveForward = serverSynthSpot * Math.exp(r * tau);
  // Verified convention (269d + 7d, DATA_SOURCES.md §2d): calls discount at
  // the token rate, puts accrete the strike at the USDC rate.
  const oliveDf =
    target.kind === 'call' ? Math.exp(-rates.token * tau) : Math.exp(rates.usdc * tau);
  const olivePremium = bsPrice({
    forward: oliveForward,
    strike: target.strike,
    tauYears: tau,
    vol: market.vol,
    discountFactor: oliveDf,
    kind: target.kind,
  });

  const spreadVols = (deriveIv - market.vol) * 100;
  const direction = spreadVols >= 0 ? 'buy_olive_sell_derive' : 'buy_derive_sell_olive';
  const entry = direction === 'buy_olive_sell_derive' ? olivePremium : ask ?? deriveMark;
  const exit = direction === 'buy_olive_sell_derive' ? bid ?? deriveMark : olivePremium;
  const gross = exit - entry;

  const spot = index; // engine: dq.indexPrice ?? spotByUnderlying ?? forward
  // Fee models (verified 2026-09-29):
  //   Derive taker: $0.50/order + min(3bps × notional, 12.5% × leg premium)
  //   Olive:        min(2.5bps × qty × ORACLE SPOT, 10% × premium) — spot base for both kinds
  const deriveLegPremium =
    spreadVols >= 0 ? bid ?? deriveMark : ask ?? deriveMark;
  let deriveFee = spot * (cfg.deriveTakerFeeBps / 10_000);
  if (deriveLegPremium != null && deriveLegPremium > 0) {
    deriveFee = Math.min(deriveFee, deriveLegPremium * 0.125);
  }
  const oliveFee = olivePremium > 0 ? Math.min(spot * 0.00025, olivePremium * 0.1) : 0;
  const costs = deriveFee + oliveFee; // Solana tx fee is per clip — in total below
  const collateral = target.kind === 'call' ? spot : target.strike;
  const capital = collateral * cfg.capitalBorrowRateApr * tau;
  const net = gross - costs;
  const netAfterCapital = net - capital;

  // Size: direction-relevant Derive touch × per-custody pool capacity
  // (calls lock the underlying custody, puts K USDC each); scalar AUM
  // fallback when the custody snapshot is missing.
  const bookSize = direction === 'buy_olive_sell_derive' ? bidSize : askSize;
  const custodyCap =
    target.kind === 'call' ? market.underlyingFree : market.usdcFreeUsd != null ? market.usdcFreeUsd / target.strike : null;
  const scalar = market.liquidityUsd ?? cfg.olivePoolLiquidityUsd[target.underlying] ?? null;
  const fallbackCap = scalar != null && collateral > 0 ? Math.floor(scalar / collateral) : null;
  let size = bookSize;
  if (bookSize != null) {
    const capacity = custodyCap ?? fallbackCap;
    if (capacity != null && capacity < bookSize) size = capacity;
  }
  const total = size != null && size > 0 && netAfterCapital != null ? netAfterCapital * size - 0.5 - cfg.solanaFeeUsdc : null; // $0.50 Derive order fee + one Solana tx
  const apy = netAfterCapital / collateral / tau * 100;
  const basis = Math.abs(delta) * spot * deriveIv * Math.sqrt(0.5 / (365 * 24));
  // Cross-check: reprice at the CYCLE's olive vol (row.legs.olive.quote.iv) so the
  // only residual is Derive-mark drift between the cycle and this fetch.
  const xchkVol = n(row?.legs?.olive?.quote?.iv) ?? market.vol;
  const xchk = deriveMark - bsPrice({ forward, strike: target.strike, tauYears: tau, vol: xchkVol, discountFactor: df, kind: target.kind });

  const cmp = (label: string, mine: number | null, theirs: number | null, tol = 0.02) => {
    if (mine == null || theirs == null) return `${label}: mine=${mine} theirs=${theirs} (null mismatch?)`;
    const ok = Math.abs(mine - theirs) <= tol;
    return `${label}: mine=${mine.toFixed(4)} theirs=${theirs} ${ok ? '✓' : `✗ DIFF ${Math.abs(mine - theirs).toFixed(4)}`}`;
  };
  console.log(`hand-check of ${target.pairKey} (tau=${tau.toFixed(6)}y, Derive index=${index}, server synth spot=${serverSynthSpot}, stork=${market.spot})`);
  console.log(`Derive IV: mine(fresh)=${(deriveIv * 100).toFixed(2)}% theirs(cycle)=${signal.ivSpreadVols != null ? (((signal.ivSpreadVols / 100) + market.vol) * 100).toFixed(2) : '?'}% — quoted IVs drift between the cycle and this check`);
  console.log(`direction: mine=${direction} theirs=${signal.direction} ${direction === signal.direction ? '✓' : '✗'}`);
  // 0.5 vol pts: Derive's quoted IV on the wings can jump a few tenths
  // between the server's cycle and this fetch; the point is catching gross
  // pipeline errors (wrong vol source / scale), not tick-level drift.
  console.log(cmp('spreadVols', spreadVols, signal.ivSpreadVols, 0.5));
  console.log(cmp('entryPrice', entry, signal.entryPriceUsdc, 0.02));
  console.log(cmp('exitPrice', exit, signal.exitPriceUsdc, 0.02));
  console.log(cmp('grossEdge', gross, signal.edgeUsdc, 0.02));
  console.log(cmp('costs', costs, signal.costsUsdc, 0.02));
  console.log(cmp('capitalCost', capital, signal.capitalCostUsdc, 0.05));
  console.log(cmp('netEdge', net, signal.netEdgeUsdc, 0.03));
  console.log(cmp('netAfterCapital', netAfterCapital, signal.netAfterCapitalUsdc, 0.05));
  console.log(cmp('maxSize', size, signal.maxExecutableSize, 0.5));
  console.log(cmp('totalNet', total, signal.totalNetUsdc, 1));
  console.log(cmp('roiApyPct', apy, signal.roiApyPct, 0.5));
  console.log(cmp('settlementBasis', basis, signal.settlementBasisUsdc, 0.01));
  // 0.1: this field differences the (fresh) Derive mark against a reprice —
  // mark drift between the cycle and this check lands here wholesale.
  console.log(cmp('syntheticCrossCheck', xchk, signal.syntheticCrossCheckUsdc, 0.1));

  // ── Executability verdicts: would the venue accept this trade? ───────────
  // Strike band: docs + live-UI verified ±1σ (2026-09-29). Size: quantities
  // are 1e-6 native (confirmed by a live fill), so sub-tick sizes are dust.
  const band = oliveStrikeBounds(serverSynthSpot, market.vol, tau, { tokenApr: rates.token, usdcApr: rates.usdc }, 1);
  const inBand = target.strike >= band.lower && target.strike <= band.upper;
  const sizeOk = signal.maxExecutableSize == null || signal.maxExecutableSize >= 1e-6;
  console.log(`executability: strike ${target.strike} in venue band [${band.lower.toFixed(0)}, ${band.upper.toFixed(0)}]: ${inBand ? '✓' : '✗ OUT OF BAND — the venue refuses this strike'}`);
  console.log(`executability: size ${signal.maxExecutableSize ?? 'null'} vs 1e-6 tick: ${sizeOk ? '✓' : '✗ below minimum quantity'}`);
}

main().catch((e) => {
  console.error('HANDCHECK FAILED:', e);
  process.exit(1);
});
