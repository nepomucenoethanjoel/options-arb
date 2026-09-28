import type { Signal } from '@options-arb/shared';
import type { AppConfig } from './config';

/**
 * Threshold-crossing webhook alerts (generic JSON POST — works with Discord/
 * Slack webhook relays or any receiver). Deduped per pair with a cooldown so
 * a persistently crossed pair doesn't spam. Disabled by default.
 */
export class Alerter {
  private lastAlertPerPair = new Map<string, number>();

  constructor(private readonly cfg: AppConfig) {}

  async process(signals: Signal[]): Promise<void> {
    if (!this.cfg.alertsEnabled || !this.cfg.alertWebhookUrl) return;
    const now = Date.now();
    for (const s of signals) {
      if (!s.isOpportunity) continue;
      // The buy-Olive/sell-Derive direction is the only one executable on
      // both legs (writing to Olive's pool is an LP role) — default filter.
      if (this.cfg.alertsExecutableOnly && s.direction !== 'buy_olive_sell_derive') continue;
      if (s.flags.includes('price_distortion')) continue;
      const last = this.lastAlertPerPair.get(s.pairKey) ?? 0;
      if (now - last < this.cfg.alertCooldownMs) continue;
      this.lastAlertPerPair.set(s.pairKey, now);
      try {
        await fetch(this.cfg.alertWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'iv_spread_opportunity',
            text: `IV spread ${s.ivSpreadVols} vol pts | ${s.pairKey} | net ${s.netAfterCapitalUsdc} USDC/ctr after fees+capital | total ${s.totalNetUsdc} USDC × ${s.maxExecutableSize} | APY ${s.roiApyPct}% | flags: ${s.flags.join(',')}`,
            signal: s,
            ts: new Date(now).toISOString(),
          }),
        });
      } catch (err) {
        console.warn('[alerter] webhook failed:', err instanceof Error ? err.message : err);
      }
    }
  }
}
