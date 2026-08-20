import { describe, it, expect } from "vitest";
import { generateValidTrack } from "../src/core/generator";
import { defaultParams } from "../src/core/types";
import { serializeProject, deserializeProject } from "../src/export/json";
import { trackToSvg } from "../src/export/svg";
import { trackToCsv } from "../src/export/csv";
import { trackToGeoJSON } from "../src/export/geojson";
import { trackToDxf } from "../src/export/dxf";
import { trackToOpenDrive } from "../src/export/opendrive";
import { trackToLandXML } from "../src/export/landxml";
import { trackToObj } from "../src/export/obj";
import { trackToBlenderScript } from "../src/export/blender";
import { makeLocalFrame, geoToLocal, localToGeo } from "../src/core/geo";
import { TerrainGrid } from "../src/core/terrain";

const params = defaultParams();
const track = generateValidTrack(20250911, params).track!;

describe("exports", () => {
  it("project JSON round-trips losslessly", () => {
    const json = serializeProject(track);
    const restored = deserializeProject(json);
    expect(restored.samples.length).toBe(track.samples.length);
    expect(restored.length).toBe(track.length);
    expect(restored.seed).toBe(track.seed);
    expect(restored.samples[500]).toEqual(track.samples[500]);
    expect(restored.dna).toEqual(track.dna);
    expect(restored.params).toEqual(track.params);
  });

  it("SVG is well-formed-ish and contains geometry", () => {
    const svg = trackToSvg(track);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("polyline");
    expect(svg).toContain("T1"); // corner label
    expect(svg.match(/<\/g>/g)?.length ?? 0).toBeGreaterThan(2);
  });

  it("CSV has header + one row per sample and parseable numbers", () => {
    const csv = trackToCsv(track);
    const lines = csv.split("\n");
    expect(lines.length).toBe(track.samples.length + 1);
    expect(lines[0]).toContain("curvature");
    const cols = lines[1].split(",");
    expect(Number(cols[1])).toBeCloseTo(track.samples[0].x, 2);
    expect(Number(cols[2])).toBeCloseTo(track.samples[0].y, 2);
  });

  it("GeoJSON is valid JSON with centerline feature", () => {
    const gj = JSON.parse(trackToGeoJSON(track));
    expect(gj.type).toBe("FeatureCollection");
    const centerline = gj.features.find((f: { properties: { kind: string } }) => f.properties.kind === "centerline");
    expect(centerline).toBeDefined();
    expect(centerline.geometry.coordinates.length).toBe(track.samples.length);
  });

  it("DXF has layers, entities and EOF", () => {
    const dxf = trackToDxf(track);
    expect(dxf).toContain("TRACK_CENTERLINE");
    expect(dxf).toContain("TRACK_LEFT_EDGE");
    expect(dxf).toContain("VERTEX");
    expect(dxf.trim().endsWith("EOF")).toBe(true);
    expect(dxf).toContain("AC1015");
  });

  it("OpenDRIVE is consistent XML with planView + elevation", () => {
    const xodr = trackToOpenDrive(track);
    expect(xodr).toContain("<OpenDRIVE>");
    expect(xodr).toContain("</OpenDRIVE>");
    expect(xodr).toContain("<planView>");
    expect(xodr).toContain("<elevationProfile>");
    expect(xodr).toContain("<laneSection");
    // balanced tags for key elements
    expect((xodr.match(/<geometry /g) ?? []).length).toBeGreaterThan(1000);
    expect((xodr.match(/<\/geometry>/g) ?? []).length).toBe(
      (xodr.match(/<geometry /g) ?? []).length,
    );
  });

  it("LandXML has alignment, profile, units", () => {
    const xml = trackToLandXML(track);
    expect(xml).toContain("<LandXML");
    expect(xml).toContain("</LandXML>");
    expect(xml).toContain("<Alignment");
    expect(xml).toContain("<CoordGeom>");
    expect(xml).toContain("<ProfAlign");
    expect(xml).toContain("<Metric");
  });

  it("OBJ has vertices and faces for all parts", () => {
    const obj = trackToObj(track);
    expect(obj).toContain("o asphalt");
    expect(obj).toContain("o curb_left");
    const vCount = (obj.match(/^v /gm) ?? []).length;
    const fCount = (obj.match(/^f /gm) ?? []).length;
    expect(vCount).toBeGreaterThan(1000);
    expect(fCount).toBeGreaterThan(1000);
  });

  it("Blender script embeds data and is plausible python", () => {
    const py = trackToBlenderScript(track);
    expect(py).toContain("import bpy");
    expect(py).toContain("DATA = json.loads");
    expect(py).toContain("build_strip");
    expect(py.length).toBeGreaterThan(2000);
  });
});

describe("geo", () => {
  it("local<->geo round-trips", () => {
    const frame = makeLocalFrame({ lat: 35.37, lon: 138.93 }); // Fuji-ish
    const p = geoToLocal(frame, { lat: 35.38, lon: 138.94 });
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(500);
    const back = localToGeo(frame, p.x, p.y);
    expect(back.lat).toBeCloseTo(35.38, 8);
    expect(back.lon).toBeCloseTo(138.94, 8);
  });

  it("1 degree latitude is ~111km", () => {
    const frame = makeLocalFrame({ lat: 35.37, lon: 138.93 });
    const p = geoToLocal(frame, { lat: 36.37, lon: 138.93 });
    expect(p.y).toBeGreaterThan(110000);
    expect(p.y).toBeLessThan(112500);
  });
});

describe("terrain grid", () => {
  it("bilinear interpolation is exact at nodes and smooth between", () => {
    const frame = makeLocalFrame({ lat: 36, lon: 138 });
    const elev = new Float32Array([0, 10, 20, 30]); // 2x2
    const grid = new TerrainGrid(frame, 10, 2, 2, 0, 0, elev);
    expect(grid.elevationAt(0, 0)).toBeCloseTo(0, 3);
    expect(grid.elevationAt(10, 0)).toBeCloseTo(10, 3);
    expect(grid.elevationAt(5, 0)).toBeCloseTo(5, 3);
    expect(grid.elevationAt(5, 5)).toBeCloseTo(15, 3);
    expect(Number.isNaN(grid.elevationAt(-50, 0))).toBe(true);
  });

  it("slope is computed", () => {
    const frame = makeLocalFrame({ lat: 36, lon: 138 });
    const elev = new Float32Array(9);
    for (let i = 0; i < 9; i++) elev[i] = (i % 3) * 10; // x-gradient 1.0
    const grid = new TerrainGrid(frame, 10, 3, 3, 0, 0, elev);
    expect(grid.slopeAt(10, 10)).toBeCloseTo(1, 1);
  });
});
