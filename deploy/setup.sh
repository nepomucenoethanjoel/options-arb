#!/usr/bin/env bash
# One-time VPS bootstrap for options-arb. Run as root on the box AFTER the
# code has been unpacked to /opt/options-arb (see deploy/README.md):
#
#   bash /opt/options-arb/deploy/setup.sh
#
# Idempotent: safe to re-run (fixes permissions, reinstalls the unit).
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

echo "==> dependencies (npm workspaces: shared + server + web)"
cd "$APP_DIR"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

echo "==> build (shared types + web dashboard; server is tsc --noEmit)"
npm run build -w shared -w web

echo "==> runtime .env (HOST=0.0.0.0 for remote access)"
cd "$APP_DIR/server"
if [ ! -f .env ]; then
  cp ../.env.example .env 2>/dev/null || true
fi
sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env || printf '\nHOST=0.0.0.0\n' >> .env
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
