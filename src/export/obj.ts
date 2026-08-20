/**
 * OBJ export: generic mesh interchange. Objects split by part
 * (asphalt / curbs / runoff / terrain) with groups + materials.
 */

import { buildGridMesh, buildTrackMesh } from "./mesh";
import type { TerrainGrid } from "../core/terrain";
import type { Track } from "../core/types";

export interface ObjOptions {
  terrain?: TerrainGrid | null;
  terrainExtent?: number; // meters of terrain around track bbox
}

export function trackToObj(track: Track, opts: ObjOptions = {}): string {
  const out: string[] = [];
  out.push("# grandprix-gen track export");
  out.push(`# seed ${track.seed} length ${(track.length / 1000).toFixed(3)} km`);
  out.push("mtllib track.mtl");

  const mesh = buildTrackMesh(track, { curbWidth: 1.2, runoffWidth: 6, stride: 1 });
  let vOffset = 1; // OBJ is 1-indexed

  for (const part of mesh.parts) {
    if (part.count === 0) continue;
    out.push(`o ${part.name}`);
    out.push(`usemtl ${part.name}`);
    // write only vertices used by this part
    const used = new Set<number>();
    for (let i = part.start; i < part.start + part.count; i++) used.add(mesh.indices[i]);
    const remap = new Map<number, number>();
    const verts = [...used].sort((a, b) => a - b);
    for (const v of verts) {
      const px = mesh.positions[v * 3];
      const py = mesh.positions[v * 3 + 1];
      const pz = mesh.positions[v * 3 + 2];
      out.push(`v ${px.toFixed(4)} ${pz.toFixed(4)} ${(-py).toFixed(4)}`); // y-up conversion
      remap.set(v, vOffset++);
    }
    for (const v of verts) {
      const nx = mesh.normals[v * 3];
      const ny = mesh.normals[v * 3 + 1];
      const nz = mesh.normals[v * 3 + 2];
      out.push(`vn ${nx.toFixed(4)} ${nz.toFixed(4)} ${(-ny).toFixed(4)}`);
    }
    for (let i = part.start; i < part.start + part.count; i += 3) {
      const a = remap.get(mesh.indices[i])!;
      const b = remap.get(mesh.indices[i + 1])!;
      const c = remap.get(mesh.indices[i + 2])!;
      out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  }

  if (opts.terrain) {
    const g = opts.terrain;
    const extent = opts.terrainExtent ?? Math.max(g.width, g.height) * g.resolution;
    const nx = Math.min(256, g.width);
    const ny = Math.min(256, g.height);
    const mesh2 = buildGridMesh(
      (x, y) => g.elevationAt(x, y),
      g.originX,
      g.originY,
      g.originX + extent,
      g.originY + extent,
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

  return out.join("\n") + "\n";
}

export function trackMtl(): string {
  return `# grandprix-gen materials
newmtl asphalt
Kd 0.13 0.13 0.14
Ka 0.05 0.05 0.05
Ks 0.05 0.05 0.05
newmtl curb_left
Kd 0.75 0.12 0.12
newmtl curb_right
Kd 0.85 0.85 0.85
newmtl runoff_left
Kd 0.55 0.55 0.5
newmtl runoff_right
Kd 0.55 0.55 0.5
newmtl terrain
Kd 0.22 0.35 0.18
`;
}
