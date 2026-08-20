/**
 * Geometric validity checks. This is plausibility linting, not any form of
 * regulatory certification ("Realistic" mode applies stricter limits).
 */

import { analyzeIntersections, minRadius } from "./geometry";
import { maxGradeOf } from "./vertical";
import type { Track, TrackParams } from "./types";

export interface ValidationReport {
  valid: boolean;
  issues: string[];
  minCornerRadius: number;
  minSeparation: number;
  maxGrade: number;
  lengthError: number;
}

export function validateTrack(track: Track, params: TrackParams): ValidationReport {
  const issues: string[] = [];
  const n = track.samples.length;

  // NaN / Infinity scan
  let finite = true;
  for (let i = 0; i < n; i++) {
    const s = track.samples[i];
    if (
      !Number.isFinite(s.x) ||
      !Number.isFinite(s.y) ||
      !Number.isFinite(s.z) ||
      !Number.isFinite(s.heading) ||
      !Number.isFinite(s.kappa)
    ) {
      finite = false;
      break;
    }
  }
  if (!finite) issues.push("non-finite geometry");

  // length (terrain sites may clamp the footprint, so be lenient there)
  const lengthError = Math.abs(track.length - params.targetLength) / params.targetLength;
  const lenTol = track.terrain ? 0.3 : 0.03;
  if (lengthError > lenTol) issues.push(`length off by ${(lengthError * 100).toFixed(1)}%`);

  // curvature
  const kappaArr = new Float64Array(n);
  for (let i = 0; i < n; i++) kappaArr[i] = track.samples[i].kappa;
  const minR = minRadius(kappaArr);
  const minAllowed = params.mode === "realistic" ? 11 : 6;
  if (minR < minAllowed) issues.push(`corner radius ${minR.toFixed(1)} m below ${minAllowed} m`);

  // curvature continuity (jerk proxy)
  let maxJerk = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const jerk = Math.abs(kappaArr[j] - kappaArr[i]) / track.ds;
    if (jerk > maxJerk) maxJerk = jerk;
  }
  if (maxJerk > 0.035) issues.push(`curvature discontinuity (jerk ${maxJerk.toFixed(4)})`);

  // self-intersection / separation
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = track.samples[i].x;
    ys[i] = track.samples[i].y;
  }
  const inter = analyzeIntersections(xs, ys, track.ds);
  if (inter.intersections > 0) issues.push(`${inter.intersections} self-intersection(s)`);
  const minWidth = params.width;
  if (inter.minSeparation < minWidth * 1.6) {
    issues.push(`segments too close (${inter.minSeparation.toFixed(1)} m)`);
  }

  // grades
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) zs[i] = track.samples[i].z;
  const gMax = maxGradeOf(zs, track.ds);
  const gradeLimit = params.maxGrade * (track.terrain ? 1.25 : 1.05);
  if (gMax > gradeLimit) issues.push(`grade ${(gMax * 100).toFixed(1)}% exceeds limit`);

  // degenerate segments
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    if (d < track.ds * 0.3) {
      issues.push("degenerate segment spacing");
      break;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    minCornerRadius: minR,
    minSeparation: inter.minSeparation,
    maxGrade: gMax,
    lengthError,
  };
}
