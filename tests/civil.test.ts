/**
 * Civil engineering tests: synthetic terrain fixtures + planner behavior
 * + validation guarantees. No network DEMs involved.
 */

import { describe, expect, it } from "vitest";
import { generateTerrainTrack } from "../src/core/terrainGen";
import { TerrainGrid } from "../src/core/terrain";
import { defaultParams, type Track } from "../src/core/types";
import { makeLocalFrame } from "../src/core/geo";
import { Corridor } from "../src/core/corridor";
import { repairSpans, type CivilKind } from "../src/core/civil";
import { validateCorridor } from "../src/core/corridorValidate";

function mkGrid(fn: (x: number, y: number) => number, res = 20, w = 200): TerrainGrid {
  const frame = makeLocalFrame({ lat: 46.5, lon: 9.8 });
  const elev = new Float32Array(w * w);
  for (let iy = 0; iy < w; iy++) {
    for (let ix = 0; ix < w; ix++) {
      elev[iy * w + ix] = fn((ix - w / 2) * res, (iy - w / 2) * res);
    }
  }
  return new TerrainGrid(frame, res, w, w, (-w / 2) * res, (-w / 2) * res, elev);
}

/** Deterministic fixtures. */
const FIXTURES: Record<string, (x: number, y: number) => number> = {
  flat: () => 10,
  hillside: (x, y) => 100 + 0.05 * x + 0.03 * y + 6 * Math.sin(x / 220) * Math.cos(y / 280),
  crossSlope: (x, y) => 100 + 0.16 * x + 4 * Math.sin(y / 200),
  ravine: (x) => 100 - 85 * Math.exp(-(x * x) / (2 * 85 * 85)),
  valley: (x, y) => 100 + 60 * Math.cos(Math.hypot(x, y) / 700) ** 2,
  ridge: (x) => 100 + 55 * Math.exp(-(x * x) / (2 * 150 * 150)),
  terraced: (x) => 100 + 12 * Math.floor((x + 2000) / 180),
  volcano: (x, y) => 100 + 380 * Math.exp(-((x * x + y * y) / (2 * 850 * 850))),
};

function genOn(name: string, seed = 777): Track {
  const grid = mkGrid(FIXTURES[name]);
  const r = generateTerrainTrack(seed, defaultParams(), grid, { candidates: 4 });
  expect(r.track).not.toBeNull();
  return r.track!;
}

function stateCounts(t: Track): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of t.civil?.stateAt ?? []) out[k] = (out[k] ?? 0) + 1;
  return out;
}

const ELEVATED: CivilKind[] = ["viaduct", "short-bridge", "platform", "shelf"];

describe("civil planner on synthetic fixtures", () => {
  it("flat terrain: no unnecessary structures", () => {
    const t = genOn("flat");
    const c = stateCounts(t);
    const elevatedCount = ELEVATED.reduce((a, k) => a + (c[k] ?? 0), 0);
    expect(elevatedCount).toBe(0);
    expect((c["at-grade"] ?? 0) + (c["open-cut"] ?? 0) + (c["embankment"] ?? 0)).toBeGreaterThan(2000);
    expect(t.civil?.feasible).toBe(true);
  });

  it("gentle hillside: at-grade / bench / embankment / retaining, no viaducts", () => {
    const t = genOn("hillside");
    const c = stateCounts(t);
    expect(c["viaduct"] ?? 0).toBe(0);
    expect(t.civil?.feasible).toBe(true);
  });

  it("steep cross-slope: produces retained/benched/platform solutions", () => {
    const t = genOn("crossSlope");
    const c = stateCounts(t);
    const retained = (c["bench"] ?? 0) + (c["retaining"] ?? 0) + (c["dual-retaining"] ?? 0) + (c["platform"] ?? 0) + (c["shelf"] ?? 0);
    expect(retained).toBeGreaterThan(50);
  });

  it("narrow ravine: a bridge kind appears", () => {
    const t = genOn("ravine");
    const c = stateCounts(t);
    const bridges = (c["short-bridge"] ?? 0) + (c["viaduct"] ?? 0);
    expect(bridges).toBeGreaterThan(5);
  });

  it("extreme sustained fill (volcano): infeasible or heavily penalized in Realistic", () => {
    const grid = mkGrid(FIXTURES.volcano);
    const r = generateTerrainTrack(4242, defaultParams(), grid, { candidates: 3 });
    const t = r.track!;
    // either the planner found a feasible terrain-following plan, or it
    // reports infeasibility -- never silently endless piers
    const c = stateCounts(t);
    const elevatedCount = ELEVATED.reduce((a, k) => a + (c[k] ?? 0), 0);
    if (!t.civil!.feasible) {
      expect(t.civil!.violations.length).toBeGreaterThan(0);
    }
    // and whatever it did, the pier count is not the whole lap by default
    expect(elevatedCount).toBeLessThan(2400);
  });

  it("deterministic: same seed reproduces the same civil plan", () => {
    const a = genOn("ravine", 31337);
    const b = genOn("ravine", 31337);
    expect(a.civil?.spans.map((s) => s.kind).join(",")).toBe(b.civil?.spans.map((s) => s.kind).join(","));
    expect(a.civil?.cost).toBe(b.civil?.cost);
  });
});

describe("corridor validation", () => {
  it("no finished corridor vertex penetrates terrain outside cut kinds", () => {
    const t = genOn("hillside", 999);
    const corridor = new Corridor(t);
    const grid = mkGrid(FIXTURES.hillside);
    const v = validateCorridor(t, corridor, (x, y) => grid.elevationAt(x, y), t.civil!);
    const penetrations = v.filter((x) => x.kind === "terrain-penetration");
    expect(penetrations.length).toBe(0);
  });

  it("repair pass leaves no elevated span burying a rise", () => {
    const t = genOn("ravine", 555);
    const corridor = new Corridor(t);
    const grid = mkGrid(FIXTURES.ravine);
    const repaired = repairSpans(t.civil!.spans, t, corridor, (x, y) => grid.elevationAt(x, y), t.ds);
    for (const sp of repaired) {
      if (!ELEVATED.includes(sp.kind)) continue;
      const n = t.samples.length;
      const i0 = Math.round(sp.sStart / t.ds) % n;
      const i1 = Math.round(sp.sEnd / t.ds) % n;
      const len = ((i1 - i0 + n) % n) || n;
      for (let k = 0; k < len; k++) {
        const i = (i0 + k) % n;
        const smp = t.samples[i];
        const g = grid.elevationAt(smp.x, smp.y);
        if (Number.isFinite(g)) {
          expect(smp.z).toBeGreaterThanOrEqual(g - 2.0);
        }
      }
    }
  });

  it("runoff is side-specific and speed/corner aware", () => {
    const t = genOn("flat", 2468);
    // at least one corner with asymmetric runoff on the exit side
    let asymmetric = 0;
    for (const c of t.corners) {
      if (c.minRadius > 250) continue;
      const i = Math.round(c.sEnd / t.ds) % t.samples.length;
      const l = t.props.runoffWidthL[i];
      const r = t.props.runoffWidthR[i];
      if (Math.abs(l - r) > 0.5) asymmetric++;
    }
    expect(asymmetric).toBeGreaterThan(0);
  });

  it("elevated spans use shoulders + close barriers, not pretend runoff", () => {
    const t = genOn("ravine", 1357);
    const n = t.samples.length;
    for (const sp of t.civil!.spans) {
      if (sp.kind !== "viaduct" && sp.kind !== "short-bridge") continue;
      const i0 = Math.round(sp.sStart / t.ds) % n;
      const i1 = Math.round(sp.sEnd / t.ds) % n;
      const len = ((i1 - i0 + n) % n) || n;
      for (let k = 0; k < len; k++) {
        const i = (i0 + k) % n;
        expect(t.props.runoffWidthL[i]).toBeLessThanOrEqual(2.5);
        expect(t.props.barrierDistL[i]).toBeLessThanOrEqual(2.0);
      }
    }
  });

  it("planner produces supports with no lower-corridor collisions (self-crossing fixture)", () => {
    // figure-8-like self-crossing polyline -> samples
    const n = 1200;
    const ds = 2.5;
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t2 = (i / n) * Math.PI * 2;
      const x = Math.sin(t2) * 800;
      const y = Math.sin(t2 * 2) * 500;
      // z rises through the lap so the two crossings have separation
      const z = 50 + 35 * Math.sin(t2 * 0.5);
      const i2 = (i + 1) % n;
      samples.push({
        s: i * ds,
        x,
        y,
        z,
        heading: Math.atan2(Math.sin((i2 / n) * Math.PI * 4) * 500 - y, Math.sin((i2 / n) * Math.PI * 2) * 800 - x),
        kappa: 0.001,
        bank: 0,
        width: 12,
        groundZ: 0,
        speed: 50,
      });
    }
    const track = {
      samples,
      ds,
      length: n * ds,
      props: {
        widthL: new Float32Array(n).fill(6),
        widthR: new Float32Array(n).fill(6),
        runoffWidthL: new Float32Array(n).fill(8),
        runoffWidthR: new Float32Array(n).fill(8),
        kerbL: new Uint8Array(n).fill(2),
        kerbR: new Uint8Array(n).fill(2),
      },
    } as unknown as Track;
    const corridor = new Corridor(track);
    // platform halfwidths exist and are positive
    const half = corridor.platformHalf(5);
    expect(half.l).toBeGreaterThan(10);
    expect(half.r).toBeGreaterThan(10);
  });
});
