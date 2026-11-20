import {
  HEADLINE_BLOCKING_FLAGS,
  VENUE_SPECS,
  honestClipSize,
  honestTotalNetUsdc,
  isTwoLegExecutable,
  yearsBetween,
  type MatchRow,
  type OptionQuote,
  type Signal,
  type Venue,
} from '@options-arb/shared';
import type { AppConfig } from './config';
import { hypercallShortMargin } from './signals/hypercallMargin';
import { fetchWithTimeout } from './util';

/**
 * Threshold-crossing alerts. Transports (first configured wins):
 *  - Discord channel webhook (DISCORD_WEBHOOK_URL) — one credential, no bot
 *  - Telegram Bot API (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *  - generic JSON webhook (ALERT_WEBHOOK_URL) — Slack/relays etc.
 *
 * Gating: isOpportunity rows only, executable direction only (writing to
 * Olive's pool is an LP role), no headline-blocking flag (reference venues,
 * unpriced Olive fills, unproven or broken books — what the KPI excludes, an
 * alert must too), and — when
 * ALERT_MIN_TOTAL_USDC > 0 — the clip's HONEST total (expected/marginal-fill
 * aware: min(quoted, expected), the same basis as the KPI Σ) must clear the
 * threshold. Deduped per pair with a cooldown so a persistently crossed pair
 * doesn't spam. Disabled by default.
 *
 * Delivery: ONE message per cycle, best honest total first, packed up to the
 * transport's length limit; pairs that don't fit stay due for the next cycle.
 * Per-pair concurrent posts (~50 per cycle on a busy book) blew through
 * Discord's ~5 posts / 2 s webhook limit — 22k HTTP 429s/day on 2026-10-30 —
 * and every rejected pair re-fired next cycle. A 429's Retry-After pauses all
 * sending, since webhook limits are per channel, not per pair.
 *
 * Maker-quote lane (MAKER_ALERTS, own cooldown, own message): a venue pair
 * whose ONLY headline-blocking flag is `single_maker` — one market maker's
 * RFQ quote crossing a clean order book after fees. Those stay out of the
 * headline (unproven at size), but they are the fleeting mispricings worth a
 * human look: the 2026-11-20 Hypercall BTC 46000-P bid at ~4x Hypercall's own
 * model price filled at the quote, then was pulled ~40 min later (row 82).
 */
export class Alerter {
  private lastAlertPerPair = new Map<string, number>();
  private lastMakerAlert = new Map<string, number>();
  /** A cycle landing while the previous digest is still posting skips; its pairs stay due. */
  private sending = false;
  /** Retry-After from the last 429 — nothing is sent before this. */
  private pausedUntil = 0;

  constructor(private readonly cfg: AppConfig) {}

  async process(signals: Signal[], rows?: ReadonlyMap<string, MatchRow>): Promise<void> {
    if (!this.cfg.alertsEnabled) return;
    const transport = this.transport();
    if (!transport) return;
    const now = Date.now();
    if (this.sending || now < this.pausedUntil) return;
    for (const [pair, ts] of this.lastAlertPerPair) {
      if (now - ts >= this.cfg.alertCooldownMs) this.lastAlertPerPair.delete(pair);
    }
    if (this.cfg.makerAlertsEnabled && rows) {
      this.sending = true;
      try {
        await this.processMakerQuotes(transport, signals, rows, now);
      } finally {
        this.sending = false;
      }
      if (Date.now() < this.pausedUntil) return;
    }
    const due: Array<{ s: Signal; honest: number }> = [];
    for (const s of signals) {
      if (!s.isOpportunity) continue;
      if (this.cfg.alertsExecutableOnly && !isTwoLegExecutable(s)) continue;
      if (s.flags.some((f) => HEADLINE_BLOCKING_FLAGS.has(f))) continue;
      const honest = honestTotalNetUsdc(s) ?? 0;
      if (this.cfg.alertMinTotalUsdc > 0 && honest < this.cfg.alertMinTotalUsdc) continue;
      if (this.lastAlertPerPair.has(s.pairKey)) continue;
      due.push({ s, honest });
    }
    if (due.length === 0) return;
    due.sort((a, b) => b.honest - a.honest);

    // The first block always goes, however long; later ones only while the
    // message (plus the multi-pair header) stays under the transport limit.
    const limit = MAX_TEXT_CHARS[transport.kind];
    const batch: typeof due = [];
    const blocks: string[] = [];
    let length = DIGEST_HEADER_RESERVE;
    for (const d of due) {
      const block = formatSignal(d.s);
      if (blocks.length > 0 && length + 2 + block.length > limit) break;
      batch.push(d);
      blocks.push(block);
      length += 2 + block.length;
    }
    const header = batch.length > 1 ? `options-arb — ${batch.length} new opportunities, best first\n\n` : '';
    const text = header + blocks.join('\n\n');

    const payload =
      transport.kind === 'discord'
        ? { username: 'options-arb', content: text }
        : transport.kind === 'telegram'
          ? { chat_id: this.cfg.telegramChatId, text }
          : batch.length === 1
            ? { type: 'iv_spread_opportunity', text, honestTotalUsdc: batch[0]!.honest, signal: batch[0]!.s, ts: new Date(now).toISOString() }
            : { type: 'iv_spread_opportunities', text, items: batch.map((d) => ({ honestTotalUsdc: d.honest, signal: d.s })), ts: new Date(now).toISOString() };

    this.sending = true;
    try {
      await this.post(transport.url, payload);
      // Cooldown only after a confirmed delivery: a 429/4xx or network
      // failure must not silence the pairs for the whole cooldown.
      for (const d of batch) this.lastAlertPerPair.set(d.s.pairKey, now);
    } catch (err) {
      let pause = '';
      if (err instanceof RateLimitedError && err.retryAfterMs != null) {
        const ms = Math.min(err.retryAfterMs, MAX_PAUSE_MS);
        this.pausedUntil = Date.now() + ms;
        pause = ` — pausing alerts ${Math.ceil(ms / 1000)}s`;
      }
      const keys = batch.length > 1 ? `${batch[0]!.s.pairKey} (+${batch.length - 1})` : batch[0]!.s.pairKey;
      console.warn(`[alerter] alert for ${keys} failed: ${err instanceof Error ? err.message : String(err)}${pause}`);
    } finally {
      this.sending = false;
    }
  }

  private async processMakerQuotes(
    transport: { kind: keyof typeof MAX_TEXT_CHARS; url: string },
    signals: Signal[],
    rows: ReadonlyMap<string, MatchRow>,
    now: number,
  ): Promise<void> {
    for (const [key, ts] of this.lastMakerAlert) {
      if (now - ts >= this.cfg.makerAlertCooldownMs) this.lastMakerAlert.delete(key);
    }
    const hits = findMakerQuoteHits(signals, rows, this.cfg, now).filter((h) => !this.lastMakerAlert.has(h.key));
    if (hits.length === 0) return;
    const limit = MAX_TEXT_CHARS[transport.kind];
    const batch: MakerQuoteHit[] = [];
    let text = '';
    for (const h of hits) {
      const block = formatMakerHit(h);
      if (batch.length > 0 && text.length + 2 + block.length > limit) break;
      text = batch.length > 0 ? `${text}\n\n${block}` : block;
      batch.push(h);
    }
    text = text.slice(0, limit);
    const payload =
      transport.kind === 'discord'
        ? { username: 'options-arb', content: text }
        : transport.kind === 'telegram'
          ? { chat_id: this.cfg.telegramChatId, text }
          : { type: 'maker_quote', text, items: batch, ts: new Date(now).toISOString() };
    try {
      await this.post(transport.url, payload);
      // Cooldown only after a confirmed delivery, as for the digest.
      for (const h of batch) this.lastMakerAlert.set(h.key, now);
    } catch (err) {
      if (err instanceof RateLimitedError && err.retryAfterMs != null) this.pausedUntil = Date.now() + Math.min(err.retryAfterMs, MAX_PAUSE_MS);
      console.warn(`[alerter] maker-quote alert for ${batch[0]!.key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * One free-text notice (not a signal) through the preferred transport, e.g.
   * an Olive pool getting funded. Same gates as signal alerts: ALERTS_ENABLED,
   * a configured transport, and any Retry-After pause.
   */
  async notify(text: string): Promise<boolean> {
    const transport = this.transport();
    if (!this.cfg.alertsEnabled || !transport || Date.now() < this.pausedUntil) return false;
    const body = text.slice(0, MAX_TEXT_CHARS[transport.kind]);
    const payload =
      transport.kind === 'discord'
        ? { username: 'options-arb', content: body }
        : transport.kind === 'telegram'
          ? { chat_id: this.cfg.telegramChatId, text: body }
          : { type: 'notice', text: body, ts: new Date().toISOString() };
    try {
      await this.post(transport.url, payload);
      return true;
    } catch (err) {
      if (err instanceof RateLimitedError && err.retryAfterMs != null) this.pausedUntil = Date.now() + Math.min(err.retryAfterMs, MAX_PAUSE_MS);
      console.warn(`[alerter] notice failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** First configured transport wins: Discord, then Telegram, then the generic webhook. */
  private transport(): { kind: keyof typeof MAX_TEXT_CHARS; url: string } | null {
    if (this.cfg.discordWebhookUrl) return { kind: 'discord', url: this.cfg.discordWebhookUrl };
    if (this.cfg.telegramBotToken && this.cfg.telegramChatId) {
      return { kind: 'telegram', url: `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage` };
    }
    if (this.cfg.alertWebhookUrl) return { kind: 'webhook', url: this.cfg.alertWebhookUrl };
    return null;
  }

  /**
   * One clearly labelled test message through EVERY configured transport
   * (not just the preferred one) — proves delivery end to end. Ignores
   * ALERTS_ENABLED: it is an explicit operator action (npm run alert:test).
   */
  async sendTest(text = '🧪 options-arb alert test — delivery check, not a signal'): Promise<Array<{ transport: string; ok: boolean; error?: string }>> {
    const targets: Array<[string, string, unknown]> = [];
    if (this.cfg.discordWebhookUrl) targets.push(['discord', this.cfg.discordWebhookUrl, { username: 'options-arb', content: text }]);
    if (this.cfg.telegramBotToken && this.cfg.telegramChatId) {
      targets.push(['telegram', `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, { chat_id: this.cfg.telegramChatId, text }]);
    }
    if (this.cfg.alertWebhookUrl) targets.push(['webhook', this.cfg.alertWebhookUrl, { type: 'test', text, ts: new Date().toISOString() }]);
    return Promise.all(
      targets.map(([transport, url, payload]) =>
        this.post(url, payload).then(
          () => ({ transport, ok: true }),
          (err: unknown) => ({ transport, ok: false, error: err instanceof Error ? err.message : String(err) }),
        ),
      ),
    );
  }

  private async post(url: string, payload: unknown): Promise<void> {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) throw new RateLimitedError(await retryAfterMs(res));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}

/** Discord rejects content over 2000 chars, Telegram text over 4096. */
const MAX_TEXT_CHARS = { discord: 2000, telegram: 4096, webhook: 4000 } as const;
/** Room for the multi-pair header line. */
const DIGEST_HEADER_RESERVE = 64;
/** Cap on a server-requested pause, so a bogus Retry-After can't silence alerts for hours. */
const MAX_PAUSE_MS = 10 * 60_000;

class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('HTTP 429');
  }
}

/** Retry-After header (seconds; Discord, generic), else the JSON body's
 *  `retry_after` (Discord) or `parameters.retry_after` (Telegram). */
async function retryAfterMs(res: Response): Promise<number | null> {
  const header = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const body = typeof res.json === 'function'
    ? ((await res.json().catch(() => null)) as { retry_after?: unknown; parameters?: { retry_after?: unknown } } | null)
    : null;
  const s = body?.retry_after ?? body?.parameters?.retry_after;
  return typeof s === 'number' && s > 0 ? s * 1000 : null;
}

function formatSignal(s: Signal): string {
  const expectedNote =
    s.expectedTotalNetUsdc != null && s.expectedTotalNetUsdc < (s.totalNetUsdc ?? 0)
      ? ` (fill model: ${s.expectedTotalNetUsdc.toFixed(2)} after rate impact)`
      : '';
  return [
    `🎯 ${s.pairKey} — buy ${s.buyVenue} · sell ${s.sellVenue}`,
    `spread ${s.ivSpreadVols} vol pts (${s.ivSpreadBps} bps) · ${s.kind.toUpperCase()}`,
    `net ${s.netAfterCapitalUsdc} USDC/ctr · size ${honestClipSize(s)} · APY ${s.roiApyPct}%`,
    `total ${s.totalNetUsdc} USDC${expectedNote}`,
    s.flags.length > 0 ? `flags: ${s.flags.join(',')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface MakerQuoteHit {
  /** Cooldown key: contract + direction. */
  key: string;
  pairKey: string;
  kind: Signal['kind'];
  buyVenue: Venue;
  sellVenue: Venue;
  /** The single-maker leg: we sell to its bid or buy its ask. */
  makerVenue: Venue;
  makerSide: 'bid' | 'ask';
  makerPrice: number;
  makerSize: number | null;
  /** The maker venue's own model price (Hypercall theoretical_price). */
  theoreticalPrice: number | null;
  /** How far the maker quote is off its own venue's model in our favour
   *  (bid / model when we sell, model / ask when we buy). */
  theoMultiple: number | null;
  hedgeVenue: Venue;
  hedgePrice: number;
  hedgeSize: number | null;
  netPerContractUsdc: number;
  clipSize: number | null;
  totalUsdc: number;
  /** Hypercall portfolio margin per contract after the fill, when we short there. */
  marginPerContract: { imUsd: number; mmUsd: number } | null;
}

const MAKER_FLAG = 'single_maker';
/** Book-quality flags a maker leg raises by itself (an RFQ maker's rich bid
 *  often sits far from its ask, or alone, or small): tolerated only when the
 *  hedge leg's own book is two-sided, deep enough and tight enough. */
const MAKER_LEG_BOOK_FLAGS: ReadonlySet<string> = new Set(['wide_book', 'thin_book', 'one_sided']);

function hedgeBookClean(q: OptionQuote | null, cfg: Pick<AppConfig, 'minBookSize' | 'maxRelBookWidth'>): boolean {
  const bid = q?.bid ?? 0;
  const ask = q?.ask ?? 0;
  if (!(bid > 0 && ask > 0)) return false;
  if ((q!.bidSize ?? 0) < cfg.minBookSize || (q!.askSize ?? 0) < cfg.minBookSize) return false;
  return (ask - bid) / ((ask + bid) / 2) <= cfg.maxRelBookWidth;
}

/**
 * Venue pairs (each signal's best pair and its alternatives) whose only
 * headline-blocking flag is `single_maker` (plus wide/thin/one-sided book
 * flags when the hedge leg's own book is clean), both legs user-executable, and
 * whose net after fees and capital clears MAKER_ALERT_MIN_NET_USDC per
 * contract and MAKER_ALERT_MIN_TOTAL_USDC at the clip. MAKER_ALERT_MIN_THEO_MULTIPLE
 * > 0 also requires the maker quote that far off its venue's own model price.
 * Best total first.
 */
export function findMakerQuoteHits(
  signals: Signal[],
  rows: ReadonlyMap<string, MatchRow>,
  cfg: Pick<AppConfig, 'makerAlertMinNetUsdc' | 'makerAlertMinTotalUsdc' | 'makerAlertMinTheoMultiple' | 'minBookSize' | 'maxRelBookWidth'>,
  now: number,
): MakerQuoteHit[] {
  const hits: MakerQuoteHit[] = [];
  for (const s of signals) {
    const row = rows.get(s.pairKey);
    if (!row) continue;
    const candidates = [
      { buyVenue: s.buyVenue, sellVenue: s.sellVenue, entry: s.entryPriceUsdc, exit: s.exitPriceUsdc, net: s.netAfterCapitalUsdc, size: honestClipSize(s), total: honestTotalNetUsdc(s), flags: s.flags },
      ...(s.alternatives ?? []).map((a) => ({
        buyVenue: a.buyVenue, sellVenue: a.sellVenue, entry: a.entryPriceUsdc, exit: a.exitPriceUsdc,
        net: a.netAfterCapitalUsdc, size: a.maxExecutableSize, total: a.honestTotalNetUsdc, flags: a.flags,
      })),
    ];
    for (const c of candidates) {
      if (!c.buyVenue || !c.sellVenue || !isTwoLegExecutable({ buyVenue: c.buyVenue, sellVenue: c.sellVenue, flags: c.flags })) continue;
      if (!c.flags.includes(MAKER_FLAG)) continue;
      const blocking = c.flags.filter((f) => f !== MAKER_FLAG && HEADLINE_BLOCKING_FLAGS.has(f));
      if (blocking.some((f) => !MAKER_LEG_BOOK_FLAGS.has(f))) continue;
      if (c.net == null || c.net < cfg.makerAlertMinNetUsdc || c.total == null || c.total < cfg.makerAlertMinTotalUsdc) continue;
      if (c.entry == null || c.exit == null) continue;
      const sellQuote = row.legs[c.sellVenue]?.quote ?? null;
      const buyQuote = row.legs[c.buyVenue]?.quote ?? null;
      const makerIsSell = sellQuote?.flags?.includes(MAKER_FLAG) ?? false;
      if (!makerIsSell && !buyQuote?.flags?.includes(MAKER_FLAG)) continue;
      const makerQuote = makerIsSell ? sellQuote! : buyQuote!;
      const hedgeQuote = makerIsSell ? buyQuote : sellQuote;
      if (blocking.length > 0 && !hedgeBookClean(hedgeQuote, cfg)) continue;
      const makerPrice = makerIsSell ? c.exit : c.entry;
      const theo = makerQuote.theoreticalPrice ?? null;
      const theoMultiple = theo != null && theo > 0 && makerPrice > 0 ? (makerIsSell ? makerPrice / theo : theo / makerPrice) : null;
      if (cfg.makerAlertMinTheoMultiple > 0 && (theoMultiple == null || theoMultiple < cfg.makerAlertMinTheoMultiple)) continue;
      const makerVenue = makerIsSell ? c.sellVenue : c.buyVenue;
      const spot = makerQuote.indexPrice ?? null;
      const margin =
        makerIsSell && makerVenue === 'hypercall' && spot != null && makerQuote.iv != null
          ? hypercallShortMargin({ spot, strike: s.strike, kind: s.kind, tauYears: yearsBetween(now, s.expiryTs), vol: makerQuote.iv })
          : null;
      hits.push({
        key: `${s.pairKey}|${c.buyVenue}>${c.sellVenue}`,
        pairKey: s.pairKey,
        kind: s.kind,
        buyVenue: c.buyVenue,
        sellVenue: c.sellVenue,
        makerVenue,
        makerSide: makerIsSell ? 'bid' : 'ask',
        makerPrice,
        makerSize: makerIsSell ? makerQuote.bidSize : makerQuote.askSize,
        theoreticalPrice: theo,
        theoMultiple,
        hedgeVenue: makerIsSell ? c.buyVenue : c.sellVenue,
        hedgePrice: makerIsSell ? c.entry : c.exit,
        hedgeSize: (makerIsSell ? hedgeQuote?.askSize : hedgeQuote?.bidSize) ?? null,
        netPerContractUsdc: c.net,
        clipSize: c.size,
        totalUsdc: c.total,
        marginPerContract: margin && { imUsd: margin.imUsd, mmUsd: margin.mmUsd },
      });
    }
  }
  return hits.sort((a, b) => b.totalUsdc - a.totalUsdc);
}

function formatMakerHit(h: MakerQuoteHit): string {
  const label = (v: Venue) => VENUE_SPECS[v]?.label ?? v;
  const size = (x: number | null) => (x == null ? '?' : String(Number(x.toFixed(4))));
  const makerAction = h.makerSide === 'bid' ? 'sell to' : 'buy from';
  const hedgeAction = h.makerSide === 'bid' ? 'buy on' : 'sell on';
  const model =
    h.theoreticalPrice != null
      ? ` · ${label(h.makerVenue)} model ${h.theoreticalPrice.toFixed(2)}${h.theoMultiple != null ? ` (${h.theoMultiple.toFixed(1)}× in our favour)` : ''}`
      : '';
  return [
    `⚡ MAKER QUOTE — ${h.pairKey} ${h.kind.toUpperCase()}`,
    `${makerAction} ${label(h.makerVenue)} ${h.makerSide} ${h.makerPrice.toFixed(2)} × ${size(h.makerSize)} (single maker)${model}`,
    `${hedgeAction} ${label(h.hedgeVenue)} ${h.makerSide === 'bid' ? 'ask' : 'bid'} ${h.hedgePrice.toFixed(2)} × ${size(h.hedgeSize)}`,
    `net ${h.netPerContractUsdc.toFixed(2)} USDC/ctr after fees + capital · clip ${size(h.clipSize)} → ${h.totalUsdc.toFixed(2)} USDC`,
    h.marginPerContract
      ? `${label(h.makerVenue)} margin ≈ ${h.marginPerContract.imUsd.toFixed(0)} USDC/ctr IM (MM ${h.marginPerContract.mmUsd.toFixed(0)}) after an RFQ fill — estimate`
      : '',
    '⚠ one maker, unproven at size — check the live quote; these get pulled fast',
  ]
    .filter(Boolean)
    .join('\n');
}
