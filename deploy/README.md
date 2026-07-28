# Airchive VPS deployment

Runbook for moving Airchive off the developer machine and its ephemeral
Cloudflare quick tunnels onto a VPS with a stable domain, TLS, verified
backups and file-backed secrets.

Requirements: a 64-bit Linux host (Ubuntu 24.04 LTS assumed below) with at
least 4 vCPU, 8 GB RAM and 80 GB SSD, Docker Engine 25+ and Compose v2.24 or
newer. The `!override` merge syntax in `docker-compose.prod.yml` needs 2.24.

## 1. Host preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version   # must be >= 2.24
```

Only three ports are ever exposed. Everything else stays on the internal
compose network:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Harden SSH (`/etc/ssh/sshd_config`): `PasswordAuthentication no`,
`PermitRootLogin no`, then `sudo systemctl restart ssh`. Add
`unattended-upgrades` so security patches land without intervention.

## 2. Domain

Point an A record (and AAAA if the host has IPv6) at the VPS:

```
airchive.example.com.  A  203.0.113.10
```

This replaces the Cloudflare quick tunnels entirely. Once the domain resolves,
the dashboard, REST API and WebSocket are all same-origin behind nginx, which
is why `PUBLIC_ORIGIN` below is baked into the dashboard bundle at build time.

If the dashboard stays on Vercel instead, skip the `dashboard` service and set
`CORS_ORIGIN` in `.env` to the Vercel URL; the trade-off is that the browser
then talks cross-origin to `https://airchive.example.com/api`, so the gateway's
CORS and JWT settings become load-bearing rather than defence in depth.

## 3. Code and configuration

```bash
sudo install -d -o "$USER" -g "$USER" /opt/airchive
git clone <repository> /opt/airchive
cd /opt/airchive
cp .env.example .env
```

Edit `.env` with the non-sensitive settings, including:

```
PUBLIC_DOMAIN=airchive.example.com
PUBLIC_ORIGIN=https://airchive.example.com
PUBLIC_WS_ORIGIN=wss://airchive.example.com/ws
CORS_ORIGIN=https://airchive.example.com
POSTGRES_DB=airchive
POSTGRES_USER=airchive
BACKUP_PATH=/var/backups/airchive
BACKUP_RETENTION_DAYS=14
```

Set the deployment's real hostname in `nginx/nginx.conf` in place of
`server_name _;`, so a request arriving with an unknown `Host` is not served by
this vhost.

## 4. Secrets

Sensitive values move out of `.env` into root-only files that the containers
read through the `*_FILE` convention handled by `deploy/docker-entrypoint.sh`.

```bash
sudo install -d -m 0700 /etc/airchive/secrets
umask 077
printf '%s' 'REPLACE_ME' | sudo tee /etc/airchive/secrets/postgres_password   >/dev/null
printf '%s' 'REPLACE_ME' | sudo tee /etc/airchive/secrets/wallet_master_seed  >/dev/null
printf '%s' 'REPLACE_ME' | sudo tee /etc/airchive/secrets/funding_wallet_wif  >/dev/null
printf '%s' 'REPLACE_ME' | sudo tee /etc/airchive/secrets/taal_arc_api_key    >/dev/null
openssl rand -hex 32     | sudo tee /etc/airchive/secrets/jwt_secret          >/dev/null
sudo chmod 0400 /etc/airchive/secrets/*
```

**Delete `POSTGRES_PASSWORD`, `WALLET_MASTER_SEED`, `FUNDING_WALLET_WIF`,
`TAAL_ARC_API_KEY` and `JWT_SECRET` from `.env` afterwards.** Two sources for
one secret is how a rotation silently fails to take effect.

Losing `wallet_master_seed` means losing every aircraft wallet, and losing
`funding_wallet_wif` means losing the treasury. Back both up offline, encrypted,
somewhere that is not this VPS.

## 5. First certificate

nginx will not start without a certificate, and certbot's HTTP-01 challenge
needs something serving `/.well-known/acme-challenge/`. Issue the first one
with certbot's own standalone server while port 80 is free:

```bash
mkdir -p nginx/certs nginx/acme nginx/letsencrypt
sudo docker run --rm -p 80:80 \
  -v "$PWD/nginx/letsencrypt:/etc/letsencrypt" \
  -v "$PWD/nginx/acme:/var/www/certbot" \
  certbot/certbot certonly --standalone \
  -d airchive.example.com \
  --agree-tos -m ops@example.com --no-eff-email

sudo cp -L nginx/letsencrypt/live/airchive.example.com/fullchain.pem nginx/certs/
sudo cp -L nginx/letsencrypt/live/airchive.example.com/privkey.pem   nginx/certs/
sudo cp -L nginx/letsencrypt/live/airchive.example.com/chain.pem     nginx/certs/
sudo chmod 0644 nginx/certs/fullchain.pem nginx/certs/chain.pem
sudo chmod 0640 nginx/certs/privkey.pem
```

Renewals are then handled by the `certbot` service in the production overlay,
which uses the webroot challenge through the running nginx and copies the new
material back into `nginx/certs`.

## 6. Bring the stack up

```bash
cd /opt/airchive
sudo mkdir -p /var/backups/airchive
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Migrations need no separate step. The `migrate` service runs once against a
healthy Postgres and every service that touches the database is gated on it
exiting zero, so a fresh volume comes up with a complete schema and a failed
migration halts the rollout rather than leaving services to crash-loop against
missing tables. To see what it did:

```bash
docker compose logs migrate
```

Verify:

```bash
curl -fsS https://airchive.example.com/api/system/health | jq
curl -fsS https://airchive.example.com/api/system/funding | jq
```

`/api/system/funding` is the one to watch. It reports the persisted treasury
state (`HEALTHY`, `LOW`, `DRY`, `RECOVERING`), the balance, the estimated
runway in hours and how many writes are being held. A `stale: true` there means
the blockchain writer has stopped reporting, not that funding is fine.

## 7. Boot and renewal units

```bash
sudo cp deploy/systemd/airchive.service /etc/systemd/system/
sudo cp deploy/systemd/airchive-nginx-reload.service /etc/systemd/system/
sudo cp deploy/systemd/airchive-nginx-reload.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now airchive.service
sudo systemctl enable --now airchive-nginx-reload.timer
```

`restart: unless-stopped` on every container covers crashes; the unit covers
reboots. The timer exists because nginx reads certificates once at startup, so
a renewed certificate is not picked up until it is reloaded.

## 8. Backups

The `postgres-backup` service takes a verified `pg_dump --format=custom` on
`BACKUP_INTERVAL_SECONDS` (daily by default) into `BACKUP_PATH`, prunes dumps
older than `BACKUP_RETENTION_DAYS`, and — importantly — only prunes after a
dump that `pg_restore --list` could actually read.

Copy them off the host; a backup on the same disk as the database is not a
backup:

```bash
rsync -az --delete /var/backups/airchive/ backup-host:/srv/airchive-backups/
```

Restore, which deliberately requires an explicit confirmation:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  -e RESTORE_CONFIRM=yes \
  --entrypoint /usr/local/bin/pg-restore.sh postgres-backup \
  /backups/airchive-20260422T000000Z.dump
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart \
  blockchain-writer gateway overlay-node alert-engine agent-marketplace
```

Test a restore into a scratch database at least once. An untested backup is a
hypothesis.

## 9. Operations

Logs are capped at 10 MB × 5 files per container by the json-file driver, so
they cannot fill the disk:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f blockchain-writer
```

Prometheus metrics are exposed inside the network only — the writer on
`:9091`, ingestion on `:9090`, agent-marketplace on `:9093`. Scrape them from a
collector attached to the `airchive` network rather than publishing the ports.
The ones worth alerting on:

| Metric | Meaning |
| --- | --- |
| `airchive_funding_state` | 0 healthy, 1 low, 2 dry, 3 recovering |
| `airchive_funding_runway_hours` | Treasury runway at the observed burn rate |
| `airchive_treasury_dry` | 1 when the last refill could not be funded |
| `airchive_aircraft_dry_count` | Aircraft with no spendable UTXOs |
| `airchive_pending_writes` | Held telemetry awaiting broadcast |
| `airchive_arcade_sse_connected` | 0 means transaction status is blind |
| `airchive_spv_verifications_total` | Merkle proof outcomes by result |

Deploying a change:

```bash
cd /opt/airchive && git pull
sudo systemctl reload airchive.service   # runs `up -d --build`
```

## 10. When the treasury runs dry

No intervention beyond funding is required. The writer persists the funding
state in Postgres, so it survives restarts of any length:

1. On entering `DRY` it stops the retry churn, raises a `CRITICAL` alert
   through the alert engine (SendGrid/Twilio/webhook, whichever is configured)
   and shows a banner on the dashboard.
2. Held writes in `pending_writes` are preserved rather than aged out — the
   retry-exhaustion purge is skipped entirely while funding is unhealthy.
3. It polls the funding address on a backoff that widens to
   `FUNDING_DRY_POLL_MAX_MS` (10 minutes by default) and keeps polling
   indefinitely.
4. When funds arrive it reconciles the pool, splits to
   `FUNDING_POOL_SPLIT_TARGET`, refills active aircraft first, then drains the
   backlog `FUNDING_RECOVERY_DRAIN_BATCH` writes at a time so recovery does not
   stampede the broadcaster.

To recover, send BSV to the funding wallet address and wait. Watch it happen:

```bash
watch -n 30 'curl -fsS https://airchive.example.com/api/system/funding | jq .data'
```
