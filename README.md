# Airchive — BSV Blockchain Aircraft Telemetry Platform

> **BSV Hackathon (April) 2026 Submission** — Chronicle-era on-chain aviation data

Airchive ingests multi-source ADS-B telemetry, normalises it into a canonical record model, and drives phase detection, adaptive on-chain write rates, and operator-facing dashboards backed by Redis, PostgreSQL, and BSV infrastructure.

The goal is an auditable, immutable trail of flight activity suitable for safety analytics, insurers, and fleet operations — without naive "one transaction per second per aircraft" economics.

## Solo Dev

| Name | Role |
|------|------|
| @BSVCasey | Lead Developer |

## Architecture overview

```
  ADS-B Sources                    BSV Blockchain (Chronicle)
  ┌──────────┐                     ┌──────────────┐
  │ adsb.fi  │─┐                   │ TAAL ARC     │
  │ OpenSky  │─┤                   │ Whatsonchain  │
  │ RTL-SDR  │─┘                   └──────┬───────┘
       │                                  │
       ▼                                  ▲
  ┌──────────┐    Redis PubSub    ┌───────┴───────┐
  │Ingestion │──────────────────▶│Blockchain     │
  │ + Phase  │                    │Writer + Refill│
  │  Engine  │                    └───────┬───────┘
  └────┬─────┘                           │ OP_RETURN txs
       │ telemetry:{ICAO}                ▼
       ▼                         ┌───────────────┐
  ┌──────────┐    WebSocket       │ Overlay Node  │
  │ Gateway  │◀────────────────── │ tm_airchive   │
  │ HTTP+WS  │                    │ Lookup API    │
  └────┬─────┘                    └───────────────┘
       │                          ┌───────────────┐
       │                          │Agent          │
       │                          │Marketplace    │
       │                          │(3 AI agents)  │
       │                          └───────────────┘
       ▼
  ┌──────────┐
  │Dashboard │  Next.js + CesiumJS globe
  │(Operator)│  Fleet grid, blockchain feed, explorer,
  └──────────┘  alerts, agent marketplace panel
```

**Ingestion** polls adsb.fi, OpenSky, and optional RTL-SDR endpoints, merges and deduplicates into `TelemetryRecord` shapes, and publishes to Redis `telemetry:{ICAO}` channels. A **phase engine** subscribes to those channels, runs the flight-phase state machine and adaptive write-rate controller, emits `write:{ICAO}` for the blockchain writer, and broadcasts enriched payloads for real-time consumers.

**Gateway** exposes HTTP APIs and WebSockets for the **dashboard** (globe, fleet grid, alerts, blockchain feed, agent marketplace). **Blockchain writer** consumes `write:{ICAO}` events, builds OP_RETURN transactions with encoded telemetry, and broadcasts via TAAL ARC. Each aircraft has its own independently funded wallet — **on-chain broadcasts only occur during active flight periods** (TAXI through LANDING phases). Parked aircraft write at most every 2 minutes, conserving both bandwidth and funds. An **activity-aware auto-refill** monitor tops up wallets only for actively flying aircraft, while the retry buffer now coalesces superseded telemetry writes per aircraft and treats orphan-mempool responses as bounded backpressure rather than destructive wallet churn.

**Overlay Node** runs a custom BSV overlay node (`services/overlay-node`) with an `AirchiveTopicManager` (`tm_airchive`) that indexes transactions by filtering for the `AIRCHIVE` protocol prefix in OP_RETURN outputs. It exposes a REST + WebSocket API for querying telemetry records by ICAO, transaction ID, time range, or flight session — providing a self-hosted, BSV-native lookup layer independent of third-party explorers.

**Agent Marketplace** runs three autonomous AI agents that discover each other via BRC-100 identity, exchange data products via MessageBox P2P, and settle micropayments on-chain:

| Agent | Role | Spend pattern |
|-------|------|---------------|
| **Collector** | Aggregates live telemetry from Redis and historical data from PostgreSQL; sells data products to other agents | Earns sats from data sales |
| **Analyst** | Purchases fleet snapshots from Collector, runs anomaly detection and fleet statistics, inscribes analysis summaries on-chain | 5 sats/cycle (fleet_snapshot) + inscription fees |
| **Monitor** | Round-robin queries live telemetry per aircraft from Collector; periodic monitoring inscriptions | 1 sat/query + inscription fees every 100 cycles |

## Dashboard

The operator dashboard ([https://airchive.vercel.app](https://airchive.vercel.app)) is a real-time Next.js 15 application with the following views:

| View | Description |
|------|-------------|
| **3D Globe** | CesiumJS globe with live aircraft positions, trails, labels, and custom aircraft billboards updated via WebSocket |
| **Fleet Status Grid** | Card-per-aircraft showing ICAO, callsign, altitude, speed, heading, flight phase, and live on-chain write activity, with `All`, `Live`, and `Offline` filters |
| **Selected Aircraft Panel** | Deep-dive into a single aircraft: telemetry readouts, altitude/speed charts, flight timeline, and a "View Wallet On-Chain" button linking to WhatsonChain |
| **Blockchain Feed** | Fixed-height, scroll-free live viewer of the newest OP_RETURN transactions, with Chronicle badge, phase, size, fee, and timestamp |
| **Analytics** | Daily transaction counts, bytes on chain, BSV cost, tracked aircraft, rolling `TX/s`, and pending/mined/failed status counts |
| **Alerts Panel** | Configurable rule-based alerts (squawk codes, altitude deviations, phase anomalies) with acknowledgement |
| **Emergency Overlay** | Full-screen overlay triggered by squawk 7700/7600/7500 — forces maximum 1s write rate |
| **Agent Marketplace** | Live view of the three AI agents — messages, on-chain inscriptions, micropayment flows |
| **Flight History** | Paginated completed flight log with origin/destination, duration, phase breakdown, and linked transactions |
| **Aircraft Explorer** | Per-aircraft transaction history with decoded payload, block height, Merkle path, and flight session context |
| **Wallet List** | All 239 configured aircraft wallets with BIP44 index and WhatsonChain links, generated automatically from the configured fleet |
| **Pitch / Cost Calculator** (`/demo`) | Interactive chain-write economics calculator — compare naive 1 tx/s vs Airchive's adaptive rate, adjust fleet size and flight hours, view phase-by-phase write rate breakdown |

## BSV Chronicle Integration

Airchive is built for the **Chronicle era** of BSV (activated 7 April 2026, block 943,816). All telemetry transactions are broadcast with **`tx.version = 2`**, opting into the Chronicle ruleset.

### What Chronicle enables

The Chronicle upgrade restores original Bitcoin protocol features:

- **Restored opcodes:** `OP_SUBSTR` (0xb3), `OP_LEFT` (0xb4), `OP_RIGHT` (0xb5) for in-script string manipulation; `OP_2MUL`, `OP_2DIV`, `OP_LSHIFTNUM`, `OP_RSHIFTNUM` for arithmetic; `OP_VER`, `OP_VERIF`, `OP_VERNOTIF` for version-gated logic.
- **Original Transaction Digest Algorithm (OTDA):** Opt-in via the `CHRONICLE` [0x20] sighash flag, restoring the original Bitcoin transaction digest.
- **Relaxed malleability restrictions** for `tx.version > 1`: Minimal encoding, Low-S, NULLFAIL/NULLDUMMY, MINIMALIF, Clean Stack, and data-only unlocking script requirements are all removed.
- **Functional opcodes in unlocking scripts:** Allowed for `tx.version > 1`.
- **32 MB script number limit:** Increased from 750 KB.

### How Airchive uses Chronicle

- **Transaction version 2:** Every telemetry transaction uses `tx.version = 2`, signalling Chronicle-era compliance and opting into the relaxed ruleset.
- **Chronicle-validated badge:** The dashboard displays a "Chronicle" badge on transactions that were broadcast under Chronicle rules, providing visual confirmation of the protocol version.
- **Future-ready architecture:** The transaction pipeline is designed to adopt Chronicle opcodes (e.g. `OP_SUBSTR` for in-script ICAO extraction, `OP_VER` for version-gated validation) as the ecosystem tooling matures.

### On-chain telemetry payload format

Every OP_RETURN output contains a structured binary payload:

| Offset | Length | Field | Description |
|--------|--------|-------|-------------|
| 0 | 8 | Protocol ID | `"AIRCHIVE"` (ASCII) |
| 8 | 1 | Version | `0x01` |
| 9 | 3 | ICAO | Aircraft address (packed hex) |
| 12 | 8 | Timestamp | Epoch milliseconds (LE uint64) |
| 20 | 1 | Record type | `0x01` telemetry, `0x02` flight event, `0x03` telemetry delta |
| 21+ | variable | Payload | MessagePack-encoded telemetry data |

## On-chain verifiability

Every aircraft wallet is deterministically derived and publicly verifiable:

- **Derivation path:** `m/44'/236'/0'/0/{index}` (BIP44, coin type 236 for BSV)
- **Wallet list API:** `GET /api/wallets` returns all aircraft wallet addresses with WhatsonChain links
- **Per-aircraft explorer:** The dashboard's "View Wallet On-Chain" button links directly to WhatsonChain for each aircraft
- **Transaction format:** All telemetry is encoded in OP_RETURN outputs with the `AIRCHIVE` protocol prefix, making transactions machine-parseable by any third party

To verify any aircraft's on-chain activity, query the wallet list endpoint and follow the WhatsonChain links to inspect the raw transactions.

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
pnpm --filter @airchive/overlay-node dev
pnpm --filter @airchive/dashboard dev
```

### Live deployment

- **Dashboard:** [https://airchive.vercel.app](https://airchive.vercel.app)
- **Pitch / cost calculator:** [https://airchive.vercel.app/demo](https://airchive.vercel.app/demo)
- **Wallet list:** [https://airchive.vercel.app/wallets](https://airchive.vercel.app/wallets)

### Local development URLs

- Dashboard: `http://localhost:3000`
- Gateway API: `http://localhost:4000`
- Overlay Node REST API: `http://localhost:4010`
- Prometheus metrics: Ingestion `:9090`, Blockchain Writer `:9091`, Agent Marketplace `:9093`

### Deployment architecture

The **dashboard** is deployed to Vercel (Next.js). All backend services (ingestion, gateway, blockchain-writer, agent-marketplace) run locally and are exposed to the Vercel frontend via a **Cloudflare Tunnel**, providing a secure HTTPS bridge without port forwarding or static IPs. The gateway WebSocket and REST endpoints are tunnelled so the Vercel-hosted dashboard can communicate with the local backend in real time.

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
| `services/overlay-node` | BSV overlay node — `tm_airchive` topic manager, `AirchiveLookupService`, REST + WebSocket API |
| `services/alert-engine` | Configurable alerting (email/SMS via SendGrid/Twilio) |
| `dashboard` | Next.js operator UI — globe, fleet grid, blockchain feed, agent marketplace panel |
| `k8s`, `nginx` | Kubernetes manifests and reverse-proxy examples |

## Wallet architecture

### Aircraft wallets (HD-derived)

The system currently tracks **239 aircraft** in `aircraft_config`, each with its own deterministic P2PKH wallet derived from the master seed via BIP44 path `m/44'/236'/0'/0/{index}`. Total active wallets: **239 aircraft + 3 agent wallets + 1 treasury/funding wallet = 243 wallets**.

| Wallet | Count | Purpose |
|--------|-------|---------|
| Aircraft (HD-derived) | 239 | One per tracked ICAO — holds UTXOs for telemetry broadcasts |
| Agent (ServerWallet) | 3 | Collector, Analyst, Monitor — micropayments and inscriptions |
| Treasury / Funding | 1 | Top-level wallet that distributes satoshis to aircraft wallets via activity-aware auto-refill (`FUNDING_WALLET_WIF`) |

The treasury wallet is a standard P2PKH wallet whose UTXOs are fetched directly from WhatsonChain at refill time — it is not managed in the UTXO pool database.

**On-chain broadcasts only occur during active flight periods.** Parked aircraft write at most every 2 minutes. Once an aircraft is airborne (TAXI onwards), write rates increase to 15s for taxiing, 1s for takeoff/climb/landing, 2s for descent/approach, and 3s for cruise. This means the blockchain is only written to when there is meaningful data to record.

### Activity-aware auto-refill

The auto-refill monitor runs every 5 minutes and checks each aircraft wallet balance against `REFILL_THRESHOLD_SATS`. It only refills wallets for **actively flying** aircraft — those that have had write channel activity within `REFILL_IDLE_WINDOW_MS` (default 30 minutes). Idle aircraft are skipped to conserve funding, refill broadcasts are serialised, and orphan-mempool dependency responses are backed off rather than treated as hard wallet failures.

- **Startup behaviour**: The writer performs an activity-aware check rather than blindly refilling the whole fleet on boot.
- **Subsequent cycles**: Only active aircraft are refilled; idle ones are skipped.
- **On-demand refill**: If a UTXO pool is exhausted mid-flight, a refill is requested immediately rather than waiting for the next 5-minute cycle.
- **Retry shaping**: Deferred telemetry writes are coalesced per aircraft so the queue keeps the latest state instead of every stale sample.

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

**Ingestion (live feeds):** set `TRACKED_AIRCRAFT` to a comma-separated ICAO list and ensure Redis/Postgres are reachable. Ingestion polls **adsb.fi** using your hex list (`GET /api/v2/hex/...`, batched by 20 ICAOs per request), merges optional OpenSky/RTL-SDR, then publishes to Redis. It does **not** pull a worldwide aircraft dump and filter locally. The **WebSocket** (`/ws`) only forwards Redis messages to subscribed clients; it is unrelated to ADS-B ingestion. To build a long list from live traffic, run `node scripts/fetch-tracked-aircraft-from-opensky.mjs --max 200` (OpenSky snapshot; Qatar-first, then other long-haul callsigns).

**Ingestion (demo replay):** set `DEMO_MODE=true`. ICAO addresses are taken from the demo JSON plus any `TRACKED_AIRCRAFT` entries. Optional: `DEMO_REPLAY_PATH`, `DEMO_SPEED_MULTIPLIER`.

**Dashboard:** `pnpm --filter @airchive/dashboard dev` — requires `NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_WS_URL`.

> **Note:** `next build` with `output: "standalone"` may require symlink privileges on Windows (Developer Mode or elevated rights). Linux/macOS and CI/Docker builds are unaffected.

## Fleet Scale And Throughput Headroom

The current configured fleet database contains **239 aircraft**. Aircraft are not airborne 24 hours a day — commercial fleet utilisation averages **8–10 hours of active flight per aircraft per day** (short-haul fleets ~8h, long-haul ~12–16h). The maths below uses a conservative 9-hour average and the existing phase-weighted write profile.

| Parameter | Value |
|-----------|-------|
| Current configured aircraft | **239** |
| Avg active flight hours / aircraft / day | ~9 hours |
| Weighted-avg tx/s per aircraft (in-flight) | ~0.39 (phase-weighted) |
| Effective tx/s per aircraft over 24h | 0.39 × (9 / 24) ≈ 0.146 |
| Effective sustained throughput at 239 aircraft | **~34.9 tx/second** |
| Estimated daily volume at 239 aircraft | **~3.02 million transactions/day** |
| Headroom vs 1.5M/day target | **~2.0x** |

The adaptive write-rate controller adjusts per flight phase:

| Phase | Write interval | tx/s | Typical % of flight |
|-------|---------------|------|---------------------|
| TAKEOFF / LANDING | 1s | 1.00 | ~4% |
| CLIMB | 1s | 1.00 | ~8% |
| DESCENT / APPROACH | 2s | 0.50 | ~12% |
| CRUISE | 3s | 0.33 | ~70% |
| TAXI / TAXI_IN | 15s | 0.07 | ~6% |
| EMERGENCY | 1s | 1.00 | rare |
| PARKED | 120s | 0.008 | n/a (not in-flight) |

At the current fleet size, Airchive produces approximately **239 × 9 × 3,600 × 0.39 ≈ 3.02M transactions** within 24 hours under the same assumptions. That means the original **1.5M transactions/day** target can be met with substantial fleet headroom even after allowing for inactive tails, maintenance gaps, and uneven utilisation across carriers.

Each aircraft wallet is independently funded and manages its own UTXO chain, enabling fully parallel transaction construction with no contention.

**Cost estimate:** At the current fee rate of 110 sats/KB, a typical 738-byte aircraft telemetry transaction costs ~82 sats. 1.5M transactions therefore costs approximately 1.23 BSV (~£14.64 at £11.90/BSV). At the current **239-aircraft** scale and the same 9-hour utilisation assumption, ~3.02M transactions/day would cost roughly **2.48 BSV** (~**£29.51** at the same reference price). The activity-aware auto-refill system distributes funding automatically from the treasury wallet.

In recent local monitoring windows with the 239-aircraft database loaded, mixed live traffic typically produced single-digit to low double-digit live throughput bursts rather than the theoretical 24-hour ceiling. That is expected: only a subset of the configured fleet is active at any given moment, parked aircraft write far less often, and dependency-aware buffering deliberately favours correctness over aggressive child-spend chaining.

> The `/demo` route on the dashboard includes an interactive cost calculator where stakeholders can adjust fleet size and flight hours to model their own economics.

## Licence

**UNLICENSED / proprietary.** All rights reserved unless otherwise agreed in writing.
