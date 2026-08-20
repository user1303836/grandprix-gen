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

/** Iteratively clamp dz/ds to maxGrade (preserves overall character). */
export function gradeLimit(z: Float64Array, ds: number, maxGrade: number, passes = 60): Float64Array {
  const n = z.length;
  const out = Float64Array.from(z);
  const g = Math.max(0.005, maxGrade);
  for (let pass = 0; pass < passes; pass++) {
    let maxViolation = 0;
    // forward
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const lim = g * ds;
      const d = out[j] - out[i];
      if (d > lim) {
        out[j] = out[i] + lim;
        maxViolation = Math.max(maxViolation, d - lim);
      } else if (d < -lim) {
        out[j] = out[i] - lim;
        maxViolation = Math.max(maxViolation, -d - lim);
      }
    }
    // backward
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const lim = g * ds;
      const d = out[j] - out[i];
      if (d > lim) {
        out[i] = out[j] - lim;
        maxViolation = Math.max(maxViolation, d - lim);
      } else if (d < -lim) {
        out[i] = out[j] + lim;
        maxViolation = Math.max(maxViolation, -d - lim);
      }
    }
    if (maxViolation < 1e-4) break;
  }
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

  // Alternate grade limiting and band clamping; finish with a soft grade pass.
  for (let k = 0; k < 4; k++) {
    z = gradeLimit(z, ds, params.maxGrade, 20);
    band(z);
  }
  z = gradeLimit(z, ds, params.maxGrade * 1.15, 40);

  const cutFill = new Float64Array(n);
  for (let i = 0; i < n; i++) cutFill[i] = z[i] - existingZ[i];
  return { z, cutFill };
}
