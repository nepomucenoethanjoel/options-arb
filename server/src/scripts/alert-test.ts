/**
 * Sends one labelled test message through every configured alert transport
 * (server/.env: DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID,
 * ALERT_WEBHOOK_URL) and prints each HTTP outcome. Exit 1 when none is
 * configured or any delivery fails. URLs/tokens are never printed.
 *   npm run alert:test -w server            (default text)
 *   npm run alert:test -w server -- "text"  (custom text, e.g. a cron failure)
 */
import { loadConfig } from '../config';
import { Alerter } from '../alerts';

async function main() {
  const text = process.argv[2];
  const results = await new Alerter(loadConfig()).sendTest(text);
  if (results.length === 0) {
    console.error('no alert transport configured (DISCORD_WEBHOOK_URL / TELEGRAM_* / ALERT_WEBHOOK_URL)');
    process.exitCode = 1;
    return;
  }
  for (const r of results) console.log(`${r.transport}: ${r.ok ? 'delivered' : `FAILED (${r.error})`}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error('alert test failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
