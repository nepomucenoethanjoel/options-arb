/** ZEC enablement checks: Derive chain shape + index vs Olive spot + Olive fixed rates. */
export {};

async function main() {
  const [instr, tick, file] = await Promise.all([
    fetch('https://api.derive.xyz/v3/public/get_all_instruments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'ZEC', expired: false, instrument_type: 'option', page: 1, page_size: 1000 }),
    }).then((r) => r.json()),
    fetch('https://api.derive.xyz/v3/public/get_tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument_type: 'option', currency: 'ZEC', expiry_date: 20270326 }),
    }).then((r) => r.json()),
    fetch('https://olive.exchange/public/market/ZEC%2FUSDC.json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then((r) => r.json()),
  ]);

  const instruments: any[] = instr?.result?.instruments ?? [];
  const names = instruments.map((i) => String(i.instrument_name ?? '')).filter((s) => s.startsWith('ZEC-'));
  const expiries = [...new Set(names.map((s) => s.split('-')[1]))].sort();
  const strikes = [...new Set(names.map((s) => s.split('-')[2]))].sort();
  console.log(`Derive ZEC chain: ${names.length} instruments, ${expiries.length} expiries: ${expiries.join(', ')}`);
  console.log(`strikes (${strikes.length}): ${strikes.join(', ')}`);

  const tickers = Object.values(tick?.result?.tickers ?? {}) as any[];
  console.log(`tickers: ${tickers.length}`);
  for (const t of tickers.slice(0, 6)) {
    console.log(
      `  ${t.instrument_name}: idx=${t.I} iv=${t.option_pricing?.i} mark=${t.mark_price} bid=${t.b}(${t.B}) ask=${t.a}(${t.A})`,
    );
  }
  const idxs = [...new Set(tickers.map((t) => Number(t.I)).filter(Number.isFinite))];
  console.log(`Derive ZEC index prints: ${idxs.join(', ')}`);

  const snap = file?.state?.payload?.snapshot;
  const zecTick = (Array.isArray(file.ticker) ? file.ticker : []).find((x: any) => x?.symbol === 'ZEC/USD');
  console.log(`Olive ZEC: spot=${zecTick?.price} vol=${snap?.volatility?.volatility}`);
  const raw = snap?.rawOnChainPoolSnapshot ?? {};
  const rateKeys = Object.entries(raw).filter(([k, v]) => /rate|apr|yield/i.test(k) && (typeof v === 'number' || typeof v === 'string'));
  console.log('rate-ish fields in rawOnChainPoolSnapshot:', JSON.stringify(Object.fromEntries(rateKeys)));
  console.log('poolSummary keys:', Object.keys(snap?.poolSummary ?? {}).join(', '));
  const ps = snap?.poolSummary ?? {};
  console.log('lendingRate:', ps.lendingRate, '| utilizationRatio:', ps.utilizationRatio, '| aumUsd:', ps.aumUsd);
  // scan the whole snapshot for fixed-rate-like numeric fields
  const found: Record<string, unknown> = {};
  const walk = (obj: unknown, path: string, depth: number) => {
    if (depth > 4 || obj == null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/rate|apr|borrow|lend/i.test(k) && (typeof v === 'number' || typeof v === 'string')) found[`${path}.${k}`] = v;
      if (typeof v === 'object' && v != null) walk(v, `${path}.${k}`, depth + 1);
    }
  };
  walk(snap, 'snap', 0);
  console.log('all rate-ish fields:', JSON.stringify(found));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
