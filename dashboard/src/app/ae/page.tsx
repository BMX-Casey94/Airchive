import type { Metadata } from "next";
import AeClient from "@/ae/AeClient";

export const metadata: Metadata = {
  title: "AE Flight Map — Airchive",
  description:
    "Live fleet telemetry on an azimuthal equidistant world disc — full "
    + "take-off to landing flight paths, rendered in real time.",
};

export default function AePage() {
  return <AeClient />;
}
