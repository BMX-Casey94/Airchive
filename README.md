# Airchive — BSV Blockchain Aircraft Telemetry Platform

Airchive ingests multi-source ADS-B telemetry, normalises it into a canonical record model, and drives phase detection, adaptive on-chain write rates, and operator-facing dashboards backed by Redis, PostgreSQL, and BSV infrastructure.

The goal is an auditable, append-only trail of flight activity suitable for safety analytics, insurers, and fleet operations. Airborne aircraft are archived at the full 1 Hz rate ADS-B broadcasts at — sampling faster would only duplicate records — while cadence drops on the ground and duplicate suppression removes samples carrying no new information. Every mined record is verified by SPV against a locally held, proof-of-work-checked block header rather than an explorer's say-so. Transactions are broadcast under the **Chronicle** era of BSV (`tx.version = 2`).

## Author

| Name | Role |
|------|------|
| @BSVCasey | Lead Developer |

## Architecture overview

```
  ADS-B Sources                    BSV Blockchain (Chronicle)
  ┌──────────┐                     ┌──────────────┐
  │ adsb.fi  │─┐                   │ Arcade       │
  │ OpenSky  │─┤                   │ (ARC fallbk) │
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
  │Dashboard │  Next.js + CesiumJS globe + AE polar map
  │(Operator)│  Fleet grid, blockchain feed, explorer,
  └──────────┘  alerts, agent marketplace panel
```

**Ingestion** polls adsb.fi, OpenSky, and optional RTL-SDR endpoints, merges and deduplicates into `TelemetryRecord` shapes, and publishes to Redis `telemetry:{ICAO}` channels. A **phase engine** subscribes to those channels, runs the flight-phase state machine and adaptive write-rate controller, emits `write:{ICAO}` for the blockchain writer, and broadcasts enriched payloads for real-time consumers. Write rates are configurable per phase via environment variables (`WRITE_RATE_*_MS`).

**Gateway** exposes HTTP APIs and WebSockets for the **dashboard** (globe, AE polar map, fleet grid, alerts, blockchain feed, agent marketplace), including live session paths via `/api/sessions/active`. **Blockchain writer** consumes `write:{ICAO}` events, builds OP_RETURN transactions with encoded telemetry, and broadcasts through **Arcade** — a Teranode-native, Arc-compatible endpoint — with TAAL ARC as fallback. Transactions are coalesced into Extended Format batches and status arrives over Arcade's SSE stream rather than inbound callbacks, so no public ingress is required. A **bounded-concurrency broadcaster** applies priority queuing, transient retry with exponential backoff, and a circuit breaker to prevent cascade failures. Each aircraft has its own independently funded wallet, and an **activity-aware auto-refill** monitor tops up wallets only for actively flying aircraft. The retry buffer coalesces superseded telemetry writes per aircraft during ordinary backpressure, preserves the full stream while the treasury is dry, and change is only spent once Arcade confirms the parent is genuinely on the network.

**Overlay Node** runs a custom BSV overlay node (`services/overlay-node`) with an `AirchiveTopicManager` (`tm_airchive`) that indexes transactions by filtering for the `AIRCHIVE` protocol prefix in OP_RETURN outputs. It exposes a REST + WebSocket API for querying telemetry records by ICAO, transaction ID, time range, or flight session — providing a self-hosted, BSV-native lookup layer independent of third-party explorers.

**Agent Marketplace** runs three autonomous AI agents that discover each other via BRC-100 identity, exchange data products via MessageBox P2P, and settle micropayments on-chain:

| Agent | Role | Spend pattern |
|-------|------|---------------|
| **Collector** | Aggregates live telemetry from Redis and historical data from PostgreSQL; sells data products to other agents | Earns sats from data sales |
| **Analyst** | Purchases fleet snapshots from Collector, runs anomaly detection and fleet statistics, inscribes analysis summaries on-chain | 5 sats/cycle (fleet_snapshot) + inscription fees |
| **Monitor** | Round-robin queries live telemetry per aircraft from Collector; inscribes a coverage record once each full fleet sweep completes | 1 sat/query + inscription fees per sweep |

Agent records carry an explicit `windowStart` and `windowEnd` rather than a
single instant, because a sweep describes an interval and batched transactions
are mined out of order — arrival time is not a safe proxy for when the data was
observed. The Analyst inscribes full anomaly objects and stale-aircraft detail,
not a bare count, so the on-chain record stands alone as evidence.

## Dashboard

The operator dashboard ([https://airchive.vercel.app](https://airchive.vercel.app)) is a real-time Next.js 15 application with the following views:

| View | Description |
|------|-------------|
| **3D Globe** | CesiumJS globe with live aircraft positions, trails, labels, and custom aircraft billboards updated via WebSocket. The homepage links onward to the AE polar map for a full-fleet disc view |
| **AE Polar Flight Map** (`/ae`) | Full-screen azimuthal equidistant world disc centred on the North Pole, every active flight drawn as a complete take-off-to-landing trail. A bespoke three.js/WebGL engine rather than a Cesium view — [see below](#ae-polar-flight-map-ae) |
| **Fleet Status Grid** | Card-per-aircraft showing ICAO, callsign, altitude, speed, heading, flight phase, and live on-chain write activity, with `All`, `Live`, and `Offline` filters |
| **Selected Aircraft Panel** | Deep-dive into a single aircraft: telemetry readouts, altitude/speed charts, flight timeline, and a "View Wallet On-Chain" button linking to WhatsonChain |
| **Blockchain Feed** | Fixed-height, scroll-free live viewer of the newest OP_RETURN transactions, with Chronicle badge, phase, size, fee, and timestamp |
| **Analytics** | Daily transaction counts, bytes on chain, BSV cost, tracked aircraft, rolling `TX/s`, and pending/mined/failed status counts |
| **Alerts Panel** | Configurable rule-based alerts (squawk codes, altitude deviations, phase anomalies) with acknowledgement |
| **Emergency Overlay** | Full-screen overlay triggered by squawk 7700/7600/7500 — forces maximum 1s write rate |
| **Agent Marketplace** | Live view of the three AI agents — messages, on-chain inscriptions, micropayment flows |
| **Flight History** | Paginated completed flight log with origin/destination, duration, phase breakdown, and linked transactions |
| **Aircraft Explorer** | Per-aircraft transaction history with decoded payload, block height, inclusion proof, and SPV verification state (verified / proof received / awaiting proof) |
| **Historical Data** | Per-aircraft view that reads past transactions back off the chain and decodes them into a columnar telemetry table |
| **Funding Status** | Treasury state (`HEALTHY`, `LOW`, `DRY`, `RECOVERING`), balance, estimated runway and retry backlog, with a banner when funding is unhealthy |
| **Wallet List** | All 253 configured aircraft wallets with BIP44 index and WhatsonChain links, generated automatically from the configured fleet |
| **Cost Calculator** (`/demo`) | Interactive chain-write economics calculator — model the cost of full-fidelity archival per aircraft and per flight hour, adjust fleet size and flight hours, view the phase-by-phase write rate breakdown |

## AE Polar Flight Map (`/ae`)

A second projection of the live fleet: an **azimuthal equidistant world disc**
centred on the North Pole, with every active flight drawn as a complete
take-off-to-landing trail. It exists because a globe can only ever show you
half the fleet at once — on a pole-centred AE disc, the transatlantic, polar
and trans-Siberian routes that dominate long-haul traffic are all visible
simultaneously, and the great-circle paths that look like arbitrary curves on
a Mercator map read as the direct routes they actually are.

Cesium renders an ellipsoid and cannot express this projection, so `/ae` is a
self-contained three.js scene under `dashboard/src/ae` — its own renderer,
shaders, projection maths and picking, sharing only the existing Zustand
stores and WebSocket feed.

### Projection: inverse-projected in the fragment shader

The conventional way to draw an unusual projection on the web is to pre-warp
raster tiles offline, which locks you to one resolution ladder and bakes
resampling blur into the imagery. This does the opposite. The disc is a single
circle mesh whose **fragment shader runs the inverse projection per pixel**:
disc XZ → colatitude and longitude → equirectangular UV → sample NASA's
unmodified equirectangular imagery.

There is no pre-warped raster and no tile pyramid, so the map is exact at
every zoom level and there is nothing to blur or seam. The disc radius (10
world units) spans a colatitude of π — pole at the centre, Antarctic rim at
the edge — which is the defining property of the projection: distance from the
centre is linearly proportional to true great-circle distance from the pole.

Two details matter more than they look:

- **Antimeridian derivatives.** The `u` coordinate jumps 0↔1 along the
  antimeridian ray. Left alone, the GPU sees an enormous UV derivative there,
  selects the smallest mip level and paints a visible seam from pole to rim.
  The screen-space derivatives are corrected across that discontinuity and the
  texture fetched with `textureGrad`.
- **Sphere normals, not disc normals.** The day/night terminator is shaded
  against the *sphere* normal reconstructed from lat/lon, because the disc is
  a projection of a sphere and its own flat normal carries no information. The
  subsolar point comes from a standard low-precision solar ephemeris including
  the equation of time, recomputed once a minute, so the terminator sits where
  it genuinely is rather than being decorative.

Vector linework (Natural Earth coastlines and borders, plus a 15° graticule)
is projected once on the CPU and drawn as native GL hairlines — one pixel wide
at any zoom. Every edge is **densified to 0.75° steps** before projection: a
straight chord between two lat/lon points is badly wrong on an AE disc, and
near the rim the distortion is extreme enough that undersampled coastlines cut
visibly across the map. Meridians are the exception; on a polar aspect they
are radial lines and straight by definition.

Two further pieces of projection-specific geometry:

- **Heading.** Local north at any point on a polar AE disc is the direction
  toward the disc centre, so an aircraft's on-screen yaw depends on its
  longitude as well as its ADS-B track.
- **Altitude.** Vertical exaggeration is deliberate. At true scale a cruising
  airliner sits about 7.5 miles above a disc whose radius represents roughly
  12,400 miles, which is invisible. Altitude is scaled to lift cruise a little
  clear of the surface — enough for relief, shallow enough that a climb-out
  does not render as a steep glowing ramp over the departure airport.

### Persisting full flight paths

The harder half of this feature was data, not graphics. Trails were previously
reconstructed client-side from whichever telemetry frames a browser happened
to witness, so a dashboard opened mid-flight showed a trail that began the
moment the page loaded, and a refresh threw away everything before it. A map
whose whole premise is showing complete routes needed the real path.

Migration `014_session_positions` adds a `session_positions` table — a
thinned, phase-aware position stream per flight session, keyed to
`flight_sessions` with cascade delete and indexed on `(flight_id, ts)`.
Timestamps are epoch milliseconds because the consumers are browsers merging
this stream with live WebSocket telemetry that already speaks epoch-ms.

A `SessionPositionRecorder` in the ingestion service buffers and samples the
stream. Sampling is **phase-aware**, mirroring the write-rate controller's
philosophy without touching the on-chain write path:

| Phase | Stored every |
|-------|--------------|
| TAKEOFF, APPROACH, LANDING | 2s |
| TAXI, CLIMB, DESCENT, TAXI_IN | 5s |
| CRUISE | 15s |
| PARKED | 60s |

Cruise is close to a straight line and needs very few points; turns and
altitude changes cluster around airports, so those phases sample densely.
Phase transitions force a point regardless of the interval, so the exact
take-off and landing coordinates are always in the stored path. Movement below
roughly 30 metres is treated as jitter and dropped, with a liveness point every
60 seconds so a parked aircraft still has a heartbeat. Points are batch-inserted
every 5 seconds or every 500 rows, and a failed flush requeues behind a
2,000-row ceiling so a database outage cannot grow memory without bound. A
complete flight typically lands under 1,000 rows.

A stored path is only as truthful as the session it belongs to, and sessions
used to be able to lie: the only close path was an observed `TAXI_IN → PARKED`
transition, so any flight that ended out of ADS-B coverage left its session
open forever. The next time that airframe appeared — days later, on a
different continent — the zombie was resumed, and the new flight inherited the
old flight's origin and path. The lifecycle is now defended at four points:

- **A sweeper** closes any open session whose last recorded position is more
  than six hours old, backdating `ended_at` to that last sign of life. It runs
  at ingestion start-up and every fifteen minutes.
- **A resumption guard** checks the activity gap before re-adopting an open
  session: up to three hours is tolerated mid-air (transoceanic coverage holes
  are real), thirty minutes on the ground. Beyond that, the session is expired
  — an unresolved origin is far better than a wrong one.
- **Close-before-open**: a new departure (`PARKED → TAXI`, or a take-off after
  a long silence) retires whatever session the airframe still holds, so one
  aircraft can never run two flights under one `flight_id`.
- **Mid-air pickups get their own session.** An aircraft first seen at cruise
  never fires a phase transition, so it previously got no session — and no
  recorded path — at all. First contact now creates an origin-less session, so
  the rest of the journey is recorded honestly.

Destinations also resolve earlier: once a flight is on APPROACH below 6,000 ft,
the nearest airport within 12 miles is written as the destination rather than
waiting for touchdown.

The gateway exposes `GET /api/sessions/active` (open sessions showing recent
life — a stored position in the last fifteen minutes — one per airframe, with
paths) and `GET /api/flights/:flightId/path` (any single flight, active or
completed), with three optimisations worth noting:

- **Thinning happens in SQL.** A window function decimates long paths with
  `row_number() % step`, always keeping the final point, so a long-haul path
  of several thousand rows is reduced in the database rather than shipped
  whole and discarded client-side. Callers may request 50–4,000 points; the
  default is 1,500.
- **Tuples, not objects.** Path points go over the wire as
  `[ts, lat, lon, alt_baro, gs, track]`, roughly halving the JSON payload
  compared with named fields repeated thousands of times.
- **A 2-second response cache** absorbs every open dashboard tab polling at
  once, which is invisible against paths that gain a point every few seconds.

The client fetches this on a 30-second SWR interval and feeds it into the
existing fleet store through the same timestamp-aware `hydrateTrails` used for
IndexedDB restores. Because that merge is ordered by timestamp and
deduplicating, the server baseline, the browser's own IndexedDB history and
live WebSocket telemetry all stitch into one continuous trail, and repeated
refreshes converge rather than accumulating duplicates.

### Scene composition

| Layer | Approach |
|-------|----------|
| **Trails** | Drawn twice — a wide additive glow underlay and a crisp core line, both screen-space-width fat lines (`LineSegments2`) so they stay legible at any zoom. Colour ramps from dim ember on the ground to bright gold at cruise. Coverage gaps render as breaks rather than chords slicing across the disc, and long segments are subdivided in lat/lon so they follow the projection's curvature near the rim |
| **Aircraft** | Procedurally generated low-poly airliners (extruded plan-view silhouette plus a vertical stabiliser), the only lit objects in the scene — everything else is unlit shaders |
| **Toroidal field** | A cage of poloidal loops through the pole, helically twisted with the swirl direction alternating per shell, plus 2,200 flowing particles and a soft axial beam through the pole |
| **Rim** | A single shader-driven glow: a gaussian cyan core at the disc boundary plus an outward halo that decays to exactly zero before the geometry ends, so the edge feathers into the void rather than terminating on a hard circle. The map surface itself dissolves across the last 1.4% of the radius underneath it |
| **Country labels** | 111 billboarded sprites over three zoom tiers, fading in per-label by camera distance so the disc is never cluttered at a given zoom |
| **Void** | A shader gradient with per-pixel dither — a dark gradient across a full screen bands visibly on 8-bit displays without it |

The bloom pass is the reason several of these are tuned the way they are.
Ordinary trails are deliberately capped *below* the bloom threshold so they
stay crisp, and only the selected flight's core is pushed into HDR (channel
values above 1) so exactly one trail halos. The toroidal field's particles
went through the same calibration — an early build's sizing formula produced a
single white bloom that washed out the entire scene.

The field's particles are advected **entirely in the vertex shader**: their
paths are baked into attributes and only a clock uniform changes per frame, so
2,200 animated particles cost no per-frame CPU work and upload no buffers.
Every loop begins and ends exactly at the pole, where the loop radius is zero,
which is what lets any amount of helical twist still close cleanly. Both ends
taper to nothing and the travelling pulses feather at the leading edge, so
nothing in the field terminates on a hard line.

### Interaction

- **Free exploration.** Orbit with zoom-to-cursor and panning, with the pivot
  clamped to the disc plane and inside the rim so the camera can dive toward
  any point on the map but never wander off into empty void.
- **Click to focus.** Selecting an aircraft glides the camera to frame it and
  drops a pulsing pin at its take-off point, while every other trail dims. The
  approach direction is preserved during the move — only the pivot and
  distance change — because rotating the world underneath someone to reach a
  target is disorienting. Grabbing the map cancels the animation instantly.
- **Flight dossier.** A side rail on desktop, a bottom sheet on phones. On
  mobile the sheet can be minimised to a slim title bar (callsign, phase, and
  expand/close) so the selected aircraft stays visible on the map; a brief
  bouncing chevron hints that the sheet scrolls when it first opens with
  overflow.
- **Map dim toggle.** Halves the imagery brightness so aircraft and trails
  dominate, animated in the shader and remembered in `localStorage`. It dims
  brightness rather than opacity deliberately: the disc has to stay opaque or
  the void gradient would show through the Earth's surface.
- **Touch.** Taps are allowed 14px of travel before counting as a drag, versus
  6px for a mouse. At the mouse threshold, ordinary finger jitter rejected most
  taps and selecting an aircraft on a phone was a lottery.
- **Degradation.** The intro camera move respects `prefers-reduced-motion`,
  rendering pauses when the tab is hidden, WebGL context loss offers a reload
  rather than a frozen canvas, and missing imagery falls back to vector-only
  rendering instead of an empty scene.

### Assets

`dashboard/scripts/fetch-ae-assets.mjs` runs on `predev` and `prebuild` and
fetches four files into `public/ae/`, all public domain or equivalent: NASA
Blue Marble Next Generation (day, 5400×2700), NASA Black Marble 2016 (night
lights), and Natural Earth 1:50m land and country TopoJSON. It skips anything
already present and warns rather than fails when offline, so a build without
network access still produces a working — if imagery-free — map.

## BSV Chronicle Compatibility

Airchive broadcasts telemetry transactions under the **Chronicle era** of BSV (activated 7 April 2026, block 943,816). All telemetry transactions use **`tx.version = 2`**, opting into the Chronicle ruleset.

### What this means in practice

- **Transaction version 2:** Every telemetry transaction sets `tx.version = 2`, which opts into the Chronicle ruleset on the network. Miners accept these transactions under the relaxed Chronicle rules (no minimal-encoding enforcement, no Clean Stack requirement, functional opcodes permitted in unlocking scripts).
- **Version badge:** The dashboard displays a **v2** badge on each transaction in the blockchain feed, confirming it was broadcast under Chronicle rules.
- **Standard P2PKH signing:** Inputs are signed with standard P2PKH (sig + pubkey). The signing does not currently use the Chronicle-specific OTDA sighash flag (`[0x20]`).
- **No restored opcodes used (yet):** The current transaction format does not use any of the opcodes Chronicle restores (`OP_SUBSTR`, `OP_LEFT`, `OP_RIGHT`, `OP_SPLIT`, `OP_LSHIFTNUM`, etc.). The OP_RETURN output is a standard data carrier with the `AIRCHIVE` protocol prefix.

### Chronicle roadmap

The transaction pipeline is structured to adopt Chronicle-native features as the ecosystem tooling matures:

- **On-chain payload validation** — a spendable output with a locking script that uses `OP_SPLIT`/`OP_SUBSTR` to extract and verify the `AIRCHIVE` protocol prefix, ICAO address, and record type directly in script. This would make telemetry records independently verifiable on-chain without external tooling.
- **Version-gated logic** — `OP_VER` to enforce that only Chronicle-era transactions can spend validated telemetry outputs.
- **OTDA sighash** — opt into the original transaction digest algorithm for signing, once `@bsv/sdk` exposes the `[0x20]` flag cleanly.

### On-chain telemetry payload format

Every OP_RETURN script is structured as `OP_FALSE OP_RETURN` followed by six individual data pushes:

| Push | Bytes | Field | Description |
|------|-------|-------|-------------|
| 1 | 8 | Protocol ID | `"AIRCHIVE"` (ASCII) |
| 2 | 1 | Version | `0x01` |
| 3 | 3 | ICAO | Aircraft address (packed hex) |
| 4 | 8 | Timestamp | Epoch milliseconds (LE uint64) |
| 5 | 1 | Record type | `0x01` telemetry, `0x02` flight event, `0x03` telemetry delta, `0x04` agent analysis, `0x05` agent monitor |
| 6 | variable | Payload | MessagePack-encoded telemetry data |

Agent inscriptions share this envelope rather than using a separate format, so a
single parser reads both telemetry and agent records off the chain.

## On-chain verifiability

Every aircraft wallet is deterministically derived and publicly verifiable:

- **Derivation path:** `m/44'/236'/0'/0/{index}` (BIP44, coin type 236 for BSV)
- **Wallet list API:** `GET /api/wallets` returns all aircraft wallet addresses with WhatsonChain links
- **Per-aircraft explorer:** The dashboard's "View Wallet On-Chain" button links directly to WhatsonChain for each aircraft
- **Transaction format:** All telemetry is encoded in OP_RETURN outputs with the `AIRCHIVE` protocol prefix, making transactions machine-parseable by any third party

To verify any aircraft's on-chain activity, query the wallet list endpoint and follow the WhatsonChain links to inspect the raw transactions.

### SPV verification

A transaction is only marked `MINED` once its inclusion proof has been
recomputed to a Merkle root matching a block header held locally — and every
stored header has had its own proof of work checked before being trusted. No
explorer's assertion that something is confirmed is taken at face value.

- **Header chain:** headers are fetched, proof-of-work validated (the hash must
  meet its own difficulty target) and stored in `block_headers`. A differing
  hash at a known height is treated as a reorg, which deletes the header and
  returns affected transactions for re-verification.
- **Proofs:** BUMP proofs from Arcade and TSC proofs from WhatsOnChain are both
  accepted, and both are verified the same way. These services transport proof
  bytes; they are not trusted to vouch for them, because a forged proof cannot
  produce a root matching a locally held header.
- **Honest reporting:** proofs that fail verification are still stored, flagged
  unverified, and retried. The explorer distinguishes *verified*, *proof
  received but not yet verified*, and *awaiting proof* rather than collapsing
  all three into a single confident badge.
- **Metrics:** `airchive_spv_verifications_total` breaks outcomes down by
  result, counting a missing header separately from a genuine root mismatch —
  a lagging sync and an invalid proof are opposite diagnoses.

## Broadcast shaping and reliability

The blockchain writer includes several production-grade mechanisms to maintain sustained throughput under real-world network conditions:

- **Arcade batching** — submissions are coalesced into Extended Format batches over a short window (`ARCADE_BATCH_WINDOW_MS`, `ARCADE_MAX_BATCH_SIZE`), cutting per-transaction HTTP overhead at high fleet throughput
- **Bounded-concurrency broadcaster** — configurable parallel slots (`ARC_MAX_CONCURRENT_BROADCASTS`, default 4) with a priority queue that favours refills and flight events over routine telemetry
- **Transient retry with exponential backoff** — HTTP 500/502/503/504 errors are retried automatically (`ARC_TRANSIENT_RETRY_ATTEMPTS`, default 2) before deferring
- **Circuit breaker** — opens after repeated transient failures within a time window, pausing broadcasts briefly to prevent cascade overload
- **Seen-on-network gate** — change is only spent once Arcade confirms the parent transaction is genuinely on the network. An earlier build optimistically treated `SEEN_IN_ORPHAN_MEMPOOL` as success and spent change the network had never seen, which produced conflicting spends that silently killed an aircraft's whole chain
- **Rejection unwinding** — a terminally rejected transaction has its phantom outputs purged and the owning wallet reconciled against the chain, whether the rejection arrives over SSE or is found later by the confirmation poller. Skipping this is how one rejection becomes a permanently stuck chain
- **Conservative UTXO settlement** — an input is only returned to the pool if the network was never offered it. Once broadcast, it stays locked and the wallet reconciles against chain truth, because unlocking risks a second transaction spending it
- **Treasury reshaping** — the funding pool splits into spendable outputs sized above the refill floor, and consolidates automatically when fragmentation leaves it unable to fund a refill despite holding ample total value
- **WoC reconciliation deduplication** — funding wallet reconciliation against WhatsonChain is globally deduplicated with rate-limit awareness (30s cooldown, 120s after a 429)
- **Write coalescing** — the retry buffer keeps only the latest telemetry per aircraft, so a write deferred by a momentary broadcaster blip is replaced rather than replayed. This is suspended while the treasury is dry: a funding outage lasts until somebody sends coins, and collapsing there would destroy the archive it claims to be protecting, so the full stream is preserved instead (see below)

## Dashboard performance

The operator dashboard is optimised for long-running sessions with large fleets:

- **Stale aircraft eviction** — aircraft not updated for 5 minutes are automatically pruned from both the fleet store and the globe store, preventing unbounded memory growth
- **Throttled store subscriptions** — the fleet grid and analytics panels use 2-second throttled selectors, reducing React re-renders from hundreds per second to one every 2 seconds
- **Batched globe updates** — individual WebSocket telemetry messages are batched into a single globe store update per second, and Cesium entity sync is throttled to ~1 Hz
- **Memoised components** — fleet cards use `React.memo` with CSS transitions instead of per-card Framer Motion spring animations
- **Fetch overlap guards** — API polling (`/api/metrics` every 10s, `/api/fleet` every 60s) skips if the previous request is still in flight

## Quick start

From the repository root:

```bash
cp .env.example .env
# Edit .env — at minimum: database, Redis, wallet seed, funding WIF, tracked aircraft.
# Or enable DEMO_MODE=true for ingestion without live ADS-B feeds.

pnpm install
pnpm run build
docker compose up -d postgres redis   # or run them natively
pnpm run db:migrate
```

`docker compose up -d` with no arguments brings up the whole stack — Postgres,
Redis, Arcade, all six services, the dashboard and nginx. For local development
against `pnpm dev` processes, start only the dependencies as shown above.

Under compose the schema is applied by a one-shot `migrate` service, and every
service that touches Postgres waits for it to exit zero, so `pnpm run db:migrate`
is only needed when running the services natively. Migrations are recorded
without a file extension, so the same ledger is read whether they were applied
from TypeScript source or from the compiled build in the container.

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
- **AE polar flight map:** [https://airchive.vercel.app/ae](https://airchive.vercel.app/ae)
- **Cost calculator:** [https://airchive.vercel.app/demo](https://airchive.vercel.app/demo)
- **Wallet list:** [https://airchive.vercel.app/wallets](https://airchive.vercel.app/wallets)

### Local development URLs

- Dashboard: `http://localhost:3000`
- Gateway API: `http://localhost:4000`
- Overlay Node REST API: `http://localhost:4010`
- Prometheus metrics: Ingestion `:9090`, Blockchain Writer `:9091`, Agent Marketplace `:9093`

### Deployment architecture

Production is a **Docker Compose** stack on a VPS — Postgres, Redis, Arcade, the six Node services, the Next.js dashboard and nginx on one internal network, with TLS terminated at nginx (certbot). `deploy/README.md` is the full runbook: host preparation, file-backed secrets, verified backups and optional systemd units for boot.

The dashboard can also be served from Vercel while the backend remains on the VPS; in that case the gateway's REST and WebSocket endpoints need a stable public origin (TLS at nginx, or a **named** Cloudflare Tunnel — the latter needs no open ports or certificates and, unlike a quick tunnel, keeps a stable hostname across restarts). SEO surfaces (`robots.txt`, `sitemap.xml`, Open Graph, JSON-LD) resolve from `NEXT_PUBLIC_SITE_URL` / `PUBLIC_ORIGIN` at build time.

## Tech stack

- **Runtime:** Node.js 22+, TypeScript, pnpm workspaces
- **Data:** PostgreSQL 16, Redis 7
- **Web:** Next.js 15, React 19, Tailwind CSS, Framer Motion, Cesium (globe), three.js + GLSL (AE polar map)
- **Chain:** BSV mainnet (Arcade primary, TAAL ARC fallback, Whatsonchain, `@bsv/sdk` v2, `@bsv/simple`)
- **Verification:** SPV — local proof-of-work-checked header chain, BUMP and TSC proof validation
- **Agent infra:** `@bsv/simple` ServerWallet, BRC-100 Identity Registry, MessageBox P2P
- **Ops:** Docker Compose, nginx + certbot, Prometheus metrics, systemd

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
| `services/blockchain-writer` | On-chain writes from Redis `write:*`, UTXO management, activity-aware auto-refill, SPV header store and proof verification, funding state machine |
| `services/agent-marketplace` | Three autonomous AI agents (Collector, Analyst, Monitor) with BSV micropayments |
| `services/overlay-node` | BSV overlay node — `tm_airchive` topic manager, `AirchiveLookupService`, REST + WebSocket API |
| `services/alert-engine` | Configurable alerting (email/SMS via SendGrid/Twilio) |
| `dashboard` | Next.js operator UI — globe, AE map entry banner, fleet grid, blockchain feed, agent marketplace panel, SEO metadata |
| `dashboard/src/ae` | Custom three.js engine for the AE polar flight map — projection maths, disc/rim/field/label shaders, trail layer, flight dossier |
| `deploy` | VPS runbook, systemd units, entrypoint and verified backup/restore scripts |
| `k8s`, `nginx` | Kubernetes manifests and reverse-proxy configuration |

## Wallet architecture

### Aircraft wallets (HD-derived)

The system currently tracks **253 aircraft** in `aircraft_config`, each with its own deterministic P2PKH wallet derived from the master seed via BIP44 path `m/44'/236'/0'/0/{index}`. Total active wallets: **253 aircraft + 3 agent wallets + 1 treasury/funding wallet = 257 wallets**.

| Wallet | Count | Purpose |
|--------|-------|---------|
| Aircraft (HD-derived) | 253 | One per tracked ICAO — holds UTXOs for telemetry broadcasts |
| Agent (ServerWallet) | 3 | Collector, Analyst, Monitor — micropayments and inscriptions, topped up from the treasury |
| Treasury / Funding | 1 | Top-level wallet that distributes satoshis to aircraft wallets via activity-aware auto-refill, and to the agent wallets on a fixed schedule (`FUNDING_WALLET_WIF`) |

The treasury is a standard P2PKH wallet whose outputs are tracked in a dedicated `funding_utxo_pool` table, reconciled against WhatsonChain rather than re-fetched on every refill. Keeping the pool locally means a refill can select and lock several inputs atomically, which is what allows a fragmented treasury to fund a refill from multiple smaller outputs instead of failing while holding ample total value.

**Write cadence follows flight state.** A parked aircraft emits a liveness heartbeat every 60s. Taxi phases write every 2s, and every airborne phase writes at 1s — the rate ADS-B itself updates at, so sampling faster would only duplicate records. Writes are additionally triggered the moment a phase change, squawk change, or significant heading, altitude or vertical-rate change is observed, so a manoeuvre is never missed while waiting for the next interval tick. A duplicate-suppression filter, with tighter thresholds airborne than on the ground, drops samples carrying no new information. All intervals are configurable via `WRITE_RATE_*_MS`.

### Activity-aware auto-refill

The auto-refill monitor runs every `REFILL_CHECK_INTERVAL_MS` (default 5 seconds) and checks each aircraft wallet balance against `REFILL_THRESHOLD_SATS`. It only refills wallets for **actively flying** aircraft — those with write-channel activity within `REFILL_IDLE_WINDOW_MS` (default 30 minutes). Idle aircraft are skipped to conserve funding.

- **Startup behaviour**: The writer performs an activity-aware check rather than blindly refilling the whole fleet on boot.
- **On-demand refill**: If a UTXO pool is exhausted mid-flight, a refill is requested immediately rather than waiting for the next cycle.
- **Multi-input refills**: A refill may draw on several treasury outputs at once, so fragmentation does not block funding while the treasury holds sufficient total value.
- **Retry shaping**: Deferred telemetry writes are coalesced per aircraft so the queue keeps the latest state instead of every stale sample.

### Funding recovery

Funding state is persisted in Postgres, so it survives restarts of any length
and no manual intervention is needed beyond sending funds.

On entering `DRY` the writer stops retry churn, raises a `CRITICAL` alert and
shows a dashboard banner. Rows in `pending_writes` are preserved rather than
aged out — the retry-exhaustion purge is skipped entirely while funding is
unhealthy, so the backlog survives. The funding address is then polled on a
backoff widening to `FUNDING_DRY_POLL_MAX_MS`, indefinitely.

Deferred telemetry is flagged `preserved` for the duration, which exempts it
from the per-aircraft coalescing that applies in normal operation. Without that
exemption the backlog was not a backlog at all: each arriving sample deleted the
one being held, so however long the outage ran, exactly one telemetry frame per
aircraft survived. Preserved rows drain in chronological order once funding
returns, and are aged out on a 24-hour retention window so an unattended outage
cannot fill the disk — at the measured write rate a dry treasury accrues roughly
a million rows a day.

Flight paths themselves do not depend on any of this. `session_positions` is
written by the ingestion service straight to Postgres and never touches the
treasury, so the operational record of a flight survives a funding outage
intact; it is the on-chain archive that gains a gap.

When funds arrive it reconciles the pool, splits to `FUNDING_POOL_SPLIT_TARGET`,
refills active aircraft first, then drains the backlog
`FUNDING_RECOVERY_DRAIN_BATCH` writes at a time so recovery does not stampede
the broadcaster. `GET /api/system/funding` reports state, balance, estimated
**runway** and **retry backlog** throughout:

- **Runway** is balance divided by a time-weighted burn rate. Quiet intervals
  count as zero burn (so the estimate is not inflated by only sampling spend
  windows), and balance increases are skipped so top-ups do not look like
  negative burn. The smoother uses a 30-minute time constant.
- **Retry backlog** is the count of deferred writes waiting to broadcast —
  coalesced to the latest sample per aircraft during ordinary backpressure,
  and preserved in full while the treasury is dry.

### Agent wallets (`@bsv/simple` ServerWallet)

The three marketplace agents each have their own `@bsv/simple` ServerWallet, separate from the HD aircraft wallets. Set the `*_AGENT_KEY` env vars to persist stable keys across restarts; addresses are logged at startup.

They are funded from the same treasury as the aircraft. The blockchain writer holds the funding key, so it also derives the three agent addresses from those keys and tops them up on the `AGENT_REFILL_*` schedule. Each top-up arrives as `AGENT_REFILL_OUTPUTS` small outputs rather than one large one, because an agent inscribing from a single output has to chain unconfirmed spends and the sequence ends up in the orphan mempool. Set `AGENT_REFILL_ENABLED=false` to fund the agents by hand instead.

## Environment variables

Authoritative list and descriptions: **`.env.example`** at the repository root. Key sections:

- **PostgreSQL / Redis** — database and message bus
- **BSV Blockchain** — ARC URL, API key, Whatsonchain
- **Wallet Vault** — HD master seed, funding WIF
- **Auto-refill** — threshold, amount, idle window
- **Data Sources** — adsb.fi, OpenSky, RTL-SDR
- **Ingestion** — poll interval, tracked aircraft, demo mode, write rate overrides (`WRITE_RATE_*_MS`)
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

The current configured fleet database contains **253 aircraft** across five carrier groups (Qatar Airways, British Airways, Singapore Airlines, Cathay Pacific, Qantas). Not all aircraft are airborne simultaneously — commercial utilisation typically means **30–50% of a fleet is active at any given moment**, with individual aircraft averaging 8–12 flight hours per day. The maths below reflects a realistic concurrent active fraction rather than the theoretical maximum.

| Parameter | Value |
|-----------|-------|
| Configured aircraft | **253** |
| Realistic concurrent active aircraft | **80–120** (30–50% utilisation) |
| Weighted-avg tx/s per active aircraft | 0.97 ceiling (phase-weighted, before duplicate suppression) |
| Measured sustained TX/s | **11 TX/s** mean across active minutes |
| Measured 90th percentile | **23 TX/s** |
| Measured peak | **30 TX/s** |
| Extrapolated daily volume | approx. **0.95M/day** at the mean, **2.0M/day** at p90 |

The measured figures come from a six-hour window of live operation and sit well
below the phase-weighted ceiling, because duplicate suppression drops samples
that carry no new information and not every tracked aircraft is airborne at
once. The gap between ceiling and measurement is the design working, not
capacity being lost.

The adaptive write-rate controller adjusts per flight phase (defaults shown; all overridable via `WRITE_RATE_*_MS` env vars):

| Phase | Write interval | tx/s | Typical % of flight |
|-------|---------------|------|---------------------|
| TAKEOFF / LANDING | 1s | 1.00 | ~4% |
| CLIMB | 1s | 1.00 | ~8% |
| DESCENT / APPROACH | 1s | 1.00 | ~12% |
| CRUISE | 1s | 1.00 | ~70% |
| TAXI | 2s | 0.50 | ~4% |
| TAXI_IN | 2s | 0.50 | ~2% |
| EMERGENCY | 1s | 1.00 | rare |
| PARKED | 60s | 0.017 | n/a (not in-flight) |

These are ceilings. Duplicate suppression removes samples that carry no new
information, so realised throughput runs below the table.

Throughput scales linearly with the tracked fleet — adding aircraft increases daily volume with no architectural change, since each aircraft wallet is independently funded and manages its own UTXO chain, enabling fully parallel transaction construction with no contention.

**Cost estimate:** At 110 sats/KB, the measured average transaction is 767 bytes and costs 85 sats. At the measured sustained rate that is roughly **0.8 BSV/day** (approx. £10 at £11.90/BSV), rising to about **1.7 BSV/day** (approx. £20) at p90. The activity-aware auto-refill system distributes funding automatically from the treasury, topping up only actively flying aircraft.

Throughput peaks during descent- and approach-heavy periods such as European evening arrivals, and dips when most tracked aircraft are cruising or parked. In practice the system is write-generation-limited rather than broadcast-limited: Arcade batching absorbs submission load comfortably, and the constraint is how much genuinely new telemetry the fleet produces.

> The `/demo` route on the dashboard includes an interactive cost calculator where fleet size and flight hours can be adjusted to model chain-write economics.

## Licence

**UNLICENSED / proprietary.** All rights reserved unless otherwise agreed in writing.
