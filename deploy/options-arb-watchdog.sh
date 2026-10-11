#!/bin/bash
# options-arb health watchdog — run from cron every 5 min
# (deploy/options-arb-watchdog.cron). Checks the local health endpoint:
#   - unreachable  → restart the service, alert
#   - venue down / cycle stale >10min → alert
#   - recovered   → alert
# Alerts go via Telegram (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID in
# server/.env) and only on state CHANGE, so it never spams. No Telegram
# creds → silent monitoring, restart still happens.
set -euo pipefail
ENV_FILE=/opt/options-arb/server/.env
STATE=/var/lib/options-arb-watchdog
mkdir -p "$(dirname "$STATE")"
kv() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | head -1 | cut -d= -f2-; }
TOKEN=$(kv TELEGRAM_BOT_TOKEN)
CHAT=$(kv TELEGRAM_CHAT_ID)
notify() {
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      -d chat_id="$CHAT" --data-urlencode text="$1" >/dev/null 2>&1 || true
  fi
}

status=ok
detail=""
out=$(curl -fsS --max-time 10 http://127.0.0.1:8799/api/health 2>/dev/null) || {
  status=down
  detail="health endpoint unreachable"
}
if [ "$status" = ok ]; then
  verdict=$(node -e '
    const h = JSON.parse(process.argv[1]);
    const bad = [];
    for (const v of ["derive", "olive"]) {
      if (h.health?.[v]?.status !== "ok") bad.push(v + "=" + (h.health?.[v]?.status ?? "?"));
    }
    const cyc = h.health?.lastCycleMs ?? 0;
    if (cyc && Date.now() - cyc > 10 * 60_000) {
      bad.push("cycle stale " + Math.round((Date.now() - cyc) / 60000) + "min");
    }
    console.log(bad.length ? "bad: " + bad.join(" ") : "ok");
  ' "$out" 2>/dev/null) || verdict="bad: health response unparseable"
  if [ "$verdict" != ok ]; then
    status=degraded
    detail="$verdict"
  fi
fi

if [ "$status" = down ]; then
  systemctl restart options-arb || true
fi

prev=$(cat "$STATE" 2>/dev/null || echo unknown)
if [ "$status" != "$prev" ]; then
  case "$status" in
    ok)
      if [ "$prev" != unknown ]; then notify "✅ options-arb recovered (was: $prev)"; fi
      ;;
    *) notify "⚠️ options-arb $status — $detail" ;;
  esac
  echo "$status" > "$STATE"
fi
