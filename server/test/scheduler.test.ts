import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config';
import { Orchestrator } from '../src/scheduler';

/** Orchestrator with the cycle body replaced by a fixed-duration stub. */
class TimedOrchestrator extends Orchestrator {
  starts: number[] = [];
  constructor(private readonly cycleMs: number, private readonly fail = false) {
    super(
      { pollIntervalMs: 15_000, historyRetentionDays: 3, oliveVolOverrides: {}, oliveRealtimeSpotTriggerPct: 0 } as unknown as AppConfig,
      {} as never,
      { onSpot: () => () => {} } as never,
      { prune: () => {} } as never,
    );
  }
  override async runOnce(): Promise<void> {
    this.starts.push(Date.now());
    await new Promise((r) => setTimeout(r, this.cycleMs));
    if (this.fail) throw new Error('boom');
  }
}

describe('Orchestrator cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs back-to-back when a cycle outlasts the interval (was every 30 s under setInterval)', async () => {
    const o = new TimedOrchestrator(15_200);
    o.start();
    await vi.advanceTimersByTimeAsync(61_000);
    o.stop();
    const gaps = o.starts.slice(1).map((t, i) => t - o.starts[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(15_200);
    for (const g of gaps) expect(g).toBeLessThan(15_210); // not ~30 s
  });

  it('keeps the interval measured from cycle start when cycles are short', async () => {
    const o = new TimedOrchestrator(4_000);
    o.start();
    await vi.advanceTimersByTimeAsync(46_000);
    o.stop();
    const gaps = o.starts.slice(1).map((t, i) => t - o.starts[i]!);
    for (const g of gaps) expect(g).toBe(15_000);
  });

  it('keeps cycling after a cycle throws, and stop() ends the chain', async () => {
    const o = new TimedOrchestrator(1_000, true);
    o.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(o.starts.length).toBe(3);
    o.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(o.starts.length).toBe(3);
  });
});
