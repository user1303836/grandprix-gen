/**
 * Canonical track representation and parameter model.
 *
 * The rendered mesh is never the source of truth: a Track is a
 * mathematical road object queryable by distance s along the lap.
 */

export const GENERATOR_VERSION = 1;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export type GeometryMode = "experimental" | "realistic";
export type TrackDirection = "cw" | "ccw" | "random";
export type SiteMode = "blank" | "site";

/**
 * High-level design parameters. These intentionally operate above raw
 * geometry: one slider typically modulates several generator weights.
 */
export interface TrackParams {
  // --- global geometry -----------------------------------------------------
  /** Target lap length in meters. */
  targetLength: number;
  /** Structural: number of corner events (requires re-synthesis). */
  cornerCount: number;
  /** Morphable: 0 = sprawling/irregular, 1 = tight footprint. */
  compactness: number;
  /** Morphable: 0 = round, 1 = strongly elongated. */
  elongation: number;
  /** Morphable: amount of asymmetric irregularity. */
  asymmetry: number;
  /** Structural-ish: share of left vs right turning (0 = all left). */
  leftRightBalance: number;
  direction: TrackDirection;

  // --- circuit character ---------------------------------------------------
  /** Morphable: tightens/loosens corner radii (curvature multiplier). */
  curvatureSeverity: number;
  /** Morphable: bias toward longer straights. */
  longStraightBias: number;
  /** Latent: flowing vs stop/start character. */
  flow: number;
  /** Latent: corner density, short connectors, tight radii. */
  technicality: number;
  /** Latent: spread of corner radii/types. */
  cornerVariety: number;
  /** Structural: frequency of hairpins (requires re-synthesis). */
  hairpinFreq: number;
  /** Structural: long fast sweepers. */
  sweeperFreq: number;
  /** Structural: alternating S-sequences. */
  essesFreq: number;
  /** Structural: tight chicane insertions. */
  chicaneFreq: number;

  // --- elevation / cross section -------------------------------------------
  /** Morphable: vertical relief amplitude ("elevation drama"). */
  elevationIntensity: number;
  /** Morphable: how strongly crests/compressions couple to corners. */
  elevationCoupling: number;
  /** Constraint: maximum |grade| (fraction, e.g. 0.12 = 12%). */
  maxGrade: number;
  /** Morphable: banking strength 0..1 (maps to ~0..12 deg). */
  banking: number;
  /** Morphable: tendency for corners to fall away outward. */
  offCamber: number;
  /** Morphable: track width in meters. */
  width: number;

  // --- terrain (site mode) ---------------------------------------------------
  /** How strongly the route follows natural terrain features. */
  terrainAdherence: number;
  /** How far proposed road elevation may deviate from ground. */
  earthworkTolerance: number;
  maxCut: number;
  maxFill: number;
  /** Preference for contour following vs straight-line grades. */
  contourFollowing: number;
  ridgePreference: number;
  valleyPreference: number;

  // --- validity ------------------------------------------------------------
  mode: GeometryMode;
}

export function defaultParams(): TrackParams {
  return {
    targetLength: 5200,
    cornerCount: 14,
    compactness: 0.5,
    elongation: 0.35,
    asymmetry: 0.5,
    leftRightBalance: 0.5,
    direction: "random",

    curvatureSeverity: 0.5,
    longStraightBias: 0.45,
    flow: 0.6,
    technicality: 0.5,
    cornerVariety: 0.6,
    hairpinFreq: 0.25,
    sweeperFreq: 0.45,
    essesFreq: 0.35,
    chicaneFreq: 0.2,

    elevationIntensity: 0.4,
    elevationCoupling: 0.4,
    maxGrade: 0.12,
    banking: 0.35,
    offCamber: 0.15,
    width: 12,

    terrainAdherence: 0.5,
    earthworkTolerance: 0.4,
    maxCut: 18,
    maxFill: 14,
    contourFollowing: 0.5,
    ridgePreference: 0.3,
    valleyPreference: 0.3,

    mode: "realistic",
  };
}

/** Parameters that morph the existing track continuously. */
export const MORPHABLE_PARAMS: ReadonlySet<keyof TrackParams> = new Set([
  "compactness",
  "elongation",
  "asymmetry",
  "leftRightBalance",
  "curvatureSeverity",
  "longStraightBias",
  "flow",
  "technicality",
  "cornerVariety",
  "elevationIntensity",
  "elevationCoupling",
  "maxGrade",
  "banking",
  "offCamber",
  "width",
  "terrainAdherence",
  "earthworkTolerance",
  "maxCut",
  "maxFill",
  "contourFollowing",
  "ridgePreference",
  "valleyPreference",
  "mode",
]);

/** Parameters that re-synthesize track structure. */
export const STRUCTURAL_PARAMS: ReadonlySet<keyof TrackParams> = new Set([
  "targetLength",
  "cornerCount",
  "hairpinFreq",
  "sweeperFreq",
  "essesFreq",
  "chicaneFreq",
  "direction",
]);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One sample of the canonical, uniformly arc-length parameterized centerline. */
export interface TrackSample {
  /** Distance along lap in meters, 0 <= s < length. */
  s: number;
  x: number;
  y: number;
  /** Designed track elevation (not necessarily ground). */
  z: number;
  /** Tangent heading in radians (math convention, CCW positive from +x). */
  heading: number;
  /** Signed curvature 1/m. Positive = turning left. */
  kappa: number;
  /** Banking in radians. Positive = road tilts into a left turn. */
  bank: number;
  /** Full road width in meters. */
  width: number;
  /** Existing ground elevation (NaN in blank-canvas mode). */
  groundZ: number;
  /** Estimated speed m/s (filled by vehicle model; NaN until computed). */
  speed: number;
}

export type CornerDirection = "L" | "R";

export interface Corner {
  /** 1-based number in driving order. */
  id: number;
  sStart: number;
  sApex: number;
  sEnd: number;
  direction: CornerDirection;
  /** Smallest (tightest) radius within the corner, meters. */
  minRadius: number;
  /** Arc length of the corner, meters. */
  length: number;
  /** Total heading change, radians (always positive). */
  angle: number;
}

export interface Sector {
  index: number;
  sStart: number;
  sEnd: number;
}

// ---------------------------------------------------------------------------
// Generative DNA
// ---------------------------------------------------------------------------

/**
 * Structural DNA: an ordered road-design element sequence. Together with
 * the deform state and params this fully reproduces the canonical samples.
 */
export type AlignmentElement =
  | { type: "straight"; length: number }
  | {
      type: "corner";
      /** Corner radius at full curvature (meters). */
      radius: number;
      /** Total signed heading change, radians. */
      angle: number;
      /** +1 left, -1 right. */
      dir: 1 | -1;
      /** Clothoid transition length per side, meters. */
      transition: number;
      /** Corner archetype used for semantics/styling. */
      kind: "normal" | "hairpin" | "sweeper" | "esses" | "chicane";
    };

export interface DeformState {
  compactness: number;
  elongation: number;
  /** Rotation of the elongation axis, radians. */
  elongationAxis: number;
  asymmetry: number;
  /** Seeded radial noise amplitudes/phases used by the asymmetry deform. */
  asymmetryNoise: { amp: number[]; phase: number[] };
}

/** Generation-time snapshot of morphable weights baked into elements. */
export interface BaseMorph {
  severity: number;
  straightBias: number;
  flow: number;
  technicality: number;
  cornerVariety: number;
}

export interface TrackDNA {
  /** Pristine elements as generated (never mutated by morphs). */
  elements: AlignmentElement[];
  deform: DeformState;
  base: BaseMorph;
}

// ---------------------------------------------------------------------------
// Site / terrain
// ---------------------------------------------------------------------------

export interface SiteRef {
  /** Geographic reference (WGS84). */
  lat: number;
  lon: number;
  /** Site extent, meters (radius of the usable area). */
  radiusMeters: number;
  /** Optional polygon in local metric coords [x,y] pairs. */
  polygon?: [number, number][];
  name?: string;
}

export interface TerrainMeta {
  resolutionMeters: number;
  width: number;
  height: number;
  minElevation: number;
  maxElevation: number;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

export interface Track {
  version: number;
  seed: number;
  params: TrackParams;
  dna: TrackDNA;
  /** Uniformly sampled closed centerline. samples[N-1].s + ds == length. */
  samples: TrackSample[];
  /** Total lap length, meters. */
  length: number;
  /** Sample spacing, meters. */
  ds: number;
  startFinishS: number;
  corners: Corner[];
  sectors: Sector[];
  site: SiteRef | null;
  terrain: TerrainMeta | null;
}

// ---------------------------------------------------------------------------
// Queries (functions of s)
// ---------------------------------------------------------------------------

export function wrapS(track: Track, s: number): number {
  const L = track.length;
  return ((s % L) + L) % L;
}

/** Index pair + interpolation factor for arbitrary s. */
function locate(track: Track, s: number): [number, number, number] {
  const w = wrapS(track, s);
  const n = track.samples.length;
  const f = w / track.ds;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  return [i0, i1, f - Math.floor(f)];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function sampleAt(track: Track, s: number): TrackSample {
  const [i0, i1, t] = locate(track, s);
  const a = track.samples[i0];
  const b = track.samples[i1];
  return {
    s: wrapS(track, s),
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    heading: lerpAngle(a.heading, b.heading, t),
    kappa: lerp(a.kappa, b.kappa, t),
    bank: lerpAngle(a.bank, b.bank, t),
    width: lerp(a.width, b.width, t),
    groundZ: lerp(a.groundZ, b.groundZ, t),
    speed: lerp(a.speed, b.speed, t),
  };
}

export const positionAt = (tr: Track, s: number) => {
  const p = sampleAt(tr, s);
  return { x: p.x, y: p.y, z: p.z };
};
export const headingAt = (tr: Track, s: number) => sampleAt(tr, s).heading;
export const curvatureAt = (tr: Track, s: number) => sampleAt(tr, s).kappa;
export const elevationAt = (tr: Track, s: number) => sampleAt(tr, s).z;
export const bankingAt = (tr: Track, s: number) => sampleAt(tr, s).bank;
export const widthAt = (tr: Track, s: number) => sampleAt(tr, s).width;

/** Grade (dz/ds) at s via central difference. */
export function gradeAt(track: Track, s: number): number {
  const e = Math.max(1, track.ds);
  const z1 = elevationAt(track, s + e);
  const z0 = elevationAt(track, s - e);
  return (z1 - z0) / (2 * e);
}

/** Fraction of lap used by sector index. */
export function sectorAt(track: Track, s: number): Sector {
  const w = wrapS(track, s);
  for (const sec of track.sectors) {
    if (sec.sStart <= sec.sEnd) {
      if (w >= sec.sStart && w < sec.sEnd) return sec;
    } else if (w >= sec.sStart || w < sec.sEnd) {
      return sec;
    }
  }
  return track.sectors[0];
}
