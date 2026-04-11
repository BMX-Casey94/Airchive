"use client";

import { useEffect, useRef, useState } from "react";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { useFleetStore } from "@/stores/fleet";
import { useAircraftStore } from "@/stores/aircraft-store";
import type { AircraftState } from "@/types/dashboard";

/** Inlined by Next from next.config `env` + dotenv loading workspace `.env`. */
const CESIUM_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";

const ALT_EXAGGERATION = 6;
const AUTO_ROTATE_SPEED = 0.05;
const FLY_TO_ALTITUDE = 800_000;

type CesiumNs = typeof import("cesium");

function aircraftColour(
  Cesium: CesiumNs,
  ac: AircraftState,
): import("cesium").Color {
  if (ac.emergency !== "none") {
    return Cesium.Color.fromCssColorString("#FF3B5C");
  }
  if (ac.onGround) return Cesium.Color.fromCssColorString("#FFB800");
  return Cesium.Color.fromCssColorString("#00F5FF");
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

  /* ── One-time Cesium Viewer (dynamic import — no require() in browser) ─ */
  useEffect(() => {
    if (!CESIUM_TOKEN) {
      setLoadError("missing_token");
      return;
    }
    if (!containerRef.current) return;

    let cancelled = false;

    void (async () => {
      try {
        const Cesium = await import("cesium");
        if (cancelled || !containerRef.current) return;

        const g = globalThis as unknown as { CESIUM_BASE_URL?: string };
        g.CESIUM_BASE_URL = "/cesium/";

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

        cesiumRef.current = Cesium;
        viewerRef.current = viewer;

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

        if (!cancelled) setReady(true);
      } catch (e) {
        console.error(e);
        setLoadError(
          e instanceof Error ? e.message : "Failed to initialise CesiumJS",
        );
      }
    })();

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

    const trailColour = Cesium.Color.fromCssColorString("#00F5FF").withAlpha(0.5);

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

        const colour = aircraftColour(C, ac);
        const isSelected = selectedIcao === ac.icao;
        const position = C.Cartesian3.fromDegrees(
          ac.lon,
          ac.lat,
          ac.altBaro * ALT_EXAGGERATION,
        );

        let entity = v.entities.getById(ac.icao);
        if (entity) {
          (entity.position as import("cesium").ConstantPositionProperty).setValue(position);
          entity.point!.pixelSize = new C.ConstantProperty(isSelected ? 14 : 10) as unknown as import("cesium").Property;
          entity.point!.color = new C.ConstantProperty(colour) as unknown as import("cesium").Property;
          entity.label!.text = new C.ConstantProperty(ac.callsign || ac.icao) as unknown as import("cesium").Property;
          entity.label!.fillColor = new C.ConstantProperty(colour) as unknown as import("cesium").Property;
        } else {
          v.entities.add({
            id: ac.icao,
            position,
            point: {
              pixelSize: isSelected ? 14 : 10,
              color: colour,
              outlineColor: C.Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: ac.callsign || ac.icao,
              font: "12px JetBrains Mono, monospace",
              fillColor: colour,
              outlineColor: C.Color.BLACK,
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              pixelOffset: new C.Cartesian2(0, -16),
              showBackground: true,
              backgroundColor: C.Color.BLACK.withAlpha(0.6),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }

        /* Trail for selected aircraft */
        const trailId = TRAIL_ENTITY_PREFIX + ac.icao;
        const existingTrail = v.entities.getById(trailId);
        if (isSelected) {
          const trail = trails.get(ac.icao);
          if (trail && trail.length >= 2) {
            const positions = trail.map((p) =>
              C.Cartesian3.fromDegrees(
                p.lon,
                p.lat,
                Math.max(p.alt, 100) * ALT_EXAGGERATION,
              ),
            );
            if (existingTrail) {
              existingTrail.polyline!.positions = new C.ConstantProperty(positions) as unknown as import("cesium").Property;
            } else {
              v.entities.add({
                id: trailId,
                polyline: {
                  positions,
                  width: 2,
                  material: new C.ColorMaterialProperty(trailColour),
                  arcType: C.ArcType.NONE,
                },
              });
            }
          }
          seenIds.add(trailId);
        } else if (existingTrail) {
          v.entities.remove(existingTrail);
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

    /* Subscribe to store changes — runs outside React render cycle */
    const unsub = useFleetStore.subscribe(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(syncEntities);
    });

    /* Initial sync */
    syncEntities();

    return () => {
      unsub();
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
