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
import { designVerticalProfile, designTerrainProfile, conformToTerrain } from "./vertical";
import { designCharacter } from "./profiles";
import { Corridor } from "./corridor";
import { defaultCivilControls, planCivil, rollCivilStyle, type CivilControls, type CivilPlan, type CivilStyle, type FeasibilityMode } from "./civil";
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
  /** Plan translation (local meters) applied before terrain sampling. */
  centerOffset?: { x: number; y: number } | null;
  /** Ground elevation sampler in local metric coords (site mode). */
  terrainSampler?: ((x: number, y: number) => number) | null;
  /** Site mode: clamp the horizontal footprint to this radius (meters). */
  maxFootprintRadius?: number;
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
  let scale = params.targetLength / Math.max(1, coarse.length);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { track: null, closureError: Infinity, failReason: "bad-scale" };
  }
  if (opts.maxFootprintRadius && opts.maxFootprintRadius > 0) {
    // site mode: the footprint must stay inside the surveyed terrain
    const { cx, cy } = polygonCentroid(curve.x, curve.y);
    let maxR = 0;
    for (let i = 0; i < curve.n; i++) {
      const r = Math.hypot(curve.x[i] - cx, curve.y[i] - cy);
      if (r > maxR) maxR = r;
    }
    const fitScale = (opts.maxFootprintRadius * scale) / Math.max(1e-9, maxR * scale);
    if (fitScale < 1) scale *= fitScale;
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

  // 8b. site placement: translate the whole plan (terrain sampling follows)
  if (opts.centerOffset) {
    for (let i = 0; i < n; i++) {
      uni.x[i] += opts.centerOffset.x;
      uni.y[i] += opts.centerOffset.y;
    }
  }

  const corners = detectCorners(kappa, ds, 0);
  const sectors = makeSectors(uni.length, 0);

  // 9. vertical
  const groundZ = new Float64Array(n);
  let z: Float64Array;
  if (opts.terrainSampler) {
    for (let i = 0; i < n; i++) groundZ[i] = opts.terrainSampler(uni.x[i], uni.y[i]);
    // off-grid samples (NaN) break the vertical design -- substitute the
    // nearest finite ground reading along the lap
    if (!Number.isFinite(groundZ[0])) {
      const anyFinite = [...groundZ].some(Number.isFinite);
      if (!anyFinite) groundZ.fill(0);
    }
    let last = NaN;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(groundZ[i])) last = groundZ[i];
      else if (Number.isFinite(last)) groundZ[i] = last;
    }
    // leading NaNs get the first finite value
    let next = NaN;
    for (let i = n - 1; i >= 0; i--) {
      if (Number.isFinite(groundZ[i])) next = groundZ[i];
      else if (Number.isFinite(next)) groundZ[i] = next;
    }
    if (!Number.isFinite(groundZ[0])) groundZ.fill(0);
    const tp = designTerrainProfile(groundZ, ds, params);
    z = tp.z;
  } else {
    const apexes = corners.map((c) => ({ s: c.sApex, strength: 1 / Math.max(20, c.minRadius) }));
    z = designVerticalProfile(n, ds, params, seed, { cornerApexes: apexes });
    groundZ.fill(0);
  }

  // 10. character: identity -> features -> geometry effects -> profiles
  const character = designCharacter({
    seed,
    params,
    elements,
    corners,
    n,
    ds,
    length: uni.length,
    z,
    groundZ,
    kappa,
  });
  z = character.z;
  const bank = character.bank;
  const props = character.props;

  // 11. terrain conformance is a HARD constraint, re-checked after feature
  // geometry (crests/bowls/dips move z): the road never clips the land.
  let structures: Track["structures"] = [];
  let carveMask: Uint8Array | null = null;
  let carveInner: Float32Array | null = null;
  let civil: CivilPlan | null = null;
  if (opts.terrainSampler) {
    const tol = params.earthworkTolerance;
    const cut = Math.max(0.5, params.maxCut * (0.25 + 0.75 * tol)) + 2.5; // feature headroom
    const fill = Math.max(0.5, params.maxFill * (0.25 + 0.75 * tol));
    z = conformToTerrain(z, groundZ, ds, params.maxGrade, cut, fill);

    // offset ground for banking-into-hill (left/right of the corridor)
    const gL = new Float64Array(n);
    const gR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = heading[i];
      const nx = -Math.sin(h);
      const ny = Math.cos(h);
      const off = (props.widthL[i] + props.widthR[i]) / 2 + 9;
      gL[i] = opts.terrainSampler(uni.x[i] + nx * off, uni.y[i] + ny * off);
      gR[i] = opts.terrainSampler(uni.x[i] - nx * off, uni.y[i] - ny * off);
    }

    // conform to the hillside FIRST so the corridor sees final banking
    const coupling0 = character.identity.terrainCoupling;
    if (coupling0 > 0.05) {
      for (let i = 0; i < n; i++) {
        const off = (props.widthL[i] + props.widthR[i]) / 2 + 9;
        if (!Number.isFinite(gL[i]) || !Number.isFinite(gR[i])) continue;
        const cross = (gL[i] - gR[i]) / (2 * off); // + = ground higher left
        bank[i] += Math.max(-0.05, Math.min(0.05, cross * 0.55)) * coupling0;
      }
      const smoothed = smoothCircular(bank, Math.max(1, 14 / ds));
      bank.set(smoothed);
    }

    // ---- civil engineering: corridor + structure planner ----------------
    const shimSamples = new Array(n);
    for (let i = 0; i < n; i++) {
      shimSamples[i] = { x: uni.x[i], y: uni.y[i], z: z[i], heading: heading[i], kappa: kappa[i], bank: bank[i] };
    }
    const shim = { samples: shimSamples, props, ds, length: uni.length } as unknown as Track;
    const corridor = new Corridor(shim);
    const controls = civilControlsFromParams(params, seed);
    civil = planCivil(shim, corridor, opts.terrainSampler, controls, seed);
    structures = civilSpansToLegacy(civil.spans);
    carveMask = new Uint8Array(n).fill(1);
    carveInner = new Float32Array(n).fill(40);
    for (const sp of civil.spans) {
      const i0 = Math.round(sp.sStart / ds) % n;
      const i1 = Math.round(sp.sEnd / ds) % n;
      const spanLen = ((i1 - i0 + n) % n) || n;
      const elevated = sp.kind === "viaduct" || sp.kind === "short-bridge" || sp.kind === "platform" || sp.kind === "shelf";
      const covered = sp.kind === "tunnel" || sp.kind === "gallery";
      const pad = Math.round(20 / ds);
      for (let k = -pad; k < spanLen + pad; k++) {
        const i = (i0 + k + n) % n;
        if (elevated || covered) carveMask[i] = 0;
        else if (sp.kind === "open-cut" || sp.kind === "retaining" || sp.kind === "dual-retaining" || sp.kind === "bench") {
          carveInner[i] = Math.min(carveInner[i], Math.max(props.widthL[i], props.widthR[i]) + 7);
        }
      }
    }

  }

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
      width: props.widthL[i] + props.widthR[i],
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
    identity: character.identity,
    features: character.features,
    zones: character.zones,
    props,
    structures,
    carveMask,
    carveInner,
    civil,
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
// helpers
// ---------------------------------------------------------------------------

/** Build CivilControls from params (auto pieces are seeded). */
function civilControlsFromParams(params: TrackParams, seed: number): CivilControls {
  const rolled = rollCivilStyle(seed, params.heritage ?? 0.4);
  const style: CivilStyle = params.civilStyle && params.civilStyle !== "auto" ? (params.civilStyle as CivilStyle) : rolled.style;
  const base = defaultCivilControls(style, params.civilBudget >= 0 ? params.civilBudget : rolled.budget);
  base.feasibility = (
    params.civilFeasibility && params.civilFeasibility !== "auto"
      ? params.civilFeasibility
      : style === "megaproject"
        ? "megaproject"
        : "realistic"
  ) as FeasibilityMode;
  base.reshape = params.earthworkTolerance;
  base.viaductBias = params.viaductPref ?? 0;
  base.platformBias = params.platformPref ?? 0;
  base.tunnelBias = params.tunnelPref ?? 0;
  base.runoffStandard = params.runoffStandard >= 0 ? params.runoffStandard : 0.5;
  return base;
}

/** Legacy StructureSpan mapping for older consumers (barriers/mesh/debug). */
function civilSpansToLegacy(spans: import("./civil").CivilSpan[]): import("./structures").StructureSpan[] {
  const map: Record<string, import("./structures").StructureKind> = {
    viaduct: "bridge",
    "short-bridge": "bridge",
    tunnel: "tunnel",
    gallery: "tunnel",
    retaining: "retaining",
    "dual-retaining": "retaining",
    "open-cut": "rock-cut",
    bench: "retaining",
    platform: "bridge",
    shelf: "bridge",
    embankment: "embankment",
    terraced: "embankment",
  };
  const out: import("./structures").StructureSpan[] = [];
  for (const sp of spans) {
    const kind = map[sp.kind];
    if (!kind) continue;
    out.push({
      kind,
      sStart: sp.sStart,
      sEnd: sp.sEnd,
      minD: -sp.maxCut,
      maxD: sp.maxFill,
      side: sp.side === 0 ? "both" : sp.side > 0 ? "left" : "right",
      seed: sp.seed,
    });
  }
  return out;
}

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
