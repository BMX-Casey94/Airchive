"use client";

import { useEffect, useRef, useState } from "react";
import { useFleetStore } from "@/stores/fleet";
import { useAircraftStore } from "@/stores/aircraft-store";
import { aircraftColourHex, aircraftSprite } from "./aircraft-style";
import { loadPersistedTrails, persistTrails } from "@/lib/trail-persistence";
import type { AircraftState, PositionSnapshot } from "@/types/dashboard";

/** Inlined by Next from next.config `env` + dotenv loading workspace `.env`. */
const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";

const ALT_EXAGGERATION = 6;
const AUTO_ROTATE_SPEED = 0.025;
const AIRCRAFT_ICON_SIZE = 26;
const AIRCRAFT_ICON_SIZE_SELECTED = 34;
const AIRCRAFT_LABEL_OFFSET_Y = -22;
const FLY_TO_ALTITUDE = 800_000;
const GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE = 0;

/**
 * Callsigns only render inside this camera range. Every aircraft carried a
 * permanent label, so a few hundred over Europe merged into an unreadable
 * block that hid the globe behind it. Labels now appear as the view closes in
 * on a region, where there is room for them.
 */
const LABEL_VISIBLE_DISTANCE_M = 3_000_000;

/** Markers shrink with distance so a crowded continent stays legible. */
const ICON_SCALE_NEAR_M = 150_000;
const ICON_SCALE_FAR_M = 22_000_000;
const ICON_SCALE_NEAR = 1.15;
const ICON_SCALE_FAR = 0.5;

/**
 * Vertices drawn per aircraft. The stored path can be far longer; it is
 * sampled down to this, so the whole route is shown end to end at a cost that
 * does not grow with flight duration. The selection gets a much larger budget
 * because it is the one being examined closely.
 */
const TRAIL_POINTS_DEFAULT = 160;
const TRAIL_POINTS_SELECTED = 1_200;
const TRAIL_MIN_ALTITUDE_M = 100;

/**
 * A silence longer than this means the aircraft left coverage rather than flew
 * a straight line. Drawing across the gap would invent a route it never took,
 * so the path is broken into separate segments instead.
 */
const TRAIL_GAP_MS = 12 * 60_000;

/** Breaks a path wherever the feed went quiet for longer than TRAIL_GAP_MS. */
function splitOnGaps(points: PositionSnapshot[]): PositionSnapshot[][] {
  const segments: PositionSnapshot[][] = [];
  let current: PositionSnapshot[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const previous = points[i - 1];
    if (previous && point.ts - previous.ts > TRAIL_GAP_MS) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length >= 2) segments.push(current);

  return segments;
}

/** Evenly thins a segment to `max` vertices, always keeping both ends. */
function sampleForDisplay(
  points: PositionSnapshot[],
  max: number,
): PositionSnapshot[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: PositionSnapshot[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/** Trails are written back to storage on this cadence, not on every update. */
const TRAIL_PERSIST_INTERVAL_MS = 15_000;

type CesiumNs = typeof import("cesium");

function aircraftIconSize(isSelected: boolean): number {
  return isSelected ? AIRCRAFT_ICON_SIZE_SELECTED : AIRCRAFT_ICON_SIZE;
}

/** The generated sprite points north, so only the track rotation applies. */
function trackToRotation(trackDeg: number): number {
  return -(trackDeg * Math.PI) / 180;
}

function labelVisible(Cesium: CesiumNs, always: boolean): import("cesium").DistanceDisplayCondition {
  return new Cesium.DistanceDisplayCondition(
    0,
    always ? Number.MAX_VALUE : LABEL_VISIBLE_DISTANCE_M,
  );
}

function constant<T>(Cesium: CesiumNs, value: T): import("cesium").Property {
  return new Cesium.ConstantProperty(value) as unknown as import("cesium").Property;
}

function GlobeFallback({ reason }: { reason: string }) {
  return (
    <div className="flex h-full min-h-[50vh] w-full items-center justify-center bg-space-black">
      <div className="panel max-w-lg p-8 text-center space-y-4">
        <h3 className="text-lg font-semibold text-white">3D Globe</h3>
        <p className="text-sm text-hud-muted leading-relaxed">{reason}</p>
        <p className="text-xs text-hud-muted">
          Ensure <code className="data-readout text-[10px]">public/cesium</code> exists
          (run <code className="text-neon-amber">pnpm run postinstall</code> in{" "}
          <code className="text-[10px]">dashboard</code>) and set{" "}
          <code className="data-readout text-[10px]">NEXT_PUBLIC_CESIUM_ION_TOKEN</code>{" "}
          in <code className="text-[10px] text-neon-amber">Intelegentic/.env</code>.
        </p>
      </div>
    </div>
  );
}

const TRAIL_ENTITY_PREFIX = "__trail__";

export default function GlobeViewInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<import("cesium").Viewer | null>(null);
  const cesiumRef = useRef<CesiumNs | null>(null);
  const tickRef = useRef<(() => void) | null>(null);
  const handlerRef = useRef<import("cesium").ScreenSpaceEventHandler | null>(null);
  const rafRef = useRef<number>(0);
  const hasFlewRef = useRef<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const selectGlobeAircraft = useFleetStore((s) => s.selectAircraft);
  const selectPanelAircraft = useAircraftStore((s) => s.selectAircraft);

  /* ── Trails survive a reload ─────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;

    void loadPersistedTrails().then((restored) => {
      if (!cancelled && restored.size > 0) {
        useFleetStore.getState().hydrateTrails(restored);
      }
    });

    const flush = () => {
      void persistTrails(useFleetStore.getState().trails);
    };
    const timer = setInterval(flush, TRAIL_PERSIST_INTERVAL_MS);
    // A tab closed or backgrounded between ticks would otherwise lose
    // everything gathered since the last one.
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      flush();
    };
  }, []);

  /* ── One-time Cesium Viewer (loaded from /cesium/Cesium.js static asset) ─ */
  useEffect(() => {
    if (!CESIUM_TOKEN) {
      setLoadError("missing_token");
      return;
    }
    if (!containerRef.current) return;

    let cancelled = false;

    function initViewer(Cesium: CesiumNs) {
      if (cancelled || !containerRef.current) return;

      Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

      const viewer = new Cesium.Viewer(containerRef.current, {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        vrButton: false,
        scene3DOnly: true,
        infoBox: false,
        selectionIndicator: false,
      });

      viewer.scene.globe.enableLighting = true;
      // Allow the globe itself to occlude aircraft on the far side.
      viewer.scene.globe.depthTestAgainstTerrain = true;

      // Render at the native device resolution so the globe, labels, and
      // icons are sharp on high-DPI / Retina mobile screens instead of
      // being up-scaled from a 1× CSS-pixel canvas.
      viewer.resolutionScale = window.devicePixelRatio ?? 1;

      cesiumRef.current = Cesium;
      viewerRef.current = viewer;

      void (async () => {
        try {
          const provider = await Cesium.createWorldImageryAsync({
            style: Cesium.IonWorldImageryStyle.AERIAL,
          });
          if (viewer.isDestroyed()) return;
          viewer.scene.imageryLayers.removeAll();
          const layer = viewer.scene.imageryLayers.addImageryProvider(provider);
          layer.brightness = 0.35;
          layer.contrast = 1.3;
          layer.saturation = 0.3;
        } catch {
          /* keep default imagery */
        }
      })();

      if (!cancelled) setReady(true);
    }

    const win = window as unknown as { Cesium?: CesiumNs };
    (globalThis as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = "/cesium/";

    if (win.Cesium) {
      try {
        initViewer(win.Cesium);
      } catch (e) {
        console.error("[GlobeViewInner] Cesium init failed:", e);
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    } else {
      const existingScript = document.querySelector('script[src="/cesium/Cesium.js"]');
      if (existingScript) {
        existingScript.addEventListener("load", () => {
          if (win.Cesium && !cancelled) initViewer(win.Cesium);
          else if (!cancelled) setLoadError("Cesium failed to load from static assets");
        });
      } else {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/cesium/Widgets/widgets.css";
        document.head.appendChild(link);

        const script = document.createElement("script");
        script.src = "/cesium/Cesium.js";
        script.async = true;
        script.onload = () => {
          if (win.Cesium && !cancelled) {
            try {
              initViewer(win.Cesium);
            } catch (e) {
              console.error("[GlobeViewInner] Cesium init failed:", e);
              setLoadError(e instanceof Error ? e.message : String(e));
            }
          }
        };
        script.onerror = () => {
          if (!cancelled) setLoadError("Failed to load /cesium/Cesium.js — run postinstall in dashboard");
        };
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      handlerRef.current?.destroy();
      handlerRef.current = null;
      if (tickRef.current && viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.clock.onTick.removeEventListener(tickRef.current);
        tickRef.current = null;
      }
      viewerRef.current?.destroy();
      viewerRef.current = null;
      cesiumRef.current = null;
      setReady(false);
    };
  }, []);

  /* ── Subscribe to fleet store outside React render cycle ─ */
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !ready || viewer.isDestroyed()) return;

    /* Click handler */
    handlerRef.current?.destroy();
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handlerRef.current = handler;
    handler.setInputAction(
      (click: { position: import("cesium").Cartesian2 }) => {
        const picked = viewer.scene.pick(click.position);
        if (Cesium.defined(picked) && picked.id?.id) {
          const icao = picked.id.id as string;
          const cur = useFleetStore.getState().selectedIcao;
          const toggled = icao === cur ? null : icao;
          selectGlobeAircraft(toggled);
          selectPanelAircraft(toggled);
        } else {
          selectGlobeAircraft(null);
          selectPanelAircraft(null);
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    /* Auto-rotate tick */
    const rotateTick = () => {
      if (!viewer.isDestroyed() && !useFleetStore.getState().selectedIcao) {
        viewer.scene.camera.rotate(
          Cesium.Cartesian3.UNIT_Z,
          (AUTO_ROTATE_SPEED * Math.PI) / 180,
        );
      }
    };
    viewer.clock.onTick.addEventListener(rotateTick);
    tickRef.current = rotateTick;

    const pixelRatio = window.devicePixelRatio ?? 1;
    const scaleByDistance = new Cesium.NearFarScalar(
      ICON_SCALE_NEAR_M,
      ICON_SCALE_NEAR,
      ICON_SCALE_FAR_M,
      ICON_SCALE_FAR,
    );
    /** Paths already drawn, so untouched trails are not rebuilt every tick. */
    const trailRevision = new Map<string, string>();

    /** Sync Cesium entities with the fleet store (runs outside React render). */
    function syncEntities() {
      const v = viewerRef.current;
      const C = cesiumRef.current;
      if (!v || !C || v.isDestroyed()) return;

      const { aircraft: acMap, trails, selectedIcao } = useFleetStore.getState();

      const seenIds = new Set<string>();

      for (const ac of acMap.values()) {
        if (ac.lat === 0 && ac.lon === 0) continue;
        seenIds.add(ac.icao);

        const colourHex = aircraftColourHex(ac);
        const colour = C.Color.fromCssColorString(colourHex);
        const isSelected = selectedIcao === ac.icao;
        const isUrgent = ac.emergency !== "none";
        const sprite = aircraftSprite(colourHex, pixelRatio);
        const iconSize = aircraftIconSize(isSelected);
        const rotation = trackToRotation(ac.track);
        const position = C.Cartesian3.fromDegrees(
          ac.lon,
          ac.lat,
          ac.altBaro * ALT_EXAGGERATION,
        );
        // Shading is baked into the sprite, so the billboard must not tint it.
        const labelText = ac.callsign || ac.icao;
        const labelCondition = labelVisible(C, isSelected || isUrgent);

        let entity = v.entities.getById(ac.icao);
        if (entity) {
          (entity.position as import("cesium").ConstantPositionProperty).setValue(position);
          if (!entity.billboard) {
            entity.billboard = new C.BillboardGraphics({
              image: sprite,
              width: iconSize,
              height: iconSize,
              rotation,
              alignedAxis: C.Cartesian3.UNIT_Z,
              horizontalOrigin: C.HorizontalOrigin.CENTER,
              verticalOrigin: C.VerticalOrigin.CENTER,
              scaleByDistance,
              disableDepthTestDistance: GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE,
            });
            entity.point = undefined;
          } else {
            entity.billboard.image = constant(C, sprite);
            entity.billboard.width = constant(C, iconSize);
            entity.billboard.height = constant(C, iconSize);
            entity.billboard.rotation = constant(C, rotation);
            entity.billboard.scaleByDistance = constant(C, scaleByDistance);
            entity.billboard.disableDepthTestDistance = constant(
              C,
              GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE,
            );
          }
          entity.label!.text = constant(C, labelText);
          entity.label!.fillColor = constant(C, colour);
          entity.label!.pixelOffset = constant(
            C,
            new C.Cartesian2(0, AIRCRAFT_LABEL_OFFSET_Y),
          );
          entity.label!.distanceDisplayCondition = constant(C, labelCondition);
          entity.label!.disableDepthTestDistance = constant(
            C,
            GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE,
          );
        } else {
          v.entities.add({
            id: ac.icao,
            position,
            billboard: {
              image: sprite,
              width: iconSize,
              height: iconSize,
              rotation,
              alignedAxis: C.Cartesian3.UNIT_Z,
              horizontalOrigin: C.HorizontalOrigin.CENTER,
              verticalOrigin: C.VerticalOrigin.CENTER,
              scaleByDistance,
              disableDepthTestDistance: GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE,
            },
            label: {
              text: labelText,
              font: "12px JetBrains Mono, monospace",
              fillColor: colour,
              outlineColor: C.Color.BLACK,
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              pixelOffset: new C.Cartesian2(0, AIRCRAFT_LABEL_OFFSET_Y),
              showBackground: true,
              backgroundColor: C.Color.BLACK.withAlpha(0.55),
              distanceDisplayCondition: labelCondition,
              disableDepthTestDistance: GLOBE_OCCLUSION_DEPTH_TEST_DISTANCE,
            },
          });
        }

        /* Flight path. Every aircraft draws its whole stored route, not a
           short tail, because seeing where traffic came from is the point of
           having trails at all. Cost is held down by sampling vertices rather
           than by discarding history. */
        const trail = trails.get(ac.icao);
        const budget = isSelected ? TRAIL_POINTS_SELECTED : TRAIL_POINTS_DEFAULT;
        const segments =
          trail && trail.length >= 2
            ? splitOnGaps(trail)
                .map((segment) => sampleForDisplay(segment, budget))
                .filter((segment) => segment.length >= 2)
            : [];

        for (let s = 0; s < segments.length; s++) {
          seenIds.add(`${TRAIL_ENTITY_PREFIX}${ac.icao}:${s}`);
        }

        // Keyed on the stored length rather than the drawn length: once a path
        // exceeds its vertex budget the drawn count stops changing, and a
        // signature built from it would freeze the trail in place.
        const signature = `${isSelected ? "s" : "u"}:${trail?.length ?? 0}:${segments.length}`;

        if (trailRevision.get(ac.icao) !== signature) {
          trailRevision.set(ac.icao, signature);

          for (let s = 0; s < segments.length; s++) {
            const segment = segments[s]!;
            const segmentId = `${TRAIL_ENTITY_PREFIX}${ac.icao}:${s}`;
            // Altitude is carried through, so a climb-out visibly rises off
            // the surface rather than lying flat against it.
            const positions = segment.map((p) =>
              C.Cartesian3.fromDegrees(
                p.lon,
                p.lat,
                Math.max(p.alt, TRAIL_MIN_ALTITUDE_M) * ALT_EXAGGERATION,
              ),
            );

            const material = isSelected
              ? new C.PolylineGlowMaterialProperty({
                  color: colour.withAlpha(0.85),
                  glowPower: 0.22,
                  taperPower: 0.45,
                })
              : new C.ColorMaterialProperty(colour.withAlpha(0.3));

            const existing = v.entities.getById(segmentId);
            if (existing?.polyline) {
              existing.polyline.positions = constant(C, positions);
              existing.polyline.material = material;
              existing.polyline.width = constant(C, isSelected ? 3 : 1.3);
            } else {
              v.entities.add({
                id: segmentId,
                polyline: {
                  positions,
                  width: isSelected ? 3 : 1.3,
                  material,
                  arcType: C.ArcType.NONE,
                },
              });
            }
          }
        }
      }

      /* Remove stale entities */
      const toRemove: import("cesium").Entity[] = [];
      const all = v.entities.values;
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e.id && !seenIds.has(e.id)) {
          toRemove.push(e);
        }
      }
      for (const e of toRemove) v.entities.remove(e);

      /* Fly to selected aircraft (once per selection) */
      if (selectedIcao && selectedIcao !== hasFlewRef.current) {
        const ac = acMap.get(selectedIcao);
        if (ac && !(ac.lat === 0 && ac.lon === 0)) {
          hasFlewRef.current = selectedIcao;
          void v.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(ac.lon, ac.lat, FLY_TO_ALTITUDE),
            duration: 1.8,
          });
        }
      } else if (!selectedIcao) {
        hasFlewRef.current = null;
      }
    }

    /* Subscribe to store changes — throttled to ~1 Hz to prevent CPU overload */
    let lastSyncTs = 0;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    const GLOBE_SYNC_INTERVAL_MS = 1_000;

    const throttledSync = () => {
      const now = Date.now();
      const elapsed = now - lastSyncTs;
      if (elapsed >= GLOBE_SYNC_INTERVAL_MS) {
        lastSyncTs = now;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(syncEntities);
      } else if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          lastSyncTs = Date.now();
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(syncEntities);
        }, GLOBE_SYNC_INTERVAL_MS - elapsed);
      }
    };

    const unsub = useFleetStore.subscribe(throttledSync);

    /* Initial sync */
    syncEntities();

    return () => {
      unsub();
      if (throttleTimer) clearTimeout(throttleTimer);
      cancelAnimationFrame(rafRef.current);
      handler.destroy();
      if (handlerRef.current === handler) handlerRef.current = null;
      if (tickRef.current && !viewer.isDestroyed()) {
        viewer.clock.onTick.removeEventListener(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [ready, selectGlobeAircraft, selectPanelAircraft]);

  if (!CESIUM_TOKEN || loadError === "missing_token") {
    return (
      <GlobeFallback reason="Set NEXT_PUBLIC_CESIUM_ION_TOKEN in Intelegentic/.env (or dashboard/.env.local), then restart the dev server." />
    );
  }

  if (loadError) {
    return <GlobeFallback reason={loadError} />;
  }

  return (
    <div className="relative h-full min-h-[50vh] w-full overflow-hidden rounded-xl">
      <div ref={containerRef} className="absolute inset-0 [&_.cesium-viewer-bottom]:hidden" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-space-black/80">
          <p className="hud-label animate-pulse">Initialising globe&hellip;</p>
        </div>
      )}
    </div>
  );
}
