import { useEffect, useRef, useState } from 'react';
import type { MatchRow, MatchRowLite, ParitySignal, Signal, SignalKpis, Venue, VenueHealthSnapshot } from '@options-arb/shared';

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
  /** Rows/signals for the subscribed underlying only (empty before subscribing). */
  rows: MatchRowLite[];
  signals: Signal[];
  health: VenueHealthSnapshot | null;
  spots: Record<string, number | null>;
  /** Olive socket.io ticker stream status (null when disabled). */
  realtime: RealtimeStatus | null;
  oliveCaveats: string[];
  config: OverviewConfig;
  /** The subscription the rows/signals belong to (null = digest-only). */
  underlying?: string | null;
  /** Cross-asset KPI digest (header, KPI strip, top clips). */
  kpi?: SignalKpis | null;
}

export interface PairResponse {
  row: MatchRow | null;
  signal: Signal | null;
  ts: number | null;
}

export interface HistoryResponse {
  pairKey: string;
  hours: number;
  points: Array<{
    ts: number;
    spreadVols: number | null;
    deriveIv: number | null;
    oliveIv: number | null;
    ivs?: Partial<Record<Venue, number | null>>;
    buyVenue?: Venue | null;
    sellVenue?: Venue | null;
  }>;
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

export type EpisodeTier = 'headline' | 'reference' | 'quote_only' | 'parity';

export interface EpisodeRecord {
  pairKey: string;
  underlying: string;
  buyVenue: Venue;
  sellVenue: Venue;
  tier: EpisodeTier;
  startTs: number;
  endTs: number;
  peakHonestUsdc: number;
  peakQuotedUsdc: number;
  peakSize: number | null;
  cycles: number;
}

export interface EpisodeSummaryResponse {
  days: number;
  sinceTs: number;
  pollIntervalMs: number;
  /** When this server process started measuring (episodes are only seen while it runs). */
  trackingSinceTs: number | null;
  openCount: number;
  rows: Array<{
    tier: EpisodeTier;
    underlying: string;
    buyVenue: Venue;
    sellVenue: Venue;
    count: number;
    medianCycles: number;
    p90Cycles: number;
    maxCycles: number;
    windows: number;
    sumWindowPeakUsdc: number;
    best: EpisodeRecord;
  }>;
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

export function fetchEpisodeSummary(days: number): Promise<EpisodeSummaryResponse> {
  return getJson(`/api/episodes/summary?days=${days}`);
}

export function fetchParity(underlying: string): Promise<{ ts: number | null; parity: ParitySignal[] }> {
  return getJson(`/api/parity?underlying=${encodeURIComponent(underlying)}`);
}

function parseCycle(raw: string): OverviewResponse | null {
  try {
    const msg = JSON.parse(raw) as { type: string } & OverviewResponse;
    if (msg.type !== 'cycle') return null;
    return {
      ts: msg.ts,
      rows: msg.rows,
      signals: msg.signals,
      health: msg.health,
      spots: msg.spots,
      realtime: msg.realtime,
      oliveCaveats: msg.oliveCaveats,
      config: msg.config,
      underlying: msg.underlying ?? null,
      kpi: msg.kpi ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Live overview for ONE underlying: the server pushes only that underlying's
 * rows/signals per cycle (~0.4 MB vs 2.1 MB full) plus the global KPI digest.
 * Switching the underlying re-subscribes over the same socket and refreshes
 * via REST immediately so the table swaps without waiting for the next cycle.
 * REST polling is the fallback while the WS is down.
 */
export function useLiveOverview(underlying: string): { data: OverviewResponse | null; connected: boolean } {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const underlyingRef = useRef(underlying);
  underlyingRef.current = underlying;

  // One WS connection for the session; re-subscribe when the underlying changes.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws?.send(JSON.stringify({ type: 'subscribe', underlying: underlyingRef.current }));
      };
      ws.onmessage = (ev) => {
        const parsed = parseCycle(ev.data as string);
        // A digest (no subscription yet, e.g. the default '' underlying the
        // server ignores) carries KPI/health only — keep the rows on screen
        // instead of blanking the table until the next REST refresh.
        if (parsed) setData((prev) => (parsed.underlying == null && prev ? { ...parsed, rows: prev.rows, signals: prev.signals, underlying: prev.underlying } : parsed));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  // Re-subscribe on underlying change (if the socket is already open — the
  // onopen handler covers the not-yet-open case via the ref).
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', underlying }));
    }
  }, [underlying]);

  // Immediate REST refresh for the new filter + polling fallback while disconnected.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const d = await getJson<OverviewResponse>(`/api/overview?underlying=${encodeURIComponent(underlying)}`);
        if (live) setData(d);
      } catch {
        // server not up yet
      }
    };
    void tick();
    const poll = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [underlying]);

  return { data, connected };
}
