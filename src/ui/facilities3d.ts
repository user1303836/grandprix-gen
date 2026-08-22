/**
 * Three.js rendering of the canonical FacilityPlan. Meshes consume the
 * plan; the plan is the source of truth. Instanced/batched where repeated.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Uint32BufferAttribute,
} from "three";
import type { Track } from "../core/types";
import type { FacilityPlan, PitLanePlan } from "../core/facilities/types";

/** Band colors for the painted pit-lane canvas. */
const BAND_COLORS: Record<string, string> = {
  verge: "#3d4a33",
  "pit-wall": "#9aa0a6",
  "fast-lane": "#2e3238",
  "working-lane": "#33373d",
  "box-apron": "#3a3e44",
  "garage-apron": "#45484e",
};

/** Paint the whole pit lane (bands + all markings) onto a strip canvas. */
function paintPitLaneTexture(plan: PitLanePlan): { tex: CanvasTexture; widthM: number; lengthM: number } {
  const lengthM = plan.centerline[plan.centerline.length - 1]?.s ?? 1;
  const oIn = plan.laneBands[0]?.offsetInner ?? 0;
  const oOut = plan.laneBands[plan.laneBands.length - 1]?.offsetOuter ?? 20;
  const widthM = oOut - oIn;
  const PXW = 128;
  const PXM = 0.5; // canvas px per meter along the lane
  const cv = document.createElement("canvas");
  cv.width = PXW;
  cv.height = Math.max(64, Math.round(lengthM * PXM));
  const ctx = cv.getContext("2d")!;
  const xOf = (off: number) => ((off - oIn) / widthM) * PXW;
  const yOf = (s: number) => cv.height - s * PXM;
  // bands
  for (const b of plan.laneBands) {
    ctx.fillStyle = BAND_COLORS[b.kind] ?? "#333";
    ctx.fillRect(xOf(b.offsetInner), 0, xOf(b.offsetOuter) - xOf(b.offsetInner), cv.height);
  }
  // asphalt noise
  ctx.globalAlpha = 0.05;
  for (let k = 0; k < 900; k++) {
    ctx.fillStyle = Math.random() > 0.5 ? "#fff" : "#000";
    ctx.fillRect(Math.random() * PXW, Math.random() * cv.height, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
  const fast = plan.laneBands.find((b) => b.kind === "fast-lane")!;
  const working = plan.laneBands.find((b) => b.kind === "working-lane")!;
  const box = plan.laneBands.find((b) => b.kind === "box-apron")!;
  // entry/exit white edge lines at the outer fast-lane edge
  ctx.fillStyle = "#e8eaec";
  const edgeX = xOf(fast.offsetInner) ;
  for (const m of plan.markings) {
    if (m.kind === "pit-entry-line" || m.kind === "pit-exit-line") {
      ctx.fillRect(edgeX - 1, yOf(m.s + m.length), 2, m.length * PXM);
    }
  }
  // speed-limit + release lines across the lane
  for (const m of plan.markings) {
    if (m.kind === "speed-limit-line" || m.kind === "release-line") {
      ctx.fillStyle = m.kind === "speed-limit-line" ? "#f2f4f6" : "#e8b23a";
      ctx.fillRect(xOf(fast.offsetInner), yOf(m.s) - 2, xOf(box.offsetOuter) - xOf(fast.offsetInner), 3);
      ctx.fillStyle = "#e8eaec";
    }
  }
  // fast-lane separation (dashed white)
  const sepX = xOf(working.offsetInner);
  ctx.fillStyle = "#e8eaec";
  for (let s = plan.phases.workingS[0]; s < plan.phases.workingS[1]; s += 8) {
    ctx.fillRect(sepX, yOf(s + 4.5), 1.6, 4.5 * PXM * 2);
  }
  // pit boxes: white outlines + numbers
  ctx.strokeStyle = "#f2f4f6";
  ctx.lineWidth = 2;
  ctx.fillStyle = "#f2f4f6";
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const b of plan.pitBoxes) {
    const yTop = yOf(b.s + b.length / 2);
    const yBot = yOf(b.s - b.length / 2);
    const x0 = xOf(box.offsetInner + 0.3);
    const x1 = xOf(box.offsetOuter - 0.3);
    ctx.strokeRect(x0, yTop, x1 - x0, yBot - yTop);
    ctx.save();
    ctx.translate((x0 + x1) / 2, (yTop + yBot) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(String(b.index), 0, 0);
    ctx.restore();
  }
  // arrows in the entry zone (simple triangles)
  ctx.fillStyle = "#dfe3e6";
  for (const m of plan.markings) {
    if (m.kind !== "arrow") continue;
    const y = yOf(m.s);
    const xc = (xOf(fast.offsetInner) + xOf(working.offsetOuter)) / 2;
    ctx.beginPath();
    ctx.moveTo(xc, y - 7);
    ctx.lineTo(xc - 4, y + 3);
    ctx.lineTo(xc + 4, y + 3);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  return { tex, widthM, lengthM };
}

/** Pit-lane ribbon mesh from the plan centerline. */
function pitLaneMesh(plan: PitLanePlan): Mesh {
  const { tex, widthM } = paintPitLaneTexture(plan);
  const n = plan.centerline.length;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const indices: number[] = [];
  const lengthM = plan.centerline[n - 1].s;
  for (let i = 0; i < n; i++) {
    const c = plan.centerline[i];
    const nx = -Math.sin(c.heading);
    const ny = Math.cos(c.heading);
    // path runs mid-lane; lane extends ±widthM/2 around it
    const half = widthM / 2;
    positions[i * 6] = c.x - nx * half;
    positions[i * 6 + 1] = c.y - ny * half;
    positions[i * 6 + 2] = c.z;
    positions[i * 6 + 3] = c.x + nx * half;
    positions[i * 6 + 4] = c.y + ny * half;
    positions[i * 6 + 5] = c.z;
    uvs[i * 4] = 0;
    uvs[i * 4 + 1] = c.s / lengthM;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = c.s / lengthM;
    if (i < n - 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0, side: DoubleSide });
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  return mesh;
}

/** Pit wall segments (between openings) + signalling station boards. */
function pitWallGroup(plan: PitLanePlan): Group {
  const g = new Group();
  const wallBand = plan.laneBands.find((b) => b.kind === "pit-wall")!;
  const fast = plan.laneBands.find((b) => b.kind === "fast-lane")!;
  const working = plan.laneBands.find((b) => b.kind === "working-lane")!;
  const pathOffset = (fast.offsetInner + working.offsetOuter) / 2;
  const oMid = (wallBand.offsetInner + wallBand.offsetOuter) / 2;
  // lateral distance from the pit path to the wall centerline, measured in
  // band-offset space (positive = toward the pit side)
  const offFromPath = oMid - pathOffset;
  const sideSign = plan.side === "left" ? 1 : -1;
  // wall segments between openings
  const gaps = [...plan.pitWall.openings].sort((a, b) => a.s - b.s);
  const spans: [number, number][] = [];
  let cur = plan.pitWall.sStart;
  for (const gap of gaps) {
    if (gap.s > cur) spans.push([cur, gap.s]);
    cur = Math.max(cur, gap.s + gap.length);
  }
  if (cur < plan.pitWall.sEnd) spans.push([cur, plan.pitWall.sEnd]);
  const sampleAtS = (s: number) => {
    const cl = plan.centerline;
    let lo = 0;
    let hi = cl.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cl[mid].s < s) lo = mid + 1;
      else hi = mid;
    }
    return cl[Math.min(cl.length - 1, lo)];
  };
  const mat = new MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.7 });
  for (const [a, b] of spans) {
    const steps = Math.max(1, Math.round((b - a) / 6));
    for (let k = 0; k < steps; k++) {
      const s0 = a + ((b - a) * k) / steps;
      const s1 = a + ((b - a) * (k + 1)) / steps;
      const p0 = sampleAtS(s0);
      const p1 = sampleAtS(s1);
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      const mz = (p0.z + p1.z) / 2;
      const nx0 = -Math.sin(p0.heading);
      const ny0 = Math.cos(p0.heading);
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + 0.15;
      const seg = new Mesh(new BoxGeometry(0.35, 1.1, len), mat);
      // band-offset space grows toward the pit side: lateral = off*sideSign
      const lat = offFromPath * sideSign;
      seg.position.set(mx + nx0 * lat, mz + 0.55, -(my + ny0 * lat));
      seg.quaternion.copy(basisForWall(p0.heading));
      seg.castShadow = true;
      g.add(seg);
    }
  }
  return g;
}

/** Build every facility mesh for the current plan. */
export function buildFacilityMeshes(plan: FacilityPlan, track: Track, ground: import("../core/facilities/types").GroundSurface | null = null): Group {
  const group = new Group();
  group.name = "facilities";
  if (plan.pitLane) {
    group.add(pitLaneMesh(plan.pitLane));
    group.add(pitWallGroup(plan.pitLane));
  }
  if (plan.pitComplex) {
    group.add(pitComplexMeshes(plan.pitComplex, track, { sStart: plan.site.sStart, side: plan.site.side }));
  }
  if (plan.foundations.length > 0) {
    group.add(foundationMeshes(plan, ground));
  }
  if (plan.grandstands.length > 0) {
    group.add(grandstandMeshes(plan.grandstands));
  }
  if (plan.lighting.anchors.length > 0) {
    group.add(facilityLampMeshes(plan.lighting));
  }
  for (const sc of plan.screens) {
    group.add(screenTowerMesh(track, sc.x, sc.y, sc.z, sc.heading, sc.title));
  }
  return group;
}

export { Float32BufferAttribute, Uint32BufferAttribute };

// ============================================================ pit complex

import {
  CylinderGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShapeGeometry,
  Vector3,
} from "three";
import type { BuildingVolumePlan, PitComplexPlan } from "../core/facilities/types";

const WALL_MAT = new MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.75 });
const ROOF_MAT = new MeshStandardMaterial({ color: 0x8d939b, roughness: 0.55, metalness: 0.15 });
const GLAZE_MAT = new MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.18, metalness: 0.65 });
const CONCRETE_MAT = new MeshStandardMaterial({ color: 0xb6b2a8, roughness: 0.9 });
const CANVAS_MAT = new MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.85, side: DoubleSide });

/**
 * Orientation bases in world space — no Euler guessing.
 * Plan heading h: world tangent tW=(cos h,0,-sin h), plan-left nW=(-sin h,0,-cos h).
 */
function basisForBuilding(heading: number, sideSign: number): Quaternion {
  // building local axes: +X = along the straight (u), +Z = away from track (v)
  const tx = Math.cos(heading);
  const tz = -Math.sin(heading);
  const nx = -Math.sin(heading);
  const nz = -Math.cos(heading);
  const x = new Vector3(-sideSign * tx, 0, -sideSign * tz);
  const y = new Vector3(0, 1, 0);
  const z = new Vector3(sideSign * nx, 0, sideSign * nz);
  const m = new Matrix4().makeBasis(x, y, z);
  return new Quaternion().setFromRotationMatrix(m);
}

function basisForWall(heading: number): Quaternion {
  // wall local axes: +Z along travel, +X across (plan-left)
  const tx = Math.cos(heading);
  const tz = -Math.sin(heading);
  const nx = -Math.sin(heading);
  const nz = -Math.cos(heading);
  const m = new Matrix4().makeBasis(new Vector3(nx, 0, nz), new Vector3(0, 1, 0), new Vector3(tx, 0, tz));
  return new Quaternion().setFromRotationMatrix(m);
}

/** One building volume: stacked floors with facade treatments + roof. */
function volumeMesh(v: BuildingVolumePlan, sideSign: number): Group {
  const g = new Group();
  const totalH = v.floors * v.floorHeight;
  const bodyMat = v.kind === "tower" || v.kind === "race-control" ? CONCRETE_MAT : WALL_MAT;
  const body = new Mesh(new BoxGeometry(v.widthU, totalH, v.depthV), bodyMat);
  body.position.y = totalH / 2;
  body.castShadow = true;
  g.add(body);
  // facade bands per floor on the TRACK-FACING side (local -z)
  for (let f = 0; f < v.floors; f++) {
    const kind = v.facade[f] ?? "solid";
    const y = f * v.floorHeight;
    if (kind === "glazed") {
      const gl = new Mesh(new BoxGeometry(v.widthU * 0.94, v.floorHeight * 0.62, 0.18), GLAZE_MAT);
      gl.position.set(0, y + v.floorHeight * 0.52, -v.depthV / 2 - 0.1);
      g.add(gl);
    } else if (kind === "balcony") {
      const slab = new Mesh(new BoxGeometry(v.widthU * 0.96, 0.16, 1.6), CONCRETE_MAT);
      slab.position.set(0, y + v.floorHeight * 0.12, -v.depthV / 2 - 0.8);
      g.add(slab);
      const rail = new Mesh(new BoxGeometry(v.widthU * 0.96, 0.9, 0.08), GLAZE_MAT);
      rail.position.set(0, y + v.floorHeight * 0.55, -v.depthV / 2 - 1.55);
      g.add(rail);
    }
  }
  // roof by kind
  if (v.roof === "flat" || v.roof === "none") {
    const slab = new Mesh(new BoxGeometry(v.widthU + 0.5, 0.3, v.depthV + 0.5), ROOF_MAT);
    slab.position.y = totalH + 0.15;
    g.add(slab);
  } else if (v.roof === "shallow-pitch") {
    const slab = new Mesh(new BoxGeometry(v.widthU + 0.6, 0.24, v.depthV * 0.62), ROOF_MAT);
    slab.position.set(0, totalH + 0.55, -v.depthV * 0.19);
    slab.rotation.x = 0.16;
    g.add(slab);
    const slab2 = slab.clone();
    slab2.position.z = v.depthV * 0.19;
    slab2.rotation.x = -0.16;
    g.add(slab2);
  } else if (v.roof === "cantilever") {
    const slab = new Mesh(new BoxGeometry(v.widthU + 1.2, 0.28, v.depthV + 5.5), ROOF_MAT);
    slab.position.set(0, totalH + 0.35, -2.2);
    g.add(slab);
  } else if (v.roof === "tensile-canopy" || v.roof === "fabric") {
    // scalloped membrane: series of arched thin boxes
    const n = Math.max(3, Math.round(v.widthU / 14));
    for (let k = 0; k < n; k++) {
      const w = v.widthU / n;
      const mem = new Mesh(new CylinderGeometry(w * 0.62, w * 0.62, 0.16, 10, 1, false, 0, Math.PI), CANVAS_MAT);
      mem.rotation.z = Math.PI / 2;
      mem.rotation.y = Math.PI / 2;
      mem.position.set(-v.widthU / 2 + (k + 0.5) * w, totalH + 0.4, -0.6);
      mem.scale.set(1, 1, v.depthV + 4 / (w * 0.62));
      g.add(mem);
    }
  } else if (v.roof === "wave") {
    const slab1 = new Mesh(new BoxGeometry(v.widthU * 0.55, 0.3, v.depthV + 3), ROOF_MAT);
    slab1.position.set(-v.widthU * 0.2, totalH + 0.8, -1);
    slab1.rotation.z = 0.06;
    g.add(slab1);
    const slab2 = new Mesh(new BoxGeometry(v.widthU * 0.55, 0.3, v.depthV + 3), ROOF_MAT);
    slab2.position.set(v.widthU * 0.22, totalH + 1.5, -0.5);
    slab2.rotation.z = -0.07;
    g.add(slab2);
  }
  g.position.set(v.cx, v.baseZ, -v.cy);
  g.quaternion.copy(basisForBuilding(v.angleU, sideSign));
  return g;
}

/** Garage doors on the building front, one per bay. */
function garageDoorGroup(complex: PitComplexPlan): Group {
  const g = new Group();
  const numTexCache = new Map<string, CanvasTexture>();
  const numberTex = (n: number): CanvasTexture => {
    const key = String(n);
    let t = numTexCache.get(key);
    if (!t) {
      const cv = document.createElement("canvas");
      cv.width = 64;
      cv.height = 48;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#181c20";
      ctx.fillRect(0, 0, 64, 48);
      ctx.fillStyle = "#f2f4f6";
      ctx.font = "bold 30px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n), 32, 26);
      t = new CanvasTexture(cv);
      t.colorSpace = SRGBColorSpace;
      numTexCache.set(key, t);
    }
    return t;
  };
  for (const bay of complex.garageBays) {
    const door = new Mesh(
      new BoxGeometry(bay.width, 3.1, 0.14),
      new MeshStandardMaterial({ color: bay.doorColor, roughness: 0.5, metalness: 0.3 }),
    );
    door.position.set(bay.x, bay.z + 1.55, -bay.y);
    door.quaternion.copy(basisForBuilding(bay.heading, bay.sideSign));
    g.add(door);
    // lintel number board above the door
    const board = new Mesh(
      new PlaneGeometry(1.6, 1.1),
      new MeshStandardMaterial({ map: numberTex(bay.number), roughness: 0.6 }),
    );
    board.position.set(bay.x, bay.z + 3.6, -bay.y);
    board.quaternion.copy(basisForBuilding(bay.heading, bay.sideSign));
    // face outward (toward the lane): the door plane's -z side after rotation
    board.translateZ(-0.12);
    g.add(board);
    if (bay.doorOpen) {
      // dark open doorway behind the (raised) door
      const open = new Mesh(new BoxGeometry(bay.width, 3.0, 0.1), new MeshStandardMaterial({ color: 0x0c0e10, roughness: 1 }));
      open.position.set(bay.x, bay.z + 1.5, -bay.y);
      open.quaternion.copy(basisForBuilding(bay.heading, bay.sideSign));
      open.translateZ(0.1);
      g.add(open);
      door.position.y = bay.z + 3.0;
      door.rotation.x = -0.5;
    }
  }
  return g;
}

/** Apron canopy slab + columns toward the lane. */
function canopyGroup(complex: PitComplexPlan, track: Track, siteS: { sStart: number; side: "left" | "right" }): Group {
  const g = new Group();
  const c = complex.canopy;
  if (!c) return g;
  const sign = siteS.side === "left" ? 1 : -1;
  const uMid = (c.uStart + c.uEnd) / 2;
  // sample the frame at the canopy mid-u
  const { sampleAt } = { sampleAt: (tr: Track, s: number) => tr.samples[Math.round((((s % tr.length) + tr.length) % tr.length) / tr.ds) % tr.samples.length] };
  const p = sampleAt(track, siteS.sStart + uMid);
  const nx = -Math.sin(p.heading) * sign;
  const ny = Math.cos(p.heading) * sign;
  const cx = p.x + nx * (c.vFront + c.vBack) / 2;
  const cy = p.y + ny * (c.vFront + c.vBack) / 2;
  const z = p.z + 4.6;
  const slab = new Mesh(new BoxGeometry(c.uEnd - c.uStart, 0.22, c.vBack - c.vFront), ROOF_MAT);
  slab.position.set(cx, z, -cy);
  slab.quaternion.copy(basisForBuilding(p.heading, sign));
  slab.castShadow = true;
  g.add(slab);
  // columns at the front edge
  const n = c.columns;
  for (let k = 0; k < n; k++) {
    const u = c.uStart + ((c.uEnd - c.uStart) * (k + 0.5)) / n;
    const pu = track.samples[Math.round(((siteS.sStart + u) % track.length) / track.ds) % track.samples.length];
    const col = new Mesh(new CylinderGeometry(0.14, 0.14, 4.6, 8), CONCRETE_MAT);
    col.position.set(pu.x + (-Math.sin(pu.heading) * sign) * c.vFront, pu.z + 2.3, -(pu.y + Math.cos(pu.heading) * sign * c.vFront));
    g.add(col);
  }
  return g;
}

/** Flat polygon mesh (earcut via ShapeGeometry) at height z, plan coords. */
function flatPolygonMesh(polygon: { x: number; y: number }[], z: number, mat: MeshStandardMaterial): Mesh | null {
  if (polygon.length < 3) return null;
  const shape = new Shape();
  shape.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) shape.lineTo(polygon[i].x, polygon[i].y);
  shape.closePath();
  const geo = new ShapeGeometry(shape);
  // ShapeGeometry is in XY; plan (x, y) -> world (x, z, -y)
  geo.rotateX(-Math.PI / 2);
  geo.scale(1, 1, -1);
  geo.translate(0, z, 0);
  geo.computeVertexNormals();
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** Paddock apron surface polygon. */
function paddockMesh(complex: PitComplexPlan): Mesh | null {
  const pad = complex.paddockApron;
  if (!pad) return null;
  return flatPolygonMesh(
    pad.polygon,
    pad.z + 0.03,
    new MeshStandardMaterial({ color: pad.surface === "gravel" ? 0x8a8578 : 0x3c4046, roughness: 1, side: DoubleSide }),
  );
}

/** Pit-complex meshes (buildings, doors, canopy, paddock). */
export function pitComplexMeshes(complex: PitComplexPlan, track: Track, site: { sStart: number; side: "left" | "right" }): Group {
  const g = new Group();
  g.name = "pit-complex";
  const sideSign = site.side === "left" ? 1 : -1;
  for (const v of complex.volumes) g.add(volumeMesh(v, sideSign));
  g.add(garageDoorGroup(complex));
  g.add(canopyGroup(complex, track, site));
  const pad = paddockMesh(complex);
  if (pad) g.add(pad);
  return g;
}

// ============================================================ foundations

import type { FoundationPlan, GroundSurface } from "../core/facilities/types";

const PLINTH_MAT = new MeshStandardMaterial({ color: 0xa8a49a, roughness: 0.95 });

/** Visible foundation: pad slab + perimeter skirt down to the ground. */
function foundationMesh(f: FoundationPlan, ground: GroundSurface | null): Group {
  const g = new Group();
  const datum = f.datumZ[0];
  const n = f.footprint.length;
  // top pad (earcut-triangulated; footprints may be concave)
  const pad = flatPolygonMesh(f.footprint, datum, new MeshStandardMaterial({ color: 0x9b978d, roughness: 1, side: DoubleSide }));
  if (pad) g.add(pad);
  // skirt walls along each edge, from datum down to ground (stepped)
  for (let i = 0; i < n; i++) {
    const a = f.footprint[i];
    const b = f.footprint[(i + 1) % n];
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const x0 = a.x + (b.x - a.x) * t0;
      const y0 = a.y + (b.y - a.y) * t0;
      const x1 = a.x + (b.x - a.x) * t1;
      const y1 = a.y + (b.y - a.y) * t1;
      const gm = ground?.elevationAt((x0 + x1) / 2, (y0 + y1) / 2);
      const bottom = (gm ?? datum) - 0.4;
      const h = datum - bottom;
      if (h < 0.15) continue;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const wall = new Mesh(new BoxGeometry(len + 0.1, h, 0.5), PLINTH_MAT);
      wall.position.set((x0 + x1) / 2, bottom + h / 2, -(y0 + y1) / 2);
      wall.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      wall.castShadow = true;
      g.add(wall);
    }
  }
  // column-deck: visible columns at the support points
  if (f.kind === "column-deck" || f.kind === "piles") {
    for (const s of f.supports) {
      const gm = ground?.elevationAt(s.x, s.y);
      const h = gm === null || gm === undefined ? 0 : Math.max(0, s.topZ - gm);
      if (h < 1) continue;
      const col = new Mesh(new CylinderGeometry(0.35, 0.42, h, 8), PLINTH_MAT);
      col.position.set(s.x, (gm ?? s.topZ) + h / 2, -s.y);
      g.add(col);
    }
  }
  return g;
}

/** All foundation meshes for the plan. */
export function foundationMeshes(plan: import("../core/facilities/types").FacilityPlan, ground: GroundSurface | null): Group {
  const g = new Group();
  g.name = "facility-foundations";
  for (const f of plan.foundations) g.add(foundationMesh(f, ground));
  return g;
}

// ============================================================ grandstands

import type { GrandstandPlan } from "../core/facilities/types";

const SEAT_FRAME = new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.8, metalness: 0.2 });
const SEAT_COLORS = [0x2a5a9e, 0xc83a2a, 0x3a9a5a, 0xe8b23a, 0xe8e8e8];

/**
 * One grandstand. Local frame per the orientation contract:
 *   local +X = longDir (along rows), local +Z = -frontDir (rows rise away
 *   from the track). Rows step up as they recede.
 */
function grandstandMesh(st: GrandstandPlan): Group {
  const g = new Group();
  const depth = st.rows * st.rowDepth;
  // orientation basis: X = longDir, Z = -frontDir (into the stand)
  const x = new Vector3(st.longDir.x, 0, -st.longDir.y);
  const zAxis = new Vector3(-st.frontDir.x, 0, st.frontDir.y);
  const y = new Vector3(0, 1, 0);
  const m = new Matrix4().makeBasis(x, y, zAxis);
  const q = new Quaternion().setFromRotationMatrix(m);

  // stepped seating decks (merged boxes per tier, not per row)
  const deckRows = st.rows;
  const seatMat = new MeshStandardMaterial({ color: SEAT_COLORS[st.id.length % SEAT_COLORS.length], roughness: 0.85 });
  for (let tier = 0; tier < st.tiers; tier++) {
    const tierRows = Math.ceil(deckRows / st.tiers);
    const row0 = tier * tierRows;
    const rowsHere = Math.min(tierRows, deckRows - row0);
    if (rowsHere <= 0) continue;
    const tierDropback = tier * 1.2; // upper tier starts further back
    for (let r = 0; r < rowsHere; r++) {
      const rr = row0 + r;
      const step = new Mesh(new BoxGeometry(st.width, 0.32, st.rowDepth * 0.94), rr % 2 === 0 ? seatMat : SEAT_FRAME);
      step.position.set(0, rr * st.rowRise + 0.16 + tier * 0.9, -(rr * st.rowDepth + tierDropback));
      step.castShadow = false;
      g.add(step);
    }
    // tier fascia (structural face under each tier)
    const fascia = new Mesh(new BoxGeometry(st.width, 1.1, 0.4), SEAT_FRAME);
    fascia.position.set(0, row0 * st.rowRise - 0.4 + tier * 0.9, -(row0 * st.rowDepth + tierDropback) + 0.2);
    g.add(fascia);
  }
  // rear wall
  const rearH = st.rows * st.rowRise + 2.2;
  const rear = new Mesh(new BoxGeometry(st.width, rearH, 0.5), SEAT_FRAME);
  rear.position.set(0, rearH / 2 - 0.5, -(depth + st.tiers * 1.2 + 0.3));
  g.add(rear);
  // side walls
  for (const sx of [-1, 1]) {
    const side = new Mesh(new BoxGeometry(0.4, rearH * 0.85, depth * 0.96), SEAT_FRAME);
    side.position.set((sx * st.width) / 2, (rearH * 0.85) / 2 - 0.4, -(depth / 2));
    g.add(side);
  }
  // roof (cantilevered toward the track: front = local +z)
  if (st.roof && st.roof !== "none") {
    const roofDepth = depth * 0.85 + 6;
    const roof = new Mesh(
      new BoxGeometry(st.width + 1.5, 0.28, roofDepth),
      st.roof === "tensile-canopy" || st.roof === "fabric" ? CANVAS_MAT : ROOF_MAT,
    );
    roof.position.set(0, rearH + 1.4, -(depth / 2) + roofDepth * 0.18);
    roof.rotation.x = st.roof === "cantilever" ? -0.07 : 0;
    roof.castShadow = true;
    g.add(roof);
    // roof support columns at the rear (cantilever logic: held from behind)
    for (let k = 0; k <= 4; k++) {
      const col = new Mesh(new CylinderGeometry(0.22, 0.22, rearH + 1.4, 8), SEAT_FRAME);
      col.position.set(-st.width / 2 + (st.width * k) / 4, (rearH + 1.4) / 2 - 0.5, -(depth + st.tiers * 1.2));
      g.add(col);
    }
  }
  g.position.set(st.origin.x, st.origin.z, -st.origin.y);
  g.quaternion.copy(q);
  return g;
}

/** All grandstand meshes + debug front arrows. */
export function grandstandMeshes(stands: GrandstandPlan[], debug = false): Group {
  const g = new Group();
  g.name = "grandstands";
  for (const st of stands) {
    g.add(grandstandMesh(st));
    if (debug) {
      // front-direction debug arrow
      const arrowGeo = new CylinderGeometry(0.15, 0.15, 14, 6);
      const arrow = new Mesh(arrowGeo, new MeshStandardMaterial({ color: 0xff2a2a }));
      arrow.position.set(st.origin.x + st.frontDir.x * 8, st.origin.z + 6, -(st.origin.y + st.frontDir.y * 8));
      arrow.rotation.z = Math.PI / 2;
      arrow.rotation.y = -Math.atan2(st.frontDir.y, st.frontDir.x);
      g.add(arrow);
    }
  }
  return g;
}

// ============================================================ night lighting

import {
  AdditiveBlending,
  Points,
  PointsMaterial,
} from "three";
import type { FacilityLightingPlan } from "../core/facilities/types";

let lampDot: CanvasTexture | null = null;
function lampDotTex(): CanvasTexture {
  if (lampDot) return lampDot;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  lampDot = new CanvasTexture(cv);
  return lampDot;
}

/** Emissive lamp anchors as one additive Points cloud (visible at night). */
export function facilityLightPoints(lighting: FacilityLightingPlan): Points {
  const n = lighting.anchors.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = { r: 1, g: 1, b: 1 };
  lighting.anchors.forEach((a, i) => {
    pos[i * 3] = a.x;
    pos[i * 3 + 1] = a.z;
    pos[i * 3 + 2] = -a.y;
    const hex = a.color;
    c.r = ((hex >> 16) & 255) / 255;
    c.g = ((hex >> 8) & 255) / 255;
    c.b = (hex & 255) / 255;
    const k = a.intensity;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  });
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("color", new BufferAttribute(col, 3));
  const mat = new PointsMaterial({
    size: 2.6,
    map: lampDotTex(),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const pts = new Points(geo, mat);
  pts.name = "facility-lamps";
  pts.frustumCulled = false;
  return pts;
}

/** Vary lamp point size by kind: bake into per-point scale via geometry attr. */
export function facilityLampMeshes(lighting: FacilityLightingPlan): Group {
  const g = new Group();
  g.name = "facility-lighting";
  g.add(facilityLightPoints(lighting));
  return g;
}

// ============================================================ screens

import { Group as THREEGroup } from "three";

/** Generated screen content: timing tower + track map (no real brands). */
export function makeScreenTexture(track: Track, title: string): CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 288;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#0b1016";
  ctx.fillRect(0, 0, 512, 288);
  // header
  ctx.fillStyle = "#e8362a";
  ctx.fillRect(0, 0, 512, 34);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(title.toUpperCase().slice(0, 26), 12, 24);
  // timing tower rows
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y = 48 + r * 26;
    ctx.fillStyle = r % 2 === 0 ? "#121a24" : "#0e141d";
    ctx.fillRect(8, y - 16, 300, 24);
    ctx.fillStyle = "#f2f4f6";
    ctx.font = "bold 15px monospace";
    ctx.fillText(String(r + 1).padStart(2, " "), 16, y);
    ctx.fillStyle = ["#e8362a", "#2a5ae8", "#3ae85a", "#e8a83a", "#8a4ae8", "#3ac8e8", "#e84a98", "#9ae83a"][r];
    ctx.fillRect(44, y - 12, 10, 16);
    ctx.fillStyle = "#c8ccd2";
    ctx.fillText(`CAR ${r * 7 + 3}`, 62, y);
    ctx.fillStyle = "#8a9098";
    ctx.fillText(`1:4${r}.$\{String(100 + ((r * 137) % 880)).padStart(3, "0")}`, 140, y);
    if (r > 0) {
      ctx.fillStyle = "#e8b23a";
      ctx.fillText(`+${(r * 0.421).toFixed(3)}`, 230, y);
    }
  }
  // track map
  const samples = track.samples;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }
  const mx = (x: number) => 330 + ((x - minX) / Math.max(1, maxX - minX)) * 168;
  const my = (y: number) => 270 - ((y - minY) / Math.max(1, maxY - minY)) * 224;
  ctx.strokeStyle = "#3a82e8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  samples.forEach((s, i) => (i === 0 ? ctx.moveTo(mx(s.x), my(s.y)) : ctx.lineTo(mx(s.x), my(s.y))));
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "#e8362a";
  ctx.beginPath();
  ctx.arc(mx(samples[0].x), my(samples[0].y), 5, 0, Math.PI * 2);
  ctx.fill();
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** A supported video screen facing the grandstand/pit straight. */
export function screenTowerMesh(track: Track, x: number, y: number, z: number, heading: number, title: string): Group {
  const g = new THREEGroup();
  // support columns
  for (const sx of [-3.4, 3.4]) {
    const col = new Mesh(new CylinderGeometry(0.28, 0.34, 9.5, 8), CONCRETE_MAT);
    col.position.set(sx, 4.75, 0);
    col.castShadow = true;
    g.add(col);
  }
  const frame = new Mesh(new BoxGeometry(9.6, 5.6, 0.4), new MeshStandardMaterial({ color: 0x14181e, roughness: 0.6 }));
  frame.position.y = 9.2;
  g.add(frame);
  const screen = new Mesh(
    new PlaneGeometry(8.8, 4.9),
    new MeshStandardMaterial({
      map: makeScreenTexture(track, title),
      emissive: 0xffffff,
      emissiveMap: makeScreenTexture(track, title),
      emissiveIntensity: 0.0,
      roughness: 0.4,
    }),
  );
  screen.name = "screen-emissive";
  screen.position.set(0, 9.2, 0.25);
  g.add(screen);
  g.position.set(x, z, -y);
  g.rotation.y = -heading;
  return g;
}
