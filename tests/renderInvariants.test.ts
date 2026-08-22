/**
 * Render-space invariants: these test what reaches the SCREEN, not plans.
 * Adversarial fixtures preserved: track seeds 141721562 and 3686475847
 * (sky pit-lane ribbon, mirrored grandstands, detached crowd).
 */
import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { generateValidTrack } from "../src/core/generator";
import { defaultParams, sampleAt } from "../src/core/types";
import type { Track } from "../src/core/types";
import { planFacilities } from "../src/core/facilities/plan";
import { defaultFacilityControls } from "../src/core/facilities/types";
import { buildFacilityMeshParts } from "../src/export/facilityMesh";
import { corridorCarve, type TerrainSurface } from "../src/core/terrain";
import { Corridor } from "../src/core/corridor";
import { planPointToWorld, worldPointToPlan } from "../src/core/planWorld";

function trackFor(seed: number): Track {
  const r = generateValidTrack(seed, defaultParams());
  if (!r.track) throw new Error(`no track for seed ${seed}`);
  return r.track;
}

describe("render-space invariants", () => {
  it("plan↔world conversion is a pure permutation and inverts", () => {
    const p = { x: 123.4, y: -567.8, z: 42.0 };
    const w = planPointToWorld(p.x, p.y, p.z);
    expect(w).toEqual({ x: 123.4, y: 42.0, z: 567.8 });
    const back = worldPointToPlan(w.x, w.y, w.z);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    expect(back.z).toBeCloseTo(p.z);
  });

  for (const seed of [141721562, 3686475847]) {
    it(`facility export vertices stay in plan bounds (seed ${seed})`, () => {
      const track = trackFor(seed);
      const plan = planFacilities(track, null, defaultFacilityControls(884210));
      const parts = buildFacilityMeshParts({ ...track, facilities: plan });
      expect(parts.length).toBeGreaterThan(3);
      // plan bounds
      let minZ = Infinity;
      let maxZ = -Infinity;
      let cx = 0;
      let cy = 0;
      for (const smp of track.samples) {
        minZ = Math.min(minZ, smp.z);
        maxZ = Math.max(maxZ, smp.z);
        cx += smp.x;
        cy += smp.y;
      }
      cx /= track.samples.length;
      cy /= track.samples.length;
      let maxR = 0;
      for (const smp of track.samples) maxR = Math.max(maxR, Math.hypot(smp.x - cx, smp.y - cy));
      for (const part of parts) {
        for (let i = 0; i < part.positions.length; i += 3) {
          const x = part.positions[i];
          const y = part.positions[i + 1];
          const z = part.positions[i + 2];
          // no plan-y smuggled into altitude: z stays near the track range
          expect(z).toBeGreaterThan(minZ - 60);
          expect(z).toBeLessThan(maxZ + 120);
          expect(Math.hypot(x - cx, y - cy)).toBeLessThan(maxR + 400);
        }
      }
    });
  }

  it("grandstand basis is right-handed (det = +1) and rows recede from the target", () => {
    const track = trackFor(141721562);
    const plan = planFacilities(track, null, { ...defaultFacilityControls(884210), grandstandDensity: 0.9, scale: 0.8 });
    expect(plan.grandstands.length).toBeGreaterThan(0);
    for (const st of plan.grandstands) {
      // the renderer's basis: X=longDir, Y=up, Z=frontDir (world-mapped)
      const x = new Vector3(st.longDir.x, 0, -st.longDir.y);
      const zAxis = new Vector3(st.frontDir.x, 0, -st.frontDir.y);
      const m = new Matrix4().makeBasis(x, new Vector3(0, 1, 0), zAxis);
      expect(m.determinant()).toBeCloseTo(1, 5);
      // front edge closer to the target than the rear edge
      const midS = ((st.targetTrackRange.sStart + st.targetTrackRange.sEnd) / 2) % track.length;
      const tp = sampleAt(track, midS);
      const depth = st.rows * st.rowDepth;
      const frontDist = Math.hypot(st.origin.x - tp.x, st.origin.y - tp.y);
      const rearDist = Math.hypot(st.origin.x - st.frontDir.x * depth - tp.x, st.origin.y - st.frontDir.y * depth - tp.y);
      expect(rearDist).toBeGreaterThan(frontDist);
    }
  });

  it("corridor carve never seats terrain ABOVE the engineered corridor surface", () => {
    const track = trackFor(141721562);
    // synthetic ground: rolling surface BELOW/at the road (cut-heavy proxy)
    const grid: TerrainSurface = {
      elevationAt: (x: number, y: number) => Math.sin(x * 0.01) * 8 + Math.cos(y * 0.013) * 6,
      slopeAt: () => 0.2,
    } as unknown as TerrainSurface;
    const corr = new Corridor(track);
    const carve = corridorCarve(grid, track, 120);
    for (let s = 0; s < track.length; s += 97) {
      const smp = sampleAt(track, s);
      for (const side of [-1, 1]) {
        for (const a of [2, 6, 10, 14]) {
          const nx = -Math.sin(smp.heading) * side;
          const ny = Math.cos(smp.heading) * side;
          const x = smp.x + nx * a;
          const y = smp.y + ny * a;
          const carved = carve(x, y);
          const surf = corr.surface(s, side * a);
          expect(carved).toBeLessThanOrEqual(surf.z + 1e-9);
        }
      }
    }
  });

  it("carve-active corridor coverage seats BELOW road level on banked samples", () => {
    const track = trackFor(3686475847);
    const grid: TerrainSurface = {
      elevationAt: (x: number, y: number) => Math.sin(x * 0.01) * 8 + Math.cos(y * 0.013) * 6,
      slopeAt: () => 0.2,
    } as unknown as TerrainSurface;
    const carve = corridorCarve(grid, track, 120);
    // at the road's LOW edge on banked sections, terrain must be below the edge
    for (let i = 0; i < track.samples.length; i += 61) {
      const smp = track.samples[i];
      if (Math.abs(smp.bank) < 0.04) continue;
      const half = Math.max(track.props.widthL[i], track.props.widthR[i]);
      const nx = -Math.sin(smp.heading);
      const ny = Math.cos(smp.heading);
      // low edge side: bank sign picks the side; probe both edges
      for (const side of [-1, 1]) {
        const x = smp.x + nx * side * half;
        const y = smp.y + ny * side * half;
        const carved = carve(x, y);
        const edgeZ = smp.z - side * half * Math.tan(smp.bank);
        expect(carved).toBeLessThanOrEqual(edgeZ + 0.05);
      }
    }
  });
});
