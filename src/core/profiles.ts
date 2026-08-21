/**
 * Property-profile computation: turns identity + features into per-sample
 * physical properties, applying coherent localized feature effects to
 * geometry (z, banking, widths) and infrastructure (surface, kerbs,
 * runoff, barriers).
 */

import { Rng, saltSeed } from "./prng";
import { gradeLimit } from "./vertical";
import { smoothCircular } from "./geometry";
import {
  generateFeatures,
  generateZones,
  elementRangesFor,
  rollIdentity,
  KerbKind,
  RunoffKind,
  SurfaceKind,
  type CircuitIdentity,
  type CircuitZone,
  type TrackFeature,
} from "./character";
import type { AlignmentElement, Corner, PropertyProfiles, TrackParams } from "./types";

export interface CharacterInput {
  seed: number;
  params: TrackParams;
  /** The elements as actually built (post-morph, post-preclose). */
  elements: AlignmentElement[];
  corners: Corner[];
  n: number;
  ds: number;
  length: number;
  /** Designed vertical profile (mutated by geometry features). */
  z: Float64Array;
  /** Ground elevation per sample (NaN in blank mode). */
  groundZ: Float64Array;
  /** Curvature per sample. */
  kappa: Float64Array;
}

export interface CharacterResult {
  identity: CircuitIdentity;
  features: TrackFeature[];
  zones: CircuitZone[];
  props: PropertyProfiles;
  /** z after geometry features (crests/jumps/compressions). */
  z: Float64Array;
  /** Full banking profile including features (e.g. karussell steep). */
  bank: Float64Array;
}

// ---------------------------------------------------------------------------

export function designCharacter(input: CharacterInput): CharacterResult {
  const { params, seed, n, ds } = input;
  const identity = rollIdentity(params, seed);
  const L = input.length;

  // ---- base banking from curvature (moved here from build.ts) --------------
  const bank = computeBaseBanking(input.kappa, input.corners, ds, params, seed);

  // ---- base profiles ---------------------------------------------------------
  const props = baseProfiles(input, identity, bank);

  // ---- sector-scale zones (kilometer axis) -------------------------------------
  const ranges0 = elementRangesFor(input.elements, L);
  const relief0 = ranges0.map((r) => {
    const i0 = Math.floor(r.s0 / ds) % n;
    const i1 = Math.floor(r.s1 / ds) % n;
    const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
    let mn = Infinity;
    let mx = -Infinity;
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      const v = ref[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      i = (i + 1) % n;
    }
    return Number.isFinite(mn) ? mx - mn : 0;
  });
  const zones = generateZones(seed, identity, ranges0, relief0, L);
  applyZoneBiases(props, zones, input, ds, n);

  // ---- features --------------------------------------------------------------
  const ranges = elementRangesFor(input.elements, L);
  const reliefPerElement = ranges.map((r) => {
    const i0 = Math.floor(r.s0 / ds) % n;
    const i1 = Math.floor(r.s1 / ds) % n;
    const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
    let mn = Infinity;
    let mx = -Infinity;
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      const v = ref[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      i = (i + 1) % n;
    }
    return Number.isFinite(mn) ? mx - mn : 0;
  });

  const slopePerElement = ranges.map((r) => {
    const i0 = Math.floor(r.s0 / ds) % n;
    const i1 = Math.floor(r.s1 / ds) % n;
    const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
    return (ref[i1] - ref[i0]) / Math.max(20, r.s1 - r.s0);
  });
  const features = generateFeatures({
    seed,
    params,
    identity,
    elements: input.elements,
    corners: input.corners,
    elementRanges: ranges,
    totalLength: L,
    reliefPerElement,
    slopePerElement,
  });

  // map features to s ranges (also stored on the feature for UI/export)
  const franges = features.map((f) => {
    const r = ranges[f.elementIdx];
    const s0 = r.s0 + f.spanStart * (r.s1 - r.s0);
    const s1 = r.s0 + f.spanEnd * (r.s1 - r.s0);
    const L2 = n * ds;
    f.sStart = ((s0 % L2) + L2) % L2;
    f.sEnd = ((s1 % L2) + L2) % L2;
    return { f, s0, s1 };
  });

  // ---- geometry phase ----------------------------------------------------------
  const z = Float64Array.from(input.z);
  const widthL = Float32Array.from(props.widthL);
  const widthR = Float32Array.from(props.widthR);

  for (const { f, s0, s1 } of franges) {
    switch (f.kind) {
      case "karussell": {
        // steep bowl banking matching the corner direction + a dip in
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        const target = dir * (0.24 + 0.12 * f.strength); // ~14..21 deg
        windowLerp(bank, s0, s1, ds, n, target, 30);
        // dips into the bowl
        windowAdd(z, s0, s1, ds, n, -1.6 * f.strength, 20);
        const narrow = 1 - 0.1 * f.strength;
        windowScale(widthL, s0, s1, ds, n, narrow, 25);
        windowScale(widthR, s0, s1, ds, n, narrow, 25);
        break;
      }
      case "blind-crest":
      case "jump-crest": {
        // place at the local vertical maximum inside the range
        const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
        const cIdx = extremumInRange(ref, s0, s1, ds, n, "max");
        const amp = (f.kind === "jump-crest" ? 1.6 : 3.2) * f.strength;
        const widthM = f.kind === "jump-crest" ? 18 + 10 * f.strength : 45 + 40 * f.strength;
        gaussianAdd(z, cIdx, ds, n, amp, widthM);
        break;
      }
      case "compression": {
        const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
        const cIdx = extremumInRange(ref, s0, s1, ds, n, "min");
        gaussianAdd(z, cIdx, ds, n, -2.4 * f.strength, 35 + 30 * f.strength);
        break;
      }
      case "legacy-narrow": {
        const sc = 1 - 0.24 * f.strength;
        windowScale(widthL, s0, s1, ds, n, sc, 35);
        windowScale(widthR, s0, s1, ds, n, sc, 35);
        break;
      }
      case "wide-braking": {
        // widen toward the outside of the following corner
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        const widen = 1 + 0.28 * f.strength;
        if (dir > 0) windowScale(widthR, s0, s1, ds, n, widen, 30);
        else windowScale(widthL, s0, s1, ds, n, widen, 30);
        windowScale(dir > 0 ? widthL : widthR, s0, s1, ds, n, 1 + 0.08 * f.strength, 30);
        break;
      }
      case "wall-run":
      case "retaining-run": {
        const sc = 1 - 0.08 * f.strength;
        windowScale(widthL, s0, s1, ds, n, sc, 20);
        windowScale(widthR, s0, s1, ds, n, sc, 20);
        break;
      }
      case "off-camber": {
        // banking flips AWAY from the turn direction
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        windowLerp(bank, s0, s1, ds, n, -dir * (0.025 + 0.045 * f.strength), 35);
        break;
      }
      case "camber-plus": {
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        windowLerp(bank, s0, s1, ds, n, dir * (0.05 + 0.05 * f.strength), 30);
        break;
      }
      case "banked-curve": {
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        windowLerp(bank, s0, s1, ds, n, dir * (0.12 + 0.08 * f.strength), 28);
        break;
      }
      case "major-compression": {
        const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
        const cIdx = extremumInRange(ref, s0, s1, ds, n, "min");
        gaussianAdd(z, cIdx, ds, n, -4.5 * f.strength, 55 + 45 * f.strength);
        break;
      }
      case "crest-corner": {
        // bump exactly at the corner apex
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        gaussianAdd(z, midIdx, ds, n, 2.6 * f.strength, 30 + 25 * f.strength);
        break;
      }
      case "compression-corner": {
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        gaussianAdd(z, midIdx, ds, n, -2.8 * f.strength, 32 + 26 * f.strength);
        break;
      }
      case "drainage-dip": {
        const ref = Number.isFinite(input.groundZ[0]) ? input.groundZ : input.z;
        const cIdx = extremumInRange(ref, s0, s1, ds, n, "min");
        gaussianAdd(z, cIdx, ds, n, -0.9 * f.strength, 16 + 10 * f.strength);
        break;
      }
      case "passing-area": {
        const widen = 1 + 0.22 * f.strength;
        windowScale(widthL, s0, s1, ds, n, widen, 40);
        windowScale(widthR, s0, s1, ds, n, widen, 40);
        break;
      }
      case "downhill-braking":
      case "uphill-braking": {
        const midIdx = apexIndexInRange(f, s0, s1, input.kappa, ds, n);
        const dir = Math.sign(input.kappa[midIdx]) || 1;
        const widen = 1 + 0.18 * f.strength;
        if (dir > 0) windowScale(widthR, s0, s1, ds, n, widen, 35);
        else windowScale(widthL, s0, s1, ds, n, widen, 35);
        break;
      }
      default:
        break;
    }
  }

  // keep grades legal after feature geometry
  const zFinal = gradeLimit(z, ds, params.maxGrade);
  const bankFinal = smoothCircular(bank, Math.max(1, 18 / ds));

  // ---- surface/infrastructure phase --------------------------------------------
  for (const { f, s0, s1 } of franges) {
    applyFeatureProps(props, f, s0, s1, ds, n, input);
  }

  // featureIdx map (active feature per sample; last one wins overlaps)
  franges.forEach(({ s0, s1 }, fi) => {
    const i0 = modFloor(s0, ds, n);
    const i1 = modFloor(s1, ds, n);
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      props.featureIdx[i] = fi;
      i = (i + 1) % n;
    }
  });

  // width floor
  for (let i = 0; i < n; i++) {
    if (props.widthL[i] < 3.5) props.widthL[i] = 3.5;
    if (props.widthR[i] < 3.5) props.widthR[i] = 3.5;
  }

  props.widthL = widthL;
  props.widthR = widthR;

  return { identity, features, zones, props, z: zFinal, bank: bankFinal };
}

// ---------------------------------------------------------------------------
// base profiles
// ---------------------------------------------------------------------------

function computeBaseBanking(
  kappa: Float64Array,
  corners: Corner[],
  ds: number,
  params: TrackParams,
  seed: number,
): Float64Array {
  const n = kappa.length;
  const maxBank = (params.banking * 12 * Math.PI) / 180;
  const bank = new Float64Array(n);
  for (let i = 0; i < n; i++) bank[i] = maxBank * Math.tanh(kappa[i] * 140);
  if (params.offCamber > 0.01 && corners.length > 0) {
    const rng = Rng.fromSalt(seed, 7303);
    for (const c of corners) {
      if (!rng.bool(params.offCamber * 0.7)) continue;
      const widthM = 90;
      const range = Math.ceil(widthM / ds);
      const i0 = Math.round(c.sApex / ds);
      const flip = 1 + params.offCamber * 1.6;
      for (let d = -range; d <= range; d++) {
        const i = (((i0 + d) % n) + n) % n;
        const w = Math.exp(-((d * ds) ** 2) / (2 * (widthM / 2) ** 2));
        bank[i] = bank[i] * (1 - w) + -Math.abs(bank[i]) * w * flip;
      }
    }
  }
  return smoothCircular(bank, Math.max(1, 20 / ds));
}

function baseProfiles(input: CharacterInput, identity: CircuitIdentity, bank: Float64Array): PropertyProfiles {
  const { params, n, seed } = input;
  const rng = new Rng(saltSeed(seed, 60411));

  const widthL = new Float32Array(n);
  const widthR = new Float32Array(n);
  const surface = new Uint8Array(n);
  const roughness = new Float32Array(n);
  const grip = new Float32Array(n);
  const crossfall = new Float32Array(n);
  const kerbL = new Uint8Array(n);
  const kerbR = new Uint8Array(n);
  const runoffL = new Uint8Array(n);
  const runoffR = new Uint8Array(n);
  const runoffWidthL = new Float32Array(n);
  const runoffWidthR = new Float32Array(n);
  const barrierDistL = new Float32Array(n);
  const barrierDistR = new Float32Array(n);
  const featureIdx = new Int16Array(n).fill(-1);

  // --- width: slow noise + corner response + asymmetry -------------------------
  const wNoise = new Float64Array(n);
  const k1 = rng.range(1.5, 2.5);
  const k2 = rng.range(3.5, 5.5);
  const p1 = rng.range(0, Math.PI * 2);
  const p2 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    wNoise[i] = Math.sin(k1 * t + p1) * 0.6 + Math.sin(k2 * t + p2) * 0.4;
  }
  const wVar = identity.widthVariation;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(input.kappa[i]);
    const half = params.width / 2;
    // slight widen into corners (entries), asymmetric toward the outside
    const cornerF = Math.min(1, k * 180);
    const widen = 1 + wVar * 0.16 * cornerF + wVar * 0.14 * wNoise[i];
    const dir = Math.sign(input.kappa[i]);
    const asym = 1 + dir * 0.035 * cornerF;
    widthL[i] = half * widen * (dir > 0 ? asym : 2 - asym);
    widthR[i] = half * widen * (dir < 0 ? asym : 2 - asym);
  }

  // --- surface / roughness / grip ------------------------------------------------
  const defaultSurface =
    identity.era === "classic"
      ? SurfaceKind.AgedAsphalt
      : identity.era === "modern"
        ? SurfaceKind.ModernAsphalt
        : SurfaceKind.AgedAsphalt; // hybrid: aged base, features add modern patches
  const rNoiseP1 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    surface[i] = defaultSurface;
    const t = (i / n) * Math.PI * 2;
    const rn = 0.5 + 0.5 * Math.sin(3 * t + rNoiseP1) + rng.spread(0.06);
    const r = Math.min(1, Math.max(0, identity.roughnessBase * (0.75 + 0.5 * rn)));
    roughness[i] = r;
    // grip inversely tied to roughness; modern surface reads grippier
    grip[i] = 1.02 - r * 0.16 - (defaultSurface === SurfaceKind.AgedAsphalt ? 0.015 : 0);
  }

  // --- crossfall: mild drainage, tips with curvature sign -------------------------
  for (let i = 0; i < n; i++) {
    crossfall[i] = 0.012 * -Math.sign(input.kappa[i]) * Math.min(1, Math.abs(input.kappa[i]) * 150);
  }

  // --- kerbs: corner apex/exit placement by style -----------------------------------
  computeKerbMasks(input, identity, kerbL, kerbR, rng);

  // --- runoff / barriers --------------------------------------------------------------
  const runoffKindDefault =
    identity.runoffStyle === "grass"
      ? RunoffKind.Grass
      : identity.runoffStyle === "gravel"
        ? RunoffKind.Gravel
        : identity.runoffStyle === "asphalt"
          ? RunoffKind.Asphalt
          : -1; // mixed: per corner
  // smooth width noise for runoff (per-sample jitter makes jagged edges)
  const roP1 = rng.range(0, Math.PI * 2);
  const roP2 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(input.kappa[i]);
    const cornerF = Math.min(1, k * 200);
    let rkL = runoffKindDefault;
    let rkR = runoffKindDefault;
    if (rkL < 0) {
      // mixed: gravel on fast exits, grass elsewhere, asphalt at slow technicals
      const fast = k * 200 < 1 && Math.abs(bank[i]) < 0.02;
      const pickL = rng.next();
      rkL = fast ? (pickL < 0.55 ? RunoffKind.Gravel : RunoffKind.Grass) : pickL < 0.2 ? RunoffKind.Asphalt : RunoffKind.Grass;
      const pickR = rng.next();
      rkR = fast ? (pickR < 0.55 ? RunoffKind.Gravel : RunoffKind.Grass) : pickR < 0.2 ? RunoffKind.Asphalt : RunoffKind.Grass;
    }
    runoffL[i] = rkL;
    runoffR[i] = rkR;
    // speed/corner-aware envelope: big outside fast corners, extended at
    // exits, small on straights; smooth low-freq variation on top
    const t = (i / n) * Math.PI * 2;
    const roNoise = 0.7 * Math.sin(2.3 * t + roP1) + 0.5 * Math.sin(4.7 * t + roP2);
    // approach speed from curvature (v ~ sqrt(mu*g*R))
    const vEst = k > 1e-5 ? Math.sqrt((1.35 * 9.81) / Math.max(1e-5, k)) : 95;
    const speedFactor = Math.min(1.6, (vEst / 55) ** 2 * 0.55);
    const rwBase = 4.5 + cornerF * (5 + 9 * speedFactor) + roNoise;
    // asymmetry: the EXIT side (outside of the corner) gets more
    const dir = Math.sign(input.kappa[i]);
    const exitBias = 1 + 0.28 * cornerF;
    runoffWidthL[i] = rwBase * (dir > 0 ? 1 : exitBias);
    runoffWidthR[i] = rwBase * (dir < 0 ? 1 : exitBias);
    // barriers (smooth variation; style sets the baseline)
    const bBase =
      identity.barrierStyle === "armco-close"
        ? 7
        : identity.barrierStyle === "modern-setback"
          ? 32
          : 16;
    const bNoise = 0.5 * Math.sin(2.9 * t + roP1) + 0.5 * Math.sin(5.3 * t + roP2);
    const bVar = identity.barrierStyle === "modern-setback" ? 14 : 6;
    barrierDistL[i] = rkL === RunoffKind.Wall ? 1.2 : Math.max(3, bBase + bNoise * bVar);
    barrierDistR[i] = rkR === RunoffKind.Wall ? 1.2 : Math.max(3, bBase + bNoise * bVar);
  }

  return {
    widthL,
    widthR,
    surface,
    roughness,
    grip,
    crossfall,
    kerbL,
    kerbR,
    runoffL,
    runoffR,
    runoffWidthL,
    runoffWidthR,
    barrierDistL,
    barrierDistR,
    featureIdx,
  };
}

/** Kerb placement from corners, styled by identity. */
function computeKerbMasks(
  input: CharacterInput,
  identity: CircuitIdentity,
  kerbL: Uint8Array,
  kerbR: Uint8Array,
  rng: Rng,
): void {
  const { n, ds } = input;
  for (const c of input.corners) {
    if (c.minRadius > 250) continue; // sweepers: no kerb contact
    const apexI = Math.round(c.sApex / ds) % n;
    const startI = Math.round(c.sStart / ds) % n;
    const endI = Math.round(c.sEnd / ds) % n;
    const runLen = ((endI - startI) % n + n) % n;
    const apexOff = ((apexI - startI) % n + n) % n;

    // style -> kind for this corner (mixed rolls per corner)
    let kind: KerbKind;
    switch (identity.kerbStyle) {
      case "flat":
        kind = KerbKind.FlatPainted;
        break;
      case "standard":
        kind = KerbKind.Standard;
        break;
      case "aggressive":
        kind = KerbKind.Aggressive;
        break;
      default: {
        const r = rng.next();
        kind = r < 0.3 ? KerbKind.FlatPainted : r < 0.75 ? KerbKind.Standard : KerbKind.Aggressive;
      }
    }
    // classic circuits sometimes have no kerb at all
    if (identity.era === "classic" && rng.bool(0.25)) kind = KerbKind.None;
    if (kind === KerbKind.None) continue;

    const inside = c.direction === "L" ? kerbL : kerbR;
    const outside = c.direction === "L" ? kerbR : kerbL;
    // inside: apex region
    const i0 = (startI + Math.max(0, apexOff - runLen * 0.4)) % n;
    const i1 = (startI + Math.min(runLen, apexOff + runLen * 0.55) + Math.round(8 / ds)) % n;
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      inside[i] = kind;
      i = (i + 1) % n;
    }
    // outside: exit
    const o0 = (startI + Math.max(0, apexOff - runLen * 0.1)) % n;
    const o1 = (endI + Math.round(14 / ds)) % n;
    i = o0;
    guard = 0;
    while (i !== o1 && guard++ < n) {
      if (outside[i] === KerbKind.None) outside[i] = kind;
      i = (i + 1) % n;
    }
  }
}

// ---------------------------------------------------------------------------
// feature application (surface/infrastructure)
// ---------------------------------------------------------------------------

function applyFeatureProps(
  props: PropertyProfiles,
  f: TrackFeature,
  s0: number,
  s1: number,
  ds: number,
  n: number,
  input: CharacterInput,
): void {
  const rng = new Rng(f.seed);
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  const each = (fn: (i: number, w: number) => void) => {
    let i = i0;
    let guard = 0;
    const total = ((i1 - i0 + n) % n) || 1;
    let k = 0;
    while (i !== i1 && guard++ < n) {
      // window: ramp 25 m at the edges
      const edge = Math.min(k * ds, (total - k) * ds);
      const w = Math.min(1, Math.max(0.15, edge / 25));
      fn(i, w);
      i = (i + 1) % n;
      k++;
    }
  };

  switch (f.kind) {
    case "karussell":
      each((i, w) => {
        props.surface[i] = SurfaceKind.Concrete;
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.3 * f.strength), w);
        props.grip[i] = lerpTo(props.grip[i], 1.0 - 0.02 * f.strength, w); // concrete + steep: reads ok
        props.kerbL[i] = KerbKind.None;
        props.kerbR[i] = KerbKind.None;
        props.runoffL[i] = RunoffKind.Grass;
        props.runoffR[i] = RunoffKind.Grass;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], 4, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], 4, w);
        props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 3.5, w);
        props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 3.5, w);
      });
      break;
    case "blind-crest":
    case "jump-crest":
      each((i, w) => {
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.12 * f.strength), w);
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - (f.kind === "jump-crest" ? 0.05 : 0.03) * f.strength, w);
      });
      break;
    case "compression":
      each((i, w) => {
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] + 0.03 * f.strength, w);
      });
      break;
    case "resurfaced":
      each((i, w) => {
        props.surface[i] = SurfaceKind.ModernAsphalt;
        props.roughness[i] = lerpTo(props.roughness[i], 0.05, w);
        props.grip[i] = lerpTo(props.grip[i], 1.05, w);
        if (props.kerbL[i] !== KerbKind.None) props.kerbL[i] = KerbKind.Standard;
        if (props.kerbR[i] !== KerbKind.None) props.kerbR[i] = KerbKind.Standard;
      });
      break;
    case "legacy-narrow":
      each((i, w) => {
        props.surface[i] = SurfaceKind.AgedAsphalt;
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.3 * f.strength), w);
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.04 * f.strength, w);
        props.kerbL[i] = KerbKind.None;
        props.kerbR[i] = KerbKind.None;
        props.runoffL[i] = RunoffKind.Grass;
        props.runoffR[i] = RunoffKind.Grass;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], props.runoffWidthL[i] * 0.55, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], props.runoffWidthR[i] * 0.55, w);
        props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 9 + f.strength * 6, w);
        props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 9 + f.strength * 6, w);
      });
      break;
    case "wall-run":
      each((i, w) => {
        props.runoffL[i] = RunoffKind.Wall;
        props.runoffR[i] = RunoffKind.Wall;
        props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 1.5 + f.strength * 2, w);
        props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 1.5 + f.strength * 2, w);
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], 2.5, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], 2.5, w);
        props.surface[i] = SurfaceKind.AgedAsphalt;
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.01, w);
      });
      break;
    case "mixed-surface": {
      // alternating patches every 60-160 m
      let s = s0;
      let toggle = rng.bool();
      while (true) {
        const segLen = rng.range(60, 160);
        const e = s + segLen;
        const si = modFloor(s, ds, n);
        const ei = modFloor(e, ds, n);
        let i = si;
        let guard = 0;
        while (i !== ei && guard++ < n) {
          if (i === i1) break;
          props.surface[i] = toggle ? SurfaceKind.ModernAsphalt : SurfaceKind.AgedAsphalt;
          props.roughness[i] = toggle ? props.roughness[i] * 0.5 : Math.min(1, props.roughness[i] + 0.18);
          i = (i + 1) % n;
        }
        if (i === i1 || ei === i1) break;
        toggle = !toggle;
        s = e;
        if (((((modFloor(s, ds, n) - i0) % n) + n) % n) > (((i1 - i0) % n) + n) % n) break;
      }
      break;
    }
    case "wide-braking":
      each((i, w) => {
        props.runoffL[i] = RunoffKind.Asphalt;
        props.runoffR[i] = RunoffKind.Asphalt;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], props.runoffWidthL[i] * 1.6, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], props.runoffWidthR[i] * 1.6, w);
      });
      break;
    case "downhill-braking":
      each((i, w) => {
        props.runoffL[i] = RunoffKind.Asphalt;
        props.runoffR[i] = RunoffKind.Asphalt;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], props.runoffWidthL[i] * 1.5, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], props.runoffWidthR[i] * 1.5, w);
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] + 0.02, w);
      });
      break;
    case "uphill-braking":
      each((i, w) => {
        props.runoffL[i] = RunoffKind.Gravel;
        props.runoffR[i] = RunoffKind.Gravel;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], props.runoffWidthL[i] * 1.3, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], props.runoffWidthR[i] * 1.3, w);
      });
      break;
    case "off-camber":
      each((i, w) => {
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.06 * f.strength, w);
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.1), w);
      });
      break;
    case "camber-plus":
    case "banked-curve":
      each((i, w) => {
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] + 0.04 * f.strength, w);
        if (f.kind === "banked-curve") {
          props.surface[i] = SurfaceKind.Concrete;
        }
      });
      break;
    case "concrete-corner":
      each((i, w) => {
        props.surface[i] = SurfaceKind.Concrete;
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.08), w);
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.01, w);
      });
      break;
    case "rough-zone":
      each((i, w) => {
        props.surface[i] = SurfaceKind.AgedAsphalt;
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, 0.55 + 0.4 * f.strength), w);
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.05 * f.strength, w);
      });
      break;
    case "patched": {
      // patched/repaired pavement: transverse repair bands every 30-70 m
      let s = s0;
      let toggle = rng.bool();
      while (true) {
        const segLen = rng.range(30, 70);
        const e = s + segLen;
        const si = modFloor(s, ds, n);
        const ei = modFloor(e, ds, n);
        let i = si;
        let guard = 0;
        while (i !== ei && guard++ < n) {
          if (i === i1) break;
          if (toggle) {
            props.surface[i] = SurfaceKind.PatchedMix;
            props.roughness[i] = Math.min(1, props.roughness[i] + 0.12);
          }
          i = (i + 1) % n;
        }
        if (i === i1 || ei === i1) break;
        toggle = !toggle;
        s = e;
        if (((((modFloor(s, ds, n) - i0) % n) + n) % n) > (((i1 - i0) % n) + n) % n) break;
      }
      break;
    }
    case "drainage-dip":
      each((i, w) => {
        // dip channel: gravel edges, slightly greasy when damp
        props.runoffL[i] = RunoffKind.Gravel;
        props.runoffR[i] = RunoffKind.Gravel;
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.015, w);
      });
      break;
    case "narrow-shoulder":
      each((i, w) => {
        if (props.runoffL[i] !== RunoffKind.Wall) props.runoffL[i] = RunoffKind.Shoulder;
        if (props.runoffR[i] !== RunoffKind.Wall) props.runoffR[i] = RunoffKind.Shoulder;
        props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], 1.6, w);
        props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], 1.6, w);
        props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 4.5, w);
        props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 4.5, w);
      });
      break;
    case "passing-area":
      each((i, w) => {
        props.runoffL[i] = RunoffKind.Asphalt;
        props.runoffR[i] = RunoffKind.Asphalt;
        props.surface[i] = SurfaceKind.ModernAsphalt;
        props.grip[i] = lerpTo(props.grip[i], 1.04, w);
      });
      break;
    case "crown-transition":
      each((i, w) => {
        // crossfall drains to the OTHER side here (road crown swap)
        props.crossfall[i] = lerpTo(props.crossfall[i], -props.crossfall[i] - 0.006 * f.strength, w);
      });
      break;
    case "sausage-kerbs":
      each((i, w) => {
        if (props.kerbL[i] !== KerbKind.None || w > 0.5) props.kerbL[i] = KerbKind.Sausage;
        if (props.kerbR[i] !== KerbKind.None || w > 0.5) props.kerbR[i] = KerbKind.Sausage;
        props.surface[i] = SurfaceKind.ModernAsphalt;
      });
      break;
    case "old-kerbs":
      each((i, w) => {
        if (props.kerbL[i] !== KerbKind.None || w > 0.5) props.kerbL[i] = KerbKind.OldLow;
        if (props.kerbR[i] !== KerbKind.None || w > 0.5) props.kerbR[i] = KerbKind.OldLow;
        props.surface[i] = SurfaceKind.AgedAsphalt;
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.15), w);
      });
      break;
    case "retaining-run": {
      // one-sided wall: pick a side deterministically
      const leftSide = rng.bool();
      each((i, w) => {
        if (leftSide) {
          props.runoffL[i] = RunoffKind.Wall;
          props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 1.8, w);
          props.runoffWidthL[i] = lerpTo(props.runoffWidthL[i], 2, w);
        } else {
          props.runoffR[i] = RunoffKind.Wall;
          props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 1.8, w);
          props.runoffWidthR[i] = lerpTo(props.runoffWidthR[i], 2, w);
        }
      });
      break;
    }
    case "crest-corner":
    case "compression-corner":
      each((i, w) => {
        props.roughness[i] = lerpTo(props.roughness[i], Math.min(1, props.roughness[i] + 0.08), w);
      });
      break;
    case "service-road":
    case "pit-lane":
      // visual/geometry handled in mesh; mild prop annotation
      each((i, w) => {
        props.grip[i] = lerpTo(props.grip[i], props.grip[i] - 0.005, w);
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// zone biases (sector scale)
// ---------------------------------------------------------------------------

function applyZoneBiases(
  props: PropertyProfiles,
  zones: CircuitZone[],
  input: CharacterInput,
  ds: number,
  n: number,
): void {
  for (const z of zones) {
    const i0 = modFloor(z.sStart, ds, n);
    const i1 = modFloor(z.sEnd, ds, n);
    const total = ((i1 - i0 + n) % n) || 1;
    let i = i0;
    let guard = 0;
    let k = 0;
    while (i !== i1 && guard++ < n) {
      // 150 m ramps at the boundaries: zones morph into each other
      const edge = Math.min(k * ds, (total - k) * ds);
      const w = Math.min(1, Math.max(0, edge / 150));
      switch (z.kind) {
        case "old":
          props.roughness[i] = Math.min(1, props.roughness[i] + 0.22 * w);
          props.widthL[i] *= 1 - 0.06 * w;
          props.widthR[i] *= 1 - 0.06 * w;
          props.surface[i] = SurfaceKind.AgedAsphalt;
          if (props.runoffL[i] !== RunoffKind.Wall) props.runoffL[i] = RunoffKind.Grass;
          if (props.runoffR[i] !== RunoffKind.Wall) props.runoffR[i] = RunoffKind.Grass;
          props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 8, w * 0.7);
          props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 8, w * 0.7);
          props.grip[i] -= 0.03 * w;
          break;
        case "modern":
          props.roughness[i] *= 1 - 0.5 * w;
          props.surface[i] = SurfaceKind.ModernAsphalt;
          props.grip[i] += 0.02 * w;
          props.runoffWidthL[i] *= 1 + 0.3 * w;
          props.runoffWidthR[i] *= 1 + 0.3 * w;
          break;
        case "mountain":
          props.widthL[i] *= 1 - 0.05 * w;
          props.widthR[i] *= 1 - 0.05 * w;
          if (props.runoffL[i] !== RunoffKind.Wall) props.runoffL[i] = RunoffKind.Grass;
          if (props.runoffR[i] !== RunoffKind.Wall) props.runoffR[i] = RunoffKind.Grass;
          props.runoffWidthL[i] *= 1 - 0.3 * w;
          props.runoffWidthR[i] *= 1 - 0.3 * w;
          props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 6, w * 0.7);
          props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 6, w * 0.7);
          break;
        case "developed":
          props.runoffWidthL[i] *= 1 - 0.45 * w;
          props.runoffWidthR[i] *= 1 - 0.45 * w;
          props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 5, w * 0.8);
          props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 5, w * 0.8);
          break;
        case "open":
          props.runoffWidthL[i] *= 1 + 0.4 * w;
          props.runoffWidthR[i] *= 1 + 0.4 * w;
          break;
        case "confined":
          props.widthL[i] *= 1 - 0.05 * w;
          props.widthR[i] *= 1 - 0.05 * w;
          props.barrierDistL[i] = lerpTo(props.barrierDistL[i], 7, w * 0.7);
          props.barrierDistR[i] = lerpTo(props.barrierDistR[i], 7, w * 0.7);
          break;
      }
      i = (i + 1) % n;
      k++;
    }
  }
  void input;
}

// ---------------------------------------------------------------------------
// windowed array helpers (circular)
// ---------------------------------------------------------------------------

function modFloor(s: number, ds: number, n: number): number {
  const L = n * ds;
  const w = ((s % L) + L) % L;
  return Math.floor(w / ds) % n;
}

/** Blend arr toward target over [s0,s1] with ramped edges. */
function windowLerp(arr: Float64Array, s0: number, s1: number, ds: number, n: number, target: number, rampM: number): void {
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  const total = ((i1 - i0 + n) % n) || 1;
  let i = i0;
  let guard = 0;
  let k = 0;
  while (i !== i1 && guard++ < n) {
    const edge = Math.min(k * ds, (total - k) * ds);
    const w = Math.min(1, Math.max(0, edge / rampM));
    arr[i] = arr[i] + (target - arr[i]) * w;
    i = (i + 1) % n;
    k++;
  }
}

function windowScale(arr: Float32Array, s0: number, s1: number, ds: number, n: number, scale: number, rampM: number): void {
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  const total = ((i1 - i0 + n) % n) || 1;
  let i = i0;
  let guard = 0;
  let k = 0;
  while (i !== i1 && guard++ < n) {
    const edge = Math.min(k * ds, (total - k) * ds);
    const w = Math.min(1, Math.max(0, edge / rampM));
    arr[i] = arr[i] * (1 + (scale - 1) * w);
    i = (i + 1) % n;
    k++;
  }
}

function windowAdd(arr: Float64Array, s0: number, s1: number, ds: number, n: number, delta: number, rampM: number): void {
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  const total = ((i1 - i0 + n) % n) || 1;
  let i = i0;
  let guard = 0;
  let k = 0;
  while (i !== i1 && guard++ < n) {
    const edge = Math.min(k * ds, (total - k) * ds);
    const w = Math.min(1, Math.max(0, edge / rampM));
    arr[i] += delta * w;
    i = (i + 1) % n;
    k++;
  }
}

/** Add a gaussian bump centered at sample cIdx (circular). */
function gaussianAdd(arr: Float64Array, cIdx: number, ds: number, n: number, amp: number, widthM: number): void {
  const range = Math.ceil((widthM * 3.5) / ds);
  for (let d = -range; d <= range; d++) {
    const i = (((cIdx + d) % n) + n) % n;
    const dist = d * ds;
    arr[i] += amp * Math.exp(-(dist * dist) / (2 * widthM * widthM));
  }
}

/** Index of the local extremum of ref within [s0,s1]. */
function extremumInRange(ref: Float64Array, s0: number, s1: number, ds: number, n: number, mode: "max" | "min"): number {
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  let best = i0;
  let bestV = mode === "max" ? -Infinity : Infinity;
  let i = i0;
  let guard = 0;
  while (i !== i1 && guard++ < n) {
    const v = ref[i];
    if (Number.isFinite(v)) {
      if (mode === "max" && v > bestV) {
        bestV = v;
        best = i;
      } else if (mode === "min" && v < bestV) {
        bestV = v;
        best = i;
      }
    }
    i = (i + 1) % n;
  }
  return best;
}

/** Apex (max |kappa|) sample index within [s0,s1]; falls back to midpoint. */
function apexIndexInRange(f: TrackFeature, s0: number, s1: number, kappa: Float64Array, ds: number, n: number): number {
  const i0 = modFloor(s0, ds, n);
  const i1 = modFloor(s1, ds, n);
  let best = i0;
  let bestK = -Infinity;
  let i = i0;
  let guard = 0;
  while (i !== i1 && guard++ < n) {
    const k = Math.abs(kappa[i]);
    if (k > bestK) {
      bestK = k;
      best = i;
    }
    i = (i + 1) % n;
  }
  void f;
  return best;
}

function lerpTo(cur: number, target: number, w: number): number {
  return cur + (target - cur) * Math.min(1, Math.max(0, w));
}
