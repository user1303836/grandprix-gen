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
  PointLight,
  Raycaster,
  RepeatWrapping,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
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
import { buildStructureMeshes, buildFeatureMeshes, type StructureMeshPart } from "../export/structuresMesh";
import {
  FeatureColors,
  FeatureLabels,
  SurfaceNames as SURFACE_NAMES,
  KerbNames as KERB_NAMES,
  RunoffNames as RUNOFF_NAMES,
} from "../core/character";
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
  sausage: 0xd8b020,
  oldlow: 0xb5aa98,
  high: 0xd04838,
};

const RUNOFF_COLORS: Record<string, number> = {
  grass: 0x42592f,
  gravel: 0x9c8f73,
  asphalt: 0x55565a,
  wall: 0x86827a,
  shoulder: 0x4a4a48,
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
    // the browser context menu steals right-drag pan gestures -- kill it
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    this.setupHover();
    // floating "fit view" button (3D only)
    const fitBtn = document.createElement("button");
    fitBtn.className = "fit-view-btn";
    fitBtn.style.display = "none";
    fitBtn.title = "Fit view to track";
    fitBtn.textContent = "\u229E fit";
    fitBtn.addEventListener("click", () => this.resetView());
    this.container.appendChild(fitBtn);
    this.fitBtn = fitBtn;

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
    if (this.fitBtn) this.fitBtn.style.display = v ? "block" : "none";
    if (!v && this.hoverEl) this.hoverEl.style.display = "none";
    if (v && this.needsRebuild && this.state) {
      this.rebuildScene(this.state);
      this.needsRebuild = false;
    }
  }

  private fitBtn: HTMLButtonElement | null = null;

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
        } else if (o instanceof Sprite) {
          const m = o.material as SpriteMaterial;
          if (m.map) m.map.dispose();
          m.dispose();
        }
      });
    }
    this.trackGroup = new Group();
    this.hitMeshes = [];
    this.labelSprites = [];
    const track = state.track;
    if (track) {
      const mesh = buildTrackMesh(track, { curbWidth: 1.3, runoffWidth: 9, stride: 1 });
      for (const part of mesh.parts) {
        if (part.count === 0) continue;
        const m = this.partMesh(mesh, part.start, part.count, part.name);
        m.castShadow = true;
        this.trackGroup.add(m);
        if (!part.name.startsWith("runoff")) this.hitMeshes.push(m);
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
      this.addStructureMeshes(track, state.terrain);
      this.addFeatureMeshes(track);
      this.addFeatureLabels(track);
      this.maybeFitCamera(track, state.terrain);
    }

    if (state.terrain && track) {
      // detailed carved site terrain
      const g = state.terrain;
      const carve = carveSampler(g, track.samples, track.carveMask, 40, 120, track.carveInner);
      // cell size well under the narrowest carved bench (~13 m in cuts)
      const span = Math.max(g.width, g.height) * g.resolution;
      const maxSide = Math.max(240, Math.min(720, Math.ceil(span / 9.5)));
      // open the corridor: cull terrain triangles centered within ~11 m of
      // carve-active samples (the road + runoff + skirts cover the gap)
      const holeProx = makeTrackProximity(
        track.samples.filter((_, i) => !track.carveMask || track.carveMask[i] === 1),
      );
      const holeTest = (x: number, y: number) => holeProx.nearest(x, y, 11) !== null;
      const siteMesh = this.terrainMesh(g, carve, maxSide, 0, holeTest);
      siteMesh.receiveShadow = true;
      this.trackGroup.add(siteMesh);
      // coarse surrounding context -- carved identically, otherwise its
      // coarse triangles roof over the cut trenches the site mesh opens
      if (state.terrainContext) {
        const ctx = state.terrainContext;
        const ctxCarve = carveSampler(ctx, track.samples, track.carveMask, 40, 120, track.carveInner);
        const ctxMesh = this.terrainMesh(ctx, (x, y) => ctxCarve(x, y), 200, 0);
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
        const carved = carveSampler(state.terrain, track.samples, track.carveMask, 40, 120, track.carveInner);
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
    this.scene.fog = new Fog(0x9aa8a2, span * 3.4, span * 12);

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

  /**
   * Fit ONLY on the very first build or when the site (terrain) changed --
   * parameter morphs must never move the camera. The user owns the view;
   * the floating "fit" button is the explicit escape hatch.
   */
  private didInitialFit = false;
  private lastTerrain: TerrainGrid | null = null;
  private maybeFitCamera(track: Track, terrain: TerrainGrid | null): void {
    const terrainChanged = terrain !== this.lastTerrain;
    if (!this.didInitialFit || terrainChanged) {
      this.fitCamera(track, terrain);
      this.didInitialFit = true;
      this.lastTerrain = terrain;
    }
  }

  /** Public: the floating "fit view" button. */
  resetView(): void {
    if (!this.state?.track) return;
    this.fitCamera(this.state.track, this.state.terrain);
    this.lastTerrain = this.state.terrain;
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
    /** triangles fully within this distance of the corridor are culled
     * (the road/structures own the corridor; bilinear terrain can leak
     * over a narrow carved bench) */
    holeProximity: ((x: number, y: number) => boolean) | null = null,
  ): Mesh {
    const strideT = Math.max(1, Math.floor(Math.max(grid.width, grid.height) / maxSide));
    const nx = Math.max(2, Math.floor((grid.width - 1) / strideT));
    const ny = Math.max(2, Math.floor((grid.height - 1) / strideT));
    const finite: boolean[] = [];
    const gm = buildGridMesh(
      (x, y) => {
        const z = sampler(x, y);
        finite.push(Number.isFinite(z));
        return Number.isFinite(z) ? z + zOffset : 0;
      },
      grid.originX,
      grid.originY,
      grid.originX + (grid.width - 1) * grid.resolution,
      grid.originY + (grid.height - 1) * grid.resolution,
      nx,
      ny,
    );
    // never render the off-grid fallback plane: cull NaN triangles
    {
      const kept: number[] = [];
      for (let i = 0; i < gm.indices.length; i += 3) {
        if (finite[gm.indices[i]] && finite[gm.indices[i + 1]] && finite[gm.indices[i + 2]]) {
          kept.push(gm.indices[i], gm.indices[i + 1], gm.indices[i + 2]);
        }
      }
      gm.indices = new Uint32Array(kept);
    }
    if (holeProximity) {
      // cull triangles whose CENTROID sits inside the corridor: with the
      // cell size below the carved bench width this opens the trench
      // cleanly, with the boundary hidden inside the flat carved zone
      const kept: number[] = [];
      const pos = gm.positions;
      for (let i = 0; i < gm.indices.length; i += 3) {
        const a = gm.indices[i];
        const b = gm.indices[i + 1];
        const c = gm.indices[i + 2];
        const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
        const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
        if (!holeProximity(cx, cy)) kept.push(a, b, c);
      }
      gm.indices = new Uint32Array(kept);
    }
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
      // hypsometric albedo: forest -> olive -> dry -> rock -> pale summits
      let r: number, g: number, b: number;
      if (t < 0.45) {
        const u = t / 0.45;
        r = 0.10 + u * 0.16;
        g = 0.24 + u * 0.14;
        b = 0.07 + u * 0.05;
      } else if (t < 0.75) {
        const u = (t - 0.45) / 0.3;
        r = 0.26 + u * 0.18;
        g = 0.38 - u * 0.02;
        b = 0.12 + u * 0.08;
      } else {
        // high ground: rock face, only the very top goes pale
        const u = (t - 0.75) / 0.25;
        r = 0.42 + u * 0.22;
        g = 0.36 + u * 0.22;
        b = 0.2 + u * 0.22;
      }
      // steep ground reads as rock regardless of elevation
      const rocky = Math.max(0, Math.min(1, (slope - 0.35) * 2.2));
      r = r * (1 - rocky) + 0.40 * rocky;
      g = g * (1 - rocky) + 0.375 * rocky;
      b = b * (1 - rocky) + 0.34 * rocky;
      // subtle per-vertex variation so big faces don't look airbrushed
      const nv = Math.sin(x * 0.043 + y * 0.031) * 0.5 + Math.sin(x * 0.011 - y * 0.017) * 0.5;
      const vmod = 1 + nv * 0.07;
      const vi = (i / 3) * 3;
      colors[vi] = r * vmod;
      colors[vi + 1] = g * vmod;
      colors[vi + 2] = b * vmod;
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

  // ---------------------------------------------------- structures
  private addStructureMeshes(track: Track, terrain: TerrainGrid | null): void {
    if (!this.trackGroup) return;
    const groundSampler = terrain ? (x: number, y: number) => terrain.elevationAt(x, y) : null;
    for (const part of buildStructureMeshes(track, groundSampler)) {
      this.trackGroup.add(this.structureMesh(part));
    }
  }

  private addFeatureMeshes(track: Track): void {
    if (!this.trackGroup) return;
    for (const part of buildFeatureMeshes(track)) {
      this.trackGroup.add(this.structureMesh(part));
    }
  }

  private structureMesh(part: StructureMeshPart): Mesh {
    const geo = new BufferGeometry();
    // [x, y_plan, z_up] -> three [x, z_up, -y_plan]
    const pos = new Float32Array(part.positions.length);
    for (let i = 0; i < part.positions.length; i += 3) {
      pos[i] = part.positions[i];
      pos[i + 1] = part.positions[i + 2];
      pos[i + 2] = -part.positions[i + 1];
    }
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setIndex(new BufferAttribute(part.indices, 1));
    geo.computeVertexNormals();
    const colors: Record<string, number> = {
      bridge: 0x9a968c,
      piers: 0x8f8b81,
      tunnel: 0x43444a,
      portals: 0x95897a,
      retaining: 0x8f8b80,
      rock: 0x6b6357,
      embankment: 0x465c34,
      "pit-lane": 0x484b52,
      "pit-wall": 0xc8c4bc,
      "service-road": 0x5c5c58,
    };
    const mat = new MeshStandardMaterial({
      color: colors[part.name] ?? 0x8a857c,
      roughness: part.name === "tunnel" ? 0.8 : 0.95,
      metalness: 0,
      side: DoubleSide,
    });
    const mesh = new Mesh(geo, mat);
    // walls/tubes hug or bury into the terrain; letting them cast shadows
    // only buys shadow-acne on their curved faces (the km-wide shadow map
    // can't resolve them). Bridges/piers keep their dramatic long shadows.
    const casts = part.name === "bridge" || part.name === "piers";
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    mesh.name = `structure_${part.name}`;
    return mesh;
  }

  private headlight: PointLight | null = null;

  // ---------------------------------------------------- hover tooltip
  private hoverRay = new Raycaster();
  private hitMeshes: Mesh[] = [];
  private hoverEl: HTMLDivElement | null = null;
  private hoverPos: { x: number; y: number } | null = null;
  private lastHoverT = 0;

  private setupHover(): void {
    const el = document.createElement("div");
    el.className = "hover-tip3d";
    el.style.display = "none";
    this.container.appendChild(el);
    this.hoverEl = el;
    const onMove = (e: PointerEvent) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.hoverPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    // listen on both: overlays may sit between the pointer and the canvas
    this.renderer.domElement.addEventListener("pointermove", onMove);
    this.container.addEventListener("pointermove", onMove);
    this.container.addEventListener("pointerleave", () => {
      this.hoverPos = null;
      if (this.hoverEl) this.hoverEl.style.display = "none";
    });
  }

  private updateHover(now: number): void {
    const el = this.hoverEl;
    if (!el) return;
    if (!this.hoverPos || this.driveActive || !this.state?.track || now - this.lastHoverT < 70) {
      if (!this.hoverPos || this.driveActive) el.style.display = "none";
      return;
    }
    this.lastHoverT = now;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      (this.hoverPos.x / rect.width) * 2 - 1,
      -(this.hoverPos.y / rect.height) * 2 + 1,
    );
    this.hoverRay.setFromCamera(ndc, this.camera);
    const hits = this.hoverRay.intersectObjects(this.hitMeshes, false);
    const track = this.state.track;
    if (hits.length === 0 || !track) {
      el.style.display = "none";
      return;
    }
    const uv = hits[0].uv;
    if (!uv) {
      el.style.display = "none";
      return;
    }
    const s = ((uv.x * 6) % track.length + track.length) % track.length;
    const idx = Math.round(s / track.ds) % track.samples.length;
    const smp = track.samples[idx];
    const props = track.props;
    const fi = props.featureIdx[idx];
    const feat = fi >= 0 ? track.features[fi] : null;
    const { SurfaceNames, KerbNames, RunoffNames } = { SurfaceNames: SURFACE_NAMES, KerbNames: KERB_NAMES, RunoffNames: RUNOFF_NAMES };
    const rows: string[] = [];
    rows.push(`<div class="tt-head">${(s / 1000).toFixed(2)} km${feat ? ` · <span style="color:${FeatureColors[feat.kind]}">${feat.name}</span>` : ""}</div>`);
    if (feat) rows.push(`<div class="tt-row dim">${FeatureLabels[feat.kind]}</div>`);
    rows.push(`<div class="tt-row">${SurfaceNames[props.surface[idx]]} · grip ${props.grip[idx].toFixed(2)}</div>`);
    rows.push(`<div class="tt-row">width ${(props.widthL[idx] + props.widthR[idx]).toFixed(1)} m · bank ${(smp.bank * 57.3).toFixed(1)}° · z ${smp.z.toFixed(1)} m</div>`);
    rows.push(`<div class="tt-row dim">kerb ${KerbNames[props.kerbL[idx]]}/${KerbNames[props.kerbR[idx]]} · ${RunoffNames[props.runoffL[idx]]}/${RunoffNames[props.runoffR[idx]]}</div>`);
    if (Number.isFinite(smp.speed)) rows.push(`<div class="tt-row dim">v ≈ ${(smp.speed * 3.6).toFixed(0)} km/h</div>`);
    el.innerHTML = rows.join("");
    el.style.display = "block";
    const pad = 14;
    const elW = el.offsetWidth;
    const elH = el.offsetHeight;
    let lx = this.hoverPos.x + pad;
    let ly = this.hoverPos.y + pad;
    if (lx + elW > rect.width - 8) lx = this.hoverPos.x - elW - pad;
    if (ly + elH > rect.height - 8) ly = this.hoverPos.y - elH - pad;
    el.style.left = `${lx}px`;
    el.style.top = `${ly}px`;
  }

  // ---------------------------------------------------- feature labels
  private labelSprites: { sprite: Sprite; s: number }[] = [];

  private addFeatureLabels(track: Track): void {
    this.labelSprites = [];
    const feats = track.features ?? [];
    const zones = track.zones ?? [];
    const makeLabel = (text: string, sub: string, accent: string, sAt: number, height: number) => {
      const cv = document.createElement("canvas");
      const ctx = cv.getContext("2d")!;
      ctx.font = "600 34px 'Segoe UI', system-ui, sans-serif";
      const wText = ctx.measureText(text).width;
      ctx.font = "500 22px 'Segoe UI', system-ui, sans-serif";
      const wSub = ctx.measureText(sub).width;
      cv.width = Math.ceil(Math.max(wText, wSub)) + 48;
      cv.height = 96;
      const c2 = cv.getContext("2d")!;
      c2.fillStyle = "rgba(12,15,19,0.82)";
      c2.beginPath();
      c2.roundRect(0, 10, cv.width, 76, 10);
      c2.fill();
      c2.fillStyle = accent;
      c2.fillRect(0, 24, 7, 48);
      c2.font = "600 34px 'Segoe UI', system-ui, sans-serif";
      c2.fillStyle = "#f2f3f5";
      c2.fillText(text, 22, 46);
      c2.font = "500 22px 'Segoe UI', system-ui, sans-serif";
      c2.fillStyle = "#9aa3ad";
      c2.fillText(sub, 22, 76);
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      const mat = new SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const sp = new Sprite(mat);
      const smp = sampleAt(track, sAt);
      sp.position.set(smp.x, smp.z + height, -smp.y);
      const aspect = cv.width / cv.height;
      sp.scale.set(30 * aspect, 30, 1);
      sp.renderOrder = 50;
      this.labelSprites.push({ sprite: sp, s: sAt });
      this.trackGroup?.add(sp);
    };
    feats.forEach((f, fi) => {
      const sMid = (f.sStart + f.sEnd) / 2;
      // stagger heights so clustered labels don't stack
      makeLabel(f.name, FeatureLabels[f.kind], FeatureColors[f.kind], sMid, 22 + (fi % 3) * 11);
    });
    zones.forEach((z, zi) => {
      const sMid = (z.sStart + z.sEnd) / 2;
      makeLabel(z.name, "section", "#8a97a8", sMid, 48 + (zi % 2) * 14);
    });
  }

  /** Per-frame label upkeep: distance fade + roughly constant screen size. */
  private updateLabels(): void {
    const span = this.state?.track ? estimateSpan(this.state.track) : 2000;
    for (const { sprite } of this.labelSprites) {
      const d = this.camera.position.distanceTo(sprite.position);
      const mat = sprite.material as SpriteMaterial;
      mat.opacity = Math.max(0, Math.min(1, 1.25 - d / (span * 1.1)));
      const w = Math.max(14, Math.min(52, d * 0.045));
      const aspect = sprite.scale.x / Math.max(1e-6, sprite.scale.y);
      sprite.scale.set(w * aspect, w, 1);
      // hide when it's right on top of the camera
      if (d < 55) mat.opacity = 0;
    }
  }

  // ------------------------------------------------------------- tick
  private tick(dt: number): void {
    const state = this.state;
    if (!state) return;
    if (this.driveActive && state.track) {
      this.controls.enabled = false;
      // headlight so tunnels/unlit cuts read while driving
      if (!this.headlight) {
        this.headlight = new PointLight(0xfff4e2, 0, 95, 1.5);
        this.scene.add(this.headlight);
      }
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
      if (this.headlight) {
        this.headlight.intensity = 260;
        this.headlight.position.set(here.x, here.z + 4, -here.y);
      }
    } else {
      if (this.headlight) this.headlight.intensity = 0;
      this.controls.enabled = true;
      this.controls.update();
      this.updateLabels();
      this.updateHover(performance.now());
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
