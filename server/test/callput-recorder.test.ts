import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawLog } from '../src/adapters/callputEvents';
import { CallputRecorder, legSum, summarizeCallputFills } from '../src/callputRecorder';

/** The owner's two 2026-09-27 requests (rows 85, 87): 0xb86f… cancelled 4 s later, 0x62ee… executed 6 s later. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/callput-pm-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const RPC = 'https://rpc.test';
const FEED = 'https://feed.test/market-data.json';
const PM = '0x83b04701b227b045cbbaf921377137ff595a54af';
const OWNER = 'd7700c8fbb6df79ce08d6d1d138547d097a8eb67';
const SEP28_S = 1790582400;
const EXECUTION_TX = fixture.logs[5]!.transactionHash;

const feed = {
  lastUpdatedAt: '2026-09-27T21:23:05.000Z',
  data: {
    spotIndices: { BTC: 84672 },
    market: {
      BTC: {
        options: {
          [String(SEP28_S)]: {
            call: [
              { optionId: '0x0001006aba1e80000000014c08', strikePrice: 85000, markPrice: 400, markIv: 0.5, riskPremiumRateForBuy: 0.02, riskPremiumRateForSell: 0.01 },
              { optionId: '0x0001006aba1e80000000014dfc', strikePrice: 85500, markPrice: 330, markIv: 0.5, riskPremiumRateForBuy: 0.02, riskPremiumRateForSell: 0.01 },
            ],
          },
        },
      },
    },
  },
};

function fakeFetch(opts: { creditRaw?: bigint } = {}) {
  let logsServed = false;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === FEED) return { ok: true, status: 200, json: async () => feed } as Response;
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const reply = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ result }) }) as Response;
    if (method === 'eth_blockNumber') return reply('0x' + (51877430).toString(16));
    if (method === 'eth_getLogs') {
      const out = logsServed ? [] : fixture.logs;
      logsServed = true;
      return reply(out);
    }
    if (method === 'eth_getTransactionReceipt') {
      const logs = (params[0] === EXECUTION_TX && opts.creditRaw != null)
        ? [{ address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + PM.slice(2).padStart(64, '0'), '0x' + OWNER.padStart(64, '0')], data: '0x' + opts.creditRaw.toString(16).padStart(64, '0') }]
        : [];
      return reply({ logs });
    }
    throw new Error(`unexpected ${method}`);
  });
}

describe('legSum', () => {
  const legs = [
    { isBuy: true, strike: 85000, isCall: true, mark: 400, rpBuy: 0.02, rpSell: 0.01, iv: 0.5 },
    { isBuy: false, strike: 85500, isCall: true, mark: 330, rpBuy: 0.02, rpSell: 0.01, iv: 0.5 },
  ];
  it('opens: bought legs at mark·(1+rpBuy), sold legs at −mark·(1−rpSell)', () => {
    expect(legSum(legs, 'open')).toBeCloseTo(400 * 1.02 - 330 * 0.99, 9);
  });
  it('closes reverse each leg: the held long is sold at the bid, the held short bought back at the ask', () => {
    expect(legSum(legs, 'close')).toBeCloseTo(-400 * 0.99 + 330 * 1.02, 9);
  });
  it('null when a leg is unquoted', () => {
    expect(legSum([{ ...legs[0]!, mark: null }], 'open')).toBeNull();
  });
});

describe('CallputRecorder (owner fixture, faked RPC + feed)', () => {
  afterEach(() => vi.useRealTimers());

  it('records the cancellation and the debit fill with latency, size, all-in price and the feed prediction', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-27T21:23:20Z'), toFake: ['Date'] });
    const dir = mkdtempSync(join(tmpdir(), 'cp-rec-'));
    const rec = new CallputRecorder({ rpcUrl: RPC, feedUrl: FEED, file: join(dir, 'fills.jsonl'), fetchImpl: fakeFetch() as never });
    await rec.poll();
    expect(rec.lastError).toBeNull();
    const [filled, cancelled] = rec.latest();
    expect(cancelled).toMatchObject({ kind: 'open', outcome: 'cancelled', underlying: 'BTC', legs: 'buy 89000C / sell 92000C', usdc: 1.049099, latencyMs: 4000, size: null });
    expect(filled).toMatchObject({ kind: 'open', outcome: 'executed', underlying: 'BTC', legs: 'buy 85000C / sell 85500C', size: 0.01045202, usdc: 0.800517, latencyMs: 6000, creditUsdc: null });
    expect(filled!.perUnit).toBeCloseTo(0.800517 / 0.01045202, 9);
    expect(filled!.predictedPerUnit).toBeCloseTo(400 * 1.02 - 330 * 0.99, 9);
    expect(filled!.snapshot).toMatchObject({ spot: 84672, feedTs: Date.parse('2026-09-27T21:23:05Z') });
    const lines = readFileSync(join(dir, 'fills.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(summarizeCallputFills(rec.latest())).toMatchObject({ records: 2, executed: 1, cancelled: 1, comparable: 1 });
  });

  it("a debit spread's open never reads USDC sent to the account as credit (e.g. a close paid out in the same transaction)", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-27T21:23:20Z'), toFake: ['Date'] });
    const f = fakeFetch({ creditRaw: 500_000n });
    const rec = new CallputRecorder({ rpcUrl: RPC, feedUrl: FEED, file: null, fetchImpl: f as never });
    await rec.poll();
    const [filled] = rec.latest();
    expect(filled!.creditUsdc).toBeNull();
    expect(filled!.perUnit).toBeCloseTo(0.800517 / 0.01045202, 9);
    expect(filled!.predictedPerUnit).toBeCloseTo(400 * 1.02 - 330 * 0.99, 9);
    expect(f.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body ?? '').includes('eth_getTransactionReceipt'))).toBe(false);
  });

  it('only counts fills whose snapshot was taken within the max age of the request as comparable', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-28T21:23:20Z'), toFake: ['Date'] });
    const rec = new CallputRecorder({ rpcUrl: RPC, feedUrl: FEED, file: null, fetchImpl: fakeFetch() as never });
    await rec.poll();
    expect(summarizeCallputFills(rec.latest()).comparable).toBe(0);
  });

  it('backfills on the first poll, then never re-reads a block it has read', async () => {
    const f = fakeFetch();
    const rec = new CallputRecorder({ rpcUrl: RPC, feedUrl: FEED, file: null, fetchImpl: f as never });
    await rec.poll();
    await rec.poll();
    const ranges = f.mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? 'null')))
      .filter((b) => b?.method === 'eth_getLogs')
      .map((b) => b.params[0].fromBlock);
    expect(ranges).toEqual(['0x' + (51877430 - 3000).toString(16)]); // head unchanged → the second poll reads nothing
    expect(rec.latest()).toHaveLength(2);
  });
});
