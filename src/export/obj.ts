/**
 * OBJ export: generic mesh interchange. Objects split by part+kind
 * (asphalt surface types / kerb kinds / runoff kinds / barriers / terrain).
 */

import { buildBarrierMeshes, buildGridMesh, buildTrackMesh } from "./mesh";
import { carveSampler, type TerrainSurface } from "../core/terrain";
import { buildStructureMeshes, buildFeatureMeshes } from "./structuresMesh";
import { worldExportParts } from "../core/world/exportGeometry";
import type { Track } from "../core/types";

export interface ObjOptions {
  terrain?: TerrainSurface | null;
  terrainExtent?: number;
  world?: import("../core/world/types").WorldPlan | null;
}

export function trackToObj(track: Track, opts: ObjOptions = {}): string {
  const out: string[] = [];
  out.push("# grandprix-gen track export");
  out.push(`# seed ${track.seed} length ${(track.length / 1000).toFixed(3)} km era ${track.identity?.era}`);
  out.push("mtllib track.mtl");

  const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });
  let vOffset = 1; // OBJ is 1-indexed

  const emitPart = (name: string, positions: Float32Array, indices: Uint32Array, start: number, count: number) => {
    out.push(`o ${name.replace(/[^a-zA-Z0-9_]/g, "_")}`);
    out.push(`usemtl ${name.replace(/[^a-zA-Z0-9_]/g, "_")}`);
    const used = new Set<number>();
    for (let i = start; i < start + count; i++) used.add(indices[i]);
    const remap = new Map<number, number>();
    const verts = [...used].sort((a, b) => a - b);
    for (const v of verts) {
      const px = positions[v * 3];
      const py = positions[v * 3 + 1];
      const pz = positions[v * 3 + 2];
      out.push(`v ${px.toFixed(4)} ${pz.toFixed(4)} ${(-py).toFixed(4)}`); // y-up
      remap.set(v, vOffset++);
    }
    for (const v of verts) {
      void v;
      out.push(`vn 0 1 0`);
    }
    for (let i = start; i < start + count; i += 3) {
      const a = remap.get(indices[i])!;
      const b = remap.get(indices[i + 1])!;
      const c = remap.get(indices[i + 2])!;
      out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  };

  for (const part of mesh.parts) {
    if (part.count === 0) continue;
    emitPart(part.name, mesh.positions, mesh.indices, part.start, part.count);
  }

  // barriers
  const barriers = buildBarrierMeshes(track);
  for (const [side, bm] of [["left", barriers.left], ["right", barriers.right]] as const) {
    if (!bm) continue;
    emitPart(`barrier_${side}`, bm.positions, bm.indices, 0, bm.indices.length);
  }

  // structures + feature geometry (bridges, tunnels, walls, pit lane...)
  {
    const groundSampler = opts.terrain
      ? (x: number, y: number) => opts.terrain!.elevationAt(x, y)
      : null;
    for (const part of [...buildStructureMeshes(track, groundSampler), ...buildFeatureMeshes(track)]) {
      emitPart(`structure_${part.name}`, part.positions, part.indices, 0, part.indices.length);
    }
  }

  if (opts.terrain) {
    const g = opts.terrain;
    const extent = opts.terrainExtent ?? Math.max(g.width, g.height) * g.resolution;
    const nx = Math.min(256, g.width);
    const ny = Math.min(256, g.height);
    const sampler = carveSampler(g, track.samples, track.carveMask, 40, 120, track.carveInner);
    const mesh2 = buildGridMesh(
      sampler,
      g.originX,
      g.originY,
      g.originX + Math.min(extent, (g.width - 1) * g.resolution),
      g.originY + Math.min(extent, (g.height - 1) * g.resolution),
      nx,
      ny,
    );
    out.push("o terrain");
    out.push("usemtl terrain");
    for (let i = 0; i < mesh2.positions.length; i += 3) {
      out.push(
        `v ${mesh2.positions[i].toFixed(2)} ${mesh2.positions[i + 2].toFixed(2)} ${(-mesh2.positions[i + 1]).toFixed(2)}`,
      );
    }
    for (let i = 0; i < mesh2.indices.length; i += 3) {
      const a = mesh2.indices[i] + vOffset;
      const b = mesh2.indices[i + 1] + vOffset;
      const c = mesh2.indices[i + 2] + vOffset;
      out.push(`f ${a} ${b} ${c}`);
    }
    vOffset += mesh2.positions.length / 3;
  }

  if (opts.world) {
    for (const part of worldExportParts(opts.world)) {
      out.push(`o ${part.name}`);
      out.push("usemtl terrain");
      for (let i = 0; i < part.positions.length; i += 3) {
        out.push(
          `v ${part.positions[i].toFixed(2)} ${part.positions[i + 2].toFixed(2)} ${(-part.positions[i + 1]).toFixed(2)}`,
        );
      }
      for (let i = 0; i < part.indices.length; i += 3) {
        out.push(
          `f ${part.indices[i] + vOffset} ${part.indices[i + 1] + vOffset} ${part.indices[i + 2] + vOffset}`,
        );
      }
      vOffset += part.positions.length / 3;
    }
  }

  return out.join("\n") + "\n";
}

const SURF_MTL: Record<string, string> = {
  modern: "Kd 0.20 0.20 0.21",
  aged: "Kd 0.27 0.27 0.26",
  concrete: "Kd 0.58 0.57 0.54",
  patched: "Kd 0.24 0.24 0.23",
};

export function trackMtl(): string {
  const lines: string[] = ["# grandprix-gen materials"];
  for (const [k, v] of Object.entries(SURF_MTL)) {
    lines.push(`newmtl asphalt_${k}`);
    lines.push(v);
    lines.push("Ka 0.05 0.05 0.05");
    lines.push("Ks 0.04 0.04 0.04");
  }
  lines.push(
    `newmtl line_default\nKd 0.95 0.95 0.95`,
    `newmtl kerb_left_flat\nKd 0.85 0.83 0.80`,
    `newmtl kerb_right_flat\nKd 0.85 0.83 0.80`,
    `newmtl kerb_left_standard\nKd 0.76 0.23 0.18`,
    `newmtl kerb_right_standard\nKd 0.76 0.23 0.18`,
    `newmtl kerb_left_aggressive\nKd 0.83 0.33 0.0`,
    `newmtl kerb_right_aggressive\nKd 0.83 0.33 0.0`,
    `newmtl runoff_left_grass\nKd 0.26 0.35 0.18`,
    `newmtl runoff_right_grass\nKd 0.26 0.35 0.18`,
    `newmtl runoff_left_gravel\nKd 0.61 0.56 0.45`,
    `newmtl runoff_right_gravel\nKd 0.61 0.56 0.45`,
    `newmtl runoff_left_asphalt\nKd 0.33 0.33 0.35`,
    `newmtl runoff_right_asphalt\nKd 0.33 0.33 0.35`,
    `newmtl runoff_left_wall\nKd 0.53 0.51 0.48`,
    `newmtl runoff_right_wall\nKd 0.53 0.51 0.48`,
    `newmtl barrier_left\nKd 0.47 0.50 0.48`,
    `newmtl barrier_right\nKd 0.47 0.50 0.48`,
    `newmtl terrain\nKd 0.18 0.29 0.13`,
  );
  return lines.join("\n") + "\n";
}
