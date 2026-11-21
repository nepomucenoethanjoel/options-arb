/**
 * Read-only: Callput's settlement prices on Base (SETTLE_PRICE_FEED events)
 * vs Deribit's delivery prices for the same 08:00 UTC expiries (DATA_SOURCES
 * rows 30, 89).
 *
 *   npm run callput:settlements -w server          # last 14 days
 *   DAYS=30 npm run callput:settlements -w server
 *
 * Event layout (read from live logs): topics = [sig, asset (indexed), expiry
 * seconds (indexed)], data word 0 = price × 1e30. WBTC/WETH map to BTC/ETH;
 * other assets (synthetic stocks, 17:00 UTC) print by address.
 */
export {}; // a module, not a global script (its main() must not collide with other scripts')

const RPC = process.env.CALLPUT_RPC_URL ?? 'https://base-rpc.publicnode.com';
const SETTLE_PRICE_FEED = '0xfd1Ca63B2b31ebaDDB17EbB7bCAcb5a834DaC3c6';
const SETTLE_TOPIC = '0x84d62f67';
const ASSETS: Record<string, string> = {
  '0x0555e30da8f98308edb960aa94c0db47230d2b9c': 'BTC',
  '0x4200000000000000000000000000000000000006': 'ETH',
};
const DAYS = Number(process.env.DAYS ?? 14);
const CHUNK = 10_000;

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { result?: T } | null) : null;
    if (body && body.result !== undefined) return body.result;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(`${method} failed after retries`);
}
const hex = (n: number) => `0x${n.toString(16)}`;
const blockTime = async (n: number) => parseInt((await rpc<{ timestamp: string }>('eth_getBlockByNumber', [hex(n), false])).timestamp, 16) * 1000;

async function blockAtOrAfter(ts: number, latest: number): Promise<number> {
  let span = Math.ceil(((Date.now() - ts) / 1000) * 6) + 1000;
  let lo = Math.max(0, latest - span);
  while (lo > 0 && (await blockTime(lo)) > ts) {
    span *= 2;
    lo = Math.max(0, latest - span);
  }
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(mid)) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function deribitDelivery(index: 'btc_usd' | 'eth_usd'): Promise<Map<string, number>> {
  const res = await fetch(`https://www.deribit.com/api/v2/public/get_delivery_prices?index_name=${index}&count=${DAYS + 5}`);
  const body = (await res.json()) as { result?: { data?: Array<{ date: string; delivery_price: number }> } };
  return new Map((body.result?.data ?? []).map((d) => [d.date, d.delivery_price]));
}

async function main(): Promise<void> {
  const latest = parseInt(await rpc<string>('eth_blockNumber', []), 16);
  const from = await blockAtOrAfter(Date.now() - DAYS * 86_400_000, latest);
  const rows: Array<{ asset: string; expiryTs: number; price: number; postedTs: number }> = [];
  for (let b = from; b <= latest; b += CHUNK) {
    const logs = await rpc<Array<{ blockNumber: string; topics: string[]; data: string }>>('eth_getLogs', [
      { fromBlock: hex(b), toBlock: hex(Math.min(b + CHUNK - 1, latest)), address: SETTLE_PRICE_FEED },
    ]);
    for (const l of logs) {
      if (!l.topics[0]?.startsWith(SETTLE_TOPIC)) continue;
      const asset = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
      const raw = BigInt(`0x${l.data.slice(2, 66)}`);
      rows.push({ asset, expiryTs: parseInt(l.topics[2]!, 16) * 1000, price: Number(raw / 10n ** 18n) / 1e12, postedTs: await blockTime(parseInt(l.blockNumber, 16)) });
    }
  }
  const delivery = { BTC: await deribitDelivery('btc_usd'), ETH: await deribitDelivery('eth_usd') };
  console.log(`Callput settlement prices, last ${DAYS} days (${rows.length} posts)\n`);
  console.log('expiry (UTC)       asset   Callput        Deribit delivery   diff      bps    posted after expiry');
  const diffs: Record<string, number[]> = { BTC: [], ETH: [] };
  for (const r of rows.sort((a, b) => a.expiryTs - b.expiryTs || a.asset.localeCompare(b.asset))) {
    const sym = ASSETS[r.asset];
    const when = new Date(r.expiryTs).toISOString().slice(0, 16).replace('T', ' ');
    const lag = `${Math.round((r.postedTs - r.expiryTs) / 1000)}s`;
    const d = sym ? delivery[sym as 'BTC' | 'ETH'].get(new Date(r.expiryTs).toISOString().slice(0, 10)) : undefined;
    if (sym && d != null && new Date(r.expiryTs).getUTCHours() === 8) {
      const bps = ((r.price - d) / d) * 10_000;
      diffs[sym]!.push(bps);
      console.log(`${when}   ${sym.padEnd(6)}  ${r.price.toFixed(2).padStart(12)}   ${d.toFixed(2).padStart(14)}   ${(r.price - d).toFixed(2).padStart(8)}  ${bps.toFixed(1).padStart(6)}   ${lag}`);
    } else {
      console.log(`${when}   ${(sym ?? r.asset.slice(0, 10)).padEnd(6)}  ${r.price.toFixed(4).padStart(12)}   ${'—'.padStart(14)}   ${''.padStart(8)}  ${''.padStart(6)}   ${lag}`);
    }
  }
  for (const [sym, xs] of Object.entries(diffs)) {
    if (xs.length === 0) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const rms = Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
    console.log(`\n${sym}: ${xs.length} expiries, Callput − Deribit mean ${mean.toFixed(1)} bps, RMS ${rms.toFixed(1)} bps, max |${Math.max(...xs.map(Math.abs)).toFixed(1)}| bps`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
