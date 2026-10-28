import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Signal } from '@options-arb/shared';
import { Alerter } from '../src/alerts';
import type { AppConfig } from '../src/config';

function sig(overrides: Partial<Signal> = {}): Signal {
  return {
    pairKey: 'ZEC-20261225-1700-C', underlying: 'ZEC', expiryDate: '20261225', expiryTs: 0,
    strike: 1700, kind: 'call', ivSpreadVols: 17.3, ivSpreadBps: 1342,
    entryPriceUsdc: 88.5, exitPriceUsdc: 105, edgeUsdc: 16.5, netEdgeUsdc: 15.6,
    netAfterCapitalUsdc: 6.1, costsUsdc: 0.8, capitalCostUsdc: 9.6,
    maxExecutableSize: 0.4855, totalNetUsdc: 2.45, roiApyPct: 5.1,
    expectedEntryUsdc: 95, expectedNetAfterCapitalUsdc: 0.2, expectedTotalNetUsdc: -0.4,
    settlementBasisUsdc: 5.2, syntheticCrossCheckUsdc: 26, crossCheckDeviationUsdc: -0.6,
    bookVsMarkUsdc: 10.4, score: 0.98, isOpportunity: true, isProfitable: true,
    buyVenue: 'olive', sellVenue: 'derive', flags: ['amm_pool_depth_unknown'], ts: 0,
    ...overrides,
  };
}

const base = {
  alertsEnabled: true,
  alertWebhookUrl: '',
  alertCooldownMs: 300_000,
  alertsExecutableOnly: true,
  telegramBotToken: '',
  telegramChatId: '',
  discordWebhookUrl: '',
  alertMinTotalUsdc: 0,
} as Partial<AppConfig> as AppConfig;

function lastPost() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const c = calls[calls.length - 1];
  return { url: String(c[0]), body: JSON.parse(c[1].body) as Record<string, unknown> };
}

describe('Alerter — transports and gating', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing when disabled or unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await new Alerter({ ...base, alertsEnabled: false }).process([sig()]);
    await new Alerter({ ...base }).process([sig()]); // enabled, no transport
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('posts to the Telegram Bot API with a readable message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await new Alerter({
      ...base,
      telegramBotToken: 'T0K',
      telegramChatId: '12345',
    }).process([sig({ expectedTotalNetUsdc: null })]);
    const { url, body } = lastPost();
    expect(url).toBe('https://api.telegram.org/botT0K/sendMessage');
    expect(body.chat_id).toBe('12345');
    expect(String(body.text)).toContain('ZEC-20261225-1700-C');
    expect(String(body.text)).toContain('17.3 vol pts');
    expect(String(body.text)).not.toContain('fill model');
  });

  it('notes the fill-model total when it prices the clip lower', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await new Alerter({ ...base, telegramBotToken: 'T0K', telegramChatId: '1' }).process([sig()]);
    const { body } = lastPost();
    expect(String(body.text)).toContain('fill model: -0.4');
  });

  it('gates on the HONEST total (expected, not quoted) when a threshold is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const alerter = new Alerter({
      ...base,
      telegramBotToken: 'T0K',
      telegramChatId: '1',
      alertMinTotalUsdc: 5,
    });
    // quoted $2.45, expected -$0.40 → honest is negative → suppressed.
    await alerter.process([sig()]);
    expect(fetchMock.mock.calls).toHaveLength(0);
    // no expected → honest = quoted $2.45 → still under $5.
    await alerter.process([sig({ pairKey: 'A', expectedTotalNetUsdc: null, expectedNetAfterCapitalUsdc: null })]);
    expect(fetchMock.mock.calls).toHaveLength(0);
    // honest clears the threshold → fires.
    await alerter.process([sig({ pairKey: 'B', totalNetUsdc: 9.9, expectedTotalNetUsdc: 7.2, expectedNetAfterCapitalUsdc: 1.4 })]);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('posts to Discord as {username, content} — and wins over other transports', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await new Alerter({
      ...base,
      discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc',
      telegramBotToken: 'T0K',
      telegramChatId: '1',
      alertWebhookUrl: 'https://hooks.example/x',
    }).process([sig()]);
    expect(fetchMock.mock.calls).toHaveLength(1);
    const { url, body } = lastPost();
    expect(url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(body.username).toBe('options-arb');
    expect(String(body.content)).toContain('ZEC-20261225-1700-C');
    expect(String(body.content)).toContain('fill model: -0.4');
  });

  it('keeps webhook transport for non-Telegram setups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await new Alerter({ ...base, alertWebhookUrl: 'https://hooks.example/x' }).process([sig()]);
    const { url, body } = lastPost();
    expect(url).toBe('https://hooks.example/x');
    expect(body.type).toBe('iv_spread_opportunity');
    expect(body.honestTotalUsdc).toBe(-0.4); // min(2.45, -0.4)
  });

  it('skips non-opportunities, LP-only directions, distorted books; cooldown dedupes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const alerter = new Alerter({ ...base, telegramBotToken: 'T0K', telegramChatId: '1' });
    await alerter.process([
      sig({ pairKey: 'X1', isOpportunity: false }),
      sig({ pairKey: 'X2', buyVenue: 'derive', sellVenue: 'olive', flags: ['direction_limited'] }),
      sig({ pairKey: 'X3', flags: ['price_distortion'] }),
    ]);
    expect(fetchMock.mock.calls).toHaveLength(0);
    await alerter.process([sig({ pairKey: 'X4', expectedTotalNetUsdc: null })]);
    await alerter.process([sig({ pairKey: 'X4', expectedTotalNetUsdc: null })]); // within cooldown
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('a rejected send (HTTP 429) does not start the cooldown — the next cycle retries', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alerter = new Alerter({ ...base, telegramBotToken: 'T0K', telegramChatId: '1' });
    await alerter.process([sig({ expectedTotalNetUsdc: null })]);
    await alerter.process([sig({ expectedTotalNetUsdc: null })]);
    await alerter.process([sig({ expectedTotalNetUsdc: null })]); // delivered last time → cooled down
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('sends a cycle’s alerts concurrently, and a send in flight is not duplicated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    const alerter = new Alerter({ ...base, telegramBotToken: 'T0K', telegramChatId: '1' });
    const first = alerter.process([sig({ pairKey: 'A', expectedTotalNetUsdc: null }), sig({ pairKey: 'B', expectedTotalNetUsdc: null })]);
    await Promise.resolve();
    expect(fetchMock.mock.calls).toHaveLength(2); // both started before either finished
    const second = alerter.process([sig({ pairKey: 'A', expectedTotalNetUsdc: null })]); // A still in flight
    release();
    await Promise.all([first, second]);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });
});
