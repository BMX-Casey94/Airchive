import { describe, expect, it } from "vitest";
import { normaliseCallsign } from "@airchive/types";

describe("normaliseCallsign", () => {
  it("strips Mode S @ pads from unset callsigns", () => {
    expect(normaliseCallsign("@@@@@@@@")).toBeNull();
    expect(normaliseCallsign("@@@@@@")).toBeNull();
    expect(normaliseCallsign("@")).toBeNull();
  });

  it("keeps real callsigns and strips trailing pads", () => {
    expect(normaliseCallsign("BAW15L")).toBe("BAW15L");
    expect(normaliseCallsign("BAW15@@@")).toBe("BAW15");
    expect(normaliseCallsign("  qtr957  ")).toBe("QTR957");
  });

  it("rejects ICAO-hex placeholders and filler", () => {
    expect(normaliseCallsign("ABC123", "ABC123")).toBeNull();
    expect(normaliseCallsign("----")).toBeNull();
    expect(normaliseCallsign("????")).toBeNull();
    expect(normaliseCallsign("")).toBeNull();
    expect(normaliseCallsign(null)).toBeNull();
  });
});
