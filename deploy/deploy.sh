#!/usr/bin/env bash
# Deploy from the workstation (Git Bash / Linux / macOS). One command does
# everything: build locally, ship repo + prebuilt dists, bootstrap-or-update
# the VPS, restart the service.
#
#   bash deploy/deploy.sh root@<VPS_IP>
#
# Design: the VPS never compiles anything. Dists are built here (where the
# toolchain already exists) and shipped alongside the git archive, so the
# box installs only production dependencies — ~1/3 the node_modules and no
# ~1.5 GB vite/tsc build spike. Safe to re-run for updates; server/.env and
# server/data on the box survive untouched.
set -euo pipefail

HOST=${1:?usage: bash deploy/deploy.sh user@host}
KEY=${DEPLOY_KEY:-$HOME/.ssh/options-arb-hetzner}
REMOTE_DIR=/opt/options-arb

echo "==> building dists locally (shared types + web dashboard)"
npm run build -w shared -w web
test -d shared/dist && test -d web/dist

echo "==> shipping code + dists to $HOST:$REMOTE_DIR"
git archive --format=tar HEAD | ssh -i "$KEY" "$HOST" "mkdir -p $REMOTE_DIR && tar -x -C $REMOTE_DIR"
tar -C . -cf - shared/dist web/dist | ssh -i "$KEY" "$HOST" "tar -x -C $REMOTE_DIR"

echo "==> bootstrap/update on the box (idempotent)"
ssh -i "$KEY" "$HOST" "bash $REMOTE_DIR/deploy/setup.sh"

echo "==> health check"
ssh -i "$KEY" "$HOST" "curl -s --max-time 10 http://127.0.0.1:8799/api/health | head -c 300; echo"
