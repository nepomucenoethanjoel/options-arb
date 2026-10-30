import { honestClipSize, honestTotalNetUsdc, isTwoLegExecutable, type Signal } from '@options-arb/shared';
import type { AppConfig } from './config';
import { fetchWithTimeout } from './util';

/**
 * Threshold-crossing alerts. Transports (first configured wins):
 *  - Discord channel webhook (DISCORD_WEBHOOK_URL) — one credential, no bot
 *  - Telegram Bot API (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *  - generic JSON webhook (ALERT_WEBHOOK_URL) — Slack/relays etc.
 *
 * Gating: isOpportunity rows only, executable direction only (writing to
 * Olive's pool is an LP role), price-distortion noise skipped, and — when
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
 */
export class Alerter {
  private lastAlertPerPair = new Map<string, number>();
  /** A cycle landing while the previous digest is still posting skips; its pairs stay due. */
  private sending = false;
  /** Retry-After from the last 429 — nothing is sent before this. */
  private pausedUntil = 0;

  constructor(private readonly cfg: AppConfig) {}

  async process(signals: Signal[]): Promise<void> {
    if (!this.cfg.alertsEnabled) return;
    const transport = this.transport();
    if (!transport) return;
    const now = Date.now();
    if (this.sending || now < this.pausedUntil) return;
    for (const [pair, ts] of this.lastAlertPerPair) {
      if (now - ts >= this.cfg.alertCooldownMs) this.lastAlertPerPair.delete(pair);
    }
    const due: Array<{ s: Signal; honest: number }> = [];
    for (const s of signals) {
      if (!s.isOpportunity) continue;
      if (this.cfg.alertsExecutableOnly && !isTwoLegExecutable(s)) continue;
      if (s.flags.includes('price_distortion')) continue;
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
