/**
 * Capture Olive's socket.io traffic to identify their streaming market-data
 * events (vol/quotes/greeks). Passive listener: connects like any browser
 * would, logs every server event for N seconds. Run while their trade page is
 * open in a browser to compare against known UI values, then wire the
 * identified event into OliveAdapter.
 *
 *   npm run capture:olive-ws [seconds]
 */
import WebSocket from 'ws';

const URL = 'wss://olive.exchange/socket.io/?EIO=4&transport=websocket';
const SECONDS = Number(process.argv[2] ?? 45);

function main() {
  const ws = new WebSocket(URL);
  const t0 = Date.now();
  const eventCounts = new Map<string, number>();
  const samples = new Map<string, string>();

  ws.on('open', () => console.log(`[capture] connected to ${URL}`));
  ws.on('message', (raw) => {
    const msg = String(raw);
    // socket.io v4 engine framing: "0" open, "2" ping, "40" connect ack,
    // "42[\"event\",payload]" events, "44" connect error.
    if (msg.startsWith('0')) {
      console.log('[capture] engine open:', msg.slice(0, 200));
      // realtime v2 handshake — plain "40" gets realtime_upgrade_required + drop.
      ws.send('40{"realtimeVersion":2}');
      return;
    }
    if (msg === '2') {
      ws.send('3'); // pong
      return;
    }
    if (msg.startsWith('40')) {
      console.log('[capture] namespace connected:', msg.slice(0, 120));
      return;
    }
    if (msg.startsWith('42')) {
      try {
        const [event, payload] = JSON.parse(msg.slice(2)) as [string, unknown];
        eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
        if (!samples.has(event)) {
          samples.set(event, JSON.stringify(payload).slice(0, 400));
        }
      } catch {
        // malformed frame
      }
      return;
    }
    if (msg.startsWith('44')) console.log('[capture] connect error:', msg.slice(0, 200));
  });
  ws.on('error', (e) => console.error('[capture] ws error:', e.message));
  ws.on('close', (code) => console.log('[capture] closed:', code));

  const timer = setInterval(() => {
    if (Date.now() - t0 > SECONDS * 1000) {
      clearInterval(timer);
      console.log(`\n[capture] ${((Date.now() - t0) / 1000).toFixed(0)}s summary — events received:`);
      if (eventCounts.size === 0) {
        console.log('  (none — passive listen saw no broadcasts; events likely require joining rooms)');
      }
      for (const [event, count] of [...eventCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${event} ×${count}`);
        console.log(`    sample: ${samples.get(event)}`);
      }
      ws.close();
      process.exit(0);
    }
  }, 1000);
}

main();
