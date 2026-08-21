/**
 * Vertical profile design.
 *
 * Blank canvas: seeded blend of sinusoids + corner-coupled crests, grade
 * limited. Terrain mode: smoothing of the existing-ground profile inside a
 * cut/fill band (earthwork model), then grade limited.
 */

import { Rng } from "./prng";
import { smoothCircular } from "./geometry";
import type { TrackParams } from "./types";

/**
 * Iteratively clamp dz/ds to maxGrade.
 *
 * The profile is periodic (closed lap). Slope-limiting an open chain
 * breaks periodicity at the wrap, so we iterate: limit a duplicated open
 * chain, then spread the residual seam jump linearly across the lap
 * (which itself stays within grade budget) until the seam closes.
 */
export function gradeLimit(z: Float64Array, ds: number, maxGrade: number, passes = 0): Float64Array {
  const n = z.length;
  const g = Math.max(0.005, maxGrade);
  const maxPasses = passes > 0 ? passes : Math.min(n * 2, 4000);
  let cur = Float64Array.from(z);

  for (let round = 0; round < 8; round++) {
    const limited = limitOpenChain(cur, ds, g, maxPasses);
    // residual seam jump when wrapping limited[n-1] -> limited[0]
    const jump = limited[0] - limited[n - 1];
    if (Math.abs(jump) < 0.02) return limited;
    // spread the jump across the lap (raise the tail toward the head),
    // then re-limit to absorb the tiny introduced slope
    const out = Float64Array.from(limited);
    for (let i = 0; i < n; i++) out[i] += jump * (i / n);
    cur = out;
  }
  return cur;
}

/**
 * Hard terrain conformance. Constraint priority (this ordering is what
 * guarantees the road never clips the land):
 *   1. FLOOR is sacred: z >= ground - cut (burial = clipping, forbidden).
 *   2. GRADE is sacred: |dz/ds| <= maxGrade.
 *   3. CEILING is soft: z <= ground + fill is only a design preference --
 *      when the land is steeper than the road may climb, the road leaves
 *      the band upward and a bridge/embankment structure owns the gap.
 *
 * POCS loop toward the band for good aesthetics, then an exact raise-only
 * floor+slope solve (floorSlopeSolve) which satisfies 1+2 simultaneously.
 */
export function conformToTerrain(
  z: Float64Array,
  ground: Float64Array,
  ds: number,
  maxGrade: number,
  cut: number,
  fill: number,
  rounds = 48,
): Float64Array {
  const n = z.length;
  if (!Number.isFinite(ground[0])) return z;
  const lo = new Float64Array(n);
  const hiSoft = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = ground[i];
    lo[i] = Number.isFinite(g) ? g - cut : -1e9; // off-DEM: unconstrained
    hiSoft[i] = Number.isFinite(g) ? g + fill * 3 : 1e9;
  }
  let cur: Float64Array = Float64Array.from(z);
  for (let i = 0; i < n; i++) {
    if (cur[i] < lo[i]) cur[i] = lo[i];
    else if (cur[i] > hiSoft[i]) cur[i] = hiSoft[i];
  }
  for (let r = 0; r < rounds; r++) {
    cur = gradeLimit(cur, ds, maxGrade, 240);
    for (let i = 0; i < n; i++) {
      if (cur[i] < lo[i]) cur[i] = lo[i];
      else if (cur[i] > hiSoft[i]) cur[i] = hiSoft[i];
    }
  }
  // exact finish: raise-only floor+slope solver; no ceiling clamp (structures)
  cur = floorSlopeSolve(cur, lo, ds, Math.max(0.005, maxGrade));
  return cur;
}

/**
 * Minimal profile w >= max(z, lo) on a closed loop with |dw/ds| <= g.
 * Solved on a doubled (two-lap) domain so floor contacts propagate their
 * raises fully around the seam; the second lap is the circular envelope.
 */
export function floorSlopeSolve(z: Float64Array, lo: Float64Array, ds: number, g: number): Float64Array {
  const n = z.length;
  const step = g * ds;
  // seam at the lowest floor point (deepest valley: least forcing)
  let start = 0;
  let loMin = Infinity;
  for (let i = 0; i < n; i++) {
    if (lo[i] < loMin) {
      loMin = lo[i];
      start = i;
    }
  }
  const idx = (k: number) => (start + k) % n;
  // tripled domain: the middle lap has BOTH neighbors inside the domain,
  // so every output pair -- including the circular wrap -- is constrained
  const w = new Float64Array(3 * n);
  w[0] = Math.max(z[idx(0)], lo[idx(0)]);
  for (let k = 1; k < 3 * n; k++) {
    const i = idx(k);
    w[k] = Math.max(z[i], lo[i], w[k - 1] - step);
  }
  for (let k = 3 * n - 2; k >= 0; k--) {
    w[k] = Math.max(w[k], w[k + 1] - step);
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[idx(k)] = w[k + n];
  return out;
}

/** Slope-limit an open (non-periodic) duplicated chain, extract the lap. */
function limitOpenChain(z: Float64Array, ds: number, g: number, maxPasses: number): Float64Array {
  const n = z.length;
  const m = n * 2;
  const chain = new Float64Array(m);
  for (let i = 0; i < m; i++) chain[i] = z[i % n];
  const lim = g * ds;
  for (let pass = 0; pass < maxPasses; pass++) {
    let maxViolation = 0;
    for (let i = 0; i < m - 1; i++) {
      const d = chain[i + 1] - chain[i];
      if (d > lim) {
        chain[i + 1] = chain[i] + lim;
        if (d - lim > maxViolation) maxViolation = d - lim;
      } else if (d < -lim) {
        chain[i + 1] = chain[i] - lim;
        if (-d - lim > maxViolation) maxViolation = -d - lim;
      }
    }
    for (let i = m - 2; i >= 0; i--) {
      const d = chain[i + 1] - chain[i];
      if (d > lim) {
        chain[i] = chain[i + 1] - lim;
        if (d - lim > maxViolation) maxViolation = d - lim;
      } else if (d < -lim) {
        chain[i] = chain[i + 1] + lim;
        if (-d - lim > maxViolation) maxViolation = -d - lim;
      }
    }
    if (maxViolation < 1e-6) break;
  }
  // second copy: every sample was limited with full left context
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = chain[n + i];
  return out;
}

/** Maximum absolute grade of a periodic profile. */
export function maxGradeOf(z: Float64Array, ds: number): number {
  const n = z.length;
  let g = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const v = Math.abs(z[j] - z[i]) / ds;
    if (v > g) g = v;
  }
  return g;
}

export interface VerticalOptions {
  /** Apex s-positions and strengths for corner coupling. */
  cornerApexes?: { s: number; strength: number }[];
}

/**
 * Blank-canvas vertical profile. Amplitude scales with elevationIntensity
 * and lap length; low-frequency content dominates (real circuits have a
 * handful of meaningful elevation features, not white noise).
 */
export function designVerticalProfile(
  n: number,
  ds: number,
  params: TrackParams,
  seed: number,
  opts: VerticalOptions = {},
): Float64Array {
  const L = n * ds;
  const rng = Rng.fromSalt(seed, 7101);
  const intensity = params.elevationIntensity;

  const z = new Float64Array(n);
  if (intensity <= 0.001) return z;

  // overall amplitude: ~12 m of relief per km at full intensity
  const A = intensity * (L / 1000) * 12;
  const nWaves = 2 + Math.floor(rng.range(0, 3));
  const waves: { k: number; amp: number; phase: number }[] = [];
  let ampSum = 0;
  for (let i = 0; i < nWaves; i++) {
    const k = 1 + Math.floor(rng.range(0, 4)); // harmonic 1..4
    const amp = rng.range(0.4, 1) / (1 + 0.6 * (k - 1));
    waves.push({ k, amp, phase: rng.range(0, Math.PI * 2) });
    ampSum += amp;
  }
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    let v = 0;
    for (const wv of waves) {
      v += wv.amp * Math.sin((2 * Math.PI * wv.k * s) / L + wv.phase);
    }
    z[i] = (v / Math.max(1e-6, ampSum)) * A;
  }

  // Corner coupling: crests/compressions near apexes.
  const coupling = params.elevationCoupling;
  if (coupling > 0.01 && opts.cornerApexes && opts.cornerApexes.length > 0) {
    const cRng = Rng.fromSalt(seed, 7202);
    for (const ap of opts.cornerApexes) {
      if (!cRng.bool(0.6)) continue;
      const sign = cRng.bool() ? 1 : -1;
      const mag = sign * A * 0.35 * coupling * cRng.range(0.5, 1);
      const widthM = cRng.range(40, 110);
      addGaussianBump(z, ds, ap.s, mag, widthM);
    }
  }

  // Smooth and grade-limit.
  const sigma = Math.max(1, 25 / ds);
  let out = smoothCircular(z, sigma);
  out = gradeLimit(out, ds, params.maxGrade);
  // recenter so min elevation ~0 (cosmetic; absolute z handled by caller)
  let min = Infinity;
  for (let i = 0; i < n; i++) if (out[i] < min) min = out[i];
  for (let i = 0; i < n; i++) out[i] -= min;
  return out;
}

function addGaussianBump(z: Float64Array, ds: number, s0: number, mag: number, widthM: number): void {
  const n = z.length;
  const L = n * ds;
  const range = Math.ceil((widthM * 4) / ds);
  const i0 = Math.round(s0 / ds);
  for (let d = -range; d <= range; d++) {
    const i = (((i0 + d) % n) + n) % n;
    const dist = Math.min(Math.abs(d * ds), L - Math.abs(d * ds));
    z[i] += mag * Math.exp(-(dist * dist) / (2 * widthM * widthM));
  }
}

/**
 * Terrain-mode vertical design.
 *
 * existingZ: ground elevation along the centerline.
 * earthworkTolerance: 0 = track hugs ground, 1 = heavy civil engineering
 * (profile may straighten/smooth aggressively within the cut/fill band).
 */
export function designTerrainProfile(
  existingZ: Float64Array,
  ds: number,
  params: TrackParams,
): { z: Float64Array; cutFill: Float64Array } {
  const n = existingZ.length;
  const tol = params.earthworkTolerance;
  const cut = Math.max(0.5, params.maxCut * (0.25 + 0.75 * tol));
  const fill = Math.max(0.5, params.maxFill * (0.25 + 0.75 * tol));

  // Smoothing window: low tolerance follows the ground closely.
  const windowM = 20 + tol * 260; // 20 m .. 280 m
  const sigma = Math.max(0.5, windowM / ds / 3);
  let z = smoothCircular(existingZ, sigma);

  // Blend toward ground according to (1 - tolerance) so tol=0 hugs terrain.
  const hug = 1 - tol;
  for (let i = 0; i < n; i++) {
    z[i] = z[i] * (1 - hug * 0.7) + existingZ[i] * hug * 0.7;
  }

  // Clamp to the cut/fill band around ground.
  const band = (arr: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const lo = existingZ[i] - cut;
      const hi = existingZ[i] + fill;
      if (arr[i] < lo) arr[i] = lo;
      else if (arr[i] > hi) arr[i] = hi;
    }
  };
  band(z);

  // Projected relaxation: repeatedly pull toward the band-clamped ground,
  // then project back onto the grade-feasible set. Converges to a profile
  // that hugs the ground where grades allow and does earthworks only
  // where the land is steeper than the road may be.
  const target = Float64Array.from(z);
  band(target);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < n; i++) z[i] += 0.3 * (target[i] - z[i]);
    z = gradeLimit(z, ds, params.maxGrade);
  }

  // FINAL guarantee: the band is a hard constraint (no clipping, ever).
  z = conformToTerrain(z, existingZ, ds, params.maxGrade, cut, fill);

  const cutFill = new Float64Array(n);
  for (let i = 0; i < n; i++) cutFill[i] = z[i] - existingZ[i];
  return { z, cutFill };
}
