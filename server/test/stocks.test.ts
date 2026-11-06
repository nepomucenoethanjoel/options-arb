import { describe, expect, it } from 'vitest';
import { HEADLINE_BLOCKING_FLAGS, isUsEquitySessionOpen, type Signal } from '@options-arb/shared';
import { DEFAULT_OLIVE_SYMBOL_MAP } from '../src/config';
import { underlyingFlags } from '../src/scheduler';

describe('NYSE session calendar', () => {
  it('open 09:30–16:00 New York on a regular weekday, across DST', () => {
    // Thu 2026-11-05 (EST, UTC−5): 14:30 UTC = 09:30 ET.
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 5, 14, 29))).toBe(false);
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 5, 14, 30))).toBe(true);
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 5, 20, 59))).toBe(true);
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 5, 21, 0))).toBe(false);
    // Wed 2026-07-08 (EDT, UTC−4): 13:30 UTC = 09:30 ET.
    expect(isUsEquitySessionOpen(Date.UTC(2026, 6, 8, 13, 30))).toBe(true);
  });

  it('closed on weekends, holidays, after an early close, and past the calendar', () => {
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 7, 16))).toBe(false); // Saturday
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 26, 16))).toBe(false); // Thanksgiving
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 27, 17, 59))).toBe(true); // 12:59 ET, early-close day
    expect(isUsEquitySessionOpen(Date.UTC(2026, 10, 27, 18, 0))).toBe(false); // 13:00 ET
    expect(isUsEquitySessionOpen(Date.UTC(2028, 0, 4, 16))).toBe(false); // not covered → closed
  });
});

describe('per-underlying headline blocks', () => {
  const sig = (over: Partial<Signal> = {}): Signal =>
    ({ pairKey: 'TSLA-20261113-350-C', buyVenue: 'olive', sellVenue: 'callput', flags: ['indicative_quote'], alternatives: [{ buyVenue: 'coincall', sellVenue: 'callput', flags: [] }], ...over }) as unknown as Signal;
  const cfg = { stockUnderlyings: ['TSLA', 'SPY'], oliveSymbolMap: DEFAULT_OLIVE_SYMBOL_MAP };
  const open = Date.UTC(2026, 10, 5, 16);
  const closed = Date.UTC(2026, 10, 7, 16);

  it('stock rows outside the session carry market_closed — on the pair and every alternative', () => {
    const [s] = underlyingFlags([sig()], 'TSLA', closed, cfg);
    expect(s!.flags).toContain('market_closed');
    expect(s!.alternatives![0]!.flags).toContain('market_closed');
    expect(underlyingFlags([sig()], 'TSLA', open, cfg)[0]!.flags).not.toContain('market_closed');
  });

  it('an Olive leg on a wrapper market (TSLAX for TSLA, PAXG for XAUT) carries wrapper_basis; non-Olive pairs do not', () => {
    const [s] = underlyingFlags([sig()], 'TSLA', open, cfg);
    expect(s!.flags).toContain('wrapper_basis');
    expect(s!.alternatives![0]!.flags).not.toContain('wrapper_basis');
    expect(underlyingFlags([sig({ pairKey: 'XAUT-20261113-4000-C' })], 'XAUT', open, cfg)[0]!.flags).toContain('wrapper_basis');
  });

  it('crypto underlyings are untouched, and both flags block the headline', () => {
    const s = sig({ pairKey: 'BTC-20261113-80000-C' });
    expect(underlyingFlags([s], 'BTC', closed, cfg)[0]).toBe(s);
    expect(HEADLINE_BLOCKING_FLAGS.has('market_closed')).toBe(true);
    expect(HEADLINE_BLOCKING_FLAGS.has('wrapper_basis')).toBe(true);
  });
});
