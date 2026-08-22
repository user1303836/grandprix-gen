/**
 * Facility night lighting: emissive anchors (garage interiors, numbers,
 * canopy strips, windows, concourse, screens, high-mast floodlights) with
 * a bounded pool of REAL lights near the main complex. Density and warmth
 * vary with facility type and night readiness.
 */

import { mulberry32 } from "../prng";
import type { Archetype } from "../../data/facilityArchetypes";
import type {
  FacilityIdentity,
  FacilityLightingPlan,
  LightAnchor,
  PitComplexPlan,
  PitLanePlan,
  FacilitySitePlan,
  GrandstandPlan,
} from "./types";
import type { Track } from "../types";

export function buildLighting(
  track: Track,
  site: FacilitySitePlan,
  pitLane: PitLanePlan | null,
  complex: PitComplexPlan | null,
  stands: GrandstandPlan[],
  arch: Archetype,
  identity: FacilityIdentity,
  seed: number,
): FacilityLightingPlan {
  const rnd = mulberry32(seed ^ 0x1167);
  const anchors: LightAnchor[] = [];
  const readiness = identity.nightEventReadiness;
  if (readiness < 0.08) return { anchors, realLightIndices: [] };

  void site;
  void track;

  // ---- pit-lane high masts (spaced along the working section) -------------
  if (pitLane) {
    const apron = pitLane.laneBands.find((b) => b.kind === "garage-apron")!;
    const spacing = readiness > 0.7 ? 42 : 65;
    for (let s = pitLane.phases.workingS[0]; s < pitLane.phases.workingS[1]; s += spacing) {
      const cl = pitLane.centerline[Math.min(pitLane.centerline.length - 1, Math.round(s / 4))];
      anchors.push({ kind: "pit-high-mast", x: cl.x, y: cl.y, z: cl.z + 11, intensity: 1.4, color: 0xf2ecdc });
    }
    // pit-wall task lights (small, frequent, only when quite lit)
    if (readiness > 0.45) {
      for (let s = pitLane.pitWall.sStart; s < pitLane.pitWall.sEnd; s += 16) {
        const cl = pitLane.centerline[Math.min(pitLane.centerline.length - 1, Math.round(s / 4))];
        anchors.push({ kind: "pit-wall-task", x: cl.x, y: cl.y, z: cl.z + 1.3, intensity: 0.35, color: 0xd8e2ea });
      }
    }
    // canopy strip along the garage apron
    for (let s = pitLane.phases.workingS[0]; s < pitLane.phases.workingS[1]; s += 8) {
      const cl = pitLane.centerline[Math.min(pitLane.centerline.length - 1, Math.round(s / 4))];
      anchors.push({ kind: "canopy-strip", x: cl.x, y: cl.y, z: cl.z + 4.4, intensity: 0.6, color: 0xeae4d2 });
    }
    void apron;
  }

  // ---- garage interiors + numbers ------------------------------------------
  if (complex) {
    for (const bay of complex.garageBays) {
      if (bay.doorOpen || rnd() < 0.55) {
        anchors.push({ kind: "garage-interior", x: bay.x, y: bay.y, z: bay.z + 2.6, intensity: 0.9, color: 0xffe8c4 });
      }
      anchors.push({ kind: "garage-number", x: bay.x, y: bay.y, z: bay.z + 3.6, intensity: 0.5, color: 0xbfe0ff });
    }
    // windows on hospitality/tower floors
    for (const v of complex.volumes) {
      const winCount = Math.round(v.widthU / 6);
      for (let f = 1; f < v.floors; f++) {
        for (let k = 0; k < winCount; k++) {
          if (rnd() > 0.28 + readiness * 0.5) continue; // dark offices exist
          const t = (k + 0.5) / winCount - 0.5;
          anchors.push({
            kind: rnd() < 0.7 ? "window-warm" : "window-cool",
            x: v.cx + Math.cos(v.angleU) * t * v.widthU,
            y: v.cy + Math.sin(v.angleU) * t * v.widthU,
            z: v.baseZ + (f + 0.55) * v.floorHeight,
            intensity: 0.5 + rnd() * 0.3,
            color: rnd() < 0.7 ? 0xffd9a0 : 0xcfe4ff,
          });
        }
      }
    }
  }

  // ---- grandstand concourse + roof underlight -------------------------------
  for (const st of stands) {
    if (st.roof === "none") continue;
    const n = Math.max(2, Math.round(st.width / 22));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n - 0.5;
      anchors.push({
        kind: "roof-underlight",
        x: st.origin.x + st.longDir.x * t * st.width,
        y: st.origin.y + st.longDir.y * t * st.width,
        z: st.origin.z + st.rows * st.rowRise + 1.2,
        intensity: 0.7,
        color: 0xe8ecda,
      });
    }
  }

  // ---- real light pool: the brightest anchors near the complex -------------
  const scored = anchors
    .map((a, i) => ({ i, s: a.intensity * (a.kind === "pit-high-mast" ? 2 : 1) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => x.i);

  return { anchors, realLightIndices: scored };
}
