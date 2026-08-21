/**
 * Canonical facility representation — the single source of truth for the
 * pit complex, grandstands, foundations, lighting, and reservations.
 * Rendered meshes (src/ui/facilities3d.ts) and exports consume this plan;
 * meshes are never the source of truth.
 *
 * All geometry is in TRACK-PLAN coordinates (x,y plan meters, z up),
 * matching Track.samples. Deterministic for (track, facilitySeed,
 * generator version, facility controls).
 */

import type { ArchitectureStyle, FacilityClass, GrandstandKind, RoofKind } from "../../data/facilityArchetypes";

export interface Vec2 {
  x: number;
  y: number;
}

export type Polygon2D = Vec2[];

export const FACILITIES_VERSION = 1;

// ---------------------------------------------------------------- controls

/** User-facing facility controls (independent of the track seed). */
export interface FacilityControls {
  seed: number;
  style: ArchitectureStyle | "auto";
  /** 0 compact … 1 monumental */
  scale: number;
  /** 0 conservative … 1 experimental */
  variation: number;
  /** 0 sparse … 1 high capacity */
  grandstandDensity: number;
  /** 0 empty … 1 race day */
  crowdDensity: number;
  /** 0 minimal … 1 fully lit */
  nightReadiness: number;
}

export function defaultFacilityControls(seed: number): FacilityControls {
  return {
    seed,
    style: "auto",
    scale: 0.5,
    variation: 0.35,
    grandstandDensity: 0.5,
    crowdDensity: 0.7,
    nightReadiness: 0.5,
  };
}

// ---------------------------------------------------------------- identity

export interface FacilityIdentity {
  facilityClass: FacilityClass;
  architectureStyle: ArchitectureStyle;
  permanence: "permanent" | "temporary" | "hybrid";
  /** 0..1 compact→monumental (resolved, never "auto") */
  scale: number;
  architecturalVariation: number;
  crowdCapacity: number;
  budget: number;
  nightEventReadiness: number;
}

// ---------------------------------------------------------------- ground

/** Narrow terrain abstraction — works for DEM, synthetic, or flat worlds. */
export interface GroundSurface {
  elevationAt(x: number, y: number): number | null;
  slopeAt?(x: number, y: number): number;
}

// ---------------------------------------------------------------- site

export interface FacilitySitePlan {
  /** chosen pit-straight window (arc positions, sEnd > sStart, no wrap) */
  sStart: number;
  sEnd: number;
  /** pit side relative to travel direction */
  side: "left" | "right";
  /** candidate score 0..1 */
  score: number;
  /** rejected candidates (debug) */
  rejected: { sStart: number; sEnd: number; side: "left" | "right"; reason: string }[];
}

// ---------------------------------------------------------------- pit lane

/** One lateral band of the pit-lane cross-section (track side → building). */
export interface PitLaneBand {
  kind:
    | "verge"
    | "pit-wall"
    | "fast-lane"
    | "working-lane"
    | "box-apron"
    | "garage-apron"
    | "paddock";
  /** lateral offset from main-track centerline, plan meters (inner edge) */
  offsetInner: number;
  offsetOuter: number;
  surface: "asphalt" | "concrete" | "paint" | "grass";
}

export interface FacilityPathSample {
  s: number; // arc position along the pit path itself
  x: number;
  y: number;
  z: number;
  heading: number;
  kappa: number;
  /** corresponding main-track s (for attachment/validation) */
  trackS: number;
}

export interface PitBoxPlan {
  index: number;
  /** center along the pit path */
  s: number;
  /** garage bay id this box serves (null = spare box) */
  bayId: number | null;
  width: number; // across the lane
  length: number; // along the lane
}

export interface FacilityMarkingPlan {
  kind:
    | "pit-entry-line"
    | "pit-exit-line"
    | "speed-limit-line"
    | "release-line"
    | "box-outline"
    | "box-number"
    | "arrow"
    | "working-rect"
    | "fast-lane-separation";
  s: number;
  /** lateral offset from pit-path centerline */
  offset: number;
  length: number;
  angle?: number;
  text?: string;
}

export interface PitWallPlan {
  sStart: number;
  sEnd: number;
  /** openings (marshal access / pit-box gaps) as s-ranges */
  openings: { s: number; length: number }[];
  /** signalling stations along the wall */
  stations: { s: number }[];
}

export interface PitLanePlan {
  side: "left" | "right";
  /** main-straight window the lane serves */
  mainStraightSStart: number;
  mainStraightSEnd: number;
  /** pit path centerline: entry leaves the track, runs the working
   * section, exit rejoins — one continuous polyline with z + heading */
  centerline: FacilityPathSample[];
  /** arc ranges of the phases along the pit path */
  phases: {
    entryS: [number, number];
    decelS: [number, number];
    workingS: [number, number];
    exitS: [number, number];
    accelS: [number, number];
  };
  /** where the path leaves / rejoins the main track (track s) */
  entryTrackS: number;
  exitTrackS: number;
  laneBands: PitLaneBand[];
  pitBoxes: PitBoxPlan[];
  markings: FacilityMarkingPlan[];
  pitWall: PitWallPlan;
  speedLimitS: number;
  releaseS: number;
  /** total paved width (bands sum) */
  width: number;
}

// ---------------------------------------------------------------- complex

export interface BuildingVolumePlan {
  id: string;
  kind:
    | "garage-block"
    | "hospitality"
    | "race-control"
    | "tower"
    | "service-core"
    | "media"
    | "clubhouse"
    | "screen-tower"
    | "pedestrian-bridge";
  /** footprint center (plan) + size */
  cx: number;
  cy: number;
  /** building-local axes: u = along the pit straight, v = away from track */
  angleU: number;
  widthU: number; // along straight
  depthV: number; // away from track
  baseZ: number; // floor datum (from foundations)
  floors: number;
  floorHeight: number;
  /** facade treatment per floor */
  facade: ("garage-doors" | "solid" | "glazed" | "balcony" | "open")[];
  roof: RoofKind;
  foundationId: string;
}

export interface GarageBayPlan {
  id: number;
  volumeId: string;
  /** center of the bay frontage along the straight */
  u: number;
  frontOffsetV: number; // v of the garage door plane
  width: number;
  doorColor: number;
  doorOpen: boolean;
  number: number;
  teamName: string;
}

export interface CanopyPlan {
  kind: RoofKind;
  /** coverage along the straight */
  uStart: number;
  uEnd: number;
  /** coverage away from the building front (toward the lane) */
  vFront: number;
  vBack: number;
  z: number;
  /** support columns along the front edge */
  columns: number;
}

export interface PitComplexPlan {
  volumes: BuildingVolumePlan[];
  garageBays: GarageBayPlan[];
  canopy: CanopyPlan | null;
  /** paddock apron surface behind the building */
  paddockApron: { polygon: Polygon2D; z: number; surface: "asphalt" | "concrete" | "gravel" };
  /** rear service road (plan polyline) */
  serviceRoad: { points: Vec2[]; width: number } | null;
  /** pedestrian bridges over the pit lane */
  pedestrianBridges: { u: number; width: number; z: number }[];
}

// ---------------------------------------------------------------- grandstand

export interface GrandstandPlan {
  id: string;
  kind: GrandstandKind;
  /** the track range the stand watches */
  targetTrackRange: { sStart: number; sEnd: number };
  /** plan-space unit vector the stand FACES (toward the track) */
  frontDir: Vec2;
  /** plan-space unit vector along the seating rows */
  longDir: Vec2;
  /** footprint polygon (plan) */
  footprint: Polygon2D;
  /** center of the front-bottom corner of the first row */
  origin: { x: number; y: number; z: number };
  rows: number;
  rowDepth: number;
  rowRise: number;
  tiers: number;
  /** width along longDir */
  width: number;
  roof: RoofKind;
  capacityEstimate: number;
  foundationId: string;
  /** sightline score 0..1 from validation */
  viewScore: number;
  /** seats face the target: dot(frontDir, toTarget) at planning time */
  facingDot: number;
}

// ---------------------------------------------------------------- foundation

export interface FoundationPlan {
  id: string;
  kind:
    | "slab-on-grade"
    | "cut-fill-pad"
    | "stepped-plinth"
    | "retaining-terrace"
    | "column-deck"
    | "podium"
    | "hillside-terrace"
    | "piles"
    | "temporary-footings";
  footprint: Polygon2D;
  /** facility datum elevation(s); stepped kinds get one per step */
  datumZ: number[];
  /** terrain stats beneath the footprint */
  ground: { min: number; max: number; mean: number; slope: number };
  /** support points that must contact ground (plan + column top z) */
  supports: { x: number; y: number; topZ: number }[];
}

// ---------------------------------------------------------------- lighting

export interface LightAnchor {
  kind:
    | "garage-interior"
    | "garage-number"
    | "pit-high-mast"
    | "canopy-strip"
    | "pit-wall-task"
    | "window-warm"
    | "window-cool"
    | "concourse"
    | "stair"
    | "roof-underlight"
    | "screen-emissive"
    | "floodlight";
  x: number;
  y: number;
  z: number;
  /** emissive intensity multiplier */
  intensity: number;
  color: number;
}

export interface FacilityLightingPlan {
  anchors: LightAnchor[];
  /** indices into anchors that deserve pooled REAL lights at night */
  realLightIndices: number[];
}

// ---------------------------------------------------------------- reservation

export interface ElevationBand {
  min: number;
  max: number;
}

/** Stage-A output for the concurrent landscape generator. */
export interface FacilityReservation {
  developedPolygons: Polygon2D[];
  vegetationExclusionPolygons: Polygon2D[];
  preferredElevationBands: ElevationBand[];
  requiredAccessCorridors: Polygon2D[];
}

// ---------------------------------------------------------------- violations

export interface FacilityViolation {
  kind:
    | "site-infeasible"
    | "pitlane-topology"
    | "pitlane-grade"
    | "pitlane-curvature"
    | "pitlane-track-overlap"
    | "building-track-collision"
    | "building-unsupported"
    | "building-terrain-penetration"
    | "garage-door-orientation"
    | "stand-facing"
    | "stand-unsupported"
    | "stand-sightline"
    | "light-floating";
  s: number;
  detail: string;
}

// ---------------------------------------------------------------- plan

export interface FacilityPlan {
  version: number;
  seed: number;
  identity: FacilityIdentity;
  site: FacilitySitePlan;
  pitLane: PitLanePlan | null;
  pitComplex: PitComplexPlan | null;
  grandstands: GrandstandPlan[];
  foundations: FoundationPlan[];
  lighting: FacilityLightingPlan;
  reservation: FacilityReservation;
  feasible: boolean;
  violations: FacilityViolation[];
}
