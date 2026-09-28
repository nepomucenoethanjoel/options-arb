/**
 * Settle the question with data: for each underlying and expiry, where does
 * Derive's IV smile sit relative to Olive's flat model vol? Reports per-expiry
 * ATM IV, the smile range, and the strike(s) where the smile crosses Olive's
 * line (those crossovers are the executable buy-Olive/sell-Derive strikes —
 * if they fall inside Olive's ±1σ strike bounds).
 */
import { yearsBetween } from '@options-arb/shared';

const OLIVE = {
  SOL: { vol: 0.6898 },
  BTC: { vol: 0.4910 },
  ETH: { vol: 0.5335 },
};
const expiryTsOf = (d: string) =>
  Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), 8);

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.derive.xyz/v3/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = (await res.json()) as { result?: T };
  return j.result as T;
}

async function main() {
  const now = Date.now();
  for (const u of ['SOL', 'BTC', 'ETH'] as const) {
    const insts = await call<{ instruments: Array<{ instrument_name: string }> }>(
      'public/get_all_instruments',
      { instrument_type: 'option', expired: false, currency: u, page: 1, page_size: 1000 },
    );
    const expiries = [...new Set(insts.instruments.map((i) => i.instrument_name.split('-')[1]))]
      .filter((d) => expiryTsOf(d) > now)
      .sort()
      .slice(0, 8);
    console.log(`\n=== ${u} — Olive flat model vol ${(OLIVE[u].vol * 100).toFixed(2)}% ===`);
    for (const exp of expiries) {
      const t = await call<{ tickers?: Record<string, any> }>('public/get_tickers', {
        instrument_type: 'option',
        currency: u,
        expiry_date: Number(exp),
      });
      const rows = Object.entries(t.tickers ?? {})
        .filter(([, v]) => v.option_pricing?.i && Number(v.option_pricing.i) > 0)
        .map(([name, v]) => {
          const strike = Number(name.split('-')[2].replace('_', '.'));
          const isPut = name.endsWith('-P');
          const iv = Number(v.option_pricing.i);
          const index = Number(v.I) || 0;
          return { strike, isPut, iv, index };
        })
        .filter((r) => r.index > 0);
      if (rows.length === 0) continue;
      const index = rows[0].index;
      const calls = rows.filter((r) => !r.isPut).sort((a, b) => Math.abs(a.strike - index) - Math.abs(b.strike - index));
      const atm = calls[0];
      const days = ((expiryTsOf(exp) - now) / 86400000).toFixed(1);
      const oliveVol = OLIVE[u].vol;
      // strikes (calls) where Derive IV > Olive flat vol
      const above = calls.filter((r) => r.iv > oliveVol);
      const nearestAbove = above.sort((a, b) => Math.abs(a.strike - index) - Math.abs(b.strike - index))[0];
      // Olive ±1σ bounds at this tenor
      const tau = yearsBetween(now, expiryTsOf(exp));
      const lower = index * Math.exp(-oliveVol * Math.sqrt(tau));
      const upper = index * Math.exp(oliveVol * Math.sqrt(tau));
      console.log(
        `${exp} (${days}d): ATM K=${atm.strike} IV=${(atm.iv * 100).toFixed(1)}% | smile ${(Math.min(...calls.map((c) => c.iv)) * 100).toFixed(0)}–${(Math.max(...calls.map((c) => c.iv)) * 100).toFixed(0)}% | ${above.length}/${calls.length} strikes above Olive | nearest-above K=${nearestAbove?.strike ?? '–'} (IV ${nearestAbove ? (nearestAbove.iv * 100).toFixed(0) + '%' : ''}) | Olive bounds ${lower.toFixed(0)}–${upper.toFixed(0)}${nearestAbove && nearestAbove.strike >= lower && nearestAbove.strike <= upper ? ' ← EXECUTABLE' : ''}`,
      );
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
