# Airchive — BSV blockchain aircraft telemetry platform

Airchive ingests multi-source ADS-B telemetry, normalises it into a canonical record model, and drives phase detection, adaptive on-chain write rates, and operator-facing dashboards backed by Redis, PostgreSQL, and BSV infrastructure.

The goal is an auditable, immutable trail of flight activity suitable for safety analytics, insurers, and fleet operations — without naive "one transaction per second per aircraft" economics.

## Architecture overview

```
  ADS-B Sources                    BSV Blockchain
  ┌──────────┐                     ┌──────────────┐
  │ adsb.fi  │─┐                   │ TAAL ARC     │
  │ OpenSky  │─┤                   │ Whatsonchain  │
  │ RTL-SDR  │─┘                   └──────┬───────┘
       │                                  │
       ▼                                  ▲
  ┌──────────┐    Redis PubSub    ┌───────┴───────┐
  │Ingestion │──────────────────▶│Blockchain     │
  │ + Phase  │                    │Writer + Refill│
  │  Engine  │                    └───────────────┘
  └────┬─────┘                           │
       │ telemetry:{ICAO}                │ write:{ICAO}
       ▼                                 │
  ┌──────────┐    WebSocket       ┌──────┴────────┐
  │ Gateway  │◀──────────────────│Agent          │
  │ HTTP+WS  │                    │Marketplace    │
  └────┬─────┘                    │(3 AI agents)  │
       │                          └───────────────┘
       ▼
  ┌──────────┐
  │Dashboard │  Next.js + Cesium globe
  │(Operator)│  Fleet grid, alerts, blockchain feed,
  └──────────┘  agent marketplace panel
```

**Ingestion** polls adsb.fi, OpenSky, and optional RTL-SDR endpoints, merges and deduplicates into `TelemetryRecord` shapes, and publishes to Redis `telemetry:{ICAO}` channels. A **phase engine** subscribes to those channels, runs the flight-phase state machine and adaptive write-rate controller, emits `write:{ICAO}` for the blockchain writer, and broadcasts enriched payloads for real-time consumers.

**Gateway** exposes HTTP APIs and WebSockets for the **dashboard** (globe, fleet grid, alerts, blockchain feed, agent marketplace). **Blockchain writer** consumes `write:{ICAO}` events, builds OP_RETURN transactions with encoded telemetry, and broadcasts via TAAL ARC. An **activity-aware auto-refill** monitor tops up aircraft wallets only when they are actively flying — idle aircraft are skipped to conserve funding.

**Agent Marketplace** runs three autonomous AI agents that discover each other via BRC-100 identity, exchange data products via MessageBox P2P, and settle micropayments on-chain:

| Agent | Role | Spend pattern |
|-------|------|---------------|
| **Collector** | Aggregates live telemetry from Redis and historical data from PostgreSQL; sells data products to other agents | Earns sats from data sales |
| **Analyst** | Purchases fleet snapshots from Collector, runs anomaly detection and fleet statistics, inscribes analysis summaries on-chain | 5 sats/cycle (fleet_snapshot) + inscription fees |
| **Monitor** | Round-robin queries live telemetry per aircraft from Collector; periodic monitoring inscriptions | 1 sat/query + inscription fees every 100 cycles |

## Quick start

From the repository root:

```bash
cp .env.example .env
# Edit .env — at minimum: database, Redis, wallet seed, funding WIF, tracked aircraft.
# Or enable DEMO_MODE=true for ingestion without live ADS-B feeds.

pnpm install
pnpm run build
docker compose up -d   # Postgres + Redis (or run them natively)
pnpm run db:migrate
```

Start all services (separate terminals or use a process manager):

```bash
pnpm --filter @airchive/ingestion dev
pnpm --filter @airchive/gateway dev
pnpm --filter @airchive/blockchain-writer dev
pnpm --filter @airchive/agent-marketplace dev
pnpm --filter @airchive/dashboard dev
```

- Dashboard: `http://localhost:3000`
- Demo / pitch landing: `http://localhost:3000/demo`
- Gateway API: `http://localhost:4000`
- Prometheus metrics: Ingestion `:9090`, Blockchain Writer `:9091`, Agent Marketplace `:9093`

## Tech stack

- **Runtime:** Node.js 22+, TypeScript, pnpm workspaces
- **Data:** PostgreSQL 16, Redis 7
- **Web:** Next.js 15, React 19, Tailwind CSS, Framer Motion, Cesium (globe)
- **Chain:** BSV mainnet (TAAL ARC, Whatsonchain, `@bsv/sdk`, `@bsv/simple`)
- **Agent infra:** `@bsv/simple` ServerWallet, BRC-100 Identity Registry, MessageBox P2P
- **Ops:** Docker Compose, Prometheus metrics, Cloudflare Tunnel (optional)

## Project structure

| Path | Purpose |
|------|---------|
| `packages/types` | Shared TypeScript interfaces (`TelemetryRecord`, `FlightEventRecord`, etc.) |
| `packages/logger` | Structured pino logger factory |
| `packages/db` | Knex.js database client + migrations |
| `packages/crypto` | `WalletVault` — BIP44 HD key derivation for aircraft wallets |
| `packages/airports` | Airport lookup data |
| `packages/flight-phase` | Flight phase state machine + adaptive write-rate controller |
| `packages/telemetry-codec` | Binary encoder/decoder for on-chain telemetry payloads |
| `services/ingestion` | ADS-B ingest (adsb.fi, OpenSky, RTL-SDR), demo replay, phase engine |
| `services/gateway` | HTTP REST API + WebSocket hub |
| `services/blockchain-writer` | On-chain writes from Redis `write:*`, UTXO management, activity-aware auto-refill |
| `services/agent-marketplace` | Three autonomous AI agents (Collector, Analyst, Monitor) with BSV micropayments |
| `services/overlay-node` | BSV overlay network node |
| `services/alert-engine` | Configurable alerting (email/SMS via SendGrid/Twilio) |
| `dashboard` | Next.js operator UI — globe, fleet grid, blockchain feed, agent marketplace panel |
| `k8s`, `nginx` | Kubernetes manifests and reverse-proxy examples |

## Wallet architecture

### Aircraft wallets (HD-derived)

Each tracked aircraft gets a deterministic P2PKH wallet derived from the master seed via BIP44 path `m/44'/236'/0'/0/{index}`. The **funding wallet** (`FUNDING_WALLET_WIF`) distributes satoshis to aircraft wallets as needed.

### Activity-aware auto-refill

The auto-refill monitor runs every 5 minutes and checks each aircraft wallet balance against `REFILL_THRESHOLD_SATS`. However, it only refills wallets for **actively flying** aircraft — those that have had write channel activity within `REFILL_IDLE_WINDOW_MS` (default 30 minutes). This prevents idle aircraft from accumulating unnecessary funds.

- **Initial bootstrap** (`force=true`): All aircraft below threshold are refilled regardless of activity.
- **Subsequent cycles**: Only active aircraft are refilled; idle ones are skipped with a debug log.

### Agent wallets (`@bsv/simple` ServerWallet)

The three marketplace agents each have their own `@bsv/simple` ServerWallet, separate from the HD aircraft wallets. These require independent funding. Set the `*_AGENT_KEY` env vars to persist stable keys across restarts; addresses are logged at startup.

## Environment variables

Authoritative list and descriptions: **`.env.example`** at the repository root. Key sections:

- **PostgreSQL / Redis** — database and message bus
- **BSV Blockchain** — ARC URL, API key, Whatsonchain
- **Wallet Vault** — HD master seed, funding WIF
- **Auto-refill** — threshold, amount, idle window
- **Data Sources** — adsb.fi, OpenSky, RTL-SDR
- **Ingestion** — poll interval, tracked aircraft, demo mode
- **Gateway** — ports, JWT, CORS
- **Agent Marketplace** — agent keys, intervals, storage URL
- **Dashboard** — public URLs, Cesium token

## Development

Prerequisites: Node >= 22, pnpm >= 9, Docker (optional but recommended for Postgres/Redis).

```bash
pnpm install
pnpm run build          # all packages and services
pnpm run dev            # parallel dev scripts (per package)
```

Database migrations:

```bash
pnpm run db:migrate
```

**Ingestion (live feeds):** set `TRACKED_AIRCRAFT` to a comma-separated ICAO list and ensure Redis/Postgres are reachable.

**Ingestion (demo replay):** set `DEMO_MODE=true`. ICAO addresses are taken from the demo JSON plus any `TRACKED_AIRCRAFT` entries. Optional: `DEMO_REPLAY_PATH`, `DEMO_SPEED_MULTIPLIER`.

**Dashboard:** `pnpm --filter @airchive/dashboard dev` — requires `NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_WS_URL`.

> **Note:** `next build` with `output: "standalone"` may require symlink privileges on Windows (Developer Mode or elevated rights). Linux/macOS and CI/Docker builds are unaffected.

## Licence

**UNLICENSED / proprietary.** All rights reserved unless otherwise agreed in writing.
