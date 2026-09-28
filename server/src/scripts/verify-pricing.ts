/**
 * Pricing accuracy verification against BOTH venues' production numbers.
 *
 *  A) Olive ground truth: their live UI quote (SOL 120.17C, Oct-4 expiry)
 *     vs our bsPrice/bsGreeks at their displayed inputs (spot 122.94,
 *     vol 69.06%, rates 15.07% L / 2.00% S). Multiple rate conventions tested;
 *     the one that matches identifies Olive's exact pricing convention.
 *  B) Derive ground truth: their option_pricing mark vs bsPrice at their own
 *     IV/forward/discount factor for a live SOL chain.
 */
import { bsPrice, bsGreeks, normCdf, yearsBetween } from '@options-arb/shared';

const snap = {
  snapshotAt: '2026-09-27T20:45:46.665Z',
  kind: 'call' as const,
  strike: 120.17,
  expiryText: '04 Oct 2026',
  countdown: '6d 11h 14m',
  theirPrice: 6.1631,
  theirDelta: 0.6265,
  theirGamma: 0.0335,
  theirTheta: -0.3601, // per day
  theirVega: 0.0620, // per 1% vol
  theirPITM: 0.591,
  spot: 122.94,
  vol: 0.6906,
  rateL: 0.1507,
  rateS: 0.0200,
};

async function main() {
  console.log('=== A) Olive ground truth ===\n');
  const snapMs = Date.parse(snap.snapshotAt);
  // Countdown implies expiry at 04 Oct 2026 08:00 UTC (Derive-style 08:00).
  const expiryTs = Date.UTC(2026, 9, 4, 8, 0, 0);
  const tau = yearsBetween(snapMs, expiryTs);
  console.log(`tenor: ${tau.toFixed(8)} y (countdown ${snap.countdown} → ${(tau * 365 * 24).toFixed(2)} h)`);

  const conventions: Array<[string, number, number]> = [
    ['F=S·e^(rL·T), df=1', snap.spot * Math.exp(snap.rateL * tau), 1],
    ['F=S·e^(rL·T), df=e^(−rS·T)', snap.spot * Math.exp(snap.rateL * tau), Math.exp(-snap.rateS * tau)],
    ['F=S, df=1 (flat — our current demo convention)', snap.spot, 1],
    ['F=S·e^(rS·T), df=1', snap.spot * Math.exp(snap.rateS * tau), 1],
  ];
  for (const [label, F, df] of conventions) {
    const price = bsPrice({ forward: F, strike: snap.strike, tauYears: tau, vol: snap.vol, discountFactor: df, kind: 'call' });
    const g = bsGreeks({ forward: F, strike: snap.strike, tauYears: tau, vol: snap.vol, discountFactor: df, kind: 'call' });
    const pitm = normCdf((Math.log(F / snap.strike) - 0.5 * snap.vol ** 2 * tau) / (snap.vol * Math.sqrt(tau)));
    console.log(`${label}`);
    console.log(`  price ${price.toFixed(4)}  (theirs ${snap.theirPrice}, diff ${(price - snap.theirPrice).toFixed(4)})`);
    console.log(`  delta ${g.delta.toFixed(4)} (theirs ${snap.theirDelta}) | gamma ${g.gamma.toFixed(4)} (theirs ${snap.theirGamma})`);
    console.log(`  vega/1% ${(g.vega / 100).toFixed(4)} (theirs ${snap.theirVega}) | theta/day ${(g.thetaPerYear / 365).toFixed(4)} (theirs ${snap.theirTheta})`);
    console.log(`  PITM ${pitm.toFixed(4)} (theirs ${snap.theirPITM})`);
    console.log('');
  }

  console.log('=== B) Derive ground truth ===\n');
  const res = await fetch('https://api.derive.xyz/v3/public/get_tickers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instrument_type: 'option', currency: 'SOL', expiry_date: 20261030 }),
  });
  const json = (await res.json()) as { result?: { tickers?: Record<string, any> }; tickers?: Record<string, any> };
  const tickers = Object.entries(json.result?.tickers ?? json.tickers ?? {}).filter(([, t]: [string, any]) => t.option_pricing?.i);
  let checked = 0;
  let maxAbsDiff = 0;
  let sumSq = 0;
  for (const [name, t] of tickers as Array<[string, any]>) {
    const strike = Number(name.split('-')[2]?.replace('_', '.')) || 0;
    const kind = name.endsWith('-P') ? 'put' : 'call';
    const F = Number(t.option_pricing.f);
    const df = Number(t.option_pricing.df);
    const iv = Number(t.option_pricing.i);
    const theirMark = Number(t.option_pricing.m);
    if (!strike || !F || !df || !iv || !theirMark) continue;
    const tauD = yearsBetween(Date.now(), Date.UTC(2026, 9, 30, 8));
    const mine = bsPrice({ forward: F, strike, tauYears: tauD, vol: iv, discountFactor: df, kind });
    const diff = mine - theirMark;
    checked++;
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(diff));
    sumSq += diff * diff;
    if (checked <= 5) {
      console.log(`${kind === 'call' ? 'C' : 'P'} K=${strike}: mine ${mine.toFixed(4)} vs Derive mark ${theirMark.toFixed(4)} → diff ${diff.toFixed(4)}`);
    }
  }
  console.log(`\nchecked ${checked} Derive options: max |diff| ${maxAbsDiff.toFixed(4)}, RMS ${Math.sqrt(sumSq / Math.max(1, checked)).toFixed(4)} USDC`);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e);
  process.exit(1);
});
