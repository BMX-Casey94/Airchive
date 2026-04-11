export interface DataProduct {
  id: string;
  name: string;
  description: string;
  priceSats: number;
}

export const PRODUCTS: Record<string, DataProduct> = {
  live_telemetry: {
    id: "live_telemetry",
    name: "Live Telemetry Snapshot",
    description: "Latest telemetry for a single aircraft",
    priceSats: 1,
  },
  fleet_snapshot: {
    id: "fleet_snapshot",
    name: "Fleet Snapshot",
    description: "Current state of all tracked aircraft",
    priceSats: 5,
  },
  flight_history: {
    id: "flight_history",
    name: "Flight History",
    description: "Historical positions for a flight session",
    priceSats: 10,
  },
  phase_events: {
    id: "phase_events",
    name: "Phase Events",
    description: "Flight phase transitions for a session",
    priceSats: 5,
  },
};

export function getProduct(id: string): DataProduct | undefined {
  return PRODUCTS[id];
}

export function getPrice(productId: string): number {
  return PRODUCTS[productId]?.priceSats ?? 0;
}
