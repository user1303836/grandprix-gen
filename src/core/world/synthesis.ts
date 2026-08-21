/**
 * Synthetic terrain for procedural worlds.
 *
 * Strategy: a macro field with real structure independent of the track
 * (domain-warped fBm shaped by the landform identity), conditioned by
 * sparse constraints sampled from the relationship spans, blended with an
 * iterative relaxation solver. Constraints near the corridor are protected
 * and win; away from the corridor the macro field rules. Conflicting
 * constraints at different heights (bridge over road) resolve to the
 * LOWEST cluster — the ground belongs to the lower feature and is never
 * pulled upward through a deck.
 */

import { Rng } from "../prng";
import type { TerrainSurface } from "../terrain";
import type { TrackSample } from "../types";
import type { EnvironmentIdentity, EnvironmentParams, RoleSpan } from "./types";
import { roleAt } from "./relationships";

// ---------------------------------------------------------------------------
// deterministic value noise
// ---------------------------------------------------------------------------

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** fBm, output roughly [-1, 1] */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += (valueNoise(x * f, y * f, seed + o * 131) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.52;
    f *= 2.07;
  }
  return v / Math.max(1e-9, norm);
}

/** ridged fBm: sharp crests, [0,1] */
function ridged(x: number, y: number, seed: number, octaves: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, seed + o * 733) * 2 - 1);
    v += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.11;
  }
  return v / Math.max(1e-9, norm);
}

// ---------------------------------------------------------------------------
// corridor constraints
// ---------------------------------------------------------------------------

interface Constraint {
  x: number;
  y: number;
  z: number;
  /** influence radius in meters */
  radius: number;
  /** blend strength 0..1 at center */
  weight: number;
}

/**
 * Sample the relationship spans into scattered elevation constraints.
 * Positions are offset perpendicular to the road so roles shape the
 * cross-section, not just the centerline.
 */
export function constraintsFromSpans(
  samples: TrackSample[],
  spans: RoleSpan[],
  ds: number,
  length: number,
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
): Constraint[] {
  const out: Constraint[] = [];
  const rng = new Rng(params.drama * 1e6 + 917);
  const drama = params.drama;
  const n = samples.length;

  const step = Math.max(6, Math.round(14 / ds)); // ~14 m along the road
  for (let i = 0; i < n; i += step) {
    const p = samples[i];
    const sp = roleAt(spans, p.s, length);
    const nx = -Math.sin(p.heading); // left normal
    const ny = Math.cos(p.heading);
    const inten = sp.intensity;
    const side = sp.side || 1;

    const push = (off: number, dz: number, radius: number, weight: number) => {
      out.push({
        x: p.x + nx * off,
        y: p.y + ny * off,
        z: p.z + dz,
        radius,
        weight,
      });
    };

    switch (sp.kind) {
      case "at-grade":
        push(0, -0.6, 55, 0.85);
        push(45, -1.5 - rng.next() * 2, 70, 0.5);
        push(-45, -1.5 - rng.next() * 2, 70, 0.5);
        break;
      case "developed":
        push(0, -0.5, 90, 0.95);
        push(70, -0.8, 90, 0.85);
        push(-70, -0.8, 90, 0.85);
        break;
      case "valley-floor":
        push(0, -1.2, 110, 0.8);
        push(90, 0.5 + rng.next() * 2, 120, 0.45);
        push(-90, 0.5 + rng.next() * 2, 120, 0.45);
        break;
      case "plateau":
        push(0, -1.0, 130, 0.85);
        push(110, -1.0, 130, 0.7);
        push(-110, -1.0, 130, 0.7);
        break;
      case "hillside-bench": {
        const h = (10 + 22 * drama) * inten;
        push(0, -0.5, 40, 0.8);
        push(side * 55, h, 85, 0.7); // uphill
        push(-side * 55, -h * 0.9, 85, 0.7); // downhill
        break;
      }
      case "cliff-edge": {
        const h = (16 + 30 * drama) * inten;
        push(side * 40, h * 0.8, 70, 0.75); // supported side rises
        push(-side * 34, -h, 60, 0.8); // exposure side drops
        break;
      }
      case "ridge":
        push(0, -2.2, 60, 0.8);
        push(70, -(10 + 20 * drama) * inten, 110, 0.65);
        push(-70, -(10 + 20 * drama) * inten, 110, 0.65);
        break;
      case "embankment":
        push(0, -(2.5 + 4 * drama) * inten, 55, 0.8);
        push(50, -(4 + 8 * drama) * inten, 75, 0.6);
        push(-50, -(4 + 8 * drama) * inten, 75, 0.6);
        break;
      case "open-cut":
        push(0, 4.5 + 5 * drama, 60, 0.85); // ground ABOVE road: civil cuts it
        push(45, 6 + 8 * drama, 75, 0.7);
        push(-45, 6 + 8 * drama, 75, 0.7);
        break;
      case "tunnel-ridge":
        push(0, 16 + 20 * drama * inten, 120, 0.8); // ridge over the road
        break;
      case "ravine-crossing": {
        const depth = (12 + 26 * drama) * inten;
        push(0, -depth, 42, 0.9); // deep V under the road
        push(40, -depth * 0.35, 70, 0.6);
        push(-40, -depth * 0.35, 70, 0.6);
        break;
      }
      case "river-crossing": {
        const depth = (14 + 22 * drama) * inten;
        push(0, -depth, 55, 0.95); // wide gorge under the road
        push(60, -depth * 0.4, 90, 0.6);
        push(-60, -depth * 0.4, 90, 0.6);
        break;
      }
      case "forest-corridor":
        push(0, -0.8, 60, 0.85);
        push(50, -1 + rng.spread(2), 80, 0.5);
        push(-50, -1 + rng.spread(2), 80, 0.5);
        break;
    }
  }

  // developed anchor around start/finish regardless of role
  const p0 = samples[0];
  out.push({ x: p0.x, y: p0.y, z: p0.z - 0.5, radius: 150, weight: 0.9 });

  return out;
}

// ---------------------------------------------------------------------------
// macro field
// ---------------------------------------------------------------------------

export interface MacroField {
  (x: number, y: number): number;
}

/** Landform-shaped macro terrain, centered on the track's elevation range. */
export function makeMacroField(
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
  envSeed: number,
  cx: number,
  cy: number,
  span: number,
  baseZ: number,
): MacroField {
  const seed = envSeed | 0;
  const drama = params.drama;
  const amp = 20 + 90 * drama;
  const wfreq = 1.6 / Math.max(400, span);

  const warp = (x: number, y: number, mag: number): [number, number] => {
    const wx = fbm(x * wfreq * 2.1 + 31.7, y * wfreq * 2.1 - 17.3, seed ^ 0x51ab, 3);
    const wy = fbm(x * wfreq * 2.1 - 8.9, y * wfreq * 2.1 + 44.1, seed ^ 0x72cd, 3);
    return [x + wx * mag, y + wy * mag];
  };

  // ridge/valley axes for directional landforms
  const axisAngle = hash2(3, 7, seed) * Math.PI;
  const ax = Math.cos(axisAngle);
  const ay = Math.sin(axisAngle);

  return (x: number, y: number): number => {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.hypot(dx, dy) / Math.max(1, span);
    const [wx, wy] = warp(x, y, span * 0.14);

    switch (identity.landform) {
      case "rolling-hills":
        return baseZ + fbm(wx * wfreq, wy * wfreq, seed, 5) * amp;
      case "plateau": {
        const h = fbm(wx * wfreq, wy * wfreq, seed, 4) * amp * 0.5;
        // quantize into terraces: flat shelves, steep risers
        const t = 8 + 10 * drama;
        const band = ((h % t) + t) % t;
        const riser = smooth(Math.min(1, band / (t * 0.22))); // steep riser over 22% of the band
        const q = Math.floor(h / t) * t + riser * t * 0.9 + band * 0.1;
        return baseZ + q + fbm(x * wfreq * 6, y * wfreq * 6, seed ^ 99, 2) * 2.2;
      }
      case "ridges": {
        const along = (wx * ax + wy * ay) * wfreq;
        const across = (-wx * ay + wy * ax) * wfreq * 2.4;
        return baseZ + (ridged(across, along, seed, 4) - 0.42) * amp * 1.5 + fbm(wx * wfreq * 3, wy * wfreq * 3, seed ^ 7, 3) * amp * 0.25;
      }
      case "valley": {
        // broad U across the axis + longitudinal tilt + noise
        const across = -dx * ay + dy * ax;
        const along = dx * ax + dy * ay;
        const u = Math.pow(Math.abs(across) / (span * 0.75), 1.8) * amp * 1.1;
        return baseZ + u + along * 0.004 * amp * 0.2 + fbm(wx * wfreq * 2.2, wy * wfreq * 2.2, seed, 4) * amp * 0.35;
      }
      case "canyon": {
        const across = -wx * ay + wy * ax;
        const rim = baseZ + fbm(wx * wfreq, wy * wfreq, seed, 4) * amp * 0.5;
        const chan = Math.exp(-Math.pow(across / (span * 0.16), 2)) * amp * 1.3;
        return rim - chan + ridged(wx * wfreq * 3, wy * wfreq * 3, seed ^ 55, 3) * amp * 0.3;
      }
      case "basin": {
        const bowl = -Math.max(0, 1 - r * r) * amp * 0.8;
        return baseZ + bowl + fbm(wx * wfreq, wy * wfreq, seed, 5) * amp * 0.5;
      }
      case "island": {
        const dome = Math.max(0, 1 - r * r * 1.15);
        const coastDrop = Math.max(0, r - 0.72) * amp * 3.2;
        return baseZ + dome * amp * 0.9 - coastDrop + fbm(wx * wfreq * 2, wy * wfreq * 2, seed, 4) * amp * 0.4;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// relaxation solver
// ---------------------------------------------------------------------------

export interface SynthesisResult {
  surface: TerrainSurface;
  moisture: Float32Array;
}

class SyntheticGrid implements TerrainSurface {
  readonly geographic = false;
  readonly minElevation: number;
  readonly maxElevation: number;
  private slopeCache: Float32Array | null = null;
  constructor(
    readonly resolution: number,
    readonly width: number,
    readonly height: number,
    readonly originX: number,
    readonly originY: number,
    readonly elevation: Float32Array,
  ) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of elevation) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.minElevation = mn;
    this.maxElevation = mx;
  }
  elevationAt(x: number, y: number): number {
    const gx = (x - this.originX) / this.resolution;
    const gy = (y - this.originY) / this.resolution;
    if (gx < 0 || gy < 0 || gx > this.width - 1 || gy > this.height - 1) return NaN;
    const x0 = Math.min(this.width - 2, Math.floor(gx));
    const y0 = Math.min(this.height - 2, Math.floor(gy));
    const fx = gx - x0;
    const fy = gy - y0;
    const i = y0 * this.width + x0;
    const e = this.elevation;
    return (
      e[i] * (1 - fx) * (1 - fy) + e[i + 1] * fx * (1 - fy) + e[i + this.width] * (1 - fx) * fy + e[i + this.width + 1] * fx * fy
    );
  }
  slopeAt(x: number, y: number): number {
    if (!this.slopeCache) {
      const { width: w, height: h, resolution: res, elevation: e } = this;
      const out = new Float32Array(w * h);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const xl = Math.max(0, xx - 1);
          const xr = Math.min(w - 1, xx + 1);
          const yt = Math.max(0, yy - 1);
          const yb = Math.min(h - 1, yy + 1);
          const dzdx = (e[yy * w + xr] - e[yy * w + xl]) / ((xr - xl) * res);
          const dzdy = (e[yb * w + xx] - e[yt * w + xx]) / ((yb - yt) * res);
          out[yy * w + xx] = Math.hypot(dzdx, dzdy);
        }
      }
      this.slopeCache = out;
    }
    const gx = Math.round((x - this.originX) / this.resolution);
    const gy = Math.round((y - this.originY) / this.resolution);
    if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) return 0;
    return this.slopeCache[gy * this.width + gx];
  }
}

/**
 * Synthesize the world terrain. `samples/spans` place constraints; the
 * macro field fills everything else. Coupling (0..1) scales constraint
 * weight; drama scales macro amplitude (already in the field).
 */
export function synthesizeTerrain(
  samples: TrackSample[],
  spans: RoleSpan[],
  ds: number,
  trackLength: number,
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
  envSeed: number,
): SynthesisResult {
  // bounds: track bbox + margin
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of samples) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < zMin) zMin = p.z;
    if (p.z > zMax) zMax = p.z;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const span = Math.max(spanX, spanY);
  const margin = Math.max(140, span * 0.16);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const baseZ = (zMin + zMax) / 2 - 6;

  const resolution = Math.max(6, Math.min(10, span / 240));
  const width = Math.min(560, Math.ceil((spanX + margin * 2) / resolution) + 1);
  const height = Math.min(560, Math.ceil((spanY + margin * 2) / resolution) + 1);
  const originX = cx - ((width - 1) * resolution) / 2;
  const originY = cy - ((height - 1) * resolution) / 2;

  const macro = makeMacroField(identity, params, envSeed, cx, cy, span, baseZ);
  const constraints = constraintsFromSpans(samples, spans, ds, trackLength, identity, params);

  // rasterize constraints into a coarse constraint grid (per cell: lowest-z
  // cluster wins when conflicting heights overlap)
  const cw = Math.ceil((width * resolution) / 24) + 2;
  const ch = Math.ceil((height * resolution) / 24) + 2;
  const cz = new Float32Array(cw * ch).fill(NaN);
  const cwt = new Float32Array(cw * ch);
  const crad = new Float32Array(cw * ch);
  const cellOf = (x: number, y: number): number => {
    const gx = Math.round((x - originX) / 24);
    const gy = Math.round((y - originY) / 24);
    return gy * cw + gx;
  };
  for (const c of constraints) {
    const ci = cellOf(c.x, c.y);
    if (Number.isNaN(cz[ci])) {
      cz[ci] = c.z;
      cwt[ci] = c.weight;
      crad[ci] = c.radius;
    } else if (Math.abs(c.z - cz[ci]) < 8) {
      // compatible: weight toward the stronger constraint
      const wSum = cwt[ci] + c.weight;
      cz[ci] = (cz[ci] * cwt[ci] + c.z * c.weight) / wSum;
      cwt[ci] = Math.min(1, wSum);
      crad[ci] = Math.max(crad[ci], c.radius);
    } else {
      // conflict across levels: the LOWER ground wins (never lift terrain
      // up through a lower road); keep radius of the winner
      if (c.z < cz[ci]) {
        cz[ci] = c.z;
        crad[ci] = c.radius;
      }
      cwt[ci] = Math.max(cwt[ci], c.weight);
    }
  }

  // field init from macro
  const z = new Float32Array(width * height);
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      z[iy * width + ix] = macro(originX + ix * resolution, originY + iy * resolution);
    }
  }

  // relaxation: N passes; each pass pulls cells toward nearby constraints
  // with smooth falloff, then smooths the field slightly
  const coupling = Math.min(1, Math.max(0, params.coupling));
  const tmp = new Float32Array(z.length);
  const PASSES = 4;
  for (let pass = 0; pass < PASSES; pass++) {
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const wx = originX + ix * resolution;
        const wy = originY + iy * resolution;
        let zi = z[iy * width + ix];
        // constraints: check the coarse cell neighborhood
        const cgx = Math.round((wx - originX) / 24);
        const cgy = Math.round((wy - originY) / 24);
        let acc = 0;
        let wsum = 0;
        const reach = 4; // 4*24 = 96 m influence check
        for (let gy = Math.max(0, cgy - reach); gy <= Math.min(ch - 1, cgy + reach); gy++) {
          for (let gx = Math.max(0, cgx - reach); gx <= Math.min(cw - 1, cgx + reach); gx++) {
            const ci = gy * cw + gx;
            if (Number.isNaN(cz[ci])) continue;
            const d = Math.hypot(wx - (originX + gx * 24), wy - (originY + gy * 24));
            const rad = crad[ci];
            if (d > rad) continue;
            const t = 1 - d / rad;
            const w = t * t * (3 - 2 * t) * cwt[ci];
            acc += cz[ci] * w;
            wsum += w;
          }
        }
        if (wsum > 0) {
          const target = acc / wsum;
          const k = Math.min(0.9, wsum * coupling * (0.5 + pass * 0.16));
          zi = zi * (1 - k) + target * k;
        }
        tmp[iy * width + ix] = zi;
      }
    }
    // light smoothing (3x3), weaker near strong constraints to keep benches crisp
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const i = iy * width + ix;
        if (iy === 0 || ix === 0 || iy === height - 1 || ix === width - 1) {
          z[i] = tmp[i];
          continue;
        }
        const avg = (tmp[i - 1] + tmp[i + 1] + tmp[i - width] + tmp[i + width]) * 0.25;
        z[i] = tmp[i] * 0.72 + avg * 0.28;
      }
    }
  }

  // geological detail away from the corridor: extra fBm ridges/terraces,
  // faded out near constraint cores so the corridor intent stays readable
  const detailSeed = envSeed ^ 0xd37;
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const wx = originX + ix * resolution;
      const wy = originY + iy * resolution;
      const cgx = Math.round((wx - originX) / 24);
      const cgy = Math.round((wy - originY) / 24);
      const ci = cgy * cw + cgx;
      const nearCore = !Number.isNaN(cz[ci]) && cwt[ci] > 0.55;
      const i = iy * width + ix;
      const det = fbm(wx * 0.02, wy * 0.02, detailSeed, 3) * (2.2 + params.drama * 4);
      z[i] += nearCore ? det * 0.25 : det;
    }
  }

  // corridor protection: ground must stay below the road within the bench
  // (except on roles that deliberately cover the road: open-cut / tunnel-ridge)
  const stepI = Math.max(1, Math.round(3 / ds));
  for (let i = 0; i < samples.length; i += stepI) {
    const p = samples[i];
    const sp = roleAt(spans, p.s, trackLength);
    const above = sp.kind === "open-cut" || sp.kind === "tunnel-ridge";
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    for (let off = -16; off <= 16; off += 4) {
      const wx = p.x + nx * off;
      const wy = p.y + ny * off;
      const gx = (wx - originX) / resolution;
      const gy = (wy - originY) / resolution;
      if (gx < 0 || gy < 0 || gx >= width - 1 || gy >= height - 1) continue;
      const gi = Math.round(gy) * width + Math.round(gx);
      if (!above && z[gi] > p.z - 0.45) z[gi] = p.z - 0.45 - (Math.abs(off) / 16) * 0.5;
      if (above && z[gi] < p.z + 1.2) z[gi] = p.z + 1.2; // keep the cover real
    }
  }

  // moisture: base by hydrology + noise; hydrology module adds water detail
  const moisture = new Float32Array(width * height);
  const mBase =
    identity.hydrology === "river" || identity.hydrology === "lake" || identity.hydrology === "coast"
      ? 0.55
      : identity.hydrology === "seasonal-stream"
        ? 0.4
        : 0.22;
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const wx = originX + ix * resolution;
      const wy = originY + iy * resolution;
      moisture[iy * width + ix] = Math.min(
        1,
        Math.max(0, mBase + fbm(wx * 0.004, wy * 0.004, envSeed ^ 0x712, 3) * 0.45),
      );
    }
  }

  const surface = new SyntheticGrid(resolution, width, height, originX, originY, z);
  return { surface, moisture };
}
