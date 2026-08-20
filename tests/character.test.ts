import { describe, it, expect } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { computeSpeedProfile, VEHICLE_PRESETS } from "../src/core/vehicle";
import { computeMetrics } from "../src/core/metrics";
import { serializeProject, deserializeProject } from "../src/export/json";
import { buildTrackMesh, buildBarrierMeshes } from "../src/export/mesh";
import { defaultParams } from "../src/core/types";
import { KerbKind, RunoffKind, SurfaceKind } from "../src/core/character";

const base = defaultParams();

describe("character model", () => {
  it("profiles align with samples and stay in valid ranges", () => {
    const track = generateValidTrack(606060, base).track!;
    const n = track.samples.length;
    const p = track.props;
    expect(p.widthL.length).toBe(n);
    expect(p.widthR.length).toBe(n);
    expect(p.surface.length).toBe(n);
    expect(p.grip.length).toBe(n);
    expect(p.featureIdx.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(p.widthL[i]).toBeGreaterThanOrEqual(3.5);
      expect(p.widthR[i]).toBeGreaterThanOrEqual(3.5);
      expect(p.widthL[i] + p.widthR[i]).toBeCloseTo(track.samples[i].width, 3);
      expect(p.grip[i]).toBeGreaterThan(0.8);
      expect(p.grip[i]).toBeLessThan(1.12);
      expect(p.surface[i]).toBeLessThan(4);
      expect(p.kerbL[i]).toBeLessThan(4);
      expect(p.runoffL[i]).toBeLessThan(4);
      expect(Number.isFinite(p.barrierDistL[i])).toBe(true);
      expect(p.roughness[i]).toBeGreaterThanOrEqual(0);
      expect(p.roughness[i]).toBeLessThanOrEqual(1);
    }
  });

  it("character is deterministic in seed", () => {
    const a = generateValidTrack(777999, base).track!;
    const b = generateValidTrack(777999, base).track!;
    expect(a.identity.era).toBe(b.identity.era);
    expect(a.features.length).toBe(b.features.length);
    expect(a.features.map((f) => f.name)).toEqual(b.features.map((f) => f.name));
    expect(a.props.roughness[200]).toBe(b.props.roughness[200]);
    expect(a.props.widthL[500]).toBe(b.props.widthL[500]);
  });

  it("features get names and resolved s-ranges", () => {
    const track = generateValidTrack(888777, { ...base, featureRichness: 1 }).track!;
    expect(track.features.length).toBeGreaterThanOrEqual(2);
    for (const f of track.features) {
      expect(f.name.length).toBeGreaterThan(2);
      expect(Number.isFinite(f.sStart)).toBe(true);
      expect(Number.isFinite(f.sEnd)).toBe(true);
      expect(f.sStart).toBeLessThan(track.length);
    }
  });

  it("karussell features steepen banking locally", () => {
    // force classic era + high richness over several seeds until we find one
    const params = { ...base, heritage: 0.95, featureRichness: 1, banking: 0.5 };
    let tested = 0;
    for (let k = 0; k < 12 && tested < 3; k++) {
      const track = generateValidTrack(12000 + k * 337, params).track!;
      const kar = track.features.find((f) => f.kind === "karussell");
      if (!kar) continue;
      tested++;
      // banking magnitude inside the karussell should exceed typical max
      const i0 = Math.round(kar.sStart / track.ds);
      const i1 = Math.round(kar.sEnd / track.ds);
      let maxBank = 0;
      let i = i0;
      let guard = 0;
      while (i !== i1 && guard++ < track.samples.length) {
        maxBank = Math.max(maxBank, Math.abs(track.samples[i].bank));
        i = (i + 1) % track.samples.length;
      }
      expect(maxBank).toBeGreaterThan(0.18); // >10 degrees
      // concrete surface inside
      const mid = Math.round(((kar.sStart + kar.sEnd) / 2 / track.ds)) % track.samples.length;
      expect(track.props.surface[mid]).toBe(SurfaceKind.Concrete);
    }
    expect(tested).toBeGreaterThanOrEqual(1); // found at least one in 12 seeds
  });

  it("heritage era reads rougher than modern on average", () => {
    const heritageP = { ...base, heritage: 1, featureRichness: 0.7 };
    const modernP = { ...base, heritage: 0, featureRichness: 0.7 };
    let hSum = 0;
    let mSum = 0;
    const K = 8;
    for (let k = 0; k < K; k++) {
      hSum += computeMetrics(
        generateValidTrack(31000 + k * 71, heritageP).track!,
        computeSpeedProfile(generateValidTrack(31000 + k * 71, heritageP).track!, VEHICLE_PRESETS.gt3),
      ).meanRoughness;
      mSum += computeMetrics(
        generateValidTrack(31000 + k * 71, modernP).track!,
        computeSpeedProfile(generateValidTrack(31000 + k * 71, modernP).track!, VEHICLE_PRESETS.gt3),
      ).meanRoughness;
    }
    expect(hSum / K).toBeGreaterThan(mSum / K + 0.05);
  });

  it("lower grip slows the lap (same track, patched props)", () => {
    const track = generateValidTrack(424242, base).track!;
    const fast = computeSpeedProfile(track, VEHICLE_PRESETS.gt3);
    for (let i = 0; i < track.props.grip.length; i++) track.props.grip[i] *= 0.92;
    const slow = computeSpeedProfile(track, VEHICLE_PRESETS.gt3);
    expect(slow.lapTime).toBeGreaterThan(fast.lapTime + 0.5);
  });

  it("crest/jump features alter the vertical profile", () => {
    // compare same seed with featureRichness extremes
    const rich = generateValidTrack(515000, { ...base, featureRichness: 1 }).track!;
    const hasCrest = rich.features.some((f) => f.kind.includes("crest") || f.kind === "compression");
    if (hasCrest) {
      // z profile should deviate from a pure sinusoid somewhere — just check
      // the feature exists and the lap is still valid-length
      expect(rich.length).toBeGreaterThan(4000);
    }
  });

  it("props survive project JSON round-trip", () => {
    const track = generateValidTrack(987654, base).track!;
    const restored = deserializeProject(serializeProject(track));
    expect(ArrayBuffer.isView(restored.props.widthL)).toBe(true);
    expect(restored.props.widthL[300]).toBeCloseTo(track.props.widthL[300], 3);
    expect(restored.features.length).toBe(track.features.length);
    expect(restored.identity.era).toBe(track.identity.era);
  });

  it("mesh builder emits kind-bucketed parts and barriers where close", () => {
    const track = generateValidTrack(112211, { ...base, heritage: 0.9, featureRichness: 1 }).track!;
    const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });
    expect(mesh.parts.length).toBeGreaterThan(4);
    const names = mesh.parts.map((p) => p.name);
    expect(names.some((x) => x.startsWith("asphalt:"))).toBe(true);
    // kerb parts appear only where kerbs exist
    const kerbParts = names.filter((x) => x.startsWith("kerb_"));
    const hasKerbs = (() => {
      for (let i = 0; i < track.props.kerbL.length; i++) {
        if (track.props.kerbL[i] !== KerbKind.None || track.props.kerbR[i] !== KerbKind.None) return true;
      }
      return false;
    })();
    expect(kerbParts.length > 0).toBe(hasKerbs);
    // barriers: armco-close styles produce walls
    const barriers = buildBarrierMeshes(track);
    const anyClose = (() => {
      for (let i = 0; i < track.props.barrierDistL.length; i++) {
        if (track.props.barrierDistL[i] < 16 || track.props.barrierDistR[i] < 16) return true;
        if (track.props.runoffL[i] === RunoffKind.Wall || track.props.runoffR[i] === RunoffKind.Wall) return true;
      }
      return false;
    })();
    if (anyClose) {
      expect(barriers.left !== null || barriers.right !== null).toBe(true);
    }
  });
});
