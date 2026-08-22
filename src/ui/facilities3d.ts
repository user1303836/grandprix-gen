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
      seg.rotation.y = -p0.heading;
      seg.castShadow = true;
      g.add(seg);
    }
  }
  return g;
}

/** Build every facility mesh for the current plan. */
export function buildFacilityMeshes(plan: FacilityPlan, track: Track): Group {
  const group = new Group();
  group.name = "facilities";
  if (plan.pitLane) {
    group.add(pitLaneMesh(plan.pitLane));
    group.add(pitWallGroup(plan.pitLane));
  }
  void track;
  return group;
}

export { Float32BufferAttribute, Uint32BufferAttribute };
