/**
 * Terrain-aware generation.
 *
 * The horizontal layout is scored against the DEM (cross-slope, alignment
 * with natural features, elevation character) -- terrain participates in
 * generation instead of the track being draped over the ground.
 */

import { generateValidTrack, type ValidResult } from "./generator";
import { computeSpeedProfile, VEHICLE_PRESETS } from "./vehicle";
import { gradeLimit } from "./vertical";
import { Rng } from "./prng";
import { maskHit } from "./osm";
import type { TerrainGrid } from "./terrain";
import type { SiteRef, TrackParams } from "./types";

export interface TerrainGenOptions {
  site?: SiteRef;
  candidates?: number;
  onProgress?: (done: number, total: number) => void;
  /** Building avoidance mask (local coords) + strength 0..1. */
  avoidBuildings?: { mask: import("./osm").BuildingMask; strength: number } | null;
}

/**
 * Cost of a candidate layout against the terrain (lower is better).
 * Rewards: followable ground, requested elevation character, low
 * earthwork. Penalizes: cross-slope, roughness, grade infeasibility.
 */
export function terrainCost(
  xs: Float64Array,
  ys: Float64Array,
  heading: Float64Array,
  grid: TerrainGrid,
  params: TrackParams,
  avoid?: { mask: import("./osm").BuildingMask; strength: number } | null,
): number {
  const n = xs.length;
  let crossSlopeSum = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  let valid = 0;

  // decimate to ~4 m spacing for the ground profile
  const step = Math.max(1, Math.round(4 / ((xs.length > 0 ? 1 : 1) * 2))); // xs sampled every ~2 m upstream
  const ground: number[] = [];
  for (let i = 0; i < n; i += step) {
    const z = grid.elevationAt(xs[i], ys[i]);
    if (Number.isNaN(z)) continue;
    valid++;
    ground.push(z);
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    // cross slope: slope component perpendicular to travel direction
    const eps = grid.resolution * 1.5;
    const nx = -Math.sin(heading[i]);
    const ny = Math.cos(heading[i]);
    const zL = grid.elevationAt(xs[i] + nx * eps, ys[i] + ny * eps);
    const zR = grid.elevationAt(xs[i] - nx * eps, ys[i] - ny * eps);
    if (!Number.isNaN(zL) && !Number.isNaN(zR)) {
      crossSlopeSum += Math.abs(zL - zR) / (2 * eps);
    }
  }
  if (valid < n / 8 || ground.length < 8) return 1e9;

  const crossSlope = crossSlopeSum / Math.max(1, valid);
  const relief = zMax - zMin;

  // earthwork estimate: grade-limit the ground profile, measure deviation.
  // a superlinear term on large fills kills routes that would need giant
  // causeways (they generate as bridges; a few is cool, kilometers is not)
  const gArr = Float64Array.from(ground);
  const dsEff = 2 * step;
  const limited = gradeLimit(gArr, dsEff, params.maxGrade, 400);
  let earthwork = 0;
  let bigFill = 0;
  const fillRef = Math.max(4, params.maxFill * (0.25 + 0.75 * params.earthworkTolerance));
  for (let i = 0; i < gArr.length; i++) {
    const d = limited[i] - gArr[i];
    earthwork += Math.abs(d);
    if (d > fillRef) bigFill += (d - fillRef) * (d - fillRef);
  }
  earthwork /= gArr.length;
  bigFill /= gArr.length;

  // elevation character: want relief to match elevationIntensity
  const L = n * 2;
  const wantRelief = params.elevationIntensity * (L / 1000) * 24;
  const reliefErr = Math.abs(relief - wantRelief) / Math.max(30, wantRelief);

  // building avoidance: fraction of the line hitting the mask
  let buildingHits = 0;
  if (avoid) {
    for (let i = 0; i < n; i += step) {
      if (maskHit(avoid.mask, xs[i], ys[i])) buildingHits++;
    }
  }
  const buildingFrac = buildingHits / Math.max(1, valid);
  // hard mode: any meaningful overlap rejects the candidate outright
  if (avoid && avoid.strength >= 1.4 && buildingFrac > 0.004) return 1e9;

  // contour following: penalize travel aligned with the uphill gradient
  // (roads should traverse slopes, not climb fall lines)
  let alignSum = 0;
  let alignN = 0;
  {
    const eps = grid.resolution * 1.5;
    for (let i = 0; i < n; i += step) {
      const gx =
        (grid.elevationAt(xs[i] + eps, ys[i]) - grid.elevationAt(xs[i] - eps, ys[i])) / (2 * eps);
      const gy =
        (grid.elevationAt(xs[i], ys[i] + eps) - grid.elevationAt(xs[i], ys[i] - eps)) / (2 * eps);
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      const gMag = Math.hypot(gx, gy);
      if (gMag < 0.015) continue;
      const tx = Math.cos(heading[i]);
      const ty = Math.sin(heading[i]);
      const align = Math.abs((tx * gx + ty * gy) / gMag) * Math.min(gMag, 0.3);
      alignSum += align;
      alignN++;
    }
  }
  const contourCost = alignN > 0 ? alignSum / alignN : 0;

  const adherence = params.terrainAdherence;
  const earthworkWeight = 1.6 - params.earthworkTolerance * 1.3; // low tolerance => strong penalty
  const cost =
    adherence * (crossSlope * 2.0 + earthwork * earthworkWeight * 0.45 + bigFill * 0.12) +
    reliefErr * 0.5 +
    (avoid && avoid.strength < 1.4 ? avoid.strength * buildingFrac * 14 : 0) +
    params.contourFollowing * contourCost * 9;
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
  const halfSpan = (Math.min(grid.width, grid.height) * grid.resolution) / 2;
  const buildOpts = {
    site: opts.site ?? null,
    terrain: grid.meta(),
    terrainSampler: sampler,
    maxFootprintRadius: halfSpan * 0.72,
  };

  let best: (ValidResult & { terrainCost?: number }) | null = null;
  const placeRng = Rng.fromSalt(seed, 9182);
  for (let k = 0; k < candidates; k++) {
    const sub = seed + k * 100003;
    // relocate candidates within the site so avoidance/contour costs can
    // actually choose between PLACES, not just shapes
    const ang = placeRng.range(0, Math.PI * 2);
    const rad = k === 0 ? 0 : placeRng.range(0, halfSpan * 0.3);
    const r = generateValidTrack(sub, params, {
      ...buildOpts,
      // keep the relocated plan strictly inside the DEM (off-grid = NaN)
      maxFootprintRadius: Math.max(halfSpan * 0.3, halfSpan * 0.9 - rad),
      centerOffset: { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad },
    }, 6);
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
    const cost = terrainCost(xs, ys, hd, grid, params, opts.avoidBuildings);
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
