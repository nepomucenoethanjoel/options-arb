/**
 * Olive realtime-v2 stream (socket.io v4 over engine.io WebSocket).
 *
 * Protocol (verified live 2026-09-28, DATA_SOURCES.md §2d-quat):
 *   1. connect wss://olive.exchange/socket.io/?EIO=4&transport=websocket
 *   2. on engine `0{...}` open → send `40{"realtimeVersion":2}`
 *      (plain `40` gets `realtime_upgrade_required` + server drop)
 *   3. on `40{...sid}` namespace-connect → send `42["subscribe_ticker",{}]`
 *      — empty payload is accepted; no wallet needed (only subscribe_options /
 *      subscribe_positions are user-scoped)
 *   4. server pushes `42["tickerPriceSnapshot",[…]]` ~1/s:
 *      [{ symbol:"SOL/USD", price:118.52, publishTime:1790579647.42,
 *         fetchedAt:"2026-09-28T07:14:07.539Z" }, …]   (all Stork feeds)
 *   5. engine keepalive: server sends `2` → reply `3` (pingInterval 25 s)
 *
 * One passive connection, identical to a browser tab — no request budget spent.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const OLIVE_REALTIME_URL = 'wss://olive.exchange/socket.io/?EIO=4&transport=websocket';

/** Minimal surface of a WebSocket the client needs (real `ws` or a test double). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'close', cb: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'message', cb: (data: unknown) => void): unknown;
}

export type EngineFrame =
  | { kind: 'open' }
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'connected' }
  | { kind: 'connect_error'; data: string }
  | { kind: 'event'; event: string; payload: unknown }
  | { kind: 'other'; raw: string };

/** Parse one engine.io/socket.io v4 text frame. Pure — unit-tested. */
export function parseEngineFrame(msg: string): EngineFrame {
  if (msg === '2') return { kind: 'ping' };
  if (msg === '3') return { kind: 'pong' };
  if (msg.startsWith('0')) return { kind: 'open' };
  if (msg.startsWith('40')) return { kind: 'connected' };
  if (msg.startsWith('44')) return { kind: 'connect_error', data: msg.slice(2) };
  if (msg.startsWith('42')) {
    try {
      const [event, payload] = JSON.parse(msg.slice(2)) as [string, unknown];
      if (typeof event === 'string') return { kind: 'event', event, payload };
    } catch {
      // malformed event frame
    }
  }
  return { kind: 'other', raw: msg.slice(0, 60) };
}

export interface TickerTick {
  asset: string;
  price: number;
  /** Stork publish time (epoch ms, from the fractional `publishTime` seconds). */
  publishMs: number;
  recvMs: number;
}

/**
 * Map a `tickerPriceSnapshot` payload to per-asset ticks. Stork feed names map
 * `SOL/USD` → `SOL`; USDC/USD is skipped (not an underlying here). Pure.
 */
export function mapTickerSnapshot(payload: unknown, recvMs: number): TickerTick[] {
  if (!Array.isArray(payload)) return [];
  const ticks: TickerTick[] = [];
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue;
    const { symbol, price, publishTime } = item as Record<string, unknown>;
    if (typeof symbol !== 'string' || typeof price !== 'number' || !Number.isFinite(price)) continue;
    const asset = symbol.split('/')[0]?.toUpperCase();
    if (!asset || asset === 'USDC' || asset === 'USD') continue;
    const publishMs =
      typeof publishTime === 'number' && Number.isFinite(publishTime) ? Math.round(publishTime * 1000) : recvMs;
    ticks.push({ asset, price, publishMs, recvMs });
  }
  return ticks;
}

export interface RealtimeSpot {
  asset: string;
  price: number;
  publishMs: number;
  recvMs: number;
  ageMs: number;
}

export type RealtimeStatus = 'stopped' | 'connecting' | 'live' | 'reconnecting';

export interface OliveRealtimeOptions {
  url?: string;
  /** Ticks older than this are not served (getSpot returns null). */
  maxSpotAgeMs?: number;
  /** No frame for this long while live → force reconnect. */
  staleReconnectMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Injection point for tests. */
  socketFactory?: (url: string) => SocketLike;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Maintains one socket.io connection to Olive and the freshest Stork spot per
 * asset (~1 s cadence vs ~5 s for the market file). Emits `spot` on every
 * changed price (scheduler uses it to re-price early on big moves) and
 * `status` on lifecycle changes. Reconnects forever with capped backoff.
 */
export class OliveRealtimeClient extends EventEmitter {
  private readonly url: string;
  private readonly maxSpotAgeMs: number;
  private readonly staleReconnectMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private socket: SocketLike | null = null;
  private statusValue: RealtimeStatus = 'stopped';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;
  private lastFrameMs: number | null = null;
  private lastServerInfo: unknown = null;
  private readonly spots = new Map<string, { price: number; publishMs: number; recvMs: number }>();

  constructor(opts: OliveRealtimeOptions = {}) {
    super();
    this.url = opts.url ?? OLIVE_REALTIME_URL;
    this.maxSpotAgeMs = opts.maxSpotAgeMs ?? 10_000;
    this.staleReconnectMs = opts.staleReconnectMs ?? 20_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000;
    this.socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(`[olive-realtime] ${m}`));
  }

  get status(): RealtimeStatus {
    return this.statusValue;
  }

  get lastFrameAgeMs(): number | null {
    return this.lastFrameMs == null ? null : this.now() - this.lastFrameMs;
  }

  /** Freshest spot for an asset, or null when absent/older than maxSpotAgeMs. */
  getSpot(asset: string): RealtimeSpot | null {
    const t = this.spots.get(asset.toUpperCase());
    if (!t) return null;
    const ageMs = this.now() - t.recvMs;
    if (ageMs > this.maxSpotAgeMs) return null;
    return { asset: asset.toUpperCase(), ...t, ageMs };
  }

  healthSummary(): { status: RealtimeStatus; lastFrameAgeMs: number | null; assets: string[] } {
    return {
      status: this.statusValue,
      lastFrameAgeMs: this.lastFrameAgeMs,
      assets: [...this.spots.keys()].sort(),
    };
  }

  start(): void {
    if (this.socket || this.statusValue === 'live' || this.statusValue === 'connecting') return;
    this.connect();
    // Staleness watchdog: a silently-dead TCP connection must not masquerade
    // as "live" — force a reconnect when frames stop arriving.
    this.watchdogTimer = setInterval(() => {
      if (this.statusValue !== 'live') return;
      const age = this.lastFrameAgeMs;
      if (age != null && age > this.staleReconnectMs) {
        this.log(`no frames for ${Math.round(age / 1000)}s — forcing reconnect`);
        this.teardownSocket();
        this.scheduleReconnect();
      }
    }, 5_000);
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
  }

  stop(): void {
    this.setStatus('stopped');
    this.teardownSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.spots.clear();
  }

  private connect(): void {
    this.setStatus(this.backoffAttempt > 0 ? 'reconnecting' : 'connecting');
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.on('open', () => {
      socket.send('40{"realtimeVersion":2}');
    });
    socket.on('message', (data) => this.onFrame(String(data)));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      this.log(`socket error: ${err.message}`);
    });
  }

  private onFrame(msg: string): void {
    const frame = parseEngineFrame(msg);
    switch (frame.kind) {
      case 'open':
        // Handshake sent on 'open' — nothing further here.
        break;
      case 'ping':
        this.socket?.send('3');
        this.touch();
        break;
      case 'connected':
        // Namespace connected — join the market-data room.
        this.socket?.send('42["subscribe_ticker",{}]');
        this.touch();
        break;
      case 'connect_error':
        this.log(`connect error: ${frame.data.slice(0, 120)}`);
        this.teardownSocket();
        this.scheduleReconnect();
        break;
      case 'event':
        this.touch();
        this.onEvent(frame.event, frame.payload);
        break;
      default:
        break;
    }
  }

  private onEvent(event: string, payload: unknown): void {
    if (event === 'tickerPriceSnapshot') {
      const recvMs = this.now();
      for (const tick of mapTickerSnapshot(payload, recvMs)) {
        const prev = this.spots.get(tick.asset);
        this.spots.set(tick.asset, { price: tick.price, publishMs: tick.publishMs, recvMs: tick.recvMs });
        if (!prev || prev.price !== tick.price) {
          this.emit('spot', { asset: tick.asset, price: tick.price, prevPrice: prev?.price ?? null });
        }
      }
      return;
    }
    if (event === 'connected') {
      this.lastServerInfo = payload;
      this.backoffAttempt = 0;
      this.setStatus('live');
      return;
    }
    if (event === 'realtime_upgrade_required' || event === 'subscription_error') {
      this.log(`server rejected: ${event} ${JSON.stringify(payload).slice(0, 120)}`);
      return;
    }
    // Unknown broadcast — log once per event name to catch protocol changes.
    if (!this.seenEvents.has(event)) {
      this.seenEvents.add(event);
      this.log(`unhandled event "${event}"`);
    }
  }

  private readonly seenEvents = new Set<string>();

  private touch(): void {
    this.lastFrameMs = this.now();
    if (this.statusValue !== 'live' && this.statusValue !== 'stopped') {
      // First data frame implies the subscription took (the explicit `connected`
      // event flips status too; this covers servers that skip it).
      this.backoffAttempt = 0;
      this.setStatus('live');
    }
  }

  private onClose(): void {
    if (this.statusValue === 'stopped') return;
    this.teardownSocket();
    this.scheduleReconnect();
  }

  private teardownSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    // Null the reference before terminating — terminate() can re-emit
    // 'close', which re-enters here and must find nothing to do.
    this.socket = null;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      // already closed
    }
  }

  private scheduleReconnect(): void {
    if (this.statusValue === 'stopped' || this.reconnectTimer) return;
    const delay = Math.min(this.backoffBaseMs * 2 ** this.backoffAttempt, this.backoffMaxMs);
    this.backoffAttempt = Math.min(this.backoffAttempt + 1, 10);
    this.setStatus('reconnecting');
    this.log(`reconnecting in ${delay}ms (attempt ${this.backoffAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.statusValue !== 'stopped') this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private setStatus(s: RealtimeStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.emit('status', s);
  }
}
