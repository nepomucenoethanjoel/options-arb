import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  mapTickerSnapshot,
  parseEngineFrame,
  OliveRealtimeClient,
  type OliveRealtimeOptions,
  type SocketLike,
} from '../src/adapters/olive/realtime';

describe('parseEngineFrame', () => {
  it('classifies engine.io keepalive frames', () => {
    expect(parseEngineFrame('2')).toEqual({ kind: 'ping' });
    expect(parseEngineFrame('3')).toEqual({ kind: 'pong' });
  });

  it('classifies open and namespace-connect frames', () => {
    expect(parseEngineFrame('0{"sid":"a","pingInterval":25000}')).toEqual({ kind: 'open' });
    expect(parseEngineFrame('40{"sid":"b"}')).toEqual({ kind: 'connected' });
  });

  it('extracts socket.io events', () => {
    const f = parseEngineFrame('42["tickerPriceSnapshot",[{"symbol":"SOL/USD","price":1}]]');
    expect(f).toEqual({
      kind: 'event',
      event: 'tickerPriceSnapshot',
      payload: [{ symbol: 'SOL/USD', price: 1 }],
    });
  });

  it('survives malformed event JSON and unknown frames', () => {
    expect(parseEngineFrame('42[not json').kind).toBe('other');
    expect(parseEngineFrame('41').kind).toBe('other');
    expect(parseEngineFrame('45AA-1').kind).toBe('other');
  });

  it('extracts connect errors', () => {
    expect(parseEngineFrame('44{"message":"no"}')).toEqual({
      kind: 'connect_error',
      data: '{"message":"no"}',
    });
  });
});

describe('mapTickerSnapshot', () => {
  it('maps Stork feed symbols to assets and converts publishTime seconds to ms', () => {
    const ticks = mapTickerSnapshot(
      [
        { symbol: 'SOL/USD', price: 118.5, publishTime: 1790579647.42, fetchedAt: 'x' },
        { symbol: 'BTC/USD', price: 83044.1, publishTime: 1790579647.42, fetchedAt: 'x' },
      ],
      1000,
    );
    expect(ticks).toEqual([
      { asset: 'SOL', price: 118.5, publishMs: 1_790_579_647_420, recvMs: 1000 },
      { asset: 'BTC', price: 83044.1, publishMs: 1_790_579_647_420, recvMs: 1000 },
    ]);
  });

  it('skips USDC and malformed entries', () => {
    const ticks = mapTickerSnapshot(
      [
        { symbol: 'USDC/USD', price: 1.0 },
        { symbol: 'ETH/USD', price: 2646.3 },
        { symbol: 'JUP/USD', price: Number.NaN },
        { price: 5 },
        'garbage',
      ],
      2000,
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.asset).toBe('ETH');
    expect(ticks[0]?.publishMs).toBe(2000); // no publishTime → recv time
  });

  it('returns empty for non-array payloads', () => {
    expect(mapTickerSnapshot(null, 1)).toEqual([]);
    expect(mapTickerSnapshot({ symbol: 'SOL/USD' }, 1)).toEqual([]);
  });
});

/** EventEmitter-based stand-in for the `ws` WebSocket. */
class FakeSocket {
  sent: string[] = [];
  terminated = false;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, cb: (...args: unknown[]) => void): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.fire('close', 1000, null);
  }
  terminate(): void {
    this.close();
  }
  // Test driver helpers below are not part of SocketLike.
  open(): void {
    this.fire('open');
  }
  message(msg: string): void {
    this.fire('message', msg);
  }
}

function makeClient(over: Partial<OliveRealtimeOptions> = {}) {
  const sockets: FakeSocket[] = [];
  let clock = 1_000_000;
  const client = new OliveRealtimeClient({
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as SocketLike;
    },
    now: () => clock,
    staleReconnectMs: 60_000, // watchdog off for most tests
    backoffBaseMs: 10,
    ...over,
  });
  return { client, sockets, tick: (ms: number) => (clock += ms) };
}

describe('OliveRealtimeClient', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('handshakes with realtime v2 and subscribes with an empty payload', () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent).toContain('40{"realtimeVersion":2}');
    sockets[0]!.message('40{"sid":"s1"}');
    expect(sockets[0]!.sent).toContain('42["subscribe_ticker",{}]');
    client.stop();
  });

  it('answers engine pings', () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('2');
    expect(sockets[0]!.sent).toContain('3');
    client.stop();
  });

  it('goes live and tracks per-asset spots from tickerPriceSnapshot', () => {
    const { client, sockets, tick } = makeClient({ maxSpotAgeMs: 5000 });
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('40{"sid":"s1"}');
    sockets[0]!.message('42["connected",{"serverVersion":"2.0.0"}]');
    expect(client.status).toBe('live');

    sockets[0]!.message(
      '42["tickerPriceSnapshot",[{"symbol":"SOL/USD","price":118.5,"publishTime":1790579647.4}]]',
    );
    const spot = client.getSpot('sol');
    expect(spot).toMatchObject({ asset: 'SOL', price: 118.5 });
    expect(spot?.ageMs).toBe(0);

    tick(6000); // past maxSpotAgeMs
    expect(client.getSpot('SOL')).toBeNull();
    client.stop();
  });

  it('emits spot only when the price changes', () => {
    const { client, sockets } = makeClient();
    const events: Array<{ asset: string; price: number; prevPrice: number | null }> = [];
    client.on('spot', (e) => events.push(e));
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('40{"sid":"s1"}');
    const frame = (p: number) =>
      sockets[0]!.message(`42["tickerPriceSnapshot",[{"symbol":"SOL/USD","price":${p},"publishTime":1}]]`);
    frame(118.5);
    frame(118.5); // unchanged — no event
    frame(118.6);
    expect(events).toEqual([
      { asset: 'SOL', price: 118.5, prevPrice: null },
      { asset: 'SOL', price: 118.6, prevPrice: 118.5 },
    ]);
    client.stop();
  });

  it('reconnects with backoff after an unexpected close', () => {
    const { client, sockets } = makeClient({ backoffBaseMs: 10 });
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('40{"sid":"s1"}');
    sockets[0]!.terminate();
    expect(client.status).toBe('reconnecting');
    vi.advanceTimersByTime(50); // past the 10ms first backoff
    expect(sockets.length).toBe(2);
    client.stop();
  });

  it('forces a reconnect when live but silent past staleReconnectMs', () => {
    const { client, sockets, tick } = makeClient({ staleReconnectMs: 20_000 });
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('40{"sid":"s1"}');
    sockets[0]!.message('42["connected",{}]');
    tick(30_000);
    vi.advanceTimersByTime(6000); // let the 5s watchdog fire
    expect(sockets.length).toBe(2); // reconnected
    client.stop();
  });

  it('recycles a connect attempt that never opens (live 2026-10-27: wedged 7.6 days)', () => {
    const { client, sockets, tick } = makeClient({ connectTimeoutMs: 15_000 });
    client.start(); // socket never fires open/close/error
    tick(20_000);
    vi.advanceTimersByTime(6000);
    expect(sockets[0]!.terminated).toBe(true);
    vi.advanceTimersByTime(50);
    expect(sockets.length).toBe(2);
    expect(client.healthSummary().lastError).toMatch(/not live after/);
    client.stop();
  });

  it('recycles a socket that opens and pings but never acks the namespace', () => {
    const { client, sockets, tick } = makeClient({ connectTimeoutMs: 15_000 });
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('2'); // engine ping alone is not "live"
    expect(client.status).toBe('connecting');
    tick(20_000);
    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(50);
    expect(sockets.length).toBe(2);
    client.stop();
  });

  it('ignores a late close from a torn-down socket', () => {
    const { client, sockets, tick } = makeClient({ connectTimeoutMs: 15_000 });
    client.start();
    tick(20_000);
    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(50);
    expect(sockets.length).toBe(2);
    sockets[1]!.open();
    sockets[1]!.message('42["connected",{}]');
    expect(client.status).toBe('live');
    sockets[0]!.fire('close', 1006, null); // stale socket's late event
    expect(client.status).toBe('live');
    expect(sockets[1]!.terminated).toBe(false);
    client.stop();
  });

  it('reports attempts and status age in the health summary', () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0]!.open();
    sockets[0]!.message('42["tickerPriceSnapshot",[{"symbol":"SOL/USD","price":1,"publishTime":1}]]');
    const h = client.healthSummary();
    expect(h).toMatchObject({ status: 'live', attempts: 1, lastTickerAgeMs: 0, lastError: null });
    client.stop();
  });

  it('stop() prevents any further reconnects', () => {
    const { client, sockets } = makeClient({ backoffBaseMs: 10 });
    client.start();
    sockets[0]!.open();
    client.stop();
    sockets[0]!.terminate();
    vi.advanceTimersByTime(500);
    expect(client.status).toBe('stopped');
    expect(sockets.length).toBe(1);
  });
});
