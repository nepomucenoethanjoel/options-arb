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
      // ticker went empty ~2026-10-31; the fresh execution oracle is the same Stork feed (row 52).
      const ob = snap?.executionOracle?.base;
      const spot = n(tk?.price) ?? (ob?.label === `${sym}/USD` && ob?.isFresh === true ? n(ob.price) : null);
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
  // Scheduled runs (HANDCHECK_AUTO=1) ignore a leftover manual focus file.
  if (process.env.HANDCHECK_AUTO !== '1' && existsSync('../handcheck-target.json')) {
    const t = JSON.parse(readFileSync('../handcheck-target.json', 'utf8')) as TargetPick;
    if (!t.pairKey) throw new Error('handcheck-target.json has no pairKey');
    return { ...t, how: 'manual handcheck-target.json' };
  }
  const res = await fetch(`${APP}/api/opportunities`);
  if (!res.ok) throw new Error(`/api/opportunities unreachable (${res.status}) — is the server running?`);
  const { signals } = (await res.json()) as { signals: any[] };
  // This script verifies Olive × Derive pairs (book pairs: handcheck-books.ts).
  const oliveDerive = signals.filter((s) => [s.buyVenue, s.sellVenue].sort().join() === 'derive,olive');
  const executable = oliveDerive.filter((s) => s.buyVenue === 'olive');
  const pick = executable[0] ?? [...oliveDerive].sort((a, b) => b.score - a.score)[0];
  if (!pick) throw new NothingToCheck('no opportunities to verify (and no handcheck-target.json)');
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

/** Exit codes (scheduled runs, deploy/options-arb-handcheck.sh): 0 all ✓, 1 a
 *  pipeline field ✗ or an error, 3 nothing to check right now. */
let failures = 0;
class NothingToCheck extends Error {}

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
  // FRESH Derive ticker — used only for the live-parity check below. The
  // pipeline recomputation uses the cycle's own stored Derive quote (same
  // instant as the signal), so quote drift between the cycle and this fetch
  // cannot masquerade as a pipeline error (it false-failed every BTC/ETH pair).
  const fresh = {
    bid: n(t.b) != null && n(t.b)! > 0 ? n(t.b)! : null,
    ask: n(t.a) != null && n(t.a)! > 0 ? n(t.a)! : null,
    bidSize: n(t.B) ?? 0,
    askSize: n(t.A) ?? 0,
    iv: n(op.i) ?? 0,
    mark: n(op.m) ?? 0,
    index: n(t.I) ?? market.spot,
    forward: n(op.f) ?? (n(t.I) ?? market.spot),
    df: n(op.df) ?? 1,
    delta: n(op.d) ?? 0,
  };

  // The server's own synth inputs for the AMM leg — reusing its exact spot
  // print isolates pipeline correctness from spot drift between fetches.
  const pairRes = await fetch(`${APP}/api/pair?pairKey=${encodeURIComponent(target.pairKey)}`);
  if (!pairRes.ok) throw new Error(`/api/pair unreachable (${pairRes.status})`);
  const { row, signal } = (await pairRes.json()) as { row: any; signal: any };
  if (!signal) throw new Error(`no live signal for ${target.pairKey} in the current cycle`);
  if ([signal.buyVenue, signal.sellVenue].sort().join() !== 'derive,olive') {
    throw new NothingToCheck(`${target.pairKey} is now ${signal.buyVenue}→${signal.sellVenue}; this script verifies Olive × Derive pairs`);
  }
  const serverSynthSpot = n(row?.legs?.olive?.quote?.indexPrice) ?? market.spot;
  // Zero prices mean "no quote" on Derive (v3 zeroed books), same rule as the adapter.
  const cq = row?.legs?.derive?.quote;
  const cycleMode = cq != null && n(cq.indexPrice) != null && n(cq.ts) != null;
  const pos = (v: unknown) => (n(v) != null && n(v)! > 0 ? n(v)! : null);
  const bid = cycleMode ? pos(cq.bid) : fresh.bid;
  const ask = cycleMode ? pos(cq.ask) : fresh.ask;
  const bidSize = bid != null ? (cycleMode ? n(cq.bidSize) ?? 0 : fresh.bidSize) : null;
  const askSize = ask != null ? (cycleMode ? n(cq.askSize) ?? 0 : fresh.askSize) : null;
  const deriveIv = cycleMode ? n(cq.iv) ?? 0 : fresh.iv;
  const deriveMark = cycleMode ? n(cq.mark) ?? 0 : fresh.mark;
  const index = cycleMode ? n(cq.indexPrice)! : fresh.index;
  const forward = cycleMode ? n(cq.forward) ?? index : fresh.forward;
  const df = cycleMode ? n(cq.discountFactor) ?? 1 : fresh.df;
  const delta = cycleMode ? n(cq.greeks?.delta) ?? 0 : fresh.delta;
  console.log(cycleMode ? `recomputing from the cycle's own Derive quote (ts ${new Date(n(cq.ts)!).toISOString()})` : 'cycle Derive quote missing — recomputing from the FRESH ticker (drift-sensitive)');

  // ── Independent recomputation (engine semantics, live inputs) ────────────
  const expiryTs = Date.UTC(
    Number(target.expiryDate.slice(0, 4)),
    Number(target.expiryDate.slice(4, 6)) - 1,
    Number(target.expiryDate.slice(6, 8)),
    8,
  );
  const now = cycleMode ? n(cq.ts)! : Date.now();
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
    if (mine == null || theirs == null) {
      if (mine !== theirs) failures++;
      return `${label}: mine=${mine} theirs=${theirs} (null mismatch?)`;
    }
    const ok = Math.abs(mine - theirs) <= tol;
    if (!ok) failures++;
    return `${label}: mine=${mine.toFixed(4)} theirs=${theirs} ${ok ? '✓' : `✗ DIFF ${Math.abs(mine - theirs).toFixed(4)}`}`;
  };
  console.log(`hand-check of ${target.pairKey} (tau=${tau.toFixed(6)}y, Derive index=${index}, server synth spot=${serverSynthSpot}, stork=${market.spot})`);
  console.log(`Derive IV: mine(fresh)=${(deriveIv * 100).toFixed(2)}% theirs(cycle)=${signal.ivSpreadVols != null ? (((signal.ivSpreadVols / 100) + market.vol) * 100).toFixed(2) : '?'}% — quoted IVs drift between the cycle and this check`);
  const theirs = `buy_${signal.buyVenue}_sell_${signal.sellVenue}`;
  if (direction !== theirs) failures++;
  console.log(`direction: mine=${direction} theirs=${theirs} ${direction === theirs ? '✓' : '✗'}`);
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
  // Relative: basis = |delta|·S·σ·√(0.5h) scales with the underlying, so a flat
  // 0.01 USD false-failed every BTC/ETH pair (0.16% IV/spot drift = 0.011 on
  // BTC). 1% of value still catches a wrong vol source/scale (those are ≥10%).
  console.log(cmp('settlementBasis', basis, signal.settlementBasisUsdc, Math.max(0.01, 0.01 * Math.abs(signal.settlementBasisUsdc ?? basis))));
  console.log(cmp('syntheticCrossCheck', xchk, signal.syntheticCrossCheckUsdc, 0.1));

  // Live parity: the cycle's stored Derive quote vs the fresh ticker, so a
  // wrong field mapping / scale in the adapter still fails. Allowed difference
  // is the first-order move of the quote over the elapsed spot and IV drift
  // (1.25·|delta|·dS gamma margin, + vega·dIV), + 1% of price for book noise.
  if (cycleMode) {
    const dS = Math.abs(fresh.index - index);
    const vegaPerVol = (bsPrice({ forward, strike: target.strike, tauYears: tau, vol: deriveIv + 0.005, discountFactor: df, kind: target.kind }) -
      bsPrice({ forward, strike: target.strike, tauYears: tau, vol: Math.max(1e-4, deriveIv - 0.005), discountFactor: df, kind: target.kind })) / 0.01;
    const allow = (px: number) => 1.25 * Math.abs(delta) * dS + 1.25 * Math.abs(vegaPerVol) * Math.abs(fresh.iv - deriveIv) + 0.01 * px + 0.02;
    console.log(`live parity (cycle quote vs fresh ticker; index drift ${dS.toFixed(2)} = ${(index ? (dS / index) * 1e4 : 0).toFixed(1)} bps):`);
    if (dS / index > 0.0050) {
      console.log('  index moved >50 bps since the cycle — parity inconclusive, skipped');
    } else {
      console.log('  ' + cmp('mark', fresh.mark, deriveMark, allow(deriveMark)));
      if (bid != null && fresh.bid != null) console.log('  ' + cmp('bid', fresh.bid, bid, allow(bid)));
      if (ask != null && fresh.ask != null) console.log('  ' + cmp('ask', fresh.ask, ask, allow(ask)));
    }
  }

  // ── Executability verdicts: would the venue accept this trade? ───────────
  // Strike band: docs + live-UI verified ±1σ (2026-09-29). Size: quantities
  // are 1e-6 native (confirmed by a live fill), so sub-tick sizes are dust.
  const band = oliveStrikeBounds(serverSynthSpot, market.vol, tau, { tokenApr: rates.token, usdcApr: rates.usdc }, 1);
  const inBand = target.strike >= band.lower && target.strike <= band.upper;
  const sizeOk = signal.maxExecutableSize == null || signal.maxExecutableSize >= 1e-6;
  console.log(`executability: strike ${target.strike} in venue band [${band.lower.toFixed(0)}, ${band.upper.toFixed(0)}]: ${inBand ? '✓' : '✗ OUT OF BAND — the venue refuses this strike'}`);
  console.log(`executability: size ${signal.maxExecutableSize ?? 'null'} vs 1e-6 tick: ${sizeOk ? '✓' : '✗ below minimum quantity'}`);
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`HANDCHECK MISMATCH: ${failures} field(s) ✗`);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    if (e instanceof NothingToCheck) {
      console.log(`HANDCHECK SKIPPED: ${e.message}`);
      process.exitCode = 3;
      return;
    }
    console.error('HANDCHECK FAILED:', e);
    process.exit(1);
  });
