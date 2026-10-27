import type { Signal } from '@options-arb/shared';
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

  constructor(private readonly cfg: AppConfig) {}

  /** Honest clip total: the fill model's number when it prices one lower. */
  private honestTotal(s: Signal): number {
    const quoted = s.totalNetUsdc ?? 0;
    return s.expectedTotalNetUsdc != null ? Math.min(quoted, s.expectedTotalNetUsdc) : quoted;
  }

  async process(signals: Signal[]): Promise<void> {
    if (!this.cfg.alertsEnabled) return;
    const discord = this.cfg.discordWebhookUrl;
    const telegram = this.cfg.telegramBotToken && this.cfg.telegramChatId;
    const webhook = this.cfg.alertWebhookUrl;
    if (!discord && !telegram && !webhook) return;
    const now = Date.now();
    for (const s of signals) {
      if (!s.isOpportunity) continue;
      if (this.cfg.alertsExecutableOnly && s.direction !== 'buy_olive_sell_derive') continue;
      if (s.flags.includes('price_distortion')) continue;
      const honest = this.honestTotal(s);
      if (this.cfg.alertMinTotalUsdc > 0 && honest < this.cfg.alertMinTotalUsdc) continue;
      const last = this.lastAlertPerPair.get(s.pairKey) ?? 0;
      if (now - last < this.cfg.alertCooldownMs) continue;
      this.lastAlertPerPair.set(s.pairKey, now);

      const expectedNote =
        s.expectedTotalNetUsdc != null && s.expectedTotalNetUsdc < (s.totalNetUsdc ?? 0)
          ? ` (fill model: ${s.expectedTotalNetUsdc.toFixed(2)} after rate impact)`
          : '';
      const text = [
        `🎯 ${s.pairKey}`,
        `spread ${s.ivSpreadVols} vol pts (${s.ivSpreadBps} bps) · ${s.kind.toUpperCase()}`,
        `net ${s.netAfterCapitalUsdc} USDC/ctr · size ${s.maxExecutableSize} · APY ${s.roiApyPct}%`,
        `total ${s.totalNetUsdc} USDC${expectedNote}`,
        s.flags.length > 0 ? `flags: ${s.flags.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      try {
        if (discord) {
          await fetchWithTimeout(discord, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'options-arb', content: text }),
          });
        } else if (telegram) {
          await fetchWithTimeout(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text }),
          });
        } else {
          await fetchWithTimeout(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'iv_spread_opportunity',
              text,
              honestTotalUsdc: honest,
              signal: s,
              ts: new Date(now).toISOString(),
            }),
          });
        }
      } catch (err) {
        console.warn('[alerter] alert failed:', err instanceof Error ? err.message : err);
      }
    }
  }
}
