import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCallputLog, decodeCallputTokenId, describeLegs, type RawLog } from '../src/adapters/callputEvents';

/** The owner's two 2026-09-27 Callput requests (DATA_SOURCES row 85): 0xb86f… cancelled, 0x62ee… executed. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/callput-pm-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const SEP28 = Date.UTC(2026, 8, 28, 8);
const OWNER = '0xd7700c8fbb6df79ce08d6d1d138547d097a8eb67';

describe('Callput optionTokenId', () => {
  it('decodes underlying, expiry, strategy and 48-bit legs (the owner\'s BTC 85000/85500 call spread)', () => {
    const t = decodeCallputTokenId('0001006aba1e80560000000a60440000000a6fe4000000000000000000000000');
    expect(t).toEqual({
      underlyingIndex: 1,
      expiryTs: SEP28,
      strategy: 5,
      legs: [{ isBuy: true, strike: 85000, isCall: true }, { isBuy: false, strike: 85500, isCall: true }],
      vaultIndex: 0,
    });
    expect(describeLegs(t.legs)).toBe('buy 85000C / sell 85500C');
  });

  it('decodes a put spread on a stock underlying (NVDA, 17:00 UTC expiry)', () => {
    const t = decodeCallputTokenId('0007006b256690560000000005cc00000000061c000000000000000000000000');
    expect(t.underlyingIndex).toBe(7);
    expect(new Date(t.expiryTs).toISOString()).toBe('2026-12-18T17:00:00.000Z');
    expect(describeLegs(t.legs)).toBe('buy 185C / sell 195C');
  });
});

describe('Callput PositionManager events (owner fixture)', () => {
  const events = fixture.logs.map(decodeCallputLog);

  it('open request → cancelled with the full amount refunded', () => {
    const req = events[1]!;
    expect(req).toMatchObject({ type: 'openRequest', account: OWNER, minSizeRaw: 78_000_000n, amountInRaw: 1_049_099n });
    if (req.type !== 'openRequest') throw new Error('type');
    expect(describeLegs(req.token.legs)).toBe('buy 89000C / sell 92000C');
    expect(events[2]).toMatchObject({ type: 'openCancelled', account: OWNER, amountInRaw: 1_049_099n });
  });

  it('open request → executed: 0.01045202 BTC-spread units for 0.800517 USDC', () => {
    expect(events[3]).toMatchObject({ type: 'requestKey', account: OWNER, isOpen: true });
    expect(events[4]).toMatchObject({ type: 'openRequest', minSizeRaw: 780_000n, amountInRaw: 800_517n });
    const ex = events[5]!;
    expect(ex).toMatchObject({ type: 'openExecuted', account: OWNER, sizeRaw: 1_045_202n, amountInRaw: 800_517n });
    if (ex.type !== 'openExecuted') throw new Error('type');
    expect(ex.token.expiryTs).toBe(SEP28);
    expect(describeLegs(ex.token.legs)).toBe('buy 85000C / sell 85500C');
  });

  it('ignores event types it does not read', () => {
    expect(decodeCallputLog({ blockNumber: '0x1', transactionHash: '0x', topics: ['0xdeadbeef'], data: '0x' })).toBeNull();
  });
});
