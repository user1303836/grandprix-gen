/**
 * World renderer: turns a canonical WorldPlan into Three.js meshes.
 * Everything here is derived — the plan (src/core/world/) is the source of
 * truth. Reuses the site-mode water material + wind sway shading.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  BoxGeometry,
  RepeatWrapping,
} from "three";
import { Rng } from "../core/prng";
import { makeWaterMaterial } from "./water";
import { makeGrassTexture } from "./textures";
import type { WorldPlan, Landmark, Biome } from "../core/world/types";
import type { Track } from "../core/types";
import { pointInPolygon } from "../core/facilities/foundations";
import { makeTrackProximity } from "../core/terrain";
import { windUniform } from "./furniture";

export interface WorldMeshOptions {
  sunDir: Vector3;
  horizonColor: number;
  sunColor: number;
  season: "summer" | "autumn";
  carve: (x: number, y: number) => number;
  maxTessSide?: number;
  /** drop terrain quads whose center lies inside the road-covered corridor
   * (prevents coarse triangles spanning the road between close sections) */
  corridorCull?: (x: number, y: number) => boolean;
}

// ---------------------------------------------------------------------------
// biome terrain tinting
// ---------------------------------------------------------------------------

interface Ramp {
  low: [number, number, number];
  mid: [number, number, number];
  high: [number, number, number];
  rock: [number, number, number];
}

const BIOME_RAMPS: Record<Biome, Ramp> = {
  "temperate-forest": { low: [0.16, 0.30, 0.10], mid: [0.30, 0.38, 0.14], high: [0.42, 0.42, 0.24], rock: [0.42, 0.40, 0.36] },
  alpine: { low: [0.20, 0.30, 0.12], mid: [0.32, 0.34, 0.16], high: [0.55, 0.55, 0.52], rock: [0.44, 0.42, 0.40] },
  volcanic: { low: [0.16, 0.13, 0.11], mid: [0.26, 0.20, 0.15], high: [0.36, 0.28, 0.22], rock: [0.22, 0.19, 0.17] },
  arid: { low: [0.48, 0.38, 0.22], mid: [0.56, 0.46, 0.28], high: [0.60, 0.52, 0.36], rock: [0.46, 0.38, 0.30] },
  coastal: { low: [0.55, 0.52, 0.36], mid: [0.28, 0.38, 0.16], high: [0.40, 0.42, 0.26], rock: [0.44, 0.42, 0.38] },
  highland: { low: [0.24, 0.32, 0.12], mid: [0.36, 0.38, 0.18], high: [0.46, 0.44, 0.30], rock: [0.44, 0.42, 0.38] },
};

function tintWorldTerrain(
  plan: WorldPlan,
  positions: Float32Array,
  slopeOf: (x: number, y: number) => number,
  season: "summer" | "autumn",
): Float32Array {
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  const ramp = BIOME_RAMPS[plan.identity.biome] ?? BIOME_RAMPS.highland;
  const g = plan.grid;
  const zSpan = Math.max(1, g.maxElevation - g.minElevation);
  const autumn = season === "autumn";
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const t = Math.min(1, Math.max(0, (z - g.minElevation) / zSpan));
    // moisture at the vertex
    const gx = Math.round((x - g.originX) / g.resolution);
    const gy = Math.round((y - g.originY) / g.resolution);
    const moistRaw = gx >= 0 && gy >= 0 && gx < g.width && gy < g.height ? g.moisture[gy * g.width + gx] : 0.3;
    const moist = Number.isFinite(moistRaw) ? moistRaw : 0.3;
    const slopeRaw = slopeOf(x, y);
    const slope = Number.isFinite(slopeRaw) ? slopeRaw : 0.2;
    let r: number, gg: number, b: number;
    if (t < 0.5) {
      const u = t / 0.5;
      r = ramp.low[0] + (ramp.mid[0] - ramp.low[0]) * u;
      gg = ramp.low[1] + (ramp.mid[1] - ramp.low[1]) * u;
      b = ramp.low[2] + (ramp.mid[2] - ramp.low[2]) * u;
    } else {
      const u = (t - 0.5) / 0.5;
      r = ramp.mid[0] + (ramp.high[0] - ramp.mid[0]) * u;
      gg = ramp.mid[1] + (ramp.high[1] - ramp.mid[1]) * u;
      b = ramp.mid[2] + (ramp.high[2] - ramp.mid[2]) * u;
    }
    // moist ground: darker + greener
    gg += moist * 0.07;
    r *= 1 - moist * 0.15;
    // gentle saturation + contrast so terrain doesn't read washed out
    const lum = r * 0.3 + gg * 0.55 + b * 0.15;
    r = lum + (r - lum) * 1.35;
    gg = lum + (gg - lum) * 1.35;
    b = lum + (b - lum) * 1.3;
    const ctr = 1.12;
    r = (r - 0.28) * ctr + 0.28;
    gg = (gg - 0.28) * ctr + 0.28;
    b = (b - 0.28) * ctr + 0.28;
    // rock outcrops on steep slopes
    const rocky = Math.min(1, Math.max(0, (slope - 0.4) * 2.4));
    r = r * (1 - rocky) + ramp.rock[0] * rocky;
    gg = gg * (1 - rocky) + ramp.rock[1] * rocky;
    b = b * (1 - rocky) + ramp.rock[2] * rocky;
    if (autumn) {
      r = Math.min(1, r * 1.35 + 0.05);
      gg *= 0.85;
      b *= 0.6;
    }
    // subtle variation
    const nv = Math.sin(x * 0.043 + y * 0.031) * 0.5 + Math.sin(x * 0.011 - y * 0.017) * 0.5;
    const vm = 1 + nv * 0.07;
    colors[i * 3] = r * vm;
    colors[i * 3 + 1] = gg * vm;
    colors[i * 3 + 2] = b * vm;
  }
  return colors;
}

// ---------------------------------------------------------------------------
// terrain mesh (grid tessellation, carved by the caller's sampler)
// ---------------------------------------------------------------------------

function buildWorldTerrainMesh(plan: WorldPlan, opts: WorldMeshOptions): Mesh {
  const g = plan.grid;
  const safeCarveRef = (x: number, y: number): number => {
    const v = opts.carve(x, y);
    if (Number.isFinite(v)) return v;
    return sampleGridZ(plan, Math.min(Math.max(x, g.originX), g.originX + (g.width - 1) * g.resolution), Math.min(Math.max(y, g.originY), g.originY + (g.height - 1) * g.resolution)) || 0;
  };
  const span = Math.max(g.width, g.height) * g.resolution;
  const maxSide = opts.maxTessSide ?? Math.max(200, Math.min(640, Math.ceil(span / 9.5)));
  const step = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
  const nx = Math.ceil((g.width - 1) / step) + 1;
  const ny = Math.ceil((g.height - 1) / step) + 1;
  const positions = new Float32Array(nx * ny * 3);
  let p = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const gx = Math.min(g.width - 1, ix * step);
      const gy = Math.min(g.height - 1, iy * step);
      const x = g.originX + gx * g.resolution;
      const y = g.originY + gy * g.resolution;
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = safeCarveRef(x, y);
    }
  }
  const maskToRing = plan.boundary.mode !== "open";
  const ring = plan.boundary.ring;
  const indexList: number[] = [];
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      // quad center (plan)
      const qcx = g.originX + (Math.min(g.width - 1, ix * step) + (step / 2)) * g.resolution;
      const qcy = g.originY + (Math.min(g.height - 1, iy * step) + (step / 2)) * g.resolution;
      if (opts.corridorCull && opts.corridorCull(qcx, qcy)) continue;
      if (maskToRing) {
        // drop quads whose center is outside the boundary ring
        if (!pointInRing(ring, qcx, qcy)) continue;
      }
      const a = iy * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indexList.push(a, c, b, b, c, d);
    }
  }
  const indices = new Uint32Array(indexList);
  const safeCarve = (x: number, y: number): number => {
    const v = opts.carve(x, y);
    if (Number.isFinite(v)) return v;
    // outside the grid: fall back to the raw plan grid edge value
    const w = sampleGridZ(plan, Math.min(Math.max(x, g.originX), g.originX + (g.width - 1) * g.resolution), Math.min(Math.max(y, g.originY), g.originY + (g.height - 1) * g.resolution));
    return Number.isFinite(w) ? w : 0;
  };
  const colors = tintWorldTerrain(plan, positions, (x, y) => {
    // finite-difference slope off the carved surface (crisp enough for tinting)
    const e = 4;
    const dzdx = (safeCarve(x + e, y) - safeCarve(x - e, y)) / (2 * e);
    const dzdy = (safeCarve(x, y + e) - safeCarve(x, y - e)) / (2 * e);
    return Math.hypot(dzdx, dzdy);
  }, opts.season);

  // world-frame conversion (plan y up => three -y forward): done by caller
  const pos3 = new Float32Array(nx * ny * 3);
  const uvs = new Float32Array(nx * ny * 2);
  for (let i = 0; i < positions.length; i += 3) {
    pos3[i] = positions[i];
    pos3[i + 1] = positions[i + 2];
    pos3[i + 2] = -positions[i + 1];
    uvs[(i / 3) * 2] = positions[i] / 57;
    uvs[(i / 3) * 2 + 1] = positions[i + 1] / 57;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos3, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide });
  // grass/ground detail breaks up flat tinting up close
  mat.map = detailTextureFor(plan.identity.biome);
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "world-terrain";
  return mesh;
}

let worldDetailTex: CanvasTexture | null = null;
function detailTextureFor(_biome: Biome): CanvasTexture {
  if (!worldDetailTex) worldDetailTex = makeGrassTexture();
  return worldDetailTex;
}

// ---------------------------------------------------------------------------
// boundary skirt / plinth / cliffs
// ---------------------------------------------------------------------------

function buildFarApron(plan: WorldPlan, opts: WorldMeshOptions): Mesh | null {
  if (plan.boundary.mode !== "open") return null;
  const g = plan.grid;
  const cx = g.originX + (g.width * g.resolution) / 2;
  const cy = g.originY + (g.height * g.resolution) / 2;
  const baseZ = (g.minElevation + g.maxElevation) / 2 - 6;
  const rimZ = baseZ - 6 - plan.envParams.drama * 20;
  const ramp = BIOME_RAMPS[plan.identity.biome] ?? BIOME_RAMPS.highland;
  const haze = new Color(opts.horizonColor);
  const edge = new Color(ramp.mid[0], ramp.mid[1], ramp.mid[2]);

  // rectangular frame: inner loop = grid perimeter (slightly inset, at rimZ),
  // outer loops expand toward the fog distance, fading into the haze
  const gx0 = g.originX - 2;
  const gy0 = g.originY - 2;
  const gx1 = g.originX + (g.width - 1) * g.resolution + 2;
  const gy1 = g.originY + (g.height - 1) * g.resolution + 2;
  const per: { x: number; y: number }[] = [];
  const STEPS = 24;
  for (let k = 0; k < STEPS; k++) per.push({ x: gx0 + ((gx1 - gx0) * k) / STEPS, y: gy0 });
  for (let k = 0; k < STEPS; k++) per.push({ x: gx1, y: gy0 + ((gy1 - gy0) * k) / STEPS });
  for (let k = 0; k < STEPS; k++) per.push({ x: gx1 - ((gx1 - gx0) * k) / STEPS, y: gy1 });
  for (let k = 0; k < STEPS; k++) per.push({ x: gx0, y: gy1 - ((gy1 - gy0) * k) / STEPS });
  const N = per.length;
  const RINGS = 5;
  const expand = [0, 90, 260, 700, 1800, 3600];
  const positions: number[] = [];
  const colors: number[] = [];
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    const e = expand[r];
    const z = rimZ - t * t * 26;
    for (let k = 0; k < N; k++) {
      const px = per[k].x;
      const py = per[k].y;
      const dx = px - cx;
      const dy = py - cy;
      const len = Math.hypot(dx, dy) || 1;
      positions.push(px + (dx / len) * e, z, -(py + (dy / len) * e));
      const cc = edge.clone().lerp(haze, 0.2 + t * 0.8);
      colors.push(cc.r, cc.g, cc.b);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < RINGS; r++) {
    for (let k = 0; k < N; k++) {
      const a = r * N + k;
      const b = r * N + ((k + 1) % N);
      const c = a + N;
      const d = b + N;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide });
  const mesh = new Mesh(geo, mat);
  mesh.name = "world-far-apron";
  return mesh;
}

function buildBoundaryMesh(plan: WorldPlan): Mesh | null {
  const b = plan.boundary;
  if (b.mode === "open") return null;
  const ring = b.ring;
  const n = ring.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const treatmentColor = (t: number): [number, number, number] => {
    switch (b.treatment) {
      case "concrete-plinth":
        return [0.62, 0.62, 0.60];
      case "stratified-earth": {
        const band = Math.sin(t * 22) * 0.5 + 0.5;
        return [0.42 - band * 0.08, 0.32 - band * 0.05, 0.24 - band * 0.03];
      }
      case "coastline":
        return [0.55, 0.52, 0.44];
      case "fog-drop":
        return [0.30, 0.32, 0.34];
      case "rock-cliff":
      default: {
        const band = Math.sin(t * 16 + 1.2) * 0.5 + 0.5;
        return [0.36 + band * 0.06, 0.33 + band * 0.05, 0.30 + band * 0.04];
      }
    }
  };

  // side wall: two rings (terrain edge -> baseZ), stratified colors
  for (let k = 0; k <= n; k++) {
    const p = ring[k % n];
    const zTop = plan.grid.elevation
      ? sampleGridZ(plan, p.x, p.y)
      : 0;
    positions.push(p.x, zTop, -p.y);
    const c0 = treatmentColor(0.9);
    colors.push(...c0);
    positions.push(p.x, b.baseZ, -p.y);
    const c1 = treatmentColor(0.1);
    colors.push(...c1);
  }
  for (let k = 0; k < n; k++) {
    const a = k * 2;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  // underside cap (simple fan from centroid at baseZ)
  const cx = ring.reduce((a, p) => a + p.x, 0) / n;
  const cy = ring.reduce((a, p) => a + p.y, 0) / n;
  const centerIdx = positions.length / 3;
  positions.push(cx, b.baseZ, -cy);
  colors.push(0.3, 0.3, 0.3);
  const ringStart = positions.length / 3;
  for (let k = 0; k <= n; k++) {
    const p = ring[k % n];
    positions.push(p.x, b.baseZ, -p.y);
    colors.push(0.3, 0.3, 0.3);
  }
  for (let k = 0; k < n; k++) {
    indices.push(centerIdx, ringStart + k + 1, ringStart + k);
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: DoubleSide });
  const mesh = new Mesh(geo, mat);
  mesh.name = "world-boundary";
  return mesh;
}

function pointInRing(ring: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sampleGridZ(plan: WorldPlan, x: number, y: number): number {
  const g = plan.grid;
  const gx = (x - g.originX) / g.resolution;
  const gy = (y - g.originY) / g.resolution;
  const x0 = Math.max(0, Math.min(g.width - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(g.height - 2, Math.floor(gy)));
  const fx = Math.min(1, Math.max(0, gx - x0));
  const fy = Math.min(1, Math.max(0, gy - y0));
  const i = y0 * g.width + x0;
  const e = g.elevation;
  return (
    e[i] * (1 - fx) * (1 - fy) + e[i + 1] * fx * (1 - fy) + e[i + g.width] * (1 - fx) * fy + e[i + g.width + 1] * fx * fy
  );
}

// ---------------------------------------------------------------------------
// water meshes
// ---------------------------------------------------------------------------

/** Live waterfall textures — the view scrolls map.offset each frame. */
export const waterfallTextures: CanvasTexture[] = [];

function makeWaterfallMaterial(): MeshStandardMaterial {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 256;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#bcd8e8";
  ctx.fillRect(0, 0, 64, 256);
  for (let k = 0; k < 90; k++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.5})`;
    const x = Math.random() * 64;
    ctx.fillRect(x, Math.random() * 256, 1 + Math.random() * 2, 30 + Math.random() * 90);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  waterfallTextures.push(tex);
  return new MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.92, roughness: 0.25, side: DoubleSide });
}

/** A diorama waterfall where a river crosses the boundary ring. */
function waterfallMesh(x: number, y: number, zTop: number, zBottom: number, width: number, outDir: { x: number; y: number }): Group {
  const g = new Group();
  const h = Math.max(2, zTop - zBottom);
  const sheet = new Mesh(new PlaneGeometry(width, h, 6, 8), makeWaterfallMaterial());
  // slight outward lean + convex belly
  const pos = sheet.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const vy = pos.getY(i); // -h/2..h/2
    const t = (vy + h / 2) / h; // 0 bottom, 1 top
    pos.setZ(i, (1 - t) * (1 - t) * h * 0.12 + Math.sin(t * Math.PI) * 0.4);
  }
  sheet.geometry.computeVertexNormals();
  sheet.position.set(0, -h / 2, 0);
  g.add(sheet);
  // foam lip + plunge pool
  const foamMat = new MeshStandardMaterial({ color: 0xeef6fa, roughness: 0.6 });
  const lip = new Mesh(new BoxGeometry(width + 0.6, 0.5, 1.2), foamMat);
  lip.position.set(0, 0.05, 0.2);
  g.add(lip);
  const pool = new Mesh(new CylinderGeometry(width * 0.75, width * 0.9, 0.35, 12), foamMat);
  pool.position.set(0, -h + 0.1, 1.2);
  g.add(pool);
  g.position.set(x, zTop, -y);
  g.rotation.y = -Math.atan2(outDir.y, outDir.x) + Math.PI / 2;
  return g;
}

function buildWaterMeshes(plan: WorldPlan, opts: WorldMeshOptions): Group {
  const group = new Group();
  group.name = "world-water";
  for (const w of plan.water) {
    if (w.type === "river") {
      // ribbon along the centerline
      const pts = w.points;
      if (pts.length < 2) continue;
      const curvePts = pts.map((p) => new Vector3(p.x, p.z - 0.25, -p.y));
      const curve = new CatmullRomCurve3(curvePts);
      const segs = Math.max(16, pts.length * 2);
      const positions: number[] = [];
      const half = w.width / 2;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t);
        const nx = -tan.z;
        const nz = tan.x;
        const len = Math.hypot(nx, nz) || 1;
        positions.push(p.x + (nx / len) * half, p.y, p.z + (nz / len) * half);
        positions.push(p.x - (nx / len) * half, p.y, p.z - (nz / len) * half);
      }
      // clip ribbon segments at the boundary ring; waterfalls at crossings
      const ring = plan.boundary.mode !== "open" ? plan.boundary.ring : null;
      const kept: number[] = [];
      const remap = new Map<number, number>();
      const newPos: number[] = [];
      const mk = (vi: number): number => {
        let nv = remap.get(vi);
        if (nv === undefined) {
          nv = newPos.length / 3;
          newPos.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
          remap.set(vi, nv);
        }
        return nv;
      };
      for (let k = 0; k < segs; k++) {
        const a = k * 2;
        // segment midpoint in PLAN coords (positions are world: x, z, -y)
        const mx = (positions[a * 3] + positions[(a + 2) * 3]) / 2;
        const my = -((positions[a * 3 + 2] + positions[(a + 2) * 3 + 2]) / 2);
        const inside = !ring || pointInRing(ring, mx, my);
        if (inside) {
          const a0 = mk(a);
          const a1 = mk(a + 1);
          const a2 = mk(a + 2);
          const a3 = mk(a + 3);
          kept.push(a0, a2, a1, a1, a2, a3);
        } else if (ring) {
          // river leaving the diorama → waterfall at the last inside edge
          const lx = positions[a * 3];
          const lz = positions[a * 3 + 1];
          const ly = -positions[a * 3 + 2];
          if (pointInRing(ring, lx, ly)) continue;
          // crossing between previous inside point and this outside one
          const prevMx = (positions[Math.max(0, a - 2) * 3] + positions[a * 3]) / 2;
          const prevMy = -((positions[Math.max(0, a - 2) * 3 + 2] + positions[a * 3 + 2]) / 2);
          const cx = (prevMx + mx) / 2;
          const cy = (prevMy + my) / 2;
          // outward direction: away from the ring centroid
          let ccx = 0;
          let ccy = 0;
          for (const rp of ring) {
            ccx += rp.x;
            ccy += rp.y;
          }
          ccx /= ring.length;
          ccy /= ring.length;
          const od = { x: mx - ccx, y: my - ccy };
          const odl = Math.hypot(od.x, od.y) || 1;
          group.add(waterfallMesh(cx, cy, lz + 0.1, plan.boundary.baseZ, w.width * 0.9, { x: od.x / odl, y: od.y / odl }));
          break; // one waterfall per river exit
        }
      }
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(new Float32Array(newPos), 3));
      geo.setIndex(kept);
      geo.computeVertexNormals();
      const mat = makeWaterMaterial(opts.sunDir);
      mat.uniforms.shallow.value.setHex(opts.horizonColor);
      mat.uniforms.sunColor.value.setHex(opts.sunColor);
      const mesh = new Mesh(geo, mat);
      mesh.name = "world-river";
      group.add(mesh);
    } else if (w.type === "lake") {
      const geo = new PlaneGeometry(w.radius * 2, w.radius * 2, 12, 12);
      geo.rotateX(-Math.PI / 2);
      // clip lake triangles that fall outside the diorama ring
      const ring = plan.boundary.mode !== "open" ? plan.boundary.ring : null;
      if (ring) {
        const pos = geo.getAttribute("position");
        const idx = geo.getIndex()!;
        const kept: number[] = [];
        for (let t = 0; t < idx.count; t += 3) {
          let cx = 0;
          let cz = 0;
          for (let k = 0; k < 3; k++) {
            const vi = idx.getX(t + k);
            cx += pos.getX(vi);
            cz += pos.getZ(vi);
          }
          cx /= 3;
          cz /= 3;
          // mesh local: x/z plane; plan y = -(local z) — lake centered at w
          if (pointInRing(ring, w.x + cx, w.y + cz)) kept.push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
        }
        geo.setIndex(kept);
      }
      const mat = makeWaterMaterial(opts.sunDir);
      mat.uniforms.shallow.value.setHex(opts.horizonColor);
      mat.uniforms.sunColor.value.setHex(opts.sunColor);
      const mesh = new Mesh(geo, mat);
      mesh.position.set(w.x, w.level, -w.y);
      mesh.name = "world-lake";
      group.add(mesh);
    } else if (w.type === "coast") {
      const g = plan.grid;
      const span = Math.max(g.width, g.height) * g.resolution * 2.2;
      const geo = new PlaneGeometry(span, span, 4, 4);
      geo.rotateX(-Math.PI / 2);
      const mat = makeWaterMaterial(opts.sunDir);
      mat.uniforms.shallow.value.setHex(opts.horizonColor);
      mat.uniforms.sunColor.value.setHex(opts.sunColor);
      const mesh = new Mesh(geo, mat);
      mesh.position.set(g.originX + (g.width * g.resolution) / 2, w.level, -(g.originY + (g.height * g.resolution) / 2));
      mesh.name = "world-coast";
      group.add(mesh);
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// vegetation (instanced, from plan placements)
// ---------------------------------------------------------------------------

function swayify(mat: MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 wpos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float wphase = wpos.x * 0.07 + wpos.y * 0.11;
          float sway = sin(uTime * 1.3 + wphase) * 0.5 + sin(uTime * 2.1 + wphase * 1.7) * 0.3;
          transformed.x += sway * max(0.0, transformed.y - 2.0) * 0.09;
          transformed.z += sway * max(0.0, transformed.y - 2.0) * 0.05;
        #endif`,
      );
  };
}

function buildVegetation(plan: WorldPlan, season: "summer" | "autumn", track?: Track): Group {
  const group = new Group();
  group.name = "world-vegetation";
  const autumn = season === "autumn";
  // Stage-A contract: the facility reservation excludes vegetation
  const exclusion = track?.facilities?.reservation?.vegetationExclusionPolygons ?? [];
  // hard rule: NOTHING grows inside the road corridor (platform + margin),
  // regardless of plan staleness after track morphs
  const prox = track ? makeTrackProximity(track.samples) : null;
  const corridorClear = (x: number, y: number): boolean => {
    if (!prox) return true;
    const near = prox.nearest(x, y, 46);
    return !near || near.d > 34; // platform max ~30 m incl. wide runoff
  };
  const veg = track
    ? {
        ...plan.vegetation,
        trees: plan.vegetation.trees.filter(
          (t) => corridorClear(t.x, t.y) && !exclusion.some((poly) => pointInPolygon({ x: t.x, y: t.y }, poly)),
        ),
        boulders: plan.vegetation.boulders.filter((b) => corridorClear(b.x, b.y)),
        tufts: plan.vegetation.tufts.filter((t) => {
          const near = prox!.nearest(t.x, t.y, 20);
          return !near || near.d > 8;
        }),
      }
    : plan.vegetation;

  if (veg.trees.length > 0) {
    const conifers = veg.trees.filter((t) => t.conifer);
    const leafies = veg.trees.filter((t) => !t.conifer);
    const trunkGeo = new CylinderGeometry(0.22, 0.34, 3.2, 5);
    trunkGeo.translate(0, 1.6, 0);
    const trunkMat = new MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });
    const coneGeo = new ConeGeometry(2.5, 8.5, 6);
    coneGeo.translate(0, 6.6, 0);
    const coneBase = autumn ? 0x7a5c22 : 0x3d6132;
    const leafBase = autumn ? 0xb87a2e : 0x517434;
    const coneMat = new MeshStandardMaterial({ color: coneBase, roughness: 1 });
    const leafGeo = new IcosahedronGeometry(3.4, 1);
    leafGeo.translate(0, 5.2, 0);
    leafGeo.scale(1, 1.25, 1);
    const leafMat = new MeshStandardMaterial({ color: leafBase, roughness: 1 });
    swayify(coneMat);
    swayify(leafMat);

    const rng = new Rng(plan.envSeed ^ 0x7717);
    const m4 = new Matrix4();
    const q = new Quaternion();
    const sv = new Vector3();
    const trunks = new InstancedMesh(trunkGeo, trunkMat, veg.trees.length);
    const cones = new InstancedMesh(coneGeo, coneMat, Math.max(1, conifers.length));
    const leaves = new InstancedMesh(leafGeo, leafMat, Math.max(1, leafies.length));
    let ti = 0;
    conifers.forEach((t, i) => {
      q.setFromAxisAngle(new Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m4.compose(new Vector3(t.x, t.z, -t.y), q, sv.setScalar(t.scale));
      trunks.setMatrixAt(ti++, m4);
      cones.setMatrixAt(i, m4);
      cones.setColorAt(i, new Color(coneBase).offsetHSL(t.autumnHue * 0.03, 0, (t.scale - 1) * 0.08));
    });
    leafies.forEach((t, i) => {
      q.setFromAxisAngle(new Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m4.compose(new Vector3(t.x, t.z, -t.y), q, sv.setScalar(t.scale));
      trunks.setMatrixAt(ti++, m4);
      leaves.setMatrixAt(i, m4);
      leaves.setColorAt(i, new Color(leafBase).offsetHSL(t.autumnHue * 0.05, 0, (t.scale - 1) * 0.07));
    });
    trunks.instanceMatrix.needsUpdate = true;
    cones.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (cones.instanceColor) cones.instanceColor.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    trunks.castShadow = cones.castShadow = leaves.castShadow = true;
    trunks.name = "world-trees-trunks";
    cones.name = "world-trees-conifer";
    leaves.name = "world-trees-leafy";
    group.add(trunks, cones, leaves);
  }

  if (veg.tufts.length > 0) {
    const tuftGeo = new ConeGeometry(0.5, 1.4, 4);
    tuftGeo.translate(0, 0.5, 0);
    const tuftMat = new MeshStandardMaterial({ color: autumn ? 0x8a722e : 0x4a6a2e, roughness: 1 });
    const inst = new InstancedMesh(tuftGeo, tuftMat, veg.tufts.length);
    const m4 = new Matrix4();
    const tq = new Quaternion();
    veg.tufts.forEach((t, i) => {
      tq.setFromAxisAngle(new Vector3(0, 1, 0), t.x * 0.7);
      m4.compose(new Vector3(t.x, t.z, -t.y), tq, new Vector3(t.scale, t.scale, t.scale));
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.name = "world-tufts";
    group.add(inst);
  }

  if (veg.boulders.length > 0) {
    const geo = new IcosahedronGeometry(1.6, 0);
    const mat = new MeshStandardMaterial({ color: 0x7a7268, roughness: 1 });
    const inst = new InstancedMesh(geo, mat, veg.boulders.length);
    const m4 = new Matrix4();
    const rng = new Rng(plan.envSeed ^ 0xb0b5);
    const bq = new Quaternion();
    veg.boulders.forEach((b, i) => {
      bq.setFromAxisAngle(new Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m4.compose(new Vector3(b.x, b.z - b.scale * 0.3, -b.y), bq, new Vector3(b.scale, b.scale * (0.55 + rng.next() * 0.4), b.scale));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, new Color(0x7a7268).offsetHSL(0, 0, rng.spread(0.08)));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true;
    inst.name = "world-boulders";
    group.add(inst);
  }

  return group;
}

// ---------------------------------------------------------------------------
// hero landmarks
// ---------------------------------------------------------------------------

function landmarkMesh(lm: Landmark, opts: WorldMeshOptions): Group | null {
  const g = new Group();
  const rng = new Rng(lm.seed);
  switch (lm.kind) {
    case "hero-tree":
    case "crest-tree": {
      const s = lm.scale * (lm.kind === "hero-tree" ? 1.25 : 1);
      const trunkMat = new MeshStandardMaterial({ color: 0x3e2f22, roughness: 1 });
      const trunk = new Mesh(new CylinderGeometry(0.5 * s, 1.1 * s, 9 * s, 7), trunkMat);
      trunk.position.y = 4.5 * s;
      trunk.castShadow = true;
      g.add(trunk);
      // major limbs
      const limbs = 4 + rng.int(0, 2);
      const limbMat = trunkMat;
      for (let k = 0; k < limbs; k++) {
        const a = (k / limbs) * Math.PI * 2 + rng.next();
        const limb = new Mesh(new CylinderGeometry(0.16 * s, 0.3 * s, 4.5 * s, 5), limbMat);
        limb.position.set(Math.cos(a) * 1.6 * s, 7.2 * s, Math.sin(a) * 1.6 * s);
        limb.rotation.z = Math.cos(a) * 1.05;
        limb.rotation.x = -Math.sin(a) * 1.05;
        g.add(limb);
      }
      const canopyMat = new MeshStandardMaterial({
        color: opts.season === "autumn" ? 0xa8642a : 0x3f6830,
        roughness: 1,
      });
      const canopy = new Mesh(new IcosahedronGeometry(4.2 * s, 1), canopyMat);
      canopy.position.y = 9.6 * s;
      canopy.scale.set(1.25, 0.75, 1.25);
      canopy.castShadow = true;
      g.add(canopy);
      const canopy2 = new Mesh(new IcosahedronGeometry(2.6 * s, 1), canopyMat);
      canopy2.position.y = 11.4 * s;
      canopy2.castShadow = true;
      g.add(canopy2);
      break;
    }
    case "forest-tunnel": {
      // arching grove: two dense tree rows leaning over the road
      const mat = new MeshStandardMaterial({ color: opts.season === "autumn" ? 0x9a6224 : 0x2f5226, roughness: 1 });
      const trunkMat2 = new MeshStandardMaterial({ color: 0x3e2f22, roughness: 1 });
      const len = 90 * lm.scale;
      const dir = new Vector3(Math.cos(lm.heading), 0, -Math.sin(lm.heading));
      const nrm = new Vector3(-Math.sin(lm.heading), 0, -Math.cos(lm.heading));
      const count = 14;
      const trunks = new InstancedMesh(new CylinderGeometry(0.3, 0.5, 7, 5), trunkMat2, count * 2);
      const canopy = new InstancedMesh(new IcosahedronGeometry(3.6, 1), mat, count * 2);
      const m4 = new Matrix4();
      let idx = 0;
      for (let k = 0; k < count; k++) {
        for (const side of [-1, 1]) {
          const along = (k / count - 0.5) * len;
          const wx = lm.x + dir.x * along + nrm.x * side * 8.5;
          const wy = lm.y + dir.z * along + nrm.z * side * 8.5;
          m4.makeRotationZ(side * -0.35).setPosition(wx, lm.z, -wy);
          trunks.setMatrixAt(idx, m4);
          m4.makeRotationZ(side * -0.5).setPosition(wx - nrm.x * side * 2.2, lm.z + 7.5, -wy + nrm.z * side * 2.2);
          canopy.setMatrixAt(idx, m4);
          idx++;
        }
      }
      trunks.instanceMatrix.needsUpdate = true;
      canopy.instanceMatrix.needsUpdate = true;
      g.add(trunks, canopy);
      return g; // already positioned in world coords
    }
    case "monolith": {
      const mat = new MeshStandardMaterial({ color: 0x5c544c, roughness: 1 });
      const h = 14 * lm.scale;
      const rock = new Mesh(new CylinderGeometry(1.2 * lm.scale, 3.2 * lm.scale, h, 6), mat);
      rock.position.y = h / 2 - 1;
      rock.rotation.y = lm.heading;
      rock.rotation.z = rng.spread(0.08);
      rock.castShadow = true;
      g.add(rock);
      const cap = new Mesh(new IcosahedronGeometry(2.2 * lm.scale, 0), mat);
      cap.position.y = h - 0.5;
      g.add(cap);
      break;
    }
    case "waterfall": {
      const mat = new MeshStandardMaterial({
        color: 0xcfe4ee,
        roughness: 0.3,
        metalness: 0,
        transparent: true,
        opacity: 0.85,
      });
      const h = 6 * lm.scale + 3;
      const fall = new Mesh(new PlaneGeometry(3.5, h), mat);
      fall.position.y = h / 2;
      fall.rotation.y = -lm.heading;
      g.add(fall);
      const foam = new Mesh(new SphereGeometry(2.2, 8, 6), mat);
      foam.position.y = 0.2;
      foam.scale.set(1.4, 0.4, 1.4);
      g.add(foam);
      break;
    }
    case "rock-arch": {
      const mat = new MeshStandardMaterial({ color: 0x6a5f50, roughness: 1 });
      const arch = new Mesh(new TorusGeometry(9 * lm.scale, 2.4 * lm.scale, 7, 14, Math.PI), mat);
      arch.rotation.y = lm.heading + Math.PI / 2;
      arch.castShadow = true;
      g.add(arch);
      break;
    }
    case "ruin": {
      const mat = new MeshStandardMaterial({ color: 0x7d7668, roughness: 1 });
      const w = 6 * lm.scale;
      const wall1 = new Mesh(new PlaneGeometry(w, 3.2 * lm.scale), mat);
      wall1.position.y = 1.6 * lm.scale;
      wall1.castShadow = true;
      g.add(wall1);
      const wall2 = wall1.clone();
      wall2.rotation.y = Math.PI / 2;
      wall2.position.set(1.4, 1.1 * lm.scale, 0);
      wall2.scale.y = 0.7;
      g.add(wall2);
      break;
    }
    case "viewing-platform":
    case "cliff-wall":
    default:
      return null;
  }
  g.position.set(lm.x, lm.z, -lm.y);
  g.rotation.y = lm.kind === "hero-tree" || lm.kind === "crest-tree" ? lm.heading : 0;
  g.name = `landmark-${lm.kind}`;
  return g;
}

function buildLandmarks(plan: WorldPlan, opts: WorldMeshOptions): Group {
  const group = new Group();
  group.name = "world-landmarks";
  for (const lm of plan.landmarks) {
    const m = landmarkMesh(lm, opts);
    if (m) group.add(m);
  }
  return group;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export function buildWorldMeshes(plan: WorldPlan, track: Track, opts: WorldMeshOptions): Group {
  const group = new Group();
  group.name = "world";
  const terrain = buildWorldTerrainMesh(plan, opts);
  group.add(terrain);
  const boundary = buildBoundaryMesh(plan);
  if (boundary) group.add(boundary);
  const apron = buildFarApron(plan, opts);
  if (apron) group.add(apron);
  group.add(buildWaterMeshes(plan, opts));
  group.add(buildVegetation(plan, opts.season, track));
  group.add(buildLandmarks(plan, opts));
  void track;
  return group;
}
