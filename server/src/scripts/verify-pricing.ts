/**
 * Pricing accuracy verification against BOTH venues' production numbers.
 *
 *  A) Olive ground truth — three UI snapshots (7d call 2026-09-27, 269d
 *     call + 269d put 2026-09-28) tested against the old flat-df convention
 *     and the verified one:
 *       call: F=S·e^(rL·T), df=e^(−rL·T)  (classic BS at the long rate)
 *       put:  F=S·e^(−rS·T), df=e^(+rS·T)  (strike accretes at the short rate)
 *     The 269d tenor is what discriminates: at 7d the discount factors are
 *     ≈1 and both conventions fit; at 269d the old one is off by $3.81 on
 *     the call.
 *  B) Derive ground truth: their option_pricing mark vs bsPrice at their own
 *     IV/forward/discount factor for a live SOL chain.
 */
import { bsPrice, bsGreeks, yearsBetween } from '@options-arb/shared';

const snapshots = [
  {
    label: '7d call (2026-09-27 UI)',
    kind: 'call' as const,
    strike: 120.17,
    expiryTs: Date.UTC(2026, 9, 4, 8),
    nowMs: Date.parse('2026-09-27T20:45:46.665Z'),
    theirPrice: 6.1631,
    theirDelta: 0.6265,
    spot: 122.94,
    vol: 0.6906,
    rateL: 0.1507,
    rateS: 0.02,
  },
  {
    label: '269d call (2026-09-28 UI)',
    kind: 'call' as const,
    strike: 120,
    expiryTs: Date.UTC(2027, 5, 25, 8), // TV symbol 1813910400000
    nowMs: Date.parse('2026-09-28T13:23:00Z'),
    theirPrice: 32.4057,
    theirDelta: 0.6837,
    spot: 119.81,
    vol: 0.6697,
    rateL: 0.1504,
    rateS: 0.02,
  },
  {
    label: '269d put (2026-09-28 UI)',
    kind: 'put' as const,
    strike: 120,
    expiryTs: Date.UTC(2027, 5, 25, 8),
    nowMs: Date.parse('2026-09-28T13:20:00Z'),
    theirPrice: 28.3989,
    theirDelta: -0.3783, // NOTE: their put delta display uses classic d1 at +rS — inconsistent with their own price form
    spot: 119.75,
    vol: 0.6701,
    rateL: 0.1504,
    rateS: 0.02,
  },
];

async function main() {
  console.log('=== A) Olive ground truth ===\n');
  for (const snap of snapshots) {
    const tau = yearsBetween(snap.nowMs, snap.expiryTs);
    console.log(`${snap.label} — ${snap.kind} K=${snap.strike}, τ=${(tau * 365).toFixed(1)}d, their price ${snap.theirPrice}`);
    const conventions: Array<[string, number, number]> = [
      ['old: F=S·e^(±r·T), df=1', snap.spot * Math.exp((snap.kind === 'call' ? snap.rateL : -snap.rateS) * tau), 1],
      ['verified: call df=e^(−rL·T) / put df=e^(+rS·T)',
        snap.spot * Math.exp((snap.kind === 'call' ? snap.rateL : -snap.rateS) * tau),
        snap.kind === 'call' ? Math.exp(-snap.rateL * tau) : Math.exp(snap.rateS * tau)],
    ];
    for (const [label, F, df] of conventions) {
      const price = bsPrice({ forward: F, strike: snap.strike, tauYears: tau, vol: snap.vol, discountFactor: df, kind: snap.kind });
      const g = bsGreeks({ forward: F, strike: snap.strike, tauYears: tau, vol: snap.vol, discountFactor: df, kind: snap.kind });
      console.log(`  ${label}`);
      console.log(`    price ${price.toFixed(4)}  (theirs ${snap.theirPrice}, diff ${(price - snap.theirPrice).toFixed(4)})  delta ${g.delta.toFixed(4)} (theirs ${snap.theirDelta})`);
    }
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
