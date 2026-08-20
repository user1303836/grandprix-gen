/**
 * Blender reconstruction script (.py). Instead of a baked mesh only, this
 * rebuilds EDITABLE objects in Blender: centerline curve, track surface
 * with named parts, curbs, runoff, terrain, corner markers, materials.
 *
 * Run inside Blender's scripting workspace: exec(open('track_blender.py').read())
 */

import type { TerrainGrid } from "../core/terrain";
import type { Track } from "../core/types";

export interface BlenderOptions {
  terrain?: TerrainGrid | null;
  stride?: number;
}

export function trackToBlenderScript(track: Track, opts: BlenderOptions = {}): string {
  const stride = Math.max(1, opts.stride ?? 2);
  const s = track.samples;
  const rows: number[][] = [];
  for (let i = 0; i < s.length; i += stride) {
    const p = s[i];
    rows.push([
      round(p.x),
      round(p.y),
      round(p.z),
      round(p.heading),
      round(p.bank),
      round(p.width),
    ]);
  }
  const corners = track.corners.map((c) => {
    const idx = Math.round(c.sApex / track.ds) % s.length;
    const p = s[idx];
    return { id: c.id, x: round(p.x), y: round(p.y), z: round(p.z), dir: c.direction };
  });

  // terrain block (decimated)
  let terrainJson = "null";
  if (opts.terrain) {
    const g = opts.terrain;
    const maxSide = 160;
    const strideT = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
    const pts: number[][] = [];
    const ws: number[] = [];
    for (let iy = 0; iy < g.height; iy += strideT) {
      for (let ix = 0; ix < g.width; ix += strideT) {
        const x = g.originX + ix * g.resolution;
        const y = g.originY + iy * g.resolution;
        const z = g.elevationAt(x, y);
        pts.push([round(x), round(y), round(Number.isFinite(z) ? z : 0)]);
      }
    }
    ws.push(Math.floor(g.width / strideT), Math.floor(g.height / strideT));
    terrainJson = JSON.stringify({ points: pts, dims: ws });
  }

  const dataJson = JSON.stringify({ rows, corners });
  const name = "Circuit";

  return `"""grandprix-gen Blender reconstruction.
Seed ${track.seed}, length ${(track.length / 1000).toFixed(3)} km, ${track.corners.length} corners.
Creates editable objects: centerline curve, asphalt/curb/runoff meshes,
corner markers${opts.terrain ? ", terrain mesh" : ""}.
Coordinate convention inside Blender: X=east, Y=up? No: X=east, Y=north, Z=up.
"""
import bpy
import bmesh
import math
import json

DATA = json.loads(r'''${dataJson}''')
TERRAIN = json.loads(r'''${terrainJson}''')
ROWS = DATA["rows"]
CORNERS = DATA["corners"]

# ---------------------------------------------------------------- materials
def make_mat(name, color, rough=0.9):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m

MAT = {
    "asphalt": make_mat("Asphalt", (0.10, 0.10, 0.11), 0.95),
    "curb_l":  make_mat("CurbL", (0.75, 0.10, 0.10), 0.7),
    "curb_r":  make_mat("CurbR", (0.90, 0.90, 0.90), 0.7),
    "runoff":  make_mat("Runoff", (0.45, 0.45, 0.40), 1.0),
    "terrain": make_mat("Terrain", (0.18, 0.30, 0.13), 1.0),
    "marker":  make_mat("Marker", (0.95, 0.80, 0.20), 0.5),
}

# ------------------------------------------------------------------ helpers
def edges(p, curb=1.2, runoff=6.0):
    """(left_asphalt, left_curb, left_runoff, right_runoff, right_curb, right_asphalt)"""
    import math as _m
    hd = p[3]; bank = p[4]; w = p[5] / 2.0
    nx, ny = -_m.sin(hd), _m.cos(hd)
    cb, sb = _m.cos(bank), _m.sin(bank)
    def pt(off, dz=0.0):
        return (p[0] + nx*off*cb, p[1] + ny*off*cb, p[2] - off*sb + dz)
    return (pt(w), pt(w+curb, 0.04), pt(w+curb+runoff, -0.05),
            pt(-w-curb-runoff, -0.05), pt(-w-curb, 0.04), pt(-w))

def build_strip(name, col_a, col_b, mat):
    verts, faces = [], []
    for p in ROWS:
        e = edges(p)
        verts.append(e[col_a]); verts.append(e[col_b])
    n = len(ROWS)
    for i in range(n):
        j = (i + 1) % n
        faces.append((i*2, j*2, j*2+1, i*2+1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces); me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob

# ------------------------------------------------------------------- meshes
build_strip("${name}_Asphalt", 0, 5, MAT["asphalt"])
build_strip("${name}_Curb_L", 1, 0, MAT["curb_l"])
build_strip("${name}_Curb_R", 5, 4, MAT["curb_r"])
build_strip("${name}_Runoff_L", 2, 1, MAT["runoff"])
build_strip("${name}_Runoff_R", 4, 3, MAT["runoff"])

# --------------------------------------------------------- centerline curve
cu = bpy.data.curves.new("${name}_Centerline", "CURVE"); cu.dimensions = "3D"
sp = cu.splines.new("NURBS"); sp.points.add(len(ROWS))
for i, p in enumerate(ROWS):
    sp.points[i].co = (p[0], p[1], p[2], 1.0)
sp.use_cyclic_u = True
ob = bpy.data.objects.new("${name}_Centerline", cu)
bpy.context.collection.objects.link(ob)

# ------------------------------------------------------------ corner marks
for c in CORNERS:
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

print("grandprix-gen: circuit rebuilt (${track.corners.length} corners, ${(track.length / 1000).toFixed(2)} km)")
`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
