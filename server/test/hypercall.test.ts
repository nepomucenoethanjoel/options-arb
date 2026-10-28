import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HypercallAdapter, mapHypercallSummary } from '../src/adapters/hypercall';

/** Trimmed real options-summary (ETH, include_rfq_provider_quotes=true) captured 2026-10-28. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/hypercall-eth.json', import.meta.url), 'utf8'));

describe('Hypercall mapping (live fixture)', () => {
  it('takes the RFQ maker quote as the book, with sizes, maker timestamp and single_maker', () => {
    const { instrument, quote } = mapHypercallSummary(fixture.result[0], 'ETH')!;
    expect(instrument).toEqual({
      venue: 'hypercall',
      instrumentId: 'ETH-20261029-2100-C',
      underlying: 'ETH',
      expiryTs: Date.UTC(2026, 9, 29, 8),
      expiryDate: '20261029',
      strike: 2100,
      kind: 'call',
    });
    expect(quote).toMatchObject({
      bid: 257.35200000000003,
      bidSize: 7.304682,
      ask: 314.17900000000003,
      askSize: 7.304682,
      ts: 1793176172104,
      mark: 285.76550000000003,
      indexPrice: 2374.6,
      ivSource: 'model',
      flags: ['single_maker'],
    });
  });

  it('no maker quotes → no book, and mark_price 0 means no mark', () => {
    const { quote } = mapHypercallSummary(fixture.result[2], 'ETH')!;
    expect(quote.bid).toBeNull();
    expect(quote.ask).toBeNull();
    expect(quote.mark).toBeNull();
    expect(quote.flags).toBeUndefined();
  });

  it('picks the best bid and ask across makers; two wallets drop single_maker', () => {
    const raw = {
      ...fixture.result[0],
      rfq_provider_quotes: [
        { wallet: '0xA', bid_price: '250', ask_price: '320', max_bid_size: '1', max_ask_size: '2', updated_at: 10 },
        { wallet: '0xB', bid_price: '260', ask_price: '330', max_bid_size: '3', max_ask_size: '4', updated_at: 5 },
      ],
    };
    const { quote } = mapHypercallSummary(raw, 'ETH')!;
    expect(quote).toMatchObject({ bid: 260, bidSize: 3, ask: 320, askSize: 2, ts: 5 });
    expect(quote.flags).toBeUndefined();
  });
});

describe('HypercallAdapter.getChain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the result array and marks health ok; an empty result (SOL) is an empty chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('currency=ETH') ? fixture : { jsonrpc: '2.0', result: [] }),
    })));
    const a = new HypercallAdapter('https://x');
    expect((await a.getChain('ETH')).quotes).toHaveLength(3);
    expect(await a.getChain('SOL')).toEqual({ instruments: [], quotes: [] });
    expect(a.getHealth().status).toBe('ok');
  });
});
