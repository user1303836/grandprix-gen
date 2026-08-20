/**
 * Direct section editing: lock the part you like, regenerate the rest.
 *
 * Works on structural DNA: elements whose center station falls inside the
 * locked range are kept verbatim; the remaining contiguous gap is filled
 * with a freshly generated run of elements, winding is re-normalized, and
 * the build pipeline re-closes the loop.
 */

import { Rng, saltSeed } from "./prng";
import { morphElements, cornerLengths } from "./elements";
import { generateElements } from "./generator";
import { buildTrack, type BuildOptions, type BuildResult } from "./build";
import type { AlignmentElement, Track, TrackParams } from "./types";

export interface LockRange {
  sStart: number;
  sEnd: number;
}

/** Compute the s-range of each element in the built track. */
export function elementSRanges(track: Track): { el: AlignmentElement; index: number; s0: number; s1: number }[] {
  const els = morphElements(track.dna.elements, track.params, track.dna.base);
  const totalEl = els.reduce((acc, el) => acc + (el.type === "straight" ? el.length : cornerLengths(el).total), 0);
  const scale = track.length / Math.max(1, totalEl);
  const out: { el: AlignmentElement; index: number; s0: number; s1: number }[] = [];
  let s = 0;
  els.forEach((el, index) => {
    const len = (el.type === "straight" ? el.length : cornerLengths(el).total) * scale;
    out.push({ el, index, s0: s, s1: s + len });
    s += len;
  });
  return out;
}

function inLock(sCenter: number, lock: LockRange, L: number): boolean {
  const a = lock.sStart;
  const b = lock.sEnd;
  const s = ((sCenter % L) + L) % L;
  if (a <= b) return s >= a && s <= b;
  return s >= a || s <= b; // wraps the origin
}

/**
 * Regenerate everything outside [sStart, sEnd], keeping the locked
 * section's elements. Deterministic in (track, lock, seed, params).
 */
export function regenerateOutsideLock(
  track: Track,
  lock: LockRange,
  params: TrackParams,
  seed: number,
  opts: BuildOptions = {},
): BuildResult {
  const L = track.length;
  const ranges = elementSRanges(track);

  // find the contiguous run of elements inside the lock
  const kept = ranges.filter((r) => inLock((r.s0 + r.s1) / 2, lock, L));
  if (kept.length === 0) {
    return { track: null, closureError: Infinity, failReason: "lock-range-empty" };
  }
  const keptIndices = new Set(kept.map((k) => k.index));
  const firstKept = Math.min(...keptIndices);
  const lastKept = Math.max(...keptIndices);

  // kept run must be contiguous (everything inside the lock stays)
  const lockedElements = ranges.slice(firstKept, lastKept + 1).map((r) => ({ ...r.el }));
  const lockedLen = lockedElements.reduce(
    (acc, el) => acc + (el.type === "straight" ? el.length : cornerLengths(el).total),
    0,
  );

  // generate a fresh full sequence from the salted seed and take a run that
  // fills the remaining budget
  const rng = new Rng(saltSeed(seed, 9182));
  const gapBudget = Math.max(300, params.targetLength - lockedLen);
  const fresh = generateElements(rng, { ...params });
  // rotate fresh list to a random start, then take elements until the gap
  // budget is roughly filled (favor straights at the ends for splicing)
  const rot = rng.int(0, fresh.length - 1);
  const rotated = [...fresh.slice(rot), ...fresh.slice(0, rot)];
  const fill: AlignmentElement[] = [];
  let fillLen = 0;
  for (const el of rotated) {
    const len = el.type === "straight" ? el.length : cornerLengths(el).total;
    if (fillLen > gapBudget && el.type === "straight") break;
    fill.push({ ...el });
    fillLen += len;
    if (fill.length >= fresh.length) break;
  }

  // splice: [fill..., locked...]
  const elements = [...fill, ...lockedElements];

  // re-normalize total turning to one winding
  const windingSign = Math.sign(
    track.dna.elements.reduce((acc, e) => (e.type === "corner" ? acc + e.dir * e.angle : acc), 0),
  ) || 1;
  const target = windingSign * 2 * Math.PI;
  const corners = elements.filter((e): e is Extract<AlignmentElement, { type: "corner" }> => e.type === "corner");
  // keep locked corners fixed where possible: distribute correction onto the
  // freshly filled corners first
  const freshCorners = corners.slice(0, corners.length - lockedElements.filter((e) => e.type === "corner").length);
  for (let pass = 0; pass < 5; pass++) {
    const sum = corners.reduce((acc, c) => acc + c.dir * c.angle, 0);
    const err = target - sum;
    if (Math.abs(err) < 0.02) break;
    const pool = freshCorners.length > 0 ? freshCorners : corners;
    const poolAngle = pool.reduce((acc, c) => acc + c.angle, 0);
    if (poolAngle < 0.1) break;
    for (const c of pool) {
      c.angle = Math.max(0.22, c.angle + ((err * (c.angle / poolAngle)) / c.dir) * 0.9);
    }
  }

  const dna = {
    elements,
    deform: track.dna.deform,
    base: track.dna.base,
  };
  const result = buildTrack(track.seed, params, dna, opts);
  return result;
}
