/**
 * Corner and sector detection from the canonical curvature profile.
 */

import type { Corner, Sector } from "./types";

const KAPPA_THRESHOLD = 1 / 600; // corners are radius < 600 m
const MERGE_GAP_M = 30;
const MIN_CORNER_ANGLE = 0.06; // ~3.4 deg
const MIN_CORNER_LENGTH = 6;

export function detectCorners(
  kappa: Float64Array,
  ds: number,
  startFinishS: number,
): Corner[] {
  const n = kappa.length;
  const L = n * ds;
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) active[i] = Math.abs(kappa[i]) > KAPPA_THRESHOLD ? 1 : 0;

  // find runs on the circle
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  // rotate so we start in an inactive region if possible
  let offset = 0;
  for (let k = 0; k < n; k++) {
    if (!active[k]) {
      offset = k;
      break;
    }
  }
  let runStart = -1;
  for (let k = 0; k <= n; k++) {
    const idx = (offset + k) % n;
    const isActive = k < n ? active[idx] : 0;
    if (isActive && runStart < 0) runStart = idx;
    if (!isActive && runStart >= 0) {
      runs.push({ start: runStart, end: (idx - 1 + n) % n });
      runStart = -1;
    }
  }
  void i;

  // merge runs separated by small gaps
  const gapN = Math.max(1, Math.round(MERGE_GAP_M / ds));
  const merged: { start: number; end: number }[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last) {
      const gap = (r.start - last.end + n) % n;
      if (gap <= gapN) {
        last.end = r.end;
        continue;
      }
    }
    merged.push({ start: r.start, end: r.end });
  }
  // possibly merge first and last (they wrap around origin)
  if (merged.length > 1) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    const gap = (first.start - last.end + n) % n;
    if (gap <= gapN) {
      last.end = first.end;
      merged.shift();
    }
  }

  const corners: Corner[] = [];
  for (const r of merged) {
    const len = ((r.end - r.start + n) % n) + 1;
    const lengthM = len * ds;
    if (lengthM < MIN_CORNER_LENGTH) continue;
    let maxK = 0;
    let apexIdx = r.start;
    let angle = 0;
    let dir = 0;
    for (let k = 0; k < len; k++) {
      const idx = (r.start + k) % n;
      const kv = kappa[idx];
      angle += kv * ds;
      if (Math.abs(kv) > maxK) {
        maxK = Math.abs(kv);
        apexIdx = idx;
        dir = Math.sign(kv);
      }
    }
    if (Math.abs(angle) < MIN_CORNER_ANGLE) continue;
    const sStart = r.start * ds;
    const sApex = apexIdx * ds;
    const sEnd = ((r.end + 1) % n) * ds;
    corners.push({
      id: 0,
      sStart,
      sApex,
      sEnd: sEnd >= L ? sEnd - L : sEnd,
      direction: (dir >= 0 ? "L" : "R") as "L" | "R",
      minRadius: maxK > 1e-9 ? 1 / maxK : Infinity,
      length: lengthM,
      angle: Math.abs(angle),
    });
  }

  // Renumber in driving order starting after start/finish.
  corners.sort((a, b) => relS(a.sStart, startFinishS, L) - relS(b.sStart, startFinishS, L));
  corners.forEach((c, idx) => (c.id = idx + 1));
  return corners;
}

function relS(s: number, origin: number, L: number): number {
  return (((s - origin) % L) + L) % L;
}

/** Find the midpoint of the longest straight (low-curvature run). */
export function findStartFinish(kappa: Float64Array, ds: number): number {
  const n = kappa.length;
  const thresh = 1 / 800;
  let bestLen = 0;
  let bestMid = 0;
  let runStart = -1;
  for (let k = 0; k < 2 * n; k++) {
    const idx = k % n;
    const straight = Math.abs(kappa[idx]) < thresh;
    if (straight && runStart < 0) runStart = k;
    const endNow = !straight || k === 2 * n - 1;
    if (endNow && runStart >= 0) {
      const len = k - runStart;
      if (len * ds > 40 && len > bestLen) {
        bestLen = len;
        bestMid = ((runStart + len / 2) % n) * ds;
      }
      runStart = -1;
    }
  }
  return bestMid;
}

/** Three equal sectors starting at start/finish. */
export function makeSectors(L: number, startFinishS: number): Sector[] {
  const third = L / 3;
  const sectors: Sector[] = [];
  for (let i = 0; i < 3; i++) {
    const s0 = (startFinishS + i * third) % L;
    const s1 = (startFinishS + (i + 1) * third) % L;
    sectors.push({ index: i + 1, sStart: s0, sEnd: s1 });
  }
  return sectors;
}
