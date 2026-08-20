/**
 * Shared 3D mesh builder for the track ribbon (used by the Three.js view
 * and the OBJ/GLB/Blender exports). Banking rotates edge offsets about
 * the local tangent axis.
 */

import type { Track } from "../core/types";

export interface TrackMeshOptions {
  /** Curb strip width beyond the asphalt edge, meters (0 = none). */
  curbWidth: number;
  /** Runoff skirt width beyond curbs, meters (0 = none). */
  runoffWidth: number;
  /** Sample stride (1 = every sample). */
  stride: number;
}

export interface MeshPart {
  name: string;
  /** Starting index into `indices`. */
  start: number;
  /** Number of indices. */
  count: number;
}

export interface TrackMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  parts: MeshPart[];
}

interface StripRow {
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  width: number;
  bank: number;
}

/**
 * Build the track ribbon mesh: asphalt, curb strips, runoff skirt.
 * Closed loop: last row connects back to first.
 */
export function buildTrackMesh(track: Track, opts: TrackMeshOptions): TrackMeshData {
  const stride = Math.max(1, opts.stride);
  const rows: StripRow[] = [];
  const n = track.samples.length;
  for (let i = 0; i < n; i += stride) {
    const s = track.samples[i];
    rows.push({
      cx: s.x,
      cy: s.y,
      cz: s.z,
      nx: -Math.sin(s.heading),
      ny: Math.cos(s.heading),
      width: s.width,
      bank: s.bank,
    });
  }
  const m = rows.length;

  // vertex columns per row: [runoffL, curbL, edgeL, edgeR, curbR, runoffR]
  const curb = Math.max(0, opts.curbWidth);
  const runoff = Math.max(0, opts.runoffWidth);
  const cols = 6;
  const positions = new Float32Array(m * cols * 3);
  const indices: number[] = [];

  for (let i = 0; i < m; i++) {
    const r = rows[i];
    const cosB = Math.cos(r.bank);
    const sinB = Math.sin(r.bank);
    // lateral offsets from center (left positive)
    const halfW = r.width / 2;
    const offs = [
      halfW + curb + runoff,
      halfW + curb,
      halfW,
      -halfW,
      -(halfW + curb),
      -(halfW + curb + runoff),
    ];
    for (let c = 0; c < cols; c++) {
      const off = offs[c];
      const lx = r.nx * off * cosB;
      const ly = r.ny * off * cosB;
      const lz = -off * sinB;
      // curbs slightly raised, runoff drops slightly
      let extraZ = 0;
      if (c === 1 || c === 4) extraZ = 0.04;
      if (c === 0 || c === 5) extraZ = -0.05;
      const vi = (i * cols + c) * 3;
      positions[vi] = r.cx + lx;
      positions[vi + 1] = r.cy + ly;
      positions[vi + 2] = r.cz + lz + extraZ;
    }
  }

  // parts: asphalt between cols 2..3, curbs 1..2 and 3..4, runoff 0..1 and 4..5
  const parts: MeshPart[] = [];
  const bandStart: number[] = [];
  for (let i = 0; i < m; i++) {
    const i2 = (i + 1) % m;
    for (let band = 0; band < cols - 1; band++) {
      const a = i * cols + band;
      const b = i * cols + band + 1;
      const c = i2 * cols + band;
      const d = i2 * cols + band + 1;
      bandStart.push(band);
      indices.push(a, c, b, b, c, d);
    }
  }
  // group indices by band type: [runoffL, curbL, asphalt, curbR, runoffR]
  const partNames = ["runoff_left", "curb_left", "asphalt", "curb_right", "runoff_right"];
  const grouped: number[][] = [[], [], [], [], []];
  for (let k = 0; k < indices.length; k += 6) {
    const band = bandStart[Math.floor(k / 6)]; // 0..4 maps directly to parts
    for (let t = 0; t < 6; t++) grouped[band].push(indices[k + t]);
  }
  const allIndices: number[] = [];
  for (let p = 0; p < 5; p++) {
    const start = allIndices.length;
    allIndices.push(...grouped[p]);
    parts.push({ name: partNames[p], start, count: grouped[p].length });
  }

  // normals: up-ish (banked)
  const normals = new Float32Array(m * cols * 3);
  for (let i = 0; i < m; i++) {
    const r = rows[i];
    const cosB = Math.cos(r.bank);
    const sinB = Math.sin(r.bank);
    for (let c = 0; c < cols; c++) {
      const vi = (i * cols + c) * 3;
      normals[vi] = -sinB * r.nx;
      normals[vi + 1] = -sinB * r.ny;
      normals[vi + 2] = cosB;
    }
  }

  return {
    positions,
    normals,
    indices: Uint32Array.from(allIndices),
    parts,
  };
}

/** Simple grid mesh from a terrain sampler, for scene/export. */
export function buildGridMesh(
  sampler: (x: number, y: number) => number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  nx: number,
  ny: number,
): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(nx * ny * 3);
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = minX + ((maxX - minX) * ix) / (nx - 1);
      const y = minY + ((maxY - minY) * iy) / (ny - 1);
      const z = sampler(x, y);
      const vi = (iy * nx + ix) * 3;
      positions[vi] = x;
      positions[vi + 1] = y;
      positions[vi + 2] = Number.isFinite(z) ? z : 0;
    }
  }
  let ii = 0;
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iy * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }
  return { positions, indices };
}
