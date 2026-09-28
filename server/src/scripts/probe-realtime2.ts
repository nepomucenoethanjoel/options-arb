/**
 * Probe Olive's realtime-v2 socket: connect with the v2 handshake, then try
 * subscribe_* variants and log everything the server sends back (validation
 * errors teach the schema). Goal: find a market-data subscription that does
 * NOT require a user/wallet.
 *
 *   npm run probe:realtime2
 */
import WebSocket from 'ws';

const URL = 'wss://olive.exchange/socket.io/?EIO=4&transport=websocket';

const variants: Array<{ label: string; emits: Array<[string, unknown]> }> = [
  { label: 'subscribe_ticker empty', emits: [['subscribe_ticker', {}]] },
  { label: 'subscribe_ticker poolName', emits: [['subscribe_ticker', { poolName: 'SOL/USDC' }]] },
  { label: 'subscribe_ticker poolName+version', emits: [['subscribe_ticker', { poolName: 'SOL/USDC', version: 2 }]] },
  { label: 'subscribe_ticker symbols[]', emits: [['subscribe_ticker', { symbols: ['SOL/USDC'] }]] },
  { label: 'subscribe_ticker_fast poolName', emits: [['subscribe_ticker_fast', { poolName: 'SOL/USDC' }]] },
  { label: 'subscribe_options poolName', emits: [['subscribe_options', { poolName: 'SOL/USDC' }]] },
];

function run(label: string, emits: Array<[string, unknown]>): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const log: string[] = [];
    let ns = false;
    const timer = setTimeout(() => {
      ws.close();
      console.log(`\n=== ${label} ===`);
      for (const l of log.slice(0, 12)) console.log('  ' + l.slice(0, 500));
      resolve();
    }, 10000);
    ws.on('open', () => ws.send('40{"realtimeVersion":2}'));
    ws.on('message', (raw) => {
      const msg = String(raw);
      if (msg === '2') {
        ws.send('3');
        return;
      }
      if (msg.startsWith('40')) {
        ns = true;
        for (const [event, payload] of emits) ws.send(`42${JSON.stringify([event, payload])}`);
        return;
      }
      if (msg.startsWith('42') || msg.startsWith('44')) log.push(msg);
    });
    ws.on('error', (e) => log.push('ERR ' + e.message));
    ws.on('close', (code) => {
      if (ns) log.push(`closed(${code})`);
    });
  });
}

async function main(): Promise<void> {
  for (const v of variants) await run(v.label, v.emits);
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
