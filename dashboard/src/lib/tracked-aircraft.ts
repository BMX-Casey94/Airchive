export interface TrackedAircraftInfo {
  icao: string;
  reg: string;
  type: string;
  desc: string;
  operator: string;
}

/**
 * Static lookup for our 15 tracked aircraft.
 * Ensures every aircraft appears in the fleet list even when its
 * transponder is off and adsb.fi returns no data.
 */
export const TRACKED_AIRCRAFT: TrackedAircraftInfo[] = [
  { icao: "4076E8", reg: "G-XWBA", type: "A35K", desc: "Airbus A350-1041", operator: "British Airways" },
  { icao: "407798", reg: "G-XWBB", type: "A35K", desc: "Airbus A350-1041", operator: "British Airways" },
  { icao: "4072C7", reg: "G-UZHA", type: "A20N", desc: "Airbus A320-251N", operator: "easyJet" },
  { icao: "4072C8", reg: "G-UZHB", type: "A20N", desc: "Airbus A320-251N", operator: "easyJet" },
  { icao: "407131", reg: "G-VBOW", type: "B789", desc: "Boeing 787-9 Dreamliner", operator: "Virgin Atlantic" },
  { icao: "4077D3", reg: "G-VTEA", type: "A35K", desc: "Airbus A350-1041", operator: "Virgin Atlantic" },
  { icao: "4CA242", reg: "EI-DCL", type: "B738", desc: "Boeing 737-8AS", operator: "Ryanair" },
  { icao: "4CA568", reg: "EI-DWC", type: "B738", desc: "Boeing 737-8AS", operator: "Ryanair" },
  { icao: "43C6B8", reg: "ZZ177", type: "C17",  desc: "Boeing C-17A Globemaster III", operator: "Royal Air Force" },
  { icao: "43C6F3", reg: "ZZ330", type: "A332", desc: "Airbus A330-243 MRTT Voyager", operator: "Royal Air Force" },
  { icao: "43C6F9", reg: "ZZ336", type: "A332", desc: "Airbus A330-243 MRTT Voyager (VIP)", operator: "Royal Air Force" },
  { icao: "43C918", reg: "ZP801", type: "P8",   desc: "Boeing P-8A Poseidon MRA1", operator: "Royal Air Force" },
  { icao: "43C919", reg: "ZP802", type: "P8",   desc: "Boeing P-8A Poseidon MRA1", operator: "Royal Air Force" },
  { icao: "43C5EB", reg: "ZM417", type: "A400", desc: "Airbus A400M Atlas C1", operator: "Royal Air Force" },
  { icao: "43C61D", reg: "ZZ504", type: "SHDW", desc: "Beechcraft Shadow R1", operator: "Royal Air Force" },
];

export const TRACKED_AIRCRAFT_MAP = new Map(
  TRACKED_AIRCRAFT.map((a) => [a.icao, a]),
);
