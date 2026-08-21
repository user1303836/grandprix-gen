/**
 * Trackside furniture: distance boards at braking zones, sponsor
 * billboards, the start/finish gantry, grid slot paint, grandstands and
 * marshal posts. Everything is seeded from the track so the circuit
 * always looks dressed the same way.
 */

import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  DoubleSide,
} from "three";
import type { Track } from "../core/types";
import { FeatureColors } from "../core/character";

/** Shared wind time uniform (the view drives it every frame). */
export const windUniform = { value: 0 };

const BRAND_WORDS_A = ["VULCAN", "TORQUE", "APEX", "REDLINE", "STRADA", "KOMET", "ZEPHYR", "HAYATE", "MONZA", "VECTOR", "PRIME", "ATLAS"];
const BRAND_WORDS_B = ["OIL", "TYRES", "BRAKES", "FUELS", "MOTORS", "LUBES", "RACING", "PARTS", "ENERGY", "TOOLS", "SYSTEMS", "WORKS"];
const BRAND_COLORS = ["#c8322b", "#20447e", "#e8a018", "#1a7a4a", "#7a2a8a", "#c85a10", "#2a8a9a", "#b8b4ac"];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brand billboard face textures (a handful shared by all boards). */
export function makeBrandTextures(seed: number, count = 6): CanvasTexture[] {
  const rnd = seeded(seed ^ 0x5eed);
  const out: CanvasTexture[] = [];
  for (let k = 0; k < count; k++) {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 128;
    const ctx = cv.getContext("2d")!;
    const bg = BRAND_COLORS[Math.floor(rnd() * BRAND_COLORS.length)];
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 128);
    const brand = `${BRAND_WORDS_A[Math.floor(rnd() * BRAND_WORDS_A.length)]} ${BRAND_WORDS_B[Math.floor(rnd() * BRAND_WORDS_B.length)]}`;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.font = "900 58px 'Arial Black', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(brand, 256, 58);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "700 22px Arial, sans-serif";
    ctx.fillText("OFFICIAL PARTNER", 256, 104);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    out.push(tex);
  }
  return out;
}

/** Number board textures: 150 / 100 / 50. */
export function makeDistanceTextures(): Record<number, CanvasTexture> {
  const out: Partial<Record<number, CanvasTexture>> = {};
  for (const d of [150, 100, 50]) {
    const cv = document.createElement("canvas");
    cv.width = 128;
    cv.height = 128;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#f2f0ea";
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "#c8322b";
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, 116, 116);
    ctx.fillStyle = "#14161a";
    ctx.font = "900 52px 'Arial Black', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(d), 64, 68);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    out[d] = tex;
  }
  return out as Record<number, CanvasTexture>;
}

/** Start gantry banner. */
export function makeGantryTexture(): CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 96;
  const ctx = cv.getContext("2d")!;
  // checkered edges
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#14161a" : "#f2f0ea";
      ctx.fillRect(x * 12, y * 12, 12, 12);
      ctx.fillRect(1024 - (x + 1) * 12, y * 12 + 48, 12, 12);
    }
  }
  ctx.fillStyle = "#14161a";
  ctx.fillRect(192, 0, 640, 96);
  ctx.fillStyle = "#f2f0ea";
  ctx.font = "900 54px 'Arial Black', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("G R A N D P R I X", 512, 50);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Grandstand seats texture (colored dots in rows). */
export function makeStandTexture(seed: number): CanvasTexture {
  const rnd = seeded(seed ^ 0x51ad);
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 32;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#3a3f46";
  ctx.fillRect(0, 0, 64, 32);
  const seatColors = ["#c84a3a", "#e8e4dc", "#3a6ab8", "#e8a83a", "#3aa85a", "#8a8f98"];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      if (rnd() < 0.82) {
        ctx.fillStyle = seatColors[Math.floor(rnd() * seatColors.length)];
        ctx.fillRect(col * 8 + 1, row * 16 + 3, 6, 9);
      }
    }
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

interface Placement {
  x: number;
  y: number; // three-space z (negative plan y)
  z: number; // three-space y (height)
  heading: number;
}

function frameAt(track: Track, s: number): Placement {
  const n = track.samples.length;
  const i = ((Math.round(s / track.ds) % n) + n) % n;
  const smp = track.samples[i];
  return { x: smp.x, y: -smp.y, z: smp.z, heading: smp.heading };
}

function offsetOf(track: Track, i: number, side: number, extra: number): { nx: number; ny: number; off: number } {
  const smp = track.samples[i];
  const nx = -Math.sin(smp.heading);
  const ny = Math.cos(smp.heading);
  const w = side > 0 ? track.props.widthL[i] : track.props.widthR[i];
  return { nx, ny, off: side * (w + extra) };
}

/** Build all furniture for the track. Returns a Group in three-space. */
export function buildFurniture(track: Track): Group {
  const group = new Group();
  const n = track.samples.length;
  const ds = track.ds;
  const rnd = seeded(track.seed ^ 0xf12);
  const L = track.length;

  // ---------- distance boards at corner entries (outside of the corner) ---
  const distTex = makeDistanceTextures();
  const boardGeo = new PlaneGeometry(1.15, 1.15);
  const postGeo = new CylinderGeometry(0.05, 0.05, 1.1, 5);
  const postMat = new MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.6, metalness: 0.5 });
  for (const c of track.corners) {
    if (c.minRadius > 200) continue;
    const side = c.direction === "L" ? -1 : 1; // boards sit outside the corner
    [150, 100, 50].forEach((d, di) => {
      const s = (c.sStart - (d + 10) + L) % L;
      const i = ((Math.round(s / ds) % n) + n) % n;
      const { nx, ny, off } = offsetOf(track, i, side, 6.5);
      const smp = track.samples[i];
      const px = smp.x + nx * off;
      const py = smp.y + ny * off;
      const pz = smp.z - off * Math.sin(smp.bank);
      const post = new Mesh(postGeo, postMat);
      post.position.set(px, pz + 0.55, -py);
      group.add(post);
      const face = new MeshStandardMaterial({ map: distTex[d], side: DoubleSide, roughness: 0.8 });
      const board = new Mesh(boardGeo, face);
      board.position.set(px, pz + 1.35, -py);
      // face back along the track (drivers see it approaching)
      board.rotation.y = -smp.heading + (side > 0 ? Math.PI * 0.9 : -Math.PI * 0.1);
      board.rotation.z = di === 0 ? 0.02 : 0;
      group.add(board);
    });
  }

  // ---------- sponsor billboards along straights ---------------------------
  const brandTex = makeBrandTextures(track.seed);
  const panelGeo = new BoxGeometry(9, 2.4, 0.18);
  const legGeo = new CylinderGeometry(0.09, 0.09, 2.2, 5);
  const stride = Math.max(1, Math.round(260 / ds));
  let boardIdx = 0;
  for (let i = Math.round(60 / ds); i < n; i += stride) {
    if (Math.abs(track.samples[i].kappa) > 0.004) continue; // straights only
    if (rnd() < 0.35) continue;
    const side = rnd() < 0.5 ? 1 : -1;
    const { nx, ny, off } = offsetOf(track, i, side, 11);
    const smp = track.samples[i];
    const px = smp.x + nx * off;
    const py = smp.y + ny * off;
    const pz = smp.z - off * Math.sin(smp.bank);
    const mat = new MeshStandardMaterial({ map: brandTex[boardIdx % brandTex.length], roughness: 0.7 });
    const panel = new Mesh(panelGeo, mat);
    panel.position.set(px, pz + 2.6, -py);
    panel.rotation.y = -smp.heading + (side > 0 ? Math.PI : 0);
    panel.castShadow = true;
    group.add(panel);
    for (const legOff of [-3.6, 3.6]) {
      const leg = new Mesh(legGeo, postMat);
      const lx = px + Math.cos(smp.heading) * legOff;
      const ly = py + Math.sin(smp.heading) * legOff;
      leg.position.set(lx, pz + 1.1, -ly);
      group.add(leg);
    }
    boardIdx++;
  }

  // ---------- checkered start line --------------------------------------------
  {
    const cv = document.createElement("canvas");
    cv.width = 128;
    cv.height = 32;
    const ctx = cv.getContext("2d")!;
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 4; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#14161a" : "#f2f0ea";
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    const smp = track.samples[0];
    const w = track.props.widthL[0] + track.props.widthR[0] - 1;
    const line = new Mesh(
      new PlaneGeometry(w, 1.4),
      new MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1 }),
    );
    line.position.set(smp.x, smp.z + 0.04, -smp.y);
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -smp.heading;
    group.add(line);
  }

  // ---------- waving checkered flag on a pole at start/finish --------------
  {
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 64;
    const ctx = cv.getContext("2d")!;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#14161a" : "#f2f0ea";
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const flagTex = new CanvasTexture(cv);
    flagTex.colorSpace = SRGBColorSpace;
    const smp0 = track.samples[0];
    const { nx, ny, off } = offsetOf(track, 0, -1, 3.2);
    const fx = smp0.x + nx * off;
    const fy = smp0.y + ny * off;
    const pole = new Mesh(new CylinderGeometry(0.06, 0.08, 9.5, 6), postMat);
    pole.position.set(fx, smp0.z + 4.75, -fy);
    pole.castShadow = true;
    group.add(pole);
    const flagMat = new MeshStandardMaterial({ map: flagTex, side: DoubleSide, roughness: 0.9 });
    const flagGeo = new PlaneGeometry(2.6, 1.7, 12, 6);
    const flag = new Mesh(flagGeo, flagMat);
    flag.position.set(fx + 1.32 * Math.cos(smp0.heading), smp0.z + 8.5, -fy + 1.32 * Math.sin(smp0.heading));
    flag.rotation.y = -smp0.heading;
    // wave via vertex displacement (shared windTime uniform, set by view)
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = windUniform;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float wamp = max(0.0, position.x + 1.3) / 2.6;
          transformed.z += sin(uTime * 5.2 + position.x * 3.1) * 0.28 * wamp;
          transformed.y += sin(uTime * 3.7 + position.x * 2.2) * 0.1 * wamp;`,
        );
    };
    group.add(flag);
  }

  // ---------- start/finish gantry ------------------------------------------
  {
    const f = frameAt(track, 0);
    const smp = track.samples[0];
    const w = (track.props.widthL[0] + track.props.widthR[0]) / 2 + 2.5;
    const gantryMat = new MeshStandardMaterial({ color: 0x2e3238, roughness: 0.5, metalness: 0.7 });
    const poleGeo2 = new CylinderGeometry(0.22, 0.28, 8.5, 8);
    for (const side of [-1, 1]) {
      const { nx, ny, off } = offsetOf(track, 0, side, 2.5);
      const pole = new Mesh(poleGeo2, gantryMat);
      pole.position.set(smp.x + nx * off, smp.z + 4.25 - off * Math.sin(smp.bank), -smp.y - ny * off);
      pole.castShadow = true;
      group.add(pole);
    }
    const beamGeo = new BoxGeometry(w * 2, 1.15, 0.75);
    const beam = new Mesh(beamGeo, new MeshStandardMaterial({ map: makeGantryTexture(), roughness: 0.6 }));
    beam.position.set(f.x, f.z + 7.6, f.y);
    beam.rotation.y = -f.heading;
    beam.castShadow = true;
    group.add(beam);
    // start light bar: 5 lamps under the beam (red until the field is away)
    const lampGeo = new CylinderGeometry(0.22, 0.22, 0.1, 10);
    lampGeo.rotateX(Math.PI / 2);
    for (let k = 0; k < 5; k++) {
      const lampMat = new MeshStandardMaterial({
        color: 0x1a1c20,
        emissive: 0xff2a22,
        emissiveIntensity: 2.2,
      });
      const lamp = new Mesh(lampGeo, lampMat);
      lamp.position.set(
        f.x - Math.cos(f.heading) * (k - 2) * 0.85,
        f.z + 6.85,
        -f.y - Math.sin(f.heading) * (k - 2) * 0.85,
      );
      lamp.rotation.y = -f.heading;
      lamp.name = `startlight_${k}`;
      group.add(lamp);
    }
  }

  // ---------- grid slot paint ------------------------------------------------
  {
    const slotMat = new MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1 });
    const slotGeo = new PlaneGeometry(1.5, 5.2);
    const i0 = Math.round(14 / ds);
    for (let row = 0; row < 10; row++) {
      for (const side of [-1, 1]) {
        const i = (i0 + Math.round((row * 7 + (side > 0 ? 3.5 : 0)) / ds)) % n;
        const smp = track.samples[i];
        const w = side > 0 ? track.props.widthL[i] : track.props.widthR[i];
        const { nx, ny, off } = { nx: -Math.sin(smp.heading), ny: Math.cos(smp.heading), off: side * w * 0.52 };
        const slot = new Mesh(slotGeo, slotMat);
        slot.position.set(smp.x + nx * off, smp.z + 0.035, -smp.y - ny * off);
        slot.rotation.x = -Math.PI / 2;
        slot.rotation.z = -smp.heading;
        group.add(slot);
      }
    }
  }

  // ---------- grandstands near the main straight -----------------------------
  {
    const seatTex = makeStandTexture(track.seed);
    seatTex.wrapS = seatTex.wrapT = 1000; // RepeatWrapping
    seatTex.repeat.set(7, 1);
    const nStands = 2 + Math.floor(rnd() * 2);
    for (let k = 0; k < nStands; k++) {
      const s = 40 + k * 55 + rnd() * 20;
      const i = Math.round(s / ds) % n;
      const smp = track.samples[i];
      const side = 1; // pit side (left)
      const { nx, ny, off } = offsetOf(track, i, side, 26);
      const px = smp.x + nx * off;
      const py = smp.y + ny * off;
      // stepped block: 4 steps
      const stand = new Group();
      for (let step = 0; step < 4; step++) {
        const stepGeo = new BoxGeometry(42, 1.6, 3.2);
        const stepMat = new MeshStandardMaterial({
          color: 0xb8bcc2,
          roughness: 0.9,
        });
        const st = new Mesh(stepGeo, stepMat);
        st.position.set(0, 1.2 + step * 1.6, -step * 3.0);
        st.castShadow = true;
        stand.add(st);
        // seat rows on the step face
        const faceGeo = new PlaneGeometry(41, 1.35);
        const faceMat = new MeshStandardMaterial({ map: seatTex, roughness: 0.95 });
        const face = new Mesh(faceGeo, faceMat);
        face.position.set(0, 1.75 + step * 1.6, -step * 3.0 + 1.62);
        stand.add(face);
      }
      // roof
      const roofGeo = new BoxGeometry(43, 0.35, 13);
      const roof = new Mesh(roofGeo, new MeshStandardMaterial({ color: 0xd8dade, roughness: 0.7 }));
      roof.position.set(0, 8.6, -4.6);
      roof.castShadow = true;
      stand.add(roof);
      stand.position.set(px, smp.z, -py);
      stand.rotation.y = -smp.heading; // seat faces point at the track
      group.add(stand);
    }
  }

  // ---------- tire walls at heavy braking zones -------------------------------
  {
    // stacks of red/white tires where you really don't want to arrive
    const tireGeo = new CylinderGeometry(0.72, 0.72, 0.62, 10, 1, true);
    const redMat = new MeshStandardMaterial({ color: 0xb8302a, roughness: 0.92, side: DoubleSide });
    const whiteMat = new MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.92, side: DoubleSide });
    const L2 = track.length;
    for (const c of track.corners) {
      if (c.minRadius > 90) continue; // only the heavy stuff
      const side = c.direction === "L" ? -1 : 1; // outside of the corner
      // wall spans from just before the apex to the exit
      const s0 = (c.sApex - 30 + L2) % L2;
      const s1 = (c.sEnd + 26) % L2;
      const len = ((s1 - s0 + L2) % L2) || 1;
      const step = Math.max(1, Math.round(1.55 / ds));
      let k = 0;
      for (let ss = 0; ss < len; ss += step) {
        const sAt = (s0 + ss) % L2;
        const i = Math.round(sAt / ds) % n;
        const { nx, ny, off } = offsetOf(track, i, side, 7.5);
        const smp = track.samples[i];
        const px = smp.x + nx * off;
        const py = smp.y + ny * off;
        const pz = smp.z - off * Math.sin(smp.bank);
        // two-high stack, slight jitter so the wall looks handmade
        for (let lvl = 0; lvl < 2; lvl++) {
          const tire = new Mesh(tireGeo, (k + lvl) % 2 === 0 ? redMat : whiteMat);
          tire.position.set(px + (rnd() - 0.5) * 0.14, pz + 0.31 + lvl * 0.62, -py + (rnd() - 0.5) * 0.14);
          tire.rotation.y = rnd() * Math.PI;
          tire.castShadow = true;
          group.add(tire);
        }
        k++;
      }
    }
  }

  // ---------- corner name boards at named features -----------------------------
  {
    for (const f of track.features ?? []) {
      // named-feature sign, like real circuits post at famous corners
      const cv = document.createElement("canvas");
      cv.width = 512;
      cv.height = 128;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#14161c";
      ctx.fillRect(0, 0, 512, 128);
      ctx.fillStyle = FeatureColors[f.kind] ?? "#ffb454";
      ctx.fillRect(0, 0, 18, 128);
      ctx.fillStyle = "#f2f3f5";
      ctx.font = "italic 700 46px Georgia, serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const name = f.name.length > 22 ? f.name.slice(0, 21) + "\u2026" : f.name;
      ctx.fillText(name, 40, 66);
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      const sMid = ((f.sStart + f.sEnd) / 2 + L) % L;
      const i = Math.round(sMid / ds) % n;
      const smp = track.samples[i];
      // outside of the corner if applicable, else right-hand side
      let side = 1;
      if (smp.kappa < -0.001) side = 1;
      else if (smp.kappa > 0.001) side = -1;
      const { nx, ny, off } = offsetOf(track, i, side, 7.5);
      const px = smp.x + nx * off;
      const py = smp.y + ny * off;
      const pz = smp.z - off * Math.sin(smp.bank);
      const post2 = new Mesh(new CylinderGeometry(0.07, 0.09, 2.6, 6), postMat);
      post2.position.set(px, pz + 1.3, -py);
      group.add(post2);
      const sign = new Mesh(new BoxGeometry(3.4, 1.0, 0.08), new MeshStandardMaterial({ map: tex, roughness: 0.7 }));
      sign.position.set(px, pz + 2.9, -py);
      sign.rotation.y = -smp.heading + (side > 0 ? Math.PI : 0);
      sign.castShadow = true;
      group.add(sign);
    }
  }

  // ---------- pit garages behind the pit lane ----------------------------------
  {
    const pit = (track.features ?? []).find((x) => x.kind === "pit-lane");
    if (pit) {
      const doorColors = [0xc83a2a, 0x2a5a9e, 0x3a9a5a, 0xe8a83a, 0x7a4a9e, 0x3aa8b8];
      const nBoxes = 12;
      const s0 = (pit.sStart + 20) % L;
      const span = (pit.sEnd - 20 - (pit.sStart + 20) + L) % L;
      for (let k = 0; k < nBoxes; k++) {
        const sAt = (s0 + (span * k) / nBoxes) % L;
        const i = Math.round(sAt / ds) % n;
        const smp = track.samples[i];
        const nx = -Math.sin(smp.heading);
        const ny = Math.cos(smp.heading);
        // boxes sit to the RIGHT of the pit lane (lane occupies wR+2..wR+9)
        const offBox = -(track.props.widthR[i] + 16);
        const px = smp.x + nx * offBox;
        const py = smp.y + ny * offBox;
        const pz = smp.z - offBox * Math.sin(smp.bank);
        const box = new Mesh(
          new BoxGeometry(9.5, 4.4, 7),
          new MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.85 }),
        );
        box.position.set(px, pz + 2.05, -py);
        box.rotation.y = -smp.heading;
        box.castShadow = true;
        group.add(box);
        // colored roller door on the track-facing wall
        const offDoor = offBox + 3.53;
        const door = new Mesh(
          new PlaneGeometry(6.8, 3.4),
          new MeshStandardMaterial({ color: doorColors[k % doorColors.length], roughness: 0.6, side: DoubleSide }),
        );
        door.position.set(smp.x + nx * offDoor, pz + 1.75, -smp.y - ny * offDoor);
        door.rotation.y = -smp.heading + Math.PI;
        group.add(door);
      }
    }
  }

  // ---------- marshal posts ---------------------------------------------------
  {
    const hutGeo = new BoxGeometry(1.6, 2.2, 1.6);
    const hutMat = new MeshStandardMaterial({ color: 0xe8641c, roughness: 0.8 });
    const roofMat = new MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.8 });
    const stride2 = Math.max(1, Math.round(420 / ds));
    for (let i = Math.round(200 / ds); i < n; i += stride2) {
      const side = (i / stride2) % 2 === 0 ? 1 : -1;
      const { nx, ny, off } = offsetOf(track, i, side, 9);
      const smp = track.samples[i];
      const hut = new Mesh(hutGeo, hutMat);
      hut.position.set(smp.x + nx * off, smp.z + 1.1 - off * Math.sin(smp.bank), -smp.y - ny * off);
      hut.castShadow = true;
      group.add(hut);
      const roof = new Mesh(new BoxGeometry(1.9, 0.18, 1.9), roofMat);
      roof.position.set(hut.position.x, hut.position.y + 1.18, hut.position.z);
      group.add(roof);
    }
  }

  return group;
}
