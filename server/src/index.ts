import { join } from 'node:path';
import { loadConfig, type ExtraVenue } from './config';
import type { OptionsVenueAdapter } from '@options-arb/shared';
import { DeriveAdapter } from './adapters/derive';
import { CoincallAdapter } from './adapters/coincall';
import { HypercallAdapter } from './adapters/hypercall';
import { CallputAdapter } from './adapters/callput';
import { OliveAdapter } from './adapters/olive';
import { OliveRealtimeClient } from './adapters/olive/realtime';
import { SqliteStorage } from './storage/sqlite';
import { Orchestrator, type CyclePayload } from './scheduler';
import { Alerter } from './alerts';
import { buildServer } from './api/server';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const storage = new SqliteStorage(join(cfg.dataDir, 'options-arb.db'));
  const derive = new DeriveAdapter({
    baseUrl: cfg.deriveBaseUrl,
    legacyUrl: cfg.deriveLegacyUrl,
    bookSource: cfg.deriveBookSource,
  });
  const oliveRealtime = cfg.oliveRealtimeEnabled
    ? new OliveRealtimeClient({
        url: cfg.oliveRealtimeUrl,
        maxSpotAgeMs: cfg.oliveRealtimeMaxSpotAgeMs,
      })
    : undefined;
  const olive = new OliveAdapter({
    apiBase: cfg.oliveApiBase,
    apiKey: cfg.oliveApiKey,
    mode: cfg.oliveMode,
    staleMs: cfg.oliveStaleMs,
    rpcUrl: cfg.solanaRpcUrl,
    tokenRateApr: cfg.oliveTokenRateApr,
    usdcRateApr: cfg.oliveUsdcRateApr,
    rateOverrides: cfg.oliveRateOverrides,
    oliveMaxTenorDays: cfg.oliveMaxTenorDays,
    volOverrides: cfg.oliveVolOverrides,
    strikeBoundSigmas: cfg.oliveStrikeBoundSigmas,
    realtime: oliveRealtime,
    realtimeMaxSpotAgeMs: cfg.oliveRealtimeMaxSpotAgeMs,
  });
  const extraAdapters: Record<ExtraVenue, () => OptionsVenueAdapter> = {
    coincall: () => new CoincallAdapter(cfg.coincallBaseUrl),
    hypercall: () => new HypercallAdapter(cfg.hypercallBaseUrl),
    callput: () => new CallputAdapter(cfg.callputFeedUrl),
  };
  const extraVenues = cfg.extraVenues.map((v) => extraAdapters[v]());
  const alerter = new Alerter(cfg);
  const orchestrator = new Orchestrator(cfg, derive, olive, storage, alerter, extraVenues);
  const app = await buildServer({ cfg, orchestrator, storage, olive });

  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`[options-arb] API + WS listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[options-arb] underlyings=${cfg.underlyings.join(',')} venues=derive,olive${cfg.extraVenues.map((v) => `,${v}`).join('')} poll=${cfg.pollIntervalMs}ms threshold=${cfg.ivSpreadThresholdVols} vol pts`);
  if (cfg.alertsEnabled && cfg.alertWebhookUrl) {
    console.log(`[options-arb] webhook alerts enabled (cooldown ${cfg.alertCooldownMs}ms)`);
  }

  orchestrator.start();
  oliveRealtime?.start();
  if (oliveRealtime) {
    console.log(
      `[options-arb] olive realtime stream on (${cfg.oliveRealtimeUrl}), early re-price trigger ${cfg.oliveRealtimeSpotTriggerPct}%`,
    );
  }
  // The first cycle populates data; log when it lands.
  orchestrator.once('cycle', (payload: CyclePayload) => {
    console.log(
      `[options-arb] first cycle done in ${payload.durationMs}ms: ${payload.rows.length} rows, ${payload.signals.filter((s) => s.isOpportunity).length} opportunities`,
    );
  });

  const shutdown = async () => {
    console.log('[options-arb] shutting down…');
    orchestrator.stop();
    oliveRealtime?.stop();
    try {
      await app.close();
    } catch {
      // ignore
    }
    storage.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[options-arb] fatal:', err);
  process.exit(1);
});
