import { bsPrice, yearsBetween } from '@options-arb/shared';

async function main() {
  for (const [u, exp] of [['BTC', 20261009], ['ETH', 20261002], ['SOL', 20261002]] as const) {
    const r = await fetch('https://api.derive.xyz/v3/public/get_tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument_type: 'option', currency: u, expiry_date: exp }),
    });
    const j = (await r.json()) as any;
    const tickers = Object.entries(j.result?.tickers ?? {});
    let n = 0;
    let maxD = 0;
    let sq = 0;
    const samples: string[] = [];
    for (const [name, t] of tickers as Array<[string, any]>) {
      const op = t.option_pricing ?? {};
      const strike = Number(name.split('-')[2]?.replace('_', '.'));
      const kind = name.endsWith('-P') ? 'put' : 'call';
      const F = Number(op.f);
      const df = Number(op.df);
      const iv = Number(op.i);
      const mark = Number(op.m);
      if (!strike || !F || !df || !iv || !mark) continue;
      const tau = yearsBetween(Date.now(), Date.UTC(2026, Number(String(exp).slice(4, 6)) - 1, Number(String(exp).slice(6, 8)), 8));
      const mine = bsPrice({ forward: F, strike, tauYears: tau, vol: iv, discountFactor: df, kind });
      const d = mine - mark;
      n++;
      maxD = Math.max(maxD, Math.abs(d));
      sq += d * d;
      if (n <= 3) samples.push(`${name} mine ${mine.toFixed(2)} mark ${mark.toFixed(2)} d ${d.toFixed(2)}`);
    }
    console.log(`${u} ${exp}: ${n} opts | max |d| ${maxD.toFixed(3)} | RMS ${Math.sqrt(sq / Math.max(1, n)).toFixed(3)}`);
    for (const s of samples) console.log('   ' + s);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
