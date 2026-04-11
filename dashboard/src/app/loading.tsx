export default function Loading() {
  return (
    <div className="min-h-screen bg-space-black p-6 relative overflow-hidden">
      {/* ── Scanning line animation ───────────────────────── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-electric-cyan/30 to-transparent animate-scan-line" />
      </div>

      <div className="space-y-6">
        {/* ── Top stats row skeleton ──────────────────────── */}
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={`stat-${i}`}
              className="panel flex flex-col items-center px-4 py-5 min-w-[140px] animate-pulse"
            >
              <div className="h-2 w-14 rounded bg-panel-border mb-3" />
              <div className="h-6 w-20 rounded bg-panel-border" />
            </div>
          ))}
        </div>

        {/* ── Main content grid skeleton ──────────────────── */}
        <div className="grid grid-cols-12 gap-6">
          {/* Globe placeholder */}
          <div className="col-span-8 aspect-[16/10] panel animate-pulse flex items-center justify-center">
            <div className="h-32 w-32 rounded-full border border-panel-border bg-deep-navy/50" />
          </div>

          {/* Side panels */}
          <div className="col-span-4 space-y-6">
            {/* System health skeleton */}
            <div className="panel p-4 animate-pulse space-y-3">
              <div className="h-2 w-24 rounded bg-panel-border" />
              <div className="grid grid-cols-2 gap-3">
                <div className="h-3 rounded bg-panel-border" />
                <div className="h-3 rounded bg-panel-border" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="h-2 w-12 rounded bg-panel-border" />
                  <div className="h-4 w-20 rounded bg-panel-border" />
                </div>
                <div className="space-y-1">
                  <div className="h-2 w-16 rounded bg-panel-border" />
                  <div className="h-4 w-14 rounded bg-panel-border" />
                </div>
              </div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={`rate-${i}`} className="flex items-center gap-2">
                  <div className="h-3 w-12 rounded bg-panel-border" />
                  <div className="flex-1 h-1.5 rounded-full bg-panel-border" />
                  <div className="h-3 w-14 rounded bg-panel-border" />
                </div>
              ))}
            </div>

            {/* Flight timeline skeleton */}
            <div className="panel p-4 animate-pulse space-y-3">
              <div className="h-2 w-28 rounded bg-panel-border" />
              <div className="flex gap-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={`phase-${i}`}
                    className="h-2.5 rounded bg-panel-border"
                    style={{ flex: Math.random() * 3 + 1 }}
                  />
                ))}
              </div>
              <div className="h-3 rounded-full bg-panel-border" />
            </div>
          </div>
        </div>

        {/* ── Bottom section skeleton ─────────────────────── */}
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-8 panel p-4 animate-pulse space-y-3">
            <div className="h-2 w-32 rounded bg-panel-border" />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`row-${i}`} className="h-4 rounded bg-panel-border" />
            ))}
          </div>
          <div className="col-span-4 panel p-4 animate-pulse space-y-3">
            <div className="h-2 w-20 rounded bg-panel-border" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={`alert-${i}`} className="flex gap-2">
                <div className="h-3 w-3 rounded-full bg-panel-border" />
                <div className="h-3 flex-1 rounded bg-panel-border" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
