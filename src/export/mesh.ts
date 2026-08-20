/**
 * Shared 3D mesh builder for the track ribbon (used by the Three.js view
 * and the OBJ/GLB/Blender exports). Banking rotates edge offsets about
 * the local tangent axis.
 *
 * Column layout per station (left to right):
 *   runoff, curb, white line, [asphalt], white line, curb, runoff
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
  /** u = distance along lap / 8 m stripe period, v = across the ribbon. */
  uvs: Float32Array;
  indices: Uint32Array;
  parts: MeshPart[];
}

const LINE_WIDTH = 0.32; // white edge line width, meters
const LINE_INSET = 0.18; // from asphalt edge

/**
 * Kerb placement mask, derived from the corner data so it recomputes on
 * every rebuild. Real kerbs only exist where a car would use them:
 *   inside at/around the apex (clipping), outside through the exit
 *   (running wide) -- and only at slow/medium corners, not sweepers.
 */
function curbMasks(track: Track, nIdx: number[], n: number): { left: boolean[]; right: boolean[] } {
  const left = new Array<boolean>(track.samples.length).fill(false);
  const right = new Array<boolean>(track.samples.length).fill(false);
  const total = track.samples.length;
  const mark = (arr: boolean[], fromIdx: number, toIdx: number) => {
    let i = ((fromIdx % total) + total) % total;
    const end = ((toIdx % total) + total) % total;
    let guard = 0;
    while (guard++ <= total) {
      arr[i] = true;
      if (i === end) break;
      i = (i + 1) % total;
    }
  };
  for (const c of track.corners) {
    if (c.minRadius > 250) continue; // sweepers: no kerb contact
    const apexI = Math.round(c.sApex / track.ds) % total;
    const startI = Math.round(c.sStart / track.ds) % total;
    const endI = Math.round(c.sEnd / track.ds) % total;
    const runLen = ((endI - startI) % total + total) % total;
    const apexOff = ((apexI - startI) % total + total) % total;
    const inside = c.direction === "L" ? left : right;
    const outside = c.direction === "L" ? right : left;
    // inside: from 40% before apex to 55% past it
    mark(
      inside,
      (startI + Math.max(0, apexOff - runLen * 0.4)) % total,
      (startI + Math.min(runLen, apexOff + runLen * 0.55) + Math.round(8 / track.ds)) % total,
    );
    // outside: from just before apex through exit + ~14 m
    mark(
      outside,
      (startI + Math.max(0, apexOff - runLen * 0.1)) % total,
      (endI + Math.round(14 / track.ds)) % total,
    );
  }
  void nIdx;
  void n;
  return { left, right };
}

/**
 * Build the track ribbon mesh: asphalt, edge lines, curb strips, runoff.
 * Closed loop: last row connects back to first.
 */
export function buildTrackMesh(track: Track, opts: TrackMeshOptions): TrackMeshData {
  const stride = Math.max(1, opts.stride);
  const n = track.samples.length;
  const idxList: number[] = [];
  for (let i = 0; i < n; i += stride) idxList.push(i);
  const m = idxList.length;
  const masks = curbMasks(track, idxList, m);

  const curb = Math.max(0, opts.curbWidth);
  const runoff = Math.max(0, opts.runoffWidth);
  // lateral offsets from center (left positive), left to right
  const cols = 8;
  const positions = new Float32Array(m * cols * 3);
  const normals = new Float32Array(m * cols * 3);
  const uvs = new Float32Array(m * cols * 2);

  for (let r = 0; r < m; r++) {
    const si = idxList[r];
    const s = track.samples[si];
    const cosB = Math.cos(s.bank);
    const sinB = Math.sin(s.bank);
    const halfW = s.width / 2;
    // where a kerb is absent the curb column collapses onto the edge line
    // (zero-width strip = invisible) and the runoff band covers the gap
    const curbL = masks.left[si];
    const curbR = masks.right[si];
    const curbOuterL = curbL ? halfW + curb : halfW - LINE_INSET;
    const curbOuterR = curbR ? -(halfW + curb) : -(halfW - LINE_INSET);
    const offs = [
      halfW + curb + runoff,
      curbOuterL,
      halfW - LINE_INSET,
      halfW - LINE_INSET - LINE_WIDTH,
      -(halfW - LINE_INSET - LINE_WIDTH),
      -(halfW - LINE_INSET),
      curbOuterR,
      -(halfW + curb + runoff),
    ];
    for (let c = 0; c < cols; c++) {
      const off = offs[c];
      const lx = -Math.sin(s.heading) * off * cosB;
      const ly = Math.cos(s.heading) * off * cosB;
      const lz = -off * sinB;
      let extraZ = 0;
      if ((c === 1 && curbL) || (c === 6 && curbR)) extraZ = 0.05; // raised kerb
      if (c === 2 || c === 5) extraZ = 0.015; // lines a hair above asphalt
      if (c === 0 || c === 7) extraZ = -0.06; // runoff drops away
      const vi = (r * cols + c) * 3;
      positions[vi] = s.x + lx;
      positions[vi + 1] = s.y + ly;
      positions[vi + 2] = s.z + lz + extraZ;
      normals[vi] = -sinB * -Math.sin(s.heading);
      normals[vi + 1] = -sinB * Math.cos(s.heading);
      normals[vi + 2] = cosB;
      uvs[(r * cols + c) * 2] = (idxList[r] * track.ds) / 8;
      uvs[(r * cols + c) * 2 + 1] = c / (cols - 1);
    }
  }

  const partNames = [
    "runoff_left",
    "curb_left",
    "line_left",
    "asphalt",
    "line_right",
    "curb_right",
    "runoff_right",
  ];
  const grouped: number[][] = [[], [], [], [], [], [], []];
  for (let i = 0; i < m; i++) {
    const i2 = (i + 1) % m;
    for (let band = 0; band < cols - 1; band++) {
      const a = i * cols + band;
      const b = i * cols + band + 1;
      const c = i2 * cols + band;
      const d = i2 * cols + band + 1;
      grouped[band].push(a, c, b, b, c, d);
    }
  }
  const allIndices: number[] = [];
  const parts: MeshPart[] = [];
  for (let p = 0; p < partNames.length; p++) {
    parts.push({ name: partNames[p], start: allIndices.length, count: grouped[p].length });
    allIndices.push(...grouped[p]);
  }

  return {
    positions,
    normals,
    uvs,
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
