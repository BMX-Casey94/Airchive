/**
 * ICAO aircraft type designators to readable names.
 *
 * The curated registry in `tracked-aircraft.ts` only covers the original 15
 * aircraft, but the writer now archives anything that flies within range. Live
 * fleet state and the on-chain envelopes both carry a type designator, so an
 * aircraft the registry has never heard of can still be named from that rather
 * than reported as "type unknown".
 */
const AIRCRAFT_TYPE_NAMES: Record<string, string> = {
  // Airbus narrowbody
  A19N: "Airbus A319neo",
  A20N: "Airbus A320neo",
  A21N: "Airbus A321neo",
  A318: "Airbus A318",
  A319: "Airbus A319",
  A320: "Airbus A320",
  A321: "Airbus A321",

  // Airbus widebody
  A306: "Airbus A300-600",
  A310: "Airbus A310",
  A332: "Airbus A330-200",
  A333: "Airbus A330-300",
  A337: "Airbus A330-700 Beluga XL",
  A338: "Airbus A330-800neo",
  A339: "Airbus A330-900neo",
  A342: "Airbus A340-200",
  A343: "Airbus A340-300",
  A345: "Airbus A340-500",
  A346: "Airbus A340-600",
  A359: "Airbus A350-900",
  A35K: "Airbus A350-1000",
  A388: "Airbus A380-800",

  // Boeing narrowbody
  B712: "Boeing 717-200",
  B733: "Boeing 737-300",
  B734: "Boeing 737-400",
  B735: "Boeing 737-500",
  B736: "Boeing 737-600",
  B737: "Boeing 737-700",
  B738: "Boeing 737-800",
  B739: "Boeing 737-900",
  B37M: "Boeing 737 MAX 7",
  B38M: "Boeing 737 MAX 8",
  B39M: "Boeing 737 MAX 9",
  B3XM: "Boeing 737 MAX 10",
  B752: "Boeing 757-200",
  B753: "Boeing 757-300",

  // Boeing widebody
  B762: "Boeing 767-200",
  B763: "Boeing 767-300",
  B764: "Boeing 767-400",
  B772: "Boeing 777-200",
  B77L: "Boeing 777-200LR",
  B773: "Boeing 777-300",
  B77W: "Boeing 777-300ER",
  B778: "Boeing 777-8",
  B779: "Boeing 777-9",
  B788: "Boeing 787-8 Dreamliner",
  B789: "Boeing 787-9 Dreamliner",
  B78X: "Boeing 787-10 Dreamliner",
  B741: "Boeing 747-100",
  B742: "Boeing 747-200",
  B744: "Boeing 747-400",
  B748: "Boeing 747-8",
  B74F: "Boeing 747 Freighter",

  // Embraer, Bombardier, ATR and other regionals
  E135: "Embraer ERJ-135",
  E145: "Embraer ERJ-145",
  E170: "Embraer E170",
  E75L: "Embraer E175",
  E75S: "Embraer E175",
  E190: "Embraer E190",
  E195: "Embraer E195",
  E290: "Embraer E190-E2",
  E295: "Embraer E195-E2",
  BCS1: "Airbus A220-100",
  BCS3: "Airbus A220-300",
  CRJ2: "Bombardier CRJ200",
  CRJ7: "Bombardier CRJ700",
  CRJ9: "Bombardier CRJ900",
  CRJX: "Bombardier CRJ1000",
  DH8A: "De Havilland Dash 8-100",
  DH8C: "De Havilland Dash 8-300",
  DH8D: "De Havilland Dash 8-400",
  AT43: "ATR 42-300",
  AT45: "ATR 42-500",
  AT72: "ATR 72",
  AT75: "ATR 72-500",
  AT76: "ATR 72-600",
  SF34: "Saab 340",
  J328: "Dornier 328",
  F70: "Fokker 70",
  F100: "Fokker 100",

  // Business and general aviation
  C25A: "Cessna Citation CJ2",
  C25B: "Cessna Citation CJ3",
  C25C: "Cessna Citation CJ4",
  C56X: "Cessna Citation Excel",
  C68A: "Cessna Citation Latitude",
  C172: "Cessna 172 Skyhawk",
  C152: "Cessna 152",
  C182: "Cessna 182 Skylane",
  C208: "Cessna 208 Caravan",
  CL30: "Bombardier Challenger 300",
  CL35: "Bombardier Challenger 350",
  CL60: "Bombardier Challenger 600",
  GLEX: "Bombardier Global Express",
  GL5T: "Bombardier Global 5000",
  GLF4: "Gulfstream IV",
  GLF5: "Gulfstream V",
  GLF6: "Gulfstream G650",
  E55P: "Embraer Phenom 300",
  E50P: "Embraer Phenom 100",
  FA7X: "Dassault Falcon 7X",
  F2TH: "Dassault Falcon 2000",
  PC12: "Pilatus PC-12",
  PC24: "Pilatus PC-24",
  SR22: "Cirrus SR22",
  DA40: "Diamond DA40",
  DA42: "Diamond DA42",
  P28A: "Piper PA-28 Cherokee",
  BE20: "Beechcraft King Air 200",
  B350: "Beechcraft King Air 350",
  TBM9: "Daher TBM 900",

  // Military and state
  A400: "Airbus A400M Atlas",
  C17: "Boeing C-17 Globemaster III",
  C130: "Lockheed C-130 Hercules",
  C30J: "Lockheed C-130J Super Hercules",
  K35R: "Boeing KC-135 Stratotanker",
  P8: "Boeing P-8 Poseidon",
  E3TF: "Boeing E-3 Sentry",
  RC13: "Boeing RC-135 Rivet Joint",
  F15: "McDonnell Douglas F-15 Eagle",
  F16: "General Dynamics F-16 Fighting Falcon",
  EUFI: "Eurofighter Typhoon",
  F35: "Lockheed Martin F-35 Lightning II",
  HAWK: "BAE Systems Hawk",
  TEX2: "Beechcraft T-6 Texan II",

  // Rotary
  EC35: "Airbus H135",
  EC45: "Airbus H145",
  H500: "MD 500",
  A139: "Leonardo AW139",
  A169: "Leonardo AW169",
  A189: "Leonardo AW189",
  S76: "Sikorsky S-76",
  R44: "Robinson R44",
  R66: "Robinson R66",
};

/**
 * All-caps descriptions arrive straight from the ADS-B feed ("AIRBUS A-319").
 * Shouting at the reader is not house style, so they are cased down while
 * leaving short tokens that are genuinely acronyms alone.
 */
function normaliseDescription(desc: string): string {
  if (desc !== desc.toUpperCase()) return desc;

  return desc
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      // Anything carrying a digit is a model designation, not a word.
      if (/\d/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Readable name for an ICAO type designator, or null if it is not known. */
export function aircraftTypeName(typeCode: string | null | undefined): string | null {
  const key = typeCode?.trim().toUpperCase();
  if (!key) return null;
  return AIRCRAFT_TYPE_NAMES[key] ?? null;
}

/**
 * Best available description, preferring a curated name over the feed's own
 * wording, and falling back to the bare designator so the header never claims
 * the type is unknown when it plainly knows it.
 */
export function resolveAircraftDescription(
  curated: string | null,
  onChain: string | null,
  typeCode: string | null,
): string | null {
  if (curated) return curated;
  if (onChain) return normaliseDescription(onChain);

  const named = aircraftTypeName(typeCode);
  if (named) return named;

  return typeCode ? `Type ${typeCode.toUpperCase()}` : null;
}
