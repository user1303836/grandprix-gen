/**
 * Canonical procedural-world model. UI-independent and deterministic:
 * the same (track geometry, envSeed, envParams, version) must reproduce
 * the same world. Three.js meshes are derived from this data, never the
 * source of truth. All coordinates are local meters (track plan coords);
 * synthetic worlds are never georeferenced.
 */

export type Landform =
  | "rolling-hills"
  | "plateau"
  | "ridges"
  | "valley"
  | "canyon"
  | "basin"
  | "island";

export type Biome =
  | "temperate-forest"
  | "alpine"
  | "volcanic"
  | "arid"
  | "coastal"
  | "highland";

export type HydrologyKind = "dry" | "seasonal-stream" | "river" | "lake" | "coast";

export type Humanization =
  | "wilderness"
  | "heritage-road"
  | "mountain-club"
  | "modern-circuit"
  | "industrial"
  | "fantasy-megaproject";

export type EnvRealism = "realistic" | "permissive" | "fantasy";
export type BoundaryMode = "open" | "diorama" | "island";

/** Friendly style presets; "auto" rolls from the environment seed. */
export type EnvironmentStyle =
  | "auto"
  | "highland-forest"
  | "river-valley"
  | "cliffside"
  | "volcanic-plateau"
  | "coastal-island"
  | "alpine-canyon"
  | "plinth-fantasy";

export interface EnvironmentParams {
  style: EnvironmentStyle;
  /** macro terrain amplitude 0..1 */
  drama: number;
  /** how tightly terrain honors relationship constraints 0..1 */
  coupling: number;
  /** water presence 0..1 */
  water: number;
  /** vegetation density 0..1 */
  vegetation: number;
  boundary: BoundaryMode;
  realism: EnvRealism;
}

export const DEFAULT_ENV_PARAMS: EnvironmentParams = {
  style: "auto",
  drama: 0.55,
  coupling: 0.7,
  water: 0.5,
  vegetation: 0.6,
  boundary: "open",
  realism: "realistic",
};

export interface EnvironmentIdentity {
  landform: Landform;
  biome: Biome;
  hydrology: HydrologyKind;
  humanization: Humanization;
  /** derived display name, e.g. "Highland Forest Valley" */
  label: string;
}

/** Landscape roles assigned to coherent spans of the track. */
export type RoleKind =
  | "at-grade"
  | "hillside-bench"
  | "open-cut"
  | "embankment"
  | "ridge"
  | "valley-floor"
  | "cliff-edge"
  | "ravine-crossing"
  | "river-crossing"
  | "plateau"
  | "forest-corridor"
  | "tunnel-ridge"
  | "developed"; // pit/start developed flat ground

export interface RoleSpan {
  kind: RoleKind;
  sStart: number;
  sEnd: number;
  /** -1 = drop/rise to the left of travel, +1 = right (bench/cliff roles) */
  side: -1 | 0 | 1;
  /** role strength 0..1 (ravine depth, ridge height scale, ...) */
  intensity: number;
}

export interface WaterBodyRiver {
  type: "river";
  /** centerline in plan coords; z is the water surface elevation */
  points: { x: number; y: number; z: number }[];
  width: number;
  /** s positions where the river crosses under the road */
  crossings: number[];
}

export interface WaterBodyLake {
  type: "lake";
  x: number;
  y: number;
  radius: number;
  level: number;
}

export interface WaterBodyCoast {
  type: "coast";
  level: number;
}

export type WaterBody = WaterBodyRiver | WaterBodyLake | WaterBodyCoast;

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  conifer: boolean;
  autumnHue: number;
}

export interface TuftPlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
}

export interface BoulderPlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  seed: number;
}

export interface VegetationPlan {
  trees: TreePlacement[];
  tufts: TuftPlacement[];
  boulders: BoulderPlacement[];
}

export type LandmarkKind =
  | "hero-tree" // giant tree, canopy may overhang the road with clearance
  | "forest-tunnel" // dense arching grove over a straight
  | "crest-tree" // solitary silhouette tree on a crest
  | "monolith" // rock spire
  | "cliff-wall" // emphasized rock face beside the road
  | "waterfall"
  | "rock-arch" // straddles the road (permissive/fantasy)
  | "viewing-platform"
  | "ruin"; // abandoned structure

export interface Landmark {
  kind: LandmarkKind;
  x: number;
  y: number;
  z: number;
  heading: number;
  scale: number;
  /** nearest track arc position (composition anchor) */
  s: number;
  seed: number;
}

export type BoundaryTreatment =
  | "rock-cliff"
  | "stratified-earth"
  | "concrete-plinth"
  | "coastline"
  | "fog-drop"
  | "open-fade";

export interface WorldBoundary {
  /** closed ring (plan coords), irregular buffered hull around the track */
  ring: { x: number; y: number }[];
  mode: BoundaryMode;
  treatment: BoundaryTreatment;
  /** skirt bottom elevation (world-local) */
  baseZ: number;
}

export interface WorldPlan {
  version: 1;
  envSeed: number;
  envParams: EnvironmentParams;
  identity: EnvironmentIdentity;
  spans: RoleSpan[];
  /** canonical heightfield (local meters; NaN never allowed inside) */
  grid: {
    originX: number;
    originY: number;
    resolution: number;
    width: number;
    height: number;
    minElevation: number;
    maxElevation: number;
    elevation: Float32Array;
    /** parallel moisture field 0..1 for vegetation/tinting */
    moisture: Float32Array;
  };
  boundary: WorldBoundary;
  water: WaterBody[];
  vegetation: VegetationPlan;
  landmarks: Landmark[];
}

/** Serialized environment reference stored on the Track. */
export interface TrackEnvironmentRef {
  envSeed: number;
  envParams: EnvironmentParams;
  version: 1;
}
