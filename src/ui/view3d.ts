/**
 * Three.js 3D view: banked track ribbon with striped curbs and edge lines,
 * hypsometric hillshaded terrain, surrounding context terrain, water,
 * procedural trees, OSM buildings, shadow-mapped sun, gradient sky, orbit
 * camera and an onboard "drive the lap" camera following the estimated
 * speed profile.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  ConeGeometry,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildGridMesh,
  buildTrackMesh,
  buildBarrierMeshes,
  type TrackMeshData,
  type SimpleMesh,
} from "../export/mesh";
import { sampleAt } from "../core/types";
import { carveSampler, makeTrackProximity, type TerrainGrid } from "../core/terrain";
import type { OsmBuilding } from "../core/osm";
import { Rng } from "../core/prng";
import type { AppState } from "./state";
import type { Track } from "../core/types";

const PART_COLORS: Record<string, number> = {
  asphalt: 0x35363b,
  line: 0xf2f2f2,
  kerb: 0xd8d8d8,
  runoff: 0x7d7a66,
};

const KERB_COLORS: Record<string, number> = {
  flat: 0xd8d4d0,
  standard: 0xffffff, // striped texture
  aggressive: 0xc95a10,
};

const RUNOFF_COLORS: Record<string, number> = {
  grass: 0x42592f,
  gravel: 0x9c8f73,
  asphalt: 0x55565a,
  wall: 0x86827a,
};

export class View3D {
  private container: HTMLElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private trackGroup: Group | null = null;
  private sun: DirectionalLight;
  private raf = 0;
  private state: AppState | null = null;
  private disposed = false;
  private stripedCurbTex: CanvasTexture;

  // drive mode
  driveActive = false;
  driveS = 0;
  driveSpeedMult = 1;
  driveCamHeight = 1.7;
  driveChase = false;
  private lastT = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.inset = "0";
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = makeSkyTexture();
    this.scene.fog = new Fog(0x9db4c8, 3000, 14000);

    this.camera = new PerspectiveCamera(55, 1, 0.5, 30000);
    this.camera.position.set(0, 400, 800);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new AmbientLight(0xb4b8bc, 0.55));
    this.sun = new DirectionalLight(0xfff2dd, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 2.0;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.stripedCurbTex = makeCurbStripeTexture();

    const animate = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(animate);
      const dt = Math.min(0.1, (t - this.lastT) / 1000);
      this.lastT = t;
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(animate);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }

  setState(state: AppState): void {
    const trackChanged =
      this.state?.track !== state.track ||
      this.state?.terrain !== state.terrain ||
      this.state?.terrainContext !== state.terrainContext ||
      this.state?.buildings !== state.buildings;
    this.state = state;
    if (trackChanged) {
      if (this.visible) {
        this.rebuildScene(state);
        this.needsRebuild = false;
      } else {
        this.needsRebuild = true;
      }
    }
  }

  /** Call when the 3D/drive view becomes visible. */
  setVisible(v: boolean): void {
    this.visible = v;
    if (v && this.needsRebuild && this.state) {
      this.rebuildScene(this.state);
      this.needsRebuild = false;
    }
  }

  private visible = false;
  private needsRebuild = false;

  // -------------------------------------------------------------- scene
  private rebuildScene(state: AppState): void {
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      this.trackGroup.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          const m = o.material as MeshStandardMaterial;
          if (m.map && m.map !== this.stripedCurbTex) m.map.dispose();
          m.dispose();
        }
      });
    }
    this.trackGroup = new Group();
    const track = state.track;
    if (track) {
      const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });
      for (const part of mesh.parts) {
        if (part.count === 0) continue;
        const m = this.partMesh(mesh, part.start, part.count, part.name);
        m.castShadow = true;
        this.trackGroup.add(m);
      }
      // barrier walls (armco / concrete where infrastructure stands close)
      const barriers = buildBarrierMeshes(track);
      for (const [side, bm] of [["left", barriers.left], ["right", barriers.right]] as const) {
        if (!bm) continue;
        const wall = this.barrierMesh(bm, track);
        wall.name = `barrier_${side}`;
        wall.castShadow = true;
        this.trackGroup.add(wall);
      }
      this.addStartFinish(track);
      this.fitCamera(track, state.terrain);
    }

    if (state.terrain && track) {
      // detailed carved site terrain
      const g = state.terrain;
      const siteMesh = this.terrainMesh(g, carveSampler(g, track.samples, 26, 110), 240, 0);
      siteMesh.receiveShadow = true;
      this.trackGroup.add(siteMesh);
      // coarse surrounding context
      if (state.terrainContext) {
        const ctx = state.terrainContext;
        const ctxMesh = this.terrainMesh(ctx, (x, y) => ctx.elevationAt(x, y), 200, 0);
        ctxMesh.position.y = -1.5; // site mesh wins the overlap
        ctxMesh.receiveShadow = true;
        this.trackGroup.add(ctxMesh);
      }
      // water
      const minZ = Math.min(g.minElevation, state.terrainContext?.minElevation ?? Infinity);
      if (minZ < 2) {
        const extent =
          Math.max(
            state.terrainContext ? state.terrainContext.width * state.terrainContext.resolution : 0,
            g.width * g.resolution,
          ) * 0.75;
        const water = buildGridMesh(() => Math.max(0.25, minZ + 0.1), -extent, -extent, extent, extent, 2, 2);
        const wm = this.gridMesh(water.positions, water.indices, 0x2b4a63, true);
        this.trackGroup.add(wm);
      }
      this.addTrees(state.terrain, track);
      if (state.buildings && state.buildings.length > 0) {
        // seat buildings on the CARVED terrain so they don't float/sink
        // where the corridor flattens the ground
        const carved = carveSampler(state.terrain, track.samples, 26, 110);
        this.trackGroup.add(this.buildingsMesh(state.buildings, carved));
      }
    } else if (track) {
      const span = estimateSpan(track) * 2.4;
      const gm = buildGridMesh(() => -0.08, -span / 2, -span / 2, span / 2, span / 2, 2, 2);
      const ground = this.gridMesh(gm.positions, gm.indices, 0x3d5530);
      ground.receiveShadow = true;
      this.trackGroup.add(ground);
    }

    // shadow camera covers the scene
    const span = track ? estimateSpan(track) * 1.4 : 2000;
    const s = span * 0.75;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.far = 9000;
    this.sun.shadow.camera.updateProjectionMatrix();
    if (track) {
      const c = track.samples[0];
      this.sun.target.position.set(c.x, c.z, -c.y);
      this.sun.position.set(c.x + span * 0.9, span * 1.1 + c.z + 800, -c.y + span * 0.55);
    }
    // fog scales with the site so overview shots don't wash out
    this.scene.fog = new Fog(0x9aa8a2, span * 2.2, span * 9);

    this.scene.add(this.trackGroup);
  }

  private fitCamera(track: Track, terrain: TerrainGrid | null): void {
    const c = track.samples[0];
    this.controls.target.set(c.x, c.z, -c.y);
    const span = estimateSpan(track);
    const terrainMaxZ = terrain ? terrain.maxElevation : c.z;
    const camY = Math.max(c.z + span * 0.55, terrainMaxZ + span * 0.25);
    this.camera.position.set(c.x + span * 0.62, camY, -c.y + span * 0.62);
  }

  // ------------------------------------------------------------ meshes
  /** Resolve "band_side:kind" part names to materials. */
  private partMesh(mesh: TrackMeshData, start: number, count: number, name: string): Mesh {
    const used = new Map<number, number>();
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = start; i < start + count; i++) {
      const vi = mesh.indices[i];
      let ni = used.get(vi);
      if (ni === undefined) {
        ni = used.size;
        used.set(vi, ni);
        pos.push(mesh.positions[vi * 3], mesh.positions[vi * 3 + 2], -mesh.positions[vi * 3 + 1]);
        nrm.push(mesh.normals[vi * 3], mesh.normals[vi * 3 + 2], -mesh.normals[vi * 3 + 1]);
        uv.push(mesh.uvs[vi * 2], mesh.uvs[vi * 2 + 1]);
        col.push(mesh.colors[vi * 3], mesh.colors[vi * 3 + 1], mesh.colors[vi * 3 + 2]);
      }
      idx.push(ni);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idx);

    const [bandKind, kindLabel] = name.split(":");
    const band = bandKind.split("_")[0];
    const isKerb = band === "kerb";
    const isRunoff = band === "runoff";
    const isLine = band === "line";
    const isAsphalt = band === "asphalt";
    const baseColor =
      isKerb && kindLabel
        ? (KERB_COLORS[kindLabel] ?? 0xd8d8d8)
        : isRunoff && kindLabel
          ? (RUNOFF_COLORS[kindLabel] ?? 0x7d7a66)
          : (PART_COLORS[band] ?? 0x888888);
    const mat = new MeshStandardMaterial({
      color: new Color(baseColor),
      roughness: isAsphalt ? 0.97 : isRunoff && kindLabel === "gravel" ? 1 : 0.85,
      metalness: 0,
      side: DoubleSide,
      vertexColors: isAsphalt, // surface tint + mottle lives in vertex colors
      polygonOffset: isLine,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    if (isKerb && kindLabel === "standard") {
      mat.map = this.stripedCurbTex;
      mat.vertexColors = false;
      this.stripedCurbTex.wrapS = RepeatWrapping;
    }
    const m = new Mesh(geo, mat);
    m.name = name;
    return m;
  }

  /** Armco / concrete barrier wall ribbon. */
  private barrierMesh(bm: SimpleMesh, track: Track): Mesh {
    const nVerts = bm.positions.length / 3;
    const pos = new Float32Array(bm.positions.length);
    for (let i = 0; i < bm.positions.length; i += 3) {
      pos[i] = bm.positions[i];
      pos[i + 1] = bm.positions[i + 2];
      pos[i + 2] = -bm.positions[i + 1];
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setIndex(new BufferAttribute(bm.indices, 1));
    geo.computeVertexNormals();
    // armco where barriers sit back, concrete where it's a wall at the edge
    const isWallKind =
      track.props &&
      (track.props.runoffL[0] === 3 || track.props.runoffR[0] === 3);
    const mat = new MeshStandardMaterial({
      color: isWallKind ? 0x9a968c : 0x77807a,
      roughness: 0.6,
      metalness: isWallKind ? 0.05 : 0.35,
      side: DoubleSide,
    });
    return new Mesh(geo, mat);
    void nVerts;
  }

  /** Terrain mesh with hypsometric + slope vertex colors. */
  private terrainMesh(
    grid: TerrainGrid,
    sampler: (x: number, y: number) => number,
    maxSide: number,
    zOffset: number,
  ): Mesh {
    const strideT = Math.max(1, Math.floor(Math.max(grid.width, grid.height) / maxSide));
    const nx = Math.max(2, Math.floor((grid.width - 1) / strideT));
    const ny = Math.max(2, Math.floor((grid.height - 1) / strideT));
    const gm = buildGridMesh(
      (x, y) => {
        const z = sampler(x, y);
        return Number.isFinite(z) ? z + zOffset : 0;
      },
      grid.originX,
      grid.originY,
      grid.originX + (grid.width - 1) * grid.resolution,
      grid.originY + (grid.height - 1) * grid.resolution,
      nx,
      ny,
    );
    return this.coloredGridMesh(gm.positions, gm.indices, grid);
  }

  private gridMesh(positions: Float32Array, indices: Uint32Array, color: number, water = false): Mesh {
    const pos = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      pos[i] = positions[i];
      pos[i + 1] = positions[i + 2];
      pos[i + 2] = -positions[i + 1];
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    const mat = new MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
      transparent: water,
      opacity: water ? 0.86 : 1,
    });
    return new Mesh(geo, mat);
  }

  /** Grid mesh with per-vertex hypsometric + hillshade coloring. */
  private coloredGridMesh(positions: Float32Array, indices: Uint32Array, grid: TerrainGrid): Mesh {
    const nVerts = positions.length / 3;
    const pos = new Float32Array(positions.length);
    const colors = new Float32Array(nVerts * 3);
    const zMin = grid.minElevation;
    const zMax = Math.max(grid.maxElevation, zMin + 1);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      pos[i] = x;
      pos[i + 1] = z;
      pos[i + 2] = -y;
      const t = (z - zMin) / (zMax - zMin);
      const slope = grid.slopeAt(x, y);
      const shade = Math.max(0.35, 1 - slope * 1.5);
      // olive grass -> dry -> rocky grey/brown -> pale high
      let r = 0.13 + t * 0.30;
      let g = 0.36 + t * 0.24;
      let b = 0.10 + t * 0.04;
      if (t > 0.72) {
        const u = (t - 0.72) / 0.28;
        r = r * (1 - u) + 0.58 * u;
        g = g * (1 - u) + 0.55 * u;
        b = b * (1 - u) + 0.48 * u;
      }
      const vi = (i / 3) * 3;
      colors[vi] = r * shade;
      colors[vi + 1] = g * shade;
      colors[vi + 2] = b * shade;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(colors, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide });
    const m = new Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  private addStartFinish(track: Track): void {
    const p = track.samples[0];
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    const hw = p.width / 2;
    const a = new Vector3(p.x + nx * hw, p.z + 0.12, -(p.y + ny * hw));
    const b = new Vector3(p.x - nx * hw, p.z + 0.12, -(p.y - ny * hw));
    const len = a.distanceTo(b);
    const boxGeo = new BufferGeometry();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const verts = new Float32Array([
      -len / 2, 0, -0.4, len / 2, 0, -0.4, len / 2, 0, 0.4,
      -len / 2, 0, -0.4, len / 2, 0, 0.4, -len / 2, 0, 0.4,
    ]);
    boxGeo.setAttribute("position", new BufferAttribute(verts, 3));
    boxGeo.computeVertexNormals();
    const box = new Mesh(
      boxGeo,
      new MeshStandardMaterial({ color: 0x4fc3f7, side: DoubleSide, emissive: 0x123a4f }),
    );
    box.position.copy(mid);
    box.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    this.trackGroup!.add(box);
  }

  /** Instanced low-poly trees on moderate slopes outside the corridor. */
  private addTrees(grid: TerrainGrid, track: Track): void {
    const proximity = makeTrackProximity(track.samples);
    const rng = new Rng(track.seed ^ 0x7ee5);
    const positions: Matrix4[] = [];
    const step = 4; // grid cells between candidates
    const jitter = grid.resolution * 3;
    for (let iy = 2; iy < grid.height - 2; iy += step) {
      for (let ix = 2; ix < grid.width - 2; ix += step) {
        const x = grid.originX + (ix + rng.spread(0.5)) * grid.resolution;
        const y = grid.originY + (iy + rng.spread(0.5)) * grid.resolution;
        const z = grid.elevationAt(x, y);
        if (!Number.isFinite(z) || z < 3) continue;
        const slope = grid.slopeAt(x, y);
        if (slope > 0.42) continue;
        const near = proximity.nearest(x, y, 60);
        if (near && near.d < 48) continue;
        if (rng.next() < 0.35) continue; // thin it out
        const scale = 0.7 + rng.next() * 0.9;
        const mat = new Matrix4()
          .makeRotationY(rng.range(0, Math.PI * 2))
          .setPosition(x, z + 2.6 * scale, -y)
          .scale(new Vector3(scale, scale, scale));
        positions.push(mat);
        if (positions.length >= 4000) break;
      }
      if (positions.length >= 4000) break;
    }
    void jitter;
    if (positions.length === 0) return;
    const geo = new ConeGeometry(2.4, 7.5, 6);
    geo.translate(0, 0, 0);
    const mat = new MeshStandardMaterial({ color: 0x2f4a22, roughness: 1 });
    const inst = new InstancedMesh(geo, mat, positions.length);
    positions.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.setUsage(DynamicDrawUsage);
    inst.castShadow = true;
    inst.name = "trees";
    this.trackGroup!.add(inst);
  }

  /** Extruded OSM building footprints, merged into one geometry. */
  private buildingsMesh(buildings: OsmBuilding[], elevAt: (x: number, y: number) => number): Mesh {
    const pos: number[] = [];
    for (const b of buildings) {
      const ring = b.footprint;
      if (ring.length < 4) continue;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        cx += ring[i][0];
        cy += ring[i][1];
      }
      cx /= ring.length - 1;
      cy /= ring.length - 1;
      const base = elevAt(cx, cy);
      const z0 = (Number.isFinite(base) ? base : 0) - 0.3;
      const z1 = z0 + b.height;
      const yUp = (x: number, y: number, z: number) => [x, z, -y];
      // walls
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        pos.push(
          ...yUp(x0, y0, z0), ...yUp(x1, y1, z0), ...yUp(x1, y1, z1),
          ...yUp(x0, y0, z0), ...yUp(x1, y1, z1), ...yUp(x0, y0, z1),
        );
      }
      // roof fan from centroid (convex-ish footprints dominate)
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        pos.push(...yUp(cx, cy, z1), ...yUp(x0, y0, z1), ...yUp(x1, y1, z1));
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.computeVertexNormals();
    const mat = new MeshStandardMaterial({ color: 0x8a857c, roughness: 0.95 });
    const m = new Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = "buildings";
    return m;
  }

  // ------------------------------------------------------------- tick
  private tick(dt: number): void {
    const state = this.state;
    if (!state) return;
    if (this.driveActive && state.track) {
      this.controls.enabled = false;
      const track = state.track;
      if (!Number.isFinite(this.driveS)) this.driveS = 0;
      const idx = Math.floor(this.driveS / track.ds) % track.samples.length;
      const v = Number.isFinite(track.samples[idx].speed) ? track.samples[idx].speed : 30;
      this.driveS = (this.driveS + v * this.driveSpeedMult * dt) % track.length;
      const here = sampleAt(track, this.driveS);
      const lookS = (this.driveS + (this.driveChase ? 25 : 45)) % track.length;
      const ahead = sampleAt(track, lookS);
      const h = this.driveCamHeight;
      if (this.driveChase) {
        const backS = (this.driveS - 14 + track.length) % track.length;
        const back = sampleAt(track, backS);
        this.camera.position.set(back.x, back.z + 6.5, -back.y);
        this.camera.lookAt(ahead.x, ahead.z + 1.5, -ahead.y);
      } else {
        this.camera.position.set(here.x, here.z + h, -here.y);
        this.camera.lookAt(ahead.x, ahead.z + h * 0.6, -ahead.y);
      }
      this.camera.rotateZ(this.driveChase ? 0 : -here.bank * 0.5);
    } else {
      this.controls.enabled = true;
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function estimateSpan(track: Track): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of track.samples) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  return Math.max(maxX - minX, maxY - minY, 400);
}

/** Vertical gradient sky dome as a background texture. */
function makeSkyTexture(): CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 4;
  cv.height = 256;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#16283f");
  grad.addColorStop(0.45, "#31527a");
  grad.addColorStop(0.72, "#7d9dbd");
  grad.addColorStop(1, "#b8c9d6");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Red/white curb striping (repeats along the curb via u coordinate). */
function makeCurbStripeTexture(): CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 8;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#b23a33";
  ctx.fillRect(0, 0, 32, 8);
  ctx.fillStyle = "#d8d4d0";
  ctx.fillRect(32, 0, 32, 8);
  const tex = new CanvasTexture(cv);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export type { Object3D };
