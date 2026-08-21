/**
 * Vegetation planning: correlated density fields (biome, elevation, slope,
 * moisture, track distance, development clearings) turned into deterministic
 * instance placements with hard corridor clearance. Instances live in the
 * canonical plan; the renderer only instances them.
 */

import { Rng } from "../prng";
import type { TrackSample } from "../types";
import type { TerrainSurface } from "../terrain";
import { makeTrackProximity } from "../terrain";
import type {
  EnvironmentIdentity,
  EnvironmentParams,
  RoleSpan,
  VegetationPlan,
  WaterBody,
} from "./types";
import { roleAt } from "./relationships";

/** biome tree palette: [conifer share, size base, density base] */
const BIOME_TREES: Record<string, [number, number, number]> = {
  "temperate-forest": [0.35, 1.0, 0.9],
  alpine: [0.9, 0.85, 0.65],
  volcanic: [0.5, 0.7, 0.2],
  arid: [0.6, 0.6, 0.22],
  coastal: [0.2, 0.8, 0.5],
  highland: [0.65, 0.9, 0.6],
};

export function planVegetation(
  surface: TerrainSurface,
  moisture: Float32Array,
  samples: TrackSample[],
  spans: RoleSpan[],
  trackLength: number,
  ds: number,
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
  envSeed: number,
  water: WaterBody[],
): VegetationPlan {
  const rng = new Rng(envSeed ^ 0x7e55);
  const prox = makeTrackProximity(samples);
  const [coniferShare, sizeBase, densBase] = BIOME_TREES[identity.biome] ?? [0.5, 0.9, 0.6];
  const density = densBase * (0.25 + params.vegetation * 1.1);

  const trees: VegetationPlan["trees"] = [];
  const tufts: VegetationPlan["tufts"] = [];
  const boulders: VegetationPlan["boulders"] = [];

  const zMid = (surface.minElevation + surface.maxElevation) / 2;
  const stepCells = Math.max(2, Math.round(26 / surface.resolution));

  // water proximity boosts riparian growth
  const riverPts = water.filter((w) => w.type === "river").flatMap((w) => (w.type === "river" ? w.points : []));
  const lakes = water.filter((w) => w.type === "lake");

  for (let gy = 2; gy < surface.height - 2; gy += stepCells) {
    for (let gx = 2; gx < surface.width - 2; gx += stepCells) {
      const x = surface.originX + (gx + rng.spread(0.45)) * surface.resolution;
      const y = surface.originY + (gy + rng.spread(0.45)) * surface.resolution;
      const z = surface.elevationAt(x, y);
      if (!Number.isFinite(z)) continue;
      const gi = Math.round((y - surface.originY) / surface.resolution) * surface.width + Math.round((x - surface.originX) / surface.resolution);
      const moist = moisture[gi] ?? 0.3;
      const slope = surface.slopeAt(x, y);
      const near = prox.nearest(x, y, 200);

      // corridor clearance: nothing big inside 26 m, grass allowed closer
      const dRoad = near ? near.d : 1e9;

      // forest-corridor spans grow denser, right up to the clearing edge
      const nearRole = near && near.i !== undefined && near.d < 160
        ? roleAt(spans, samples[near.i].s, trackLength).kind
        : null;

      let p = density * (0.35 + moist * 0.9);
      if (nearRole === "forest-corridor") p *= 2.1;
      if (nearRole === "developed") p *= 0.25;
      if (slope > 0.55) p *= 0.15;
      else if (slope > 0.38) p *= 0.5;
      if (z > zMid + (surface.maxElevation - zMid) * 0.55 && identity.biome === "alpine") p *= 0.4;
      // riparian boost near river centerlines
      for (const rp of riverPts) {
        const d = Math.hypot(x - rp.x, y - rp.y);
        if (d < 40) {
          p *= 1.9;
          break;
        }
      }
      for (const lk of lakes) {
        if (lk.type === "lake") {
          const d = Math.hypot(x - lk.x, y - lk.y);
          if (d < lk.radius + 10) p = 0; // no trees in the water
          else if (d < lk.radius + 30) p *= 1.8;
        }
      }
      if (identity.hydrology === "coast" && z < surface.minElevation + 6) p *= 0.25;

      // clearing near the road: hard stop under 26 m, taper to 60 m
      if (dRoad < 26) p = 0;
      else if (dRoad < 60) p *= (dRoad - 26) / 34;

      if (rng.next() < p && trees.length < 5200) {
        const conifer = rng.next() < coniferShare || z > zMid + rng.spread(30);
        trees.push({
          x,
          y,
          z,
          scale: (0.7 + rng.next() * 0.9) * sizeBase,
          conifer,
          autumnHue: rng.next(),
        });
      }

      // grass tufts: closer in, moisture-loving
      if (dRoad > 9 && dRoad < 160 && slope < 0.5 && rng.next() < moist * params.vegetation * 0.8 && tufts.length < 9000) {
        tufts.push({ x: x + rng.spread(8), y: y + rng.spread(8), z, scale: 0.6 + rng.next() * 0.9 });
      }

      // boulders: slopes and dry ground, biome-scaled
      const bouldP = (identity.biome === "volcanic" ? 0.34 : identity.biome === "alpine" ? 0.26 : identity.biome === "arid" ? 0.22 : 0.1) *
        (slope > 0.3 ? 1.6 : 0.6) * (0.4 + params.drama);
      if (dRoad > 15 && rng.next() < bouldP && boulders.length < 900) {
        boulders.push({ x, y, z, scale: 0.5 + rng.next() * 1.7, seed: rng.int(0, 1e9) });
      }
    }
  }

  return { trees, tufts, boulders };
}
