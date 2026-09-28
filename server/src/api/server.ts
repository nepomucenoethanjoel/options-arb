import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';
import type { Orchestrator } from '../scheduler';
import type { Storage } from '../storage';

export interface ApiDeps {
  cfg: AppConfig;
  orchestrator: Orchestrator;
  storage: Storage;
  olive?: {
    getRealtimeHealth(): { status: string; lastFrameAgeMs: number | null; assets: string[] } | null;
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

  app.get('/api/overview', async () => {
    const latest = orchestrator.latest;
    return {
      ts: latest?.ts ?? null,
      rows: latest?.rows ?? [],
      signals: latest?.signals ?? [],
      health: latest?.health ?? null,
      spots: latest?.spots ?? {},
      realtime: latest?.realtime ?? null,
      oliveCaveats: latest?.oliveCaveats ?? [],
      config:
        latest?.config ?? {
          ivSpreadThresholdVols: cfg.ivSpreadThresholdVols,
          pollIntervalMs: cfg.pollIntervalMs,
          underlyings: cfg.underlyings,
          fees: {},
        },
    };
  });

  app.get('/api/opportunities', async () => {
    const latest = orchestrator.latest;
    const signals = (latest?.signals ?? []).filter((s) => s.isOpportunity);
    return { ts: latest?.ts ?? null, signals, config: latest?.config ?? null };
  });

  app.get('/api/surface', async (req) => {
    const q = req.query as { underlying?: string; expiry?: string };
    const underlying = (q.underlying ?? cfg.underlyings[0] ?? 'SOL').toUpperCase();
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
    return {
      health: latest?.health ?? null,
      oliveDetail: null,
      oliveRealtime: olive?.getRealtimeHealth() ?? latest?.realtime ?? null,
      observationsStored: storage.countObservations(),
      config: overviewConfig,
    };
  });

  const clients = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    const latest = orchestrator.latest;
    if (latest) socket.send(JSON.stringify({ type: 'cycle', ...latest }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  orchestrator.on('cycle', (payload) => {
    const msg = JSON.stringify({ type: 'cycle', ...payload });
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(msg);
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
