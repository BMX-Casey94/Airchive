import * as THREE from "three";
import { projectLatLon } from "./projection";

/**
 * Country labels as billboard sprites anchored to hand-tuned visual centres
 * (computed centroids misplace elongated countries — Norway, Chile, Indonesia
 * — so a curated gazetteer is the cartographically correct choice).
 *
 * Labels render at constant screen size (no size attenuation) with a dark
 * halo for readability over both day and night imagery, and fade in by tier
 * as the camera closes in so the wide view stays uncluttered.
 */

interface CountryLabel {
  name: string;
  lat: number;
  lon: number;
  /** 1 = always visible, 2 = mid zoom, 3 = close zoom. */
  tier: 1 | 2 | 3;
}

const COUNTRY_LABELS: CountryLabel[] = [
  // Tier 1 — continental anchors, visible from the home view.
  { name: "United States", lat: 39.5, lon: -98.35, tier: 1 },
  { name: "Canada", lat: 58.5, lon: -101, tier: 1 },
  { name: "Greenland", lat: 72.5, lon: -41, tier: 1 },
  { name: "Brazil", lat: -10.5, lon: -52.5, tier: 1 },
  { name: "Argentina", lat: -35.5, lon: -65.5, tier: 1 },
  { name: "Russia", lat: 63, lon: 97, tier: 1 },
  { name: "China", lat: 34.5, lon: 103, tier: 1 },
  { name: "India", lat: 22.5, lon: 79.5, tier: 1 },
  { name: "Australia", lat: -25.5, lon: 134.5, tier: 1 },
  { name: "Kazakhstan", lat: 48, lon: 67, tier: 1 },
  { name: "Algeria", lat: 28, lon: 2.5, tier: 1 },
  { name: "Mexico", lat: 24, lon: -102.5, tier: 1 },
  { name: "Saudi Arabia", lat: 24, lon: 45, tier: 1 },
  { name: "Indonesia", lat: -0.5, lon: 113.5, tier: 1 },
  { name: "Egypt", lat: 26.5, lon: 29.5, tier: 1 },
  { name: "South Africa", lat: -29.5, lon: 24.5, tier: 1 },
  { name: "Mongolia", lat: 46.5, lon: 103.5, tier: 1 },
  { name: "Iran", lat: 32.5, lon: 54.5, tier: 1 },
  { name: "Libya", lat: 27, lon: 17.5, tier: 1 },
  { name: "DR Congo", lat: -3, lon: 23.5, tier: 1 },

  // Tier 2 — regional powers and large mid-size countries.
  { name: "United Kingdom", lat: 53.5, lon: -2, tier: 2 },
  { name: "France", lat: 46.6, lon: 2.4, tier: 2 },
  { name: "Germany", lat: 51.1, lon: 10.4, tier: 2 },
  { name: "Spain", lat: 40.2, lon: -3.6, tier: 2 },
  { name: "Italy", lat: 42.8, lon: 12.6, tier: 2 },
  { name: "Poland", lat: 52.1, lon: 19.4, tier: 2 },
  { name: "Ukraine", lat: 49, lon: 31.4, tier: 2 },
  { name: "Turkey", lat: 39, lon: 35.4, tier: 2 },
  { name: "Sweden", lat: 62.8, lon: 16.5, tier: 2 },
  { name: "Norway", lat: 61.6, lon: 9.1, tier: 2 },
  { name: "Finland", lat: 64.5, lon: 26, tier: 2 },
  { name: "Iceland", lat: 64.9, lon: -18.6, tier: 2 },
  { name: "Japan", lat: 36.5, lon: 138.5, tier: 2 },
  { name: "South Korea", lat: 36.4, lon: 127.9, tier: 2 },
  { name: "Thailand", lat: 15.1, lon: 101, tier: 2 },
  { name: "Vietnam", lat: 21.3, lon: 105.2, tier: 2 },
  { name: "Myanmar", lat: 21.3, lon: 96.5, tier: 2 },
  { name: "Pakistan", lat: 29.4, lon: 69.4, tier: 2 },
  { name: "Afghanistan", lat: 33.8, lon: 66, tier: 2 },
  { name: "Iraq", lat: 33, lon: 43.8, tier: 2 },
  { name: "Ethiopia", lat: 8.6, lon: 39.6, tier: 2 },
  { name: "Nigeria", lat: 9.1, lon: 8, tier: 2 },
  { name: "Niger", lat: 17.6, lon: 8.1, tier: 2 },
  { name: "Mali", lat: 17.4, lon: -4, tier: 2 },
  { name: "Chad", lat: 15.4, lon: 18.7, tier: 2 },
  { name: "Sudan", lat: 15.5, lon: 30.2, tier: 2 },
  { name: "Mauritania", lat: 20.3, lon: -10.3, tier: 2 },
  { name: "Morocco", lat: 31.9, lon: -6.3, tier: 2 },
  { name: "Angola", lat: -12.3, lon: 17.5, tier: 2 },
  { name: "Tanzania", lat: -6.4, lon: 34.9, tier: 2 },
  { name: "Kenya", lat: 0.5, lon: 37.9, tier: 2 },
  { name: "Mozambique", lat: -17.3, lon: 35.5, tier: 2 },
  { name: "Namibia", lat: -22.1, lon: 17.2, tier: 2 },
  { name: "Botswana", lat: -22.3, lon: 24.7, tier: 2 },
  { name: "Zambia", lat: -13.5, lon: 27.8, tier: 2 },
  { name: "Madagascar", lat: -19.4, lon: 46.7, tier: 2 },
  { name: "Somalia", lat: 6.1, lon: 45.9, tier: 2 },
  { name: "Colombia", lat: 3.9, lon: -73, tier: 2 },
  { name: "Venezuela", lat: 7.1, lon: -66, tier: 2 },
  { name: "Peru", lat: -9.2, lon: -74.4, tier: 2 },
  { name: "Bolivia", lat: -16.7, lon: -64.5, tier: 2 },
  { name: "Chile", lat: -35.7, lon: -71.2, tier: 2 },
  { name: "Uzbekistan", lat: 41.8, lon: 63.1, tier: 2 },
  { name: "Turkmenistan", lat: 39.1, lon: 59.4, tier: 2 },
  { name: "Papua New Guinea", lat: -6.5, lon: 145.2, tier: 2 },
  { name: "New Zealand", lat: -43.4, lon: 171.5, tier: 2 },
  { name: "Yemen", lat: 15.9, lon: 47.6, tier: 2 },

  // Tier 3 — appears once the camera is close.
  { name: "Ireland", lat: 53.2, lon: -8.2, tier: 3 },
  { name: "Portugal", lat: 39.6, lon: -8, tier: 3 },
  { name: "Netherlands", lat: 52.2, lon: 5.6, tier: 3 },
  { name: "Belgium", lat: 50.6, lon: 4.7, tier: 3 },
  { name: "Switzerland", lat: 46.8, lon: 8.2, tier: 3 },
  { name: "Austria", lat: 47.6, lon: 14.1, tier: 3 },
  { name: "Czechia", lat: 49.8, lon: 15.3, tier: 3 },
  { name: "Hungary", lat: 47.2, lon: 19.4, tier: 3 },
  { name: "Romania", lat: 45.8, lon: 25, tier: 3 },
  { name: "Bulgaria", lat: 42.8, lon: 25.2, tier: 3 },
  { name: "Greece", lat: 39.3, lon: 22, tier: 3 },
  { name: "Serbia", lat: 44.2, lon: 20.8, tier: 3 },
  { name: "Denmark", lat: 56, lon: 9.3, tier: 3 },
  { name: "Belarus", lat: 53.5, lon: 28, tier: 3 },
  { name: "Lithuania", lat: 55.3, lon: 23.9, tier: 3 },
  { name: "Latvia", lat: 56.9, lon: 24.9, tier: 3 },
  { name: "Estonia", lat: 58.7, lon: 25.5, tier: 3 },
  { name: "Georgia", lat: 42.2, lon: 43.5, tier: 3 },
  { name: "Azerbaijan", lat: 40.3, lon: 47.5, tier: 3 },
  { name: "Syria", lat: 35, lon: 38.5, tier: 3 },
  { name: "Jordan", lat: 31.2, lon: 36.8, tier: 3 },
  { name: "Israel", lat: 31.4, lon: 35, tier: 3 },
  { name: "Oman", lat: 20.6, lon: 56.1, tier: 3 },
  { name: "UAE", lat: 23.9, lon: 54.3, tier: 3 },
  { name: "Nepal", lat: 28.2, lon: 83.9, tier: 3 },
  { name: "Bangladesh", lat: 23.9, lon: 90.2, tier: 3 },
  { name: "Sri Lanka", lat: 7.6, lon: 80.7, tier: 3 },
  { name: "Cambodia", lat: 12.7, lon: 104.9, tier: 3 },
  { name: "Laos", lat: 19.5, lon: 102.5, tier: 3 },
  { name: "Malaysia", lat: 3.8, lon: 102.2, tier: 3 },
  { name: "Philippines", lat: 15.9, lon: 121.2, tier: 3 },
  { name: "Cuba", lat: 21.5, lon: -79, tier: 3 },
  { name: "Guatemala", lat: 15.6, lon: -90.4, tier: 3 },
  { name: "Ecuador", lat: -1.4, lon: -78.4, tier: 3 },
  { name: "Paraguay", lat: -23.2, lon: -58.4, tier: 3 },
  { name: "Uruguay", lat: -32.8, lon: -56, tier: 3 },
  { name: "Senegal", lat: 14.4, lon: -14.5, tier: 3 },
  { name: "Ghana", lat: 7.9, lon: -1.2, tier: 3 },
  { name: "Cameroon", lat: 5.7, lon: 12.7, tier: 3 },
  { name: "Zimbabwe", lat: -19, lon: 29.8, tier: 3 },
  { name: "Uganda", lat: 1.3, lon: 32.4, tier: 3 },
  { name: "Tunisia", lat: 34.1, lon: 9.6, tier: 3 },
];

/** Above the disc, borders and trails so shallow angles never clip labels. */
const LABEL_LIFT = 0.06;

/**
 * Camera-to-label distance (world units) at which each tier fades in, so
 * detail appears locally around wherever the user is exploring rather than
 * being keyed off the pole.
 */
const TIER_FADE_IN = [Number.POSITIVE_INFINITY, 10, 5.5] as const;
const TIER_OPACITY = [0.85, 0.8, 0.75] as const;
const FADE_SPEED = 3.5;

const FONT_PX = 44;
const HALO_PX = 7;

function makeLabelTexture(
  text: string,
): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const label = text.toUpperCase();
  const font = `600 ${FONT_PX}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.font = font;
  const tracking = FONT_PX * 0.14;
  const textWidth =
    ctx.measureText(label).width + tracking * Math.max(0, label.length - 1);

  canvas.width = Math.ceil(textWidth + HALO_PX * 4);
  canvas.height = Math.ceil(FONT_PX * 1.6);

  ctx.font = font;
  ctx.textBaseline = "middle";
  const y = canvas.height / 2;

  // Dark halo first, then the light fill — standard cartographic labelling.
  let x = HALO_PX * 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(3, 8, 18, 0.9)";
  ctx.lineWidth = HALO_PX;
  for (const ch of label) {
    ctx.strokeText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }
  x = HALO_PX * 2;
  ctx.fillStyle = "rgba(224, 240, 250, 0.96)";
  for (const ch of label) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: canvas.width / canvas.height };
}

interface LabelEntry {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  tier: 1 | 2 | 3;
  targetOpacity: number;
}

export interface LabelsHandle {
  group: THREE.Group;
  update: (camera: THREE.Camera, dt: number) => void;
  dispose: () => void;
}

export function createCountryLabels(): LabelsHandle {
  const group = new THREE.Group();
  const entries: LabelEntry[] = [];

  // Screen-height fraction per label line (sizeAttenuation off means sprite
  // scale is interpreted at unit camera distance, i.e. proportional to the
  // viewport rather than the world).
  const heightScale = 0.028;

  for (const item of COUNTRY_LABELS) {
    const { texture, aspect } = makeLabelTexture(item.name);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    // Anchor at the bottom edge so the billboard never dips into the disc.
    sprite.center.set(0.5, 0);
    const [x, , z] = projectLatLon(item.lat, item.lon, 0);
    sprite.position.set(x, LABEL_LIFT, z);
    sprite.scale.set(heightScale * aspect, heightScale, 1);
    sprite.renderOrder = 8;
    sprite.visible = false;
    group.add(sprite);
    entries.push({ sprite, material, tier: item.tier, targetOpacity: 0 });
  }

  return {
    group,
    update(camera, dt) {
      for (const entry of entries) {
        const threshold = TIER_FADE_IN[entry.tier - 1] ?? 0;
        const shown =
          camera.position.distanceTo(entry.sprite.position) < threshold;
        entry.targetOpacity = shown ? TIER_OPACITY[entry.tier - 1] ?? 0.8 : 0;

        const current = entry.material.opacity;
        const next = THREE.MathUtils.lerp(
          current,
          entry.targetOpacity,
          Math.min(1, dt * FADE_SPEED),
        );
        entry.material.opacity = next;
        entry.sprite.visible = next > 0.01;
      }
    },
    dispose() {
      for (const entry of entries) {
        entry.material.map?.dispose();
        entry.material.dispose();
      }
    },
  };
}
