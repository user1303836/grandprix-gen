import { describe, it, expect } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { computeSpeedProfile, VEHICLE_PRESETS } from "../src/core/vehicle";
import { computeMetrics, scoreAgainstRequest } from "../src/core/metrics";
import { defaultParams } from "../src/core/types";

describe("vehicle model", () => {
  it("computes a sane speed profile", () => {
    const r = generateValidTrack(999, defaultParams());
    const track = r.track!;
    const profile = computeSpeedProfile(track, VEHICLE_PRESETS.gt3);
    expect(Number.isFinite(profile.lapTime)).toBe(true);
    expect(profile.lapTime).toBeGreaterThan(30);
    expect(profile.lapTime).toBeLessThan(400);
    expect(profile.vMax).toBeGreaterThan(profile.vMin);
    expect(profile.vMax).toBeLessThanOrEqual(VEHICLE_PRESETS.gt3.vTop + 1);
    // speeds never negative or NaN
    for (const v of profile.v) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("different presets produce different laps (formula faster than road)", () => {
    const r = generateValidTrack(4242, defaultParams());
    const track = r.track!;
    const f1 = computeSpeedProfile(track, VEHICLE_PRESETS.formula);
    const road = computeSpeedProfile(track, VEHICLE_PRESETS.road);
    expect(f1.lapTime).toBeLessThan(road.lapTime);
  });

  it("apex speeds respect curvature (tight corner slower)", () => {
    const r = generateValidTrack(7777, defaultParams());
    const track = r.track!;
    const profile = computeSpeedProfile(track, VEHICLE_PRESETS.gt3);
    const corners = track.corners;
    if (corners.length >= 2) {
      const apexSpeeds = corners.map(
        (c) => profile.v[Math.round(c.sApex / track.ds) % track.samples.length],
      );
      const tightest = corners.reduce((a, b) => (a.minRadius < b.minRadius ? a : b));
      const tightIdx = corners.indexOf(tightest);
      expect(apexSpeeds[tightIdx]).toBeLessThan(profile.vMax);
    }
  });
});

describe("metrics", () => {
  it("computes finite metrics in range", () => {
    const r = generateValidTrack(5150, defaultParams());
    const track = r.track!;
    const profile = computeSpeedProfile(track, VEHICLE_PRESETS.gt3);
    const m = computeMetrics(track, profile);
    console.log(
      `lap=${m.lapTime.toFixed(1)}s avg=${m.avgSpeedKmh.toFixed(0)}km/h flow=${m.flow.toFixed(0)} ` +
        `tech=${m.technicality.toFixed(0)} overtake=${m.overtakingPotential.toFixed(0)} ` +
        `braking=${m.brakingZoneCount} full-throttle=${m.fullThrottlePct.toFixed(0)}%`,
    );
    for (const k of [
      "flow",
      "technicality",
      "cornerDiversity",
      "speedDiversity",
      "rhythmicComplexity",
      "overtakingPotential",
      "elevationInterest",
      "directionBalance",
    ] as const) {
      expect(m[k]).toBeGreaterThanOrEqual(0);
      expect(m[k]).toBeLessThanOrEqual(100);
    }
    const score = scoreAgainstRequest(m, defaultParams());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("technical request scores technical tracks higher", () => {
    const techParams = { ...defaultParams(), technicality: 0.9, hairpinFreq: 0.7, cornerCount: 20 };
    const flowParams = { ...defaultParams(), technicality: 0.1, flow: 0.9, cornerCount: 8, hairpinFreq: 0 };
    const rt = generateValidTrack(31415, techParams);
    const rf = generateValidTrack(31415, flowParams);
    const mt = computeMetrics(rt.track!, computeSpeedProfile(rt.track!, VEHICLE_PRESETS.gt3));
    const mf = computeMetrics(rf.track!, computeSpeedProfile(rf.track!, VEHICLE_PRESETS.gt3));
    console.log(`technical track tech=${mt.technicality.toFixed(0)} vs flowing track tech=${mf.technicality.toFixed(0)}`);
    expect(mt.technicality).toBeGreaterThan(mf.technicality);
  });
});
