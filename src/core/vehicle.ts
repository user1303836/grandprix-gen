/**
 * Simplified quasi-static vehicle model.
 *
 * Computes an estimated speed envelope around the lap from curvature,
 * banking and grade using a friction-limit apex speed plus
 * forward (acceleration) and backward (braking) integration passes.
 *
 * Not a motorsport simulator -- good enough to estimate lap time,
 * braking zones, speed distribution and circuit character.
 */

import type { Track } from "./types";

export interface VehicleSpec {
  name: string;
  /** Max lateral acceleration at low speed, m/s^2. */
  aLat: number;
  /** Downforce gain: additional lateral accel per (m/s)^2 (0 = none). */
  downforceK: number;
  /** Absolute lateral accel cap, m/s^2. */
  aLatMax: number;
  /** Max braking deceleration, m/s^2. */
  aBrake: number;
  /** Max low-speed acceleration, m/s^2. */
  aAccel: number;
  /** Drag-limited top speed, m/s. */
  vTop: number;
}

export const VEHICLE_PRESETS: Record<string, VehicleSpec> = {
  gt3: {
    name: "GT3",
    aLat: 12.5,
    downforceK: 0.006,
    aLatMax: 22,
    aBrake: 13,
    aAccel: 7.5,
    vTop: 78, // ~281 km/h
  },
  prototype: {
    name: "Prototype",
    aLat: 15,
    downforceK: 0.011,
    aLatMax: 32,
    aBrake: 19,
    aAccel: 10,
    vTop: 89, // ~320 km/h
  },
  formula: {
    name: "Formula",
    aLat: 16,
    downforceK: 0.017,
    aLatMax: 45,
    aBrake: 32,
    aAccel: 13,
    vTop: 94, // ~340 km/h
  },
  road: {
    name: "Road Car",
    aLat: 9.0,
    downforceK: 0,
    aLatMax: 10.5,
    aBrake: 9.0,
    aAccel: 5.5,
    vTop: 66, // ~238 km/h
  },
};

const G = 9.81;

export interface BrakingZone {
  sStart: number;
  sEnd: number;
  vEntry: number;
  vMin: number;
  /** Peak deceleration, m/s^2. */
  severity: number;
  duration: number;
}

export interface SpeedProfile {
  /** Speed at each sample, m/s (aligned to track.samples). */
  v: Float64Array;
  lapTime: number;
  vMax: number;
  vMin: number;
  vAvg: number;
  /** Fraction of lap distance at full throttle. */
  fullThrottle: number;
  brakingZones: BrakingZone[];
}

/** Lateral accel capability at speed v with banking assist. */
function latCap(spec: VehicleSpec, v: number, bank: number): number {
  const base = Math.min(spec.aLat + spec.downforceK * v * v, spec.aLatMax);
  // banking tilts the load vector: effective cornering capability rises
  const tb = Math.tan(bank);
  const cap = (base + G * tb) / Math.max(0.55, 1 - (base / G) * tb * 0.5);
  return Math.max(2, cap);
}

/** Compute the estimated speed profile for a track + vehicle. */
export function computeSpeedProfile(track: Track, spec: VehicleSpec): SpeedProfile {
  const n = track.samples.length;
  const ds = track.ds;
  const v = new Float64Array(n);
  const vLim = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const s = track.samples[i];
    const k = Math.abs(s.kappa);
    if (k < 1e-5) {
      vLim[i] = spec.vTop;
    } else {
      // iterate once: vLim depends on downforce which depends on v
      let vv = Math.sqrt(spec.aLat / k);
      const cap = latCap(spec, vv, s.bank);
      vv = Math.sqrt(cap / k);
      vLim[i] = Math.min(spec.vTop, vv);
    }
  }

  // grade at each sample (central difference)
  const grade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = track.samples[(i - 1 + n) % n].z;
    const b = track.samples[(i + 1) % n].z;
    grade[i] = (b - a) / (2 * ds);
  }

  // initialize at the curvature limit, then relax:
  // forward passes enforce acceleration limits, backward passes braking.
  for (let i = 0; i < n; i++) v[i] = vLim[i];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const accel = Math.max(
        0.6,
        spec.aAccel * (1 - v[i] / spec.vTop) - G * grade[i] * 0.85,
      );
      const reach = Math.sqrt(v[i] * v[i] + 2 * accel * ds);
      if (v[j] > reach) v[j] = reach;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const decel = spec.aBrake + G * Math.max(-0.02, grade[i]) * 0.5;
      const allowed = Math.sqrt(v[j] * v[j] + 2 * decel * ds);
      if (v[i] > allowed) v[i] = allowed;
    }
  }

  // stats
  let lapTime = 0;
  let vMax = 0;
  let vMin = Infinity;
  let vSum = 0;
  let throttleDist = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vAvg = (v[i] + v[j]) / 2;
    lapTime += ds / Math.max(1, vAvg);
    if (v[i] > vMax) vMax = v[i];
    if (v[i] < vMin) vMin = v[i];
    vSum += v[i];
    // full throttle: accelerating, or holding the drag-limited top speed
    const dv2 = v[j] * v[j] - v[i] * v[i];
    const accelMeas = dv2 / (2 * ds);
    if (accelMeas > 0.7 || v[i] > 0.995 * spec.vTop) throttleDist += ds;
  }

  // braking zones: contiguous regions where backward pass bit hard
  const brakingZones: BrakingZone[] = [];
  let zStart = -1;
  let vEntry = 0;
  let minV = Infinity;
  let peakDecel = 0;
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const jNext = (idx + 1) % n;
    const decel = i < n ? (v[idx] * v[idx] - v[jNext] * v[jNext]) / (2 * ds) : 0;
    const braking = decel > 2.5;
    if (braking && zStart < 0) {
      zStart = idx;
      vEntry = v[idx];
      minV = v[idx];
      peakDecel = decel;
    } else if (braking) {
      if (v[jNext] < minV) minV = v[jNext];
      if (decel > peakDecel) peakDecel = decel;
    } else if (zStart >= 0) {
      const len = (((idx - zStart) % n) + n) % n;
      if (len * ds > 15) {
        brakingZones.push({
          sStart: zStart * ds,
          sEnd: idx * ds,
          vEntry,
          vMin: minV,
          severity: peakDecel,
          duration: (len * ds) / Math.max(1, (vEntry + minV) / 2),
        });
      }
      zStart = -1;
    }
  }

  return {
    v,
    lapTime,
    vMax,
    vMin,
    vAvg: vSum / n,
    fullThrottle: throttleDist / track.length,
    brakingZones,
  };
}

/** Convenience: write the speed profile into track.samples[].speed. */
export function applySpeedProfile(track: Track, profile: SpeedProfile): void {
  for (let i = 0; i < track.samples.length; i++) {
    track.samples[i].speed = profile.v[i];
  }
}
