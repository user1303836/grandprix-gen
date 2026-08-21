/**
 * Structures: classify where the road deviates from the ground into
 * civil-engineering structures -- bridges/viaducts over dips, embankments
 * on fills, retaining walls and rock cuts through rises, and tunnels under
 * ridges. The pairing rule is absolute: the road never clips the terrain;
 * wherever earthworks alone can't seat it, a structure occupies the gap.
 */

import { Rng, saltSeed } from "./prng";

export type StructureKind = "bridge" | "tunnel" | "retaining" | "rock-cut" | "embankment";

export interface StructureSpan {
  kind: StructureKind;
  sStart: number;
  sEnd: number;
  /** min/max deviation (z - ground) inside the span, meters. */
  minD: number;
  maxD: number;
  /** retaining/rock-cut: which side(s) hold the hill */
  side: "left" | "right" | "both";
  seed: number;
}

export interface StructureInput {
  seed: number;
  z: Float64Array;
  groundZ: Float64Array;
  ds: number;
  /** half width per sample (widthL+widthR combined handled by caller). */
  halfWidth: Float32Array;
  /** left/right ground offset samples for cut side detection. */
  groundLeft?: Float64Array | null;
  groundRight?: Float64Array | null;
}

/** Thresholds (meters of deviation z-ground). */
const FILL_EMBANK = 0.9; // beyond this the fill becomes visible as embankment
const FILL_BRIDGE = 4.2; // beyond this a fill span needs a deck + piers
const CUT_RETAIN = 1.4; // shallow cut: retaining wall on the uphill side(s)
const CUT_ROCK = 4.5; // deeper: rock cutting faces
const CUT_TUNNEL = 9; // very deep + long: bore a tunnel instead

const MIN_SPAN_M = 26; // ignore blips shorter than this
const MERGE_GAP_M = 30; // merge same-kind spans separated by less

interface RawSpan {
  kind: StructureKind;
  i0: number; // inclusive sample index (linear, may exceed n)
  i1: number; // exclusive
  minD: number;
  maxD: number;
}

/** Classify deviation into spans; also returns the per-sample carve mask. */
export function classifyStructures(input: StructureInput): {
  spans: StructureSpan[];
  carveMask: Uint8Array;
} {
  const { z, groundZ, ds, seed } = input;
  const n = z.length;
  const hasGround = Number.isFinite(groundZ[0]);
  const carveMask = new Uint8Array(n).fill(1);
  if (!hasGround) return { spans: [], carveMask };

  // per-sample class (doubled domain to handle the seam)
  const cls = new Int8Array(2 * n);
  const d = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i++) {
    const dev = z[i % n] - groundZ[i % n];
    d[i] = dev;
    if (dev >= FILL_BRIDGE) cls[i] = 3; // bridge candidate
    else if (dev >= FILL_EMBANK) cls[i] = 2; // embankment
    else if (dev <= -CUT_TUNNEL) cls[i] = -3; // tunnel candidate
    else if (dev <= -CUT_ROCK) cls[i] = -2; // rock cut
    else if (dev <= -CUT_RETAIN) cls[i] = -1; // retaining
    else cls[i] = 0;
  }

  // smooth the classification to avoid 1-sample flicker (majority over ~12 m)
  const win = Math.max(1, Math.round(6 / ds));
  const sm = new Int8Array(2 * n);
  for (let i = 0; i < 2 * n; i++) {
    const counts = new Map<number, number>();
    for (let k = Math.max(0, i - win); k <= Math.min(2 * n - 1, i + win); k++) {
      counts.set(cls[k], (counts.get(cls[k]) ?? 0) + 1);
    }
    let best = 0;
    let bestC = -1;
    for (const [c, cnt] of counts) {
      if (cnt > bestC || (cnt === bestC && Math.abs(c) > Math.abs(best))) {
        best = c;
        bestC = cnt;
      }
    }
    sm[i] = best;
  }

  // find the seam-safe start: a 0-class position near i=0
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (sm[i] === 0) {
      start = i;
      break;
    }
  }

  // extract raw runs over [start, start+n)
  const runs: RawSpan[] = [];
  let i = start;
  const end = start + n;
  while (i < end) {
    const c = sm[i];
    if (c === 0) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < end && sm[j] === c) j++;
    let mn = Infinity;
    let mx = -Infinity;
    for (let k = i; k < j; k++) {
      if (d[k] < mn) mn = d[k];
      if (d[k] > mx) mx = d[k];
    }
    const kind: StructureKind =
      c === 3 ? "bridge" : c === 2 ? "embankment" : c === -3 ? "tunnel" : c === -2 ? "rock-cut" : "retaining";
    runs.push({ kind, i0: i, i1: j, minD: mn, maxD: mx });
    i = j;
  }

  // drop tiny spans, then merge same-kind spans across small gaps
  const minLen = Math.max(1, Math.round(MIN_SPAN_M / ds));
  const mergeGap = Math.max(1, Math.round(MERGE_GAP_M / ds));
  const kept = runs.filter((r) => r.i1 - r.i0 >= minLen || r.kind === "embankment");
  const merged: RawSpan[] = [];
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && last.kind === r.kind && r.i0 - last.i1 <= mergeGap) {
      last.i1 = r.i1;
      last.minD = Math.min(last.minD, r.minD);
      last.maxD = Math.max(last.maxD, r.maxD);
    } else {
      merged.push({ ...r });
    }
  }

  // refine kinds by span statistics
  const spans: StructureSpan[] = [];
  for (const r of merged) {
    let kind = r.kind;
    const lenM = (r.i1 - r.i0) * ds;
    if (kind === "tunnel") {
      // tunnels need length + depth; otherwise it's an open rock cut
      if (lenM < 90 || r.minD > -CUT_TUNNEL - 2) kind = "rock-cut";
    }
    if (kind === "bridge" && r.maxD < FILL_BRIDGE + 1.5) kind = "embankment";
    const sStart = ((r.i0 % n) * ds) % (n * ds);
    const sEnd = ((r.i1 % n) * ds) % (n * ds);
    spans.push({
      kind,
      sStart,
      sEnd,
      minD: r.minD,
      maxD: r.maxD,
      side: "both",
      seed: saltSeed(seed, spans.length * 91 + 7),
    });
  }

  // cut side detection via offset ground samples
  for (const sp of spans) {
    if (sp.kind !== "retaining" && sp.kind !== "rock-cut") continue;
    if (!input.groundLeft || !input.groundRight) break;
    const i0 = Math.round(sp.sStart / ds) % n;
    const i1 = Math.round(sp.sEnd / ds) % n;
    let lHigher = 0;
    let rHigher = 0;
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      const zz = z[i];
      if (input.groundLeft[i] > zz + 1) lHigher++;
      if (input.groundRight[i] > zz + 1) rHigher++;
      i = (i + 1) % n;
    }
    sp.side = lHigher > rHigher * 2 ? "left" : rHigher > lHigher * 2 ? "right" : "both";
  }

  // carve mask: no carving under bridges/tunnels (structures own the gap)
  for (const sp of spans) {
    if (sp.kind !== "bridge" && sp.kind !== "tunnel") continue;
    const pad = Math.round(20 / ds);
    const i0 = Math.round(sp.sStart / ds) % n;
    const i1 = Math.round(sp.sEnd / ds) % n;
    for (let k = -pad; k < ((i1 - i0 + n) % n) + pad; k++) {
      carveMask[(i0 + k + n) % n] = 0;
    }
  }

  // deterministic rng touch (span seeds derived above)
  void Rng.fromSalt(seed, 8811);
  return { spans, carveMask };
}

/** Total meters per structure kind (metrics). */
export function structureTotals(spans: StructureSpan[]): Record<StructureKind, number> {
  const out: Record<StructureKind, number> = { bridge: 0, tunnel: 0, retaining: 0, "rock-cut": 0, embankment: 0 };
  for (const sp of spans) {
    const len = sp.sEnd >= sp.sStart ? sp.sEnd - sp.sStart : sp.sEnd; // wrapped spans rare after seam-safe start
    out[sp.kind] += len;
  }
  return out;
}
