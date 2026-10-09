# Deploying options-arb to a Hetzner VPS

Single Node process: the API server serves the built dashboard itself
(`web/dist`), so there is no second web server to run. SQLite lives in
`server/data/` (auto-pruned to 7 days, WAL bounded). No secrets are needed —
every data source is public/read-only.

## 1. Create the VPS (Hetzner Cloud console)

- **Type:** CX22 (2 vCPU / 4 GB / 40 GB) is comfortable; the app idles at a
  few % CPU and the DB plateaus well under 1 GB. CX21 works too.
- **Image:** Ubuntu 24.04
- **Location:** any (fsn1/nbg1/hel1) — EU egress to both venues is fine
- **SSH key:** add your key at creation time (or paste the deploy key from
  step 2 via the console's Rescue/SSH route)
- **Firewall:** strongly recommended — the app has **no authentication**
  (read-only market data, but it is your monitor). Either:
  - Hetzner Cloud Firewall: allow `22/tcp` and `8799/tcp` from **your IP**
    only, or
  - keep port 8799 closed and use an SSH tunnel from your machine:
    `ssh -N -L 8799:127.0.0.1:8799 root@<VPS_IP>` → open http://127.0.0.1:8799

## 2. Deploy key (from the workstation, once)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/options-arb-hetzner -N '' -C options-arb-deploy
```

Add the public key to the VPS (Hetzner console → your project → Security →
SSH keys, then recreate the server, or append it manually):

```bash
cat ~/.ssh/options-arb-hetzner.pub | ssh root@<VPS_IP> 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
```

Use it for every command below:

```bash
ssh -i ~/.ssh/options-arb-hetzner root@<VPS_IP> 'uname -a'
```

## 3. Ship the code and bootstrap (from the repo root)

The deploy excludes local runtime state (`server/data/`, node_modules) —
`git archive` only ships what's committed:

```bash
git archive --format=tar HEAD | ssh -i ~/.ssh/options-arb-hetzner root@<VPS_IP> \
  'mkdir -p /opt/options-arb && tar -x -C /opt/options-arb'

# one-time bootstrap (Node 22, service user, build, systemd)
ssh -i ~/.ssh/options-arb-hetzner root@<VPS_IP> 'bash /opt/options-arb/deploy/setup.sh'
```

The app starts under systemd (`Restart=always`, boots on reboot).

## 4. Verify

```bash
ssh -i ~/.ssh/options-arb-hetzner root@<VPS_IP> 'curl -s http://127.0.0.1:8799/api/health | head -c 300'
```

Then open `http://<VPS_IP>:8799/` (if the firewall allows it) or through the
SSH tunnel. First cycle takes ~30s to populate signals.

## Day-2 operations

| Task | Command (on the VPS, as root) |
|---|---|
| Logs (live) | `journalctl -u options-arb -f` |
| Restart | `systemctl restart options-arb` |
| Status | `systemctl status options-arb` |
| Update code | re-run step 3, then `systemctl restart options-arb` |
| DB location | `/opt/options-arb/server/data/options-arb.db` (7-day retention, auto-pruned) |

Updating = ship a fresh archive over `/opt/options-arb` and restart; the
`server/.env` and `server/data/` survive (re-running `setup.sh` is also safe
— it's idempotent and won't clobber an existing `.env`).

## Notes

- `HOST=0.0.0.0` is set by `setup.sh` (from the local `127.0.0.1`) so the
  dashboard is reachable remotely; pair it with the firewall advice above.
- Node ≥22 is required (built-in `node:sqlite`).
- The `.env` contains no secrets — only public market config and fallback
  rate pins.
