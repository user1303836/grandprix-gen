/**
 * Blender reconstruction script (.py). Embeds the actual built mesh data
 * (heterogeneous parts + barriers + terrain), so what you render is what
 * Blender gets. Also creates the editable centerline curve and named
 * corner/feature markers.
 *
 * Run inside Blender's scripting workspace: exec(open('track_blender.py').read())
 */

import type { TerrainGrid } from "../core/terrain";
import { buildBarrierMeshes, buildTrackMesh } from "./mesh";
import type { Track } from "../core/types";

export interface BlenderOptions {
  terrain?: TerrainGrid | null;
  stride?: number;
}

const SURF_MAT: Record<string, [number, number, number]> = {
  modern: [0.20, 0.20, 0.21],
  aged: [0.27, 0.27, 0.26],
  concrete: [0.58, 0.57, 0.54],
  patched: [0.24, 0.24, 0.23],
};
const KERB_MAT: Record<string, [number, number, number]> = {
  flat: [0.85, 0.83, 0.8],
  standard: [0.76, 0.23, 0.18],
  aggressive: [0.83, 0.33, 0.0],
};
const RUNOFF_MAT: Record<string, [number, number, number]> = {
  grass: [0.26, 0.35, 0.18],
  gravel: [0.61, 0.56, 0.45],
  asphalt: [0.33, 0.33, 0.35],
  wall: [0.53, 0.51, 0.48],
};

export function trackToBlenderScript(track: Track, opts: BlenderOptions = {}): string {
  const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });

  // pack parts: positions/uvs/indices per part (compact)
  const parts: { name: string; verts: number[][]; faces: number[][] }[] = [];
  for (const part of mesh.parts) {
    if (part.count === 0) continue;
    const used = new Map<number, number>();
    const verts: number[][] = [];
    const faces: number[][] = [];
    for (let i = part.start; i < part.start + part.count; i += 3) {
      const tri: number[] = [];
      for (let t = 0; t < 3; t++) {
        const vi = mesh.indices[i + t];
        let ni = used.get(vi);
        if (ni === undefined) {
          ni = used.size;
          used.set(vi, ni);
          verts.push([
            round(mesh.positions[vi * 3]),
            round(mesh.positions[vi * 3 + 1]),
            round(mesh.positions[vi * 3 + 2]),
          ]);
        }
        tri.push(ni);
      }
      faces.push(tri);
    }
    parts.push({ name: part.name.replace(":", "_"), verts, faces });
  }

  // barriers
  const barriers = buildBarrierMeshes(track);
  for (const [side, bm] of [["left", barriers.left], ["right", barriers.right]] as const) {
    if (!bm) continue;
    const verts: number[][] = [];
    for (let i = 0; i < bm.positions.length; i += 3) {
      verts.push([round(bm.positions[i]), round(bm.positions[i + 1]), round(bm.positions[i + 2])]);
    }
    const faces: number[][] = [];
    for (let i = 0; i < bm.indices.length; i += 3) {
      faces.push([bm.indices[i], bm.indices[i + 1], bm.indices[i + 2]]);
    }
    parts.push({ name: `barrier_${side}`, verts, faces });
  }

  // centerline + markers
  const stride = Math.max(1, opts.stride ?? 2);
  const center: number[][] = [];
  for (let i = 0; i < track.samples.length; i += stride) {
    const p = track.samples[i];
    center.push([round(p.x), round(p.y), round(p.z)]);
  }
  const corners = track.corners.map((c) => {
    const idx = Math.round(c.sApex / track.ds) % track.samples.length;
    const p = track.samples[idx];
    return { id: c.id, x: round(p.x), y: round(p.y), z: round(p.z) };
  });
  const features = track.features.map((f) => ({
    name: f.name,
    kind: f.kind,
    s: round(((f.sStart + f.sEnd) / 2) % track.length),
  }));

  // terrain block (decimated)
  let terrainJson = "null";
  if (opts.terrain) {
    const g = opts.terrain;
    const maxSide = 160;
    const strideT = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
    const pts: number[][] = [];
    for (let iy = 0; iy < g.height; iy += strideT) {
      for (let ix = 0; ix < g.width; ix += strideT) {
        const x = g.originX + ix * g.resolution;
        const y = g.originY + iy * g.resolution;
        const z = g.elevationAt(x, y);
        pts.push([round(x), round(y), round(Number.isFinite(z) ? z : 0)]);
      }
    }
    terrainJson = JSON.stringify({
      points: pts,
      dims: [Math.floor(g.width / strideT), Math.floor(g.height / strideT)],
    });
  }

  const dataJson = JSON.stringify({
    parts,
    center,
    corners,
    features,
    meta: {
      seed: track.seed,
      length: track.length,
      era: track.identity?.era,
      featureCount: track.features.length,
    },
  });

  return `"""grandprix-gen Blender reconstruction.
Seed ${track.seed} · ${(track.length / 1000).toFixed(3)} km · era ${track.identity?.era} · ${track.features.length} named features.
Creates: per-part meshes (surface/kerb/runoff kinds, barriers), centerline
curve, corner markers, terrain mesh. Coordinates: X=east Y=north Z=up.
"""
import bpy
import json

DATA = json.loads(r'''${dataJson}''')
TERRAIN = json.loads(r'''${terrainJson}''')

# ---------------------------------------------------------------- materials
def make_mat(name, color, rough=0.92):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m

SURF_MAT = ${JSON.stringify(SURF_MAT)}
KERB_MAT = ${JSON.stringify(KERB_MAT)}
RUNOFF_MAT = ${JSON.stringify(RUNOFF_MAT)}
MAT = {}
for k, v in SURF_MAT.items(): MAT[f"asphalt_{k}"] = make_mat(f"asphalt_{k}", v, 0.97)
for k, v in KERB_MAT.items(): MAT[f"kerb_{k}"] = make_mat(f"kerb_{k}", v, 0.8)
for k, v in RUNOFF_MAT.items(): MAT[f"runoff_{k}"] = make_mat(f"runoff_{k}", v, 1.0)

def mat_for(part_name):
    # part names: asphalt_modern, kerb_left_standard, runoff_right_gravel...
    if part_name.startswith("asphalt"):
        kind = part_name.split("_", 1)[1]
        return MAT.get(f"asphalt_{kind}", MAT["asphalt_modern"])
    if part_name.startswith("kerb"):
        kind = part_name.rsplit("_", 1)[-1]
        return MAT.get(f"kerb_{kind}", MAT["kerb_standard"])
    if part_name.startswith("runoff"):
        kind = part_name.rsplit("_", 1)[-1]
        return MAT.get(f"runoff_{kind}", MAT["runoff_grass"])
    if part_name.startswith("line"):
        return MAT["line"]
    if part_name.startswith("barrier"):
        return MAT["barrier"]
    return MAT["asphalt_modern"]

MAT["line"] = make_mat("line", (0.95, 0.95, 0.95), 0.7)
MAT["barrier"] = make_mat("barrier", (0.47, 0.50, 0.48), 0.55)
MAT["terrain"] = make_mat("terrain", (0.18, 0.29, 0.13), 1.0)
MAT["marker"] = make_mat("marker", (0.95, 0.80, 0.20), 0.4)

# ------------------------------------------------------------------- meshes
for part in DATA["parts"]:
    me = bpy.data.meshes.new(part["name"])
    me.from_pydata(part["verts"], [], part["faces"])
    me.update()
    ob = bpy.data.objects.new(part["name"], me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat_for(part["name"]))

# --------------------------------------------------------- centerline curve
cu = bpy.data.curves.new("Circuit_Centerline", "CURVE"); cu.dimensions = "3D"
sp = cu.splines.new("NURBS"); sp.points.add(len(DATA["center"]))
for i, p in enumerate(DATA["center"]):
    sp.points[i].co = (p[0], p[1], p[2], 1.0)
sp.use_cyclic_u = True
ob = bpy.data.objects.new("Circuit_Centerline", cu)
bpy.context.collection.objects.link(ob)

# ------------------------------------------------------------- markers
for c in DATA["corners"]:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=4.0, location=(c["x"], c["y"], c["z"] + 6))
    o = bpy.context.object; o.name = f"T{c['id']}"; o.data.materials.append(MAT["marker"])

# ------------------------------------------------------------------- terrain
if TERRAIN:
    pts = TERRAIN["points"]; w, h = TERRAIN["dims"]
    faces = []
    for iy in range(h - 1):
        for ix in range(w - 1):
            a = iy*w + ix; b = a + 1; cc = a + w; d = cc + 1
            faces.append((a, cc, d, b))
    me = bpy.data.meshes.new("Terrain")
    me.from_pydata([tuple(p) for p in pts], [], faces); me.update()
    ob = bpy.data.objects.new("Terrain", me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(MAT["terrain"])

print(f"grandprix-gen: rebuilt ({DATA['meta']['featureCount']} features, era {DATA['meta']['era']})")
`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
