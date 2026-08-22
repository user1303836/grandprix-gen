/**
 * Facility geometry for exports (GLB/OBJ/Blender/package): converts the
 * canonical FacilityPlan into semantic StructureMeshPart arrays in plan
 * coordinates — same contract as buildStructureMeshes.
 */

import type { Track } from "../core/types";
import type {
  BuildingVolumePlan,
  FacilityPlan,
  GrandstandPlan,
  PitLanePlan,
} from "../core/facilities/types";
import type { StructureMeshPart } from "./structuresMesh";

class Acc {
  pos: number[] = [];
  idx: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[]) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, heading: number) {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    const c: number[][] = [];
    for (const dz of [-hz, hz]) {
      for (const [dx, dy] of [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ]) {
        c.push([cx + dx * ch - dy * sh, cy + dx * sh + dy * ch, cz + dz]);
      }
    }
    const [b0, b1, b2, b3, t0, t1, t2, t3] = c;
    this.quad(b0, b1, b2, b3);
    this.quad(t0, t2, t1, t3);
    this.quad(b0, t0, t1, b1);
    this.quad(b1, t1, t2, b2);
    this.quad(b2, t2, t3, b3);
    this.quad(b3, t3, t0, b0);
  }
  finish(name: string): StructureMeshPart {
    return { name, positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
  }
}

function pitLanePart(plan: PitLanePlan): StructureMeshPart | null {
  const acc = new Acc();
  const oIn = plan.laneBands[0].offsetInner;
  const oOut = plan.laneBands[plan.laneBands.length - 1].offsetOuter;
  const half = (oOut - oIn) / 2;
  const cl = plan.centerline;
  for (let i = 0; i < cl.length - 1; i++) {
    const a = cl[i];
    const b = cl[i + 1];
    const nax = -Math.sin(a.heading);
    const nay = Math.cos(a.heading);
    const nbx = -Math.sin(b.heading);
    const nby = Math.cos(b.heading);
    acc.quad(
      [a.x - nax * half, a.y - nay * half, a.z],
      [a.x + nax * half, a.y + nay * half, a.z],
      [b.x + nbx * half, b.y + nby * half, b.z],
      [b.x - nbx * half, b.y - nby * half, b.z],
    );
  }
  return acc.idx.length ? acc.finish("pit_lane") : null;
}

function pitWallPart(plan: PitLanePlan): StructureMeshPart | null {
  const acc = new Acc();
  const wallBand = plan.laneBands.find((b) => b.kind === "pit-wall")!;
  const fast = plan.laneBands.find((b) => b.kind === "fast-lane")!;
  const working = plan.laneBands.find((b) => b.kind === "working-lane")!;
  const pathOffset = (fast.offsetInner + working.offsetOuter) / 2;
  const oMid = (wallBand.offsetInner + wallBand.offsetOuter) / 2;
  const lat = (oMid - pathOffset) * (plan.side === "left" ? 1 : -1);
  const gaps = [...plan.pitWall.openings].sort((a, b) => a.s - b.s);
  const spans: [number, number][] = [];
  let cur = plan.pitWall.sStart;
  for (const gap of gaps) {
    if (gap.s > cur) spans.push([cur, gap.s]);
    cur = Math.max(cur, gap.s + gap.length);
  }
  if (cur < plan.pitWall.sEnd) spans.push([cur, plan.pitWall.sEnd]);
  const at = (s: number) => plan.centerline[Math.min(plan.centerline.length - 1, Math.max(0, Math.round(s / 4)))];
  for (const [a, b] of spans) {
    for (let s = a; s < b; s += 6) {
      const p = at(s);
      acc.box(p.x - Math.sin(p.heading) * lat, p.y + Math.cos(p.heading) * lat, p.z + 0.55, 0.35, 0.9, Math.min(6, b - s), p.heading);
    }
  }
  return acc.idx.length ? acc.finish("pit_wall") : null;
}

function volumePart(v: BuildingVolumePlan): StructureMeshPart {
  const acc = new Acc();
  const h = v.floors * v.floorHeight;
  acc.box(v.cx, v.cy, v.baseZ + h / 2, v.widthU, v.depthV, h, v.angleU);
  // roof slab
  acc.box(v.cx, v.cy, v.baseZ + h + 0.15, v.widthU + 0.6, v.depthV + 0.6, 0.3, v.angleU);
  const name =
    v.kind === "garage-block" ? "garage_building"
    : v.kind === "hospitality" ? "hospitality"
    : v.kind === "tower" || v.kind === "race-control" ? "race_control"
    : v.kind === "clubhouse" ? "hospitality"
    : "garage_building";
  return acc.finish(name);
}

function grandstandPart(st: GrandstandPlan): StructureMeshPart {
  const acc = new Acc();
  const depth = st.rows * st.rowDepth;
  const fx = st.frontDir.x;
  const fy = st.frontDir.y;
  const lx = st.longDir.x;
  const ly = st.longDir.y;
  const ang = Math.atan2(ly, lx);
  for (let r = 0; r < st.rows; r++) {
    const bx = st.origin.x - fx * (r * st.rowDepth);
    const by = st.origin.y - fy * (r * st.rowDepth);
    acc.box(bx, by, st.origin.z + r * st.rowRise + 0.16, st.width, st.rowDepth * 0.94, 0.32, ang);
  }
  // rear wall
  acc.box(
    st.origin.x - fx * (depth + 0.5),
    st.origin.y - fy * (depth + 0.5),
    st.origin.z + (st.rows * st.rowRise + 2) / 2,
    st.width,
    0.5,
    st.rows * st.rowRise + 2,
    ang,
  );
  // roof
  if (st.roof && st.roof !== "none") {
    acc.box(
      st.origin.x - fx * (depth / 2 - 1),
      st.origin.y - fy * (depth / 2 - 1),
      st.origin.z + st.rows * st.rowRise + 2.2,
      st.width + 1.4,
      depth * 0.9 + 5,
      0.28,
      ang,
    );
  }
  return acc.finish(st.id === "main" ? "grandstand_main" : "grandstand_secondary");
}

/** All facility parts for export. */
export function buildFacilityMeshParts(track: Track): StructureMeshPart[] {
  const plan: FacilityPlan | null | undefined = track.facilities;
  if (!plan) return [];
  const out: StructureMeshPart[] = [];
  if (plan.pitLane) {
    const lane = pitLanePart(plan.pitLane);
    if (lane) out.push(lane);
    const wall = pitWallPart(plan.pitLane);
    if (wall) out.push(wall);
  }
  if (plan.pitComplex) {
    for (const v of plan.pitComplex.volumes) out.push(volumePart(v));
    // garage doors
    const doors = new Acc();
    for (const bay of plan.pitComplex.garageBays) {
      doors.box(bay.x, bay.y, bay.z + 1.55, bay.width, 0.14, 3.1, bay.heading);
    }
    if (doors.idx.length) out.push(doors.finish("garage_doors"));
  }
  for (const st of plan.grandstands) out.push(grandstandPart(st));
  // foundations: simple skirts
  const fdn = new Acc();
  for (const f of plan.foundations) {
    const n = f.footprint.length;
    for (let i = 0; i < n; i++) {
      const a = f.footprint[i];
      const b = f.footprint[(i + 1) % n];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const h = Math.max(0.3, f.datumZ[0] - f.ground.min);
      fdn.box(mx, my, f.datumZ[0] - h / 2, len, 0.5, h, Math.atan2(b.y - a.y, b.x - a.x));
    }
  }
  if (fdn.idx.length) out.push(fdn.finish("facility_foundations"));
  // screens
  const scr = new Acc();
  for (const sc of plan.screens) {
    scr.box(sc.x, sc.y, sc.z + 9.2, 9.6, 0.4, 5.6, sc.heading);
    scr.box(sc.x - 3.4 * Math.cos(sc.heading), sc.y - 3.4 * Math.sin(sc.heading), sc.z + 4.75, 0.6, 0.6, 9.5, sc.heading);
    scr.box(sc.x + 3.4 * Math.cos(sc.heading), sc.y + 3.4 * Math.sin(sc.heading), sc.z + 4.75, 0.6, 0.6, 9.5, sc.heading);
  }
  if (scr.idx.length) out.push(scr.finish("screens"));
  return out;
}
