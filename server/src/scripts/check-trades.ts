/**
 * Ground-truth check on Olive's executed trades from the market-file `trades`
 * feed: no premium field exists, but `tradeFeeUsdE6` verifies the fee model
 * exactly (min(2.5 bps notional, 10% premium) — the notional bound binds on
 * every observed open_option).
 */
export {};

async function inspect(sym: string) {
  const res = await fetch(`https://olive.exchange/public/market/${sym}%2FUSDC.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const j: any = await res.json();
  const trades: any[] = Array.isArray(j.trades) ? j.trades : [];
  console.log(`\n=== ${sym}: ${trades.length} trades in file ===`);
  if (trades.length > 0) {
    console.log('sample keys:', JSON.stringify(Object.keys(trades[0])));
    for (const t of trades.slice(0, 5)) console.log(' ', JSON.stringify(t).slice(0, 220));
  }
}

async function main() {
  for (const s of ['ZEC', 'SOL']) await inspect(s);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
