/**
 * Circuit generator: seed + high-level params -> structural DNA -> Track.
 *
 * Strategy: compose a road-design element sequence (straights, clothoid
 * corners) sampled from character-driven distributions, normalize total
 * turning to exactly one winding, pre-close with straight-length least
 * squares, then let the build pipeline do exact closure repair.
 */

import { Rng, saltSeed } from "./prng";
import {
  elementsTotalLength,
  kappaFromElements,
  scaleStraights,
  preCloseElements,
  type CornerGeom,
  cornerLengths,
} from "./elements";
import { analyzeIntersections, integrateKappa } from "./geometry";
import { buildTrack, defaultDeform, makeDNA, type BuildOptions, type BuildResult } from "./build";
import { validateTrack } from "./validate";
import type { AlignmentElement, TrackParams } from "./types";

type CornerKind = "normal" | "hairpin" | "sweeper" | "esses" | "chicane";

interface CornerSpec extends CornerGeom {
  kind: CornerKind;
}

/** Choose a corner archetype from the character frequencies. */
function pickCornerKind(rng: Rng, params: TrackParams): CornerKind {
  const wHair = params.hairpinFreq * (0.4 + params.technicality);
  const wSweep = params.sweeperFreq * (0.5 + params.flow);
  const wEss = params.essesFreq * (0.4 + 0.6 * params.flow);
  const wChic = params.chicaneFreq * (0.3 + params.technicality);
  const wNormal = 1.0;
  const total = wHair + wSweep + wEss + wChic + wNormal;
  let r = rng.range(0, total);
  if ((r -= wHair) < 0) return "hairpin";
  if ((r -= wSweep) < 0) return "sweeper";
  if ((r -= wEss) < 0) return "esses";
  if ((r -= wChic) < 0) return "chicane";
  return "normal";
}

/** Sample a corner radius (meters) for the given archetype. */
function pickRadius(rng: Rng, params: TrackParams, kind: CornerKind): number {
  // severity & technicality shrink radii; flow opens them up
  const severity = 0.55 + params.curvatureSeverity * 1.1; // 0.55..1.65
  const tech = 1 - params.technicality * 0.35;
  const flowOpen = 1 + params.flow * 0.25;
  const variety = params.cornerVariety;
  const base = (() => {
    switch (kind) {
      case "hairpin":
        return rng.range(14, 38);
      case "chicane":
        return rng.range(22, 55);
      case "esses":
        return rng.range(55, 140);
      case "sweeper":
        return rng.range(150, 420);
      default: {
        // log-normal-ish spread around 90 m
        const g = rng.gaussian(0, 0.55 + variety * 0.5);
        return 90 * Math.exp(g);
      }
    }
  })();
  const r = (base * tech) / (severity * flowOpen);
  // margin above the validation floor: closure repair + deforms amplify
  // curvature somewhat, so design radii carry headroom.
  const minR = params.mode === "realistic" ? 20 : 12;
  return Math.max(minR, Math.min(600, r));
}

function pickAngle(rng: Rng, params: TrackParams, kind: CornerKind): number {
  const deg = Math.PI / 180;
  switch (kind) {
    case "hairpin":
      return rng.range(100, 178) * deg;
    case "chicane":
      return rng.range(25, 55) * deg;
    case "esses":
      return rng.range(30, 65) * deg;
    case "sweeper":
      return rng.range(25, 75) * deg * (1 + params.flow * 0.3);
    default: {
      // technical tracks favor bigger direction changes
      const hi = 70 + params.technicality * 60;
      return rng.range(28, hi) * deg;
    }
  }
}

function pickTransition(rng: Rng, params: TrackParams, radius: number, kind: CornerKind): number {
  const base = kind === "hairpin" ? 0.55 : kind === "chicane" ? 0.8 : 0.45;
  const t = radius * base * rng.range(0.5, 1.1) * (1 + params.flow * 0.35);
  return Math.min(t, radius * 1.4);
}

/** Expand an archetype event into one or more corner specs. */
function expandEvent(
  rng: Rng,
  params: TrackParams,
  kind: CornerKind,
  dir: 1 | -1,
): { corners: CornerSpec[]; connectors: number[] } {
  const mk = (k: CornerKind, d: 1 | -1): CornerSpec => {
    const radius = pickRadius(rng, params, k);
    return {
      kind: k,
      radius,
      angle: pickAngle(rng, params, k),
      dir: d,
      transition: pickTransition(rng, params, radius, k),
    };
  };
  if (kind === "chicane") {
    return {
      corners: [mk("chicane", dir), mk("chicane", dir === 1 ? -1 : 1)],
      connectors: [rng.range(12, 45)],
    };
  }
  if (kind === "esses") {
    const count = rng.bool(0.35) ? 3 : 2;
    const corners: CornerSpec[] = [];
    const connectors: number[] = [];
    let d = dir;
    for (let i = 0; i < count; i++) {
      corners.push(mk("esses", d));
      d = d === 1 ? -1 : 1;
      if (i < count - 1) connectors.push(rng.range(30, 110));
    }
    return { corners, connectors };
  }
  return { corners: [mk(kind, dir)], connectors: [] };
}

/**
 * Generate the structural element sequence for a seed.
 * Deterministic in (seed, params).
 *
 * Corner events are grouped into complexes (clusters of corners with short
 * connectors) separated by real straights -- the rhythm of an actual
 * circuit rather than evenly spaced bends around a blob.
 */
export function generateElements(rng: Rng, params: TrackParams): AlignmentElement[] {
  const dirPref = params.leftRightBalance; // probability a corner turns right
  const cw =
    params.direction === "cw" ? true : params.direction === "ccw" ? false : rng.bool(0.5);

  // Budget of corner elements; grouped events consume multiple slots.
  const budget = Math.max(4, Math.round(params.cornerCount));
  const events: { specs: CornerSpec[]; connectors: number[] }[] = [];
  let used = 0;
  let guard = 0;
  // anti-spiral: complexes must snake, not coil -- consecutive events
  // alternate direction with high probability (esp. when technical)
  let prevDir: 1 | -1 = 1;
  let sameDirRun = 0;
  while (used < budget && guard++ < 200) {
    const kind = pickCornerKind(rng, params);
    let wantRight = rng.bool(dirPref);
    const flipProb = 0.55 + params.technicality * 0.25 + sameDirRun * 0.18;
    if (rng.bool(flipProb)) {
      wantRight = prevDir === 1;
    }
    const dir: 1 | -1 = wantRight ? -1 : 1; // +1 = left
    if (dir === prevDir) sameDirRun++;
    else sameDirRun = 0;
    prevDir = dir;
    const ev = expandEvent(rng, params, kind, dir);
    if (used + ev.corners.length > budget + 2) continue;
    events.push({ specs: ev.corners, connectors: ev.connectors });
    used += ev.corners.length;
  }

  // --- group events into complexes ----------------------------------------
  const nComplexes = Math.max(
    2,
    Math.min(events.length, Math.round(events.length / rng.range(1.6, 2.6))),
  );
  const complexes: (typeof events)[] = Array.from({ length: nComplexes }, () => []);
  // shuffled round-robin-ish assignment with chunkiness
  let ci = rng.int(0, nComplexes - 1);
  for (const ev of events) {
    complexes[ci].push(ev);
    if (rng.bool(0.55)) ci = (ci + 1) % nComplexes;
  }
  const populated = complexes.filter((c) => c.length > 0);

  // --- normalize total turning to exactly one winding ----------------------
  const all = events.flatMap((e) => e.specs);
  const target = (cw ? -1 : 1) * 2 * Math.PI;
  for (let pass = 0; pass < 4; pass++) {
    const sum = all.reduce((acc, c) => acc + c.dir * c.angle, 0);
    const err = target - sum;
    if (Math.abs(err) < 0.02) break;
    const totalAngle = all.reduce((acc, c) => acc + c.angle, 0);
    for (const c of all) {
      // distribute correction proportional to angle, respecting direction
      const share = c.angle / totalAngle;
      c.angle = Math.max(0.25, c.angle + (err * share) / c.dir);
    }
  }
  if (cw) {
    for (const c of all) c.dir = (c.dir === 1 ? -1 : 1) as 1 | -1;
  }

  // --- assemble elements: straight, then complex, straight, complex... ----
  const cornerLen = all.reduce((acc, c) => acc + cornerLengths(c).total, 0);
  const innerConnectors = events.reduce((acc, e) => acc + e.connectors.reduce((a, b) => a + b, 0), 0);
  // inter-corner gaps inside a complex: short (rhythm), scaled by technicality
  const complexGap = () => rng.range(25, 120) * (1.25 - params.technicality * 0.7);
  const nGaps = populated.reduce((acc, c) => acc + Math.max(0, c.length - 1), 0);
  const gapLen = nGaps * 70; // estimate; exact total normalized later anyway

  const straightBudget = Math.max(
    params.targetLength * 0.3,
    params.targetLength - cornerLen - innerConnectors - gapLen,
  );

  // one straight per gap between complexes; main straight boosted
  const nStraights = populated.length;
  const weights: number[] = [];
  let wSum = 0;
  for (let i = 0; i < nStraights; i++) {
    let w = rng.range(0.3, 1) * (1 - params.technicality * 0.4);
    w *= 0.6 + params.longStraightBias * rng.range(0.5, 1.6);
    weights.push(w);
    wSum += w;
  }
  const mainIdx = weights.indexOf(Math.max(...weights));
  weights[mainIdx] *= 1.5 + params.longStraightBias;
  wSum = weights.reduce((a, b) => a + b, 0);

  const elements: AlignmentElement[] = [];
  for (let i = 0; i < populated.length; i++) {
    const straightLen = Math.max(20, (weights[i] / wSum) * straightBudget);
    elements.push({ type: "straight", length: straightLen });
    const complex = populated[i];
    for (let j = 0; j < complex.length; j++) {
      const ev = complex[j];
      for (let k = 0; k < ev.specs.length; k++) {
        const c = ev.specs[k];
        elements.push({
          type: "corner",
          radius: c.radius,
          angle: c.angle,
          dir: c.dir,
          transition: c.transition,
          kind: c.kind,
        });
        if (k < ev.connectors.length) {
          elements.push({ type: "straight", length: ev.connectors[k] });
        }
      }
      if (j < complex.length - 1) {
        elements.push({ type: "straight", length: complexGap() });
      }
    }
  }
  return elements;
}

/**
 * Full generation: elements + deform + build. Caller retries on failure
 * with a salted seed (see generateValidTrack).
 */
export function generateTrack(seed: number, params: TrackParams, opts: BuildOptions = {}): BuildResult {
  const rng = new Rng(seed);
  let elements = generateElements(rng, params);

  // normalize overall length scale toward target (build() also fine-normalizes)
  const total = elementsTotalLength(elements);
  const f = params.targetLength / Math.max(1, total);
  if (f < 0.85 || f > 1.18) {
    elements = scaleStraights(elements, f);
  }

  elements = preCloseElements(elements, 4);

  // cheap pre-check: integrate the coarse element shape and reject
  // self-intersecting layouts before the expensive full build
  {
    const profile = kappaFromElements(elements, 3);
    const curve = integrateKappa(profile.kappa, profile.ds);
    const inter = analyzeIntersections(curve.x, curve.y, profile.ds, 8);
    if (inter.intersections > 0) {
      return { track: null, closureError: Infinity, failReason: "element-self-intersection" };
    }
  }

  const deform = defaultDeform(rng, params);
  const dna = makeDNA(elements, deform, {
    severity: params.curvatureSeverity,
    straightBias: params.longStraightBias,
    flow: params.flow,
    technicality: params.technicality,
    cornerVariety: params.cornerVariety,
  });
  return buildTrack(seed, params, dna, opts);
}

export interface ValidResult extends BuildResult {
  attempts: number;
}

/**
 * Deterministic rejection sampling: retry with salted sub-seeds and
 * progressively damped deforms until a geometrically valid track appears.
 */
export function generateValidTrack(
  seed: number,
  params: TrackParams,
  opts: BuildOptions = {},
  maxAttempts = 10,
): ValidResult {
  let last: BuildResult | null = null;
  let lastIssues = 1e9;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sub = saltSeed(seed, 11 + attempt * 1013);
    const result = generateTrack(sub, params, opts);
    if (!result.track) {
      last = result;
      continue;
    }
    // keep the user-facing seed stable; DNA captures actual structure
    result.track.seed = seed;
    const v = validateTrack(result.track, params);
    if (v.valid) return { ...result, attempts: attempt + 1 };
    if (v.issues.length < lastIssues) {
      lastIssues = v.issues.length;
      last = result;
    }
  }
  // return the best-effort track (UI can show issues) rather than nothing
  return {
    ...(last ?? { track: null, closureError: Infinity, failReason: "no-valid-candidate" }),
    attempts: maxAttempts,
  };
}
