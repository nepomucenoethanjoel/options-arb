/**
 * Independent three-way comparison for a set of pairs:
 *   1. RAW Derive REST (no adapter code) — bid/ask/mark/IV/index.
 *   2. OUR dashboard (/api/pair) — what the user sees.
 *   3. INDEPENDENT Olive premium — market-file spot+vol + our own BS math,
 *      nothing shared with the adapter's code path.
 * Also measures the SPOT BASIS between venues (Stork vs Derive index), which
 * if large would manufacture fake edges on near-money contracts.
 *
 *   npx tsx src/scripts/compare-live.ts
 */
import { bsPrice } from '@options-arb/shared';

const PAIRS = [
  { underlying: 'SOL', expiryDate: '20261225', strike: 120, kind: 'call' as const },
  { underlying: 'SOL', expiryDate: '20261127', strike: 115, kind: 'call' as const },
  { underlying: 'SOL', expiryDate: '20261002', strike: 118, kind: 'call' as const },
  { underlying: 'SOL', expiryDate: '20261002', strike: 118, kind: 'put' as const },
  { underlying: 'ETH', expiryDate: '20261002', strike: 2600, kind: 'call' as const },
];

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

function strikeToDerive(strike: number): string {
  // Derive instrument names use underscore decimal separators: 117.5 -> 117_5
  const s = strike.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s.includes('.') ? s.replace('.', '_') : s;
}

async function deriveTickersRaw(
  instrumentNames: string[],
): Promise<{ v3: Map<string, any>; legacy: Map<string, any> }> {
  const v3 = new Map<string, any>();
  const legacy = new Map<string, any>();
  const combos = [...new Set(instrumentNames.map((i) => `${i.split('-')[0]}|${i.split('-')[1]}`))];
  for (const combo of combos) {
    const [ccy, expiry] = combo.split('|')!;
    const body = { instrument_type: 'option', currency: ccy, expiry_date: Number(expiry) };
    const [j3, jl] = await Promise.all([
      fetch('https://api.derive.xyz/v3/public/get_tickers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
      fetch('https://api.lyra.finance/public/get_tickers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    ]);
    const t3 = j3?.result?.tickers ?? {};
    const tl = jl?.result?.tickers ?? {};
    for (const [name, t] of Object.entries(t3)) if (instrumentNames.includes(name)) v3.set(name, t);
    for (const [name, t] of Object.entries(tl)) if (instrumentNames.includes(name)) legacy.set(name, t);
  }
  return { v3, legacy };
}

async function fetchMarketFile(sym: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://olive.exchange/public/market/${sym}%2FUSDC.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`market file ${sym} unreachable`);
}

function tickerPrice(file: any, sym: string): number | null {
  const arr = file?.ticker;
  if (!Array.isArray(arr)) return null;
  for (const t of arr) if (t?.symbol === `${sym}/USD` && typeof t.price === 'number') return t.price;
  return null;
}

async function main() {
  const deriveNames = PAIRS.map(
    (p) => `${p.underlying}-${p.expiryDate}-${strikeToDerive(p.strike)}-${p.kind === 'call' ? 'C' : 'P'}`,
  );
  const pairKeys = PAIRS.map(
    (p) => `${p.underlying}-${p.expiryDate}-${p.strike}-${p.kind === 'call' ? 'C' : 'P'}`,
  );

  const { v3: rawV3, legacy: rawLegacy } = await deriveTickersRaw(deriveNames);
  const files: Record<string, any> = { SOL: await fetchMarketFile('SOL'), ETH: await fetchMarketFile('ETH') };
  const now = Date.now();

  console.log('=== venue spot basis ===');
  const deriveIndexSOL = n(rawV3.get(deriveNames[0]!)?.I);
  const storkSOL = tickerPrice(files.SOL, 'SOL');
  console.log(
    `SOL: Derive index=${deriveIndexSOL}  Stork(Olive)=${storkSOL}  basis=${((((deriveIndexSOL ?? 0) - (storkSOL ?? 0)) / (storkSOL ?? 1)) * 100).toFixed(3)}%`,
  );

  for (let i = 0; i < PAIRS.length; i++) {
    const p = PAIRS[i]!;
    const name = deriveNames[i]!;
    const pairKey = pairKeys[i]!;
    const t3 = rawV3.get(name);
    const tl = rawLegacy.get(name);
    const t = t3 ?? tl;
    const our = await fetch(`http://127.0.0.1:8799/api/pair?pairKey=${pairKey}`).then((r) => r.json());

    const file = files[p.underlying];
    const spot = tickerPrice(file, p.underlying);
    const vol = file?.state?.payload?.snapshot?.volatility?.volatility;
    const expiryTs = Date.UTC(
      Number(p.expiryDate.slice(0, 4)),
      Number(p.expiryDate.slice(4, 6)) - 1,
      Number(p.expiryDate.slice(6, 8)),
      8,
    );
    const tau = Math.max(0, (expiryTs - now) / (365 * 86_400_000));
    const r = RATES[p.underlying]!;
    const forward =
      spot == null
        ? null
        : p.kind === 'call'
          ? spot * Math.exp(r.token * tau)
          : spot * Math.exp(-r.usdc * tau);
    // Verified convention (269d + 7d): calls discount at the token rate,
    // puts accrete the strike at the USDC rate.
    const df = p.kind === 'call' ? Math.exp(-r.token * tau) : Math.exp(r.usdc * tau);
    const indepOlive =
      forward != null && vol != null
        ? bsPrice({ forward, strike: p.strike, tauYears: tau, vol, discountFactor: df, kind: p.kind })
        : null;

    console.log(`\n=== ${pairKey} (τ=${tau.toFixed(4)}y) ===`);
    console.log(
      `RAW v3     : bid=${n(t3?.b)} ask=${n(t3?.a)} mark=${n(t3?.mark_price)} iv=${n(t3?.option_pricing?.i)} idx=${n(t3?.I)} bidSz=${n(t3?.B)} askSz=${n(t3?.A)}`,
    );
    console.log(
      `RAW legacy : bid=${n(tl?.b)} ask=${n(tl?.a)} bidSz=${n(tl?.B)} askSz=${n(tl?.A)}`,
    );
    const dq = our.row?.derive?.quote;
    console.log(
      `OUR Derive : bid=${dq?.bid} ask=${dq?.ask} mark=${dq?.mark} iv=${dq?.iv}`,
    );
    const oq = our.row?.olive?.quote;
    console.log(
      `OLIVE indep: premium=${indepOlive == null ? 'n/a' : indepOlive.toFixed(4)} (spot=${spot?.toFixed?.(4)} vol=${vol})`,
    );
    console.log(`OUR Olive  : premium=${oq?.mark} iv=${oq?.iv}`);
    const s = our.signal;
    if (s) {
      console.log(
        `OUR signal : edge=${s.edgeUsdc?.toFixed(3)} net/ctr=${s.netAfterCapitalUsdc?.toFixed(3)} total=${s.totalNetUsdc?.toFixed(2)} dir=${s.direction} flags=${s.flags.join(',')}`,
      );
    }
  }
}

main().catch((e) => {
  console.error('COMPARE FAILED:', e);
  process.exit(1);
});
