#!/bin/bash
# Auto-deploy poller — installed to /usr/local/bin/options-arb-update.sh on
# the VPS, run every minute by deploy/options-arb.cron. Pulls the `deploy`
# branch (published by CI after green tests: main + built dashboard) and
# restarts the service only when the commit actually changed. The box never
# compiles — dists arrive via the branch.
set -euo pipefail
exec 9>/tmp/options-arb-update.lock
flock -n 9 || exit 0
cd /opt/options-arb
git fetch -q origin deploy
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/deploy)" ]; then
  git reset -q --hard origin/deploy
  npm ci --omit=dev --no-audit --no-fund >/dev/null
  systemctl restart options-arb
  logger -t options-arb "auto-deployed $(git rev-parse --short HEAD)"
fi
