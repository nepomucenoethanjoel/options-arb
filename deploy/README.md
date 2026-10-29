# Deploying options-arb to a VPS (any provider — Hetzner, Rocknerd, …)

The kit is provider-agnostic: it needs any Ubuntu/Debian box with root SSH.
Provider notes:

- **Rocknerd (budget KVM/OpenVZ):** pick a **KVM** plan, Ubuntu 22.04/24.04.
  OpenVZ plans mostly work too (setup tolerates missing swap), but KVM gives
  you a real kernel, swap, and systemd niceties. There is no cloud firewall —
  restrict access on the box itself:
  ```bash
  ufw allow OpenSSH && ufw allow 8799/tcp   # or skip 8799 and use SSH tunneling
  ufw enable
  ```
  Initial access is usually a root password from their panel — convert to
  the deploy key (step 2) on first login, then disable password auth
  (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- **Hetzner:** CX22 (x86) / CAX11 (ARM), Ubuntu 24.04, and use a Cloud
  Firewall instead of ufw (allow 22 + 8799 from your IP only).

Single Node process: the API server serves the built dashboard itself
(`web/dist`), so there is no second web server to run. SQLite lives in
`server/data/` (auto-pruned, WAL bounded). No secrets are needed — every
data source is public/read-only.

**Slim profile** (default): the VPS never compiles anything — deploy.sh
builds dists locally and ships them, the box installs production deps only
(`--omit=dev`), Node's heap is capped at 256 MB, retention is 3 days, and a
1 GB swapfile absorbs co-hosting spikes. Steady footprint: **~150-250 MB
RAM, ~0.3-0.5 GB DB plateau, ~0.7 GB app tree** — comfortable on a 1-2 GB
box shared with another app. To go back to build-on-the-box (fatter:
~1.5 GB build RAM, 7-day retention), ship a bare `git archive` and set
`HISTORY_RETENTION_DAYS=7`.

## 1. Create the VPS (Hetzner Cloud console)

- **Type:** CAX11 (2 vCPU ARM / 4 GB / 40 GB, ~€3.6/mo) or CX22 (x86, same
  size) — both are far more than the app needs; pick by what your OTHER
  co-hosted app wants. The app itself fits a 1 GB / 10 GB floor.
- **Image:** Ubuntu 24.04
- **Location:** any (fsn1/nbg1/hel1) — EU egress to both venues is fine
- **SSH key:** add your key at creation time (or paste the deploy key from
  step 2 via the console)
- **Firewall:** strongly recommended — the app has **no authentication**
  (read-only market data, but it is your monitor). Either:
  - Hetzner Cloud Firewall: allow `22/tcp` and `8799/tcp` from **your IP**
    only, or
  - keep port 8799 closed and use an SSH tunnel from your machine:
    `ssh -N -L 8799:127.0.0.1:8799 root@<VPS_IP>` → open http://127.0.0.1:8799

## 2. Deploy key (from the workstation, once — for Rocknerd: append via panel VNC console or first password login)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/options-arb-hetzner -N '' -C options-arb-deploy
```

Add the public key to the VPS (Hetzner console → Security → SSH keys, then
recreate the server, or append it manually):

```bash
cat ~/.ssh/options-arb-hetzner.pub | ssh root@<VPS_IP> 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
```

## 3. Deploy (from the repo root — that's the whole command)

```bash
bash deploy/deploy.sh root@<VPS_IP>
```

Builds locally, ships code + dists, bootstraps (Node 22, service user,
swap, systemd with `Restart=always`, `HOST=0.0.0.0`, 3-day retention),
restarts, and prints the health check. First cycle takes ~30s to populate
signals. Open `http://<VPS_IP>:8799/` (or via tunnel/proxy).

## Day-2 operations

| Task | Command (on the VPS, as root) |
|---|---|
| Logs (live) | `journalctl -u options-arb -f` |
| Auto-deploy log | `journalctl -t options-arb` (or `/var/log/syslog`) |
| Restart | `systemctl restart options-arb` |
| Status | `systemctl status options-arb` |
| Update code | push/merge to `main` — CI tests, publishes `deploy`, the box pulls within a minute |
| DB location | `/opt/options-arb/server/data/options-arb.db` |

### Alerts (Discord) + watchdog

The app alerts executable opportunities to a **Discord channel** when armed:

1. In your server: channel ⚙️ → **Integrations → Webhooks → New Webhook** → Copy URL.
2. On the VPS, set in `/opt/options-arb/server/.env`:
   `ALERTS_ENABLED=true`, `DISCORD_WEBHOOK_URL=…`
   (optionally `ALERT_MIN_TOTAL_USDC=5` — alerts only fire when the clip's
   HONEST total, fill-model aware, clears it), then `systemctl restart options-arb`.

Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) and a generic webhook
(`ALERT_WEBHOOK_URL`) remain supported alternatives; Discord wins when
multiple are configured.

The **watchdog** (`deploy/options-arb-watchdog.sh` + `.cron`) checks the
health endpoint every 5 min: unreachable → restart + alert; degraded (the
server rollup in `/api/health` `status`/`reasons`: venue not ok, cycle stale,
realtime stream not live >2 min, frozen market file) → alert, and if still
degraded on the next run → one restart per episode; recovery → alert. Only on
state change, so no spam. Install on the box:

```bash
install -m 755 /opt/options-arb/deploy/options-arb-watchdog.sh /usr/local/bin/
cp /opt/options-arb/deploy/options-arb-watchdog.cron /etc/cron.d/options-arb-watchdog
```

### Daily live handchecks + alert test

`npm run alert:test -w server` sends one labelled test message through every
configured transport and prints each outcome — run it once after setting up
alerts (or after changing `.env`):

```bash
cd /opt/options-arb/server && npm run alert:test
```

The **handcheck cron** (`deploy/options-arb-handcheck.sh` + `.cron`) re-runs
`handcheck.ts` (one Olive × Derive signal) and `handcheck-books.ts` (one
book-venue pair) daily at 06:30 UTC against fresh venue data. A check that
fails all 3 attempts (a minute apart — quote drift can fail one) alerts via
the same transports; "nothing to check right now" is logged, not alerted.
Log: `/var/log/options-arb-handcheck.log`. Install on the box:

```bash
install -m 755 /opt/options-arb/deploy/options-arb-handcheck.sh /usr/local/bin/
cp /opt/options-arb/deploy/options-arb-handcheck.cron /etc/cron.d/options-arb-handcheck
```

### Auto-deploy loop (phone-driven)

```
issue (phone) → agent PR → CI tests → your review → merge to main
   → CI publishes `deploy` branch (main + built web/dist)
   → VPS cron pulls every minute, npm ci --omit=dev, systemctl restart
   → dashboard updated; watch with `journalctl -t options-arb`
```

One-time install on the box (after it's a git checkout of `deploy`):

```bash
install -m 755 /opt/options-arb/deploy/options-arb-update.sh /usr/local/bin/
cp /opt/options-arb/deploy/options-arb.cron /etc/cron.d/options-arb
```

`bash deploy/deploy.sh root@<host>` from a workstation remains the manual
override path (same content, immediate). The box's `server/.env` and
`server/data/` survive every update path.

## Notes

- `HOST=0.0.0.0` is set by `setup.sh` (from the local `127.0.0.1`) so the
  dashboard is reachable remotely; pair it with the firewall advice above.
- Node ≥22 is required (built-in `node:sqlite`).
- The `.env` contains no secrets — only public market config and fallback
  rate pins.
- Co-hosting: the app takes port 8799 (change via `PORT`), ~1 GB RAM and
  ~2 GB disk on top of your other app; if a reverse proxy fronts the box,
  point a subdomain at `127.0.0.1:8799` (WS at `/ws` needs the usual
  Upgrade headers — snippet in the repo history/README).
