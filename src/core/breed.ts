/**
 * Track breeding: interactive evolutionary generation.
 *
 * Combine the structural DNA of two parent tracks plus controlled
 * mutation. The user is the fitness function.
 */

import { Rng, saltSeed } from "./prng";
import { buildTrack, type BuildOptions, type BuildResult } from "./build";
import { validateTrack } from "./validate";
import type { AlignmentElement, Track, TrackParams } from "./types";

export interface BreedOptions extends BuildOptions {
  /** Number of offspring to produce. */
  count?: number;
  /** Mutation magnitude 0..1. */
  mutation?: number;
}

/**
 * Element-sequence crossover. Parents may have different corner counts:
 * walk both sequences, pick contiguous runs from alternating parents, and
 * blend shared numeric attributes with a random alpha.
 */
function crossoverElements(
  a: AlignmentElement[],
  b: AlignmentElement[],
  rng: Rng,
  mutation: number,
  params: TrackParams,
): AlignmentElement[] {
  const out: AlignmentElement[] = [];
  const maxLen = Math.max(a.length, b.length);
  let src: AlignmentElement[] = rng.bool() ? a : b;
  let other = src === a ? b : a;
  let i = 0;
  let j = 0;
  let guard = 0;
  while ((i < src.length || j < other.length) && out.length < maxLen + 6 && guard++ < 400) {
    // take a run of 1-3 elements from the current source
    const runLen = rng.int(1, 3);
    for (let r = 0; r < runLen && i < src.length; r++) {
      out.push({ ...src[i] });
      i++;
    }
    // occasionally blend the counterpart element's numbers
    if (j < other.length && rng.bool(0.5)) {
      const partner = other[j];
      const last = out[out.length - 1];
      if (last && last.type === "corner" && partner.type === "corner") {
        const alpha = rng.range(0.25, 0.75);
        last.radius = last.radius * alpha + partner.radius * (1 - alpha);
        last.angle = last.angle * alpha + partner.angle * (1 - alpha);
        last.transition = last.transition * alpha + partner.transition * (1 - alpha);
      } else if (last && last.type === "straight" && partner.type === "straight") {
        const alpha = rng.range(0.25, 0.75);
        last.length = last.length * alpha + partner.length * (1 - alpha);
      }
      j++;
    }
    const t = src;
    src = other;
    other = t;
    // advance the new source past what we "used" from it
    if (src === a) i = Math.max(i, Math.min(a.length, j));
    else j = Math.max(j, Math.min(b.length, i));
  }

  // mutation
  const minR = params.mode === "realistic" ? 15 : 9;
  for (const el of out) {
    if (el.type === "corner") {
      if (rng.bool(mutation * 0.55)) {
        el.radius = Math.max(minR, Math.min(700, el.radius * Math.exp(rng.gaussian(0, 0.22 * mutation))));
      }
      if (rng.bool(mutation * 0.45)) {
        el.angle = Math.max(0.25, Math.min(3.1, el.angle * Math.exp(rng.gaussian(0, 0.2 * mutation))));
      }
      if (rng.bool(mutation * 0.25)) {
        el.dir = el.dir === 1 ? -1 : 1;
      }
    } else if (rng.bool(mutation * 0.4)) {
      el.length = Math.max(12, el.length * Math.exp(rng.gaussian(0, 0.25 * mutation)));
    }
  }
  return out;
}

/** Renormalize turning to one winding (crossover breaks it). */
function fixWinding(elements: AlignmentElement[], targetSign: number): void {
  const corners = elements.filter((e): e is Extract<AlignmentElement, { type: "corner" }> => e.type === "corner");
  const target = targetSign * 2 * Math.PI;
  for (let pass = 0; pass < 5; pass++) {
    const sum = corners.reduce((acc, c) => acc + c.dir * c.angle, 0);
    const err = target - sum;
    if (Math.abs(err) < 0.02) break;
    const totalAngle = corners.reduce((acc, c) => acc + c.angle, 0);
    for (const c of corners) {
      c.angle = Math.max(0.22, c.angle + ((err * (c.angle / totalAngle)) / c.dir) * 0.9);
    }
  }
}

/**
 * Breed two tracks. Deterministic in (parents, seed, params).
 * Returns offspring build results (some may be invalid -- caller filters).
 */
export function breedTracks(
  parentA: Track,
  parentB: Track,
  seed: number,
  params: TrackParams,
  opts: BreedOptions = {},
): BuildResult[] {
  const count = opts.count ?? 4;
  const mutation = opts.mutation ?? 0.5;
  const results: BuildResult[] = [];

  for (let k = 0; k < count; k++) {
    const rng = new Rng(saltSeed(seed, 3000 + k * 131));
    const elements = crossoverElements(parentA.dna.elements, parentB.dna.elements, rng, mutation, params);
    // winding direction follows parent A
    const signA = Math.sign(
      parentA.dna.elements.reduce(
        (acc, e) => (e.type === "corner" ? acc + e.dir * e.angle : acc),
        0,
      ),
    ) || 1;
    fixWinding(elements, signA);

    // blend deform states
    const da = parentA.dna.deform;
    const db = parentB.dna.deform;
    const alpha = rng.range(0.3, 0.7);
    const deform = {
      compactness: da.compactness * alpha + db.compactness * (1 - alpha),
      elongation: da.elongation * alpha + db.elongation * (1 - alpha),
      elongationAxis: rng.bool() ? da.elongationAxis : db.elongationAxis,
      asymmetry: da.asymmetry * alpha + db.asymmetry * (1 - alpha),
      asymmetryNoise: rng.bool() ? da.asymmetryNoise : db.asymmetryNoise,
    };
    const dna = {
      elements,
      deform,
      base: {
        severity: params.curvatureSeverity,
        straightBias: params.longStraightBias,
        flow: params.flow,
        technicality: params.technicality,
        cornerVariety: params.cornerVariety,
      },
    };
    const result = buildTrack(seed, params, dna, opts);
    if (result.track) {
      result.track.seed = seed;
      const v = validateTrack(result.track, params);
      if (!v.valid) {
        // offspring that don't validate are returned anyway with a note;
        // the caller may retry with a different salt
        (result as BuildResult & { issues?: string[] }).issues = v.issues;
      }
    }
    results.push(result);
  }
  return results;
}
