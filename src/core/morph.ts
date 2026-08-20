/**
 * Identity-preserving morphs.
 *
 * Morphable sliders never regenerate the circuit: they transform the
 * pristine element DNA relative to the generation-time base snapshot and
 * rebuild. Dragging severity/straights/compactness visibly deforms the
 * same circuit; structural params re-synthesize from the same seed.
 */

import { Rng } from "./prng";
import { buildTrack, makeDNA, defaultDeform, type BuildOptions, type BuildResult } from "./build";
import { generateElements } from "./generator";
import type { Track, TrackDNA, TrackParams } from "./types";

/**
 * Rebuild the track with new (morphable) params, preserving identity.
 * The deform state follows the new params (continuous slider morphs).
 */
export function morphTrack(track: Track, newParams: TrackParams, opts: BuildOptions = {}): BuildResult {
  const dna: TrackDNA = {
    elements: track.dna.elements,
    deform: {
      ...track.dna.deform,
      compactness: newParams.compactness,
      elongation: newParams.elongation,
      asymmetry: newParams.asymmetry,
    },
    base: track.dna.base,
  };
  return buildTrack(track.seed, newParams, dna, opts);
}

/**
 * Structural change: re-synthesize the element DNA from the same seed with
 * new structural params. Layout changes but generation character is stable.
 */
export function regenerateStructure(
  seed: number,
  newParams: TrackParams,
  opts: BuildOptions = {},
): BuildResult {
  const rng = new Rng(seed);
  const elements = generateElements(rng, newParams);
  const deform = defaultDeform(rng, newParams);
  const dna = makeDNA(elements, deform, {
    severity: newParams.curvatureSeverity,
    straightBias: newParams.longStraightBias,
    flow: newParams.flow,
    technicality: newParams.technicality,
    cornerVariety: newParams.cornerVariety,
  });
  return buildTrack(seed, newParams, dna, opts);
}
