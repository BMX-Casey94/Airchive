import { describe, expect, it, vi, beforeEach } from "vitest";
import { RecordType, type TelemetryRecord } from "@airchive/types";
import {
  buildOpReturnPayload,
  encodeTelemetryPayload,
  RecordType as CodecRecordType,
} from "@airchive/telemetry-codec";
import { MAX_REJECT_REQUEUES, rebufferRejectedTransaction } from "../rebuffer-rejected.js";

vi.mock("@airchive/db", () => ({
  claimRejectRequeue: vi.fn(),
  insertPendingWrite: vi.fn(),
}));

import { claimRejectRequeue, insertPendingWrite } from "@airchive/db";

const claimMock = vi.mocked(claimRejectRequeue);
const insertMock = vi.mocked(insertPendingWrite);

function mockTelemetry(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    icao: "ABCDEF",
    callsign: "TEST01",
    reg: "G-TEST",
    squawk: "1234",
    aircraft_type: "A35K",
    category: "",
    ts: 1_704_067_200_000,
    ts_pos: 1_704_067_200_000,
    lat: 51.47,
    lon: -0.46,
    alt_baro: 32_000,
    alt_geom: 32_000,
    on_ground: false,
    gs: 450,
    ias: 280,
    tas: 470,
    mach: 0.78,
    track: 90,
    true_heading: 92,
    mag_heading: 90,
    baro_rate: 0,
    geom_rate: 0,
    roll: 0,
    wind_dir: 270,
    wind_speed: 40,
    oat: -45,
    tat: -12,
    nav_qnh: 1013,
    nav_alt_mcp: 32_000,
    nav_alt_fms: 32_000,
    nav_heading: 90,
    nav_modes: ["LNAV", "VNAV"],
    nic: 8,
    rc: 0,
    adsb_version: 2,
    position_source: 1,
    num_receivers: 3,
    emergency: "none",
    data_sources: ["adsbfi"],
    seq: 1,
    ...overrides,
  };
}

function sampleEnvelope(): Buffer {
  const telemetry = mockTelemetry();
  const payload = encodeTelemetryPayload(telemetry);
  return Buffer.from(
    buildOpReturnPayload(
      telemetry.icao,
      telemetry.ts,
      CodecRecordType.TELEMETRY,
      payload,
    ),
  );
}

describe("rebufferRejectedTransaction", () => {
  beforeEach(() => {
    claimMock.mockReset();
    insertMock.mockReset();
  });

  it("re-queues a parseable rejected envelope as a preserved pending write", async () => {
    const onQueued = vi.fn();
    claimMock.mockResolvedValueOnce({
      txid: "aa".repeat(32),
      aircraft_icao: "ABCDEF",
      record_type: RecordType.TELEMETRY,
      flight_id: "flight-1",
      op_return: sampleEnvelope(),
      reject_requeues: 1,
      reject_status: "REJECTED",
      reject_reason: "Missing inputs",
      reject_competing_txs: null,
    });
    insertMock.mockResolvedValueOnce(undefined);

    const outcome = await rebufferRejectedTransaction("aa".repeat(32), {
      db: {} as never,
      onQueued,
      rejection: {
        status: "REJECTED",
        reason: "Missing inputs",
        source: "sse",
      },
    });

    expect(outcome).toBe("requeued");
    expect(insertMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aircraft_icao: "ABCDEF",
        record_type: RecordType.TELEMETRY,
        flight_id: "flight-1",
        preserved: true,
      }),
    );
    expect(onQueued).toHaveBeenCalledOnce();
  });

  it("skips when the claim cannot be taken", async () => {
    claimMock.mockResolvedValueOnce(null);
    const outcome = await rebufferRejectedTransaction("bb".repeat(32), {
      db: {} as never,
      maxRequeues: MAX_REJECT_REQUEUES,
    });
    expect(outcome).toBe("skipped_no_claim");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("skips when the stored envelope is garbage", async () => {
    claimMock.mockResolvedValueOnce({
      txid: "cc".repeat(32),
      aircraft_icao: "ABCDEF",
      record_type: RecordType.TELEMETRY,
      flight_id: null,
      op_return: Buffer.from([1, 2, 3, 4]),
      reject_requeues: 1,
      reject_status: "DOUBLE_SPEND_ATTEMPTED",
      reject_reason: "Conflicting spend",
      reject_competing_txs: ["dd".repeat(32)],
    });

    const outcome = await rebufferRejectedTransaction("cc".repeat(32), {
      db: {} as never,
    });
    expect(outcome).toBe("skipped_unparseable");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
