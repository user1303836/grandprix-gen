/**
 * Three.js 3D view: banked track ribbon with striped curbs and edge lines,
 * hypsometric hillshaded terrain, surrounding context terrain, water,
 * procedural trees, OSM buildings, shadow-mapped sun, gradient sky, orbit
 * camera and an onboard "drive the lap" camera following the estimated
 * speed profile.
 */

import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PointLight,
  Raycaster,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  ConeGeometry,
  CylinderGeometry,
  BoxGeometry,
  IcosahedronGeometry,
  PlaneGeometry,
  CircleGeometry,
  Quaternion,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { SkyDome, type SkyStyle } from "./sky";
import { makeAsphaltTexture, makeConcreteTexture, makeGrassTexture, makeGravelTexture, makeMownGrassTexture } from "./textures";
import { buildFurniture, windUniform } from "./furniture";
import { CloudShadows, makeWaterMaterial } from "./water";
import { DriveHUD } from "./driveHud";
import { RainSystem } from "./rain";
import { buildCar } from "./car";
import { SpraySystem } from "./spray";
import {
  ACESFilmicToneMapping,
  Vector2 as Vec2,
  PMREMGenerator,
  Color as ThreeColor,
  DataTexture,
  RGBAFormat,
  FloatType,
  EquirectangularReflectionMapping,
} from "three";
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
import { carBasisWorld, planToWorld, roadFrameAt } from "../core/roadFrame";
import { carveSampler, makeTrackProximity, type TerrainGrid } from "../core/terrain";
import type { OsmBuilding } from "../core/osm";
import { Rng } from "../core/prng";
import type { AppState } from "./state";
import type { Track } from "../core/types";

const PART_COLORS: Record<string, number> = {
  asphalt: 0x5a5d66,
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

export type DayTime = "noon" | "golden" | "dusk" | "night";
export type Weather = "dry" | "rain";

interface SkyPreset {
  sunElevation: number; // degrees above horizon
  sunAzimuth: number;
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  fogColor: number;
  fogNearK: number; // multiplier of span
  fogFarK: number;
  exposure: number;
  bloom: number;
  floodlights: boolean;
}

const SKY_STYLES: Record<DayTime, SkyStyle> = {
  noon: {
    zenith: 0x2f62ab, horizon: 0xa8c8e2, ground: 0x5c6e7a,
    sunColor: 0xfff3dc, sunIntensity: 0.85, cloudCover: 0.34,
    cloudTint: 0xf4f7fa, stars: 0, haze: 0.3,
  },
  golden: {
    zenith: 0x3a5a94, horizon: 0xe8b083, ground: 0x5c5248,
    sunColor: 0xffc27a, sunIntensity: 1.25, cloudCover: 0.28,
    cloudTint: 0xf6d9b8, stars: 0, haze: 0.42,
  },
  dusk: {
    zenith: 0x2c3a68, horizon: 0xc97a5e, ground: 0x3c3644,
    sunColor: 0xff8a52, sunIntensity: 1.5, cloudCover: 0.3,
    cloudTint: 0xb89aa8, stars: 0.25, haze: 0.5,
  },
  night: {
    zenith: 0x060a18, horizon: 0x18243c, ground: 0x05070c,
    sunColor: 0xb8c8e8, sunIntensity: 0.28, cloudCover: 0.22,
    cloudTint: 0x2a3450, stars: 1, haze: 0.3,
  },
};

const SKY_PRESETS: Record<DayTime, SkyPreset> = {
  noon: {
    sunElevation: 52, sunAzimuth: 155, sunColor: 0xfff2dd, sunIntensity: 2.6,
    ambientColor: 0xb4b8bc, ambientIntensity: 0.55,
    turbidity: 7, rayleigh: 2.0, mieCoefficient: 0.004, mieDirectionalG: 0.8,
    fogColor: 0x9db4c8, fogNearK: 3.6, fogFarK: 13, exposure: 1.05, bloom: 0.16,
    floodlights: false,
  },
  golden: {
    sunElevation: 14, sunAzimuth: 245, sunColor: 0xffc98a, sunIntensity: 2.0,
    ambientColor: 0xa89a8c, ambientIntensity: 0.42,
    turbidity: 8, rayleigh: 3.2, mieCoefficient: 0.009, mieDirectionalG: 0.85,
    fogColor: 0xc9a98a, fogNearK: 3.0, fogFarK: 10, exposure: 1.02, bloom: 0.24,
    floodlights: false,
  },
  dusk: {
    sunElevation: 4.5, sunAzimuth: 262, sunColor: 0xffa86e, sunIntensity: 1.15,
    ambientColor: 0x84849a, ambientIntensity: 0.42,
    turbidity: 9, rayleigh: 3.6, mieCoefficient: 0.014, mieDirectionalG: 0.9,
    fogColor: 0x7a6e88, fogNearK: 2.8, fogFarK: 9.5, exposure: 0.98, bloom: 0.34,
    floodlights: true,
  },
  night: {
    sunElevation: -9, sunAzimuth: 262, sunColor: 0x8aa2d8, sunIntensity: 0.6,
    ambientColor: 0x5a6a9a, ambientIntensity: 1.1,
    turbidity: 3, rayleigh: 0.4, mieCoefficient: 0.001, mieDirectionalG: 0.7,
    fogColor: 0x16202e, fogNearK: 2.6, fogFarK: 9, exposure: 1.0, bloom: 0.75,
    floodlights: true,
  },
};

class ValleyMist {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;
  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: { time: { value: 0 }, strength: { value: 0 } },
      vertexShader: "varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader:
        "varying vec3 vWorld; uniform float time; uniform float strength;" +
        "float h(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }" +
        "float vn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);" +
        " return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y); }" +
        "float fb(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<4;i++){ v+=a*vn(p); p=p*2.13+17.7; a*=0.52; } return v; }" +
        "void main(){ vec2 p = vWorld.xz * 0.0009 + vec2(time*0.006, time*0.002);" +
        " float m = fb(p); float a = smoothstep(0.42, 0.72, m) * strength;" +
        " gl_FragColor = vec4(0.82, 0.86, 0.9, a); }",
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 6;
  }
  configure(cx: number, cz: number, y: number, size: number, strength: number): void {
    this.mesh.position.set(cx, y, cz);
    this.mesh.scale.set(size, size, 1);
    this.mat.uniforms.strength.value = strength;
  }
  setTime(t: number): void {
    this.mat.uniforms.time.value = t;
  }
  lerpStrength(target: number, k: number): void {
    this.mat.uniforms.strength.value += (target - this.mat.uniforms.strength.value) * k;
  }
}

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
  private asphaltTex = makeAsphaltTexture();
  private grassTex = makeGrassTexture();
  private gravelTex = makeGravelTexture();
  private concreteTex = makeConcreteTexture();
  private mownTex = makeMownGrassTexture();
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private sky: SkyDome;
  private dayTime: DayTime = "noon";
  private weather: Weather = "dry";
  private season: "summer" | "autumn" = "summer";
  private rain = new RainSystem();
  private cars: { group: Group; s: number; factor: number }[];
  private spray: SpraySystem;
  private wetFactor = 0; // 0 dry, 1 soaked (lerped)
  private hemi: AmbientLight;

  // drive mode
  driveActive = false;
  driveS = 0;
  driveSpeedMult = 1;
  driveCamHeight = 1.7;
  driveChase = false;
  driveTV = false;
  private tvCamPos: { x: number; y: number; z: number } | null = null;
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
    this.scene.fog = new Fog(0x9db4c8, 3000, 14000);

    this.camera = new PerspectiveCamera(55, 1, 0.5, 30000);
    this.camera.position.set(0, 400, 800);

    // stylized sky dome (gradient + sun + clouds + stars)
    this.sky = new SkyDome();
    this.scene.add(this.sky.mesh);

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
    this.setupDayControl();
    this.hud = new DriveHUD(this.container);
    this.setupFlare();
    this.scene.add(this.rain.points);
    this.setupWeatherControl();
    this.setupCamControl();
    this.setupSeasonControl();
    // imagery attribution (required when satellite drape is shown)
    const attrib = document.createElement("div");
    attrib.className = "imagery-attrib";
    attrib.textContent = "Imagery \u00a9 Esri \u2014 Source: Esri, Maxar, Earthstar Geographics";
    attrib.style.display = "none";
    this.container.appendChild(attrib);
    this.attribEl = attrib;
    this.cars = [
      { group: buildCar(0x2a52c8), s: 0, factor: 1 },
      { group: buildCar(0xc83a2a), s: 0.4, factor: 1.045 },
      { group: buildCar(0xe8e4da), s: 0.72, factor: 0.955 },
    ];
    for (const c of this.cars) this.scene.add(c.group);
    this.spray = new SpraySystem();
    this.scene.add(this.spray.points);

    this.hemi = new AmbientLight(0xb4b8bc, 0.55);
    this.scene.add(this.hemi);
    this.sun = new DirectionalLight(0xfff2dd, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 2.0;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.stripedCurbTex = makeCurbStripeTexture();

    // ---------- post-processing ----------
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new Vec2(1, 1), 0.22, 0.6, 1.02);
    this.composer.addPass(this.bloomPass);
    // vignette + subtle grain
    const vignettePass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, strength: { value: 0.22 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;" +
        "void main(){ vec4 c = texture2D(tDiffuse, vUv);" +
        " float d = distance(vUv, vec2(0.5));" +
        " float v = smoothstep(0.42, 0.86, d) * strength;" +
        " gl_FragColor = vec4(c.rgb * (1.0 - v), c.a); }",
    });
    this.composer.addPass(vignettePass);
    this.composer.addPass(new SMAAPass(this.container.clientWidth || 1280, this.container.clientHeight || 800));
    this.composer.addPass(new OutputPass());
    this.applyDayTime();

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
    this.composer.setSize(w, h);
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
    if (this.attribEl) this.attribEl.style.display = v && this.state?.imagery && this.state.showSatellite ? "block" : "none";
    if (this.dayControl) this.dayControl.style.display = v ? "flex" : "none";
    if (this.weatherControl) this.weatherControl.style.display = v ? "flex" : "none";
    if (this.seasonControl) this.seasonControl.style.display = v ? "flex" : "none";
    if (!v && this.hoverEl) this.hoverEl.style.display = "none";
    if (v && this.needsRebuild && this.state) {
      this.rebuildScene(this.state);
      this.needsRebuild = false;
    }
  }

  private fitBtn: HTMLButtonElement | null = null;
  private attribEl: HTMLDivElement | null = null;

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
      this.trackGroup.add(buildFurniture(track));
      this.addPuddles(track);
      this.maybeFitCamera(track, state.terrain);
      this.rebuildFloodlights();
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
      const drape = state.showSatellite ? state.imagery : null;
      const siteMesh = this.terrainMesh(g, carve, maxSide, 0, holeTest, drape);
      siteMesh.receiveShadow = true;
      this.trackGroup.add(siteMesh);
      // coarse surrounding context -- carved identically, otherwise its
      // coarse triangles roof over the cut trenches the site mesh opens
      if (state.terrainContext) {
        const ctx = state.terrainContext;
        const ctxCarve = carveSampler(ctx, track.samples, track.carveMask, 40, 120, track.carveInner);
        const ctxDrape = state.showSatellite ? state.imageryContext : null;
        const ctxMesh = this.terrainMesh(ctx, (x, y) => ctxCarve(x, y), 200, 0, null, ctxDrape);
        ctxMesh.position.y = -1.5; // site mesh wins the overlap
        ctxMesh.receiveShadow = true;
        this.trackGroup.add(ctxMesh);
      }
      // water (animated ripples + sun glint)
      const minZ = Math.min(g.minElevation, state.terrainContext?.minElevation ?? Infinity);
      if (minZ < 2) {
        const extent =
          Math.max(
            state.terrainContext ? state.terrainContext.width * state.terrainContext.resolution : 0,
            g.width * g.resolution,
          ) * 0.75;
        const water = buildGridMesh(() => Math.max(0.25, minZ + 0.1), -extent, -extent, extent, extent, 2, 2);
        const wm = this.gridMesh(water.positions, water.indices, 0x2b4a63, true);
        wm.material = makeWaterMaterial(this.sunDirection());
        (wm.material as ShaderMaterial).uniforms.shallow.value.setHex(SKY_STYLES[this.dayTime].horizon);
        (wm.material as ShaderMaterial).uniforms.sunColor.value.setHex(SKY_STYLES[this.dayTime].sunColor);
        this.trackGroup.add(wm);
      }
      // drifting cloud shadows over the whole site
      const spanC = Math.max(g.width, g.height) * g.resolution;
      this.cloudShadows.configure(
        (g.originX + (g.width * g.resolution) / 2),
        -(g.originY + (g.height * g.resolution) / 2),
        (g.minElevation + g.maxElevation) / 2 + 55,
        spanC * 1.5,
        SKY_PRESETS[this.dayTime].floodlights ? 0 : 0.3,
      );
      this.trackGroup.add(this.cloudShadows.mesh);
      // valley mist hugs the low ground (dusk/night/dawn feel)
      this.valleyMist.configure(
        g.originX + (g.width * g.resolution) / 2,
        -(g.originY + (g.height * g.resolution) / 2),
        g.minElevation + 10,
        spanC * 1.4,
        0,
      );
      this.trackGroup.add(this.valleyMist.mesh);
      this.addTrees(state.terrain, track);
      this.addGrassTufts(state.terrain, track);
      this.addBoulders(state.terrain, track);
      if (state.buildings && state.buildings.length > 0) {
        // seat buildings on the CARVED terrain so they don't float/sink
        // where the corridor flattens the ground
        const carved = carveSampler(state.terrain, track.samples, track.carveMask, 40, 120, track.carveInner);
        this.trackGroup.add(this.buildingsMesh(state.buildings, carved));
        const win = this.buildingWindowsMesh(state.buildings, carved);
        if (win) {
          win.visible = SKY_PRESETS[this.dayTime].floodlights;
          this.windowsMesh = win;
          this.trackGroup.add(win);
        }
      }
    } else if (track) {
      const span = estimateSpan(track) * 9;
      const gm = buildGridMesh(() => -0.08, -span / 2, -span / 2, span / 2, span / 2, 2, 2);
      const ground = this.gridMesh(gm.positions, gm.indices, 0x51683c);
      const gmat = ground.material as MeshStandardMaterial;
      this.mownTex.repeat.set(1, 1); // world-scale uvs already tile it
      gmat.map = this.mownTex;
      gmat.color.setHex(0x93a273);
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
      const dir = this.sunDirection();
      this.sun.position.set(c.x + dir.x * span * 1.5, c.z + Math.max(120, dir.y * span * 1.5), -c.y + dir.z * span * 1.5);
    }
    // fog scales with the site so overview shots don't wash out
    const preset = SKY_PRESETS[this.dayTime];
    this.scene.fog = new Fog(preset.fogColor, span * preset.fogNearK, span * preset.fogFarK);

    this.scene.add(this.trackGroup);
    // match env intensity to the weather
    const wet = this.weather === "rain";
    const intensity = wet ? 0.85 : 0.38;
    this.trackGroup.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) {
        o.material.envMapIntensity = intensity;
      }
    });
  }

  private fitCamera(track: Track, terrain: TerrainGrid | null): void {
    const c = track.samples[0];
    this.controls.target.set(c.x, c.z, -c.y);
    const span = estimateSpan(track);
    const terrainMaxZ = terrain ? terrain.maxElevation : c.z;
    const camY = Math.max(c.z + span * 0.55, terrainMaxZ + span * 0.25);
    const endX = c.x + span * 0.62;
    const endZ = -c.y + span * 0.62;
    if (!this.didIntro) {
      // cinematic swoop: start far/high, ease into the frame
      this.didIntro = true;
      this.swoop = {
        t: 0,
        from: new Vector3(endX + span * 1.6, camY * 2.6 + 600, endZ - span * 2.2),
        to: new Vector3(endX, camY, endZ),
      };
      this.camera.position.set(endX + span * 1.6, camY * 2.6 + 600, endZ - span * 2.2);
    } else {
      this.camera.position.set(endX, camY, endZ);
    }
  }

  private didIntro = false;
  private swoop: { t: number; from: Vector3; to: Vector3 } | null = null;

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

  /** Record `seconds` of the current view as a WebM download. */
  recordVideo(seconds = 8): boolean {
    const stream = this.renderer.domElement.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 14_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `grandprix-gen-${this.dayTime}-${Date.now() % 100000}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
    try {
      rec.start();
      setTimeout(() => rec.stop(), seconds * 1000);
      return true;
    } catch {
      return false;
    }
  }

  /** Capture the current render as a PNG download. */
  captureScreenshot(): void {
    this.composer.render();
    const url = this.renderer.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `grandprix-gen-${this.dayTime}-${Date.now() % 100000}.png`;
    a.click();
  }

  /** Public: the floating "fit view" button. */
  resetView(): void {
    if (!this.state?.track) return;
    this.fitCamera(this.state.track, this.state.terrain);
    this.lastTerrain = this.state.terrain;
  }

  // ---------------------------------------------------------- day time
  private envTex: import("three").Texture | null = null;
  private pmrem: PMREMGenerator | null = null;

  /** Rebuild the scene environment map from the sky style (reflections). */
  private updateEnvironment(): void {
    if (!this.pmrem) this.pmrem = new PMREMGenerator(this.renderer);
    const st = SKY_STYLES[this.dayTime];
    const raining = this.weather === "rain";
    const zen = new ThreeColor(raining ? 0x3a4450 : st.zenith);
    const hor = new ThreeColor(raining ? 0x6a7480 : st.horizon);
    const grd = new ThreeColor(raining ? 0x2a3038 : st.ground);
    // 64x32 equirect gradient: zenith top, horizon middle, ground bottom
    const w = 64;
    const h = 32;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1); // 0 top .. 1 bottom
      for (let x = 0; x < w; x++) {
        let c: ThreeColor;
        if (t < 0.5) {
          c = zen.clone().lerp(hor, t * 2);
        } else {
          c = hor.clone().lerp(grd, (t - 0.5) * 2);
        }
        const i = (y * w + x) * 4;
        data[i] = c.r;
        data[i + 1] = c.g;
        data[i + 2] = c.b;
        data[i + 3] = 1;
      }
    }
    const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
    tex.mapping = EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    const rt = this.pmrem.fromEquirectangular(tex);
    if (this.envTex) this.envTex.dispose();
    this.envTex = rt.texture;
    this.scene.environment = this.envTex;
    // reflections: subtle on dry, present when wet
    const wet = this.weather === "rain";
    const intensity = wet ? 0.85 : 0.38;
    this.scene.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) {
        o.material.envMapIntensity = intensity;
      }
    });
    tex.dispose();
  }

  private applyDayTime(): void {
    const p = SKY_PRESETS[this.dayTime];
    // sky dome style (rain overrides toward slate overcast)
    if (this.weather === "rain") {
      this.sky.setStyle({
        zenith: 0x3a4450, horizon: 0x6a7480, ground: 0x2a3038,
        sunColor: 0xb8c4d4, sunIntensity: 0.25, cloudCover: 0.9,
        cloudTint: 0x4a5460, stars: 0, haze: 0.55,
      });
    } else {
      this.sky.setStyle(SKY_STYLES[this.dayTime]);
    }
    this.sky.setSunDirection(this.sunDirection());
    // lights
    this.sun.color.setHex(this.weather === "rain" ? 0xaebdd2 : p.sunColor);
    this.sun.intensity = this.weather === "rain" ? p.sunIntensity * 0.55 : p.sunIntensity;
    this.hemi.color.setHex(this.weather === "rain" ? 0x7a8694 : p.ambientColor);
    this.hemi.intensity = this.weather === "rain" ? p.ambientIntensity * 1.25 : p.ambientIntensity;
    // fog + exposure + bloom
    const span = this.state?.track ? estimateSpan(this.state.track) * 1.4 : 2200;
    const raining = this.weather === "rain";
    this.scene.fog = new Fog(raining ? 0x5a646e : p.fogColor, span * (raining ? 1.6 : p.fogNearK), span * (raining ? 6.5 : p.fogFarK));
    this.renderer.toneMappingExposure = raining ? p.exposure * 0.9 : p.exposure;
    this.bloomPass.strength = p.bloom;
    this.bloomPass.threshold = this.dayTime === "night" ? 0.55 : 1.55;
    // floodlights (only sensible with a track)
    this.rebuildFloodlights();
    this.updateEnvironment();
    if (this.windowsMesh) this.windowsMesh.visible = p.floodlights;
  }

  private sunDirection(): Vector3 {
    const p = SKY_PRESETS[this.dayTime];
    const phi = (90 - p.sunElevation) * (Math.PI / 180);
    const theta = p.sunAzimuth * (Math.PI / 180);
    return new Vector3().setFromSphericalCoords(1, phi, theta);
  }

  /** Day-time segmented control (floating, 3D only). */
  private dayControl: HTMLDivElement | null = null;
  private setupDayControl(): void {
    const wrap = document.createElement("div");
    wrap.className = "day-control";
    for (const t of ["noon", "golden", "dusk", "night"] as const) {
      const b = document.createElement("button");
      b.textContent = t;
      b.dataset.day = t;
      if (t === this.dayTime) b.classList.add("active");
      b.addEventListener("click", () => {
        this.dayTime = t;
        wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        this.applyDayTime();
      });
      wrap.appendChild(b);
    }
    wrap.style.display = "none";
    this.container.appendChild(wrap);
    this.dayControl = wrap;
  }

  // ---------------------------------------------------------- lens flare
  private flareSprites: { sp: Sprite; k: number; size: number; tint: number; op: number }[] = [];
  private setupFlare(): void {
    const mkGlow = (inner: string, outer: string): CanvasTexture => {
      const cv = document.createElement("canvas");
      cv.width = 128;
      cv.height = 128;
      const ctx = cv.getContext("2d")!;
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      return new CanvasTexture(cv);
    };
    const diskTex = mkGlow("rgba(255,255,250,1)", "rgba(255,240,200,0)");
    const ghostTex = mkGlow("rgba(255,230,190,0.55)", "rgba(255,230,190,0)");
    const defs: [number, number, number, number][] = [
      [1.0, 220, 0xfff8e8, 0.9], // core
      [0.78, 60, 0xffe8b8, 0.35],
      [0.55, 34, 0xd8e8ff, 0.28],
      [0.35, 90, 0xffe0a8, 0.2],
      [0.12, 26, 0xffffff, 0.22],
    ];
    for (const [k, size, tint, op] of defs) {
      const mat = new SpriteMaterial({
        map: k === 1 ? diskTex : ghostTex,
        color: tint,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });
      const sp = new Sprite(mat);
      sp.renderOrder = 60;
      this.flareSprites.push({ sp, k, size, tint, op });
      this.scene.add(sp);
    }
  }

  /** Position/opacity of the flare along the sun line each frame. */
  private updateFlare(): void {
    if (this.flareSprites.length === 0) return;
    const sunDir = this.sunDirection();
    const p = SKY_PRESETS[this.dayTime];
    const raining = this.weather === "rain";
    const visible = sunDir.y > 0.01 && !raining;
    // vector from camera toward the sun, projected through the view center
    const camDir = new Vector3();
    this.camera.getWorldDirection(camDir);
    const facing = camDir.dot(sunDir);
    const strength = visible ? Math.max(0, facing - 0.25) * p.sunIntensity * 0.4 : 0;
    const dist = 8000;
    const center = this.camera.position.clone().add(camDir.clone().multiplyScalar(4000));
    const sunPos = this.camera.position.clone().add(sunDir.clone().multiplyScalar(dist));
    for (const f of this.flareSprites) {
      // k=1 at the sun, others interpolated toward the screen center
      f.sp.position.copy(sunPos.clone().lerp(center, 1 - f.k));
      f.sp.scale.set(f.size, f.size, 1);
      (f.sp.material as SpriteMaterial).opacity = f.op * strength;
    }
  }

  /** Cinematic auto-orbit: slow aerial dolly around the circuit. */
  cinemaMode = false;
  toggleCinema(): void {
    this.cinemaMode = !this.cinemaMode;
    this.controls.autoRotate = this.cinemaMode;
    this.controls.autoRotateSpeed = 0.55;
  }

  private seasonControl: HTMLDivElement | null = null;
  private setupSeasonControl(): void {
    const wrap = document.createElement("div");
    wrap.className = "day-control season-control";
    for (const m of ["summer", "autumn"] as const) {
      const b = document.createElement("button");
      b.textContent = m === "summer" ? "\u{1F331} summer" : "\u{1F342} autumn";
      b.dataset.season = m;
      if (m === this.season) b.classList.add("active");
      b.addEventListener("click", () => {
        this.season = m;
        wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        if (this.state) this.rebuildScene(this.state);
      });
      wrap.appendChild(b);
    }
    wrap.style.display = "none";
    this.container.appendChild(wrap);
    this.seasonControl = wrap;
  }

  /** Drive camera: cockpit / chase / tv. */
  private camControl: HTMLDivElement | null = null;
  private setupCamControl(): void {
    const wrap = document.createElement("div");
    wrap.className = "day-control cam-control";
    for (const m of ["cockpit", "chase", "tv"] as const) {
      const b = document.createElement("button");
      b.textContent = m === "tv" ? "TV" : m;
      b.dataset.cam = m;
      if (m === "cockpit") b.classList.add("active");
      b.addEventListener("click", () => {
        this.driveChase = m !== "cockpit";
        this.driveTV = m === "tv";
        this.tvCamPos = null;
        wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      });
      wrap.appendChild(b);
    }
    wrap.style.display = "none";
    this.container.appendChild(wrap);
    this.camControl = wrap;
  }

  private weatherControl: HTMLDivElement | null = null;
  private setupWeatherControl(): void {
    const wrap = document.createElement("div");
    wrap.className = "day-control weather-control";
    for (const w of ["dry", "rain"] as const) {
      const b = document.createElement("button");
      b.textContent = w === "dry" ? "\u2600 dry" : "\u2614 rain";
      b.dataset.weather = w;
      if (w === this.weather) b.classList.add("active");
      b.addEventListener("click", () => {
        this.weather = w;
        wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        this.applyDayTime();
      });
      wrap.appendChild(b);
    }
    wrap.style.display = "none";
    this.container.appendChild(wrap);
    this.weatherControl = wrap;
  }

  /** Wetness lerp + material wet-look application. */
  private updateWetness(dt: number): void {
    const target = this.weather === "rain" ? 1 : 0;
    if (Math.abs(this.wetFactor - target) > 0.002) {
      this.wetFactor += (target - this.wetFactor) * Math.min(1, dt * 1.5);
      const wf = this.wetFactor;
      this.trackGroup?.traverse((o) => {
        if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) {
          const m = o.material;
          if (o.name.startsWith("asphalt") || o.name.startsWith("kerb") || o.name.startsWith("line") || o.name === "structure_pit-lane" || o.name === "structure_service-road") {
            m.roughness = (m.userData.dryRough ?? (m.userData.dryRough = m.roughness)) * (1 - wf * 0.75);
            m.metalness = wf * 0.35;
          }
          if (o.name === "buildings" || o.name.startsWith("structure")) {
            m.roughness = (m.userData.dryRough ?? (m.userData.dryRough = m.roughness)) * (1 - wf * 0.4);
          }
          // terrain soaks: slightly darker + tighter
          if (o.geometry?.attributes?.color && !o.name.startsWith("structure") && !o.name.startsWith("barrier")) {
            m.roughness = (m.userData.dryRough ?? (m.userData.dryRough = m.roughness)) * (1 - wf * 0.25);
            m.color.setScalar(1 - wf * 0.16);
          }
        }
      });
      // terrain darkens when soaked
      this.rain.setActive(this.wetFactor > 0.25);
      if (this.puddles) this.puddles.visible = this.wetFactor > 0.25;
    }
  }

  // ---------------------------------------------------------- floodlights
  private floodGroup: Group | null = null;
  private floodPositions: Vector3[] = [];
  private floodLights: { light: PointLight; idx: number }[] = [];

  private rebuildFloodlights(): void {
    if (this.floodGroup) {
      this.scene.remove(this.floodGroup);
      this.floodGroup.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as MeshStandardMaterial).dispose();
        }
      });
      this.floodGroup = null;
    }
    for (const fl of this.floodLights) this.scene.remove(fl.light);
    this.floodLights = [];
    this.floodPositions = [];
    const track = this.state?.track;
    if (!track || !SKY_PRESETS[this.dayTime].floodlights) return;

    // pole geometry: shared
    const poleGeo = new CylinderGeometry(0.12, 0.22, 13.5, 5);
    const poleMat = new MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.6, metalness: 0.6 });
    const headGeo = new BoxGeometry(2.6, 0.5, 1.1);
    const headMat = new MeshStandardMaterial({
      color: 0x303236,
      emissive: 0xfff6dc,
      emissiveIntensity: 4.5,
    });
    const poles = new InstancedMesh(poleGeo, poleMat, 0);
    const heads = new InstancedMesh(headGeo, headMat, 0);
    this.floodGroup = new Group();
    this.floodGroup.add(poles, heads);

    const n = track.samples.length;
    const spacing = Math.max(1, Math.round(130 / track.ds));
    const positions: { x: number; y: number; z: number; heading: number; side: number }[] = [];
    for (let i = 0; i < n; i += spacing) {
      const smp = track.samples[i];
      const side = (i / spacing) % 2 === 0 ? 1 : -1;
      const nx = -Math.sin(smp.heading);
      const ny = Math.cos(smp.heading);
      const off = side * (Math.max(track.props.widthL[i], track.props.widthR[i]) + 13);
      positions.push({
        x: smp.x + nx * off,
        y: smp.y + ny * off,
        z: smp.z - off * Math.sin(smp.bank),
        heading: smp.heading,
        side,
      });
    }
    poles.count = positions.length;
    heads.count = positions.length;
    const m4 = new Matrix4();
    positions.forEach((p2, i) => {
      m4.makeTranslation(p2.x, p2.z + 6.75, -p2.y);
      poles.setMatrixAt(i, m4);
      // head tilted toward the track
      m4.makeRotationY(-p2.heading + (p2.side > 0 ? Math.PI : 0));
      m4.setPosition(p2.x, p2.z + 13.6, -p2.y);
      heads.setMatrixAt(i, m4);
      this.floodPositions.push(new Vector3(p2.x, p2.z + 13.6, -p2.y));
    });
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    poles.castShadow = true;
    // volumetric-ish light shafts: additive translucent cones under each head
    const shaftGeo = new ConeGeometry(4.2, 11.5, 12, 1, true);
    shaftGeo.translate(0, -5.75, 0);
    const shaftMat = new MeshBasicMaterial({
      color: 0xffeecc,
      transparent: true,
      opacity: 0.032,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const shafts = new InstancedMesh(shaftGeo, shaftMat, positions.length);
    positions.forEach((p2, i) => {
      m4.makeTranslation(p2.x, p2.z + 13.6, -p2.y);
      shafts.setMatrixAt(i, m4);
    });
    shafts.instanceMatrix.needsUpdate = true;
    shafts.renderOrder = 40;
    this.shaftMesh = shafts;
    this.shaftBase = positions.map((p2) => new Vector3(p2.x, p2.z + 13.6, -p2.y));
    this.floodGroup.add(shafts);
    this.scene.add(this.floodGroup);
    // pool of real lights, repositioned to the poles nearest the camera
    const poolSize = 5;
    for (let i = 0; i < poolSize; i++) {
      const l = new PointLight(0xfff2d0, 0, 110, 1.7);
      this.scene.add(l);
      this.floodLights.push({ light: l, idx: -1 });
    }
  }

  private readonly basisM4 = new Matrix4();
  private readonly basisQ = new Quaternion();
  /** Orient a car from the shared 3D road frame (no Euler guessing). */
  private orientCar(group: Group, track: Track, sPos: number, dt: number): void {
    const frame = roadFrameAt(track, sPos);
    const b = carBasisWorld(frame);
    this.basisM4.makeBasis(
      new Vector3(b.x.x, b.x.y, b.x.z),
      new Vector3(b.y.x, b.y.y, b.y.z),
      new Vector3(b.z.x, b.z.y, b.z.z),
    );
    this.basisQ.setFromRotationMatrix(this.basisM4);
    const k = 1 - Math.exp(-dt * 16); // fast smoothing, no visible lag
    group.quaternion.slerp(this.basisQ, k);
    const pW = planToWorld(frame.position);
    const nW = planToWorld(frame.normal);
    group.position.set(pW.x + nW.x * 0.02, pW.y + nW.y * 0.02, pW.z + nW.z * 0.02);
  }

  /** Keep the live light pool on the poles nearest the camera. */
  private shaftMesh: InstancedMesh | null = null;
  private shaftBase: Vector3[] = [];
  private updateFloodlights(): void {
    if (this.floodPositions.length === 0) return;
    // find nearest poles
    const cam = this.camera.position;
    const sorted = this.floodPositions
      .map((p, i) => ({ d: p.distanceToSquared(cam), i }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.floodLights.length);
    this.floodLights.forEach((fl, k) => {
      const pick = sorted[k];
      fl.light.position.copy(this.floodPositions[pick.i]);
      fl.light.intensity = 1400;
    });
    // hide shafts near the camera (additive cones blow out up close)
    if (this.shaftMesh) {
      const m4 = new Matrix4();
      const sc = new Vector3();
      const q = new Quaternion();
      this.shaftBase.forEach((p, i) => {
        const d = p.distanceTo(this.camera.position);
        const k = d < 26 ? 0.0001 : d < 60 ? (d - 26) / 34 : 1;
        sc.setScalar(k);
        m4.compose(p, q, sc);
        this.shaftMesh!.setMatrixAt(i, m4);
      });
      this.shaftMesh.instanceMatrix.needsUpdate = true;
    }
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
    if (isAsphalt) {
      this.asphaltTex.repeat.set(1, 3);
    }
    const mat = new MeshStandardMaterial({
      color: new Color(baseColor),
      roughness: isAsphalt ? 0.94 : isRunoff && kindLabel === "gravel" ? 1 : 0.85,
      metalness: 0,
      side: DoubleSide,
      vertexColors: isAsphalt, // surface tint + mottle lives in vertex colors
      map: isAsphalt ? this.asphaltTex : isRunoff && kindLabel === "gravel" ? this.gravelTex : null,
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
    /** satellite drape (canvas + local bounds) */
    drape: import("./imagery").ImageryDrape | null = null,
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
    return this.coloredGridMesh(gm.positions, gm.indices, grid, drape);
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
    // world uvs for ground textures
    const uvs = new Float32Array(pos.length / 3 * 2);
    for (let i = 0; i < pos.length / 3; i++) {
      uvs[i * 2] = pos[i * 3] / 208;
      uvs[i * 2 + 1] = pos[i * 3 + 2] / 208;
    }
    geo.setAttribute("uv", new BufferAttribute(uvs, 2));
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
  private coloredGridMesh(positions: Float32Array, indices: Uint32Array, grid: TerrainGrid, drape: import("./imagery").ImageryDrape | null = null): Mesh {
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
      const autumnShift = this.season === "autumn" ? 1 : 0;
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
      if (autumnShift) {
        // turn greens toward rust/straw
        const r2 = r * 1.5 + 0.08;
        const g2 = g * 0.82 + 0.02;
        const b2 = b * 0.55;
        r = Math.min(1, r2);
        g = Math.min(1, g2);
        b = b2;
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
    // uvs: drape-accurate when satellite is available, else grass tiling
    const uvs = new Float32Array(nVerts * 2);
    for (let i = 0; i < positions.length; i += 3) {
      if (drape) {
        uvs[(i / 3) * 2] = (positions[i] - drape.minX) / drape.spanX;
        uvs[(i / 3) * 2 + 1] = (drape.minY + drape.spanY - positions[i + 1]) / drape.spanY;
      } else {
        uvs[(i / 3) * 2] = positions[i] / 57;
        uvs[(i / 3) * 2 + 1] = positions[i + 1] / 57;
      }
    }
    if (drape) {
      // satellite reads clean: neutral vertex colors
      for (let i = 0; i < colors.length; i++) colors[i] = 1;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(colors, 3));
    geo.setAttribute("uv", new BufferAttribute(uvs, 2));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide });
    if (drape) {
      const tex = new CanvasTexture(drape.canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      tex.flipY = false;
      mat.map = tex;
    } else {
      // grass detail breaks up the hypsometric flat shading up close
      mat.map = this.grassTex;
    }
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
    const conifers: { m: Matrix4; s: number }[] = [];
    const leafies: { m: Matrix4; s: number }[] = [];
    const step = 4; // grid cells between candidates
    const zMid = (grid.minElevation + grid.maxElevation) / 2;
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
        // elevation banding: conifers rule the heights, leafy below
        const conifer = z > zMid + rng.spread(40);
        const scale = 0.7 + rng.next() * 0.9;
        const m = new Matrix4()
          .makeRotationY(rng.range(0, Math.PI * 2))
          .setPosition(x, z, -y)
          .scale(new Vector3(scale, scale, scale));
        (conifer ? conifers : leafies).push({ m, s: scale });
        if (conifers.length + leafies.length >= 4000) break;
      }
      if (conifers.length + leafies.length >= 4000) break;
    }
    if (conifers.length + leafies.length === 0) return;

    const trunkGeo = new CylinderGeometry(0.22, 0.34, 3.2, 5);
    trunkGeo.translate(0, 1.6, 0);
    const trunkMat = new MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });
    const coneGeo = new ConeGeometry(2.5, 8.5, 6);
    coneGeo.translate(0, 6.6, 0);
    const autumn = this.season === "autumn";
    const coneBase = autumn ? 0x7a5c22 : 0x3d6132;
    const leafBase = autumn ? 0xb87a2e : 0x517434;
    const coneMat = new MeshStandardMaterial({ color: coneBase, roughness: 1 });
    const leafGeo = new IcosahedronGeometry(3.4, 1);
    leafGeo.translate(0, 5.2, 0);
    leafGeo.scale(1, 1.25, 1);
    const leafMat = new MeshStandardMaterial({ color: leafBase, roughness: 1 });
    // gentle wind sway (vertex shader wobble, phase from instance matrix)
    for (const m of [coneMat, leafMat]) {
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.windTime;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uTime;")
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec2 wpos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
              float wphase = wpos.x * 0.07 + wpos.y * 0.11;
              float sway = sin(uTime * 1.3 + wphase) * 0.5 + sin(uTime * 2.1 + wphase * 1.7) * 0.3;
              transformed.x += sway * max(0.0, transformed.y - 2.0) * 0.09;
              transformed.z += sway * max(0.0, transformed.y - 2.0) * 0.05;
            #endif`,
          );
      };
    }

    const total = conifers.length + leafies.length;
    const trunks = new InstancedMesh(trunkGeo, trunkMat, total);
    const cones = new InstancedMesh(coneGeo, coneMat, Math.max(1, conifers.length));
    const leaves = new InstancedMesh(leafGeo, leafMat, Math.max(1, leafies.length));
    let ti = 0;
    conifers.forEach((c, i) => {
      trunks.setMatrixAt(ti++, c.m);
      cones.setMatrixAt(i, c.m);
      // slight per-instance color variation
      cones.setColorAt(i, new Color(coneBase).offsetHSL(autumn ? 0.03 : 0, 0, (c.s - 1) * 0.08));
    });
    leafies.forEach((c, i) => {
      trunks.setMatrixAt(ti++, c.m);
      leaves.setMatrixAt(i, c.m);
      leaves.setColorAt(i, new Color(leafBase).offsetHSL((c.s - 1) * (autumn ? 0.06 : 0.04), 0, (c.s - 1) * 0.07));
    });
    trunks.instanceMatrix.needsUpdate = true;
    cones.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (cones.instanceColor) cones.instanceColor.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    trunks.castShadow = cones.castShadow = leaves.castShadow = true;
    trunks.name = "trees-trunks";
    cones.name = "trees-conifers";
    leaves.name = "trees-leafy";
    this.trackGroup!.add(trunks, cones, leaves);
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

  /** Warm lit windows sprinkled on building faces (visible at night). */
  private buildingWindowsMesh(buildings: OsmBuilding[], elevAt: (x: number, y: number) => number): Mesh | null {
    const winGeo = new PlaneGeometry(0.9, 0.7);
    const winMat = new MeshBasicMaterial({
      color: 0xffca7a,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mats: Matrix4[] = [];
    const rng = new Rng(0xb1b1);
    for (const b of buildings) {
      const nWin = rng.int(0, 3);
      for (let k = 0; k < nWin; k++) {
        const ring = b.footprint;
        const ei = rng.int(0, ring.length - 2);
        const [x0, y0] = ring[ei];
        const [x1, y1] = ring[ei + 1];
        const t = rng.next();
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        const base = elevAt(x, y);
        const z = (Number.isFinite(base) ? base : 0) - 0.3 + b.height * (0.35 + rng.next() * 0.5);
        const ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
        const m4 = new Matrix4().makeRotationY(-ang);
        m4.setPosition(x, z, -y);
        mats.push(m4);
        if (mats.length > 900) break;
      }
      if (mats.length > 900) break;
    }
    if (mats.length === 0) return null;
    const inst = new InstancedMesh(winGeo, winMat, mats.length);
    mats.forEach((m4, i) => inst.setMatrixAt(i, m4));
    inst.instanceMatrix.needsUpdate = true;
    inst.name = "building-windows";
    inst.renderOrder = 30;
    return inst;
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
    // world-space uvs so the concrete texture tiles at ~7 m
    const uv2 = new Float32Array(pos.length / 3 * 2);
    for (let i = 0; i < pos.length / 3; i++) {
      uv2[i * 2] = (pos[i * 3] + pos[i * 3 + 2]) / 7;
      uv2[i * 2 + 1] = pos[i * 3 + 1] / 7;
    }
    geo.setAttribute("uv", new BufferAttribute(uv2, 2));
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
    const useConcrete = part.name === "bridge" || part.name === "piers" || part.name === "retaining" || part.name === "portals";
    const mat = new MeshStandardMaterial({
      color: colors[part.name] ?? 0x8a857c,
      roughness: part.name === "tunnel" ? 0.8 : 0.95,
      metalness: 0,
      side: DoubleSide,
      map: useConcrete ? this.concreteTex : null,
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
  private windowsMesh: Mesh | null = null;
  private baseFov = 55;
  private driveActivePrev = false;
  private orbitCarS = 0;
  private cloudShadows = new CloudShadows();
  private valleyMist = new ValleyMist();
  private windTime = { value: 0 };
  private hud: DriveHUD;

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
  private labelFade = 1;
  private updateLabels(dt = 0.016): void {
    const span = this.state?.track ? estimateSpan(this.state.track) : 2000;
    // drive view: labels stay out of the way (the HUD calls features itself)
    const target = this.driveActive ? 0.18 : 1;
    this.labelFade += (target - this.labelFade) * Math.min(1, dt * 5);
    for (const { sprite } of this.labelSprites) {
      const d = this.camera.position.distanceTo(sprite.position);
      const mat = sprite.material as SpriteMaterial;
      mat.opacity = this.labelFade * Math.max(0, Math.min(1, 1.25 - d / (span * 1.1)));
      const w = Math.max(14, Math.min(52, d * 0.045));
      const aspect = sprite.scale.x / Math.max(1e-6, sprite.scale.y);
      sprite.scale.set(w * aspect, w, 1);
      // hide when it's right on top of the camera
      if (d < 55) mat.opacity = 0;
    }
  }

  /** Boulders on steep slopes (they read as rock outcrops). */
  private addBoulders(grid: TerrainGrid, track: Track): void {
    const proximity = makeTrackProximity(track.samples);
    const rng = new Rng(track.seed ^ 0xb01d);
    const spots: { m: Matrix4; shade: number }[] = [];
    const step = 3;
    for (let iy = 2; iy < grid.height - 2; iy += step) {
      for (let ix = 2; ix < grid.width - 2; ix += step) {
        const x = grid.originX + (ix + rng.spread(0.5)) * grid.resolution;
        const y = grid.originY + (iy + rng.spread(0.5)) * grid.resolution;
        const slope = grid.slopeAt(x, y);
        if (slope < 0.5) continue; // only steep ground
        const z = grid.elevationAt(x, y);
        if (!Number.isFinite(z) || z < 3) continue;
        const near = proximity.nearest(x, y, 55);
        if (near && near.d < 45) continue;
        if (rng.next() < 0.6) continue;
        const sc = 0.6 + rng.next() * 2.4;
        const m = new Matrix4()
          .makeRotationY(rng.range(0, Math.PI * 2))
          .setPosition(x, z - sc * 0.3, -y)
          .scale(new Vector3(sc, sc * (0.55 + rng.next() * 0.4), sc));
        spots.push({ m, shade: rng.next() });
        if (spots.length >= 900) break;
      }
      if (spots.length >= 900) break;
    }
    if (spots.length === 0) return;
    const geo = new IcosahedronGeometry(1.6, 0);
    const mat = new MeshStandardMaterial({ color: 0x7a7268, roughness: 1 });
    const inst = new InstancedMesh(geo, mat, spots.length);
    spots.forEach((sp, i) => {
      inst.setMatrixAt(i, sp.m);
      inst.setColorAt(i, new Color(0x7a7268).offsetHSL(0, 0, (sp.shade - 0.5) * 0.16));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true;
    inst.name = "boulders";
    this.trackGroup!.add(inst);
  }

  /** Puddles on the road in the wet (mirror-gloss patches). */
  private puddles: InstancedMesh | null = null;
  private addPuddles(track: Track): void {
    const rng = new Rng(track.seed ^ 0x9dd1);
    const mats: Matrix4[] = [];
    const n = track.samples.length;
    const stride = Math.max(1, Math.round(42 / track.ds));
    for (let i = 0; i < n; i += stride) {
      if (rng.next() < 0.45) continue;
      const smp = track.samples[i];
      const off = rng.spread(Math.min(track.props.widthL[i], track.props.widthR[i]) * 0.5);
      const nx = -Math.sin(smp.heading);
      const ny = Math.cos(smp.heading);
      const m4 = new Matrix4().makeRotationY(-smp.heading + rng.spread(0.4));
      m4.setPosition(smp.x + nx * off, smp.z + 0.035, -smp.y - ny * off);
      m4.scale(new Vector3(1.2 + rng.next() * 2.6, 1, 0.9 + rng.next() * 1.8));
      mats.push(m4);
    }
    const geo = new CircleGeometry(1, 18);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshStandardMaterial({
      color: 0x1a2028,
      roughness: 0.05,
      metalness: 0.85,
      transparent: true,
      opacity: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    this.puddles = new InstancedMesh(geo, mat, mats.length);
    mats.forEach((m4, i) => this.puddles!.setMatrixAt(i, m4));
    this.puddles.instanceMatrix.needsUpdate = true;
    this.puddles.receiveShadow = true;
    this.puddles.name = "puddles";
    this.puddles.visible = this.wetFactor > 0.25;
    this.trackGroup!.add(this.puddles);
  }

  /** Small instanced grass tufts hugging the corridor (close-up richness). */
  private addGrassTufts(grid: TerrainGrid, track: Track): void {
    const rng = new Rng(track.seed ^ 0x6a55);
    const proximity = makeTrackProximity(track.samples);
    const spots: Matrix4[] = [];
    const stride = Math.max(1, Math.round(9 / track.ds));
    const n = track.samples.length;
    for (let i = 0; i < n && spots.length < 2600; i += stride) {
      const smp = track.samples[i];
      for (let k = 0; k < 3; k++) {
        const side = rng.bool() ? 1 : -1;
        const w = side > 0 ? track.props.widthL[i] : track.props.widthR[i];
        const off = side * (w + 3.5 + rng.next() * 18);
        const nx = -Math.sin(smp.heading);
        const ny = Math.cos(smp.heading);
        const x = smp.x + nx * off + rng.spread(3);
        const y = smp.y + ny * off + rng.spread(3);
        const z = grid.elevationAt(x, y);
        if (!Number.isFinite(z)) continue;
        const near = proximity.nearest(x, y, 6);
        if (near && near.d < 5.5) continue; // never in the road
        const sc = 0.5 + rng.next() * 0.9;
        spots.push(
          new Matrix4()
            .makeRotationY(rng.range(0, Math.PI * 2))
            .setPosition(x, z, -y)
            .scale(new Vector3(sc, sc * (0.8 + rng.next() * 0.5), sc)),
        );
      }
    }
    if (spots.length === 0) return;
    const tuftGeo = new ConeGeometry(0.55, 1.5, 4);
    tuftGeo.translate(0, 0.7, 0);
    const tuftMat = new MeshStandardMaterial({ color: this.season === "autumn" ? 0x8a722e : 0x4a6a2e, roughness: 1 });
    const inst = new InstancedMesh(tuftGeo, tuftMat, spots.length);
    spots.forEach((m, i) => {
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, new Color(this.season === "autumn" ? 0x8a722e : 0x4a6a2e).offsetHSL(rng.spread(0.03), 0, rng.spread(0.09)));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true;
    inst.name = "grass-tufts";
    this.trackGroup!.add(inst);
  }

  // ------------------------------------------------------------- tick
  private tick(dt: number): void {
    const state = this.state;
    if (!state) return;
    if (this.driveActive !== this.driveActivePrev) {
      this.driveActivePrev = this.driveActive;
      this.hud.setVisible(this.driveActive);
      // start lights: red on the grid, green when away
      this.trackGroup?.traverse((o) => {
        if (o.name.startsWith("startlight_") && o instanceof Mesh) {
          (o.material as MeshStandardMaterial).emissive.setHex(this.driveActive ? 0x22dd44 : 0xff2a22);
        }
      });
      if (this.driveActive) this.baseFov = this.camera.fov;
      else this.tvCamPos = null;
      if (this.camControl) this.camControl.style.display = this.driveActive ? "flex" : "none";
    }
    if (this.driveActive && state.track) {
      this.controls.enabled = false;
      // headlight so tunnels/unlit cuts read while driving
      if (!this.headlight) {
        this.headlight = new PointLight(0xfff4e2, 0, 95, 1.5);
        this.scene.add(this.headlight);
      }
      const track = state.track;
      // field: player car follows driveS; rivals lap at their own factors
      {
        const i = Math.floor(this.driveS / track.ds) % track.samples.length;
        const vNow = Number.isFinite(track.samples[i].speed) ? track.samples[i].speed : 50;
        this.cars.forEach((c, ci) => {
          if (ci === 0) {
            c.s = this.driveS;
          } else {
            c.s = (c.s + vNow * c.factor * dt) % track.length;
          }
          this.orientCar(c.group, track, c.s, dt);
          c.group.visible = ci === 0 ? this.driveChase : true;
          // spray behind each car when wet (along the 3D tangent)
          if (this.wetFactor > 0.3 && vNow > 22) {
            const f = roadFrameAt(track, c.s);
            const tW = planToWorld(f.tangent);
            const pW = planToWorld(f.position);
            this.spray.emit(
              pW.x - tW.x * 2.2,
              pW.y + 0.4,
              pW.z - tW.z * 2.2,
              -tW.x * vNow * 0.25,
              -tW.z * vNow * 0.25,
            );
          }
        });
      }
      if (!Number.isFinite(this.driveS)) this.driveS = 0;
      const idx = Math.floor(this.driveS / track.ds) % track.samples.length;
      const v = Number.isFinite(track.samples[idx].speed) ? track.samples[idx].speed : 30;
      this.driveS = (this.driveS + v * this.driveSpeedMult * dt) % track.length;
      const here = sampleAt(track, this.driveS);
      const lookS = (this.driveS + (this.driveChase ? 25 : 45)) % track.length;
      const ahead = sampleAt(track, lookS);
      const h = this.driveCamHeight;
      if (this.driveTV) {
        // spectator TV camera: posted at a slow corner, pans to the nearest car
        if (!this.tvCamPos) {
          const slowest = track.corners.reduce((a, b) => (a.minRadius < b.minRadius ? a : b));
          const i = Math.round(slowest.sApex / track.ds) % track.samples.length;
          const smp = track.samples[i];
          const side = slowest.direction === "L" ? -1 : 1;
          const nx = -Math.sin(smp.heading);
          const ny = Math.cos(smp.heading);
          const off = side * (Math.max(track.props.widthL[i], track.props.widthR[i]) + 26);
          this.tvCamPos = { x: smp.x + nx * off, y: smp.z + 16 - off * Math.sin(smp.bank), z: -smp.y - ny * off };
        }
        this.camera.position.set(this.tvCamPos.x, this.tvCamPos.y, this.tvCamPos.z);
        // track the nearest car
        let bestD = Infinity;
        let target: Vector3 | null = null;
        for (const c of this.cars) {
          const d = c.group.position.distanceToSquared(this.camera.position);
          if (d < bestD) {
            bestD = d;
            target = c.group.position;
          }
        }
        if (target) this.camera.lookAt(target.x, target.y + 0.8, target.z);
      } else if (this.driveChase) {
        const fHere = roadFrameAt(track, this.driveS);
        const tW = planToWorld(fHere.tangent);
        const nW = planToWorld(fHere.normal);
        const pW = planToWorld(fHere.position);
        this.camera.up.set(nW.x, nW.y, nW.z);
        this.camera.position.set(pW.x - tW.x * 15 + nW.x * 7.6, pW.y - tW.y * 15 + nW.y * 7.6, pW.z - tW.z * 15 + nW.z * 7.6);
        this.camera.lookAt(ahead.x, ahead.z + 1.6, -ahead.y);
      } else {
        const fHere = roadFrameAt(track, this.driveS);
        const nW = planToWorld(fHere.normal);
        this.camera.up.set(nW.x, nW.y, nW.z);
        this.camera.position.set(here.x + nW.x * h * 0.1, here.z + h, -here.y + nW.z * h * 0.1);
        this.camera.lookAt(ahead.x, ahead.z + h * 0.6, -ahead.y);
      }
      // FOV kick + roughness shake at speed
      const kmh = v * 3.6;
      const targetFov = this.baseFov + Math.min(11, Math.max(0, (kmh - 120) * 0.055));
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 5);
      this.camera.updateProjectionMatrix();
      const rough = state.track.props?.roughness?.[idx] ?? 0.2;
      const shakeAmp = Math.min(0.34, (kmh / 330) * (0.05 + rough * 0.3)) * (this.driveChase ? 0.4 : 1);
      if (shakeAmp > 0.01) {
        const tSh = performance.now() / 1000;
        this.camera.position.x += Math.sin(tSh * 37.3) * shakeAmp * 0.5;
        this.camera.position.y += Math.sin(tSh * 51.7 + 1.3) * shakeAmp * 0.35;
        this.camera.position.z += Math.sin(tSh * 43.1 + 2.9) * shakeAmp * 0.5;
      }
      this.updateLabels(dt);
      this.hud.update(state, this.driveS, v, dt);
      if (this.headlight) {
        this.headlight.intensity = SKY_PRESETS[this.dayTime].floodlights ? 260 : 120;
        const fH = roadFrameAt(track, this.driveS);
        const tW = planToWorld(fH.tangent);
        const nW = planToWorld(fH.normal);
        const pW = planToWorld(fH.position);
        this.headlight.position.set(pW.x + tW.x * 8 + nW.x * 3.5, pW.y + tW.y * 8 + nW.y * 3.5, pW.z + tW.z * 8 + nW.z * 3.5);
      }
      this.updateFloodlights();
    } else {
      if (this.headlight) this.headlight.intensity = 0;
      if (this.swoop) {
        this.swoop.t += dt / 2.2;
        const t = Math.min(1, this.swoop.t);
        const e = 1 - Math.pow(1 - t, 3);
        this.camera.position.lerpVectors(this.swoop.from, this.swoop.to, e);
        if (t >= 1) this.swoop = null;
      }
      // the field keeps lapping in orbit view at a relaxed pace
      if (state.track) {
        this.orbitCarS = ((this.orbitCarS ?? 0) + dt * 52) % state.track.length;
        this.cars.forEach((c, ci) => {
          const cs = ci === 0 ? this.orbitCarS : (this.orbitCarS * c.factor + ci * state.track!.length * 0.31) % state.track!.length;
          this.orientCar(c.group, state.track!, cs, dt);
          c.group.visible = true;
          if (this.wetFactor > 0.3) {
            const f = roadFrameAt(state.track!, cs);
            const tW = planToWorld(f.tangent);
            const pW = planToWorld(f.position);
            this.spray.emit(pW.x - tW.x * 2.2, pW.y + 0.4, pW.z - tW.z * 2.2, -tW.x * 12, -tW.z * 12);
          }
        });
      }
      if (this.camera.fov !== this.baseFov) {
        this.camera.fov += (this.baseFov - this.camera.fov) * Math.min(1, dt * 6);
        this.camera.updateProjectionMatrix();
      }
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
      this.controls.update();
      this.updateLabels(dt);
      this.updateHover(performance.now());
      this.updateFloodlights();
    }
    const tNow = performance.now() / 1000;
    this.sky.setPosition(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.sky.setTime(tNow);
    this.cloudShadows.setTime(tNow);
    this.valleyMist.setTime(tNow);
    // mist strongest at dusk/night, faint at golden, none at noon
    const mistTarget = this.dayTime === "dusk" ? 0.28 : this.dayTime === "night" ? 0.17 : this.dayTime === "golden" ? 0.12 : 0;
    this.valleyMist.lerpStrength(mistTarget, Math.min(1, dt));
    this.updateFlare();
    this.windTime.value = tNow;
    windUniform.value = tNow;
    this.updateWetness(dt);
    this.spray.update(dt);
    this.rain.update(dt, this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.trackGroup?.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof ShaderMaterial && o.material.uniforms?.time) {
        o.material.uniforms.time.value = tNow;
      }
    });
    this.composer.render();
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
