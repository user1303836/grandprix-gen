/**
 * Spatial heterogeneity model: circuit identity + per-sample property
 * profiles + localized features.
 *
 * The ribbon is NOT homogeneous. Almost every physical property of a real
 * circuit varies with distance s around the lap, and the variation is
 * coherent: latent causes (era, construction history, terrain, maintenance)
 * produce correlated local differences. A historic mountain section is
 * narrow, rough, grass-shouldered and barrier-close; a rebuilt section is
 * wide, smooth and runoff-generous.
 */

import { Rng, saltSeed } from "./prng";
import type { AlignmentElement, Corner, TrackParams } from "./types";
import { cornerLengths } from "./elements";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum SurfaceKind {
  ModernAsphalt = 0,
  AgedAsphalt = 1,
  Concrete = 2,
  PatchedMix = 3,
}

export enum KerbKind {
  None = 0,
  FlatPainted = 1,
  Standard = 2,
  Aggressive = 3, // tall orange/sawtooth
  Sausage = 4, // high yellow/red sausage kerb (modern chicanes)
  OldLow = 5, // weathered low concrete kerb
  High = 6, // unusually high kerb
}

export enum RunoffKind {
  Grass = 0,
  Gravel = 1,
  Asphalt = 2,
  Wall = 3, // barrier at the road edge
  Shoulder = 4, // narrow paved shoulder, then grass
}

export const SurfaceNames = ["asphalt (modern)", "asphalt (aged)", "concrete", "mixed patches"] as const;
export const KerbNames = ["none", "flat painted", "standard", "aggressive", "sausage", "old low", "high"] as const;
export const RunoffNames = ["grass", "gravel", "asphalt runoff", "wall", "narrow shoulder"] as const;

// ---------------------------------------------------------------------------
// Circuit identity: the latent causes
// ---------------------------------------------------------------------------

export type CircuitEra = "classic" | "modern" | "hybrid";
export type RunoffStyle = "grass" | "gravel" | "asphalt" | "mixed";
export type KerbStyle = "flat" | "standard" | "aggressive" | "mixed";
export type BarrierStyle = "armco-close" | "modern-setback" | "mixed";

export interface CircuitIdentity {
  era: CircuitEra;
  /** Baseline pavement roughness 0..1. */
  roughnessBase: number;
  /** How much width varies around the lap (0..1). */
  widthVariation: number;
  runoffStyle: RunoffStyle;
  kerbStyle: KerbStyle;
  barrierStyle: BarrierStyle;
  /** How strongly features follow terrain/vertical geometry. */
  terrainCoupling: number;
  /** 0..1 — how many distinctive places the lap develops. */
  featureDensity: number;
  /** Flavor for place naming. */
  namingFlavor: "alpine" | "coastal" | "forest" | "desert";
}

/**
 * Roll the circuit's identity from the seed, steered (not determined) by
 * params: heritage -> era/roughness/runoff; featureRichness -> density.
 */
export function rollIdentity(params: TrackParams, seed: number): CircuitIdentity {
  const rng = new Rng(saltSeed(seed, 60210));
  const heritage = params.heritage ?? 0.4;
  const richness = params.featureRichness ?? 0.6;

  const eraRoll = rng.next();
  const era: CircuitEra =
    eraRoll < 0.08 + heritage * 0.55 ? "classic" : eraRoll < 0.55 + heritage * 0.25 ? "hybrid" : "modern";

  const roughnessBase =
    era === "classic" ? rng.range(0.4, 0.72) : era === "hybrid" ? rng.range(0.22, 0.45) : rng.range(0.08, 0.22);
  const widthVariation =
    era === "classic" ? rng.range(0.18, 0.4) : era === "hybrid" ? rng.range(0.1, 0.25) : rng.range(0.03, 0.12);

  const runoffStyle: RunoffStyle =
    era === "classic"
      ? rng.bool(0.7) ? "grass" : "mixed"
      : era === "hybrid"
        ? rng.pick(["gravel", "mixed", "grass"] as const)
        : rng.pick(["asphalt", "gravel", "mixed"] as const);
  const kerbStyle: KerbStyle =
    era === "classic"
      ? rng.pick(["flat", "mixed"] as const)
      : era === "hybrid"
        ? rng.pick(["standard", "mixed"] as const)
        : rng.pick(["standard", "aggressive", "mixed"] as const);
  const barrierStyle: BarrierStyle =
    era === "classic"
      ? rng.bool(0.65) ? "armco-close" : "mixed"
      : era === "hybrid"
        ? rng.pick(["mixed", "modern-setback"] as const)
        : "modern-setback";

  const terrainCoupling = rng.range(0.45, 0.9);
  const featureDensity = Math.min(1, Math.max(0.15, richness * rng.range(0.75, 1.3)));

  const namingFlavor = rng.pick(["alpine", "coastal", "forest", "desert"] as const);

  return {
    era,
    roughnessBase,
    widthVariation,
    runoffStyle,
    kerbStyle,
    barrierStyle,
    terrainCoupling,
    featureDensity,
    namingFlavor,
  };
}

// ---------------------------------------------------------------------------
// Localized features
// ---------------------------------------------------------------------------

export type FeatureKind =
  | "karussell"
  | "blind-crest"
  | "jump-crest"
  | "compression"
  | "major-compression"
  | "resurfaced"
  | "legacy-narrow"
  | "wall-run"
  | "retaining-run"
  | "mixed-surface"
  | "wide-braking"
  | "downhill-braking"
  | "uphill-braking"
  | "off-camber"
  | "camber-plus"
  | "banked-curve"
  | "concrete-corner"
  | "rough-zone"
  | "patched"
  | "drainage-dip"
  | "narrow-shoulder"
  | "passing-area"
  | "crown-transition"
  | "crest-corner"
  | "compression-corner"
  | "sausage-kerbs"
  | "old-kerbs"
  | "service-road"
  | "pit-lane";

export const FeatureLabels: Record<FeatureKind, string> = {
  karussell: "Banked bowl",
  "blind-crest": "Blind crest",
  "jump-crest": "Jump crest",
  compression: "Compression",
  "major-compression": "Major compression",
  resurfaced: "Resurfaced zone",
  "legacy-narrow": "Legacy narrows",
  "wall-run": "Wall run",
  "retaining-run": "Retaining wall",
  "mixed-surface": "Mixed surface",
  "wide-braking": "Wide braking zone",
  "downhill-braking": "Downhill braking",
  "uphill-braking": "Uphill braking",
  "off-camber": "Off-camber corner",
  "camber-plus": "Cambered corner",
  "banked-curve": "Heavily banked",
  "concrete-corner": "Concrete corner",
  "rough-zone": "Rough pavement",
  patched: "Patched repairs",
  "drainage-dip": "Drainage dip",
  "narrow-shoulder": "Narrow shoulder",
  "passing-area": "Passing area",
  "crown-transition": "Crown transition",
  "crest-corner": "Corner over crest",
  "compression-corner": "Corner in compression",
  "sausage-kerbs": "Sausage kerbs",
  "old-kerbs": "Old low kerbs",
  "service-road": "Service road",
  "pit-lane": "Pit lane",
};

/** 2D/3D accent colors per feature kind (indicators, underlays). */
export const FeatureColors: Record<FeatureKind, string> = {
  karussell: "#e09a3c",
  "blind-crest": "#d4cf4a",
  "jump-crest": "#e0b13c",
  compression: "#4ac2d4",
  "major-compression": "#3ad4e8",
  resurfaced: "#8be08a",
  "legacy-narrow": "#c9855c",
  "wall-run": "#b98a8a",
  "retaining-run": "#a89a8a",
  "mixed-surface": "#b9a86a",
  "wide-braking": "#7ab5e0",
  "downhill-braking": "#5c9fe0",
  "uphill-braking": "#8ac2e0",
  "off-camber": "#e06a6a",
  "camber-plus": "#6ae08a",
  "banked-curve": "#e0c25c",
  "concrete-corner": "#c2c2c2",
  "rough-zone": "#a86a4a",
  patched: "#9a8a5c",
  "drainage-dip": "#5c8ac2",
  "narrow-shoulder": "#8aa86a",
  "passing-area": "#6ad4a8",
  "crown-transition": "#b48ae0",
  "crest-corner": "#d4b43c",
  "compression-corner": "#4aa8c2",
  "sausage-kerbs": "#e0d44a",
  "old-kerbs": "#b9a48a",
  "service-road": "#8a8a8a",
  "pit-lane": "#e07a4a",
};

export interface TrackFeature {
  kind: FeatureKind;
  /** Anchor: index into the DNA element list. */
  elementIdx: number;
  /** Relative span inside the element (fractions of its length). */
  spanStart: number;
  spanEnd: number;
  /** Resolved lap-s range (set at build time). */
  sStart: number;
  sEnd: number;
  /** Intensity 0..1. */
  strength: number;
  /** Deterministic sub-seed for internal variation. */
  seed: number;
  /** Generated place name. */
  name: string;
}

// ---------------------------------------------------------------------------
// Sector-scale zones (the large spatial axis: kilometers)
// ---------------------------------------------------------------------------

export type ZoneKind = "old" | "modern" | "mountain" | "developed" | "open" | "confined";

export interface CircuitZone {
  kind: ZoneKind;
  sStart: number;
  sEnd: number;
  name: string;
}

export const ZoneLabels: Record<ZoneKind, string> = {
  old: "historic section",
  modern: "rebuilt section",
  mountain: "mountain section",
  developed: "developed section",
  open: "open country",
  confined: "confined section",
};

export const ZoneTints: Record<ZoneKind, string> = {
  old: "rgba(201,133,92,0.10)",
  modern: "rgba(122,181,224,0.08)",
  mountain: "rgba(139,168,106,0.10)",
  developed: "rgba(184,154,138,0.10)",
  open: "rgba(106,212,168,0.07)",
  confined: "rgba(180,138,224,0.09)",
};

const ZONE_SUFFIX: Record<ZoneKind, string[]> = {
  old: ["Altstrecke", "Old Quarter", "Heritage Mile"],
  modern: ["Neubau", "New Works", "Retop Zone"],
  mountain: ["Bergabschnitt", "Ridge Run", "Alm"],
  developed: ["Werksgelände", "Infield", "Paddock Side"],
  open: ["Flats", "Open Country", "Felder"],
  confined: ["Kessel", "The Slot", "Engpass"],
};

/**
 * Carve the lap into 2-4 contiguous sector-scale zones whose biases
 * (applied in profiles) create kilometer-scale character: the old mountain
 * stretch vs the rebuilt stadium section. Returns [] when the lap is too
 * uniform to bother (featureRichness low).
 */
export function generateZones(
  seed: number,
  identity: CircuitIdentity,
  elementRanges: { s0: number; s1: number }[],
  reliefPerElement: number[] | undefined,
  totalLength: number,
): CircuitZone[] {
  const rng = new Rng(saltSeed(seed, 60777));
  if (rng.next() > 0.25 + identity.featureDensity * 0.75) return [];
  const nEl = elementRanges.length;
  if (nEl < 4) return [];
  const nZones = rng.int(2, Math.min(4, Math.floor(nEl / 3)));
  // zone boundaries at element indices
  const bounds = rng
    .shuffle([...Array(nEl).keys()].slice(1))
    .slice(0, nZones - 1)
    .sort((a, b) => a - b);
  const cuts = [0, ...bounds, nEl];
  const zones: CircuitZone[] = [];
  const meanRelief = reliefPerElement
    ? reliefPerElement.reduce((a, b) => a + b, 0) / reliefPerElement.length
    : 0;
  for (let k = 0; k < cuts.length - 1; k++) {
    const i0 = cuts[k];
    const i1 = cuts[k + 1];
    const s0 = elementRanges[i0].s0;
    const s1 = elementRanges[i1 - 1].s1;
    // kind: terrain relief + era steer
    let zoneRelief = 0;
    if (reliefPerElement) {
      for (let i = i0; i < i1; i++) zoneRelief += reliefPerElement[i] ?? 0;
      zoneRelief /= i1 - i0;
    }
    let kind: ZoneKind;
    const roll = rng.next();
    if (reliefPerElement && zoneRelief > meanRelief * 1.35 && meanRelief > 4 && roll < 0.75) {
      kind = "mountain";
    } else if (identity.era === "classic") {
      kind = roll < 0.55 ? "old" : roll < 0.7 ? "confined" : "open";
    } else if (identity.era === "modern") {
      kind = roll < 0.5 ? "modern" : roll < 0.7 ? "developed" : "open";
    } else {
      kind = (["old", "modern", "developed", "open", "confined"] as const)[rng.int(0, 4)];
    }
    const word = rng.pick(PLACE_WORDS[identity.namingFlavor]);
    const suffix = rng.pick(ZONE_SUFFIX[kind]);
    zones.push({ kind, sStart: s0, sEnd: s1, name: rng.bool(0.5) ? `${word} ${suffix}` : suffix });
  }
  return zones;
}

// naming ---------------------------------------------------------------


const PLACE_WORDS: Record<CircuitIdentity["namingFlavor"], string[]> = {
  alpine: ["Falken", "Stein", "Adler", "Berg", "Tal", "Grat", "Wand", "Kamm", "Joch", "Fels"],
  coastal: ["Möwen", "Kliff", "Woge", "Brandung", "Düne", "Hafen", "Kap", "Strand", "Riff", "Tide"],
  forest: ["Fuchs", "Hain", "Wald", "Moos", "Eich", "Tann", "Birken", "Reh", "Holz", "Lichtung"],
  desert: ["Mesa", "Kaktus", "Canyon", "Dürre", "Oase", "Sierra", "Sol", "Viento", "Roca", "Polvo"],
};
const PLACE_SUFFIX: Record<string, string[]> = {
  karussell: ["Karussell", "Bowl", "Wandkurve"],
  "blind-crest": ["Kuppe", "Crest", "Sprunghügel"],
  "jump-crest": ["Sprung", "Flug", "Hoppe"],
  compression: ["Senke", "Dip", "Mulde"],
  resurfaced: ["Neubau", "Fresh Top", "Retop"],
  "legacy-narrow": ["Enge", "Altstrecke", "Narrows"],
  "wall-run": ["Mauer", "Wall", "Kajüte"],
  "mixed-surface": ["Flickenteppich", "Patchwork", "Quilt"],
  "wide-braking": ["Anker", "Bremse", "Anchor"],
  "major-compression": ["Talsenke", "Kessel", "Grund"],
  "retaining-run": ["Stütze", "Hang", "Lehne"],
  "downhill-braking": ["Fall", "Descente", "Abflug"],
  "uphill-braking": ["Anstieg", "Bergauf", "Rampe"],
  "off-camber": ["Rutsche", "Slide", "Abtritt"],
  "camber-plus": ["Wölbung", "Crown", "Höcker"],
  "banked-curve": ["Steilkurve", "Banking", "Wall"],
  "concrete-corner": ["Beton", "Slab", "Platte"],
  "rough-zone": ["Washboard", "Riffel", "Brösel"],
  patched: ["Flicken", "Patches", "Reparatur"],
  "drainage-dip": ["Rinne", "Channel", "Senke"],
  "narrow-shoulder": ["Kante", "Edge", "Saum"],
  "passing-area": ["Ausweiche", "Passing", "Breite"],
  "crown-transition": ["Kamm", "Spine", "Grat"],
  "crest-corner": ["Kuppkurve", "Blind", "Gipfelkurve"],
  "compression-corner": ["Druckkurve", "Punch", "Stampf"],
  "sausage-kerbs": ["Würste", "Sausages", "Bordsteine"],
  "old-kerbs": ["Altbord", "Stones", "Klassik"],
  "service-road": ["Zufahrt", "Access", "Werkweg"],
  "pit-lane": ["Boxengasse", "Pit Lane", "Boxes"],
};

function nameFeature(rng: Rng, kind: FeatureKind, flavor: CircuitIdentity["namingFlavor"], cornerId: number | null): string {
  const word = rng.pick(PLACE_WORDS[flavor]);
  const suffix = rng.pick(PLACE_SUFFIX[kind]);
  const base = rng.bool(0.6) ? `${word}${suffix}` : suffix;
  return cornerId !== null && rng.bool(0.55) ? `${base} · T${cornerId}` : base;
}

// ---------------------------------------------------------------------------
// Feature generation
// ---------------------------------------------------------------------------

export interface FeatureGenInput {
  seed: number;
  params: TrackParams;
  identity: CircuitIdentity;
  elements: AlignmentElement[];
  corners: Corner[];
  /** s-range of each element in final lap meters. */
  elementRanges: { s0: number; s1: number }[];
  totalLength: number;
  /** vertical relief per element (terrain coupling steers crest placement) */
  reliefPerElement?: number[];
  /** net elevation change per element / its length (downhill braking etc.) */
  slopePerElement?: number[];
}

/**
 * Choose coherent localized features. Placement rules tie features to
 * suitable geometry (a karussell needs a slow, high-angle corner; a wide
 * braking zone needs a long straight into a slow corner; wall runs prefer
 * technical sequences; legacy narrows prefer classic-era corner chains).
 */
export function generateFeatures(input: FeatureGenInput): TrackFeature[] {
  const { identity, elements, corners } = input;
  const rng = new Rng(saltSeed(input.seed, 60330));
  const features: TrackFeature[] = [];
  const usedElements = new Set<number>();

  const cornerElements: { idx: number; el: Extract<AlignmentElement, { type: "corner" }> }[] = [];
  elements.forEach((el, idx) => {
    if (el.type === "corner") cornerElements.push({ idx, el });
  });
  const straightElements: { idx: number; len: number }[] = [];
  elements.forEach((el, idx) => {
    if (el.type === "straight") straightElements.push({ idx, len: el.length });
  });

  const budget = Math.max(3, Math.round(identity.featureDensity * (3 + corners.length * 0.7)));
  const take = (idx: number): boolean => {
    if (usedElements.has(idx)) return false;
    usedElements.add(idx);
    return true;
  };

  // --- karussell: the signature feature ----------------------------------
  // slow, big-angle corner, classic/hybrid era, banking cranked up
  if (identity.era !== "modern" || rng.bool(0.25)) {
    const candidates = cornerElements.filter(
      ({ idx, el }) => el.angle > 1.1 && el.radius < 65 && el.kind !== "chicane" && !usedElements.has(idx),
    );
    if (candidates.length > 0 && rng.bool(0.3 + identity.featureDensity * 0.45)) {
      const c = rng.pick(candidates);
      if (take(c.idx)) {
        features.push({
          kind: "karussell",
          elementIdx: c.idx,
          spanStart: 0,
          spanEnd: 1,
          strength: rng.range(0.7, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "karussell", identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- crests & compressions ----------------------------------------------
  // attach to straights or gentle corners; exact local max/min resolved at
  // build time against the vertical profile. High terrainCoupling prefers
  // high-relief elements (crests live on ridgelines, compressions in dips).
  const nCrests = Math.round(identity.featureDensity * rng.range(0.8, 2.4));
  const crestPool = [...straightElements, ...cornerElements.map((c) => ({ idx: c.idx, len: c.el.radius * c.el.angle }))];
  const relief = input.reliefPerElement;
  const pickCrestElement = (): { idx: number; len: number } | null => {
    if (crestPool.length === 0) return null;
    if (relief && rng.bool(identity.terrainCoupling)) {
      // weighted by relief
      const weights = crestPool.map((p) => Math.max(0.1, (relief[p.idx] ?? 0) + (p.len > 200 ? 8 : 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rng.range(0, total);
      for (let k = 0; k < crestPool.length; k++) {
        r -= weights[k];
        if (r <= 0) return crestPool[k];
      }
      return crestPool[crestPool.length - 1];
    }
    return crestPool[rng.int(0, crestPool.length - 1)];
  };
  for (let k = 0; k < nCrests; k++) {
    const pickEl = pickCrestElement();
    if (!pickEl || usedElements.has(pickEl.idx)) continue;
    if (!take(pickEl.idx)) continue;
    const kind: FeatureKind = rng.bool(0.28) ? "jump-crest" : rng.bool(0.6) ? "blind-crest" : "compression";
    features.push({
      kind,
      elementIdx: pickEl.idx,
      spanStart: rng.range(0.15, 0.5),
      spanEnd: rng.range(0.6, 0.95),
      strength: rng.range(0.5, 1),
      seed: rng.int(0, 0xffffff),
      sStart: 0,
      sEnd: 0,
      name: nameFeature(rng, kind, identity.namingFlavor, null),
    });
  }

  // --- resurfaced zone (modern practice) -----------------------------------
  if (identity.era !== "classic" && cornerElements.length > 2 && rng.bool(0.2 + identity.featureDensity * 0.5)) {
    const c = rng.pick(cornerElements.filter((x) => !usedElements.has(x.idx)));
    if (c && take(c.idx)) {
      features.push({
        kind: "resurfaced",
        elementIdx: c.idx,
        spanStart: 0,
        spanEnd: 1,
        strength: rng.range(0.6, 1),
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, "resurfaced", identity.namingFlavor, nearestCornerId(c.idx, input)),
      });
    }
  }

  // --- legacy narrows -------------------------------------------------------
  if (identity.era !== "modern") {
    const cands = cornerElements.filter((x) => !usedElements.has(x.idx));
    if (cands.length > 0 && rng.bool(0.25 + (identity.era === "classic" ? 0.4 : 0.1))) {
      const c = rng.pick(cands);
      if (take(c.idx)) {
        features.push({
          kind: "legacy-narrow",
          elementIdx: c.idx,
          spanStart: -0.3,
          spanEnd: 1.3, // spill onto the approaches
          strength: rng.range(0.6, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "legacy-narrow", identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- wall run ---------------------------------------------------------------
  if (cornerElements.length > 3 && rng.bool(identity.featureDensity * 0.55)) {
    const technical = cornerElements.filter(
      (x) => x.el.radius < 90 && !usedElements.has(x.idx),
    );
    const c = technical.length > 0 ? rng.pick(technical) : null;
    if (c && take(c.idx)) {
      features.push({
        kind: "wall-run",
        elementIdx: c.idx,
        spanStart: -0.6,
        spanEnd: 1.6,
        strength: rng.range(0.55, 1),
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, "wall-run", identity.namingFlavor, nearestCornerId(c.idx, input)),
      });
    }
  }

  // --- mixed surface ------------------------------------------------------------
  if (identity.era !== "modern" && rng.bool(0.35 + identity.featureDensity * 0.3)) {
    const cands = cornerElements.filter((x) => !usedElements.has(x.idx));
    if (cands.length > 0) {
      const c = rng.pick(cands);
      if (take(c.idx)) {
        features.push({
          kind: "mixed-surface",
          elementIdx: c.idx,
          spanStart: -0.4,
          spanEnd: 1.4,
          strength: rng.range(0.5, 0.95),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "mixed-surface", identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- wide braking zone -----------------------------------------------------
  // long straight feeding a slow corner
  {
    const longStraights = straightElements.filter((s) => s.len > 300);
    if (longStraights.length > 0 && rng.bool(0.3 + identity.featureDensity * 0.4)) {
      const st = rng.pick(longStraights);
      // corner right after the straight
      const nextIdx = (st.idx + 1) % elements.length;
      const next = elements[nextIdx];
      if (next.type === "corner" && next.radius < 120 && !usedElements.has(nextIdx)) {
        usedElements.add(nextIdx);
        features.push({
          kind: "wide-braking",
          elementIdx: nextIdx,
          spanStart: -1.2, // mostly on the approach
          spanEnd: 0.35,
          strength: rng.range(0.6, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "wide-braking", identity.namingFlavor, nearestCornerId(nextIdx, input)),
        });
      }
    }
  }

  // --- corner camber/banking treatments ------------------------------------
  {
    const treated = cornerElements.filter((x) => !usedElements.has(x.idx) && x.el.kind !== "chicane");
    const nTreat = Math.round(identity.featureDensity * rng.range(1, 3));
    for (let k = 0; k < nTreat && treated.length > 0; k++) {
      const c = treated.splice(rng.int(0, treated.length - 1), 1)[0];
      if (!take(c.idx)) continue;
      const slow = c.el.radius < 85;
      const kind: FeatureKind =
        identity.era !== "modern" && slow && rng.bool(0.35)
          ? "off-camber"
          : slow && rng.bool(0.3)
            ? "banked-curve"
            : rng.bool(0.5)
              ? "camber-plus"
              : "concrete-corner";
      features.push({
        kind,
        elementIdx: c.idx,
        spanStart: -0.15,
        spanEnd: 1.15,
        strength: rng.range(0.55, 1),
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, kind, identity.namingFlavor, nearestCornerId(c.idx, input)),
      });
    }
  }

  // --- pavement condition zones ------------------------------------------
  {
    const condPool = [...straightElements.filter((x) => !usedElements.has(x.idx)), ...cornerElements.filter((x) => !usedElements.has(x.idx)).map((c) => ({ idx: c.idx, len: c.el.radius * c.el.angle }))];
    const nCond = Math.round(identity.featureDensity * rng.range(0.5, 2.2));
    for (let k = 0; k < nCond && condPool.length > 0; k++) {
      const c = condPool.splice(rng.int(0, condPool.length - 1), 1)[0];
      if (!take(c.idx)) continue;
      const kind: FeatureKind =
        identity.era === "modern"
          ? rng.bool(0.5) ? "patched" : "rough-zone"
          : rng.pick(["rough-zone", "patched", "drainage-dip", "narrow-shoulder"] as const);
      features.push({
        kind,
        elementIdx: c.idx,
        spanStart: rng.range(0, 0.3),
        spanEnd: rng.range(0.7, 1.1),
        strength: rng.range(0.5, 1),
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, kind, identity.namingFlavor, null),
      });
    }
  }

  // --- gradient braking zones (need slope info) -----------------------------
  if (input.slopePerElement) {
    const slopes = input.slopePerElement;
    const downhill = straightElements.filter((x) => slopes[x.idx] < -0.015 && x.len > 220 && !usedElements.has(x.idx));
    const uphill = straightElements.filter((x) => slopes[x.idx] > 0.015 && x.len > 220 && !usedElements.has(x.idx));
    const tryBraking = (pool: { idx: number; len: number }[], kind: FeatureKind) => {
      if (pool.length === 0 || !rng.bool(0.5)) return;
      const st = rng.pick(pool);
      const nextIdx = (st.idx + 1) % elements.length;
      const next = elements[nextIdx];
      if (next.type !== "corner" || usedElements.has(nextIdx)) return;
      usedElements.add(nextIdx);
      features.push({
        kind,
        elementIdx: nextIdx,
        spanStart: -1.4,
        spanEnd: 0.3,
        strength: rng.range(0.6, 1),
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, kind, identity.namingFlavor, nearestCornerId(nextIdx, input)),
      });
    };
    tryBraking(downhill, "downhill-braking");
    tryBraking(uphill, "uphill-braking");
  }

  // --- composite corner+vertical features ------------------------------------
  {
    const free = cornerElements.filter((x) => !usedElements.has(x.idx));
    if (free.length > 1 && rng.bool(identity.terrainCoupling * 0.8)) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        const kind: FeatureKind = rng.bool(0.55) ? "crest-corner" : "compression-corner";
        features.push({
          kind,
          elementIdx: c.idx,
          spanStart: 0,
          spanEnd: 1,
          strength: rng.range(0.6, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, kind, identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- kerb specials ---------------------------------------------------------
  {
    const free = cornerElements.filter((x) => !usedElements.has(x.idx));
    if (free.length > 0 && rng.bool(0.4)) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        const kind: FeatureKind =
          identity.era === "modern" || (identity.era === "hybrid" && rng.bool(0.6))
            ? "sausage-kerbs"
            : "old-kerbs";
        features.push({
          kind,
          elementIdx: c.idx,
          spanStart: -0.2,
          spanEnd: 1.2,
          strength: rng.range(0.6, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, kind, identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- crown transition ------------------------------------------------------
  {
    const free = straightElements.filter((x) => x.len > 180 && !usedElements.has(x.idx));
    if (free.length > 0 && rng.bool(0.3 + identity.widthVariation * 0.5)) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        features.push({
          kind: "crown-transition",
          elementIdx: c.idx,
          spanStart: 0.2,
          spanEnd: 0.8,
          strength: rng.range(0.5, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "crown-transition", identity.namingFlavor, null),
        });
      }
    }
  }

  // --- passing area -----------------------------------------------------------
  {
    const free = straightElements.filter((x) => x.len > 260 && !usedElements.has(x.idx));
    if (free.length > 0 && rng.bool(0.35 + identity.featureDensity * 0.3)) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        features.push({
          kind: "passing-area",
          elementIdx: c.idx,
          spanStart: 0.25,
          spanEnd: 0.75,
          strength: rng.range(0.5, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "passing-area", identity.namingFlavor, null),
        });
      }
    }
  }

  // --- retaining run (one-sided wall) -------------------------------------------
  if (rng.bool(identity.featureDensity * 0.4)) {
    const free = cornerElements.filter((x) => !usedElements.has(x.idx));
    if (free.length > 0) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        features.push({
          kind: "retaining-run",
          elementIdx: c.idx,
          spanStart: -0.5,
          spanEnd: 1.5,
          strength: rng.range(0.5, 1),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "retaining-run", identity.namingFlavor, nearestCornerId(c.idx, input)),
        });
      }
    }
  }

  // --- service road crossing ------------------------------------------------------
  {
    const free = straightElements.filter((x) => x.len > 150 && !usedElements.has(x.idx));
    if (free.length > 0 && rng.bool(0.3)) {
      const c = rng.pick(free);
      if (take(c.idx)) {
        features.push({
          kind: "service-road",
          elementIdx: c.idx,
          spanStart: 0.45,
          spanEnd: 0.55,
          strength: rng.range(0.4, 0.8),
          seed: rng.int(0, 0xffffff),
          sStart: 0,
          sEnd: 0,
          name: nameFeature(rng, "service-road", identity.namingFlavor, null),
        });
      }
    }
  }

  // --- pit lane: the start/finish straight if long enough, else the longest ----
  if (rng.bool(0.8)) {
    const el0 = elements[0];
    let anchor = el0.type === "straight" && el0.length > 220 ? 0 : -1;
    if (anchor < 0) {
      // longest straight, used only when it is genuinely main-straight length
      let bestLen = 0;
      for (const st of straightElements) {
        if (st.len > bestLen) {
          bestLen = st.len;
          anchor = st.idx;
        }
      }
      if (bestLen < 320) anchor = -1;
    }
    if (anchor >= 0 && !usedElements.has(anchor)) {
      usedElements.add(anchor);
      features.push({
        kind: "pit-lane",
        elementIdx: anchor,
        spanStart: 0.08,
        spanEnd: 0.85,
        strength: 1,
        seed: rng.int(0, 0xffffff),
        sStart: 0,
        sEnd: 0,
        name: nameFeature(rng, "pit-lane", identity.namingFlavor, null),
      });
    }
  }

  // cap to budget
  if (features.length > budget) {
    const shuffled = rng.shuffle([...features]);
    return shuffled.slice(0, budget);
  }
  return features;
}

/** Element index -> corner number in driving order (for names). */
function nearestCornerId(elementIdx: number, input: FeatureGenInput): number | null {
  const r = input.elementRanges[elementIdx];
  if (!r) return null;
  const sMid = (r.s0 + r.s1) / 2;
  let best: Corner | null = null;
  let bestD = Infinity;
  for (const c of input.corners) {
    const d = Math.abs(c.sApex - sMid);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? best.id : null;
}

/** Element ranges in lap meters (scaled to final length). */
export function elementRangesFor(elements: AlignmentElement[], finalLength: number): { s0: number; s1: number }[] {
  const total = elements.reduce(
    (acc, el) => acc + (el.type === "straight" ? el.length : cornerLengths(el).total),
    0,
  );
  const scale = finalLength / Math.max(1, total);
  let s = 0;
  return elements.map((el) => {
    const len = (el.type === "straight" ? el.length : cornerLengths(el).total) * scale;
    const r = { s0: s, s1: s + len };
    s += len;
    return r;
  });
}
