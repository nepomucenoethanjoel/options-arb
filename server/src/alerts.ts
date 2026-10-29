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
 */
export class Alerter {
  private lastAlertPerPair = new Map<string, number>();
  /** Pairs with a send in flight — a cycle landing mid-send must not double-post. */
  private inFlight = new Set<string>();

  constructor(private readonly cfg: AppConfig) {}

  async process(signals: Signal[]): Promise<void> {
    if (!this.cfg.alertsEnabled) return;
    const discord = this.cfg.discordWebhookUrl;
    const telegram = this.cfg.telegramBotToken && this.cfg.telegramChatId;
    const webhook = this.cfg.alertWebhookUrl;
    if (!discord && !telegram && !webhook) return;
    const now = Date.now();
    for (const [pair, ts] of this.lastAlertPerPair) {
      if (now - ts >= this.cfg.alertCooldownMs) this.lastAlertPerPair.delete(pair);
    }
    const sends: Array<Promise<void>> = [];
    for (const s of signals) {
      if (!s.isOpportunity) continue;
      if (this.cfg.alertsExecutableOnly && !isTwoLegExecutable(s)) continue;
      if (s.flags.includes('price_distortion')) continue;
      const honest = honestTotalNetUsdc(s) ?? 0;
      if (this.cfg.alertMinTotalUsdc > 0 && honest < this.cfg.alertMinTotalUsdc) continue;
      if (this.lastAlertPerPair.has(s.pairKey) || this.inFlight.has(s.pairKey)) continue;

      const expectedNote =
        s.expectedTotalNetUsdc != null && s.expectedTotalNetUsdc < (s.totalNetUsdc ?? 0)
          ? ` (fill model: ${s.expectedTotalNetUsdc.toFixed(2)} after rate impact)`
          : '';
      const text = [
        `🎯 ${s.pairKey} — buy ${s.buyVenue} · sell ${s.sellVenue}`,
        `spread ${s.ivSpreadVols} vol pts (${s.ivSpreadBps} bps) · ${s.kind.toUpperCase()}`,
        `net ${s.netAfterCapitalUsdc} USDC/ctr · size ${honestClipSize(s)} · APY ${s.roiApyPct}%`,
        `total ${s.totalNetUsdc} USDC${expectedNote}`,
        s.flags.length > 0 ? `flags: ${s.flags.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const [url, payload] = discord
        ? [discord, { username: 'options-arb', content: text }]
        : telegram
          ? [`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, { chat_id: this.cfg.telegramChatId, text }]
          : [webhook, { type: 'iv_spread_opportunity', text, honestTotalUsdc: honest, signal: s, ts: new Date(now).toISOString() }];

      this.inFlight.add(s.pairKey);
      sends.push(
        this.post(url, payload)
          .then(() => {
            // Cooldown only after a confirmed delivery: a 429/4xx or network
            // failure must not silence the pair for the whole cooldown.
            this.lastAlertPerPair.set(s.pairKey, now);
          })
          .catch((err) => {
            console.warn(`[alerter] alert for ${s.pairKey} failed:`, err instanceof Error ? err.message : err);
          })
          .finally(() => this.inFlight.delete(s.pairKey)),
      );
    }
    await Promise.allSettled(sends);
  }

  private async post(url: string, payload: unknown): Promise<void> {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
