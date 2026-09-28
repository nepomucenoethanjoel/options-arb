/**
 * Discover the olive.exchange socket.io realtime-v2 handshake by trying
 * candidate client emits and logging everything the server says back
 * (their validation errors are descriptive — they teach the schema).
 */
import WebSocket from 'ws';

const URL = 'wss://olive.exchange/socket.io/?EIO=4&transport=websocket';

const variants: Array<{ label: string; emits: Array<[string, unknown]> }> = [
  { label: 'plain subscribe_ticker', emits: [['subscribe_ticker', { poolName: 'SOL/USDC' }]] },
  { label: 'subscribe_ticker with version', emits: [['subscribe_ticker', { poolName: 'SOL/USDC', version: 2 }]] },
  { label: 'realtime_state then subscribe', emits: [['realtime_state', { version: 2 }], ['subscribe_ticker', { poolName: 'SOL/USDC' }]] },
  { label: 'subscribe_options', emits: [['subscribe_options', { poolName: 'SOL/USDC', version: 2 }]] },
];

function run(label: string, emits: Array<[string, unknown]>): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const log: string[] = [];
    let connected = false;
    const timer = setTimeout(() => {
      ws.close();
      console.log(`\n=== ${label} ===`);
      for (const l of log.slice(0, 14)) console.log('  ' + l.slice(0, 300));
      resolve();
    }, 9000);
    ws.on('open', () => ws.send('40'));
    ws.on('message', (raw) => {
      const msg = String(raw);
      if (msg === '2') {
        ws.send('3');
        return;
      }
      if (msg.startsWith('40')) {
        connected = true;
        for (const [event, payload] of emits) {
          ws.send(`42${JSON.stringify([event, payload])}`);
        }
        return;
      }
      if (msg.startsWith('44') || msg.startsWith('42') || msg.startsWith('0')) {
        log.push(msg);
      }
    });
    ws.on('error', (e) => log.push('ERR ' + e.message));
    ws.on('close', (code) => {
      if (connected) log.push(`closed(${code})`);
    });
  });
}

async function main() {
  for (const v of variants) {
    await run(v.label, v.emits);
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
