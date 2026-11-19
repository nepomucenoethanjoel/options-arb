import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { feeModels, type FeeContext } from '../src/signals/fees';

const ctx = (legPrice: number, notional: number): FeeContext => ({ legPrice, notional, underlying: 'SOL', kind: 'call', strike: 69, tteDays: 5, side: 'buy' });

describe('Olive option open fee (DATA_SOURCES rows 7, 77)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the live 5 bp notional bound', () => {
    vi.stubEnv('OLIVE_FEE_NOTIONAL_BPS', '');
    vi.stubEnv('OLIVE_FEE_PREMIUM_PCT', '');
    const cfg = loadConfig();
    expect(cfg.oliveFeeNotionalBps).toBe(5);
    expect(cfg.oliveFeePremiumPct).toBe(10);
  });

  it('reproduces a real fill: SOL 69-C 20NOV26, 2026-11-15 08:24:03 UTC', () => {
    // transactions.json: qty 25.000279, executionSpotPrice 70.3168, premium 2.929339, tradeFeeUsd 0.878968
    const olive = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).olive!;
    const perContract = olive.perContract(ctx(2.929339, 70.3168));
    expect(perContract * 25.000279).toBeCloseTo(0.878968, 5);
  });

  it('keeps the 10% premium cap', () => {
    const olive = feeModels({ deriveTakerFeeBps: 3, oliveFeeNotionalBps: 5, oliveFeePremiumPct: 10, solanaFeeUsdc: 0.05 }).olive!;
    expect(olive.perContract(ctx(0.02, 70))).toBeCloseTo(0.002, 10);
  });
});
