/**
 * Phase 1 verification: pull a live Derive option chain end-to-end
 * (instruments → tickers with IV/greeks/books → SVI surface) and print it.
 *
 *   npm run verify:derive [UNDERLYING]     (default ETH)
 */
import { loadConfig } from '../config';
import { DeriveAdapter } from '../adapters/derive';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const underlying = (process.argv[2] ?? 'ETH').toUpperCase();
  const adapter = new DeriveAdapter({
    baseUrl: cfg.deriveBaseUrl,
    legacyUrl: cfg.deriveLegacyUrl,
    bookSource: cfg.deriveBookSource,
  });

  console.log(`\n=== Derive chain for ${underlying} (book source: ${cfg.deriveBookSource}) ===\n`);
  const instruments = await adapter.getInstruments(underlying);
  console.log(`instruments: ${instruments.length}`);

  const expiryDates = [...new Set(instruments.map((i) => i.expiryDate))].sort();
  console.log(`expiries (next 3): ${expiryDates.slice(0, 3).join(', ')}\n`);

  const target = expiryDates[0];
  const tickers = await adapter.getTickers(underlying, target);
  console.log(`tickers for ${target}: ${tickers.length}\n`);

  const row = (label: string, v: unknown, pad = 10) => String(v ?? '–').padEnd(pad).slice(0, pad);
  console.log(
    ['instrument'.padEnd(26), 'bid', 'ask', 'mid', 'IV%', 'delta', 'vega', 'oi'].join('  '),
  );
  const withIv = tickers.filter((t) => t.iv != null).slice(0, 14);
  for (const t of withIv) {
    const mid = t.bid != null && t.ask != null ? ((t.bid + t.ask) / 2).toFixed(2) : (t.mark ?? '–');
    console.log(
      [
        t.instrumentId.padEnd(26),
        row('bid', t.bid?.toFixed(2)),
        row('ask', t.ask?.toFixed(2)),
        row('mid', mid),
        row('iv', (t.iv! * 100).toFixed(2)),
        row('delta', t.greeks?.delta?.toFixed(3)),
        row('vega', t.greeks?.vega?.toFixed(2)),
        row('oi', t.openInterest?.toFixed(1)),
      ].join('  '),
    );
  }
  if (withIv.length === 0) {
    console.log('(no tickers with IV — check endpoint status)');
  }

  console.log(`\n=== SVI surface for ${underlying} ===\n`);
  const slices = await adapter.getSVISlices(underlying);
  console.log(`slices: ${slices.length}`);
  if (slices[0]) {
    const s = slices[0];
    const exp = new Date(s.expiryTs).toISOString().slice(0, 10);
    console.log(
      `nearest expiry ${exp}: F=${s.forward.toFixed(1)} refTau=${s.refTau.toFixed(4)} a=${s.a} b=${s.b} m=${s.m} rho=${s.rho} sigma=${s.sigma}`,
    );
    for (const mult of [0.85, 0.95, 1.0, 1.05, 1.15]) {
      const strike = s.forward * mult;
      const iv = (await import('@options-arb/shared')).sviImpliedVol(s, strike);
      console.log(
        `  K=${strike.toFixed(0)} (k=${(Math.log(strike / s.forward)).toFixed(3)}) → IV=${iv != null ? (iv * 100).toFixed(2) + '%' : 'n/a'}`,
      );
    }
  }

  const single = tickers[0] ? await adapter.getTicker(tickers[0].instrumentId) : null;
  console.log(`\ngetTicker single-check: ${single ? `ok (${single.instrumentId}, iv=${single.iv})` : 'null'}`);

  console.log(`\nhealth: ${JSON.stringify(adapter.getHealth())}`);
  console.log(`legacy health: ${JSON.stringify(adapter.getLegacyHealth())}`);
  console.log('\nVERIFY-DERIVE OK');
}

main().catch((err) => {
  console.error('VERIFY-DERIVE FAILED:', err);
  process.exit(1);
});
