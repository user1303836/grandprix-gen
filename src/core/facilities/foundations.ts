/**
 * Foundations: sample terrain beneath every major footprint, choose a
 * datum, and produce a foundation plan (slab / stepped plinth / terrace /
 * podium / piles). Buildings then sit on their datum — never float, never
 * silently penetrate the ground.
 */

import type { GroundSurface, FoundationPlan, Polygon2D, Vec2 } from "./types";

export interface FootprintStats {
  min: number;
  max: number;
  mean: number;
  slope: number;
  samples: number;
}

/** Sample ground stats beneath a polygon (bounding-box lattice inside). */
export function footprintStats(ground: GroundSurface | null, poly: Polygon2D): FootprintStats {
  if (!ground || poly.length < 3) return { min: 0, max: 0, mean: 0, slope: 0, samples: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const step = Math.max(3, Math.min(12, Math.hypot(maxX - minX, maxY - minY) / 8));
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  let slopeSum = 0;
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (!pointInPolygon({ x, y }, poly)) continue;
      const z = ground.elevationAt(x, y);
      if (z === null) continue;
      min = Math.min(min, z);
      max = Math.max(max, z);
      sum += z;
      n++;
      if (ground.slopeAt) slopeSum += ground.slopeAt(x, y);
    }
  }
  if (n === 0) return { min: 0, max: 0, mean: 0, slope: 0, samples: 0 };
  return { min, max, mean: sum / n, slope: slopeSum / n, samples: n };
}

export function pointInPolygon(p: Vec2, poly: Polygon2D): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonOfRect(cx: number, cy: number, halfU: number, halfV: number, heading: number): Polygon2D {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const pts: Vec2[] = [
    { x: -halfU, y: -halfV },
    { x: halfU, y: -halfV },
    { x: halfU, y: halfV },
    { x: -halfU, y: halfV },
  ];
  // rotate in PLAN (heading around z-up); note plan y maps to world -z, but
  // for a rectangle the plan-space rotation is sufficient
  return pts.map((p) => ({
    x: cx + p.x * c - p.y * s,
    y: cy + p.x * s + p.y * c,
  }));
}

/**
 * Choose a foundation for a footprint.
 * @param targetZ   desired finished-floor elevation (e.g. pit-lane apron z)
 * @param stats     ground stats beneath the footprint
 * @param kind pref optional preferred kind (temporary footings etc.)
 */
export function chooseFoundation(
  id: string,
  footprint: Polygon2D,
  stats: FootprintStats,
  targetZ: number,
  preferred?: FoundationPlan["kind"],
): FoundationPlan {
  const range = stats.max - stats.min;
  let kind: FoundationPlan["kind"];
  if (preferred) kind = preferred;
  else if (stats.samples === 0 || range < 0.6) kind = "slab-on-grade";
  else if (range < 2.5) kind = "cut-fill-pad";
  else if (range < 6) kind = "stepped-plinth";
  else if (stats.slope > 0.4) kind = "retaining-terrace";
  else kind = "column-deck";

  // datum: floor sits at targetZ; the pad meets the ground at min side.
  // For big drops we still use ONE datum (the building never warps) and the
  // supports grow longer — the validation reports the max support height.
  const datumZ = [targetZ];
  if (kind === "stepped-plinth" && range > 2.5) {
    datumZ.length = 0;
    const steps = Math.min(3, Math.ceil(range / 2.4));
    for (let k = 0; k < steps; k++) datumZ.push(targetZ + (range * k) / steps * 0); // building stays level; steps are in the PLINTH below
  }

  // support points: footprint corners + edge midpoints
  const supports: FoundationPlan["supports"] = [];
  for (const p of footprint) supports.push({ x: p.x, y: p.y, topZ: targetZ });
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % footprint.length];
    supports.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, topZ: targetZ });
  }
  return {
    id,
    kind,
    footprint,
    datumZ: [targetZ],
    ground: { min: stats.min, max: stats.max, mean: stats.mean, slope: stats.slope },
    supports,
  };
}

/** Render-ready info: how far each support reaches below the datum. */
export function supportDepths(f: FoundationPlan, ground: GroundSurface | null): number[] {
  return f.supports.map((s) => {
    const g = ground?.elevationAt(s.x, s.y);
    return g === null || g === undefined ? 0 : Math.max(0, s.topZ - g);
  });
}
