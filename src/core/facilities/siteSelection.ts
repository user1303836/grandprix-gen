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

/** Straight-ish windows (low curvature, gentle grade) of at least minLen.
 * Thresholds adapt to the track's own grade/curvature distribution so a
 * mountain circuit still yields its flattest candidates. */
export function findStraightWindows(track: Track, minLen = 300, kappaLimit?: number): Candidate[] {
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
  // adaptive grade limit: the 25th-percentile sample grade, clamped
  const grades = Array.from({ length: n }, (_, i) => gradeAt(i)).sort((a, b) => a - b);
  const p25 = grades[Math.floor(n * 0.25)] ?? 0.02;
  const gradeLimit = Math.min(0.08, Math.max(0.03, p25 * 1.35));
  const kLim = kappaLimit ?? 0.0022;
  for (let i = 0; i <= n; i++) {
    const ok = i < n && kappaAt(i) < kLim && gradeAt(i) < gradeLimit;
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

/** Trim a window to its longest contiguous at-grade sub-range.
 * Returns null when no ≥ minLen at-grade part exists. */
export function shrinkToAtGrade(track: Track, sStart: number, sEnd: number, minLen = 90): { sStart: number; sEnd: number } | null {
  if (!track.civil) return { sStart, sEnd };
  const step = 8;
  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  for (let s = sStart; s <= sEnd; s += step) {
    const k = civilKindAt(track.civil.spans, s, track.length);
    const ok = !["short-bridge", "viaduct", "tunnel", "gallery"].includes(k);
    if (ok && runStart < 0) runStart = s;
    if ((!ok || s + step > sEnd) && runStart >= 0) {
      const runEnd = s;
      if (runEnd - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = runEnd;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0 || bestEnd - bestStart < minLen) return null;
  return { sStart: bestStart, sEnd: bestEnd };
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
  let windows = findStraightWindows(track, Math.min(needLen, 260));
  if (windows.length === 0) windows = findStraightWindows(track, 200);
  if (windows.length === 0) windows = findStraightWindows(track, 150);
  // gently curving pit straights are real (Interlagos, Suzuka): relaxed tier
  if (windows.length === 0) windows = findStraightWindows(track, 140, 0.004);
  if (windows.length === 0) windows = findStraightWindows(track, 100, 0.004);
  if (windows.length === 0) return null;

  // s=0 currently hosts the start/finish; prefer the window containing it,
  // but don't force it — a better window may win on land/structure.
  let best: { c: Candidate; side: "left" | "right"; score: number } | null = null;
  for (const c of windows) {
    const structF = structureFraction(track, c.sStart, c.sEnd);
    for (const side of ["left", "right"] as const) {
      const land = landScore(track, ground, c.sStart, c.sEnd, side);
      const straightScore = Math.max(0, 1 - c.meanAbsKappa / 0.0016) * 0.35;
      const gradeScore = Math.max(0, 1 - c.meanAbsGrade / 0.035) * 0.15;
      const structScore = (1 - structF) * 0.2;
      const lenScore = Math.min(1, c.lengthM / (needLen * 1.8)) * 0.1;
      const containsSF = c.sStart <= 40 || c.sEnd >= track.length - 40 ? 0.12 : 0;
      const jitter = rnd() * 0.03;
      const score = straightScore + gradeScore + structScore + lenScore + containsSF + land.score * 0.28 + jitter;
      // keep every scored candidate; the best one wins even below the
      // ideal threshold (the prompt's fallback chain: smaller/compact
      // facilities on the least-bad site rather than silent floating)
      if (score < 0.42) {
        rejected.push({ sStart: c.sStart, sEnd: c.sEnd, side, reason: `score ${score.toFixed(2)} (${land.reason})` });
      }
      if (!best || score > best.score) best = { c, side, score };
    }
  }
  if (!best) {
    for (const c of windows) rejected.push({ sStart: c.sStart, sEnd: c.sEnd, side: "left", reason: "all sides failed land/structure" });
    return null;
  }
  // never put a permanent pit complex on a structure: trim the window to
  // its longest at-grade part; if nothing remains, try the next candidates
  // candidates in score order; first one with a usable at-grade part wins
  const all: { c: Candidate; side: "left" | "right"; score: number }[] = [];
  for (const c of windows) {
    const structF2 = structureFraction(track, c.sStart, c.sEnd);
    for (const side of ["left", "right"] as const) {
      const land = landScore(track, ground, c.sStart, c.sEnd, side);
      const score =
        Math.max(0, 1 - c.meanAbsKappa / 0.0022) * 0.3 +
        Math.max(0, 1 - c.meanAbsGrade / 0.06) * 0.15 +
        (1 - structF2) * 0.22 +
        Math.min(1, c.lengthM / (needLen * 1.8)) * 0.08 +
        (c.sStart <= 40 || c.sEnd >= track.length - 40 ? 0.1 : 0) +
        land.score * 0.24;
      all.push({ c, side, score });
    }
  }
  all.sort((a, b) => b.score - a.score);
  for (const cand of all) {
    const trimmed = shrinkToAtGrade(track, cand.c.sStart, cand.c.sEnd);
    if (trimmed) {
      return {
        sStart: trimmed.sStart,
        sEnd: trimmed.sEnd,
        side: cand.side,
        score: Math.min(1, cand.score),
        rejected,
      };
    }
    rejected.push({ sStart: cand.c.sStart, sEnd: cand.c.sEnd, side: cand.side, reason: "no at-grade sub-range" });
  }
  return null;
}

/** Is an s position on an elevated/underground civil span? */
export function onStructure(track: Track, s: number): boolean {
  if (!track.civil) return false;
  return ELEVATED_KINDS.has(civilKindAt(track.civil.spans, s, track.length));
}
