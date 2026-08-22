/**
 * Export geometry for procedural worlds: pure mesh data (no three.js
 * objects) for water, boundary skirt, vegetation, and landmarks — each
 * meaningfully separated so GLB/OBJ/Blender consumers can treat them
 * independently. The carved terrain itself flows through the existing
 * TerrainSurface export paths.
 */

import { Rng } from "../prng";
import type { WorldPlan } from "./types";

export interface ExportPart {
  name: string;
  /** plan-coord positions [x, y(plan), z] triplets — callers flip y */
  positions: Float32Array;
  indices: Uint32Array;
  color: number;
}

function pushTri(pos: number[], idx: number[], ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
  const base = pos.length / 3;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  idx.push(base, base + 1, base + 2);
}

/** river ribbons + lake/coast discs */
export function worldWaterParts(plan: WorldPlan): ExportPart[] {
  const parts: ExportPart[] = [];
  for (const w of plan.water) {
    const pos: number[] = [];
    const idx: number[] = [];
    if (w.type === "river") {
      const pts = w.points;
      const half = w.width / 2;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const q = pts[Math.min(k + 1, pts.length - 1)];
        const p0 = pts[Math.max(0, k - 1)];
        const tx = q.x - p0.x;
        const ty = q.y - p0.y;
        const len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len;
        const ny = tx / len;
        pos.push(p.x + nx * half, p.y + ny * half, p.z - 0.25, p.x - nx * half, p.y - ny * half, p.z - 0.25);
      }
      for (let k = 0; k < pts.length - 1; k++) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      parts.push({ name: "world_water_river", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x2b4a63 });
    } else if (w.type === "lake") {
      const SEG = 36;
      const cx = w.x;
      const cy = w.y;
      const cIdx = 0;
      pos.push(cx, cy, w.level);
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * w.radius, cy + Math.sin(a) * w.radius, w.level);
      }
      for (let k = 1; k <= SEG; k++) idx.push(cIdx, cIdx + k, cIdx + k + 1);
      parts.push({ name: "world_water_lake", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x2b4a63 });
    } else if (w.type === "coast") {
      const g = plan.grid;
      const x0 = g.originX - 600;
      const y0 = g.originY - 600;
      const x1 = g.originX + g.width * g.resolution + 600;
      const y1 = g.originY + g.height * g.resolution + 600;
      pushTri(pos, idx, x0, y0, w.level, x1, y0, w.level, x1, y1, w.level);
      pushTri(pos, idx, x0, y0, w.level, x1, y1, w.level, x0, y1, w.level);
      parts.push({ name: "world_water_coast", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x2b4a63 });
    }
  }
  return parts;
}

/** boundary skirt: side walls + underside */
export function worldBoundaryParts(plan: WorldPlan): ExportPart[] {
  const b = plan.boundary;
  if (b.mode === "open") return [];
  const pos: number[] = [];
  const idx: number[] = [];
  const ring = b.ring;
  const n = ring.length;
  const g = plan.grid;
  const gridZ = (x: number, y: number): number => {
    const gx = (x - g.originX) / g.resolution;
    const gy = (y - g.originY) / g.resolution;
    const x0 = Math.max(0, Math.min(g.width - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(g.height - 2, Math.floor(gy)));
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fy = Math.min(1, Math.max(0, gy - y0));
    const i = y0 * g.width + x0;
    const e = g.elevation;
    return e[i] * (1 - fx) * (1 - fy) + e[i + 1] * fx * (1 - fy) + e[i + g.width] * (1 - fx) * fy + e[i + g.width + 1] * fx * fy;
  };
  for (let k = 0; k <= n; k++) {
    const p = ring[k % n];
    pos.push(p.x, p.y, gridZ(p.x, p.y), p.x, p.y, b.baseZ);
  }
  for (let k = 0; k < n; k++) {
    const a = k * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // underside fan
  const cx = ring.reduce((a, p) => a + p.x, 0) / n;
  const cy = ring.reduce((a, p) => a + p.y, 0) / n;
  const centerIdx = pos.length / 3;
  pos.push(cx, cy, b.baseZ);
  const ringStart = pos.length / 3;
  for (let k = 0; k <= n; k++) {
    const p = ring[k % n];
    pos.push(p.x, p.y, b.baseZ);
  }
  for (let k = 0; k < n; k++) idx.push(centerIdx, ringStart + k, ringStart + k + 1);
  const color = b.treatment === "concrete-plinth" ? 0x9d9d9a : b.treatment === "coastline" ? 0x8c8570 : 0x5c554e;
  return [{ name: "world_boundary", positions: new Float32Array(pos), indices: new Uint32Array(idx), color }];
}

/** vegetation baked as low-poly cones (trunk+canopy merged per tree) */
export function worldVegetationParts(plan: WorldPlan): ExportPart[] {
  const pos: number[] = [];
  const idx: number[] = [];
  const SEG = 5;
  for (const t of plan.vegetation.trees) {
    const h = (t.conifer ? 8.5 : 6.5) * t.scale;
    const r = (t.conifer ? 2.5 : 3.2) * t.scale;
    const base = pos.length / 3;
    // trunk quad-stack: just include in the cone base
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      pos.push(t.x + Math.cos(a) * r, t.y + Math.sin(a) * r, t.z + h * 0.28);
    }
    pos.push(t.x, t.y, t.z + h); // apex
    pos.push(t.x, t.y, t.z); // base center
    for (let k = 0; k < SEG; k++) {
      idx.push(base + k, base + ((k + 1) % SEG), base + SEG);
      idx.push(base + SEG + 1, base + ((k + 1) % SEG), base + k);
    }
  }
  const parts: ExportPart[] = [];
  if (pos.length > 0) {
    parts.push({ name: "world_vegetation_trees", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x3d6132 });
  }
  // boulders as small icosahedron-ish lumps (octahedron approximation)
  const bpos: number[] = [];
  const bidx: number[] = [];
  for (const b of plan.vegetation.boulders) {
    const s = b.scale * 1.6;
    const base = bpos.length / 3;
    bpos.push(
      b.x + s, b.y, b.z, b.x - s, b.y, b.z,
      b.x, b.y + s, b.z, b.x, b.y - s, b.z,
      b.x, b.y, b.z + s * 0.8, b.x, b.y, b.z - s * 0.5,
    );
    const faces = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
    for (const f of faces) bidx.push(base + f);
  }
  if (bpos.length > 0) {
    parts.push({ name: "world_vegetation_boulders", positions: new Float32Array(bpos), indices: new Uint32Array(bidx), color: 0x7a7268 });
  }
  return parts;
}

/** landmarks as simple representative geometry */
export function worldLandmarkParts(plan: WorldPlan): ExportPart[] {
  const parts: ExportPart[] = [];
  for (const lm of plan.landmarks) {
    const pos: number[] = [];
    const idx: number[] = [];
    const rng = new Rng(lm.seed);
    void rng;
    const s = lm.scale;
    if (lm.kind === "hero-tree" || lm.kind === "crest-tree") {
      // trunk prism + canopy blob (ico-ish octahedron)
      const h = 9 * s;
      const r = 0.8 * s;
      const SEG = 6;
      const base = pos.length / 3;
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        pos.push(lm.x + Math.cos(a) * r, lm.y + Math.sin(a) * r, lm.z);
        pos.push(lm.x + Math.cos(a) * r * 0.6, lm.y + Math.sin(a) * r * 0.6, lm.z + h);
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const cbase = pos.length / 3;
      const cr = 4.2 * s;
      pos.push(
        lm.x + cr, lm.y, lm.z + h + cr * 0.5, lm.x - cr, lm.y, lm.z + h + cr * 0.5,
        lm.x, lm.y + cr, lm.z + h + cr * 0.5, lm.x, lm.y - cr, lm.z + h + cr * 0.5,
        lm.x, lm.y, lm.z + h + cr * 1.3, lm.x, lm.y, lm.z + h,
      );
      const cf = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
      for (const f of cf) idx.push(cbase + f);
      parts.push({ name: `world_landmark_${lm.kind}`, positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x3f6830 });
    } else if (lm.kind === "monolith") {
      const h = 14 * s;
      const r0 = 3.2 * s;
      const r1 = 1.2 * s;
      const SEG = 6;
      const base = pos.length / 3;
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2 + lm.heading;
        pos.push(lm.x + Math.cos(a) * r0, lm.y + Math.sin(a) * r0, lm.z - 1);
        pos.push(lm.x + Math.cos(a) * r1, lm.y + Math.sin(a) * r1, lm.z + h);
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        const b2 = base + ((k + 1) % SEG) * 2;
        idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
      }
      parts.push({ name: "world_landmark_monolith", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x5c544c });
    } else if (lm.kind === "waterfall") {
      const h = 6 * s + 3;
      const w = 3.5;
      const dx = Math.cos(lm.heading + Math.PI / 2) * w;
      const dy = Math.sin(lm.heading + Math.PI / 2) * w;
      pushTri(pos, idx, lm.x - dx, lm.y - dy, lm.z, lm.x + dx, lm.y - dy, lm.z, lm.x + dx, lm.y + dy, lm.z + h);
      pushTri(pos, idx, lm.x - dx, lm.y - dy, lm.z, lm.x + dx, lm.y + dy, lm.z + h, lm.x - dx, lm.y + dy, lm.z + h);
      parts.push({ name: "world_landmark_waterfall", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0xcfe4ee });
    } else if (lm.kind === "rock-arch") {
      // half-torus approximation as a segmented arch band
      const R = 9 * s;
      const TUBE = 2.4 * s;
      const SEGS = 10;
      const base = pos.length / 3;
      const hx = Math.cos(lm.heading);
      const hy = Math.sin(lm.heading);
      for (let k = 0; k <= SEGS; k++) {
        const a = (k / SEGS) * Math.PI;
        const cxp = lm.x + Math.cos(a) * R * -hy;
        const cyp = lm.y + Math.cos(a) * R * hx;
        const cz = lm.z + Math.sin(a) * R;
        pos.push(cxp - hx * TUBE, cyp - hy * TUBE, cz, cxp + hx * TUBE, cyp + hy * TUBE, cz);
      }
      for (let k = 0; k < SEGS; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      parts.push({ name: "world_landmark_arch", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x6a5f50 });
    } else if (lm.kind === "ruin") {
      const w = (6 * s) / 2;
      const h = 3.2 * s;
      const hx = Math.cos(lm.heading);
      const hy = Math.sin(lm.heading);
      pushTri(pos, idx, lm.x - hx * w, lm.y - hy * w, lm.z, lm.x + hx * w, lm.y + hy * w, lm.z, lm.x + hx * w, lm.y + hy * w, lm.z + h);
      pushTri(pos, idx, lm.x - hx * w, lm.y - hy * w, lm.z, lm.x + hx * w, lm.y + hy * w, lm.z + h, lm.x - hx * w, lm.y - hy * w, lm.z + h);
      parts.push({ name: "world_landmark_ruin", positions: new Float32Array(pos), indices: new Uint32Array(idx), color: 0x7d7668 });
    }
    // forest-tunnel: vegetation-scale, covered by the vegetation export
  }
  return parts;
}

/** all environment parts, separated by role */
export function worldExportParts(plan: WorldPlan): ExportPart[] {
  return [
    ...worldWaterParts(plan),
    ...worldBoundaryParts(plan),
    ...worldVegetationParts(plan),
    ...worldLandmarkParts(plan),
  ];
}
