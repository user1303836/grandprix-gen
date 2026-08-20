/**
 * glTF/GLB export via Three.js GLTFExporter (browser only).
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { buildGridMesh, buildTrackMesh } from "./mesh";
import type { TerrainGrid } from "../core/terrain";
import type { Track } from "../core/types";

const PART_COLORS: Record<string, number> = {
  asphalt: 0x1b1c1e,
  curb_left: 0xc22f2f,
  curb_right: 0xe8e8e8,
  runoff_left: 0x8a8a7a,
  runoff_right: 0x8a8a7a,
};

export async function trackToGlb(track: Track, terrain?: TerrainGrid | null): Promise<ArrayBuffer> {
  const group = new Group();
  group.name = "grandprix-gen-circuit";

  const mesh = buildTrackMesh(track, { curbWidth: 1.2, runoffWidth: 6, stride: 1 });
  for (const part of mesh.parts) {
    if (part.count === 0) continue;
    const geo = new BufferGeometry();
    // gather part vertices (compact buffer)
    const used = new Map<number, number>();
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    for (let i = part.start; i < part.start + part.count; i++) {
      const vi = mesh.indices[i];
      let ni = used.get(vi);
      if (ni === undefined) {
        ni = used.size;
        used.set(vi, ni);
        pos.push(mesh.positions[vi * 3], mesh.positions[vi * 3 + 2], -mesh.positions[vi * 3 + 1]); // y-up
        nrm.push(mesh.normals[vi * 3], mesh.normals[vi * 3 + 2], -mesh.normals[vi * 3 + 1]);
      }
      idx.push(ni);
    }
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
    geo.setIndex(idx);
    const mat = new MeshStandardMaterial({
      color: new Color(PART_COLORS[part.name] ?? 0x888888),
      roughness: 0.92,
      metalness: 0,
      side: DoubleSide,
    });
    const m = new Mesh(geo, mat);
    m.name = part.name;
    group.add(m);
  }

  if (terrain) {
    const g = terrain;
    const maxSide = 256;
    const strideT = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
    const gm = buildGridMesh(
      (x, y) => g.elevationAt(x, y),
      g.originX,
      g.originY,
      g.originX + g.width * g.resolution,
      g.originY + g.height * g.resolution,
      Math.floor(g.width / strideT),
      Math.floor(g.height / strideT),
    );
    const geo = new BufferGeometry();
    const pos = new Float32Array(gm.positions.length);
    for (let i = 0; i < gm.positions.length; i += 3) {
      pos[i] = gm.positions[i];
      pos[i + 1] = gm.positions[i + 2];
      pos[i + 2] = -gm.positions[i + 1];
    }
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setIndex(new BufferAttribute(gm.indices, 1));
    geo.computeVertexNormals();
    const m = new Mesh(
      geo,
      new MeshStandardMaterial({ color: new Color(0x2e4a24), roughness: 1, side: DoubleSide }),
    );
    m.name = "terrain";
    group.add(m);
  }

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(group, { binary: true });
  return result as ArrayBuffer;
}
