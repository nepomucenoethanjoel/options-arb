import { describe, expect, it } from 'vitest';
import { expiryDateToTs, mapDeriveTicker, parseDeriveInstrumentName } from '../src/adapters/derive';

describe('parseDeriveInstrumentName', () => {
  it('parses a standard option name', () => {
    expect(parseDeriveInstrumentName('ETH-20261030-2900-C')).toEqual({
      underlying: 'ETH',
      expiryDate: '20261030',
      strike: 2900,
      kind: 'call',
    });
  });

  it('parses fractional strikes using underscore decimals', () => {
    expect(parseDeriveInstrumentName('BTC-20261226-2400_5-P')).toMatchObject({ strike: 2400.5, kind: 'put' });
  });

  it('tolerates a trailing risk-universe id', () => {
    expect(parseDeriveInstrumentName('SOL-20261030-300-C-2')).toMatchObject({ strike: 300 });
  });

  it('rejects malformed names', () => {
    expect(parseDeriveInstrumentName('ETHUSDT-PERP')).toBeNull();
    expect(parseDeriveInstrumentName('ETH-20261030--C')).toBeNull();
  });
});

describe('expiryDateToTs', () => {
  it('anchors at 08:00 UTC', () => {
    const ts = expiryDateToTs('20261030');
    const d = new Date(ts);
    expect(d.toISOString()).toBe('2026-10-30T08:00:00.000Z');
  });
});

describe('mapDeriveTicker', () => {
  it('maps abbreviated slim keys to the normalized shape', () => {
    const q = mapDeriveTicker(
      'ETH-20261030-2900-C',
      {
        t: 1790533334393,
        b: 80.9,
        B: 12.5,
        a: 86.2,
        A: 3.1,
        M: 83.5,
        I: 2995.2,
        stats: { oi: 526.36 },
        option_pricing: { i: 0.583, d: 0.412, g: 0.0021, v: 3.4, t: -12.2, r: 0.9, f: 3002.1, df: 0.989 },
      },
      'derive:v3-rest',
    );
    expect(q.venue).toBe('derive');
    expect(q.bid).toBe(80.9);
    expect(q.ask).toBe(86.2);
    expect(q.mark).toBe(83.5);
    expect(q.indexPrice).toBe(2995.2);
    expect(q.iv).toBe(0.583);
    expect(q.ivSource).toBe('market');
    expect(q.greeks?.delta).toBe(0.412);
    expect(q.greeks?.vega).toBe(3.4);
    expect(q.forward).toBe(3002.1);
    expect(q.discountFactor).toBe(0.989);
    expect(q.openInterest).toBe(526.36);
    expect(q.source).toBe('derive:v3-rest');
  });

  it('treats zeroed books as absent (v3 zero-book quirk)', () => {
    const q = mapDeriveTicker(
      'ETH-20261030-2900-C',
      { t: 1, b: 0, B: 0, a: 0, A: 0, M: 83.5, option_pricing: { i: 0.583 } },
      'derive:v3-rest',
    );
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
    expect(q.bidSize).toBeNull();
    expect(q.askSize).toBeNull();
    expect(q.mark).toBe(83.5);
    expect(q.iv).toBe(0.583);
  });

  it('falls back to raw mark when option_pricing mark is missing', () => {
    const q = mapDeriveTicker('X', { t: 1, M: 42 }, 's');
    expect(q.mark).toBe(42);
  });
});
