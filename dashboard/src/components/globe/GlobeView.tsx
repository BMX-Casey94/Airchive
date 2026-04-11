"use client";

import GlobeViewInner from "./GlobeViewInner";

export default function GlobeView() {
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-xl"
      style={{
        WebkitMaskImage: [
          "linear-gradient(to right,  transparent 0%, black 55%, black 45%, transparent 100%)",
          "linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)",
        ].join(", "),
        WebkitMaskComposite: "destination-in",
        maskImage: [
          "linear-gradient(to right,  transparent 0%, black 55%, black 45%, transparent 100%)",
          "linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)",
        ].join(", "),
        maskComposite: "intersect",
      }}
    >
      <GlobeViewInner />
    </div>
  );
}
