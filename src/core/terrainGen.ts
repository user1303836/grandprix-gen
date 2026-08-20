/**
 * Terrain-aware generation.
 *
 * The horizontal layout is scored against the DEM (cross-slope, alignment
 * with natural features, elevation character) -- terrain participates in
 * generation instead of the track being draped over the ground.
 */

import { generateValidTrack, type ValidResult } from "./generator";
import { computeSpeedProfile, VEHICLE_PRESETS } from "./vehicle";
import type { TerrainGrid } from "./terrain";
import type { SiteRef, TrackParams } from "./types";

export interface TerrainGenOptions {
  site?: SiteRef;
  candidates?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Cost of a candidate layout against the terrain (lower is better).
 * Rewards: followable ground, requested elevation character, feature
 * alignment. Penalizes: cross-slope, excessive roughness under the line.
 */
export function terrainCost(
  xs: Float64Array,
  ys: Float64Array,
  heading: Float64Array,
  grid: TerrainGrid,
  params: TrackParams,
): number {
  const n = xs.length;
  let crossSlopeSum = 0;
  let roughSum = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  let valid = 0;
  let prevZ = NaN;

  for (let i = 0; i < n; i += 2) {
    const z = grid.elevationAt(xs[i], ys[i]);
    if (Number.isNaN(z)) continue;
    valid++;
    // cross slope: slope component perpendicular to travel direction
    const eps = grid.resolution * 1.5;
    const nx = -Math.sin(heading[i]);
    const ny = Math.cos(heading[i]);
    const zL = grid.elevationAt(xs[i] + nx * eps, ys[i] + ny * eps);
    const zR = grid.elevationAt(xs[i] - nx * eps, ys[i] - ny * eps);
    if (!Number.isNaN(zL) && !Number.isNaN(zR)) {
      crossSlopeSum += Math.abs(zL - zR) / (2 * eps);
    }
    if (!Number.isNaN(prevZ)) {
      const zNext = grid.elevationAt(xs[(i + 2) % n], ys[(i + 2) % n]);
      if (!Number.isNaN(zNext)) {
        roughSum += Math.abs(zNext - 2 * z + prevZ);
      }
    }
    prevZ = z;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  if (valid < n / 4) return 1e9; // mostly off-grid: useless candidate

  const count = Math.max(1, valid);
  const crossSlope = crossSlopeSum / count;
  const rough = roughSum / count;
  const relief = zMax - zMin;

  // elevation character: want relief to match elevationIntensity
  const L = n * 2; // rough length proxy (sampled every 2)
  const wantRelief = params.elevationIntensity * (L / 1000) * 24;
  const reliefErr = Math.abs(relief - wantRelief) / Math.max(30, wantRelief);

  const adherence = params.terrainAdherence;
  const cost =
    adherence * (crossSlope * 2.2 + rough * 0.5) +
    (1 - adherence) * reliefErr * 0.35 +
    reliefErr * adherence * 0.55;
  return cost;
}

/**
 * Generate a track influenced by terrain: evaluate several candidates and
 * keep the best terrain fit that is geometrically valid.
 */
export function generateTerrainTrack(
  seed: number,
  params: TrackParams,
  grid: TerrainGrid,
  opts: TerrainGenOptions = {},
): ValidResult & { terrainCost?: number } {
  const candidates = opts.candidates ?? 8;
  const sampler = (x: number, y: number) => grid.elevationAt(x, y);
  const buildOpts = {
    site: opts.site ?? null,
    terrain: grid.meta(),
    terrainSampler: sampler,
  };

  let best: (ValidResult & { terrainCost?: number }) | null = null;
  for (let k = 0; k < candidates; k++) {
    const sub = seed + k * 100003;
    const r = generateValidTrack(sub, params, buildOpts, 6);
    opts.onProgress?.(k + 1, candidates);
    if (!r.track) continue;
    r.track.seed = seed;
    const n = r.track.samples.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const hd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = r.track.samples[i].x;
      ys[i] = r.track.samples[i].y;
      hd[i] = r.track.samples[i].heading;
    }
    const cost = terrainCost(xs, ys, hd, grid, params);
    const score = cost + (r.attempts - 1) * 0.35; // prefer easy validity too
    if (!best || score < (best.terrainCost ?? Infinity)) {
      best = { ...r, terrainCost: score };
    }
  }
  if (!best) {
    return { track: null, closureError: Infinity, failReason: "no-terrain-candidate", attempts: candidates };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Site scouting
// ---------------------------------------------------------------------------

export interface ScoutedSite {
  /** Center in local meters. */
  x: number;
  y: number;
  radiusMeters: number;
  relief: number;
  roughness: number;
  meanSlope: number;
  /** Estimated quality for the requested character (higher = better). */
  score: number;
  label: string;
}

/**
 * Search a larger DEM region for promising circuit sub-sites.
 * Nested optimization: find interesting site -> find interesting circuit.
 */
export function scoutSites(
  grid: TerrainGrid,
  params: TrackParams,
  regionRadiusMeters: number,
  count = 6,
): ScoutedSite[] {
  const siteRadius = Math.max(600, params.targetLength / (2 * Math.PI) * 1.35);
  const step = Math.max(siteRadius * 0.9, grid.resolution * 8);
  const results: ScoutedSite[] = [];

  for (let cy = -regionRadiusMeters + siteRadius; cy <= regionRadiusMeters - siteRadius; cy += step) {
    for (let cx = -regionRadiusMeters + siteRadius; cx <= regionRadiusMeters - siteRadius; cx += step) {
      // stats over the candidate window
      let zMin = Infinity;
      let zMax = -Infinity;
      let slopeSum = 0;
      let roughSum = 0;
      let samples = 0;
      let prevZ = NaN;
      const nR = Math.ceil(siteRadius / grid.resolution);
      for (let iy = -nR; iy <= nR; iy += 2) {
        for (let ix = -nR; ix <= nR; ix += 2) {
          if (ix * ix + iy * iy > nR * nR) continue;
          const x = cx + ix * grid.resolution;
          const y = cy + iy * grid.resolution;
          const z = grid.elevationAt(x, y);
          if (Number.isNaN(z)) continue;
          samples++;
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
          slopeSum += grid.slopeAt(x, y);
          if (!Number.isNaN(prevZ)) roughSum += Math.abs(z - prevZ);
          prevZ = z;
        }
      }
      if (samples < 20) continue;
      const relief = zMax - zMin;
      const meanSlope = slopeSum / samples;
      const rough = roughSum / samples;

      // score against the requested character
      const wantRelief = params.elevationIntensity * (params.targetLength / 1000) * 24;
      const reliefFit = 1 - Math.min(1, Math.abs(relief - wantRelief) / Math.max(40, wantRelief));
      const buildability = 1 - Math.min(1, meanSlope * 2.4);
      const score =
        0.45 * reliefFit +
        0.35 * buildability * (1 - params.terrainAdherence * 0.4) +
        0.2 * Math.min(1, rough / 6);
      results.push({
        x: cx,
        y: cy,
        radiusMeters: siteRadius,
        relief,
        roughness: rough,
        meanSlope,
        score,
        label: "",
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, count);
  const labels = ["SITE A", "SITE B", "SITE C", "SITE D", "SITE E", "SITE F", "SITE G", "SITE H"];
  top.forEach((s, i) => (s.label = labels[i] ?? `SITE ${i + 1}`));
  return top;
}

/** Quick vehicle estimate used by scouting summaries. */
export function quickLapEstimate(lengthMeters: number): number {
  const profile = { vAvg: 55 }; // ~200 km/h placeholder average
  return lengthMeters / profile.vAvg;
}

export { computeSpeedProfile, VEHICLE_PRESETS };
