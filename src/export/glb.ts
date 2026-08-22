/**
 * glTF/GLB export via Three.js GLTFExporter (browser only).
 * Includes heterogeneous surface parts + barrier walls.
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
import { buildBarrierMeshes, buildGridMesh, buildTrackMesh } from "./mesh";
import { corridorCarve, type TerrainSurface } from "../core/terrain";
import { buildStructureMeshes, buildFeatureMeshes } from "./structuresMesh";
import { buildFacilityMeshParts } from "./facilityMesh";
import type { Track } from "../core/types";

const KERB_COLORS: Record<string, number> = {
  flat: 0xd8d4d0,
  standard: 0xc23a2f,
  aggressive: 0xd45500,
};
const RUNOFF_COLORS: Record<string, number> = {
  grass: 0x42592f,
  gravel: 0x9c8f73,
  asphalt: 0x55565a,
  wall: 0x86827a,
};
const ASPHALT_BASE: Record<string, number> = {
  modern: 0x35363b,
  aged: 0x46474a,
  concrete: 0x94928a,
  patched: 0x3e3f42,
};

function partColor(name: string): number {
  const [bandKind, kindLabel] = name.split(":");
  const band = bandKind.split("_")[0];
  if (band === "kerb" && kindLabel) return KERB_COLORS[kindLabel] ?? 0xd8d8d8;
  if (band === "runoff" && kindLabel) return RUNOFF_COLORS[kindLabel] ?? 0x7d7a66;
  if (band === "asphalt" && kindLabel) return ASPHALT_BASE[kindLabel] ?? 0x35363b;
  if (band === "line") return 0xf2f2f2;
  return 0x888888;
}

export async function trackToGlb(
  track: Track,
  terrain?: TerrainSurface | null,
  world?: import("../core/world/types").WorldPlan | null,
): Promise<ArrayBuffer> {
  const group = new Group();
  group.name = "grandprix-gen-circuit";

  const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });
  for (const part of mesh.parts) {
    if (part.count === 0) continue;
    const geo = new BufferGeometry();
    const used = new Map<number, number>();
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = part.start; i < part.start + part.count; i++) {
      const vi = mesh.indices[i];
      let ni = used.get(vi);
      if (ni === undefined) {
        ni = used.size;
        used.set(vi, ni);
        pos.push(mesh.positions[vi * 3], mesh.positions[vi * 3 + 2], -mesh.positions[vi * 3 + 1]); // y-up
        nrm.push(mesh.normals[vi * 3], mesh.normals[vi * 3 + 2], -mesh.normals[vi * 3 + 1]);
        uv.push(mesh.uvs[vi * 2], mesh.uvs[vi * 2 + 1]);
      }
      idx.push(ni);
    }
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(idx);
    const mat = new MeshStandardMaterial({
      color: new Color(partColor(part.name)),
      roughness: part.name.startsWith("asphalt") ? 0.95 : 0.85,
      metalness: 0,
      side: DoubleSide,
    });
    const m = new Mesh(geo, mat);
    m.name = part.name.replace(":", "_");
    group.add(m);
  }

  // barrier walls
  const barriers = buildBarrierMeshes(track);
  for (const [side, bm] of [["left", barriers.left], ["right", barriers.right]] as const) {
    if (!bm) continue;
    const geo = new BufferGeometry();
    const pos = new Float32Array(bm.positions.length);
    for (let i = 0; i < bm.positions.length; i += 3) {
      pos[i] = bm.positions[i];
      pos[i + 1] = bm.positions[i + 2];
      pos[i + 2] = -bm.positions[i + 1];
    }
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setIndex(new BufferAttribute(bm.indices, 1));
    geo.computeVertexNormals();
    const m = new Mesh(
      geo,
      new MeshStandardMaterial({ color: 0x77807a, roughness: 0.6, metalness: 0.3, side: DoubleSide }),
    );
    m.name = `barrier_${side}`;
    group.add(m);
  }

  // structures + feature geometry
  {
    const groundSampler = terrain ? (x: number, y: number) => terrain.elevationAt(x, y) : null;
    const palette: Record<string, number> = {
      bridge: 0x9a968c, piers: 0x8f8b81, tunnel: 0x43444a, portals: 0x95897a,
      retaining: 0x8f8b80, rock: 0x6b6357, embankment: 0x465c34,
      "pit-lane": 0x484b52, "pit-wall": 0xc8c4bc, "service-road": 0x5c5c58,
      pit_lane: 0x3a3d43, pit_wall: 0xc8c4bc, garage_building: 0xcfd3d8,
      garage_doors: 0x9a4a3a, hospitality: 0xb8c4d0, race_control: 0xb6b2a8,
      grandstand_main: 0xb8bcc2, grandstand_secondary: 0xaaaeb6,
      facility_foundations: 0xa8a49a, screens: 0x1a2028,
    };
    for (const part of [...buildStructureMeshes(track, groundSampler), ...buildFeatureMeshes(track), ...buildFacilityMeshParts(track)]) {
      const geo = new BufferGeometry();
      const pos = new Float32Array(part.positions.length);
      for (let i = 0; i < part.positions.length; i += 3) {
        pos[i] = part.positions[i];
        pos[i + 1] = part.positions[i + 2];
        pos[i + 2] = -part.positions[i + 1];
      }
      geo.setAttribute("position", new BufferAttribute(pos, 3));
      geo.setIndex(new BufferAttribute(part.indices, 1));
      geo.computeVertexNormals();
      const m = new Mesh(
        geo,
        new MeshStandardMaterial({ color: palette[part.name] ?? 0x8a857c, roughness: 0.95, side: DoubleSide }),
      );
      m.name = `structure_${part.name}`;
      group.add(m);
    }
  }

  if (terrain) {
    const g = terrain;
    const maxSide = 256;
    const strideT = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
    const sampler = corridorCarve(g, track, 120);
    const gm = buildGridMesh(
      sampler,
      g.originX,
      g.originY,
      g.originX + (g.width - 1) * g.resolution,
      g.originY + (g.height - 1) * g.resolution,
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

  if (world) {
    const { worldExportParts } = await import("../core/world/exportGeometry");
    for (const part of worldExportParts(world)) {
      const geo = new BufferGeometry();
      const pos = new Float32Array(part.positions.length);
      for (let i = 0; i < part.positions.length; i += 3) {
        pos[i] = part.positions[i];
        pos[i + 1] = part.positions[i + 2];
        pos[i + 2] = -part.positions[i + 1];
      }
      geo.setAttribute("position", new BufferAttribute(pos, 3));
      geo.setIndex(new BufferAttribute(part.indices, 1));
      geo.computeVertexNormals();
      const m = new Mesh(
        geo,
        new MeshStandardMaterial({ color: part.color, roughness: 1, side: DoubleSide }),
      );
      m.name = part.name;
      group.add(m);
    }
  }

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(group, { binary: true });
  return result as ArrayBuffer;
}
