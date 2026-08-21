/**
 * Facility site selection: score candidate pit-straight windows and pick a
 * side. Never defaults to s=0 or a hardcoded side; penalizes bridges,
 * tunnels, shelves, steep cross-slopes, and cramped land. Reports rejected
 * candidates with reasons for the debug layer.
 */

import { civilKindAt } from "../civil";
import { mulberry32 } from "../prng";
import { sampleAt } from "../types";
import type { Track } from "../types";
import type { FacilitySitePlan, GroundSurface } from "./types";

interface Candidate {
  sStart: number;
  sEnd: number;
  lengthM: number;
  meanAbsKappa: number;
  meanAbsGrade: number;
}

/** Straight-ish windows (low curvature, gentle grade) of at least minLen. */
export function findStraightWindows(track: Track, minLen = 300): Candidate[] {
  const n = track.samples.length;
  const ds = track.ds;
  const out: Candidate[] = [];
  let runStart = -1;
  let kSum = 0;
  let gSum = 0;
  const kappaAt = (i: number) => Math.abs(track.samples[i % n].kappa);
  const gradeAt = (i: number) => {
    const a = track.samples[i % n];
    const b = track.samples[(i + 1) % n];
    return Math.abs(b.z - a.z) / ds;
  };
  for (let i = 0; i <= n; i++) {
    const ok = i < n && kappaAt(i) < 0.0016 && gradeAt(i) < 0.035;
    if (ok && runStart < 0) {
      runStart = i;
      kSum = 0;
      gSum = 0;
    }
    if (ok) {
      kSum += kappaAt(i);
      gSum += gradeAt(i);
    }
    if ((!ok || i === n) && runStart >= 0) {
      const len = (i - runStart) * ds;
      if (len >= minLen) {
        out.push({
          sStart: runStart * ds,
          sEnd: i * ds,
          lengthM: len,
          meanAbsKappa: kSum / (i - runStart),
          meanAbsGrade: gSum / (i - runStart),
        });
      }
      runStart = -1;
    }
  }
  return out;
}

/** How much of the window sits on elevated/underground civil spans (0..1). */
function structureFraction(track: Track, sStart: number, sEnd: number): number {
  if (!track.civil) return 0;
  let bad = 0;
  const step = 10;
  for (let s = sStart; s < sEnd; s += step) {
    const k = civilKindAt(track.civil.spans, s, track.length);
    if (["short-bridge", "viaduct", "tunnel", "gallery", "platform", "shelf"].includes(k)) bad += step;
  }
  return Math.min(1, bad / (sEnd - sStart));
}

/** Lateral land quality on one side: sample ground at increasing offsets. */
function landScore(
  track: Track,
  ground: GroundSurface | null,
  sStart: number,
  sEnd: number,
  side: "left" | "right",
): { score: number; reason: string } {
  if (!ground) return { score: 0.75, reason: "flat-synthetic-site" };
  const sign = side === "left" ? 1 : -1;
  let ok = 0;
  let total = 0;
  let worstSlope = 0;
  let worstDelta = 0;
  for (let s = sStart + 15; s < sEnd - 15; s += 30) {
    const p = sampleAt(track, s % track.length);
    const nx = -Math.sin(p.heading) * sign;
    const ny = Math.cos(p.heading) * sign;
    for (const off of [18, 32, 50, 70]) {
      total++;
      const g = ground.elevationAt(p.x + nx * off, p.y + ny * off);
      if (g === null) continue;
      const delta = Math.abs(g - p.z);
      const slope = ground.slopeAt ? ground.slopeAt(p.x + nx * off, p.y + ny * off) : 0;
      worstDelta = Math.max(worstDelta, delta);
      worstSlope = Math.max(worstSlope, slope);
      // foundations can absorb modest deltas; cliffs cannot
      if (delta < 14 && slope < 0.55) ok++;
    }
  }
  if (total === 0) return { score: 0.5, reason: "no-ground-data" };
  const cover = ok / total;
  const penalty = Math.min(0.35, worstDelta / 60) + Math.min(0.2, worstSlope / 5);
  return {
    score: Math.max(0.05, cover * 0.9 - penalty + 0.1),
    reason: `cover=${cover.toFixed(2)} maxDelta=${worstDelta.toFixed(1)} maxSlope=${worstSlope.toFixed(2)}`,
  };
}

const ELEVATED_KINDS = new Set(["short-bridge", "viaduct", "tunnel", "gallery"]);

/**
 * Pick the pit-straight window + side. Returns null when nothing usable
 * exists (caller marks the plan infeasible).
 */
export function selectFacilitySite(
  track: Track,
  ground: GroundSurface | null,
  facilitySeed: number,
  needLen = 320,
): FacilitySitePlan | null {
  const rejected: FacilitySitePlan["rejected"] = [];
  const rnd = mulberry32(facilitySeed ^ 0x51e);
  const windows = findStraightWindows(track, Math.min(needLen, 260));
  if (windows.length === 0) return null;

  // s=0 currently hosts the start/finish; prefer the window containing it,
  // but don't force it — a better window may win on land/structure.
  let best: { c: Candidate; side: "left" | "right"; score: number } | null = null;
  for (const c of windows) {
    const structF = structureFraction(track, c.sStart, c.sEnd);
    if (structF > 0.5) {
      rejected.push({ sStart: c.sStart, sEnd: c.sEnd, side: "left", reason: `structure ${(structF * 100) | 0}%` });
      continue;
    }
    for (const side of ["left", "right"] as const) {
      const land = landScore(track, ground, c.sStart, c.sEnd, side);
      const straightScore = Math.max(0, 1 - c.meanAbsKappa / 0.0016) * 0.35;
      const gradeScore = Math.max(0, 1 - c.meanAbsGrade / 0.035) * 0.15;
      const structScore = (1 - structF) * 0.2;
      const lenScore = Math.min(1, c.lengthM / (needLen * 1.8)) * 0.1;
      const containsSF = c.sStart <= 40 || c.sEnd >= track.length - 40 ? 0.12 : 0;
      const jitter = rnd() * 0.03;
      const score = straightScore + gradeScore + structScore + lenScore + containsSF + land.score * 0.28 + jitter;
      if (score < 0.42) {
        rejected.push({ sStart: c.sStart, sEnd: c.sEnd, side, reason: `score ${score.toFixed(2)} (${land.reason})` });
        continue;
      }
      if (!best || score > best.score) best = { c, side, score };
    }
  }
  if (!best) {
    for (const c of windows) rejected.push({ sStart: c.sStart, sEnd: c.sEnd, side: "left", reason: "all sides failed land/structure" });
    return null;
  }
  return {
    sStart: best.c.sStart,
    sEnd: best.c.sEnd,
    side: best.side,
    score: Math.min(1, best.score),
    rejected,
  };
}

/** Is an s position on an elevated/underground civil span? */
export function onStructure(track: Track, s: number): boolean {
  if (!track.civil) return false;
  return ELEVATED_KINDS.has(civilKindAt(track.civil.spans, s, track.length));
}
