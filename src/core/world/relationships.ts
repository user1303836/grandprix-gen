/**
 * Track/landscape relationship planner: assigns each arc position a
 * landscape role (at-grade, hillside bench, ridge, ravine crossing, ...).
 * A Viterbi/DP pass over per-sample role states with per-meter costs and
 * strong transition costs produces coherent spans instead of per-sample
 * flicker — same pattern as the civil planner.
 *
 * Placement is driven by the circuit's own semantics: compressions sit in
 * valleys, crests on ridges, hairpins become switchbacks, long straights
 * take valley floors/plateaus, start/pit gets developed flat ground.
 */

import { Rng } from "../prng";
import type { Corner, TrackSample } from "../types";
import type { TrackFeature } from "../character";
import type { EnvironmentIdentity, EnvironmentParams, RoleKind, RoleSpan } from "./types";

export interface RelationshipInput {
  samples: TrackSample[];
  corners: Corner[];
  features: TrackFeature[];
  ds: number;
  length: number;
  identity: EnvironmentIdentity;
  params: EnvironmentParams;
  envSeed: number;
}

const ROLES: RoleKind[] = [
  "at-grade",
  "hillside-bench",
  "open-cut",
  "embankment",
  "ridge",
  "valley-floor",
  "cliff-edge",
  "ravine-crossing",
  "river-crossing",
  "plateau",
  "forest-corridor",
  "tunnel-ridge",
  "developed",
];

// (span-length discipline comes from MIN_SPAN absorption below; rare roles
// are kept rare by their high per-meter local costs instead)

/** minimum coherent span length in meters */
const MIN_SPAN: Record<RoleKind, number> = {
  "at-grade": 90,
  "hillside-bench": 140,
  "open-cut": 90,
  embankment: 120,
  ridge: 150,
  "valley-floor": 160,
  "cliff-edge": 130,
  "ravine-crossing": 50,
  "river-crossing": 60,
  plateau: 180,
  "forest-corridor": 150,
  "tunnel-ridge": 90,
  developed: 180,
};

export function planRelationships(input: RelationshipInput): RoleSpan[] {
  const { samples, corners, features, ds, length, identity, params, envSeed } = input;
  const n = samples.length;
  const rng = new Rng(envSeed ^ 0x5e1f);

  // ---- per-sample semantic signals -------------------------------------
  const speedProxy = new Float32Array(n); // curvature-based "flow" 0..1
  const isCorner = new Uint8Array(n);
  const isHairpin = new Uint8Array(n);
  const isStraight = new Uint8Array(n);
  const isStart = new Uint8Array(n);
  const featCrest = new Uint8Array(n);
  const featCompression = new Uint8Array(n);
  const featHeritage = new Uint8Array(n);
  const featPit = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const k = Math.abs(samples[i].kappa);
    speedProxy[i] = Math.max(0, 1 - k * 900);
  }
  for (const c of corners) {
    const i0 = Math.round(c.sStart / ds) % n;
    const i1 = Math.round(c.sEnd / ds) % n;
    const span = (i1 - i0 + n) % n || n;
    for (let k = 0; k < span; k++) {
      const i = (i0 + k) % n;
      isCorner[i] = 1;
      if (c.minRadius < 45) isHairpin[i] = 1;
    }
  }
  // straights: low curvature runs
  {
    let run = 0;
    for (let i = 0; i < n * 2; i++) {
      const idx = i % n;
      if (Math.abs(samples[idx].kappa) < 0.0012) run++;
      else run = 0;
      if (run * ds > 180) isStraight[idx] = 1;
    }
  }
  const startIdx = (s: number): number => Math.round(s / ds) % n;
  const sWin = Math.round(350 / ds); // developed zone around start/finish
  for (let k = -sWin; k <= sWin; k++) isStart[(k + n) % n] = 1;

  for (const f of features) {
    const i0 = startIdx(f.sStart);
    const i1 = startIdx(f.sEnd);
    const span = (i1 - i0 + n) % n || n;
    for (let k = 0; k < span; k++) {
      const i = (i0 + k) % n;
      if (f.kind === "jump-crest" || f.kind === "blind-crest" || f.kind === "crest-corner") featCrest[i] = 1;
      if (f.kind === "compression" || f.kind === "compression-corner") featCompression[i] = 1;
      if (f.kind === "legacy-narrow" || f.kind === "retaining-run" || f.kind === "wall-run") featHeritage[i] = 1;
      if (f.kind === "pit-lane") featPit[i] = 1;
    }
  }

  // ---- landform role gates ----------------------------------------------
  const allowed = new Set<RoleKind>(["at-grade", "hillside-bench", "embankment", "open-cut", "forest-corridor", "developed"]);
  switch (identity.landform) {
    case "valley":
      allowed.add("valley-floor");
      allowed.add("ridge");
      if (identity.hydrology === "river") allowed.add("river-crossing");
      allowed.add("ravine-crossing");
      break;
    case "ridges":
      allowed.add("ridge");
      allowed.add("cliff-edge");
      allowed.add("tunnel-ridge");
      allowed.add("ravine-crossing");
      break;
    case "canyon":
      allowed.add("cliff-edge");
      allowed.add("ravine-crossing");
      allowed.add("river-crossing");
      allowed.add("tunnel-ridge");
      break;
    case "plateau":
      allowed.add("plateau");
      allowed.add("ridge");
      break;
    case "basin":
      allowed.add("plateau");
      allowed.add("valley-floor");
      break;
    case "island":
      allowed.add("plateau");
      allowed.add("valley-floor");
      allowed.add("cliff-edge");
      break;
    case "rolling-hills":
    default:
      allowed.add("valley-floor");
      allowed.add("ridge");
      if (identity.hydrology !== "dry") allowed.add("ravine-crossing");
      break;
  }
  if (params.realism === "fantasy") {
    allowed.add("tunnel-ridge");
    allowed.add("cliff-edge");
    allowed.add("ravine-crossing");
  }

  // ---- DP over tripled domain (seam-free middle-lap read) ---------------
  const roles = ROLES.filter((r) => allowed.has(r));
  const R = roles.length;
  const local = new Float32Array(n * R).fill(50);
  const waterBias = params.water;
  const drama = params.drama;

  for (let i = 0; i < n; i++) {
    const idx = i;
    for (let r = 0; r < R; r++) {
      const role = roles[r];
      let c = 1; // base
      switch (role) {
        case "at-grade":
          c = 0.9;
          break;
        case "developed":
          c = isStart[idx] || featPit[idx] ? 0.0 : 6;
          break;
        case "valley-floor":
          c = (isStraight[idx] ? 0.25 : 0.9) + (featCompression[idx] ? -0.35 : 0);
          break;
        case "ridge":
          c = (featCrest[idx] ? 0.05 : 0.75) + (speedProxy[idx] > 0.6 ? -0.15 : 0.1) + (1 - drama) * 0.8;
          break;
        case "hillside-bench":
          c = (isHairpin[idx] ? 0.15 : 0.55) + (isCorner[idx] ? -0.1 : 0.1);
          break;
        case "open-cut":
          c = (featHeritage[idx] ? 0.2 : 0.6) + (isCorner[idx] ? -0.05 : 0.15);
          break;
        case "embankment":
          c = 0.55 + (featCompression[idx] ? -0.3 : 0);
          break;
        case "ravine-crossing":
          c = 2.2 - drama * 0.9;
          break;
        case "river-crossing":
          c = 2.6 - waterBias * 1.1 - drama * 0.5;
          break;
        case "plateau":
          c = 0.6 + (isStraight[idx] ? -0.2 : 0.1);
          break;
        case "forest-corridor":
          c = 0.7 - params.vegetation * 0.55 + (featHeritage[idx] ? -0.15 : 0) + (isStraight[idx] ? -0.05 : 0);
          break;
        case "cliff-edge":
          c = 1.6 - drama * 0.7 + (isCorner[idx] && !isHairpin[idx] ? -0.2 : 0.1);
          break;
        case "tunnel-ridge":
          c = 2.8 - drama * 0.8 + (isStraight[idx] ? -0.2 : 0.2);
          break;
      }
      local[i * R + r] = c;
    }
  }

  // transition cost: discourage switching; some switches are nonsense
  const trans = new Float32Array(R * R).fill(1.4);
  for (let a = 0; a < R; a++) {
    for (let b = 0; b < R; b++) {
      if (a === b) trans[a * R + b] = 0;
      else if (
        (roles[a] === "ravine-crossing" && roles[b] === "river-crossing") ||
        (roles[a] === "river-crossing" && roles[b] === "ravine-crossing")
      ) {
        trans[a * R + b] = 3.2;
      } else if (roles[b] === "developed" && roles[a] !== "at-grade" && roles[a] !== "developed") {
        trans[a * R + b] = 2.6; // enter developed from calm ground
      }
    }
  }

  // DP (forward), tripled domain → read middle lap
  const INF = 1e9;
  let prev = new Float64Array(R).fill(0);
  const backPtr: Int16Array[] = [];
  const STEPS = n * 3;
  for (let i = 0; i < STEPS; i++) {
    const bp = new Int16Array(R);
    const next = new Float64Array(R).fill(INF);
    const li = (i % n) * R;
    for (let b = 0; b < R; b++) {
      const lc = local[li + b];
      if (lc >= 40) continue;
      for (let a = 0; a < R; a++) {
        const cost = prev[a] + trans[a * R + b];
        if (cost < next[b]) {
          next[b] = cost;
          bp[b] = a;
        }
      }
      next[b] += lc;
    }
    backPtr.push(bp);
    prev = next;
  }
  // backtrack from the best end state, then slice the middle lap
  let bestEnd = 0;
  for (let b = 1; b < R; b++) if (prev[b] < prev[bestEnd]) bestEnd = b;
  const path = new Int16Array(STEPS);
  let cur = bestEnd;
  for (let i = STEPS - 1; i >= 0; i--) {
    path[i] = cur;
    cur = backPtr[i][cur];
  }
  const mid = path.slice(n, n * 2); // middle lap: seam-free

  // ---- spans + min-length absorption -------------------------------------
  const spans: RoleSpan[] = [];
  let s0 = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || mid[i] !== mid[s0]) {
      spans.push({
        kind: roles[mid[s0]],
        sStart: s0 * ds,
        sEnd: (i * ds) % length,
        side: 0,
        intensity: 0.6 + rng.next() * 0.4,
      });
      s0 = i;
    }
  }
  // absorb too-short spans into the cheaper neighbor
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 40) {
    changed = false;
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      const len = spanLength(sp, length);
      if (len >= MIN_SPAN[sp.kind]) continue;
      // never absorb developed around start; never absorb the only span
      if (spans.length <= 1) break;
      const left = spans[(i - 1 + spans.length) % spans.length];
      const right = spans[(i + 1) % spans.length];
      // merge into the longer neighbor: extend it over the short span
      if (spanLength(left, length) >= spanLength(right, length)) left.sEnd = sp.sEnd;
      else right.sStart = sp.sStart;
      spans.splice(i, 1);
      changed = true;
      break;
    }
  }

  // ---- structural crossing seeding ----------------------------------------
  // DP local costs can never justify a river gorge over a calm valley floor;
  // seed it deliberately (the task: cross at a chosen ravine/bridge span).
  const wantWater =
    (identity.hydrology === "river" || identity.hydrology === "seasonal-stream") && params.water >= 0.2;
  const wantRavine = params.drama >= 0.45 && (allowed.has("ravine-crossing") || allowed.has("river-crossing"));
  if (wantWater || wantRavine) {
    // best site: the longest calm (straightish) stretch away from start;
    // fall back to the calmest 90 m window anywhere off the start zone
    let bestI = -1;
    let bestRun = 0;
    let run = 0;
    for (let i = 0; i < n; i++) {
      const calm = Math.abs(samples[i].kappa) < 0.0016 && !isStart[i];
      run = calm ? run + 1 : 0;
      if (run > bestRun) {
        bestRun = run;
        bestI = i;
      }
    }
    if (bestI < 0 || bestRun * ds <= 120) {
      // calmest sliding window (~90 m)
      const W = Math.max(10, Math.round(90 / ds));
      let bestScore = Infinity;
      for (let i = 0; i < n; i++) {
        if (isStart[i]) continue;
        let acc = 0;
        for (let k = 0; k < W; k++) acc += Math.abs(samples[(i + k) % n].kappa);
        if (acc < bestScore) {
          bestScore = acc;
          bestI = i + Math.floor(W / 2);
        }
      }
      bestRun = Math.round(120 / ds);
    }
    if (bestI > 0 && bestRun * ds > 90) {
      const kind: RoleKind = wantWater ? "river-crossing" : "ravine-crossing";
      const halfLen = (wantWater ? 45 : 38) / ds;
      const c0 = bestI - Math.floor(halfLen);
      const c1 = bestI + Math.floor(halfLen);
      // normalize the window into [0, length)
      const wStart = ((c0 * ds) % length + length) % length;
      const wEnd = ((c1 * ds) % length + length) % length;
      const wLen = wEnd - wStart;
      if (wLen > 20 && wLen < length / 4) {
        // rebuild: every span overlapping the window gets trimmed/split
        const next: RoleSpan[] = [];
        const norm = (a: number, b: number): [number, number] => (b > a ? [a, b] : [a, b + length]);
        for (const sp of spans) {
          const [a, b] = norm(sp.sStart, sp.sEnd);
          const [wa, wb] = norm(wStart, wEnd);
          if (wb <= a || wa >= b) {
            next.push(sp);
            continue;
          }
          const pre = { ...sp, sEnd: ((wa % length) + length) % length };
            const post = { ...sp, sStart: ((wb % length) + length) % length };
          if (wa - a > 24) next.push(pre);
          next.push({
            kind,
            sStart: ((Math.max(a, wa) % length) + length) % length,
            sEnd: ((Math.min(b, wb) % length) + length) % length,
            side: 0,
            intensity: 0.75 + rng.next() * 0.25,
          });
          if (b - wb > 24) next.push(post);
        }
        spans.length = 0;
        spans.push(...next);
      }
    }
  }

  // assign sides for bench/cliff roles from curvature + rng
  for (const sp of spans) {
    if (sp.kind === "hillside-bench" || sp.kind === "cliff-edge") {
      const iMid = Math.round(((sp.sStart + spanLength(sp, length) / 2) % length) / ds) % n;
      // inside of the corner is the uphill side for benches
      sp.side = samples[iMid].kappa >= 0 ? 1 : -1;
      if (rng.next() < 0.25) sp.side = (sp.side * -1) as -1 | 1;
    }
  }

  return spans;
}

export function spanLength(sp: RoleSpan, trackLength: number): number {
  const d = sp.sEnd - sp.sStart;
  return d > 0 ? d : d + trackLength;
}

/** Role at arc position s (wrap-aware). */
export function roleAt(spans: RoleSpan[], s: number, trackLength: number): RoleSpan {
  const sm = ((s % trackLength) + trackLength) % trackLength;
  for (const sp of spans) {
    const a = sp.sStart;
    const b = sp.sEnd;
    if (a <= b) {
      if (sm >= a && sm < b) return sp;
    } else if (sm >= a || sm < b) return sp;
  }
  return spans[0];
}
