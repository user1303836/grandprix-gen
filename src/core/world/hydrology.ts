/**
 * Hydrology: deterministic water bodies planned against the synthesized
 * terrain. Rivers descend a ravine line through the selected river/ravine
 * crossing span; lakes fill a basin low point; coasts bound islands.
 * Channels are carved INTO the terrain grid; water meshes are derived in
 * the renderer from the plan data.
 */

import { Rng } from "../prng";
import type { TrackSample } from "../types";
import type { TerrainSurface } from "../terrain";
import type { EnvironmentIdentity, EnvironmentParams, RoleSpan, WaterBody } from "./types";

export interface HydrologyResult {
  water: WaterBody[];
  /** moisture boost applied (already written into the grid) */
}

/**
 * Plan water against the (mutable) elevation grid. Carves the river channel
 * and lake bed directly into `elev`; returns the water-body descriptors.
 */
export function planHydrology(
  surface: TerrainSurface,
  elev: Float32Array,
  moisture: Float32Array,
  samples: TrackSample[],
  spans: RoleSpan[],
  trackLength: number,
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
  envSeed: number,
): HydrologyResult {
  const water: WaterBody[] = [];
  const rng = new Rng(envSeed ^ 0x9a17);
  const n = samples.length;

  if (identity.hydrology === "coast") {
    water.push({ type: "coast", level: surface.minElevation + 2.2 });
    return { water };
  }

  // ---- river -------------------------------------------------------------
  const riverSpans = spans.filter((s) => s.kind === "river-crossing" || s.kind === "ravine-crossing");
  const wantRiver =
    (identity.hydrology === "river" || identity.hydrology === "seasonal-stream") && params.water >= 0.2;
  if (wantRiver && riverSpans.length > 0) {
    // anchor: the crossing span with the strongest intensity
    const anchor = riverSpans.reduce((a, b) => (b.intensity > a.intensity ? b : a));
    const sCross = (anchor.sStart + (anchor.sEnd - anchor.sStart + (anchor.sEnd < anchor.sStart ? trackLength : 0)) / 2) % trackLength;
    const iC = Math.round(sCross / (trackLength / n)) % n;
    const pC = samples[iC];
    const heading = pC.heading;
    // the river runs PERPENDICULAR to the road at the crossing (down the ravine)
    const rx = -Math.sin(heading);
    const ry = Math.cos(heading);
    const flip = rng.next() < 0.5 ? 1 : -1;

    // walk downhill both ways from the crossing: source (uphill) and sink
    const walk = (dir: 1 | -1): { x: number; y: number; z: number }[] => {
      const pts: { x: number; y: number; z: number }[] = [];
      let x = pC.x;
      let y = pC.y;
      let z = surface.elevationAt(x, y);
      let dx = rx * dir * flip;
      let dy = ry * dir * flip;
      const step = surface.resolution * 2;
      for (let k = 0; k < 260; k++) {
        pts.push({ x, y, z });
        // steepest descent/ascent blended with the current direction
        let bx = dx;
        let by = dy;
        let bestD = -1;
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const tx = Math.cos(ang);
          const ty = Math.sin(ang);
          const ahead = surface.elevationAt(x + tx * step, y + ty * step);
          if (!Number.isFinite(ahead)) continue;
          // uphill when walking to the source (dir=1 goes upstream first?)
          const gain = dir === 1 ? ahead - z : z - ahead;
          const align = tx * dx + ty * dy;
          const score = gain * (dir === 1 ? 1 : 1) + align * surface.resolution * 1.4;
          if (score > bestD) {
            bestD = score;
            bx = tx;
            by = ty;
          }
        }
        dx = dx * 0.55 + bx * 0.45;
        dy = dy * 0.55 + by * 0.45;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        x += dx * step;
        y += dy * step;
        const nz = surface.elevationAt(x, y);
        if (!Number.isFinite(nz)) break;
        z = nz;
      }
      return pts;
    };

    const upstream = walk(1);
    const downstream = walk(-1);
    const centerline = [...upstream.reverse(), ...downstream.slice(1)];
    if (centerline.length >= 8) {
      // enforce monotonic descent along flow direction (source -> sink)
      for (let i = 1; i < centerline.length; i++) {
        if (centerline[i].z > centerline[i - 1].z) centerline[i].z = centerline[i - 1].z;
      }
      const width = identity.hydrology === "river" ? 9 + rng.next() * 5 : 4.5 + rng.next() * 2.5;
      const depth = identity.hydrology === "river" ? 2.6 : 1.4;
      // carve channel into the terrain grid + wet the banks
      for (const p of centerline) {
        const waterZ = p.z - 0.4;
        const half = width / 2 + 3;
        // grid neighborhood carve (square kernel, cheap and deterministic)
        const rr = Math.ceil((half + 4) / surface.resolution);
        const gxi = Math.round((p.x - surface.originX) / surface.resolution);
        const gyi = Math.round((p.y - surface.originY) / surface.resolution);
        for (let gy = gyi - rr; gy <= gyi + rr; gy++) {
          for (let gx = gxi - rr; gx <= gxi + rr; gx++) {
            if (gx < 0 || gy < 0 || gx >= surface.width || gy >= surface.height) continue;
            const wx = surface.originX + gx * surface.resolution;
            const wy = surface.originY + gy * surface.resolution;
            const d = Math.hypot(wx - p.x, wy - p.y);
            const gi = gy * surface.width + gx;
            if (d <= half) {
              const t = d / half;
              const bed = waterZ - depth * (1 - t * t);
              if (elev[gi] > bed) elev[gi] = bed;
              moisture[gi] = 1;
            } else if (d <= half + 6) {
              moisture[gi] = Math.max(moisture[gi], 0.9 - (d - half) * 0.08);
            }
          }
        }
      }
      const crossings = [sCross];
      water.push({ type: "river", points: centerline, width, crossings });
    }
  }

  // ---- lake ---------------------------------------------------------------
  if (identity.hydrology === "lake" && params.water >= 0.2) {
    // lowest grid cell at least 90 m from the road
    let bestI = -1;
    let bestZ = Infinity;
    for (let gy = 1; gy < surface.height - 1; gy++) {
      for (let gx = 1; gx < surface.width - 1; gx++) {
        const gi = gy * surface.width + gx;
        if (elev[gi] >= bestZ) continue;
        const wx = surface.originX + gx * surface.resolution;
        const wy = surface.originY + gy * surface.resolution;
        let near = Infinity;
        const stepJ = Math.max(1, Math.round(20 / (trackLength / n)));
        for (let i = 0; i < n; i += stepJ) {
          const d = Math.hypot(samples[i].x - wx, samples[i].y - wy);
          if (d < near) near = d;
        }
        if (near < 90) continue;
        bestZ = elev[gi];
        bestI = gi;
      }
    }
    if (bestI >= 0) {
      const gx = bestI % surface.width;
      const gy = Math.floor(bestI / surface.width);
      const lx = surface.originX + gx * surface.resolution;
      const ly = surface.originY + gy * surface.resolution;
      const radius = 55 + rng.next() * 70 + params.water * 60;
      const level = bestZ + 1.6;
      // flatten the bowl to just under the water level, wet the shore
      const rr = Math.ceil((radius + 18) / surface.resolution);
      for (let gy2 = gy - rr; gy2 <= gy + rr; gy2++) {
        for (let gx2 = gx - rr; gx2 <= gx + rr; gx2++) {
          if (gx2 < 0 || gy2 < 0 || gx2 >= surface.width || gy2 >= surface.height) continue;
          const wx = surface.originX + gx2 * surface.resolution;
          const wy = surface.originY + gy2 * surface.resolution;
          const d = Math.hypot(wx - lx, wy - ly);
          const gi = gy2 * surface.width + gx2;
          if (d < radius) {
            const bed = level - 1.2 - (1 - d / radius) * 3.2;
            if (elev[gi] > bed) elev[gi] = bed;
            moisture[gi] = 1;
          } else if (d < radius + 16) {
            moisture[gi] = Math.max(moisture[gi], 0.85 - (d - radius) * 0.04);
          }
        }
      }
      water.push({ type: "lake", x: lx, y: ly, radius, level });
    }
  }

  return { water };
}

/** crossing kinds the civil side should know about */
export function crossingsFor(spans: RoleSpan[], water: WaterBody[]): number[] {
  const out: number[] = [];
  for (const w of water) if (w.type === "river") out.push(...w.crossings);
  return out;
}

