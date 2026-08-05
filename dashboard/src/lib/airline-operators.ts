/**
 * ICAO airline designators → operator names for the fleets Airchive tracks.
 * Callsigns on ADS-B are typically `{designator}{flight}` (e.g. BAW15L, QTR957).
 */
const AIRLINE_BY_DESIGNATOR: Record<string, string> = {
  // UK / Ireland
  BAW: "British Airways",
  SHT: "British Airways",
  CFE: "British Airways CityFlyer",
  EZY: "easyJet",
  EZS: "easyJet Switzerland",
  EXS: "Jet2",
  TOM: "TUI Airways",
  VIR: "Virgin Atlantic",
  VJT: "VistaJet",
  RYR: "Ryanair",
  RUK: "Ryanair UK",
  EIN: "Aer Lingus",
  // Qatar / Middle East / Gulf
  QTR: "Qatar Airways",
  UAE: "Emirates",
  ETD: "Etihad Airways",
  ABY: "Air Arabia",
  FDB: "flydubai",
  // Asia-Pacific
  CPA: "Cathay Pacific",
  HKE: "Hong Kong Airlines",
  SIA: "Singapore Airlines",
  TGW: "Scoot",
  QFA: "Qantas",
  VOZ: "Virgin Australia",
  ANA: "All Nippon Airways",
  JAL: "Japan Airlines",
  CES: "China Eastern",
  CCA: "Air China",
  CSN: "China Southern",
  EVA: "EVA Air",
  CAL: "China Airlines",
  // Europe / North America / other long-haul
  AFR: "Air France",
  KLM: "KLM",
  DLH: "Lufthansa",
  CFG: "Condor",
  EFW: "Lufthansa Cargo",
  THY: "Turkish Airlines",
  IBE: "Iberia",
  AAL: "American Airlines",
  UAL: "United Airlines",
  DAL: "Delta Air Lines",
  ACA: "Air Canada",
  AIC: "Air India",
  ETH: "Ethiopian Airlines",
  SWR: "Swiss",
  AUA: "Austrian Airlines",
  SAS: "SAS",
  FIN: "Finnair",
  LOT: "LOT Polish Airlines",
  TAP: "TAP Air Portugal",
  ICL: "CAL Cargo",
  BOX: "AeroLogic",
  GEC: "Lufthansa Cargo",
  // Military / state (common RAF callsigns)
  RRR: "Royal Air Force",
  ASY: "Royal Air Force",
  RFR: "Royal Air Force",
  // Codeshares / wet-lease seen on tracked frames
  GXW: "GlobalX",
  LAN: "LATAM",
  AMX: "Aeroméxico",
};

/**
 * Unambiguous registration-prefix → operator hints when the airframe is quiet
 * and no callsign is available. Kept narrow so a shared prefix never mislabels.
 */
function operatorFromRegistration(reg: string | null | undefined): string | null {
  const r = reg?.trim().toUpperCase();
  if (!r) return null;

  if (r.startsWith("A7-")) return "Qatar Airways";
  if (r.startsWith("B-LX") || r.startsWith("B-LQ") || r.startsWith("B-H")) {
    return "Cathay Pacific";
  }
  if (/^ZZ\d|^ZP\d|^ZM\d/.test(r)) return "Royal Air Force";
  if (r.startsWith("9V-")) return "Singapore Airlines";

  return null;
}

/** Leading ICAO airline designator from an ADS-B callsign. */
export function callsignDesignator(callsign: string | null | undefined): string | null {
  // Strip Mode S '@' pads before matching (e.g. BAW15@@@ → BAW15).
  const cs = callsign?.replace(/@/g, "").trim().toUpperCase();
  if (!cs || !/[A-Z0-9]/.test(cs)) return null;
  const match = cs.match(/^([A-Z]{3})(?=[0-9A-Z])/);
  if (!match) return null;
  return match[1];
}

export function operatorFromCallsign(callsign: string | null | undefined): string | null {
  const designator = callsignDesignator(callsign);
  if (!designator) return null;
  return AIRLINE_BY_DESIGNATOR[designator] ?? null;
}

/**
 * Best available operator name: curated static entry, then callsign designator,
 * then a conservative registration hint.
 */
export function resolveOperator(opts: {
  curated?: string | null;
  callsign?: string | null;
  registration?: string | null;
}): string | null {
  const curated = opts.curated?.trim();
  if (curated) return curated;

  return (
    operatorFromCallsign(opts.callsign)
    ?? operatorFromRegistration(opts.registration)
  );
}
