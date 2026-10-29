import { describe, expect, it } from 'vitest';
import type { MatchRow, Venue } from '@options-arb/shared';
import { surfaceFlags } from '../src/signals/surfaceChecks';

const NOW = Date.UTC(2026, 9, 29, 12);
const E1 = Date.UTC(2026, 10, 6, 8);
const E2 = Date.UTC(2026, 10, 27, 8);

function row(venue: Venue, strike: number, iv: number, expiryTs = E1, kind: 'call' | 'put' = 'call'): MatchRow {
  return {
    pairKey: `ETH-${expiryTs}-${strike}-${kind}`, underlying: 'ETH', expiryTs, expiryDate: String(expiryTs), strike, kind, matchType: 'exact_match',
    legs: { [venue]: { venue, instrumentId: `${venue}-${strike}`, quote: { venue, instrumentId: `${venue}-${strike}`, ts: NOW, bid: null, bidSize: null, ask: null, askSize: null, mark: null, iv, ivSource: 'market', source: venue } } },
  };
}

const smile = (venue: Venue, ivs: number[], expiryTs = E1) => ivs.map((iv, i) => row(venue, 2000 + i * 100, iv, expiryTs));
const flagged = (m: Map<string, Map<Venue, string[]>>, flag: string) =>
  [...m].flatMap(([k, byV]) => [...byV].filter(([, f]) => f.includes(flag)).map(([v]) => `${k}|${v}`));

describe('surfaceFlags', () => {
  it('flags one strike sitting far off its own smile, not a smooth smile', () => {
    expect(flagged(surfaceFlags(smile('derive', [0.62, 0.58, 0.55, 0.53, 0.52, 0.53]), NOW), 'smile_outlier')).toEqual([]);
    const planted = smile('derive', [0.62, 0.58, 0.55, 0.66, 0.52, 0.53]); // 2300 strike +12 vols
    expect(flagged(surfaceFlags(planted, NOW), 'smile_outlier')).toEqual([`ETH-${E1}-2300-call|derive`]);
  });

  it('checks each venue against its own smile only', () => {
    const rows = [...smile('derive', [0.62, 0.58, 0.55, 0.53, 0.52, 0.53]), ...smile('coincall', [0.7, 0.66, 0.63, 0.61, 0.6, 0.61])];
    expect(flagged(surfaceFlags(rows, NOW), 'smile_outlier')).toEqual([]);
  });

  it('flags falling total variance across expiries at the same strike', () => {
    // T1 ≈ 7.8d at 60% → w ≈ 0.00769; T2 ≈ 28.8d at 30% → w ≈ 0.0071 < w1: inverted.
    const inverted = [row('deribit', 2300, 0.6, E1), row('deribit', 2300, 0.3, E2)];
    expect(flagged(surfaceFlags(inverted, NOW), 'calendar_inversion')).toEqual([`ETH-${E2}-2300-call|deribit`]);
    const normal = [row('deribit', 2300, 0.6, E1), row('deribit', 2300, 0.55, E2)];
    expect(flagged(surfaceFlags(normal, NOW), 'calendar_inversion')).toEqual([]);
  });

  it('skips AMM legs (one model vol, no smile)', () => {
    const olive = smile('olive', [0.5, 0.5, 0.5, 0.9, 0.5, 0.5]);
    expect(surfaceFlags(olive, NOW).size).toBe(0);
  });
});

describe('surfaceFlags near expiry', () => {
  it('ignores expiries less than a day out', () => {
    const today = NOW + 6 * 3_600_000;
    const planted = [0.62, 0.58, 0.55, 0.9, 0.52, 0.53].map((iv, i) => row('derive', 2000 + i * 100, iv, today));
    expect(surfaceFlags(planted, NOW).size).toBe(0);
  });
});
