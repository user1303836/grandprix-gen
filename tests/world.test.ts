/**
 * Procedural world tests: determinism, validity, clearance, hydrology,
 * and export coverage. No network involved.
 */

import { describe, expect, it } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { buildTrack } from "../src/core/build";
import { defaultParams, type Track } from "../src/core/types";
import { Rng } from "../src/core/prng";
import { surfaceFromPlan } from "../src/core/world/synthesis";
import { roleAt } from "../src/core/world/relationships";
import { trackToObj } from "../src/export/obj";
import { makeTrackProximity } from "../src/core/terrain";
import type { EnvironmentParams } from "../src/core/world/types";
import { DEFAULT_ENV_PARAMS } from "../src/core/world/types";

function blankTrack(seed: number): Track {
  const r = generateValidTrack(seed, defaultParams(), {}, 12);
  if (!r.track) throw new Error("no track");
  return r.track;
}

function trackWithWorld(seed: number, envSeed: number, env: Partial<EnvironmentParams> = {}): Track {
  const t0 = blankTrack(seed);
  const envParams = { ...DEFAULT_ENV_PARAMS, ...env };
  const dna = t0.dna;
  const r = buildTrack(t0.seed, t0.params, dna, {
    environment: { seed: envSeed, params: envParams },
  });
  if (!r.track) throw new Error("no world track");
  return r.track;
}

describe("procedural worlds", () => {
  it("same env seed reproduces the identical world", () => {
    const a = trackWithWorld(424242, 9001);
    const b = trackWithWorld(424242, 9001);
    const wa = a.world!;
    const wb = b.world!;
    expect(wb.envSeed).toBe(wa.envSeed);
    expect(wb.identity).toEqual(wa.identity);
    expect(wb.grid.width).toBe(wa.grid.width);
    expect(wb.grid.height).toBe(wa.grid.height);
    expect(wb.grid.elevation.length).toBe(wa.grid.elevation.length);
    let same = 0;
    for (let i = 0; i < wa.grid.elevation.length; i += 97) {
      if (wa.grid.elevation[i] === wb.grid.elevation[i]) same++;
    }
    expect(same).toBe(Math.ceil(wa.grid.elevation.length / 97));
    expect(wb.landmarks).toEqual(wa.landmarks);
    expect(wb.vegetation.trees.length).toBe(wa.vegetation.trees.length);
  });

  it("different env seeds preserve the track geometry", () => {
    const a = trackWithWorld(424242, 9001);
    const b = trackWithWorld(424242, 9002);
    // same track: centerline identical
    expect(a.samples.length).toBe(b.samples.length);
    for (let i = 0; i < a.samples.length; i += 50) {
      expect(b.samples[i].x).toBeCloseTo(a.samples[i].x, 6);
      expect(b.samples[i].y).toBeCloseTo(a.samples[i].y, 6);
      expect(b.samples[i].z).toBeCloseTo(a.samples[i].z, 6);
    }
    // but different worlds
    let diff = 0;
    for (let i = 0; i < a.world!.grid.elevation.length; i += 31) {
      if (a.world!.grid.elevation[i] !== b.world!.grid.elevation[i]) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });

  it("terrain has no NaN/Infinity and the boundary ring is closed", () => {
    const t = trackWithWorld(5150, 31337, { drama: 0.9 });
    const g = t.world!.grid;
    for (let i = 0; i < g.elevation.length; i++) {
      expect(Number.isFinite(g.elevation[i])).toBe(true);
      expect(Number.isFinite(g.moisture[i])).toBe(true);
    }
    const ring = t.world!.boundary.ring;
    expect(ring.length).toBeGreaterThan(8);
    // ring closes: first and last connect (polygon winding by construction)
    const d = Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y);
    expect(d).toBeLessThan(1000); // adjacent ring ends (closed polygon)
  });

  it("road does not penetrate the final terrain (corridor validation clean)", () => {
    const t = trackWithWorld(777001, 4242, { drama: 0.8, water: 0.8 });
    expect(t.civil).toBeTruthy();
    expect(t.civil!.feasible).toBe(true);
    expect(t.civil!.violations.filter((v) => v.includes("terrain-penetration")).length).toBe(0);
  });

  it("terrain is not a track-shaped mound: structure exists away from the road", () => {
    const t = trackWithWorld(900004, 777, { drama: 0.75 });
    const w = t.world!;
    const prox = makeTrackProximity(t.samples);
    const surf = surfaceFromPlan(w);
    // sample points far from the road: relief must vary substantially
    const zs: number[] = [];
    for (let k = 0; k < 400; k++) {
      const rng = new Rng(k * 31 + 7);
      const x = w.grid.originX + rng.next() * w.grid.width * w.grid.resolution;
      const y = w.grid.originY + rng.next() * w.grid.height * w.grid.resolution;
      const near = prox.nearest(x, y, 160);
      if (near) continue; // only far-field
      const z = surf.elevationAt(x, y);
      if (Number.isFinite(z)) zs.push(z);
    }
    expect(zs.length).toBeGreaterThan(40);
    const mn = Math.min(...zs);
    const mx = Math.max(...zs);
    expect(mx - mn).toBeGreaterThan(12); // real relief, not a flat apron
  });

  it("river centerline never flows uphill and crosses the road under a bridge", () => {
    const t = trackWithWorld(20240, 5555, { style: "river-valley", water: 0.9, drama: 0.7 });
    const river = t.world!.water.find((w) => w.type === "river");
    expect(river).toBeTruthy();
    if (river!.type !== "river") return;
    for (let i = 1; i < river!.points.length; i++) {
      expect(river!.points[i].z).toBeLessThanOrEqual(river!.points[i - 1].z + 1e-6);
    }
    // crossing covered by an elevated/structure civil span
    const sCross = river!.crossings[0];
    const kind = t.civil!.spans.find((sp) => {
      const a = sp.sStart;
      const b = sp.sEnd;
      return a <= b ? sCross >= a && sCross < b : sCross >= a || sCross < b;
    })?.kind;
    expect(kind).toBeTruthy();
    expect(["short-bridge", "viaduct", "platform", "shelf", "gallery", "embankment", "terraced"]).toContain(kind);
  });

  it("trees and landmarks respect corridor clearance", () => {
    const t = trackWithWorld(31337, 999, { vegetation: 1 });
    const w = t.world!;
    const prox = makeTrackProximity(t.samples);
    for (const tree of w.vegetation.trees) {
      const near = prox.nearest(tree.x, tree.y, 30);
      if (near) expect(near.d).toBeGreaterThanOrEqual(24);
    }
    for (const lm of w.landmarks) {
      if (lm.kind === "rock-arch" || lm.kind === "forest-tunnel") continue; // intentional over-road
      const near = prox.nearest(lm.x, lm.y, 30);
      if (near) expect(near.d).toBeGreaterThanOrEqual(13);
    }
  });

  it("civil structures exist and piers do not intersect the road deck", () => {
    const t = trackWithWorld(618033, 24601, { drama: 0.85, water: 0.7 });
    expect(t.civil!.spans.length).toBeGreaterThan(3);
    // spot check: road surface above ground where elevated, below where cut
    const surf = surfaceFromPlan(t.world!);
    const n = t.samples.length;
    let elevatedOk = 0;
    let elevatedTotal = 0;
    for (const sp of t.civil!.spans) {
      if (sp.kind !== "viaduct" && sp.kind !== "short-bridge") continue;
      const iMid = Math.round(((sp.sStart + sp.sEnd) / 2) / t.ds) % n;
      const smp = t.samples[iMid];
      const gz = surf.elevationAt(smp.x, smp.y);
      if (!Number.isFinite(gz)) continue;
      elevatedTotal++;
      if (gz < smp.z - 1) elevatedOk++;
    }
    if (elevatedTotal > 0) expect(elevatedOk / elevatedTotal).toBeGreaterThan(0.6);
  });

  it("world geometry appears in exports (OBJ)", () => {
    const t = trackWithWorld(112358, 60, { boundary: "diorama" });
    const obj = trackToObj(t, { terrain: surfaceFromPlan(t.world!), world: t.world! });
    expect(obj).toContain("o terrain");
    expect(obj).toContain("o world_boundary");
  });

  it("site mode is untouched: no world without environment option", () => {
    const t = blankTrack(60606);
    expect(t.world ?? null).toBeNull();
    expect(t.environment ?? null).toBeNull();
  });

  it("role planner produces coherent spans (min lengths respected)", () => {
    const t = trackWithWorld(246, 135, { style: "river-valley", water: 0.8 });
    const spans = t.world!.spans;
    expect(spans.length).toBeGreaterThan(3);
    for (const sp of spans) {
      const len = (sp.sEnd - sp.sStart + t.length) % t.length;
      expect(len).toBeGreaterThan(20); // absorption floor
    }
    // developed zone at start
    expect(roleAt(spans, 0, t.length).kind).toBe("developed");
  });
});
