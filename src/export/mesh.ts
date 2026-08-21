/**
 * Shared 3D mesh builder for the track ribbon (used by the Three.js view
 * and the OBJ/GLB/Blender exports).
 *
 * The ribbon is heterogeneous: asymmetric half-widths, per-sample surface
 * / kerb / runoff kinds, and barrier walls. Parts are bucketed by
 * (band, kind) so the renderer can assign real materials per run.
 *
 * Column layout per station (left to right):
 *   runoff, kerb, white line, [asphalt], white line, kerb, runoff
 */

import { KerbKind, RunoffKind, SurfaceKind } from "../core/character";
import type { Track } from "../core/types";

export interface TrackMeshOptions {
  curbWidth: number; // legacy fallback when no props
  runoffWidth: number;
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
  /** per-vertex color tint (surface mottling etc.) */
  colors: Float32Array;
  indices: Uint32Array;
  parts: MeshPart[];
}

const LINE_WIDTH = 0.32;
const LINE_INSET = 0.18;

/** structure kind per sample, derived from track.structures (cached). */
const structCache = new WeakMap<Track, Int8Array>();
function structureAt(track: Track): Int8Array {
  let out = structCache.get(track);
  if (out) return out;
  const n = track.samples.length;
  out = new Int8Array(n);
  for (const sp of track.structures ?? []) {
    const code = sp.kind === "bridge" ? 1 : sp.kind === "tunnel" ? 2 : sp.kind === "rock-cut" ? 3 : sp.kind === "retaining" ? 4 : 5;
    const i0 = Math.round(sp.sStart / track.ds) % n;
    const i1 = Math.round(sp.sEnd / track.ds) % n;
    let i = i0;
    let guard = 0;
    while (i !== i1 && guard++ < n) {
      out[i] = code;
      i = (i + 1) % n;
    }
  }
  structCache.set(track, out);
  return out;
}

const KERB_WIDTH: Record<number, number> = {
  [KerbKind.None]: 0,
  [KerbKind.FlatPainted]: 0.7,
  [KerbKind.Standard]: 1.3,
  [KerbKind.Aggressive]: 1.7,
  [KerbKind.Sausage]: 1.0,
  [KerbKind.OldLow]: 0.9,
  [KerbKind.High]: 1.2,
};
const KERB_LIFT: Record<number, number> = {
  [KerbKind.None]: 0,
  [KerbKind.FlatPainted]: 0.006,
  [KerbKind.Standard]: 0.05,
  [KerbKind.Aggressive]: 0.13,
  [KerbKind.Sausage]: 0.16,
  [KerbKind.OldLow]: 0.02,
  [KerbKind.High]: 0.11,
};

/** Base tint per surface kind (multiplied into material color). */
export const SURFACE_TINT: Record<number, [number, number, number]> = {
  [SurfaceKind.ModernAsphalt]: [1.0, 1.0, 1.0],
  [SurfaceKind.AgedAsphalt]: [1.22, 1.2, 1.16], // faded = lighter
  [SurfaceKind.Concrete]: [1.85, 1.82, 1.72],
  [SurfaceKind.PatchedMix]: [0.92, 0.92, 0.9],
};

export function buildTrackMesh(track: Track, opts: TrackMeshOptions): TrackMeshData {
  const stride = Math.max(1, opts.stride);
  const n = track.samples.length;
  const idxList: number[] = [];
  for (let i = 0; i < n; i += stride) idxList.push(i);
  const m = idxList.length;

  const props = track.props;
  const curbFallback = Math.max(0, opts.curbWidth);
  const runoffFallback = Math.max(0, opts.runoffWidth);

  const cols = 8;
  const positions = new Float32Array(m * cols * 3);
  const normals = new Float32Array(m * cols * 3);
  const uvs = new Float32Array(m * cols * 2);
  const colors = new Float32Array(m * cols * 3);
  // kind key per station per band: [kerbL, line, asphalt, runoff, kerbR...]
  const kerbAt = (i: number, side: "L" | "R"): number =>
    props ? (side === "L" ? props.kerbL[i] : props.kerbR[i]) : KerbKind.Standard;
  const runoffAt = (i: number, side: "L" | "R"): number =>
    props ? (side === "L" ? props.runoffL[i] : props.runoffR[i]) : RunoffKind.Grass;
  const surfaceAt = (i: number): number => (props ? props.surface[i] : SurfaceKind.ModernAsphalt);
  const roughAt = (i: number): number => (props ? props.roughness[i] : 0.2);
  const halfL = (i: number) => (props ? props.widthL[i] : track.samples[i].width / 2);
  const halfR = (i: number) => (props ? props.widthR[i] : track.samples[i].width / 2);
  const runoffWL = (i: number) => (props ? props.runoffWidthL[i] : runoffFallback);
  const runoffWR = (i: number) => (props ? props.runoffWidthR[i] : runoffFallback);

  // seeded low-frequency mottle for pavement texture (deterministic)
  const motK1 = 1.7 + ((track.seed % 17) / 17) * 1.6;
  const motK2 = 4.3 + ((track.seed % 31) / 31) * 2.4;
  const motP1 = (track.seed % 251) * 0.13;
  const motP2 = (track.seed % 197) * 0.21;
  const mottle = (i: number, rough: number): number => {
    const t = (i / m) * Math.PI * 2;
    const low = 0.5 * Math.sin(motK1 * t + motP1) + 0.5 * Math.sin(motK2 * t + motP2);
    return 1 + low * (0.05 + rough * 0.14);
  };

  // ---- micro scale: transverse pavement seams + slab joints + micro bumps ---
  // asphalt gets a tar seam every ~28 m, concrete slab joints every 6 m,
  // patched mix gets irregular seams. One station wide, subtle darkening.
  const seamAt = (i: number, surf: number): number => {
    const sM = i * track.ds;
    if (surf === SurfaceKind.Concrete) {
      return sM % 6 < track.ds ? 0.86 : 1;
    }
    if (surf === SurfaceKind.PatchedMix) {
      const period = 34 + ((track.seed >> 3) % 19);
      return sM % period < track.ds ? 0.8 : 1;
    }
    // asphalt: modern gets crisp joints, aged gets cracked irregular seams
    const period = surf === SurfaceKind.AgedAsphalt ? 22 + ((track.seed >> 5) % 13) : 28;
    return sM % period < track.ds ? (surf === SurfaceKind.AgedAsphalt ? 0.84 : 0.9) : 1;
  };
  // per-station micro bump (visual only; +-2.2 cm scaled by roughness)
  const bumpAt = (i: number, rough: number): number => {
    const v = Math.sin(i * 78.233 + track.seed * 0.371) * 43758.5453;
    const f = v - Math.floor(v) - 0.5;
    return f * 0.045 * (0.3 + rough);
  };

  // ---- racing-line rubber: a dark band that straightens the corners --------
  // precompute the rubber line's lateral offset per station: outside before
  // the apex, inside at the apex, outside at the exit (classic race line)
  const rubberOff = new Float32Array(m);
  const rubberAmt = new Float32Array(m).fill(0.35); // baseline highway polish
  {
    const corners = track.corners ?? [];
    for (const c of corners) {
      const iA = Math.round(c.sStart / track.ds) % n;
      const iX = Math.round(c.sApex / track.ds) % n;
      const iB = Math.round(c.sEnd / track.ds) % n;
      const dir = c.direction === "L" ? 1 : -1; // left-positive offsets
      const severity = Math.min(1, 90 / Math.max(18, c.minRadius));
      const out = -dir * 0.52; // fraction of half width toward the outside
      const inn = dir * 0.58; // toward the inside at the apex
      const visit = (i0: number, i1: number, f0: number, f1: number) => {
        const len = ((i1 - i0) % n + n) % n || 1;
        let i = i0;
        for (let k = 0; k <= len; k++) {
          const ii = i % n;
          const t = k / len;
          rubberOff[ii] = (f0 + (f1 - f0) * t) * (halfL(ii) + halfR(ii)) * 0.5;
          rubberAmt[ii] = Math.max(rubberAmt[ii], 0.35 + 0.55 * severity);
          i++;
        }
      };
      // approach (outside), entry->apex (cross to inside), apex->exit (back out)
      const iAppr = (iA - Math.round(60 / track.ds) + n) % n;
      visit(iAppr, iA, 0, out);
      visit(iA, iX, out, inn);
      visit(iX, iB, inn, out);
      visit(iB, (iB + Math.round(40 / track.ds)) % n, out, 0);
      // skid marks: extra dark patches on corner entry (heavy braking)
      if (severity > 0.55) {
        const s0 = (iA - Math.round(38 / track.ds) + n) % n;
        const s1 = iA;
        const len = ((s1 - s0) % n + n) % n || 1;
        let i = s0;
        for (let k = 0; k <= len; k++) {
          const ii = i % n;
          // skids sit slightly outside the rubber line
          rubberOff[ii] = rubberOff[ii] * 0.85;
          rubberAmt[ii] = Math.min(1, rubberAmt[ii] + 0.18 * (k / len));
          i++;
        }
      }
    }
  }
  const rubberShade = (off: number, i: number): number => {
    // gaussian darkening around the rubber line
    const d = off - rubberOff[i];
    const g = Math.exp(-(d * d) / (2 * 1.15 * 1.15));
    return 1 - g * 0.22 * rubberAmt[i];
  };

  for (let r = 0; r < m; r++) {
    const si = idxList[r];
    const s = track.samples[si];
    const cosB = Math.cos(s.bank);
    const sinB = Math.sin(s.bank);
    const kL = kerbAt(si, "L");
    const kR = kerbAt(si, "R");
    const kerbWL = KERB_WIDTH[kL] || curbFallback;
    const kerbWR = KERB_WIDTH[kR] || curbFallback;
    const wL = halfL(si);
    const wR = halfR(si);
    const roL = runoffWL(si);
    const roR = runoffWR(si);
    // wall runoff: the strip narrows to a concrete pad.
    // bridge decks / tunnels: no overhanging grass -- a narrow concrete pad
    const struct = structureAt(track)[si];
    const onDeck = struct === 1 || struct === 2;
    let roEffL = runoffAt(si, "L") === RunoffKind.Wall ? Math.min(roL, 2.5) : roL;
    let roEffR = runoffAt(si, "R") === RunoffKind.Wall ? Math.min(roR, 2.5) : roR;
    if (onDeck) {
      roEffL = Math.min(roEffL, 1.1);
      roEffR = Math.min(roEffR, 1.1);
    }
    // absent kerb: kerb column collapses onto the edge line (zero-width)
    const kerbOuterL = kL === KerbKind.None ? wL - LINE_INSET : wL + kerbWL;
    const kerbOuterR = kR === KerbKind.None ? -(wR - LINE_INSET) : -(wR + kerbWR);
    const offs = [
      wL + kerbWL + roEffL,
      kerbOuterL,
      wL - LINE_INSET,
      wL - LINE_INSET - LINE_WIDTH,
      -(wR - LINE_INSET - LINE_WIDTH),
      -(wR - LINE_INSET),
      kerbOuterR,
      -(wR + kerbWR + roEffR),
    ];
    const tint = SURFACE_TINT[surfaceAt(si)] ?? [1, 1, 1];
    const mot = mottle(si, roughAt(si)) * seamAt(si, surfaceAt(si));
    const bump = bumpAt(si, roughAt(si));
    for (let c = 0; c < cols; c++) {
      const off = offs[c];
      const lx = -Math.sin(s.heading) * off * cosB;
      const ly = Math.cos(s.heading) * off * cosB;
      const lz = -off * sinB;
      let extraZ = 0;
      // aggressive/sausage kerbs are castellated: alternating tall blocks
      if (c === 1) {
        let lift = KERB_LIFT[kL] ?? 0;
        if ((kL === KerbKind.Aggressive || kL === KerbKind.Sausage) && r % 2 === 1) lift *= 0.4;
        extraZ = lift;
      }
      if (c === 6) {
        let lift = KERB_LIFT[kR] ?? 0;
        if ((kR === KerbKind.Aggressive || kR === KerbKind.Sausage) && r % 2 === 1) lift *= 0.4;
        extraZ = lift;
      }
      if (c === 2 || c === 5) extraZ = 0.015;
      if (c === 0 || c === 7) extraZ = -0.05;
      // micro bumps only on the drivable bands (asphalt + kerbs), not runoff
      if (c >= 1 && c <= 6) extraZ += bump;
      const vi = (r * cols + c) * 3;
      positions[vi] = s.x + lx;
      positions[vi + 1] = s.y + ly;
      positions[vi + 2] = s.z + lz + extraZ;
      normals[vi] = -sinB * -Math.sin(s.heading);
      normals[vi + 1] = -sinB * Math.cos(s.heading);
      normals[vi + 2] = cosB;
      uvs[(r * cols + c) * 2] = (si * track.ds) / 6;
      uvs[(r * cols + c) * 2 + 1] = c / (cols - 1);
      // colors: asphalt band carries surface tint + mottle
      const ci = (r * cols + c) * 3;
      if (c === 3 || c === 4) {
        const rs = rubberShade(off, r);
        colors[ci] = tint[0] * mot * rs;
        colors[ci + 1] = tint[1] * mot * rs;
        colors[ci + 2] = tint[2] * mot * rs;
      } else {
        colors[ci] = 1;
        colors[ci + 1] = 1;
        colors[ci + 2] = 1;
      }
    }
  }

  // bucket quads by (band, kind) so the renderer assigns real materials
  const bandNames = ["runoff", "kerb", "line", "asphalt", "line", "kerb", "runoff"];
  const bandSides = ["left", "left", "left", "", "right", "right", "right"];
  const kindOf = (band: number, si: number): number => {
    switch (bandNames[band]) {
      case "kerb":
        return kerbAt(si, bandSides[band] === "left" ? "L" : "R");
      case "runoff": {
        if (structureAt(track)[si] === 1 || structureAt(track)[si] === 2) return RunoffKind.Wall; // concrete pad on decks
        return runoffAt(si, bandSides[band] === "left" ? "L" : "R");
      }
      case "asphalt":
        return surfaceAt(si);
      default:
        return 0;
    }
  };
  const kindNames: Record<string, Record<number, string>> = {
    kerb: { 0: "none", 1: "flat", 2: "standard", 3: "aggressive", 4: "sausage", 5: "oldlow", 6: "high" },
    runoff: { 0: "grass", 1: "gravel", 2: "asphalt", 3: "wall", 4: "shoulder" },
    asphalt: { 0: "modern", 1: "aged", 2: "concrete", 3: "patched" },
  };

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < m; i++) {
    const i2 = (i + 1) % m;
    const si = idxList[i];
    for (let band = 0; band < cols - 1; band++) {
      const bandName = bandNames[band];
      if (bandName === "kerb" && kindOf(band, si) === KerbKind.None) continue; // absent
      const kindLabel = kindNames[bandName]?.[kindOf(band, si)] ?? "default";
      const side = bandSides[band];
      const key = side ? `${bandName}_${side}:${kindLabel}` : `${bandName}:${kindLabel}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      const a = i * cols + band;
      const b = i * cols + band + 1;
      const c = i2 * cols + band;
      const d = i2 * cols + band + 1;
      bucket.push(a, c, b, b, c, d);
    }
  }
  // deterministic part order
  const allIndices: number[] = [];
  const parts: MeshPart[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    parts.push({ name: key, start: allIndices.length, count: bucket.length });
    allIndices.push(...bucket);
  }

  return {
    positions,
    normals,
    uvs,
    colors,
    indices: Uint32Array.from(allIndices),
    parts,
  };
}

// ---------------------------------------------------------------------------
// Barrier walls
// ---------------------------------------------------------------------------

export interface SimpleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Vertical barrier ribbons where barriers stand close (armco / walls).
 * Returns left/right meshes (null when no barrier on that side).
 */
export function buildBarrierMeshes(track: Track): { left: SimpleMesh | null; right: SimpleMesh | null } {
  const props = track.props;
  if (!props) return { left: null, right: null };
  return {
    left: buildBarrierSide(track, "left"),
    right: buildBarrierSide(track, "right"),
  };
}

function buildBarrierSide(track: Track, side: "left" | "right"): SimpleMesh | null {
  const props = track.props!;
  const n = track.samples.length;
  const dist = side === "left" ? props.barrierDistL : props.barrierDistR;
  const runoffW = side === "left" ? props.runoffWidthL : props.runoffWidthR;
  const halfW = side === "left" ? props.widthL : props.widthR;
  const isWall = side === "left" ? props.runoffL : props.runoffR;

  const verts: number[] = [];
  const indices: number[] = [];
  let runActive = false;
  const H = 1.0;

  const struct = structureAt(track);
  const offsetAt = (i: number): number => {
    const sign = side === "left" ? 1 : -1;
    if (struct[i] === 1) return sign * (halfW[i] + 1.35); // bridge parapet at the deck edge
    if (isWall[i] === RunoffKind.Wall) return sign * (halfW[i] + 2.6);
    return sign * (halfW[i] + 1.4 + runoffW[i] + dist[i]);
  };

  for (let i = 0; i <= n; i++) {
    const si = i % n;
    const wall = isWall[si] === RunoffKind.Wall;
    const active = wall || dist[si] < 16 || struct[si] === 1;
    if (!active) {
      runActive = false;
      continue;
    }
    const s = track.samples[si];
    const nx = -Math.sin(s.heading);
    const ny = Math.cos(s.heading);
    const off = offsetAt(si);
    const px = s.x + nx * off;
    const py = s.y + ny * off;
    const pz = s.z - off * Math.sin(s.bank);
    verts.push(px, py, pz, px, py, pz + H);
    const vi = verts.length / 3 - 2;
    if (runActive) {
      // perimeter: prev-bottom a, prev-top b, cur-top d, cur-bottom c
      const a = vi - 2;
      const b = vi - 1;
      const c = vi;
      const d = vi + 1;
      indices.push(a, b, d, a, d, c);
    }
    runActive = true;
  }
  if (indices.length === 0) return null;
  return { positions: Float32Array.from(verts), indices: Uint32Array.from(indices) };
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
