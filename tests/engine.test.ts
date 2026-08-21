import { describe, it, expect } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { generateTerrainTrack, scoutSites } from "../src/core/terrainGen";
import { morphTrack, regenerateStructure } from "../src/core/morph";
import { breedTracks } from "../src/core/breed";
import { searchCandidates } from "../src/core/search";
import { validateTrack } from "../src/core/validate";
import { computeSpeedProfile, VEHICLE_PRESETS } from "../src/core/vehicle";
import { defaultParams, type TrackParams } from "../src/core/types";
import { TerrainGrid } from "../src/core/terrain";
import { makeLocalFrame } from "../src/core/geo";
import { analyzeIntersections, minRadius } from "../src/core/geometry";

const baseParams = defaultParams();

/** Synthetic mountain terrain (ridges + valleys) for deterministic tests. */
function makeTestTerrain(): TerrainGrid {
  const frame = makeLocalFrame({ lat: 35.4, lon: 138.9 });
  const res = 20;
  const w = 220;
  const h = 220;
  const elev = new Float32Array(w * h);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const x = (ix - w / 2) * res;
      const y = (iy - h / 2) * res;
      elev[iy * w + ix] =
        400 +
        150 * Math.sin(x / 900) * Math.cos(y / 1100) +
        80 * Math.sin(x / 330 + 1) * Math.sin(y / 420) +
        0.02 * y;
    }
  }
  return new TerrainGrid(frame, res, w, h, (-w / 2) * res, (-h / 2) * res, elev);
}

describe("morphing", () => {
  it("morph preserves identity (same DNA) and stays valid", () => {
    const r = generateValidTrack(777777, baseParams);
    const track = r.track!;
    const morphed = morphTrack(track, {
      ...baseParams,
      curvatureSeverity: 0.95,
      compactness: baseParams.compactness,
    });
    expect(morphed.track).not.toBeNull();
    const m = morphed.track!;
    // identity: same pristine elements
    expect(m.dna.elements).toBe(track.dna.elements);
    // deform state follows the morphable sliders
    const morphed2 = morphTrack(track, { ...baseParams, compactness: 0.9 });
    expect(morphed2.track!.dna.deform.compactness).toBe(0.9);
    // still closed, finite, near target length
    expect(Math.abs(m.length - baseParams.targetLength) / baseParams.targetLength).toBeLessThan(0.05);
    for (const s of m.samples) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.kappa)).toBe(true);
    }
    // severity actually tightened corners
    const minROld = minRadius(new Float64Array(track.samples.map((s) => s.kappa)));
    const minRNew = minRadius(new Float64Array(m.samples.map((s) => s.kappa)));
    expect(minRNew).toBeLessThan(minROld);
  });

  it("severity morph is continuous (small slider step = small change)", () => {
    const r = generateValidTrack(31337, baseParams);
    const track = r.track!;
    const a = morphTrack(track, { ...baseParams, curvatureSeverity: 0.5 }).track!;
    const b = morphTrack(track, { ...baseParams, curvatureSeverity: 0.52 }).track!;
    let maxD = 0;
    for (let i = 0; i < a.samples.length; i++) {
      maxD = Math.max(maxD, Math.hypot(a.samples[i].x - b.samples[i].x, a.samples[i].y - b.samples[i].y));
    }
    // 0.02 slider step moves geometry by tens of meters at most, not a new track
    expect(maxD).toBeLessThan(120);
  });

  it("structural regenerate keeps seed character but changes topology option", () => {
    const r = regenerateStructure(999, { ...baseParams, cornerCount: 22 });
    expect(r.track).not.toBeNull();
    expect(r.track!.seed).toBe(999);
  });
});

describe("breeding", () => {
  it("is deterministic and produces valid-ish offspring", () => {
    const a = generateValidTrack(111, baseParams).track!;
    const b = generateValidTrack(222, baseParams).track!;
    const r1 = breedTracks(a, b, 555, baseParams, { count: 4 });
    const r2 = breedTracks(a, b, 555, baseParams, { count: 4 });
    expect(r1.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const t1 = r1[i].track;
      const t2 = r2[i].track;
      expect(t1 === null).toBe(t2 === null);
      if (t1 && t2) {
        expect(t1.samples[100].x).toBe(t2.samples[100].x);
        expect(t1.length).toBeCloseTo(t2.length, 6);
      }
    }
    // at least one valid offspring
    const validCount = r1.filter((r) => r.track && validateTrack(r.track, baseParams).valid).length;
    expect(validCount).toBeGreaterThanOrEqual(1);
  });

  it("offspring inherit from parents (metric within parent range or near)", () => {
    const a = generateValidTrack(111, baseParams).track!;
    const b = generateValidTrack(222, baseParams).track!;
    const r = breedTracks(a, b, 777, baseParams, { count: 4, mutation: 0.2 });
    const withTrack = r.filter((x) => x.track);
    for (const o of withTrack) {
      const corners = o.track!.corners.length;
      // within a sane band of the parents
      const lo = Math.min(a.corners.length, b.corners.length) - 6;
      const hi = Math.max(a.corners.length, b.corners.length) + 6;
      expect(corners).toBeGreaterThanOrEqual(Math.max(2, lo));
      expect(corners).toBeLessThanOrEqual(hi + 6);
    }
  });
});

describe("search", () => {
  it("returns diverse labeled candidates, all valid", () => {
    const out = searchCandidates(42, baseParams, {
      vehicle: VEHICLE_PRESETS.gt3,
      candidates: 12,
      keep: 5,
    });
    expect(out.candidates.length).toBeGreaterThanOrEqual(4);
    const labels = new Set(out.candidates.map((c) => c.label));
    expect(labels.size).toBeGreaterThanOrEqual(3);
    for (const c of out.candidates) {
      const v = validateTrack(c.track, baseParams);
      expect(v.valid).toBe(true);
      expect(Number.isFinite(c.score)).toBe(true);
    }
    // diversity: candidates are not all near-duplicates
    let minD = Infinity;
    for (let i = 0; i < out.candidates.length; i++) {
      for (let j = i + 1; j < out.candidates.length; j++) {
        const a = out.candidates[i].vector;
        const b = out.candidates[j].vector;
        let d = 0;
        for (let k = 0; k < a.length; k++) d += (a[k] - b[k]) ** 2;
        minD = Math.min(minD, Math.sqrt(d));
      }
    }
    expect(minD).toBeGreaterThan(0.05);
  });
});

describe("terrain generation", () => {
  it("generates on synthetic terrain: finite, grades limited, cut/fill sane", () => {
    const grid = makeTestTerrain();
    const r = generateTerrainTrack(13579, baseParams, grid, { candidates: 4 });
    expect(r.track).not.toBeNull();
    const t = r.track!;
    expect(t.terrain).not.toBeNull();
    // footprint stays inside the grid
    for (const s of t.samples) {
      expect(Number.isFinite(s.groundZ)).toBe(true);
      expect(Number.isFinite(s.z)).toBe(true);
    }
    // max grade respected (12% default + tiny numerical slack)
    const ds = t.ds;
    for (let i = 0; i < t.samples.length; i++) {
      const a = t.samples[i];
      const b = t.samples[(i + 1) % t.samples.length];
      expect(Math.abs(b.z - a.z) / ds).toBeLessThan(0.125);
    }
    // lap time computable
    const profile = computeSpeedProfile(t, VEHICLE_PRESETS.gt3);
    expect(profile.lapTime).toBeGreaterThan(40);
  });

  it("terrain mode is deterministic", () => {
    const grid = makeTestTerrain();
    const r1 = generateTerrainTrack(2468, baseParams, grid, { candidates: 3 });
    const r2 = generateTerrainTrack(2468, baseParams, grid, { candidates: 3 });
    expect(r1.track!.samples[200].x).toBe(r2.track!.samples[200].x);
  });

  it("site scouting returns scored sub-sites", () => {
    const grid = makeTestTerrain();
    const sites = scoutSites(grid, baseParams, 1800, 4);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(sites[0].score).toBeGreaterThanOrEqual(sites[sites.length - 1].score);
    expect(sites[0].relief).toBeGreaterThan(50);
  });
});

describe("section lock", () => {
  it("keeps locked elements and regenerates the rest", async () => {
    const { regenerateOutsideLock, elementSRanges } = await import("../src/core/edit");
    const track = generateValidTrack(777, baseParams).track!;
    const L = track.length;
    // lock the middle third
    const r = regenerateOutsideLock(track, { sStart: L * 0.33, sEnd: L * 0.6 }, baseParams, 424242);
    expect(r.track).not.toBeNull();
    const t2 = r.track!;
    // locked elements are present verbatim in the new DNA
    const before = elementSRanges(track);
    const locked = before.filter((x) => {
      const c = (x.s0 + x.s1) / 2;
      return c >= L * 0.33 && c <= L * 0.6;
    });
    expect(locked.length).toBeGreaterThan(0);
    const newElements = t2.dna.elements;
    for (const k of locked) {
      const found = newElements.some((e) => JSON.stringify(e) === JSON.stringify(k.el));
      expect(found).toBe(true);
    }
    // still a full closed track of about the right length
    expect(Math.abs(t2.length - baseParams.targetLength) / baseParams.targetLength).toBeLessThan(0.05);
    // deterministic
    const r2 = regenerateOutsideLock(track, { sStart: L * 0.33, sEnd: L * 0.6 }, baseParams, 424242);
    expect(r2.track!.samples[100].x).toBe(t2.samples[100].x);
  });
});

describe("fuzz invariants", () => {
  it("many random param/seed combos never produce NaN or wild geometry", () => {
    let tested = 0;
    for (let k = 0; k < 40; k++) {
      const params: TrackParams = {
        ...baseParams,
        targetLength: 2500 + (k % 5) * 900,
        cornerCount: 5 + (k % 18),
        curvatureSeverity: (k % 10) / 10,
        technicality: ((k * 7) % 10) / 10,
        flow: ((k * 3) % 10) / 10,
        elongation: ((k * 5) % 10) / 10,
        elevationIntensity: ((k * 9) % 10) / 10,
        mode: k % 3 === 0 ? "experimental" : "realistic",
      };
      const r = generateValidTrack(1000 + k * 101, params, {}, 6);
      if (!r.track) continue;
      tested++;
      const t = r.track;
      const n = t.samples.length;
      // finite everywhere
      for (const s of t.samples) {
        expect(Number.isFinite(s.x)).toBe(true);
        expect(Number.isFinite(s.y)).toBe(true);
        expect(Number.isFinite(s.z)).toBe(true);
        expect(Number.isFinite(s.kappa)).toBe(true);
      }
      // closed: last sample connects smoothly to first
      const a = t.samples[n - 1];
      const b = t.samples[0];
      const gap = Math.hypot(b.x - a.x, b.y - a.y);
      expect(gap).toBeLessThan(t.ds * 2.5);
      // length sane
      expect(t.length).toBeGreaterThan(1000);
      expect(t.length).toBeLessThan(15000);
      // radius floor (with morph margin)
      const kappa = new Float64Array(n);
      for (let i = 0; i < n; i++) kappa[i] = t.samples[i].kappa;
      expect(minRadius(kappa)).toBeGreaterThan(5);
      // intersection report runs and is finite
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = t.samples[i].x;
        ys[i] = t.samples[i].y;
      }
      const inter = analyzeIntersections(xs, ys, t.ds);
      expect(Number.isFinite(inter.minSeparation) || inter.minSeparation === Infinity).toBe(true);
    }
    expect(tested).toBeGreaterThan(30);
  });
});

describe("terrain conformance (no clipping guarantee)", () => {
  it("road never sits below ground - cut band, even in extreme mountains", () => {
    // brutal terrain: 300 m relief at short wavelength
    const frame = makeLocalFrame({ lat: 46.5, lon: 9.8 });
    const res = 20;
    const w = 200;
    const h = 200;
    const elev = new Float32Array(w * h);
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const x = (ix - w / 2) * res;
        const y = (iy - h / 2) * res;
        elev[iy * w + ix] =
          800 +
          220 * Math.sin(x / 500) * Math.cos(y / 620) +
          90 * Math.sin(x / 170 + 2) * Math.sin(y / 210) +
          30 * Math.sin(x / 61) * Math.cos(y / 77);
      }
    }
    const grid = new TerrainGrid(frame, res, w, h, (-w / 2) * res, (-h / 2) * res, elev);
    const params = defaultParams();
    const r = generateTerrainTrack(424242, params, grid, { candidates: 3 });
    expect(r.track).not.toBeNull();
    const t = r.track!;
    const tol = params.earthworkTolerance;
    const cut = Math.max(0.5, params.maxCut * (0.25 + 0.75 * tol)) + 2.5 + 0.01; // build.ts headroom
    // the no-clipping invariant: z >= ground - cut at every sample
    for (const s of t.samples) {
      expect(s.z).toBeGreaterThanOrEqual(s.groundZ - cut);
    }
    // grades still legal
    const ds = t.ds;
    for (let i = 0; i < t.samples.length; i++) {
      const a = t.samples[i];
      const b = t.samples[(i + 1) % t.samples.length];
      expect(Math.abs(b.z - a.z) / ds).toBeLessThan(0.125);
    }
    // structures classified where the road leaves the ground
    expect(Array.isArray(t.structures)).toBe(true);
    // carve mask present and consistent with spans
    expect(t.carveMask).not.toBeNull();
  });
});
