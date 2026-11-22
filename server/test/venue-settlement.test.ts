import { describe, expect, it } from 'vitest';
import { settlementWindowHours } from '@options-arb/shared';

describe("Derive's settlement window depends on the product (docs settlement.md, row 95)", () => {
  it('crypto 30-min TWAP; NVDA / WTI 2 min; US500 / US100 a 30-s futures VWAP; other venues unchanged', () => {
    expect(settlementWindowHours('derive', 'BTC')).toBe(0.5);
    expect(settlementWindowHours('derive', 'NVDA')).toBeCloseTo(2 / 60, 12);
    expect(settlementWindowHours('derive', 'WTI')).toBeCloseTo(2 / 60, 12);
    expect(settlementWindowHours('derive', 'US500')).toBeCloseTo(30 / 3600, 12);
    expect(settlementWindowHours('okx', 'BTC')).toBe(0.5);
    expect(settlementWindowHours('aevo', 'BTC')).toBe(0);
  });
});
