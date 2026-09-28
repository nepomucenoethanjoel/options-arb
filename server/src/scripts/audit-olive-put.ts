/** Put-convention verification: SOL 119.97 P, 05 Oct 2026 08:00 UTC,
 * simultaneous UI + market-file snapshot (2026-09-28T06:26:19Z). */
import { bsPrice, bsGreeks, normCdf } from '@options-arb/shared';

const ui = { quote: 5.1993, delta: -0.524, pitm: 0.565 };
const file = { spot: 118.70640787500001, vol: 0.681899, asOf: '2026-09-28T06:26:17.700Z' };
const K = 119.97;
const rL = 0.1507;
const rS = 0.02;
const tau = (Date.UTC(2026, 9, 5, 8) - Date.parse(file.asOf)) / (365 * 86_400_000);

for (const [label, F] of [
  ['doc (ours): F = S·e^(−rS·T)', file.spot * Math.exp(-rS * tau)],
  ['flat:       F = S            ', file.spot],
  ['call-carry: F = S·e^(+rL·T)  ', file.spot * Math.exp(rL * tau)],
] as Array<[string, number]>) {
  const px = bsPrice({ forward: F, strike: K, tauYears: tau, vol: file.vol, discountFactor: 1, kind: 'put' });
  const g = bsGreeks({ forward: F, strike: K, tauYears: tau, vol: file.vol, discountFactor: 1, kind: 'put' });
  const pitm = normCdf((Math.log(F / K) + 0.5 * file.vol ** 2 * tau) / (file.vol * Math.sqrt(tau)));
  console.log(
    `${label} → price ${px.toFixed(4)} (d ${(px - ui.quote).toFixed(4)}) | delta ${g.delta.toFixed(4)} (Δ${(g.delta - ui.delta).toFixed(4)}) | PITM ${(pitm * 100).toFixed(1)}%`,
  );
}
console.log(`their: price ${ui.quote} | delta ${ui.delta} | PITM ${ui.pitm * 100}%  | tau ${tau.toFixed(7)}`);
