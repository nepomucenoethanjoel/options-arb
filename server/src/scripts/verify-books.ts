/**
 * Verify Derive book depth for specific instruments: subscribe to the
 * orderbook WS channel and dump the snapshot (bids/asks beyond the touch).
 */
import WebSocket from 'ws';

const instruments = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['SOL-20261030-120-C'];

const ws = new WebSocket('wss://api.derive.xyz/v3/ws');

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'subscribe',
      params: { channels: instruments.map((n) => `orderbook.${n}.1.20`) },
    }),
  );
});

const done = new Set();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.method !== 'subscription') return;
  const ch: string = msg.params?.channel ?? '';
  const name = ch.split('.')[1];
  const d = msg.params?.data ?? {};
  const bids: Array<[number, number]> = d.bids ?? [];
  const asks: Array<[number, number]> = d.asks ?? [];
  if (!bids.length && !asks.length) return;
  const sum = (arr: Array<[number, number]>) => arr.reduce((a, [px, sz]) => a + sz, 0);
  console.log(`\n${name} — touch: bid ${bids[0]?.join('×') ?? '–'}  ask ${asks[0]?.join('×') ?? '–'}`);
  console.log(`  depth(20): ${sum(bids).toFixed(2)} bid @ avg ${(bids.reduce((a, [p]) => a + p, 0) / Math.max(1, bids.length)).toFixed(2)} | ${sum(asks).toFixed(2)} ask @ avg ${(asks.reduce((a, [p]) => a + p, 0) / Math.max(1, asks.length)).toFixed(2)}`);
  // executable size without paying more than +5% of touch ask
  if (asks.length > 0) {
    const touchAsk = asks[0][0];
    let size = 0;
    let spent = 0;
    for (const [px, sz] of asks) {
      if (px > touchAsk * 1.05) break;
      size += sz;
      spent += px * sz;
    }
    console.log(`  buyable within +5% of touch ask: ${size.toFixed(2)} (avg px ${(spent / Math.max(1e-9, size)).toFixed(2)})`);
  }
  if (bids.length > 0) {
    const touchBid = bids[0][0];
    let size = 0;
    let raised = 0;
    for (const [px, sz] of bids) {
      if (px < touchBid * 0.95) break;
      size += sz;
      raised += px * sz;
    }
    console.log(`  sellable within −5% of touch bid: ${size.toFixed(2)} (avg px ${(raised / Math.max(1e-9, size)).toFixed(2)})`);
  }
  done.add(name);
  if (done.size >= instruments.length) {
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout waiting for snapshots');
  process.exit(1);
}, 20000);
