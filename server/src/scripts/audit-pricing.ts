/**
 * Pricing re-audit (2026-09-28): reprice Olive's live UI quote with
 * FULL-PRECISION inputs from the market file (no display-rounding excuse),
 * and reproduce Derive's marks across all three assets. Also bounds the
 * put-convention ambiguity.
 */
import { bsPrice, bsGreeks, normCdf, yearsBetween } from '@options-arb/shared';

async function main() {
  // ── A) Olive call re-audit at full precision ─────────────────────────────
  // UI snapshot 2026-09-28T06:20:09.874Z: SOL 119.97 C, expiry 05 Oct 2026 08:00 UTC
  // their: price 4.2011, delta 0.4970, gamma 0.0354, vega/1% 0.0661, theta/day -0.3406, PITM 45.9%
  const file = (await (await fetch('https://olive.exchange/public/market/SOL%2FUSDC.json')).json()) as any;
  const fsnap = file.state.payload.snapshot;
  const spot = file.ticker.find((t: any) => t.symbol === 'SOL/USD').price;
  const vol = fsnap.volatility.volatility;
  const expiryTs = Date.UTC(2026, 9, 5, 8);
  const tau = Math.max(0, (expiryTs - Date.parse(file.asOf)) / (365 * 86_400_000));
  const rL = 0.1507;
  const rS = 0.02;
  const K = 119.97;
  console.log('file asOf:', file.asOf, '| spot', spot.toFixed(6), '| vol', (vol * 100).toFixed(4) + '%', '| tau', tau.toFixed(7), 'y');

  const compute = (F: number, df: number, label: string) => {
    const px = bsPrice({ forward: F, strike: K, tauYears: tau, vol, discountFactor: df, kind: 'call' });
    const g = bsGreeks({ forward: F, strike: K, tauYears: tau, vol, discountFactor: df, kind: 'call' });
    const pitm = normCdf((Math.log(F / K) - 0.5 * vol ** 2 * tau) / (vol * Math.sqrt(tau)));
    console.log(
      `${label}: price ${px.toFixed(4)} | delta ${g.delta.toFixed(4)} | gamma ${g.gamma.toFixed(4)} | vega/1% ${(g.vega / 100).toFixed(4)} | theta/day ${(g.thetaPerYear / 365).toFixed(4)} | PITM ${(pitm * 100).toFixed(1)}%`,
    );
    return px;
  };
  const F1 = spot * Math.exp(rL * tau);
  const pA = compute(F1, 1, 'A: F=S·e^(rL·T),  df=1         ');
  const pB = compute(F1, Math.exp(-rS * tau), 'B: F=S·e^(rL·T),  df=e^(-rS·T)');
  console.log(`their quote 4.2011 → diff A ${(pA - 4.2011).toFixed(4)} | diff B ${(pB - 4.2011).toFixed(4)}`);

  // Put-convention bound: max pricing difference between candidate conventions.
  const putA = bsPrice({ forward: spot * Math.exp(-rS * tau), strike: K, tauYears: tau, vol, discountFactor: 1, kind: 'put' });
  const putB = bsPrice({ forward: spot, strike: K, tauYears: tau, vol, discountFactor: 1, kind: 'put' });
  console.log(`put convention bound: doc-convention ${putA.toFixed(4)} vs flat ${putB.toFixed(4)} → |diff| ${Math.abs(putA - putB).toFixed(4)} USD`);

  // ── B) Derive mark reproduction, all assets, fresh ───────────────────────
  console.log('\nDerive mark reproduction:');
  for (const u of ['SOL', 'BTC', 'ETH'] as const) {
    const exp = u === 'SOL' ? 20261005 : u === 'BTC' ? 20261009 : 20261002;
    const res = await fetch('https://api.derive.xyz/v3/public/get_tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument_type: 'option', currency: u, expiry_date: exp }),
    });
    const json = (await res.json()) as any;
    const tickers = Object.entries(json.result?.tickers ?? {});
    let n = 0;
    let maxD = 0;
    let sq = 0;
    for (const [name, t] of tickers as Array<[string, any]>) {
      const op = t.option_pricing ?? {};
      const strike = Number(name.split('-')[2]?.replace('_', '.'));
      const kind = name.endsWith('-P') ? 'put' : 'call';
      const F = Number(op.f);
      const df = Number(op.df);
      const iv = Number(op.i);
      const mark = Number(op.m);
      if (!strike || !F || !df || !iv || !mark) continue;
      const tauD = yearsBetween(Date.now(), Date.UTC(2026, Number(String(exp).slice(0, 4)), Number(String(exp).slice(4, 6)) - 1, Number(String(exp).slice(6, 8)), 8));
      const mine = bsPrice({ forward: F, strike, tauYears: tauD, vol: iv, discountFactor: df, kind });
      const d = mine - mark;
      n++;
      maxD = Math.max(maxD, Math.abs(d));
      sq += d * d;
    }
    console.log(`  ${u} ${exp}: ${n} options | max |diff| ${maxD.toFixed(4)} | RMS ${Math.sqrt(sq / Math.max(1, n)).toFixed(4)} USD`);
  }
}

main().catch((e) => {
  console.error('AUDIT FAILED:', e);
  process.exit(1);
});
