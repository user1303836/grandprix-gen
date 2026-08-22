/**
 * Facility planner orchestration: identity → site → pit lane → (complex,
 * grandstands, foundations, lighting in later phases) → validation.
 * Pure and deterministic for (track, controls, generator version).
 */

import { archetypeById } from "../../data/facilityArchetypes";
import { mulberry32 } from "../prng";
import { sampleAt, type Track } from "../types";
import { rollFacilityIdentity } from "./identity";
import { buildPitComplex } from "./pitComplex";
import { buildPitLane } from "./pitLane";
import { selectFacilitySite } from "./siteSelection";
import {
  FACILITIES_VERSION,
  type FacilityControls,
  type FacilityPlan,
  type FacilityReservation,
  type FacilityViolation,
  type GroundSurface,
  type Polygon2D,
} from "./types";

/** Footprint rectangle along the pit-straight on the pit side. */
function siteFootprint(track: Track, sStart: number, sEnd: number, side: "left" | "right", offInner: number, offOuter: number): Polygon2D {
  const sign = side === "left" ? 1 : -1;
  const pts: Polygon2D = [];
  const back: Polygon2D = [];
  for (let s = sStart; s <= sEnd; s += 20) {
    const p = sampleAt(track, s % track.length);
    const nx = -Math.sin(p.heading) * sign;
    const ny = Math.cos(p.heading) * sign;
    pts.push({ x: p.x + nx * offInner, y: p.y + ny * offInner });
    back.push({ x: p.x + nx * offOuter, y: p.y + ny * offOuter });
  }
  return [...pts, ...back.reverse()];
}

export function planFacilities(
  track: Track,
  ground: GroundSurface | null,
  controls: FacilityControls,
): FacilityPlan {
  const rnd = mulberry32(controls.seed ^ 0xfac1);
  const identity = rollFacilityIdentity(track, controls);
  const arch = archetypeById(identity.architectureStyle);
  const violations: FacilityViolation[] = [];

  // ---- Stage A: site -----------------------------------------------------
  const site = selectFacilitySite(track, ground, controls.seed, 320);
  if (!site) {
    violations.push({ kind: "site-infeasible", s: 0, detail: "no straight window passed land/structure scoring" });
    return {
      version: FACILITIES_VERSION,
      seed: controls.seed,
      identity,
      site: { sStart: 0, sEnd: 0, side: "left", score: 0, rejected: [] },
      pitLane: null,
      pitComplex: null,
      grandstands: [],
      foundations: [],
      lighting: { anchors: [], realLightIndices: [] },
      reservation: { developedPolygons: [], vegetationExclusionPolygons: [], preferredElevationBands: [], requiredAccessCorridors: [] },
      feasible: false,
      violations,
    };
  }

  // ---- pit lane (phase 3) --------------------------------------------------
  const pit = buildPitLane(track, site, arch, controls.seed, ground);
  for (const v of pit.violations) {
    violations.push({ kind: "pitlane-topology", s: 0, detail: v });
  }

  // ---- pit complex (phase 4) -----------------------------------------------
  const complex = buildPitComplex(track, site, pit.plan, arch, identity, controls.seed);
  for (const v of complex.violations) {
    violations.push({ kind: "building-unsupported", s: 0, detail: v });
  }

  // ---- reservation polygons (Stage A contract) -----------------------------
  const buildingDepth = arch.depth[0] + (arch.depth[1] - arch.depth[0]) * 0.5;
  const pitHalfW = pit.plan.width;
  const dev: Polygon2D[] = [];
  const veg: Polygon2D[] = [];
  const halfW = 7;
  const complexFp = siteFootprint(track, site.sStart, site.sEnd, site.side, halfW, halfW + pitHalfW + buildingDepth + 14);
  dev.push(complexFp);
  // vegetation exclusion: a margin around the developed zone
  const vegFp = siteFootprint(track, site.sStart - 60, site.sEnd + 60, site.side, halfW - 4, halfW + pitHalfW + buildingDepth + 30);
  veg.push(vegFp);
  const reservation: FacilityReservation = {
    developedPolygons: dev,
    vegetationExclusionPolygons: veg,
    preferredElevationBands: [],
    requiredAccessCorridors: [],
  };

  void rnd;
  return {
    version: FACILITIES_VERSION,
    seed: controls.seed,
    identity,
    site,
    pitLane: pit.plan,
    pitComplex: complex.plan,
    grandstands: [],
    foundations: [],
    lighting: { anchors: [], realLightIndices: [] },
    reservation,
    feasible: violations.filter((v) => v.kind === "pitlane-topology").length === 0,
    violations,
  };
}
