/**
 * World boundary: an irregular buffered ring around the track (concave,
 * coherently perturbed), plus the treatment metadata the renderer uses to
 * build cliff/stratified/plinth/coast skirts and undersides.
 */

import { Rng } from "../prng";
import type { TrackSample } from "../types";
import type { TerrainSurface } from "../terrain";
import type { BoundaryMode, BoundaryTreatment, EnvironmentIdentity, WorldBoundary } from "./types";
import { defaultBoundaryTreatment } from "./identity";

/** boundary offsets: how far the ring sits beyond the track bbox edges */
function radialBuffer(samples: TrackSample[], cx: number, cy: number, base: number): number[] {
  // 96 angular bins; each bin gets the max track radius + buffer
  const BINS = 96;
  const out = new Float32Array(BINS).fill(0);
  for (const p of samples) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const a = Math.atan2(dy, dx);
    const bin = ((Math.round((a / (Math.PI * 2)) * BINS) % BINS) + BINS) % BINS;
    const r = Math.hypot(dx, dy) + base;
    if (r > out[bin]) out[bin] = r;
  }
  // close holes: bins with no track get neighbor average
  for (let k = 0; k < BINS; k++) {
    if (out[k] === 0) {
      const prev = out[(k - 1 + BINS) % BINS];
      const next = out[(k + 1) % BINS];
      out[k] = Math.max(prev, next) * 0.97;
    }
  }
  return Array.from(out);
}

export function planBoundary(
  samples: TrackSample[],
  surface: TerrainSurface,
  identity: EnvironmentIdentity,
  mode: BoundaryMode,
  envSeed: number,
): WorldBoundary {
  const rng = new Rng(envSeed ^ 0xb04d);
  let cx = 0;
  let cy = 0;
  for (const p of samples) {
    cx += p.x;
    cy += p.y;
  }
  cx /= samples.length;
  cy /= samples.length;

  const base = mode === "open" ? 150 : mode === "diorama" ? 120 : 100;
  const radii = radialBuffer(samples, cx, cy, base);

  // coherent perturbation: 3 low-frequency harmonics
  const h1 = rng.range(0, Math.PI * 2);
  const h2 = rng.range(0, Math.PI * 2);
  const h3 = rng.range(0, Math.PI * 2);
  const a1 = rng.range(0.05, 0.14);
  const a2 = rng.range(0.03, 0.09);
  const a3 = rng.range(0.02, 0.05);

  const ring: { x: number; y: number }[] = [];
  const BINS = radii.length;
  for (let k = 0; k < BINS; k++) {
    const a = (k / BINS) * Math.PI * 2;
    const perturb = 1 + a1 * Math.sin(a * 2 + h1) + a2 * Math.sin(a * 3 + h2) + a3 * Math.sin(a * 5 + h3);
    const r = radii[k] * perturb;
    ring.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }

  const treatment: BoundaryTreatment =
    mode === "open" ? "open-fade" : defaultBoundaryTreatment(identity, rng);
  const baseZ = surface.minElevation - (mode === "island" ? 26 : mode === "diorama" ? 18 : 8);

  return { ring, mode, treatment, baseZ };
}
