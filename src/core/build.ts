/**
 * Track build pipeline:
 *
 *   elements -> kappa(s) -> closure repair -> integrate -> deform
 *     -> normalize length -> uniform resample -> heading/curvature
 *     -> start/finish, corners, sectors -> vertical -> banking -> width
 *
 * Pure functions, no rendering dependencies: fully testable in Node.
 */

import {
  integrateKappa,
  repairClosure,
  resampleClosed,
  deriveHeadingKappa,
  smoothCircular,
  polygonCentroid,
} from "./geometry";
import { kappaFromElements, totalTurning, morphElements, preCloseElements } from "./elements";
import { detectCorners, findStartFinish, makeSectors } from "./corners";
import { designVerticalProfile, designTerrainProfile } from "./vertical";
import { Rng } from "./prng";
import {
  GENERATOR_VERSION,
  type AlignmentElement,
  type DeformState,
  type Track,
  type TrackDNA,
  type TrackParams,
  type TrackSample,
  type SiteRef,
  type TerrainMeta,
  type BaseMorph,
} from "./types";

export interface BuildOptions {
  site?: SiteRef | null;
  terrain?: TerrainMeta | null;
  /** Ground elevation sampler in local metric coords (site mode). */
  terrainSampler?: ((x: number, y: number) => number) | null;
}

export interface BuildResult {
  track: Track | null;
  closureError: number;
  failReason?: string;
}

const KAPPA_DS = 0.75; // rasterization step for element integration

export function buildTrack(
  seed: number,
  params: TrackParams,
  dna: TrackDNA,
  opts: BuildOptions = {},
): BuildResult {
  // apply identity-preserving morphs to pristine elements, then pre-close
  let elements = morphElements(dna.elements, params, dna.base);
  elements = preCloseElements(elements, 3);
  if (elements.length < 3) return { track: null, closureError: Infinity, failReason: "too-few-elements" };

  // 1. curvature profile
  const profile = kappaFromElements(elements, KAPPA_DS);
  if (profile.length < 400) return { track: null, closureError: Infinity, failReason: "too-short" };

  // 2. closure repair
  const winding = Math.sign(totalTurning(profile)) || 1;
  const repaired = repairClosure(profile.kappa, profile.ds, winding, 8);
  if (!repaired) return { track: null, closureError: Infinity, failReason: "closure-diverged" };
  if (repaired.closureError > profile.length * 0.002) {
    return { track: null, closureError: repaired.closureError, failReason: "closure-error" };
  }

  // 3. integrate
  const curve = integrateKappa(repaired.kappa, profile.ds);

  // 4. deform (position space)
  applyDeform(curve.x, curve.y, dna.deform);

  // 5. normalize to target length
  const coarse = resampleClosed(curve, 1024);
  const scale = params.targetLength / Math.max(1, coarse.length);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { track: null, closureError: Infinity, failReason: "bad-scale" };
  }
  for (let i = 0; i < curve.n; i++) {
    curve.x[i] *= scale;
    curve.y[i] *= scale;
  }

  // 6. canonical uniform resample (~2 m spacing)
  const targetDs = clamp(params.targetLength / 2600, 1, 4);
  const n = Math.max(256, Math.round(params.targetLength / targetDs));
  const uni = resampleClosed(curve, n);
  const ds = uni.ds;

  // 7. heading + curvature
  const derived = deriveHeadingKappa(uni.x, uni.y, ds);
  const kappa = smoothCircular(derived.kappa, 2.0);
  // re-derive heading consistency: keep derived heading (finite diff is fine)

  // 8. start/finish at longest straight; rotate so s=0 there
  const sfS = findStartFinish(kappa, ds);
  const rot = Math.round(sfS / ds) % n;
  rotateInPlace(uni.x, rot);
  rotateInPlace(uni.y, rot);
  const heading = Float64Array.from(derived.heading);
  rotateInPlace(heading, rot);
  rotateInPlace(kappa, rot);

  const corners = detectCorners(kappa, ds, 0);
  const sectors = makeSectors(uni.length, 0);

  // 9. vertical
  let groundZ = new Float64Array(n);
  let z: Float64Array;
  if (opts.terrainSampler) {
    for (let i = 0; i < n; i++) groundZ[i] = opts.terrainSampler(uni.x[i], uni.y[i]);
    const tp = designTerrainProfile(groundZ, ds, params);
    z = tp.z;
  } else {
    const apexes = corners.map((c) => ({ s: c.sApex, strength: 1 / Math.max(20, c.minRadius) }));
    z = designVerticalProfile(n, ds, params, seed, { cornerApexes: apexes });
    groundZ.fill(0);
  }

  // 10. banking
  const bank = designBanking(kappa, corners, ds, params, seed);

  // 11. width
  const width = designWidth(kappa, corners, ds, params, seed);

  // assemble samples
  const samples: TrackSample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = {
      s: i * ds,
      x: uni.x[i],
      y: uni.y[i],
      z: z[i],
      heading: heading[i],
      kappa: kappa[i],
      bank: bank[i],
      width: width[i],
      groundZ: groundZ[i],
      speed: NaN,
    };
  }

  const track: Track = {
    version: GENERATOR_VERSION,
    seed,
    params: { ...params },
    dna,
    samples,
    length: uni.length,
    ds,
    startFinishS: 0,
    corners,
    sectors,
    site: opts.site ?? null,
    terrain: opts.terrain ?? null,
  };
  return { track, closureError: repaired.closureError };
}

// ---------------------------------------------------------------------------
// Deform
// ---------------------------------------------------------------------------

/**
 * Position-space morphs. All continuous in their parameter so dragging a
 * slider visibly morphs the existing circuit instead of regenerating it.
 */
export function applyDeform(x: Float64Array, y: Float64Array, deform: DeformState): void {
  const n = x.length;
  const { cx, cy } = polygonCentroid(x, y);

  // mean radius (for compactness reference circle)
  let meanR = 0;
  for (let i = 0; i < n; i++) meanR += Math.hypot(x[i] - cx, y[i] - cy);
  meanR /= n;
  if (meanR < 1e-6) return;

  // elongation: anisotropic scale about the deform axis (moderate strength
  // so curvature at the pinch points stays plausible)
  const e = deform.elongation;
  if (Math.abs(e) > 1e-4) {
    const sx = 1 + e * 0.7;
    const sy = 1 / (1 + e * 0.35);
    const ca = Math.cos(deform.elongationAxis);
    const sa = Math.sin(deform.elongationAxis);
    for (let i = 0; i < n; i++) {
      const dx = x[i] - cx;
      const dy = y[i] - cy;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;
      x[i] = cx + u * sx * ca - v * sy * sa;
      y[i] = cy + u * sx * sa + v * sy * ca;
    }
  }

  // asymmetry: fixed seeded radial noise, amplitude follows the slider
  const a = deform.asymmetry;
  if (Math.abs(a) > 1e-4 && deform.asymmetryNoise.amp.length > 0) {
    const K = deform.asymmetryNoise.amp.length;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - cx;
      const dy = y[i] - cy;
      const r = Math.hypot(dx, dy);
      if (r < 1e-6) continue;
      const th = Math.atan2(dy, dx);
      let noise = 0;
      for (let k = 0; k < K; k++) {
        noise += deform.asymmetryNoise.amp[k] * Math.sin((k + 1) * th + deform.asymmetryNoise.phase[k]);
      }
      const dr = a * 0.25 * meanR * noise;
      const nr = Math.max(meanR * 0.15, r + dr);
      x[i] = cx + (dx / r) * nr;
      y[i] = cy + (dy / r) * nr;
    }
  }

  // compactness: blend toward (c>0.5) or away from (c<0.5) the mean circle
  const c = deform.compactness;
  const blend = (c - 0.5) * 1.2;
  if (Math.abs(blend) > 1e-4) {
    for (let i = 0; i < n; i++) {
      const dx = x[i] - cx;
      const dy = y[i] - cy;
      const r = Math.hypot(dx, dy);
      if (r < 1e-6) continue;
      let nr = r + (meanR - r) * blend;
      nr = Math.max(meanR * 0.2, nr);
      x[i] = cx + (dx / r) * nr;
      y[i] = cy + (dy / r) * nr;
    }
  }
}

// ---------------------------------------------------------------------------
// Banking / width
// ---------------------------------------------------------------------------

function designBanking(
  kappa: Float64Array,
  corners: { sApex: number; id: number }[],
  ds: number,
  params: TrackParams,
  seed: number,
): Float64Array {
  const n = kappa.length;
  const maxBank = params.banking * (12 * Math.PI) / 180; // up to ~12 deg
  const bank = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bank[i] = maxBank * Math.tanh(kappa[i] * 140);
  }
  // off-camber: seeded corners get reversed banking
  if (params.offCamber > 0.01 && corners.length > 0) {
    const rng = Rng.fromSalt(seed, 7303);
    const L = n * ds;
    for (const c of corners) {
      if (!rng.bool(params.offCamber * 0.7)) continue;
      const widthM = 90;
      const range = Math.ceil(widthM / ds);
      const i0 = Math.round(c.sApex / ds);
      const flip = -params.offCamber * 1.6;
      for (let d = -range; d <= range; d++) {
        const i = (((i0 + d) % n) + n) % n;
        const w = Math.exp(-(d * ds * d * ds) / (2 * (widthM / 2) * (widthM / 2)));
        bank[i] = bank[i] * (1 - w) + -Math.abs(bank[i]) * Math.sign(bank[i] || 1) * w * (1 + flip);
      }
    }
    void L;
  }
  // smooth to enforce roll-rate plausibility
  return smoothCircular(bank, Math.max(1, 20 / ds));
}

function designWidth(
  kappa: Float64Array,
  corners: { sApex: number; sStart: number; sEnd: number; minRadius: number }[],
  ds: number,
  params: TrackParams,
  seed: number,
): Float64Array {
  const n = kappa.length;
  const width = new Float64Array(n);
  width.fill(params.width);
  const rng = Rng.fromSalt(seed, 7404);
  for (const c of corners) {
    // tight corners get slightly wider entries/exits
    const extra = c.minRadius < 60 ? rng.range(0.5, 2.0) : rng.range(0, 0.8);
    if (extra < 0.2) continue;
    const widthM = 70;
    const range = Math.ceil(widthM / ds);
    const i0 = Math.round(c.sApex / ds);
    for (let d = -range; d <= range; d++) {
      const i = (((i0 + d) % n) + n) % n;
      const w = Math.exp(-(d * ds * d * ds) / (2 * (widthM / 2.5) * (widthM / 2.5)));
      width[i] = Math.max(width[i], params.width + extra * w);
    }
  }
  return width;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rotateInPlace(arr: Float64Array, rot: number): void {
  const n = arr.length;
  const r = ((rot % n) + n) % n;
  if (r === 0) return;
  const copy = Float64Array.from(arr);
  for (let i = 0; i < n; i++) arr[i] = copy[(i + r) % n];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function defaultDeform(rng: Rng, params: TrackParams): DeformState {
  const K = 4;
  const amp: number[] = [];
  const phase: number[] = [];
  for (let k = 0; k < K; k++) {
    // high harmonics fall off fast so the noise can't create tight radii
    amp.push(rng.range(0.4, 1) / ((k + 1) * (k + 1)));
    phase.push(rng.range(0, Math.PI * 2));
  }
  return {
    compactness: params.compactness,
    elongation: params.elongation,
    elongationAxis: rng.range(0, Math.PI),
    asymmetry: params.asymmetry,
    asymmetryNoise: { amp, phase },
  };
}

export function makeDNA(elements: AlignmentElement[], deform: DeformState, base: BaseMorph): TrackDNA {
  return { elements, deform, base };
}
