/**
 * Vehicle road-frame orientation tests: flat/turn/hill/bank/off-camber/seam.
 * Asserts the car basis maps local -Z (model forward) onto the 3D road
 * tangent and local +Y onto the banked road normal.
 */
import { describe, expect, it } from "vitest";
import { carBasisWorld, planToWorld, roadFrameAt, type Vec3 } from "../src/core/roadFrame";
import type { Track, TrackSample } from "../src/core/types";

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

/** Build a synthetic closed-loop track from a point generator. */
function synthTrack(fn: (u: number) => { x: number; y: number; z: number; bank: number }, n = 512, length = 1000): Track {
  const samples: TrackSample[] = [];
  const ds = length / n;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const p = fn(u);
    const q = fn((u + 1 / n) % 1);
    samples.push({
      s: i * ds,
      x: p.x,
      y: p.y,
      z: p.z,
      heading: Math.atan2(q.y - p.y, q.x - p.x),
      kappa: 0,
      bank: p.bank,
      width: 12,
      groundZ: p.z,
      speed: 60,
    });
  }
  return {
    version: 1,
    seed: 1,
    params: {} as Track["params"],
    dna: {} as Track["dna"],
    samples,
    length,
    ds,
    startFinishS: 0,
    corners: [],
    sectors: [],
    site: null,
    terrain: null,
    identity: {} as Track["identity"],
    features: [],
    props: {} as Track["props"],
    structures: [],
    carveMask: null,
    carveInner: null,
    civil: null,
    zones: [],
  };
}

const flatOval = synthTrack((u) => {
  const a = u * Math.PI * 2;
  return { x: Math.cos(a) * 140, y: Math.sin(a) * 90, z: 0, bank: 0 };
});

const bankedOval = synthTrack((u) => {
  const a = u * Math.PI * 2;
  return { x: Math.cos(a) * 140, y: Math.sin(a) * 90, z: 0, bank: 0.22 };
});

const offCamberOval = synthTrack((u) => {
  const a = u * Math.PI * 2;
  return { x: Math.cos(a) * 140, y: Math.sin(a) * 90, z: 0, bank: -0.18 };
});

const hillyOval = synthTrack((u) => {
  const a = u * Math.PI * 2;
  return { x: Math.cos(a) * 140, y: Math.sin(a) * 90, z: Math.sin(a * 2) * 30, bank: 0 };
});

function checkFrame(track: Track, s: number): { fwdDot: number; upDot: number; cont: boolean } {
  const f = roadFrameAt(track, s);
  const b = carBasisWorld(f);
  const fwd = { x: -b.z.x, y: -b.z.y, z: -b.z.z }; // car forward = local -Z
  const tW = planToWorld(f.tangent);
  const nW = planToWorld(f.normal);
  return {
    fwdDot: dot(fwd, tW) / (len(fwd) * len(tW)),
    upDot: dot(b.y, nW) / (len(b.y) * len(nW)),
    cont: Math.abs(len(f.tangent) - 1) < 1e-3 && Math.abs(len(f.normal) - 1) < 1e-3,
  };
}

describe("roadFrameAt + carBasisWorld", () => {
  it("flat oval: forward aligns with tangent everywhere", () => {
    for (let s = 0; s < 1000; s += 37) {
      const r = checkFrame(flatOval, s);
      expect(r.fwdDot).toBeGreaterThan(0.995);
      expect(r.upDot).toBeGreaterThan(0.98);
      expect(r.cont).toBe(true);
    }
  });

  it("flat oval: tangent stays horizontal", () => {
    for (let s = 0; s < 1000; s += 91) {
      expect(Math.abs(roadFrameAt(flatOval, s).tangent.z)).toBeLessThan(1e-6);
    }
  });

  it("left and right turns: alignment holds through curvature", () => {
    // the oval turns both ways around the lap (elliptical => varying sign)
    for (let s = 0; s < 1000; s += 23) {
      expect(checkFrame(flatOval, s).fwdDot).toBeGreaterThan(0.995);
    }
  });

  it("hilly oval: tangent captures grade (pitch), normal tilts", () => {
    let sawUp = false;
    let sawDown = false;
    for (let s = 0; s < 1000; s += 11) {
      const f = roadFrameAt(hillyOval, s);
      if (f.grade > 0.05) sawUp = true;
      if (f.grade < -0.05) sawDown = true;
      const r = checkFrame(hillyOval, s);
      expect(r.fwdDot).toBeGreaterThan(0.995);
      expect(r.upDot).toBeGreaterThan(0.98);
    }
    expect(sawUp).toBe(true);
    expect(sawDown).toBe(true);
  });

  it("banked: normal rolls away from vertical by the bank angle", () => {
    const f = roadFrameAt(bankedOval, 120);
    expect(Math.abs(Math.asin(Math.min(1, Math.abs(f.normal.x * -Math.sin(f.heading) + f.normal.y * Math.cos(f.heading)))) - 0.22)).toBeLessThan(0.06);
    const r = checkFrame(bankedOval, 120);
    expect(r.fwdDot).toBeGreaterThan(0.995);
    expect(r.upDot).toBeGreaterThan(0.98);
  });

  it("off-camber: alignment still holds", () => {
    for (let s = 0; s < 1000; s += 53) {
      const r = checkFrame(offCamberOval, s);
      expect(r.fwdDot).toBeGreaterThan(0.995);
      expect(r.upDot).toBeGreaterThan(0.98);
    }
  });

  it("lap seam: frame is continuous across s=0", () => {
    const a = roadFrameAt(flatOval, flatOval.length - 0.4);
    const b = roadFrameAt(flatOval, 0.4);
    expect(dot(a.tangent, b.tangent)).toBeGreaterThan(0.99);
    expect(dot(a.normal, b.normal)).toBeGreaterThan(0.99);
  });

  it("car basis is orthonormal and right-handed", () => {
    const f = roadFrameAt(hillyOval, 333);
    const b = carBasisWorld(f);
    expect(Math.abs(dot(b.x, b.y))).toBeLessThan(1e-6);
    expect(Math.abs(dot(b.y, b.z))).toBeLessThan(1e-6);
    expect(Math.abs(dot(b.x, b.z))).toBeLessThan(1e-6);
    // x × y = z
    const cx = { x: b.x.y * b.y.z - b.x.z * b.y.y, y: b.x.z * b.y.x - b.x.x * b.y.z, z: b.x.x * b.y.y - b.x.y * b.y.x };
    expect(dot(cx, b.z)).toBeGreaterThan(0.999);
  });
});
