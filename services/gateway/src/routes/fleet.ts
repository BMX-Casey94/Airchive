import type { FastifyInstance } from "fastify";
import type { TelemetryRecord } from "@airchive/types";
import { getDb } from "@airchive/db";

const aircraftState = new Map<string, TelemetryRecord & { phase?: string; flight_id?: string; last_updated: number }>();

const walletAddressCache = new Map<string, string>();

export function updateAircraftState(record: TelemetryRecord & { phase?: string; flight_id?: string }): void {
  aircraftState.set(record.icao.toUpperCase(), { ...record, last_updated: Date.now() });
}

async function resolveWalletAddress(icao: string): Promise<string | null> {
  const cached = walletAddressCache.get(icao);
  if (cached) return cached;

  const db = getDb();
  const row = await db("aircraft_config")
    .where({ icao })
    .select("wallet_address")
    .first();

  const addr = row?.wallet_address ?? null;
  if (addr) walletAddressCache.set(icao, addr);
  return addr;
}

export async function fleetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/fleet", async (_request, reply) => {
    const db = getDb();
    const configRows = await db("aircraft_config")
      .where({ enabled: true })
      .select("icao", "wallet_address");
    const addrMap = new Map<string, string | null>();
    for (const row of configRows) {
      addrMap.set(row.icao, row.wallet_address ?? null);
      if (row.wallet_address) walletAddressCache.set(row.icao, row.wallet_address);
    }

    const fleet = Array.from(aircraftState.values()).map((a) => ({
      icao: a.icao,
      callsign: a.callsign,
      lat: a.lat,
      lon: a.lon,
      alt_baro: a.alt_baro,
      gs: a.gs,
      track: a.track,
      on_ground: a.on_ground,
      phase: a.phase ?? "UNKNOWN",
      flight_id: a.flight_id,
      last_updated: a.last_updated,
      wallet_address: addrMap.get(a.icao.toUpperCase()) ?? null,
    }));
    return reply.send({ success: true, data: fleet });
  });

  app.get("/api/wallets", async (_request, reply) => {
    const db = getDb();
    const rows = await db("aircraft_config")
      .where({ enabled: true })
      .whereNotNull("wallet_address")
      .select("icao", "wallet_address", "wallet_index");

    const wallets = rows.map((r) => ({
      icao: r.icao as string,
      address: r.wallet_address as string,
      walletIndex: r.wallet_index as number,
      wocUrl: `https://whatsonchain.com/address/${r.wallet_address}`,
    }));

    return reply.send({
      success: true,
      data: {
        derivationPath: "m/44'/236'/0'/0/{index}",
        wallets,
      },
    });
  });

  app.get<{ Params: { icao: string } }>("/api/aircraft/:icao", async (request, reply) => {
    const icao = request.params.icao.toUpperCase();
    const current = aircraftState.get(icao);
    if (!current) {
      return reply.status(404).send({ success: false, error: "Aircraft not found or not tracked" });
    }

    const db = getDb();
    const [sessions, recentTx, walletAddress] = await Promise.all([
      db("flight_sessions")
        .where({ aircraft_icao: icao })
        .orderBy("started_at", "desc")
        .limit(1),
      db("tx_results")
        .where({ aircraft_icao: icao })
        .orderBy("timestamp", "desc")
        .limit(10),
      resolveWalletAddress(icao),
    ]);

    return reply.send({
      success: true,
      data: {
        current,
        activeSession: sessions[0] ?? null,
        recentTransactions: recentTx,
        walletAddress,
      },
    });
  });
}
