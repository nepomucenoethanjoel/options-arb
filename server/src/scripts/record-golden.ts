/**
 * Record a live Olive × Derive cycle (inputs + outputs) as a regression
 * fixture: test/fixtures/golden-olive-derive.json. The golden test replays
 * the recorded inputs through matching + signals and requires identical
 * money fields — a refactor that changes any number fails it.
 *
 *   npx tsx src/scripts/record-golden.ts
 *
 * Mirrors Orchestrator.processUnderlying (first GOLDEN_EXPIRIES expiries
 * only, to keep the fixture small).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config';
import { DeriveAdapter } from '../adapters/derive';
import { OliveAdapter, type AmmQuoteResult } from '../adapters/olive';
import { matchChain } from '../matching/engine';
import { computeSignals, type SignalConfig } from '../signals/engine';
import type { OptionQuote } from '@options-arb/shared';

const UNDERLYINGS = ['SOL', 'ETH'];
const GOLDEN_EXPIRIES = 3;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const derive = new DeriveAdapter({ baseUrl: cfg.deriveBaseUrl, legacyUrl: cfg.deriveLegacyUrl, bookSource: cfg.deriveBookSource });
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
  });

  const cases = [];
  for (const underlying of UNDERLYINGS) {
    const now = Date.now();
    const [instruments, oliveState] = await Promise.all([derive.getInstruments(underlying), olive.getMarketState(underlying)]);
    const expiries = [...new Set(instruments.map((i) => i.expiryDate))].sort().slice(0, GOLDEN_EXPIRIES);
    const quotes: OptionQuote[] = [];
    for (const e of expiries) quotes.push(...(await derive.getTickers(underlying, e)));
    let spot: number | null = quotes.find((q) => q.indexPrice != null)?.indexPrice ?? oliveState?.spot ?? null;
    if (oliveState && spot != null) {
      const stale = oliveState.caveats?.includes('spot_from_stale_onchain_oracle') ?? false;
      if (oliveState.spot == null || stale) oliveState.spot = spot;
    }
    const ammCalls: Array<{ strike: number; expiryTs: number; kind: 'call' | 'put'; result: AmmQuoteResult }> = [];
    const matchConfig = {
      expiryToleranceMs: cfg.matchExpiryToleranceDays * 86_400_000,
      maxStrikeRelDist: cfg.matchMaxStrikeRelDist,
      oliveMaxTenorMs: cfg.oliveMaxTenorDays * 86_400_000,
    };
    const deriveInstruments = instruments.filter((i) => expiries.includes(i.expiryDate));
    const rows = matchChain({
      now,
      underlying,
      deriveInstruments,
      deriveQuotes: new Map(quotes.map((q) => [q.instrumentId, q])),
      oliveQuoteProvider: (strike, expiryTs, kind) => {
        const result = olive.getAmmQuote(underlying, strike, expiryTs, kind, now, oliveState);
        ammCalls.push({ strike, expiryTs, kind, result });
        return result;
      },
      config: matchConfig,
    });
    const liveLiquidity = olive.getCachedLiquidity(underlying);
    const capacity = olive.getCachedCapacity(underlying);
    const signalConfig: SignalConfig = {
      ivSpreadThresholdVols: cfg.ivSpreadThresholdVols,
      minBookSize: cfg.minBookSize,
      maxRelBookWidth: cfg.maxRelBookWidth,
      nearExpiryDays: cfg.nearExpiryDays,
      staleQuoteMs: Math.max(60_000, cfg.pollIntervalMs * 3),
      deriveTakerFeeBps: cfg.deriveTakerFeeBps,
      oliveFeeNotionalBps: 2.5,
      oliveFeePremiumPct: 10,
      solanaFeeUsdc: cfg.solanaFeeUsdc,
      capitalBorrowRateApr: cfg.capitalBorrowRateApr,
      poolLiquidityUsdByAsset: liveLiquidity != null ? { ...cfg.olivePoolLiquidityUsd, [underlying]: liveLiquidity } : { ...cfg.olivePoolLiquidityUsd },
      poolCustodyByAsset: capacity ? { [underlying]: capacity } : {},
    };
    const spots = { [underlying]: spot };
    const signals = computeSignals(rows, signalConfig, now, spots);
    cases.push({ underlying, now, deriveInstruments, deriveQuotes: quotes, ammCalls, matchConfig, signalConfig, spots, rows, signals });
    console.log(`${underlying}: ${rows.length} rows, ${signals.length} signals, ${ammCalls.length} AMM quotes`);
  }
  mkdirSync('test/fixtures', { recursive: true });
  writeFileSync('test/fixtures/golden-olive-derive.json', JSON.stringify({ recordedAt: new Date().toISOString(), cases }));
  console.log('wrote test/fixtures/golden-olive-derive.json');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
