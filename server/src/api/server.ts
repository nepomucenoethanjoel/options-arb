import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import { honestTotalNetUsdc, isHeadlineProfitable, isTwoLegExecutable, type Signal, type SignalKpis, type VenueHealthSnapshot } from '@options-arb/shared';
import type { AppConfig } from '../config';
import type { Orchestrator } from '../scheduler';
import type { Storage } from '../storage';

export interface ApiDeps {
  cfg: AppConfig;
  orchestrator: Orchestrator;
  storage: Storage;
  olive?: {
    getRealtimeHealth(): RealtimeHealthLike | null;
  };
}

type RealtimeHealthLike = { status: string; statusSinceMs?: number; lastFrameAgeMs: number | null; assets: string[] };

/** A realtime stream not live for this long degrades health. */
const REALTIME_DEGRADED_AFTER_MS = 120_000;

export interface HealthRollup {
  status: 'ok' | 'starting' | 'degraded';
  reasons: string[];
}

/**
 * One verdict over everything that silently erodes the numbers: venue
 * health, cycle age, the realtime stream, and a frozen market file. A
 * 200 from /api/health alone said nothing about any of these.
 */
export function buildHealthRollup(input: {
  health: VenueHealthSnapshot | null;
  realtime: RealtimeHealthLike | null;
  oliveCaveats: string[];
  pollIntervalMs: number;
  now: number;
}): HealthRollup {
  const { health, realtime, now } = input;
  if (!health) return { status: 'starting', reasons: ['no_cycle_yet'] };
  const reasons: string[] = [];
  for (const v of ['derive', 'olive'] as const) {
    const st = health[v]?.status;
    if (st !== 'ok') reasons.push(`${v}_${st ?? 'unknown'}`);
  }
  if (health.lastCycleMs != null && now - health.lastCycleMs > 3 * input.pollIntervalMs) {
    reasons.push(`cycle_stale_${Math.round((now - health.lastCycleMs) / 1000)}s`);
  }
  if (realtime && realtime.status !== 'live' && realtime.status !== 'stopped') {
    const since = realtime.statusSinceMs;
    if (since == null || now - since > REALTIME_DEGRADED_AFTER_MS) {
      reasons.push(`realtime_${realtime.status}${since != null ? `_${Math.round((now - since) / 1000)}s` : ''}`);
    }
  }
  if (input.oliveCaveats.includes('market_file_stale')) reasons.push('market_file_stale');
  return { status: reasons.length ? 'degraded' : 'ok', reasons };
}

/**
 * Cross-asset KPI digest — the header, KPI strip and top clips rendered
 * without shipping every underlying's signals over the WS. Mirrors the
 * client-side logic this replaces: executable-direction clips headline,
 * LP-only rows are the fallback headline, closest = best non-profitable
 * executable-direction row on a clean book.
 */
export function buildKpis(signals: Signal[]): SignalKpis {
  // Headline honesty: only rows whose honest clip total (marginal-fill
  // expected when priced, else quote) is positive on a clean book count —
  // a quote-profitable row the fill model prices at a loss, or one with
  // untradeable/distorted prices, stays in the table but out of the headline.
  const honestTotal = (s: Signal): number => honestTotalNetUsdc(s) ?? 0;
  const profitable = signals
    .filter(isHeadlineProfitable)
    .sort((a, b) => honestTotal(b) - honestTotal(a));
  const executable = profitable.filter(isTwoLegExecutable);
  const closest = signals
    .filter(
      (s) =>
        isTwoLegExecutable(s) &&
        !s.flags.includes('price_distortion') &&
        s.netAfterCapitalUsdc != null &&
        !s.isProfitable,
    )
    .sort((a, b) => (b.netAfterCapitalUsdc ?? -Infinity) - (a.netAfterCapitalUsdc ?? -Infinity))[0] ?? null;
  // Σ is pool-aware: rows on the same underlying draw on the SAME custody
  // collateral, so only each pool's best single clip adds to the total —
  // summing per-row totals double-counts shared capacity.
  const bestPerUnderlying = new Map<string, number>();
  for (const s of executable) {
    const t = honestTotal(s);
    if (t > (bestPerUnderlying.get(s.underlying) ?? -Infinity)) bestPerUnderlying.set(s.underlying, t);
  }
  return {
    topExecutable: executable.slice(0, 3),
    topAny: profitable.slice(0, 3),
    executableProfitableCount: executable.length,
    lpOnlyProfitableCount: profitable.length - executable.length,
    opportunitiesCount: signals.filter((s) => s.isOpportunity).length,
    totalExecutableUsd: [...bestPerUnderlying.values()].reduce((a, b) => a + b, 0),
    closest,
  };
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const { cfg, orchestrator, storage, olive } = deps;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const overviewConfig = {
    ivSpreadThresholdVols: cfg.ivSpreadThresholdVols,
    pollIntervalMs: cfg.pollIntervalMs,
    underlyings: cfg.underlyings,
    fees: {
      deriveTakerFeeBps: cfg.deriveTakerFeeBps,
      oliveFee: 'min(2.5 bps notional, 10% premium)',
      solanaFeeUsdc: cfg.solanaFeeUsdc,
      capitalBorrowRateApr: cfg.capitalBorrowRateApr,
    },
  };

  const normalizeUnderlying = (u: unknown): string => {
    const s = typeof u === 'string' ? u.trim().toUpperCase() : '';
    return cfg.underlyings.includes(s) ? s : (cfg.underlyings[0] ?? '');
  };

  // Fields every cycle message carries regardless of subscription.
  const metaOf = (latest: NonNullable<Orchestrator['latest']>) => ({
    ts: latest.ts,
    durationMs: latest.durationMs,
    health: latest.health,
    spots: latest.spots,
    realtime: latest.realtime,
    oliveCaveats: latest.oliveCaveats,
    config: latest.config,
  });

  app.get('/api/overview', async (req) => {
    const q = req.query as { underlying?: string };
    const latest = orchestrator.latest;
    if (!latest) {
      return {
        ts: null,
        rows: [],
        signals: [],
        health: null,
        spots: {},
        realtime: null,
        oliveCaveats: [],
        config: { ivSpreadThresholdVols: cfg.ivSpreadThresholdVols, pollIntervalMs: cfg.pollIntervalMs, underlyings: cfg.underlyings, fees: {} },
        underlying: null,
        kpi: buildKpis([]),
      };
    }
    // No param → full snapshot (scripts/compat); ?underlying=X → filtered.
    const filtered = q.underlying !== undefined;
    const underlying = filtered ? normalizeUnderlying(q.underlying) : null;
    return {
      ...metaOf(latest),
      rows: filtered ? latest.rows.filter((r) => r.underlying === underlying) : latest.rows,
      signals: filtered ? latest.signals.filter((s) => s.underlying === underlying) : latest.signals,
      underlying,
      kpi: buildKpis(latest.signals),
    };
  });

  app.get('/api/opportunities', async () => {
    const latest = orchestrator.latest;
    const signals = (latest?.signals ?? []).filter((s) => s.isOpportunity);
    return { ts: latest?.ts ?? null, signals, config: latest?.config ?? null };
  });

  app.get('/api/surface', async (req, reply) => {
    const q = req.query as { underlying?: string; expiry?: string };
    // Each distinct underlying is an upstream Derive call on the shared
    // rate budget (and a feed-cache entry) — only configured ones are served.
    const underlying = (q.underlying ?? cfg.underlyings[0] ?? 'SOL').trim().toUpperCase();
    if (!cfg.underlyings.includes(underlying)) {
      return reply.code(400).send({ error: `unknown underlying; expected one of ${cfg.underlyings.join(',')}` });
    }
    return orchestrator.getSurface(underlying, q.expiry);
  });

  app.get('/api/pair', async (req) => {
    const q = req.query as { pairKey?: string };
    if (!q.pairKey) return { row: null, signal: null };
    const row = orchestrator.fullRows.get(q.pairKey) ?? null;
    const signal = (orchestrator.latest?.signals ?? []).find((s) => s.pairKey === q.pairKey) ?? null;
    return { row, signal, ts: orchestrator.latest?.ts ?? null };
  });

  app.get('/api/history', async (req) => {
    const q = req.query as { pairKey?: string; hours?: string };
    if (!q.pairKey) return { error: 'pairKey required' };
    const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));
    const points = storage.getSpreadHistory(q.pairKey, Date.now() - hours * 3_600_000);
    return { pairKey: q.pairKey, hours, points };
  });

  app.get('/api/health', async () => {
    const latest = orchestrator.latest;
    const oliveRealtime = olive?.getRealtimeHealth() ?? latest?.realtime ?? null;
    const rollup = buildHealthRollup({
      health: latest?.health ?? null,
      realtime: oliveRealtime,
      oliveCaveats: latest?.oliveCaveats ?? [],
      pollIntervalMs: cfg.pollIntervalMs,
      now: Date.now(),
    });
    return {
      ...rollup,
      health: latest?.health ?? null,
      oliveDetail: null,
      oliveRealtime,
      signalsStored: storage.countSignals(),
      config: overviewConfig,
    };
  });

  // ── WS: per-underlying subscription ─────────────────────────────────────
  // The full snapshot is ~2 MB per cycle; the dashboard only renders one
  // underlying at a time, so clients subscribe and receive that underlying's
  // rows/signals plus the global KPI digest (header/KPI strip/top clips).
  // Browsers don't support WebSocket compression, so sending less is the
  // only effective fix.
  const clients = new Map<WebSocket, { underlying: string | null }>();

  const cycleMessage = (latest: NonNullable<Orchestrator['latest']>, underlying: string): string =>
    JSON.stringify({
      type: 'cycle',
      ...metaOf(latest),
      kpi: buildKpis(latest.signals),
      underlying,
      rows: latest.rows.filter((r) => r.underlying === underlying),
      signals: latest.signals.filter((s) => s.underlying === underlying),
    });

  const digestMessage = (latest: NonNullable<Orchestrator['latest']>): string =>
    JSON.stringify({
      type: 'cycle',
      ...metaOf(latest),
      kpi: buildKpis(latest.signals),
      underlying: null,
      rows: [],
      signals: [],
    });

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    clients.set(socket, { underlying: null });
    const latest = orchestrator.latest;
    if (latest) socket.send(digestMessage(latest));
    socket.on('message', (data) => {
      const sub = clients.get(socket);
      if (!sub) return;
      try {
        const msg = JSON.parse(String(data)) as { type?: string; underlying?: string };
        if (msg?.type !== 'subscribe') return;
        const u = typeof msg.underlying === 'string' ? msg.underlying.trim().toUpperCase() : '';
        if (!cfg.underlyings.includes(u)) return; // ignore invalid; keep the previous subscription
        sub.underlying = u;
        const cur = orchestrator.latest;
        if (cur) socket.send(cycleMessage(cur, u));
      } catch {
        // ignore malformed frames
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  orchestrator.on('cycle', (payload) => {
    const digest = digestMessage(payload);
    const byUnderlying = new Map<string, string>();
    for (const [socket, sub] of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (!sub.underlying) {
        socket.send(digest);
        continue;
      }
      let msg = byUnderlying.get(sub.underlying);
      if (msg == null) {
        msg = cycleMessage(payload, sub.underlying);
        byUnderlying.set(sub.underlying, msg);
      }
      socket.send(msg);
    }
  });

  // Serve the built dashboard when present (npm run build -w web).
  const here = dirnameOf(import.meta.url);
  const webDist = resolve(here, '../../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url === '/ws') {
        reply.status(404).send({ error: 'not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}

function dirnameOf(url: string): string {
  return join(fileURLToPath(url), '..');
}
