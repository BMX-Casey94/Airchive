import type { Metadata } from "next";
import AeClient from "@/ae/AeClient";

const AE_TITLE = "AE Flight Map";
const AE_DESCRIPTION =
  "Live fleet telemetry on an azimuthal equidistant world disc — full "
  + "take-off to landing flight paths, rendered in real time.";

export const metadata: Metadata = {
  title: AE_TITLE,
  description: AE_DESCRIPTION,
  alternates: { canonical: "/ae" },
  openGraph: {
    title: AE_TITLE,
    description: AE_DESCRIPTION,
    url: "/ae",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Live flights on the azimuthal equidistant polar map",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: AE_TITLE,
    description: AE_DESCRIPTION,
    images: ["/og-image.png"],
  },
};

export default function AePage() {
  return <AeClient />;
}
