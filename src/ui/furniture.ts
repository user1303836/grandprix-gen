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
  cv.width = 256;
  cv.height = 128;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#3a3f46";
  ctx.fillRect(0, 0, 256, 128);
  const seatColors = ["#c84a3a", "#e8e4dc", "#3a6ab8", "#e8a83a", "#3aa85a", "#8a8f98"];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 32; col++) {
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
