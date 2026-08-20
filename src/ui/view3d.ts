/**
 * Three.js 3D view: banked track ribbon, terrain, curbs, sky, orbit
 * camera and an onboard "drive the lap" camera following the estimated
 * speed profile.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildGridMesh, buildTrackMesh } from "../export/mesh";
import { sampleAt } from "../core/types";
import { carveSampler } from "../core/terrain";
import type { AppState } from "./state";
import type { Track } from "../core/types";

const PART_COLORS: Record<string, number> = {
  asphalt: 0x2f3033,
  curb_left: 0xb93232,
  curb_right: 0xd8d8d8,
  runoff_left: 0x70705f,
  runoff_right: 0x70705f,
};

export class View3D {
  private container: HTMLElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private trackGroup: Group | null = null;
  private raf = 0;
  private state: AppState | null = null;
  private disposed = false;

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
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.inset = "0";
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x0d1117);
    this.scene.fog = new Fog(0x0d1117, 2500, 9000);

    this.camera = new PerspectiveCamera(55, 1, 0.5, 20000);
    this.camera.position.set(0, 400, 800);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    const hemi = new AmbientLight(0x93a7c4, 0.85);
    this.scene.add(hemi);
    const sun = new DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(1200, 1800, 700);
    this.scene.add(sun);

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
    const trackChanged = this.state?.track !== state.track || this.state?.terrain !== state.terrain;
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

  private rebuildScene(state: AppState): void {
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      this.trackGroup.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as MeshStandardMaterial).dispose();
        }
      });
    }
    this.trackGroup = new Group();
    const track = state.track;
    if (track) {
      const mesh = buildTrackMesh(track, { curbWidth: 1.2, runoffWidth: 8, stride: 1 });
      for (const part of mesh.parts) {
        if (part.count === 0) continue;
        const m = this.partMesh(mesh.positions, mesh.normals, mesh.indices, part.start, part.count, PART_COLORS[part.name] ?? 0x777777);
        m.name = part.name;
        this.trackGroup.add(m);
      }
      // start/finish pole
      this.addStartFinish(track);

      // fit camera on first build
      const cx = track.samples[0].x;
      const cy = track.samples[0].y;
      const cz = track.samples[0].z;
      this.controls.target.set(cx, cz, -cy);
      const span = estimateSpan(track);
      const terrainMaxZ = state.terrain ? state.terrain.maxElevation : cz;
      const camY = Math.max(cz + span * 0.5, terrainMaxZ + span * 0.22);
      this.camera.position.set(cx + span * 0.65, camY, -cy + span * 0.65);
    }
    // terrain / ground
    if (state.terrain && track) {
      const g = state.terrain;
      const maxSide = 220;
      const strideT = Math.max(1, Math.floor(Math.max(g.width, g.height) / maxSide));
      const sampler = carveSampler(g, track.samples, 26, 110);
      const gm = buildGridMesh(
        sampler,
        g.originX,
        g.originY,
        g.originX + (g.width - 1) * g.resolution,
        g.originY + (g.height - 1) * g.resolution,
        Math.max(2, Math.floor((g.width - 1) / strideT)),
        Math.max(2, Math.floor((g.height - 1) / strideT)),
      );
      const terrain = this.gridMesh(gm.positions, gm.indices, 0x2c4423);
      this.trackGroup.add(terrain);
    } else if (track) {
      const span = estimateSpan(track) * 2.2;
      const gm = buildGridMesh(() => -0.08, -span / 2, -span / 2, span / 2, span / 2, 2, 2);
      const ground = this.gridMesh(gm.positions, gm.indices, 0x24351f);
      this.trackGroup.add(ground);
    }
    this.scene.add(this.trackGroup);
  }

  /** Convert our z-up mesh data to three.js y-up. */
  private partMesh(
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    start: number,
    count: number,
    color: number,
  ): Mesh {
    const used = new Map<number, number>();
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    for (let i = start; i < start + count; i++) {
      const vi = indices[i];
      let ni = used.get(vi);
      if (ni === undefined) {
        ni = used.size;
        used.set(vi, ni);
        pos.push(positions[vi * 3], positions[vi * 3 + 2], -positions[vi * 3 + 1]);
        nrm.push(normals[vi * 3], normals[vi * 3 + 2], -normals[vi * 3 + 1]);
      }
      idx.push(ni);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
    geo.setIndex(idx);
    const mat = new MeshStandardMaterial({ color, roughness: 0.94, metalness: 0.02, side: DoubleSide });
    return new Mesh(geo, mat);
  }

  private gridMesh(positions: Float32Array, indices: Uint32Array, color: number): Mesh {
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
    return new Mesh(
      geo,
      new MeshStandardMaterial({ color, roughness: 1, metalness: 0, side: DoubleSide }),
    );
  }

  private addStartFinish(track: Track): void {
    const p = track.samples[0];
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    const hw = p.width / 2;
    const a = new Vector3(p.x + nx * hw, p.z + 0.1, -(p.y + ny * hw));
    const b = new Vector3(p.x - nx * hw, p.z + 0.1, -(p.y - ny * hw));
    const len = a.distanceTo(b);
    const boxGeo = new BufferGeometry();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const verts = new Float32Array([
      -len / 2, 0, -0.4, len / 2, 0, -0.4, len / 2, 0, 0.4,
      -len / 2, 0, -0.4, len / 2, 0, 0.4, -len / 2, 0, 0.4,
    ]);
    boxGeo.setAttribute("position", new BufferAttribute(verts, 3));
    boxGeo.computeVertexNormals();
    const box = new Mesh(boxGeo, new MeshStandardMaterial({ color: 0x4fc3f7, side: DoubleSide }));
    box.position.copy(mid);
    box.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    this.trackGroup!.add(box);
  }

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
      // banking tilt offset
      const nx = -Math.sin(here.heading);
      const ny = Math.cos(here.heading);
      const camX = here.x + nx * (this.driveChase ? -0 : 0);
      const camY = here.y + ny * 0;
      if (this.driveChase) {
        const backS = (this.driveS - 14 + track.length) % track.length;
        const back = sampleAt(track, backS);
        this.camera.position.set(back.x, back.z + 6.5, -back.y);
        this.camera.lookAt(ahead.x, ahead.z + 1.5, -ahead.y);
      } else {
        this.camera.position.set(camX, here.z + h, -camY);
        this.camera.lookAt(ahead.x, ahead.z + h * 0.6, -ahead.y);
      }
      // subtle bank roll
      this.camera.rotateZ(this.driveChase ? 0 : -here.bank * 0.5);
    } else {
      this.controls.enabled = true;
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

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
