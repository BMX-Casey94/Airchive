# Airchive -- Production Plan v2.0

> Reference document for the Airchive BSV blockchain aircraft telemetry platform.
> See the original v1.0 plan at `../AIRCHIVE_PRODUCTION_PLAN.md` for foundational context.

This file is a saved copy of the improved plan for quick reference during development.
It should NOT be edited during implementation -- treat it as read-only reference material.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   DATA INGESTION LAYER                       │
│  OpenSky REST (1s poll) + adsb.fi REST + Local RTL-SDR Feed │
└───────────────────────┬─────────────────────────────────────┘
                        │ Raw State Vectors (JSON)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│          TELEMETRY NORMALISATION + DEDUP FILTER              │
│  Merge multi-source feeds → canonical TelemetryRecord        │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│           FLIGHT PHASE STATE MACHINE (NEW)                   │
│  Detect: PARKED → TAXI → TAKEOFF → CLIMB → CRUISE →         │
│          DESCENT → APPROACH → LANDING → TAXI_IN → PARKED     │
│  Emergency override: 7700/7600/7500 → max write rate         │
└───────────────────────┬─────────────────────────────────────┘
                        │ Phase events + gated telemetry
                        ▼
┌─────────────────────────────────────────────────────────────┐
│         ADAPTIVE WRITE RATE CONTROLLER (NEW)                 │
│  PARKED: 1tx/5min | TAXI: 1tx/30s | CRUISE: 1tx/5s          │
│  TAKEOFF/CLIMB/DESCENT/APPROACH/LANDING: 1tx/s               │
│  EMERGENCY: 1tx/s override                                   │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│            BSV TRANSACTION COMPOSER (@bsv/sdk)               │
│  RECORD_TYPE: 0x01=TELEMETRY, 0x02=FLIGHT_EVENT, 0x03=DELTA │
│  + Flight Event summary transactions at phase transitions    │
│  + Offline write buffer for resilience                       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│         BSV OVERLAY NODE + DASHBOARD + ALERTS                │
└─────────────────────────────────────────────────────────────┘
```

## Key Improvements (v2.0)

1. **Flight Phase State Machine** -- deterministic detection of 9 flight phases
2. **Adaptive Write Rates** -- ~89% cost reduction (9,420 vs 86,400 tx/aircraft/day)
3. **Flight Event Summaries** -- human-readable on-chain narrative at phase transitions
4. **Airport Proximity Detection** -- OurAirports dataset for location context
5. **Flight Session Management** -- UUID per gate-to-gate flight
6. **Offline Write Buffer** -- guaranteed delivery on connectivity loss
7. **Delta Compression** -- reduced payload during stable cruise
8. **Multi-Tenant Preparation** -- schema-level readiness for enterprise

## Adaptive Write Rate Cost Model (per aircraft, 8h flight day)

| Phase              | Duration | Rate       | Transactions |
|--------------------|----------|------------|--------------|
| Parked             | 14.5h    | 1 tx/5min  | 174          |
| Taxi-Out           | 0.25h    | 1 tx/30s   | 30           |
| Takeoff            | 3 min    | 1 tx/s     | 180          |
| Climb              | 0.5h     | 1 tx/s     | 1,800        |
| Cruise             | 6.5h     | 1 tx/5s    | 4,680        |
| Descent            | 0.5h     | 1 tx/s     | 1,800        |
| Approach + Landing | 12 min   | 1 tx/s     | 720          |
| Taxi-In            | 0.25h    | 1 tx/30s   | 30           |
| Flight Events      | --       | per event  | ~6           |
| **Total**          | **24h**  | **adaptive** | **~9,420** |

15 aircraft: ~141,300 tx/day = ~0.141 BSV = ~£4.52/day
1,000 aircraft fleet: ~£301/day

## OP_RETURN Protocol (v1.1)

```
OP_RETURN
  "SKYC"           (4 bytes -- protocol ID)
  0x01             (1 byte -- version)
  <ICAO_HEX>      (3 bytes -- binary ICAO)
  <TIMESTAMP>      (8 bytes -- Unix ms, uint64 LE)
  <RECORD_TYPE>    (1 byte -- 0x01=TELEMETRY, 0x02=FLIGHT_EVENT, 0x03=TELEMETRY_DELTA)
  <PAYLOAD>        (N bytes -- MessagePack)
```

## Technology Stack

- **Language:** TypeScript 5.x (all code)
- **Runtime:** Node.js 22 LTS
- **Blockchain:** @bsv/sdk + TAAL ARC + @bsv/overlay-services
- **Database:** PostgreSQL 16 (Knex.js)
- **Message Bus:** Redis 7
- **Frontend:** Next.js 15 + CesiumJS + Recharts + Tailwind CSS
- **Serialisation:** MessagePack (@msgpack/msgpack)
- **API:** Fastify 4.x
- **Testing:** Vitest + Playwright
- **Containers:** Docker Compose (dev) / Kubernetes (prod)
