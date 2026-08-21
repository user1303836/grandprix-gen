/**
 * Procedural canvas textures: asphalt aggregate speckle, grass blades,
 * gravel, concrete joints. Deterministic (seeded) and tileable.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fine asphalt speckle (aggregate + binder), tileable luminance map. */
export function makeAsphaltTexture(seed = 1337): CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const rnd = seededRandom(seed);
  ctx.fillStyle = "#ededed";
  ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 237 + (rnd() - 0.5) * 36;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // aggregate flecks (mostly darker than the bright base)
  for (let k = 0; k < 900; k++) {
    const g = 170 + rnd() * 85;
    ctx.fillStyle = `rgba(${g},${g},${g},${0.2 + rnd() * 0.3})`;
    const r = rnd() < 0.9 ? 1 : 2;
    ctx.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), r, r);
  }
  // faint tar streaks
  ctx.strokeStyle = "rgba(120,120,120,0.18)";
  for (let k = 0; k < 26; k++) {
    ctx.beginPath();
    const y = rnd() * S;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(S * 0.3, y + (rnd() - 0.5) * 14, S * 0.7, y + (rnd() - 0.5) * 14, S, y);
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

/** Grass: blade flecks over a mid green; used as a detail multiplier. */
export function makeGrassTexture(seed = 4242): CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const rnd = seededRandom(seed);
  ctx.fillStyle = "#e4e9d8";
  ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 3400; k++) {
    const g = 175 + rnd() * 65;
    const r2 = 135 + rnd() * 55;
    ctx.strokeStyle = `rgba(${r2 * 0.8},${g},${r2 * 0.55},${0.18 + rnd() * 0.3})`;
    const x = rnd() * S;
    const y = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 2.5, y - 1 - rnd() * 2.5);
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  // patchy dry spots
  for (let k = 0; k < 14; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 12 + rnd() * 30;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(190,180,130,0.22)");
    grad.addColorStop(1, "rgba(190,180,130,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Concrete: pale gray with formwork panel lines + weathering streaks. */
export function makeConcreteTexture(seed = 919): CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const rnd = seededRandom(seed);
  ctx.fillStyle = "#e8e6e0";
  ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 226 + (rnd() - 0.5) * 16;
    d[i] = v;
    d[i + 1] = v - 1;
    d[i + 2] = v - 4;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // formwork panel seams
  ctx.strokeStyle = "rgba(120,118,112,0.5)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= S; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
  }
  for (let y = 0; y <= S; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
  // weathering streaks
  for (let k = 0; k < 30; k++) {
    const x = rnd() * S;
    ctx.fillStyle = `rgba(110,108,100,${0.05 + rnd() * 0.09})`;
    ctx.fillRect(x, rnd() * S * 0.5, 1 + rnd() * 2, 30 + rnd() * 60);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

/** Gravel: coarse pebble speckle. */
export function makeGravelTexture(seed = 777): CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const rnd = seededRandom(seed);
  ctx.fillStyle = "#e8ddc8";
  ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 1400; k++) {
    const v = 150 + rnd() * 100;
    ctx.fillStyle = `rgba(${v},${v * 0.92},${v * 0.72},${0.35 + rnd() * 0.45})`;
    const r = 1 + rnd() * 1.6;
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
