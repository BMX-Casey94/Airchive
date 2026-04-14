import type { FastifyInstance } from "fastify";
import type { TelemetryRecord } from "@airchive/types";
import { getDb } from "@airchive/db";

const aircraftState = new Map<string, GatewayAircraftState>();

const walletAddressCache = new Map<string, string>();

interface FleetConfigRow {
  icao: string;
  callsign?: string | null;
  reg?: string | null;
  aircraft_type?: string | null;
  wallet_address?: string | null;
}

type GatewayAircraftState = TelemetryRecord & {
  phase?: string;
  flight_phase?: string;
  flight_id?: string;
  last_updated: number;
  origin_icao?: string;
  origin_name?: string;
  dest_icao?: string;
  dest_name?: string;
};

export function updateAircraftState(record: Omit<GatewayAircraftState, "last_updated">): void {
  const phase = String(record.flight_phase ?? record.phase ?? "UNKNOWN").toUpperCase();
  aircraftState.set(record.icao.toUpperCase(), {
    ...record,
    phase,
    flight_phase: phase,
    last_updated: Date.now(),
  });
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
      .select("icao", "callsign", "reg", "aircraft_type", "wallet_address")
      .orderBy("wallet_index", "asc")
      .orderBy("icao", "asc") as FleetConfigRow[];
    const addrMap = new Map<string, string | null>();
    for (const row of configRows) {
      const icao = row.icao.toUpperCase();
      addrMap.set(icao, row.wallet_address ?? null);
      if (row.wallet_address) walletAddressCache.set(icao, row.wallet_address);
    }

    const fleet = configRows.map((row) => {
      const icao = row.icao.toUpperCase();
      const live = aircraftState.get(icao);
      const configCallsign = row.callsign && row.callsign !== icao ? row.callsign : "";

      return {
        icao,
        callsign: live?.callsign ?? configCallsign,
        reg: live?.reg ?? row.reg ?? "",
        aircraft_type: live?.aircraft_type ?? row.aircraft_type ?? "",
        category: live?.category ?? null,
        ts: live?.ts ?? 0,
        lat: live?.lat ?? null,
        lon: live?.lon ?? null,
        alt_baro: live?.alt_baro ?? null,
        alt_geom: live?.alt_geom ?? null,
        on_ground: live?.on_ground ?? false,
        gs: live?.gs ?? null,
        ias: live?.ias ?? null,
        tas: live?.tas ?? null,
        mach: live?.mach ?? null,
        track: live?.track ?? null,
        true_heading: live?.true_heading ?? null,
        mag_heading: live?.mag_heading ?? null,
        baro_rate: live?.baro_rate ?? null,
        geom_rate: live?.geom_rate ?? null,
        roll: live?.roll ?? null,
        squawk: live?.squawk ?? null,
        emergency: live?.emergency ?? "none",
        flight_phase: live?.flight_phase ?? live?.phase ?? "UNKNOWN",
        flight_id: live?.flight_id ?? null,
        wind_dir: live?.wind_dir ?? null,
        wind_speed: live?.wind_speed ?? null,
        oat: live?.oat ?? null,
        tat: live?.tat ?? null,
        nav_qnh: live?.nav_qnh ?? null,
        nav_alt_mcp: live?.nav_alt_mcp ?? null,
        nav_alt_fms: live?.nav_alt_fms ?? null,
        nav_heading: live?.nav_heading ?? null,
        nav_modes: live?.nav_modes ?? [],
        origin_icao: live?.origin_icao ?? null,
        origin_name: live?.origin_name ?? null,
        dest_icao: live?.dest_icao ?? null,
        dest_name: live?.dest_name ?? null,
        last_updated: live?.last_updated ?? 0,
        wallet_address: addrMap.get(icao) ?? null,
      };
    });
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
