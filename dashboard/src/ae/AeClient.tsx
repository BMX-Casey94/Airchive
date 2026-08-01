"use client";

import dynamic from "next/dynamic";

/**
 * The AE engine is WebGL-only, so the view is loaded client-side with a void
 * placeholder that matches the scene's clear colour — no flash on entry.
 */
const AeView = dynamic(() => import("./AeView"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-[#02040a]" />,
});

export default function AeClient() {
  return <AeView />;
}
