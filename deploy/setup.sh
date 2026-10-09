#!/usr/bin/env bash
# One-time VPS bootstrap for options-arb (SLIM PROFILE — see deploy/README.md).
# Run as root AFTER the code AND the prebuilt dists (shared/dist, web/dist)
# have been unpacked to /opt/options-arb — deploy/deploy.sh does all of that:
#
#   bash deploy/deploy.sh root@<VPS_IP>
#
# Slim choices baked in here:
#   - no compilers on the box: dev deps never installed (--omit=dev), the
#     dashboard ships prebuilt — cuts node_modules ~3x and removes the
#     ~1.5 GB vite/tsc build memory spike entirely
#   - 3-day signal retention (charts' finest windows are 6h/24h; the 7d
#     button shows a shorter tail) — DB plateaus ~0.3-0.5 GB
#   - Node heap capped at 256 MB via the systemd unit
#   - 1 GB swap as headroom for a busy co-hosted neighbor
#
# Idempotent: safe to re-run.
set -euo pipefail

APP_DIR=/opt/options-arb
SERVICE_USER=optionsarb
NODE_MAJOR=22

echo "==> Node.js $NODE_MAJOR (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node --version

echo "==> service user '$SERVICE_USER'"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> swap (1 GB headroom)"
if ! swapon --show 2>/dev/null | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> production dependencies only (no build on this box)"
cd "$APP_DIR"
test -d shared/dist || { echo "FATAL: shared/dist missing — run deploy.sh (builds locally), not a bare git archive"; exit 1; }
test -d web/dist   || { echo "FATAL: web/dist missing — run deploy.sh (builds locally), not a bare git archive"; exit 1; }
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
npm cache clean --force >/dev/null 2>&1 || true

echo "==> runtime .env (public interface, 3-day retention)"
cd "$APP_DIR/server"
if [ ! -f .env ]; then
  cp ../.env.example .env
fi
sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env
if grep -q '^HISTORY_RETENTION_DAYS=' .env; then
  sed -i 's/^HISTORY_RETENTION_DAYS=.*/HISTORY_RETENTION_DAYS=3/' .env
else
  printf '\nHISTORY_RETENTION_DAYS=3\n' >> .env
fi
mkdir -p data
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> systemd unit"
install -m 644 "$APP_DIR/deploy/options-arb.service" /etc/systemd/system/options-arb.service
systemctl daemon-reload
systemctl enable --now options-arb

sleep 3
systemctl --no-pager --lines 5 status options-arb || true
echo
echo "Setup done. Logs:   journalctl -u options-arb -f"
echo "Health:             curl http://127.0.0.1:8799/api/health"
