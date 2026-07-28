# Airchive — BSV Blockchain Aircraft Telemetry Platform
## Complete Production Plan for Enterprise Adoption
**Revision 1.0 | April 2026 | Confidential**

---

## TABLE OF CONTENTS

1. Executive Summary
2. System Vision & Architecture Overview
3. Data Sources & Ingestion Layer
4. BSV Blockchain Stack — Libraries, Tooling & Transaction Design
5. UTXO Management Strategy
6. On-Chain Data Schema
7. Backend Service Architecture
8. Dashboard & Visualisation Layer
9. Per-Aircraft Wallet System
10. Security Architecture
11. Cost Model
12. Agent Sub-Task Breakdown (Full Dev Roadmap)
13. Technology Stack Matrix
14. Appendix A — ADS-B Field Reference
15. Appendix B — BSV Transaction Structure Reference

---

## 1. EXECUTIVE SUMMARY

Airchive is a production-grade, enterprise blockchain telemetry platform that writes real-time aircraft state vectors — and eventually full cockpit, engine, and sensor telemetry — permanently to the BSV blockchain. Each aircraft is assigned an autonomous wallet address. Every WebSocket-received telemetry snapshot is composed into a BSV transaction and broadcast via ARC within sub-second cycles, creating an immutable, timestamped, cryptographically verifiable flight record.

The system replaces the traditional "black box" paradigm. In the event of an accident, investigation, or regulatory audit, every data point from every second of every flight is retrievable on-chain, indexed via a custom BSV Overlay Node, and viewable through a futuristic real-time dashboard featuring 3D globe mapping, live telemetry graphs, and per-aircraft blockchain explorer feeds.

**Primary Use Cases:**
- Commercial aircraft telemetry archiving (replaces DFDR/CVR black boxes)
- Real-time airline operations monitoring
- Regulatory compliance and audit trails (EASA, FAA, ICAO)
- Insurance underwriting data
- Fleet analytics and predictive maintenance
- Eventual expansion: maritime (AIS), rail, autonomous vehicle tracking

---

## 2. SYSTEM VISION & ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────┐
│                      DATA INGESTION LAYER                    │
│  OpenSky REST (1s poll) + adsb.fi REST + Local RTL-SDR Feed  │
│            [ADS-B / Mode-S / MLAT / ADS-C signals]           │
└────────────────────────┬────────────────────────────────────┘
                         │ Raw State Vectors (JSON)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              TELEMETRY NORMALISATION SERVICE (Node.js)        │
│  - Merge multi-source feeds per ICAO hex per aircraft         │
│  - Derive missing fields (vertical rate, track heading)       │
│  - Assign/lookup aircraft wallet (HD key per ICAO hex)        │
│  - Serialise to canonical TelemetryRecord JSON schema         │
└────────────────────────┬────────────────────────────────────┘
                         │ Normalised TelemetryRecord
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              BSV TRANSACTION COMPOSER (@bsv/sdk)              │
│  - Build OP_RETURN output with encoded TelemetryRecord        │
│  - Select UTXOs from internal UTXO pool (NO full scan)        │
│  - Sign with aircraft's HD private key                        │
│  - Compute fees at 100 sat/kb + buffer                        │
│  - Broadcast via TAAL ARC API (EF transaction format)         │
└────────────────────────┬────────────────────────────────────┘
                         │ TxID + Block/Mempool confirmation
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           BSV OVERLAY NODE (Custom, @bsv/overlay-services)    │
│  - Receives SPV-validated transactions                        │
│  - Indexes by ICAO hex + timestamp                            │
│  - Provides REST & WebSocket query endpoints                  │
│  - Merkle path storage for SPV proof on each record           │
└────────────────────────┬────────────────────────────────────┘
                         │ Indexed telemetry history
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Airchive DASHBOARD (React/Next.js)               │
│  - 3D Globe (CesiumJS / deck.gl)                              │
│  - Per-aircraft live telemetry graphs                         │
│  - Real-time blockchain feed per aircraft                     │
│  - Historical playback from Overlay Node                      │
│  - Alert system for anomalous sensor readings                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. DATA SOURCES & INGESTION LAYER

### 3.1 Primary Free Data Source — OpenSky Network REST API

**Endpoint:** `https://opensky-network.org/api/states/all`
**Rate:** Authenticated users → 1 request/second (free tier with registration)
**Fields Returned per Aircraft:**
- `icao24` — ICAO 24-bit hex address (unique aircraft identifier)
- `callsign` — Flight number / registration
- `origin_country` — Registered country
- `time_position` — Unix timestamp of last position fix
- `last_contact` — Unix timestamp of last signal
- `longitude` — WGS84 decimal degrees
- `latitude` — WGS84 decimal degrees
- `baro_altitude` — Barometric altitude (metres)
- `on_ground` — Boolean ground flag
- `velocity` — Ground speed (m/s)
- `true_track` — Track heading (degrees clockwise from north)
- `vertical_rate` — Climb/descent rate (m/s)
- `sensors` — Array of receiver IDs that picked up this aircraft
- `geo_altitude` — Geometric/GPS altitude (metres)
- `squawk` — Mode-3A transponder code (4 octal digits)
- `spi` — Special purpose indicator
- `position_source` — ADS-B (0), ASTERIX (1), MLAT (2), FLARM (3)

**Implementation Strategy:**
```
GET https://opensky-network.org/api/states/all?icao24=COMMA_SEPARATED_HEX_LIST
```
Poll every 1000ms for the 15 tracked aircraft. Filter by ICAO hex to avoid full global state download. This returns targeted sub-second-fresh snapshots.

### 3.2 Secondary Source — adsb.fi Open Data API

**Endpoint:** `https://opendata.adsb.fi/api/v2/hex/{icao24}`
**Rate:** 1 req/sec (public), higher with receiver contribution
**Advantages over OpenSky:** Lower latency, community-driven unfiltered data, ADSBexchange v2 API-compatible format
**Additional Fields over OpenSky:**
- `alt_baro` / `alt_geom` — Both barometric and geometric altitude
- `gs` — Ground speed in knots
- `ias` / `tas` — Indicated and true airspeed (when available)
- `mach` — Mach number (transponder-derived)
- `wd` / `ws` — Wind direction and speed (aircraft-reported)
- `oat` / `tat` — Outside air temp / total air temp (when available)
- `track` — Track over ground
- `roll` — Roll angle (degrees, when ADS-B v2 capable aircraft)
- `nav_qnh` — Set QNH pressure
- `nav_altitude_mcp` / `nav_altitude_fms` — Autopilot target altitudes
- `nav_heading` — Autopilot heading bug
- `nav_modes` — Autopilot modes (LNAV, VNAV, ALT HOLD, etc.)
- `emergency` — Emergency status code
- `category` — ICAO aircraft emitter category
- `version` — ADS-B version (0/1/2; v2 carries roll/heading)
- `nic` / `rc` — Navigation integrity category and radius of containment
- `seen` / `seen_pos` — Seconds since last message / position

### 3.3 Tertiary Source — Local RTL-SDR Receiver (For Production/Pitch Demo)

For maximum data richness and sub-100ms latency, deploy a Raspberry Pi 5 + RTL-SDR V4 dongle running `dump1090-fa` or `readsb`. This produces a local JSON endpoint at `http://localhost:8080/data/aircraft.json` refreshing every 500ms, with ALL decoded ADS-B fields including any raw Mode-S BDS register data (aircraft intent, meteorological data, etc.).

**This is the production architecture recommendation for a real airline customer.** The SDR would be installed at each major hub airport, feeding directly into the Airchive ingestion layer with no external API dependency.

### 3.4 Future Extended Telemetry — ACARS / ARINC 429

For full black-box replacement, the system architecture must eventually accommodate:
- **ACARS** (Aircraft Communications Addressing and Reporting System): Carries engine health data, fuel flow, hydraulic pressures, maintenance messages
- **ARINC 429**: Avionics data bus standard carrying cockpit instruments, FMS data, FADEC output
- **SATCOM downlink** (Iridium/Inmarsat): Real-time streaming from aircraft systems at cruise

These are enterprise integrations not reliant on free public APIs — they require airline partnership. The architecture is designed to slot these sources in via the same Normalisation Service interface.

### 3.5 WebSocket vs. Poll Strategy

OpenSky and adsb.fi do not natively expose persistent WebSockets. The recommended approach:

```
Internal WebSocket Bus (ws:// on localhost)
  ↑
Polling service (Node.js setInterval @ 1000ms)
  ↑
REST API calls to OpenSky + adsb.fi (in parallel, race/merge)
```

This creates an internal WebSocket fan-out that feeds both the blockchain writer and the dashboard's live aircraft positions simultaneously with <1s latency. For the pitch demo, this is visually indistinguishable from a native WebSocket feed.

---

## 4. BSV BLOCKCHAIN STACK

### 4.1 Core SDK — @bsv/sdk (Official BSV Association TypeScript SDK)

**Package:** `npm install @bsv/sdk`
**GitHub:** `https://github.com/bsv-blockchain/ts-sdk`
**Status:** Actively maintained (Feb 2026 commits), zero dependencies, TypeScript-first.

This is the **only** recommended SDK. It replaces all legacy libraries (bsvjs, moneybutton/bsv, etc.) and is the officially maintained BSV Association library.

**Key capabilities used in Airchive:**
- HD wallet derivation (BIP32 — per-aircraft key derivation from master seed)
- Transaction construction (inputs/outputs/scripts)
- OP_RETURN script template building
- Transaction signing (ECDSA secp256k1)
- Fee computation (sats/kb model)
- SPV Merkle proof validation
- Broadcasting via pluggable broadcaster interface (ARC)

```typescript
import { Transaction, P2PKH, ARC, PrivateKey, Script } from "@bsv/sdk";

// Build a telemetry record transaction
const tx = new Transaction();
tx.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: 0,
              unlockingScriptTemplate: new P2PKH().unlock(aircraftPrivKey) });
tx.addOutput({ lockingScript: buildTelemetryOpReturn(telemetryRecord), satoshis: 0 });
tx.addOutput({ lockingScript: new P2PKH().lock(aircraftAddress), satoshis: changeAmount });
await tx.fee(new SatoshisPerKilobyte(100));
await tx.sign();
const arc = new ARC("https://arc.taal.com", { apiKey: process.env.TAAL_ARC_KEY });
const result = await tx.broadcast(arc);
```

### 4.2 Transaction Broadcaster — TAAL ARC

**Endpoint:** `https://arc.taal.com`
**Docs:** `https://arc.taal.com/`
**Format:** Extended Format (EF) transactions — includes previous UTXO locking scripts inline, removing need for node-side UTXO lookup

ARC is the production-grade transaction processor replacing mAPI. It returns real-time transaction status through a callback mechanism, providing:
- `SEEN_ON_NETWORK` — broadcast confirmation (instant)
- `MINED` — block confirmation with Merkle path

**Why ARC over direct node RPC:**
- Connects to multiple nodes simultaneously (resilient)
- Returns tx lifecycle status callbacks
- Stores Merkle paths for SPV
- Enterprise SLAs available from TAAL
- Does not require running a full BSV node

### 4.3 UTXO Lookup — WhatsOnChain API (Lookup Only)

Per project requirements: WoC UTXO API is used **only** for initial UTXO discovery when bootstrapping a new aircraft wallet or after a system restart. It is NOT used for real-time wallet scanning.

**Endpoint:** `GET https://api.whatsonchain.com/v1/bsv/main/address/{address}/unspent`
**Returns:** Array of confirmed + unconfirmed UTXOs (paginated)

This call is made **once** at startup per aircraft wallet, then the UTXO set is maintained in the local UTXO pool database (see Section 5).

### 4.4 Overlay Node — @bsv/overlay-services

**Package:** `npm install @bsv/overlay-services`
**GitHub:** `https://github.com/bsv-blockchain/overlay-services`

The Airchive custom Overlay Node ingests all telemetry transactions as they appear on-chain, validates them via SPV, and maintains a queryable index:

```typescript
import { Engine } from "@bsv/overlay-services";

const engine = new Engine({
  managers: [new AirchiveTopicManager()],  // Custom topic: "tm_airchive"
  lookupServices: [new AirchiveLookupService(db)],
  storage: new KnexStorageEngine(knex),
  chaintracker: new WhatsOnChainMerkleVerifier(),
  broadcaster: new ARC("https://arc.taal.com")
});
```

**Why run an Overlay Node:**
- SPV-validated, self-sovereign index — no dependence on third-party explorers
- Custom query endpoints: "get all telemetry for flight BA249 on 2026-04-03"
- Merkle path storage for offline audit proof generation
- Scalable: designed for high-volume BSV transaction volumes

---

## 5. UTXO MANAGEMENT STRATEGY

This is the most critical engineering challenge. The strategy is designed to be simple, deterministic, and avoid external wallet scanning APIs for normal operation.

### 5.1 Per-Aircraft UTXO Pool

Each aircraft wallet maintains its own UTXO pool in a local PostgreSQL table:

```sql
CREATE TABLE utxo_pool (
  aircraft_icao    VARCHAR(6)   NOT NULL,
  txid             CHAR(64)     NOT NULL,
  vout             INTEGER      NOT NULL,
  satoshis         BIGINT       NOT NULL,
  locking_script   TEXT         NOT NULL,
  is_locked        BOOLEAN      DEFAULT FALSE,  -- in-flight, not yet confirmed
  created_at       TIMESTAMP    DEFAULT NOW(),
  PRIMARY KEY (txid, vout)
);
```

### 5.2 UTXO Lifecycle

```
1. BOOTSTRAP (once per wallet, at startup):
   WoC UTXO API → fetch all unspent UTXOs → populate utxo_pool

2. SPEND (every telemetry write, ~1/second):
   a. SELECT one UTXO where is_locked = FALSE, order by satoshis DESC
   b. SET is_locked = TRUE (optimistic lock)
   c. Build transaction using this UTXO as input
   d. Broadcast via ARC
   e. INSERT change output as new UTXO row (is_locked = FALSE, from known change address)

3. CONFIRMATION CALLBACK (from ARC):
   a. On MINED status: DELETE the spent input UTXO row

4. REFUND / MERGE OPERATION (scheduled, daily or when UTXO count > 50):
   a. Batch-consolidate many small UTXOs into one larger UTXO
   b. This keeps wallet clean and fees optimal

5. TOP-UP (manual or scheduled):
   a. Send BSV from funding wallet to aircraft wallet address
   b. WoC UTXO lookup confirms new UTXO
   c. INSERT into utxo_pool
```

### 5.3 UTXO Pre-Seeding Strategy

To avoid interruptions, each aircraft wallet is pre-loaded with **100 UTXOs of ~10,000 satoshis each** at initialisation. At 100 sat/kb and ~1kb per telemetry tx, each UTXO funds ~100 transactions. 100 UTXOs = ~10,000 writes before a top-up is needed. At 1 write/second, that's ~2.8 hours of uninterrupted recording.

**Recommended: Pre-seed each aircraft wallet with 0.01 BSV** (1,000,000 satoshis) at startup — this funds approximately 10,000 transactions (about 2.8 hours at 1 tx/second), covering a full long-haul flight with margin.

### 5.4 UTXO Consolidation (Automatic)

A background job runs every 24 hours to consolidate fragmented UTXOs:
```
IF utxo_count > 20 for any aircraft THEN
  Build a consolidation transaction (many inputs, 1 output)
  Broadcast and update pool
```

This is the entire UTXO management system — no third-party wallet software required, no scanning required in normal operation.

---

## 6. ON-CHAIN DATA SCHEMA

### 6.1 Transaction Structure

Each telemetry transaction has:
- **Input:** 1 UTXO from the aircraft's wallet
- **Output 0:** `OP_RETURN` — encoded TelemetryRecord (0 satoshis)
- **Output 1:** P2PKH change back to aircraft wallet (satoshis - fee)

### 6.2 OP_RETURN Encoding

The OP_RETURN payload uses a compact binary/JSON hybrid:

```
OP_RETURN
  <PROTOCOL_ID: 4 bytes> = 0x534B5943 ("SKYC")
  <VERSION: 1 byte>      = 0x01
  <ICAO_HEX: 3 bytes>    = binary encoded ICAO address
  <TIMESTAMP: 8 bytes>   = Unix timestamp milliseconds (uint64 LE)
  <PAYLOAD: N bytes>     = MessagePack-encoded TelemetryRecord
```

MessagePack is used instead of JSON to minimise transaction size (and therefore fees). A full telemetry record compresses to ~200-400 bytes, well under 1kb.

### 6.3 TelemetryRecord Schema (Full Field Set)

```typescript
interface TelemetryRecord {
  // === IDENTITY ===
  icao: string;           // "4CA1B9" - ICAO 24-bit hex
  callsign: string;       // "EIN456" - Flight callsign
  reg: string;            // "EI-LVL" - Aircraft registration
  squawk: string;         // "2342" - Mode-3A code
  aircraft_type: string;  // "B78X" - ICAO aircraft type code
  category: string;       // "A5" - Emitter category

  // === TEMPORAL ===
  ts: number;             // Unix ms timestamp (server receive time)
  ts_pos: number;         // Unix ms of last position fix from aircraft

  // === POSITION ===
  lat: number;            // Decimal degrees WGS84
  lon: number;            // Decimal degrees WGS84
  alt_baro: number;       // Barometric altitude (feet)
  alt_geom: number;       // Geometric/GPS altitude (feet)
  on_ground: boolean;     // Ground flag

  // === MOTION ===
  gs: number;             // Ground speed (knots)
  ias: number;            // Indicated airspeed (knots)
  tas: number;            // True airspeed (knots)
  mach: number;           // Mach number
  track: number;          // Track over ground (degrees true)
  true_heading: number;   // True heading (degrees)
  mag_heading: number;    // Magnetic heading (degrees)
  baro_rate: number;      // Barometric vertical rate (ft/min)
  geom_rate: number;      // Geometric vertical rate (ft/min)
  roll: number;           // Roll angle (degrees, + = right wing down)

  // === ATMOSPHERIC ===
  wind_dir: number;       // Wind direction (degrees)
  wind_speed: number;     // Wind speed (knots)
  oat: number;            // Outside air temperature (°C)
  tat: number;            // Total air temperature (°C)

  // === AUTOPILOT / FMS INTENT ===
  nav_qnh: number;        // QNH pressure setting (hPa)
  nav_alt_mcp: number;    // MCP/FCU altitude target (feet)
  nav_alt_fms: number;    // FMS altitude target (feet)
  nav_heading: number;    // Autopilot heading target (degrees)
  nav_modes: string[];    // Active autopilot modes e.g. ["LNAV","VNAV","ALT"]

  // === DATA QUALITY ===
  nic: number;            // Navigation integrity category
  rc: number;             // Radius of containment (metres)
  adsb_version: number;   // ADS-B transponder version (0/1/2)
  position_source: number;// 0=ADSB, 1=ASTERIX, 2=MLAT, 3=FLARM
  num_receivers: number;  // How many receivers saw this aircraft

  // === EMERGENCY ===
  emergency: string;      // "none"|"general"|"lifeguard"|"minfuel"|"nordo"|"unlawful"|"downed"

  // === METADATA ===
  data_sources: string[]; // ["opensky","adsbfi"] - which sources contributed
  seq: number;            // Sequence number within this flight
}
```

### 6.4 Transaction Size & Cost Estimate

| Field Set | MessagePack Size | Tx Overhead | Total Tx Size | Fee @ 100 sat/kb | Cost in GBP* |
|-----------|-----------------|-------------|----------------|------------------|--------------|
| Core only (pos+speed+alt) | ~80 bytes | ~200 bytes | ~0.28 kb | 28 sats | ~£0.00001 |
| Full record | ~350 bytes | ~200 bytes | ~0.55 kb | 55 sats | ~£0.00002 |
| Future ACARS augmented | ~800 bytes | ~200 bytes | ~1.0 kb | 100 sats | ~£0.00003 |

*At BSV ~$40 / £32 (April 2026 approximate)

**For 15 aircraft at 1 tx/second for 24 hours:**
15 × 86,400 = 1,296,000 transactions/day
At 100 sats avg fee = 129,600,000 sats = 1.296 BSV ≈ **£41.47/day** for all 15 aircraft

This is an extraordinary cost efficiency argument for the pitch.

---

## 7. BACKEND SERVICE ARCHITECTURE

### 7.1 Service Decomposition

The backend is a microservice architecture deployable via Docker Compose (development) or Kubernetes (production).

```
airchive/
├── services/
│   ├── ingestion/          # ADS-B poll + normalisation
│   ├── blockchain-writer/  # UTXO management + TX composition + broadcast
│   ├── overlay-node/       # Custom BSV overlay (SPV + indexing)
│   ├── gateway/            # API gateway + WebSocket hub for dashboard
│   └── alert-engine/       # Anomaly detection + alert triggers
├── shared/
│   ├── db/                 # PostgreSQL (UTXO pool, flight records, alerts)
│   ├── redis/              # Message queue between ingestion → writer
│   └── wallet-vault/       # Encrypted HD wallet master seed storage
└── dashboard/              # React/Next.js frontend
```

### 7.2 Message Flow

```
[Ingestion Service]
  → publishes TelemetryRecord to Redis channel "telemetry:{icao}"
  → publishes to "broadcast" channel for dashboard WS fan-out

[Blockchain Writer Service]
  → subscribes to Redis "telemetry:{icao}"
  → for each message: build + sign + broadcast BSV transaction
  → publishes TxResult to Redis "txresult:{icao}"

[Gateway Service]
  → subscribes to "broadcast" + "txresult" channels
  → fans out to connected dashboard WebSocket clients
  → provides REST API for historical data queries to Overlay Node

[Alert Engine]
  → subscribes to "telemetry:{icao}"
  → evaluates rule set (extreme roll angle, rapid altitude loss, etc.)
  → publishes alerts to "alerts" channel → dashboard + email/SMS
```

### 7.3 Ingestion Service — Detail

```typescript
// services/ingestion/src/poller.ts
const TRACKED_AIRCRAFT = [
  "400F27", // BA001 - Example ICAO
  "4CA1B9", // EIN456
  // ... 13 more
];

async function pollCycle() {
  const [openskyData, adsbfiData] = await Promise.all([
    fetchOpenSky(TRACKED_AIRCRAFT),
    fetchAdsbFi(TRACKED_AIRCRAFT)
  ]);
  const merged = mergeSources(openskyData, adsbfiData);
  for (const record of merged) {
    await redis.publish(`telemetry:${record.icao}`, JSON.stringify(record));
    await redis.publish("broadcast", JSON.stringify(record));
  }
}

setInterval(pollCycle, 1000); // 1 second poll cycle
```

### 7.4 Aircraft Wallet Provisioning

```typescript
// shared/wallet-vault/src/WalletVault.ts
import { HD, PrivateKey } from "@bsv/sdk";

class WalletVault {
  private masterKey: HD;

  // Derive deterministic wallet for each aircraft
  // Path: m/44'/236'/0'/0/{aircraft_index}
  deriveAircraftKey(aircraftIndex: number): PrivateKey {
    return this.masterKey
      .derive(`m/44'/236'/0'/0/${aircraftIndex}`)
      .privKey;
  }

  // Each aircraft gets a unique, reproducible address
  getAircraftAddress(icao: string): string {
    const index = this.icaoToIndex(icao);
    const key = this.deriveAircraftKey(index);
    return key.toPublicKey().toAddress().toString();
  }
}
```

---

## 8. DASHBOARD & VISUALISATION LAYER

### 8.1 Visual Design System

Matching the futuristic aesthetic of trackota.help/dashboard:
- **Colour palette:** Deep space black (#060B14) background, electric cyan (#00F5FF) accents, neon amber (#FFB800) alerts, signal green (#00FF88) healthy status
- **Typography:** JetBrains Mono (data readouts), Inter (labels), all uppercase tracking IDs
- **Grid:** CSS Grid dark panels with subtle blue glow borders (box-shadow: 0 0 20px rgba(0,245,255,0.1))
- **Glassmorphism cards** for aircraft detail panels
- **Animated scan-line overlay** on 3D globe section
- **HUD-style data readouts** (numbers incrementing in real-time with trailing zero-pad)

### 8.2 Dashboard Panels

**Panel 1 — 3D Globe (Hero Section, Full Width)**
- Library: CesiumJS (free, open source 3D globe engine)
- Aircraft rendered as animated chevron glyphs oriented to heading
- Flight paths rendered as glowing polylines (colour-coded by altitude)
- Auto-rotate when no aircraft selected; snap-to when selected
- Altitude exaggeration: 30x vertical scale for visual impact

**Panel 2 — Fleet Status Grid (15 aircraft cards)**
- Live: Callsign, Type, Altitude, Speed, Heading, Phase (CLIMB/CRUISE/DESCENT/GROUND)
- Colour-coded status: GREEN (normal) → AMBER (alert) → RED (emergency)
- Last BSV TxID with clickable link to Overlay Node explorer
- Transactions per second counter per aircraft

**Panel 3 — Selected Aircraft Deep Dive**
- Attitude Indicator (artificial horizon) — animated SVG using roll/pitch data
- Vertical Speed Indicator — needle gauge
- Altimeter — dual-tape display (baro + geometric)
- Speed tape — IAS/TAS/GS/Mach display
- Heading indicator — rotating compass rose
- Navigation display — mini radar showing heading/track/wind
- Engine parameters section (stubbed for future ACARS data)

**Panel 4 — Blockchain Feed**
- Real-time scrolling list of BSV transactions as they are broadcast
- Per row: timestamp, aircraft, TxID (truncated), payload size, ARC status
- Confirmation time counter
- Total transactions today / total bytes written to chain
- BSV cost ticker (live fee tally)

**Panel 5 — Analytics**
- Altitude over time graph (Recharts area chart, 60-second window)
- Speed over time (multi-line for IAS/TAS/GS)
- Vertical rate gauge (colour threshold: green <500fpm, amber 500-1500, red >1500)
- Wind vector overlay
- Route prediction trail (last 30 positions)

**Panel 6 — Alerts & Events**
- Chronological alert log
- Severity-coded (INFO / WARNING / CRITICAL / EMERGENCY)
- Squawk code change events highlighted
- Emergency squawk (7700/7600/7500) triggers full-screen alarm overlay

### 8.3 Technology Stack for Dashboard

```
Frontend Framework:   Next.js 15 (App Router)
3D Globe:             CesiumJS 1.115+ (via resium React wrapper)
Charts:               Recharts 2.x (real-time streaming data)
State Management:     Zustand (lightweight, reactive)
WebSocket Client:     native browser WebSocket → gateway service
Styling:              Tailwind CSS + custom CSS variables
Animations:           Framer Motion (panel transitions)
Gauges:               Custom SVG components (horizon, compass, VSI)
Map Tiles:            Bing Maps Aerial (free tier) via CesiumJS
Data Fetching:        SWR for historical REST queries
```

### 8.4 Overlay Node Explorer

A lightweight sub-page of the dashboard that functions as an in-system blockchain explorer:

```
/explorer/aircraft/{icao}
  → Lists all on-chain transactions for this aircraft
  → Each transaction expandable to show decoded TelemetryRecord
  → Merkle proof verification status (SPV badge)
  → Time-range filter
  → Export as CSV / JSON

/explorer/tx/{txid}
  → Full decoded transaction viewer
  → Raw hex + decoded OP_RETURN
  → ARC status (SEEN / MINED / block height)
  → Merkle path viewer
```

---

## 9. PER-AIRCRAFT WALLET SYSTEM

### 9.1 HD Wallet Architecture

```
Master Seed (BIP39 mnemonic — stored in HSM or encrypted vault)
     │
     └── m/44'/236'/0'  (BSV cointype = 236, account 0)
              │
              ├── m/44'/236'/0'/0/0   → Aircraft #0 (ICAO: 400F27)
              ├── m/44'/236'/0'/0/1   → Aircraft #1 (ICAO: 4CA1B9)
              ├── m/44'/236'/0'/0/2   → Aircraft #2
              │   ...
              └── m/44'/236'/0'/0/14  → Aircraft #14
```

Each aircraft's wallet address is deterministically derived from the master seed — losing the master seed and ICAO-to-index mapping means the wallet can always be recovered. No per-aircraft seed backup needed.

### 9.2 Wallet Funding Strategy

**Initial funding:** Each aircraft wallet pre-funded with 0.01 BSV from a master funding wallet.

**Auto-refill:** When any aircraft wallet's UTXO pool total falls below 200,000 satoshis, the funding service automatically sends a top-up transaction. This is triggered by the blockchain writer service monitoring pool balance.

### 9.3 Wallet Security

- Master seed stored in HashiCorp Vault (or AWS KMS in cloud deployments)
- Private key derivation happens in-memory only, never persisted to disk
- All signing operations sandboxed in a dedicated signing service
- Aircraft wallets hold only operational float — not large reserves

---

## 10. SECURITY ARCHITECTURE

### 10.1 Data Integrity

Every TelemetryRecord written on-chain is:
- Cryptographically signed with the aircraft's unique private key
- Timestamped by the BSV network at block confirmation
- Merkle-proven via SPV for efficient verification
- Immutable — cannot be altered or deleted once mined

### 10.2 Data Provenance Chain

```
ADS-B Transponder (hardware on aircraft)
  → RF signal received by ground receiver network
    → Decoded by OpenSky/adsb.fi (open network)
      → Airchive Ingestion Service (logged with source attribution)
        → BSV Transaction (signed, timestamped, on-chain forever)
          → Overlay Node Index (SPV-verified, queryable)
```

For a regulatory investigation, the chain of custody is provable at each step.

### 10.3 API Security

- Gateway API: JWT authentication, rate limiting
- Overlay Node: Read-only public access for auditors; write access restricted to the broadcaster
- TAAL ARC: API key per environment (dev/staging/prod)
- Aircraft wallet keys: Never exposed via API; signing service only

---

## 11. COST MODEL

### 11.1 Blockchain Transaction Costs (at 100 sat/kb, BSV ≈ £32)

| Scenario | tx/day | sats/day | BSV/day | GBP/day |
|----------|--------|----------|---------|---------|
| 15 aircraft @ 1 tx/s (full flight hours ~8hr/day avg) | 432,000 | 43,200,000 | 0.432 | ~£13.82 |
| 15 aircraft @ 1 tx/s (full 24hr ops) | 1,296,000 | 129,600,000 | 1.296 | ~£41.47 |
| 100 aircraft @ 1 tx/s (scale-up) | 8,640,000 | 864,000,000 | 8.64 | ~£276 |
| 1,000 aircraft global fleet | 86,400,000 | 8.64B | 86.4 | ~£2,765 |

**Context for pitch:** A single flight data recorder (FDR) replacement costs approximately $20,000-$50,000 per aircraft. Airchive costs pennies per flight.

### 11.2 Infrastructure Costs (Monthly Estimate, 15 aircraft)

| Component | Provider | Monthly |
|-----------|----------|---------|
| App server (2 vCPU, 4GB RAM) | AWS EC2 t3.medium | ~$30 |
| PostgreSQL | AWS RDS db.t3.small | ~$25 |
| Redis | AWS ElastiCache t3.micro | ~$15 |
| Overlay Node (dedicated) | AWS EC2 t3.small | ~$20 |
| Bandwidth + misc | AWS | ~$10 |
| **Total infra** | | **~$100/month** |

---

## 12. AGENT SUB-TASK BREAKDOWN (FULL DEV ROADMAP)

### PHASE 0 — Repository & Infrastructure Setup

**Sub-agent: DevOps/Infrastructure**
- TASK-001: Initialise monorepo (pnpm workspaces)
- TASK-002: Docker Compose configuration (PostgreSQL, Redis, all services)
- TASK-003: Environment variable schema + secret management (.env + Vault)
- TASK-004: CI/CD pipeline (GitHub Actions: lint, type-check, test, build)
- TASK-005: Kubernetes manifests (production deployment YAML)
- TASK-006: Nginx reverse proxy config (SSL, WebSocket upgrade, routing)

### PHASE 1 — Shared Libraries

**Sub-agent: Core Libraries**
- TASK-101: `@airchive/types` — TypeScript interfaces for all data models (TelemetryRecord, UTXORecord, AircraftConfig, TxResult, AlertRecord)
- TASK-102: `@airchive/crypto` — BSV wallet derivation, key management, address utilities using @bsv/sdk
- TASK-103: `@airchive/telemetry-codec` — MessagePack encode/decode for TelemetryRecord, OP_RETURN builder/parser, PROTOCOL_ID constants
- TASK-104: `@airchive/db` — Knex/PostgreSQL schema migrations, query builders for all tables
- TASK-105: `@airchive/logger` — Structured JSON logging (Pino)

### PHASE 2 — Ingestion Service

**Sub-agent: Data Ingestion**
- TASK-201: OpenSky REST client — authenticated polling, response normalisation, error handling, retry logic
- TASK-202: adsb.fi REST client — polling, normalisation, field mapping to TelemetryRecord
- TASK-203: Source merger — deduplicate, fill null fields from secondary source, prefer adsb.fi for speed fields, OpenSky for coverage
- TASK-204: Aircraft configuration loader — ICAO hex list, callsign mapping, aircraft type lookup
- TASK-205: Internal WebSocket publisher — fan-out normalised TelemetryRecords to Redis pub/sub
- TASK-206: Ingestion metrics — counts/second, source health, latency histogram (Prometheus)
- TASK-207: Local RTL-SDR adapter (optional, for production demo) — read from dump1090-fa JSON endpoint, normalise to TelemetryRecord

### PHASE 3 — UTXO Management & Wallet Service

**Sub-agent: Blockchain Core**
- TASK-301: WalletVault class — HD key derivation, ICAO-to-index mapping, master seed loading
- TASK-302: UTXO pool database schema + migrations
- TASK-303: Bootstrap UTXO loader — on startup, query WoC UTXO API for each aircraft wallet, populate pool
- TASK-304: UTXO selector — atomically lock and return best UTXO for spending
- TASK-305: UTXO confirmation handler — process ARC callbacks, delete spent UTXOs, insert change
- TASK-306: UTXO consolidation job — scheduled batch merge of fragmented UTXOs
- TASK-307: Auto-refill monitor — detect low balance, trigger top-up from funding wallet
- TASK-308: UTXO pool REST API — internal endpoint for blockchain writer to consume

### PHASE 4 — Blockchain Writer Service

**Sub-agent: Blockchain Writer**
- TASK-401: Transaction builder — compose OP_RETURN + change output using @bsv/sdk Transaction API
- TASK-402: Fee calculator — 100 sat/kb + 10% buffer, derive from tx serialised byte length
- TASK-403: ARC broadcaster — integrate @bsv/sdk ARC broadcaster, handle all status codes
- TASK-404: ARC callback receiver — HTTP endpoint for TAAL to push SEEN/MINED status updates
- TASK-405: Transaction queue — Redis-backed queue to handle burst periods without dropping records
- TASK-406: Write rate limiter — honour 1 tx/s per aircraft maximum, queue excess
- TASK-407: Blockchain writer metrics — tx/s, broadcast latency, mempool confirmations, failures
- TASK-408: Dead letter queue — failed broadcasts stored for retry with exponential backoff

### PHASE 5 — Overlay Node

**Sub-agent: Overlay/Indexing**
- TASK-501: Custom TopicManager — implement @bsv/overlay-services TopicManager for "tm_airchive" protocol
- TASK-502: Custom LookupService — query endpoints: by ICAO, by TxID, by time range, by flight
- TASK-503: Transaction parser — decode Airchive OP_RETURN protocol, extract TelemetryRecord
- TASK-504: Chain tracker integration — connect to WhatsOnChain for Merkle path retrieval
- TASK-505: Overlay Node HTTP server — Express app exposing BEEF/overlay submit + lookup endpoints
- TASK-506: REST explorer API — endpoints for the dashboard explorer feature
- TASK-507: Overlay Node WebSocket — push new indexed transactions to connected clients

### PHASE 6 — Alert Engine

**Sub-agent: Alert/Analytics**
- TASK-601: Rule engine — configurable threshold rules (altitude change rate, roll angle, emergency squawk, signal loss)
- TASK-602: Squawk change detector — special handling for 7700/7600/7500 (EMERGENCY triggers)
- TASK-603: Signal loss detection — alert if no update received for >30 seconds
- TASK-604: Alert persistence — store all alerts in PostgreSQL with acknowledgement tracking
- TASK-605: Alert notification adapter — email (SendGrid), webhook, SMS (Twilio) for critical alerts
- TASK-606: Alert API — REST endpoints for dashboard to fetch, filter, acknowledge alerts

### PHASE 7 — API Gateway Service

**Sub-agent: Gateway**
- TASK-701: Express/Fastify gateway app setup
- TASK-702: WebSocket hub — subscribe to Redis broadcast, fan-out to connected dashboard clients
- TASK-703: REST endpoint: GET /api/fleet — current state of all 15 aircraft
- TASK-704: REST endpoint: GET /api/aircraft/{icao} — current state of one aircraft
- TASK-705: REST endpoint: GET /api/aircraft/{icao}/history — historical telemetry from Overlay Node
- TASK-706: REST endpoint: GET /api/aircraft/{icao}/transactions — blockchain records from Overlay
- TASK-707: REST endpoint: GET /api/alerts — fetch alert log
- TASK-708: REST endpoint: GET /api/metrics — system health, tx rates, costs
- TASK-709: JWT authentication middleware
- TASK-710: Rate limiting + CORS

### PHASE 8 — Dashboard Frontend

**Sub-agent: Frontend**
- TASK-801: Next.js 15 app scaffold with Tailwind CSS, custom design tokens
- TASK-802: WebSocket hook — connect to gateway, manage reconnection, distribute to context
- TASK-803: 3D Globe component (CesiumJS/Resium) — aircraft markers, flight trails, altitude exaggeration
- TASK-804: Fleet status grid component — 15 aircraft cards with live data
- TASK-805: Aircraft selection state — click aircraft to focus globe + open detail panel
- TASK-806: Attitude indicator SVG component — animated artificial horizon
- TASK-807: Heading indicator SVG component — rotating compass rose
- TASK-808: Speed/altitude tape components — HUD-style readouts
- TASK-809: Vertical speed indicator gauge
- TASK-810: Autopilot modes display component
- TASK-811: Real-time altitude chart (Recharts, 60-second rolling window)
- TASK-812: Real-time speed chart (multi-line IAS/TAS/GS)
- TASK-813: Blockchain feed panel — live scrolling transaction list
- TASK-814: Overlay Node explorer pages (/explorer/aircraft, /explorer/tx)
- TASK-815: Alert panel — live alert log with severity indicators
- TASK-816: Emergency overlay — full-screen alarm for 7700/7600/7500 squawks
- TASK-817: Stats panel — tx count, bytes on chain, BSV cost ticker
- TASK-818: Dark/light theme toggle (default dark)
- TASK-819: Responsive layout (desktop-first, tablet-compatible)
- TASK-820: Loading states + skeleton screens

### PHASE 9 — Testing & Quality Assurance

**Sub-agent: QA**
- TASK-901: Unit tests — all @airchive/crypto, @airchive/telemetry-codec functions
- TASK-902: Integration tests — ingestion → redis → writer pipeline (mock APIs)
- TASK-903: UTXO management unit tests — pool lifecycle, locking, consolidation
- TASK-904: BSV transaction tests — build/sign/verify round-trip tests
- TASK-905: Overlay node tests — index, query, SPV verification
- TASK-906: E2E test — Playwright: dashboard loads, aircraft positions update, tx appears in feed
- TASK-907: Load test — 15 aircraft × 1 tx/s sustained for 1 hour (k6)
- TASK-908: Latency benchmarks — measure end-to-end: ADS-B receive → dashboard update

### PHASE 10 — Demo Data & Pitch Preparation

**Sub-agent: Demo/DevOps**
- TASK-1001: Demo mode — replay recorded ADS-B data if live feed unavailable
- TASK-1002: Seed 24 hours of flight data for 15 aircraft into overlay node for demo
- TASK-1003: One-click docker-compose demo environment
- TASK-1004: Pitch deck screenshots / screen recording automation
- TASK-1005: System architecture diagram (export from this document)
- TASK-1006: ROI calculator component on dashboard — "Cost saved vs. FDR replacement"

---

## 13. TECHNOLOGY STACK MATRIX

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Blockchain SDK** | @bsv/sdk | latest | Core BSV library |
| **TX Broadcast** | TAAL ARC | v1 | Transaction submission |
| **UTXO Lookup** | WoC API | v1 | Bootstrap only |
| **Overlay** | @bsv/overlay-services | latest | On-chain indexing |
| **Runtime** | Node.js | 22 LTS | All backend services |
| **Language** | TypeScript | 5.x | All code |
| **API Framework** | Fastify | 4.x | Gateway + overlay HTTP |
| **Message Bus** | Redis | 7 | Inter-service events |
| **Database** | PostgreSQL | 16 | UTXO pool + records |
| **ORM/Query** | Knex.js | 3.x | DB access layer |
| **Serialisation** | MessagePack | @msgpack/msgpack | Compact on-chain encoding |
| **Frontend** | Next.js | 15 | Dashboard app |
| **3D Globe** | CesiumJS | 1.115+ | Aircraft visualisation |
| **Charts** | Recharts | 2.x | Telemetry graphs |
| **UI Styling** | Tailwind CSS | 3.x | Design system |
| **Animation** | Framer Motion | 11.x | Panel transitions |
| **WebSocket** | ws (Node) | 8.x | Internal WS hub |
| **Monitoring** | Prometheus + Grafana | latest | Metrics |
| **Logging** | Pino | 9.x | Structured logs |
| **Containers** | Docker + Docker Compose | latest | Dev environment |
| **Orchestration** | Kubernetes | 1.29 | Production |
| **Testing** | Vitest + Playwright | latest | Unit + E2E |
| **CI/CD** | GitHub Actions | N/A | Pipeline |

---

## 14. APPENDIX A — ADS-B FIELD REFERENCE

### Fields Available from ADS-B Transponder (Mode S Extended Squitter)

| BDS Register | Name | Fields |
|-------------|------|--------|
| BDS 0,5 | Airborne Position | Lat, Lon, Alt (barometric) |
| BDS 0,6 | Surface Position | Lat, Lon, Ground speed, Heading |
| BDS 0,8 | Aircraft Identification | ICAO type + callsign |
| BDS 0,9 | Airborne Velocity | E/W velocity, N/S velocity, vertical rate, heading |
| BDS 6,1 | Aircraft Status | Squawk, emergency, intent change |
| BDS 6,5 | Aircraft Op Status | Version, NIC supplement, NACp, SIL, SDA |
| BDS 4,0 | Selected Vertical Intention | MCP/FCU alt, FMS alt, Baro setting |
| BDS 5,0 | Track/Turn Report | Roll angle, True track, Ground speed, Track rate, TAS |
| BDS 6,0 | Heading & Speed Report | Magnetic heading, IAS, Mach, vertical rate, TAS |
| BDS 4,4 | Meteorological Routine | Wind speed/dir, Static air temp, Humidity (when equipped) |
| BDS 4,5 | Meteorological Hazard | Turbulence, Wind shear, Icing, Wake vortex |

Notes:
- BDS 5,0 and 6,0 are only transmitted by aircraft equipped with ADS-B v2 transponders (generally post-2017 aircraft)
- Roll angle, magnetic heading, IAS, Mach, TAS — all available from ADS-B v2 without ACARS
- For older aircraft (ADS-B v0/v1), only position, altitude, groundspeed, and track are reliably available

---

## 15. APPENDIX B — BSV TRANSACTION STRUCTURE REFERENCE

### Airchive Protocol Transaction (v1)

```
INPUT (1x):
  TXID:           [32 bytes] - previous UTXO txid
  VOUT:           [4 bytes]  - previous UTXO output index
  SCRIPT_LEN:     [varint]
  UNLOCKING SCRIPT: [P2PKH: OP_DATA <sig> OP_DATA <pubkey>] ~107 bytes
  SEQUENCE:       [4 bytes]

OUTPUT 0 (OP_RETURN — telemetry data):
  SATOSHIS:       [8 bytes]  = 0x00 00 00 00 00 00 00 00 (zero)
  SCRIPT_LEN:     [varint]
  LOCKING SCRIPT:
    OP_FALSE                 [1 byte]  0x00
    OP_RETURN                [1 byte]  0x6A
    OP_PUSHDATA <4>          [2 bytes] protocol prefix "SKYC" = 53 4B 59 43
    OP_PUSHDATA <1>          [2 bytes] version = 01
    OP_PUSHDATA <3>          [4 bytes] ICAO hex (binary, 3 bytes)
    OP_PUSHDATA <8>          [9 bytes] timestamp milliseconds (uint64 LE)
    OP_PUSHDATA <N>          [1-3 bytes + N] MessagePack TelemetryRecord

OUTPUT 1 (P2PKH change back to aircraft wallet):
  SATOSHIS:       [8 bytes]  = (input satoshis - fee)
  SCRIPT_LEN:     [varint]
  LOCKING SCRIPT:
    OP_DUP OP_HASH160 <20 bytes pubkeyHash> OP_EQUALVERIFY OP_CHECKSIG [25 bytes]

LOCKTIME:         [4 bytes]  = 0x00 00 00 00
```

**Approximate total transaction size:** 500-700 bytes (well under 1kb → fee = 100 sats)

---

*Airchive Production Plan — End of Document*
*Prepared for corporate pitch and AI developer agent orchestration*
*Version 1.0 | April 2026*
