/**
 * Civil engineering: corridor-wide terrain analysis + the structure planner.
 *
 * Instead of thresholding a centerline deviation, we measure the FULL
 * cross-section (road, kerbs, runoff, platform) against the ground, and a
 * dynamic-programming planner picks coherent structure spans under a latent
 * civil identity and a construction budget. Feasibility is a real outcome:
 * in Realistic mode a bad alignment is rejected/rerouted, not viaducted.
 */

import { Rng, saltSeed } from "./prng";
import { Corridor } from "./corridor";
import type { Track } from "./types";

// ---------------------------------------------------------------------------
// Structure kinds
// ---------------------------------------------------------------------------

export type CivilKind =
  | "at-grade"
  | "open-cut"
  | "bench"
  | "embankment"
  | "terraced"
  | "retaining"
  | "dual-retaining"
  | "platform"
  | "shelf"
  | "short-bridge"
  | "viaduct"
  | "tunnel"
  | "gallery";

export const CIVIL_KINDS: CivilKind[] = [
  "at-grade",
  "open-cut",
  "bench",
  "embankment",
  "terraced",
  "retaining",
  "dual-retaining",
  "platform",
  "shelf",
  "short-bridge",
  "viaduct",
  "tunnel",
  "gallery",
];

export type CivilStyle =
  | "terrain-following"
  | "heritage"
  | "mountain-club"
  | "modern"
  | "viaduct-heavy"
  | "megaproject";

export type FeasibilityMode = "realistic" | "permissive" | "megaproject";

export interface CivilControls {
  style: CivilStyle;
  /** 0..1 budget level (low = austere, high = lavish). */
  budget: number;
  feasibility: FeasibilityMode;
  /** 0..1 reshaping allowance (0 = touch as little ground as possible). */
  reshape: number;
  /** -1..1 user nudges. */
  viaductBias: number;
  platformBias: number;
  tunnelBias: number;
  /** 0..1 runoff generosity. */
  runoffStandard: number;
}

// ---------------------------------------------------------------------------
// Corridor-wide terrain analysis
// ---------------------------------------------------------------------------

export interface StationMetrics {
  /** corridor design z minus ground z, per lateral sample offset */
  maxCut: number; // positive depth of required cut
  maxFill: number; // positive height of required fill
  /** cross-sectional |deviation| area (m^2, trapezoid across the corridor) */
  areaCut: number;
  areaFill: number;
  /** ground slope across the platform (rise/run, signed left->right) */
  crossSlope: number;
  /** deviation asymmetry: which side is uphill (+ = ground higher on left) */
  uphillSide: -1 | 0 | 1;
  platformWidth: number;
  /** ground roughness beneath the corridor (stdev of lateral samples) */
  groundVar: number;
}

export interface CivilAnalysis {
  stations: StationMetrics[];
  offGridCount: number;
  /** total earthwork estimates, m^3 */
  volumeCut: number;
  volumeFill: number;
  /** fraction of the lap above/below thresholds */
  elevatedFrac: number;
  deepCutFrac: number;
}

/** Lateral sample offsets as fractions of the corridor (queried per station). */
export function analyzeCorridor(track: Track, corridor: Corridor, ground: (x: number, y: number) => number): CivilAnalysis {
  const n = track.samples.length;
  let stations = new Array<StationMetrics>(n);
  let offGridCount = 0;
  let volumeCut = 0;
  let volumeFill = 0;
  let elevated = 0;
  let deepCut = 0;

  for (let i = 0; i < n; i++) {
    const smp = track.samples[i];
    const plat = corridor.platformHalf(i);
    const nx = -Math.sin(smp.heading);
    const ny = Math.cos(smp.heading);
    const s = i * track.ds;
    // lateral sample set across the full platform
    const offs = [-plat.l, -(plat.l * 0.66), -(plat.l * 0.33), 0, plat.r * 0.33, plat.r * 0.66, plat.r];
    const devs: number[] = [];
    const grounds: number[] = [];
    let offGrid = false;
    for (const off of offs) {
      const surf = corridor.surface(s, off);
      const g = ground(smp.x + nx * off, smp.y + ny * off);
      if (!Number.isFinite(g)) offGrid = true;
      const gz = Number.isFinite(g) ? g : surf.z;
      grounds.push(gz);
      // off-grid: unknown ground reads as a big fill so the plan flags it
      devs.push(offGrid ? 28 : surf.z - gz);
    }
    let maxCut = 0;
    let maxFill = 0;
    let areaCut = 0;
    let areaFill = 0;
    for (let k = 0; k < offs.length - 1; k++) {
      const w = offs[k + 1] - offs[k];
      const dc = Math.max(0, -devs[k]);
      const dc1 = Math.max(0, -devs[k + 1]);
      const df = Math.max(0, devs[k]);
      const df1 = Math.max(0, devs[k + 1]);
      areaCut += ((dc + dc1) / 2) * w;
      areaFill += ((df + df1) / 2) * w;
    }
    if (offGrid) offGridCount++;
    for (const d of devs) {
      if (-d > maxCut) maxCut = -d;
      if (d > maxFill) maxFill = d;
    }
    const crossSlope = (grounds[grounds.length - 1] - grounds[0]) / (plat.l + plat.r);
    const devL = devs[1];
    const devR = devs[offs.length - 2];
    const uphillSide: -1 | 0 | 1 = devL < -1 && devL < devR - 1 ? 1 : devR < -1 && devR < devL - 1 ? -1 : 0;
    let mean = 0;
    for (const g of grounds) mean += g;
    mean /= grounds.length;
    let varSum = 0;
    for (const g of grounds) varSum += (g - mean) * (g - mean);
    stations[i] = {
      maxCut,
      maxFill,
      areaCut,
      areaFill,
      crossSlope,
      uphillSide,
      platformWidth: plat.l + plat.r,
      groundVar: Math.sqrt(varSum / grounds.length),
    };
    volumeCut += areaCut * track.ds;
    volumeFill += areaFill * track.ds;
    if (maxFill > 4) elevated++;
    if (maxCut > 7) deepCut++;
  }

  // smooth station metrics along s (the planner shouldn't see flicker)
  {
    const win = Math.max(1, Math.round(6 / track.ds));
    const sm = new Array<StationMetrics>(n);
    for (let i = 0; i < n; i++) {
      let maxCut = 0;
      let maxFill = 0;
      let areaCut = 0;
      let areaFill = 0;
      let crossSlope = 0;
      let groundVar = 0;
      let platformWidth = 0;
      for (let k = -win; k <= win; k++) {
        const j = (i + k + n) % n;
        const m = stations[j];
        maxCut += m.maxCut;
        maxFill += m.maxFill;
        areaCut += m.areaCut;
        areaFill += m.areaFill;
        crossSlope += m.crossSlope;
        groundVar += m.groundVar;
        platformWidth += m.platformWidth;
      }
      const c = 2 * win + 1;
      // maxCut/maxFill respond to the LOCAL extreme, not the mean
      sm[i] = {
        maxCut: Math.max(stations[i].maxCut, (maxCut / c) * 1.15),
        maxFill: Math.max(stations[i].maxFill, (maxFill / c) * 1.15),
        areaCut: areaCut / c,
        areaFill: areaFill / c,
        crossSlope: crossSlope / c,
        uphillSide: stations[i].uphillSide,
        platformWidth: platformWidth / c,
        groundVar: groundVar / c,
      };
    }
    stations = sm;
  }

  return {
    stations,
    offGridCount,
    volumeCut,
    volumeFill,
    elevatedFrac: elevated / n,
    deepCutFrac: deepCut / n,
  };
}

// ---------------------------------------------------------------------------
// Civil identity
// ---------------------------------------------------------------------------

/** Per-style preference multipliers (< 1 = preferred, > 1 = discouraged). */
const STYLE_PREF: Record<CivilStyle, Partial<Record<CivilKind, number>>> = {
  "terrain-following": {
    "at-grade": 0.6,
    "open-cut": 0.7,
    bench: 0.8,
    embankment: 0.75,
    terraced: 1.5,
    retaining: 1.1,
    "dual-retaining": 1.4,
    platform: 2.2,
    shelf: 2.6,
    "short-bridge": 1.6,
    viaduct: 3.5,
    tunnel: 1.4,
    gallery: 1.8,
  },
  heritage: {
    "at-grade": 0.7,
    "open-cut": 0.7,
    bench: 0.85,
    embankment: 0.9,
    terraced: 1.4,
    retaining: 0.9,
    "dual-retaining": 1.2,
    platform: 2.6,
    shelf: 3,
    "short-bridge": 2.2,
    viaduct: 4.5,
    tunnel: 1.8,
    gallery: 1.5,
  },
  "mountain-club": {
    "at-grade": 0.8,
    "open-cut": 0.75,
    bench: 0.55,
    embankment: 0.9,
    terraced: 0.9,
    retaining: 0.65,
    "dual-retaining": 0.85,
    platform: 0.8,
    shelf: 1.0,
    "short-bridge": 0.9,
    viaduct: 1.8,
    tunnel: 1.1,
    gallery: 0.85,
  },
  modern: {
    "at-grade": 0.85,
    "open-cut": 0.9,
    bench: 0.85,
    embankment: 0.7,
    terraced: 0.7,
    retaining: 0.9,
    "dual-retaining": 0.9,
    platform: 1.0,
    shelf: 1.4,
    "short-bridge": 0.85,
    viaduct: 1.2,
    tunnel: 1.5,
    gallery: 1.6,
  },
  "viaduct-heavy": {
    "at-grade": 0.9,
    "open-cut": 0.9,
    bench: 1.0,
    embankment: 1.1,
    terraced: 1.2,
    retaining: 1.1,
    "dual-retaining": 1.2,
    platform: 1.1,
    shelf: 1.2,
    "short-bridge": 0.75,
    viaduct: 0.55,
    tunnel: 1.4,
    gallery: 1.6,
  },
  megaproject: {
    "at-grade": 1.0,
    "open-cut": 0.9,
    bench: 1.0,
    embankment: 1.0,
    terraced: 1.0,
    retaining: 0.9,
    "dual-retaining": 0.9,
    platform: 0.8,
    shelf: 0.9,
    "short-bridge": 0.6,
    viaduct: 0.5,
    tunnel: 0.7,
    gallery: 0.9,
  },
};

export function rollCivilStyle(seed: number, heritage: number): { style: CivilStyle; budget: number } {
  const rng = new Rng(saltSeed(seed, 66701));
  const roll = rng.next();
  let style: CivilStyle;
  if (roll < 0.16 + heritage * 0.2) style = "heritage";
  else if (roll < 0.3 + heritage * 0.25) style = "terrain-following";
  else if (roll < 0.55) style = "mountain-club";
  else if (roll < 0.72) style = "modern";
  else if (roll < 0.9) style = "viaduct-heavy";
  else style = "megaproject";
  const budget = style === "megaproject" ? rng.range(0.75, 1) : style === "heritage" || style === "terrain-following" ? rng.range(0.15, 0.5) : rng.range(0.35, 0.8);
  return { style, budget };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export interface CivilSpan {
  kind: CivilKind;
  sStart: number;
  sEnd: number;
  /** extreme stats within the span */
  maxFill: number;
  maxCut: number;
  maxHeight: number; // max structure height above ground (fill)
  side: -1 | 0 | 1; // uphill side for retaining/bench/gallery
  seed: number;
}

export interface CivilPlan {
  spans: CivilSpan[];
  /** per-station chosen state (for validation + debug) */
  stateAt: CivilKind[];
  /** total relative construction cost */
  cost: number;
  analysis: CivilAnalysis;
  feasible: boolean;
  violations: string[];
}

interface PlanContext {
  style: CivilStyle;
  controls: CivilControls;
  speeds: Float64Array | null; // estimated speed per station (m/s), if known
}

/** Local cost per meter of `kind` at station metrics m. Infinity = not allowed here. */
function localCost(kind: CivilKind, m: StationMetrics, ctx: PlanContext): number {
  const { maxCut, maxFill, crossSlope, areaCut, areaFill } = m;
  const slope = Math.abs(crossSlope);
  const reshape = ctx.controls.reshape;
  switch (kind) {
    case "at-grade":
      if (maxCut > 1.8 || maxFill > 1.6) return Infinity;
      return 1 + (areaCut + areaFill) * 0.4;
    case "open-cut":
      if (maxCut < 1.0 || maxFill > 2.5) return Infinity;
      if (maxCut > 9) return Infinity; // too deep for an open face
      return (1.6 + areaCut * 0.5) * (0.7 + reshape * 0.6);
    case "bench":
      // cut-and-fill hillside bench: needs meaningful cross-slope
      if (slope < 0.06) return Infinity;
      if (maxCut > 8 || maxFill > 6) return Infinity;
      return (2.2 + (areaCut + areaFill) * 0.35) * (0.75 + reshape * 0.5);
    case "embankment":
      if (maxFill < 0.9 || maxCut > 2.2) return Infinity;
      if (maxFill > 5) return Infinity;
      return (1.8 + areaFill * 0.3) * (0.75 + reshape * 0.5);
    case "terraced":
      if (maxFill < 3.5 || maxCut > 2.0) return Infinity;
      if (maxFill > 13) return Infinity;
      return 3.4 + areaFill * 0.32;
    case "retaining":
      if (maxCut < 1.2 || maxFill > 3) return Infinity;
      if (maxCut > 8) return Infinity;
      return 4.2 + maxCut * 0.85;
    case "dual-retaining":
      if (maxCut < 1.2 || maxFill > 3) return Infinity;
      if (maxCut > 10) return Infinity;
      return 6.2 + maxCut * 1.1;
    case "platform": {
      // broad concrete podium: fills, esp. on cross-slopes
      if (maxFill < 3 || maxCut > 4) return Infinity;
      if (maxFill > 16) return Infinity;
      return 6.0 + maxFill * 0.35 + m.platformWidth * 0.12;
    }
    case "shelf": {
      // cantilevered shelf: steep downhill side
      if (slope < 0.12) return Infinity;
      if (maxFill < 3 || maxFill > 14) return Infinity;
      return 7.5 + maxFill * 0.3;
    }
    case "short-bridge": {
      if (maxFill < 4) return Infinity;
      // a short bridge over a dip; not a skyway
      if (ctx.controls.feasibility === "realistic" && maxFill > 42) return Infinity;
      if (ctx.controls.feasibility === "permissive" && maxFill > 95) return Infinity;
      return 13 + maxFill * 0.6;
    }
    case "viaduct": {
      if (maxFill < 4) return Infinity;
      const heightFactor = 10 + maxFill * 0.7;
      // realistic feasibility caps pier height
      if (ctx.controls.feasibility === "realistic" && maxFill > 60) return Infinity;
      if (ctx.controls.feasibility === "permissive" && maxFill > 110) return Infinity;
      return heightFactor;
    }
    case "tunnel": {
      if (maxCut < 8) return Infinity;
      if (ctx.controls.feasibility === "realistic" && maxCut > 40) return Infinity;
      return 26 + maxCut * 0.5;
    }
    case "gallery": {
      // half-tunnel on a sidehill: meaningful cut + steep uphill side
      if (maxCut < 4.5 || maxCut > 14) return Infinity;
      if (m.uphillSide === 0) return Infinity;
      return 15 + maxCut * 0.4;
    }
  }
}

/** Approximate approach speed per station from curvature (sqrt(mu*g*R)). */
export function estimateSpeeds(track: Track): Float64Array {
  const n = track.samples.length;
  const out = new Float64Array(n);
  const mu = 1.35;
  const g = 9.81;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(track.samples[i].kappa);
    out[i] = k < 1e-5 ? 90 : Math.min(95, Math.sqrt((mu * g) / k));
  }
  return out;
}

/**
 * Plan civil structures over the whole lap. Dynamic programming over
 * per-station states with transition costs; the seam is settled by running
 * the DP on a doubled domain and reading the middle lap.
 */
export function planCivil(
  track: Track,
  corridor: Corridor,
  ground: (x: number, y: number) => number,
  controls: CivilControls,
  seed: number,
): CivilPlan {
  const analysis = analyzeCorridor(track, corridor, ground);
  const n = track.samples.length;
  const speeds = estimateSpeeds(track);
  const ctx: PlanContext = { style: controls.style, controls, speeds };
  const prefs = STYLE_PREF[controls.style];

  // speed/runoff feasibility: fast stations on elevated structures are
  // penalized in realistic mode (safety envelope can't be supported)
  const speedPenalty = (kind: CivilKind, i: number): number => {
    if (ctx.controls.feasibility === "megaproject") return 1;
    const elevated = kind === "viaduct" || kind === "short-bridge" || kind === "shelf" || kind === "platform";
    if (!elevated) return 1;
    const v = speeds[i];
    if (v < 42) return 1;
    const over = (v - 42) / 45;
    return 1 + over * (ctx.controls.feasibility === "realistic" ? 2.2 : 0.9);
  };

  // tunnel/viaduct fraction guards enter as per-meter surcharges in realistic mode
  const guard = (kind: CivilKind): number => {
    if (ctx.controls.feasibility === "megaproject") return 1;
    if (kind === "viaduct") return ctx.controls.feasibility === "realistic" ? 1.9 : 1.3;
    if (kind === "tunnel") return ctx.controls.feasibility === "realistic" ? 1.6 : 1.2;
    return 1;
  };

  // user nudges (small)
  const nudge = (kind: CivilKind): number => {
    if (kind === "viaduct" || kind === "short-bridge") return 1 - ctx.controls.viaductBias * 0.35;
    if (kind === "platform" || kind === "shelf" || kind === "retaining" || kind === "dual-retaining") {
      return 1 - ctx.controls.platformBias * 0.3;
    }
    if (kind === "tunnel" || kind === "gallery") return 1 - ctx.controls.tunnelBias * 0.3;
    return 1;
  };

  // budget price level: low budget raises the cost of expensive states
  const budgetPrice = (kind: CivilKind, base: number): number => {
    const luxe = Math.max(0, base - 4) / 10; // how luxurious this state is
    return 1 + luxe * (1 - ctx.controls.budget) * 0.9;
  };

  const S = CIVIL_KINDS.length;
  const local = new Float64Array(2 * n * S).fill(Infinity);
  for (let i = 0; i < 2 * n; i++) {
    const si = i % n;
    const m = analysis.stations[si];
    for (let k = 0; k < S; k++) {
      const kind = CIVIL_KINDS[k];
      const base = localCost(kind, m, ctx);
      if (!Number.isFinite(base)) continue;
      local[i * S + k] = base * (prefs[kind] ?? 1) * speedPenalty(kind, si) * guard(kind) * nudge(kind) * budgetPrice(kind, base);
    }
  }

  // transition costs: discourage oscillation; some transitions are natural
  const TRANSITION = 42;
  const same = (a: CivilKind, b: CivilKind): number => {
    if (a === b) return 0;
    const cheap: [CivilKind, CivilKind][] = [
      ["at-grade", "open-cut"],
      ["at-grade", "embankment"],
      ["at-grade", "bench"],
      ["embankment", "terraced"],
      ["short-bridge", "viaduct"],
      ["retaining", "dual-retaining"],
      ["platform", "shelf"],
      ["open-cut", "retaining"],
      ["open-cut", "gallery"],
      ["platform", "retaining"],
      ["bench", "retaining"],
    ];
    for (const [x, y] of cheap) {
      if ((a === x && b === y) || (a === y && b === x)) return 2.5;
    }
    return TRANSITION;
  };

  // DP on doubled domain
  const N2 = 2 * n;
  const dp = new Float64Array(N2 * S).fill(Infinity);
  const back = new Int8Array(N2 * S).fill(-1);
  for (let k = 0; k < S; k++) dp[k] = local[k];
  for (let i = 1; i < N2; i++) {
    for (let k = 0; k < S; k++) {
      const lc = local[i * S + k];
      if (!Number.isFinite(lc)) continue;
      let best = Infinity;
      let bestJ = -1;
      for (let j = 0; j < S; j++) {
        const prev = dp[(i - 1) * S + j];
        if (!Number.isFinite(prev)) continue;
        const c = prev + same(CIVIL_KINDS[j], CIVIL_KINDS[k]);
        if (c < best) {
          best = c;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        dp[i * S + k] = best + lc;
        back[i * S + k] = bestJ;
      }
    }
  }
  // best terminal
  let bestK = 0;
  let bestCost = Infinity;
  for (let k = 0; k < S; k++) {
    if (dp[(N2 - 1) * S + k] < bestCost) {
      bestCost = dp[(N2 - 1) * S + k];
      bestK = k;
    }
  }
  const path2 = new Int8Array(N2);
  let k = bestK;
  for (let i = N2 - 1; i >= 0; i--) {
    path2[i] = k;
    k = back[i * S + k];
    if (k < 0) k = path2[i];
  }
  // take the middle lap
  const stateIdx = new Int8Array(n);
  for (let i = 0; i < n; i++) stateIdx[i] = path2[n + i];
  const stateAt: CivilKind[] = new Array(n);
  for (let i = 0; i < n; i++) stateAt[i] = CIVIL_KINDS[stateIdx[i]];

  // min-length smoothing: absorb runs shorter than minLen into the cheaper neighbor
  const MIN_LEN: Partial<Record<CivilKind, number>> = {
    "at-grade": 40,
    "open-cut": 55,
    bench: 55,
    embankment: 55,
    terraced: 60,
    retaining: 50,
    "dual-retaining": 50,
    platform: 70,
    shelf: 60,
    "short-bridge": 50,
    viaduct: 110,
    tunnel: 90,
    gallery: 70,
  };
  // linear runs on the circular array; absorb short runs until stable
  interface Run {
    kind: CivilKind;
    i0: number;
    i1: number;
  }
  const buildRuns = (): Run[] => {
    const out: Run[] = [];
    let start = 0;
    for (let j = 1; j < n; j++) {
      if (stateAt[j] !== stateAt[0]) {
        start = j;
        break;
      }
    }
    let cur = stateAt[start];
    let runStart = start;
    for (let j = 1; j <= n; j++) {
      const ii = (start + j) % n;
      if (stateAt[ii] !== cur) {
        out.push({ kind: cur, i0: runStart, i1: (start + j) % n });
        cur = stateAt[ii];
        runStart = ii;
      }
    }
    return out;
  };
  for (let iter = 0; iter < 240; iter++) {
    const runs = buildRuns();
    const runLen = (r: Run) => ((((r.i1 - r.i0) % n) + n) % n || n) * track.ds;
    let target = -1;
    let targetMin = Infinity;
    for (let r = 0; r < runs.length; r++) {
      const lenM = runLen(runs[r]);
      const minM = MIN_LEN[runs[r].kind] ?? 24;
      if (lenM < minM && lenM < targetMin) {
        target = r;
        targetMin = lenM;
      }
    }
    if (target < 0 || runs.length <= 2) break;
    const run = runs[target];
    const prev = runs[(target - 1 + runs.length) % runs.length];
    const next = runs[(target + 1) % runs.length];
    const m0 = analysis.stations[run.i0];
    const into =
      prev.kind === next.kind
        ? prev.kind
        : localCost(prev.kind, m0, ctx) <= localCost(next.kind, m0, ctx)
          ? prev.kind
          : next.kind;
    let i = run.i0;
    let guard2 = 0;
    while (i !== run.i1 && guard2++ < n) {
      stateAt[i] = into;
      i = (i + 1) % n;
    }
  }

  // rebuild spans from stateAt
  const spans: CivilSpan[] = [];
  {
    // find a state change to anchor
    let anchor = 0;
    for (let j = 1; j < n; j++) {
      if (stateAt[j] !== stateAt[0]) {
        anchor = j;
        break;
      }
    }
    let cur = stateAt[anchor];
    let runStart = anchor;
    for (let j = 1; j <= n; j++) {
      const ii = (anchor + j) % n;
      if (stateAt[ii] !== cur || j === n) {
        // emit span [runStart, ii)
        let maxFill = 0;
        let maxCut = 0;
        let side: -1 | 0 | 1 = 0;
        let i = runStart;
        let guard3 = 0;
        while (i !== ii && guard3++ < n) {
          const m = analysis.stations[i];
          if (m.maxFill > maxFill) maxFill = m.maxFill;
          if (m.maxCut > maxCut) maxCut = m.maxCut;
          if (m.uphillSide !== 0) side = m.uphillSide;
          i = (i + 1) % n;
        }
        const s0 = runStart * track.ds;
        let s1 = ii * track.ds;
        if (s1 <= s0) s1 += n * track.ds; // linear across the seam
        // a long continuous elevated run is a viaduct, whatever the DP called it
        const kindOut = cur === "short-bridge" && s1 - s0 > 320 ? "viaduct" : cur;
        spans.push({
          kind: kindOut,
          sStart: s0,
          sEnd: s1,
          maxFill,
          maxCut,
          maxHeight: maxFill,
          side,
          seed: saltSeed(seed, spans.length * 733 + 17),
        });
        cur = stateAt[ii];
        runStart = ii;
      }
    }
  }

  // feasibility report
  const violations: string[] = [];
  let viaductLen = 0;
  let tunnelLen = 0;
  let maxPier = 0;
  for (const sp of spans) {
    const len = sp.sEnd - sp.sStart;
    if (sp.kind === "viaduct") viaductLen += len;
    if (sp.kind === "tunnel") tunnelLen += len;
    if ((sp.kind === "viaduct" || sp.kind === "short-bridge") && sp.maxHeight > maxPier) maxPier = sp.maxHeight;
  }
  const L = n * track.ds;
  if (analysis.offGridCount > n * 0.01) violations.push(`${(100 * analysis.offGridCount / n).toFixed(0)}% of the corridor leaves the surveyed terrain`);
  if (controls.feasibility === "realistic") {
    if (viaductLen / L > 0.35) violations.push(`viaduct fraction ${(100 * viaductLen / L).toFixed(0)}% > 35%`);
    if (maxPier > 60) violations.push(`max pier height ${maxPier.toFixed(0)}m > 60m`);
    if (tunnelLen / L > 0.3) violations.push(`tunnel fraction ${(100 * tunnelLen / L).toFixed(0)}% > 30%`);
    if (analysis.volumeCut + analysis.volumeFill > 900_000) {
      violations.push(`earthwork volume ${((analysis.volumeCut + analysis.volumeFill) / 1e6).toFixed(2)}Mm^3 too large`);
    }
  } else if (controls.feasibility === "permissive") {
    if (maxPier > 110) violations.push(`max pier height ${maxPier.toFixed(0)}m > 110m`);
  }

  // normalize cost per km for readability
  const cost = (bestCost / L) * 1000;

  return {
    spans,
    stateAt,
    cost,
    analysis,
    feasible: violations.length === 0,
    violations,
  };
}

/** Default controls from a rolled style (user-overridable pieces). */
export function defaultCivilControls(style: CivilStyle, budget: number): CivilControls {
  return {
    style,
    budget,
    feasibility: style === "megaproject" ? "megaproject" : "realistic",
    reshape: style === "terrain-following" || style === "heritage" ? 0.25 : style === "megaproject" ? 0.9 : 0.55,
    viaductBias: style === "viaduct-heavy" ? 0.8 : 0,
    platformBias: style === "mountain-club" ? 0.7 : 0,
    tunnelBias: 0,
    runoffStandard: 0.5,
  };
}
