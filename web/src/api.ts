import { useEffect, useRef, useState } from 'react';
import type { MatchRow, MatchRowLite, Signal, VenueHealthSnapshot } from '@options-arb/shared';

export interface OverviewConfig {
  ivSpreadThresholdVols: number;
  pollIntervalMs: number;
  underlyings: string[];
  fees: Record<string, unknown>;
  volPinnedAt?: number | null;
}

export interface RealtimeStatus {
  status: string;
  lastFrameAgeMs: number | null;
  assets: string[];
}

export interface OverviewResponse {
  ts: number | null;
  rows: MatchRowLite[];
  signals: Signal[];
  health: VenueHealthSnapshot | null;
  spots: Record<string, number | null>;
  /** Olive socket.io ticker stream status (null when disabled). */
  realtime: RealtimeStatus | null;
  oliveCaveats: string[];
  config: OverviewConfig;
}

export interface PairResponse {
  row: MatchRow | null;
  signal: Signal | null;
  ts: number | null;
}

export interface HistoryResponse {
  pairKey: string;
  hours: number;
  points: Array<{ ts: number; spreadVols: number | null; deriveIv: number | null; oliveIv: number | null }>;
}

export interface SurfaceResponse {
  underlying: string;
  expiryDate: string | null;
  deriveQuotes: Array<{ strike: number; kind: 'call' | 'put'; iv: number | null; bid: number | null; ask: number | null }>;
  deriveSvi: Array<{ strike: number; iv: number }>;
  oliveModelVol: number | null;
  oliveSpot: number | null;
  oliveBounds: { lower: number; upper: number } | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchPair(pairKey: string): Promise<PairResponse> {
  return getJson(`/api/pair?pairKey=${encodeURIComponent(pairKey)}`);
}

export function fetchHistory(pairKey: string, hours: number): Promise<HistoryResponse> {
  return getJson(`/api/history?pairKey=${encodeURIComponent(pairKey)}&hours=${hours}`);
}

export function fetchSurface(underlying: string, expiry?: string): Promise<SurfaceResponse> {
  const q = expiry ? `&expiry=${expiry}` : '';
  return getJson(`/api/surface?underlying=${encodeURIComponent(underlying)}${q}`);
}

/**
 * Live overview via WS push with REST polling fallback and auto-reconnect.
 */
export function useLiveOverview(): { data: OverviewResponse | null; connected: boolean } {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const startPolling = () => {
      if (pollRef.current) return;
      const tick = async () => {
        try {
          setData(await getJson<OverviewResponse>('/api/overview'));
        } catch {
          // server not up yet
        }
      };
      void tick();
      pollRef.current = setInterval(tick, 10_000);
    };
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        stopPolling();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string } & OverviewResponse;
          if (msg.type === 'cycle') {
            setData({
              ts: msg.ts,
              rows: msg.rows,
              signals: msg.signals,
              health: msg.health,
              spots: msg.spots,
              realtime: msg.realtime,
              oliveCaveats: msg.oliveCaveats,
              config: msg.config,
            });
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConnected(false);
        startPolling();
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };

    // Show something immediately even before the first WS cycle lands.
    startPolling();
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      stopPolling();
      ws?.close();
    };
  }, []);

  return { data, connected };
}
