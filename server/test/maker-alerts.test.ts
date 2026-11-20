import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchRow, OptionQuote, Signal } from '@options-arb/shared';
import { Alerter, findMakerQuoteHits } from '../src/alerts';
import type { AppConfig } from '../src/config';
import { hypercallShortMargin } from '../src/signals/hypercallMargin';

// Shaped on the 2026-11-20 case (DATA_SOURCES row 82): Hypercall's one maker bid
// 195.03 for BTC-20261127-46000-P while Hypercall's own model said ~48 and OKX
// offered the same put far lower.
const NOW = Date.parse('2026-11-20T16:41:39Z');
const EXPIRY = Date.parse('2026-11-27T08:00:00Z');
const PAIR = 'BTC-20261127-46000-P';

function quote(overrides: Partial<OptionQuote>): OptionQuote {
  return {
    venue: 'hypercall', instrumentId: PAIR, ts: NOW, bid: null, bidSize: null, ask: null, askSize: null,
    mark: null, iv: 0.92, ivSource: 'model', source: 'test', ...overrides,
  };
}

function row(hypercall: Partial<OptionQuote> = {}): MatchRow {
  return {
    pairKey: PAIR, underlying: 'BTC', expiryTs: EXPIRY, expiryDate: '20261127', strike: 46000, kind: 'put', matchType: 'exact_match',
    legs: {
      hypercall: { venue: 'hypercall', instrumentId: PAIR, quote: quote({ bid: 195.03, bidSize: 0.9, theoreticalPrice: 48.2, indexPrice: 59447, flags: ['single_maker'], ...hypercall }) },
      okx: { venue: 'okx', instrumentId: 'BTC-USD-261127-46000-P', quote: quote({ venue: 'okx', bid: 50.5, bidSize: 25, ask: 53.5, askSize: 25, iv: 0.86, ivSource: 'market' }) },
    },
  };
}

function sig(overrides: Partial<Signal> = {}): Signal {
  return {
    pairKey: PAIR, underlying: 'BTC', expiryDate: '20261127', expiryTs: EXPIRY, strike: 46000, kind: 'put',
    ivSpreadVols: 40, ivSpreadBps: 3000, entryPriceUsdc: 53.5, exitPriceUsdc: 195.03, edgeUsdc: 141.53, netEdgeUsdc: 141.2,
    netAfterCapitalUsdc: 138.4, costsUsdc: 0.33, capitalCostUsdc: 2.8, maxExecutableSize: 0.9, totalNetUsdc: 124.56,
    expectedEntryUsdc: null, expectedNetAfterCapitalUsdc: null, expectedTotalNetUsdc: null, roiApyPct: null,
    settlementBasisUsdc: 1, syntheticCrossCheckUsdc: null, crossCheckDeviationUsdc: null, bookVsMarkUsdc: null,
    score: 124.56, isOpportunity: true, isProfitable: true, buyVenue: 'okx', sellVenue: 'hypercall', flags: ['single_maker'], ts: NOW,
    ...overrides,
  };
}

const lane = { makerAlertMinNetUsdc: 5, makerAlertMinTotalUsdc: 10, makerAlertMinTheoMultiple: 0, minBookSize: 0.1, maxRelBookWidth: 0.2 };
const rows = (r: MatchRow = row()) => new Map([[r.pairKey, r]]);

describe('Hypercall short-option margin', () => {
  it("reproduces Hypercall's own scanning risk on the live 0.01 position (API $38.04)", () => {
    const m = hypercallShortMargin({ spot: 59447, strike: 46000, kind: 'put', tauYears: (EXPIRY - NOW) / (365 * 864e5), vol: 0.92 });
    expect(m.scanningUsd * 0.01).toBeGreaterThan(38.04 * 0.99);
    expect(m.scanningUsd * 0.01).toBeLessThan(38.04 * 1.01);
    expect(m.mmUsd).toBeCloseTo(0.85 * m.imUsd, 9);
  });

  it('floors at 1.5% of strike and adds 1% of spot within 48 h', () => {
    const far = hypercallShortMargin({ spot: 60000, strike: 20000, kind: 'put', tauYears: 7 / 365, vol: 0.5 });
    expect(far.imUsd).toBeCloseTo(300, 6);
    const near = hypercallShortMargin({ spot: 60000, strike: 20000, kind: 'put', tauYears: 24 / 8760, vol: 0.5 });
    expect(near.imUsd).toBeCloseTo(300 + 600, 6);
  });
});

describe('maker-quote lane — gating', () => {
  it('fires for a single-maker bid crossing a clean book, with model multiple, sizes and margin', () => {
    const [h, ...rest] = findMakerQuoteHits([sig()], rows(), lane, NOW);
    expect(rest).toHaveLength(0);
    expect(h).toMatchObject({
      key: `${PAIR}|okx>hypercall`, makerVenue: 'hypercall', makerSide: 'bid', makerPrice: 195.03, makerSize: 0.9,
      theoreticalPrice: 48.2, hedgeVenue: 'okx', hedgePrice: 53.5, hedgeSize: 25, netPerContractUsdc: 138.4, clipSize: 0.9, totalUsdc: 124.56,
    });
    expect(h!.theoMultiple).toBeCloseTo(195.03 / 48.2, 9);
    expect(h!.marginPerContract!.imUsd).toBeGreaterThan(3700);
  });

  it('skips any other headline-blocking flag (stale, trading cutoff, distortion, …)', () => {
    for (const f of ['stale', 'trading_cutoff', 'price_distortion', 'mismatched_legs', 'no_book']) {
      expect(findMakerQuoteHits([sig({ flags: ['single_maker', f] })], rows(), lane, NOW)).toHaveLength(0);
    }
  });

  it("tolerates wide/thin/one-sided book flags only while the hedge leg's own book is clean", () => {
    const flags = ['single_maker', 'wide_book', 'one_sided', 'thin_book'];
    expect(findMakerQuoteHits([sig({ flags })], rows(), lane, NOW)).toHaveLength(1);
    const wideHedge = row();
    wideHedge.legs.okx!.quote = { ...wideHedge.legs.okx!.quote!, bid: 20 };
    expect(findMakerQuoteHits([sig({ flags })], rows(wideHedge), lane, NOW)).toHaveLength(0);
    const thinHedge = row();
    thinHedge.legs.okx!.quote = { ...thinHedge.legs.okx!.quote!, bidSize: 0.05 };
    expect(findMakerQuoteHits([sig({ flags })], rows(thinHedge), lane, NOW)).toHaveLength(0);
    const oneSidedHedge = row();
    oneSidedHedge.legs.okx!.quote = { ...oneSidedHedge.legs.okx!.quote!, bid: null };
    expect(findMakerQuoteHits([sig({ flags })], rows(oneSidedHedge), lane, NOW)).toHaveLength(0);
    // A clean single-maker pair needs no hedge-book check.
    expect(findMakerQuoteHits([sig()], rows(oneSidedHedge), lane, NOW)).toHaveLength(1);
  });

  it('skips clean rows (the normal lane covers them) and LP-only directions', () => {
    expect(findMakerQuoteHits([sig({ flags: [] })], rows(), lane, NOW)).toHaveLength(0);
    expect(findMakerQuoteHits([sig({ flags: ['single_maker', 'direction_limited'] })], rows(), lane, NOW)).toHaveLength(0);
  });

  it('holds the per-contract and clip-total thresholds', () => {
    expect(findMakerQuoteHits([sig({ netAfterCapitalUsdc: 4 })], rows(), lane, NOW)).toHaveLength(0);
    expect(findMakerQuoteHits([sig({ totalNetUsdc: 9 })], rows(), lane, NOW)).toHaveLength(0);
  });

  it('the optional model-multiple gate needs the quote that far off the venue model', () => {
    expect(findMakerQuoteHits([sig()], rows(), { ...lane, makerAlertMinTheoMultiple: 1.5 }, NOW)).toHaveLength(1);
    expect(findMakerQuoteHits([sig()], rows(), { ...lane, makerAlertMinTheoMultiple: 5 }, NOW)).toHaveLength(0);
    expect(findMakerQuoteHits([sig()], rows(row({ theoreticalPrice: null })), { ...lane, makerAlertMinTheoMultiple: 1.5 }, NOW)).toHaveLength(0);
  });

  it('finds the maker pair among alternatives when a clean pair ranks first', () => {
    const best = sig({ buyVenue: 'okx', sellVenue: 'deribit', flags: [], netAfterCapitalUsdc: 1, totalNetUsdc: 1 });
    best.alternatives = [{
      buyVenue: 'okx', sellVenue: 'hypercall', ivSpreadVols: 40, entryPriceUsdc: 53.5, exitPriceUsdc: 195.03,
      netAfterCapitalUsdc: 138.4, maxExecutableSize: 0.9, totalNetUsdc: 124.56, honestTotalNetUsdc: 124.56, flags: ['single_maker'],
    }];
    const hits = findMakerQuoteHits([best], rows(), lane, NOW);
    expect(hits.map((h) => h.key)).toEqual([`${PAIR}|okx>hypercall`]);
  });

  it('a cheap single-maker ask works the other way round (buy the maker, sell the book)', () => {
    const r = row({ bid: null, bidSize: null, ask: 20, askSize: 2, theoreticalPrice: 48.2 });
    r.legs.okx!.quote = quote({ venue: 'okx', bid: 45, bidSize: 10, iv: 0.95, ivSource: 'market' });
    const s = sig({ buyVenue: 'hypercall', sellVenue: 'okx', entryPriceUsdc: 20, exitPriceUsdc: 45, netAfterCapitalUsdc: 24, maxExecutableSize: 2, totalNetUsdc: 48 });
    const [h] = findMakerQuoteHits([s], rows(r), lane, NOW);
    expect(h).toMatchObject({ makerSide: 'ask', makerPrice: 20, makerSize: 2, hedgeVenue: 'okx', hedgePrice: 45, hedgeSize: 10, marginPerContract: null });
    expect(h!.theoMultiple).toBeCloseTo(48.2 / 20, 9);
  });
});

describe('maker-quote lane — delivery', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cfg = {
    alertsEnabled: true, alertWebhookUrl: '', alertCooldownMs: 300_000, alertsExecutableOnly: true,
    telegramBotToken: '', telegramChatId: '', discordWebhookUrl: 'https://discord.test/hook', alertMinTotalUsdc: 0,
    makerAlertsEnabled: true, makerAlertCooldownMs: 600_000, ...lane,
  } as Partial<AppConfig> as AppConfig;

  it('posts its own message, once per cooldown, and the headline digest never carries the row', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const alerter = new Alerter(cfg);
    await alerter.process([sig()], rows());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = String(JSON.parse(fetchMock.mock.calls[0][1].body).content);
    expect(text).toContain(`⚡ MAKER QUOTE — ${PAIR} PUT`);
    expect(text).toContain('sell to Hypercall bid 195.03 × 0.9 (single maker) · Hypercall model 48.20 (4.0× in our favour)');
    expect(text).toContain('buy on OKX ask 53.50 × 25');
    expect(text).toContain('net 138.40 USDC/ctr');
    expect(text).toMatch(/Hypercall margin ≈ \d+ USDC\/ctr IM/);
    expect(text).toContain('one maker, unproven at size');
    await alerter.process([sig()], rows());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed post leaves the hit due for the next cycle', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const alerter = new Alerter(cfg);
    await alerter.process([sig()], rows());
    await alerter.process([sig()], rows());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('MAKER_ALERTS=false turns the lane off', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await new Alerter({ ...cfg, makerAlertsEnabled: false }).process([sig()], rows());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
