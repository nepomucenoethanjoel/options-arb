/**
 * Full-matrix pricing verification (zero-drift method): every (asset × expiry)
 * combo, sampling near-ATM + wing strikes, calls and puts.
 *
 * Per sampled pair:
 *   A. OLIVE leg: /api/pair full quote repriced with ITS OWN inputs
 *      (indexPrice, iv, expiryTs) — any mismatch is an adapter bug, no
 *      timing noise possible.
 *   B. DERIVE leg: lite-row bid/ask/IV vs a fresh RAW fetch from both Derive
 *      hosts (books move tick-to-tick; only gross mismatches matter).
 *   C. Spot sanity: the olive row's indexPrice vs a fresh market-file print,
 *      tolerance ±0.4% (real minute-scale drift).
 *
 *   npm run compare:sweep
 */
import { bsPrice } from '@options-arb/shared';

const RATES: Record<string, { token: number; usdc: number }> = {
  SOL: { token: 0.1507, usdc: 0.02 },
  ETH: { token: 0.08, usdc: 0.02 },
  BTC: { token: 0.08, usdc: 0.02 },
  ZEC: { token: 0.08, usdc: 0.2718 },
};

const n = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
};

const strikeToDerive = (strike: number): string => {
  const s = strike.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s.includes('.') ? s.replace('.', '_') : s;
};

interface LiteRow {
  pairKey: string;
  underlying: string;
  expiryDate: string;
  expiryTs: number;
  strike: number;
  kind: 'call' | 'put';
  deriveIv: number | null;
  deriveBid: number | null;
  deriveAsk: number | null;
}

function pickSamples(rows: LiteRow[], spot: number): LiteRow[] {
  const calls = rows.filter((r) => r.kind === 'call');
  const puts = rows.filter((r) => r.kind === 'put');
  const nearest = (arr: LiteRow[], target: number) =>
    [...arr].sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0] ?? null;
  return [
    nearest(calls, spot),
    nearest(puts, spot),
    nearest(calls, spot * 1.2),
    nearest(puts, spot * 0.8),
  ].filter((r): r is LiteRow => r != null && r.deriveIv != null);
}

async function postJson(url: string, body: unknown, tries = 3): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return null;
}

async function deriveRaw(ccy: string, expiryDate: string) {
  const body = { instrument_type: 'option', currency: ccy, expiry_date: Number(expiryDate) };
  const [j3, jl] = await Promise.all([
    postJson('https://api.derive.xyz/v3/public/get_tickers', body),
    postJson('https://api.lyra.finance/public/get_tickers', body),
  ]);
  const m = (j: any) => new Map<string, any>(Object.entries(j?.result?.tickers ?? {}));
  return { v3: m(j3), legacy: m(jl) };
}

async function marketFileSpot(sym: string): Promise<number> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://olive.exchange/public/market/${sym}%2FUSDC.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      const p = (Array.isArray(j.ticker) ? j.ticker : []).find((t: any) => t?.symbol === `${sym}/USD`)?.price;
      if (typeof p === 'number') return p;
      throw new Error('no price');
    } catch (e) {
      if (i === 2) throw new Error(`market file ${sym}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const overview = await fetch('http://127.0.0.1:8799/api/overview').then((r) => r.json());
  const rows: LiteRow[] = overview.rows ?? [];
  const assets = [...new Set(rows.map((r) => r.underlying))];
  const spotNow: Record<string, number> = {};
  for (const a of assets) spotNow[a] = await marketFileSpot(a);
  console.log('spot sanity anchors:', JSON.stringify(Object.fromEntries(Object.entries(spotNow).map(([k, v]) => [k, +v.toFixed(2)]))));

  const combos = new Map<string, LiteRow[]>();
  for (const r of rows) {
    const k = `${r.underlying}|${r.expiryDate}`;
    combos.set(k, [...(combos.get(k) ?? []), r]);
  }

  let checked = 0;
  let worstOlivePct = 0;
  let worstSpotDriftPct = 0;
  const deriveMisses: string[] = [];
  const summary: string[] = [];

  for (const [combo, comboRows] of [...combos.entries()].sort()) {
    const [ccy, expiryDate] = combo.split('|')!;
    const samples = pickSamples(comboRows, spotNow[ccy]!);
    if (samples.length === 0) continue;

    // A + C: zero-drift olive reprice + spot sanity via /api/pair
    let comboWorst = 0;
    for (const s of samples) {
      const full = await fetch(`http://127.0.0.1:8799/api/pair?pairKey=${s.pairKey}`).then((x) => x.json());
      const q = full.row?.olive?.quote;
      if (!q?.mark || q.iv == null || !q.indexPrice) continue;
      const rate = RATES[ccy] ?? { token: 0, usdc: 0 };
      const tau = Math.max(0, (full.row.expiryTs - Date.now()) / (365 * 86_400_000));
      const fwd = s.kind === 'call' ? q.indexPrice * Math.exp(rate.token * tau) : q.indexPrice * Math.exp(-rate.usdc * tau);
      const reprice = bsPrice({ forward: fwd, strike: s.strike, tauYears: tau, vol: q.iv, discountFactor: 1, kind: s.kind });
      const pct = (Math.abs(q.mark - reprice) / Math.max(reprice, 0.01)) * 100;
      comboWorst = Math.max(comboWorst, pct);
      worstOlivePct = Math.max(worstOlivePct, pct);
      const drift = (Math.abs(q.indexPrice - spotNow[ccy]!) / spotNow[ccy]!) * 100;
      worstSpotDriftPct = Math.max(worstSpotDriftPct, drift);
      checked++;
    }
    summary.push(`${combo}: olive reprice ≤${comboWorst.toFixed(3)}%`);

    // B: derive lite vs fresh raw
    const { v3, legacy } = await deriveRaw(ccy, expiryDate);
    for (const s of samples) {
      const name = `${ccy}-${expiryDate}-${strikeToDerive(s.strike)}-${s.kind === 'call' ? 'C' : 'P'}`;
      const tl = legacy.get(name);
      const t3 = v3.get(name);
      if (!t3 && !tl) continue;
      const rawBid = n(tl?.b) ?? 0;
      const rawAsk = n(tl?.a) ?? 0;
      const rawIv = n(t3?.option_pricing?.i);
      if (rawIv != null && s.deriveIv != null && Math.abs(s.deriveIv - rawIv) > 0.02) {
        deriveMisses.push(`${s.pairKey} iv ${s.deriveIv.toFixed(4)} vs raw ${rawIv.toFixed(4)}`);
      }
      if (rawBid > 0 && s.deriveBid != null && Math.abs(s.deriveBid - rawBid) > Math.max(0.02 * rawBid, rawAsk * 0.1)) {
        deriveMisses.push(`${s.pairKey} bid ${s.deriveBid} vs raw ${rawBid}`);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\nchecked ${checked} pairs across ${summary.length} combos`);
  console.log(summary.join('\n'));
  console.log(`\nWORST olive zero-drift reprice: ${worstOlivePct.toFixed(3)}%`);
  console.log(`WORST row-spot vs fresh-file drift: ${worstSpotDriftPct.toFixed(3)}% (expected ≤0.4% in moving markets)`);
  console.log(`DERIVE mismatches beyond drift tolerance: ${deriveMisses.length}`);
  for (const m of deriveMisses.slice(0, 12)) console.log('  ' + m);
}

main().catch((e) => {
  console.error('SWEEP FAILED:', e);
  process.exit(1);
});
