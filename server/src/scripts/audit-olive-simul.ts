/** Simultaneous-snapshot comparison: Olive UI quote vs our formula at the
 * exact market-file inputs (same second). SOL 119.97 C, expiry 05 Oct 2026 08:00 UTC. */
import { bsPrice, bsGreeks, normCdf } from '@options-arb/shared';

const ui = { quote: 4.0979, delta: 0.4892, gamma: 0.0354, vega1pct: 0.0659, thetaDay: -0.3401, pitm: 0.452 };
const file = { spot: 118.77960119999999, vol: 0.681396, asOf: '2026-09-28T06:24:42.149Z' };
const K = 119.97;
const rL = 0.1507;
const rS = 0.02;

const tau = (Date.UTC(2026, 9, 5, 8) - Date.parse(file.asOf)) / (365 * 86_400_000);

const rows: Array<[string, number]> = [];
for (const [label, F, df] of [
  ['A: F=S·e^(rL·T),  df=1', file.spot * Math.exp(rL * tau), 1],
  ['B: F=S·e^(rL·T),  df=e^(-rS·T)', file.spot * Math.exp(rL * tau), Math.exp(-rS * tau)],
  ['C: F=S,            df=1', file.spot, 1],
] as Array<[string, number, number]>) {
  const px = bsPrice({ forward: F, strike: K, tauYears: tau, vol: file.vol, discountFactor: df, kind: 'call' });
  const g = bsGreeks({ forward: F, strike: K, tauYears: tau, vol: file.vol, discountFactor: df, kind: 'call' });
  const pitm = normCdf((Math.log(F / K) - 0.5 * file.vol ** 2 * tau) / (file.vol * Math.sqrt(tau)));
  rows.push([label, px]);
  console.log(
    `${label} → price ${px.toFixed(4)} (d ${px - ui.quote >= 0 ? '+' : ''}${(px - ui.quote).toFixed(4)}) | delta ${g.delta.toFixed(4)} (Δ${(g.delta - ui.delta).toFixed(4)}) | gamma ${g.gamma.toFixed(4)} | vega/1% ${(g.vega / 100).toFixed(4)} | PITM ${(pitm * 100).toFixed(1)}%`,
  );
}
console.log(`their:  price ${ui.quote} | delta ${ui.delta} | gamma ${ui.gamma} | vega/1% ${ui.vega1pct} | theta/day ${ui.thetaDay} | PITM ${(ui.pitm * 100).toFixed(1)}%`);
console.log(`tau ${tau.toFixed(7)} y | spot ${file.spot.toFixed(6)} | vol ${(file.vol * 100).toFixed(4)}%`);
