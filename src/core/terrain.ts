/**
 * Terrain: efficient local DEM structure with fast interpolation and
 * derived fields (slope/aspect), plus the Mapterhorn tile provider.
 */

import { Corridor } from "./corridor";
import {
  geoToLocal,
  latToTileY,
  localToGeo,
  lonToTileX,
  terrariumDecode,
  tileResolution,
  tileXToLon,
  tileYToLat,
  type GeoPoint,
  type LocalFrame,
} from "./geo";

/**
 * Local-metric terrain contract shared by real DEM grids and synthetic
 * procedural worlds. Pure meters, no geographic reference required.
 */
export interface TerrainSurface {
  readonly resolution: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly minElevation: number;
  readonly maxElevation: number;
  /** true when tied to WGS84 (real-site DEM); synthetic worlds are false */
  readonly geographic: boolean;
  elevationAt(x: number, y: number): number;
  slopeAt(x: number, y: number): number;
}

export class TerrainGrid implements TerrainSurface {
  readonly geographic = true;
  /** Local frame tying x/y meters to WGS84. */
  readonly frame: LocalFrame;
  /** Meters per cell. */
  readonly resolution: number;
  readonly width: number;
  readonly height: number;
  /** x/y of cell (0,0) corner in local meters. */
  readonly originX: number;
  readonly originY: number;
  readonly elevation: Float32Array;
  readonly minElevation: number;
  readonly maxElevation: number;

  private slopeCache: Float32Array | null = null;

  constructor(
    frame: LocalFrame,
    resolution: number,
    width: number,
    height: number,
    originX: number,
    originY: number,
    elevation: Float32Array,
  ) {
    this.frame = frame;
    this.resolution = resolution;
    this.width = width;
    this.height = height;
    this.originX = originX;
    this.originY = originY;
    this.elevation = elevation;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < elevation.length; i++) {
      const v = elevation[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.minElevation = mn;
    this.maxElevation = mx;
  }

  /** Bilinear elevation at local (x, y). NaN outside the grid. */
  elevationAt(x: number, y: number): number {
    const gx = (x - this.originX) / this.resolution;
    const gy = (y - this.originY) / this.resolution;
    if (gx < -0.001 || gy < -0.001 || gx > this.width - 1 + 0.001 || gy > this.height - 1 + 0.001) {
      return NaN;
    }
    const x0 = Math.max(0, Math.min(this.width - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(this.height - 2, Math.floor(gy)));
    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));
    const i00 = y0 * this.width + x0;
    const i10 = i00 + 1;
    const i01 = i00 + this.width;
    const i11 = i01 + 1;
    const z00 = this.elevation[i00];
    const z10 = this.elevation[i10];
    const z01 = this.elevation[i01];
    const z11 = this.elevation[i11];
    return (
      z00 * (1 - fx) * (1 - fy) + z10 * fx * (1 - fy) + z01 * (1 - fx) * fy + z11 * fx * fy
    );
  }

  private computeSlope(): Float32Array {
    if (this.slopeCache) return this.slopeCache;
    const { width: w, height: h, resolution: res } = this;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xl = Math.max(0, x - 1);
        const xr = Math.min(w - 1, x + 1);
        const yt = Math.max(0, y - 1);
        const yb = Math.min(h - 1, y + 1);
        const dzdx = (this.elevation[y * w + xr] - this.elevation[y * w + xl]) / ((xr - xl) * res);
        const dzdy = (this.elevation[yb * w + x] - this.elevation[yt * w + x]) / ((yb - yt) * res);
        out[y * w + x] = Math.hypot(dzdx, dzdy);
      }
    }
    this.slopeCache = out;
    return out;
  }

  /** Slope magnitude (rise/run) at local (x,y). */
  slopeAt(x: number, y: number): number {
    const slope = this.computeSlope();
    const gx = Math.round((x - this.originX) / this.resolution);
    const gy = Math.round((y - this.originY) / this.resolution);
    if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) return 0;
    return slope[gy * this.width + gx];
  }

  meta() {
    return {
      resolutionMeters: this.resolution,
      width: this.width,
      height: this.height,
      minElevation: this.minElevation,
      maxElevation: this.maxElevation,
    };
  }
}

// ---------------------------------------------------------------------------
// Corridor carving
// ---------------------------------------------------------------------------

export interface TrackProximity {
  /** nearest track sample: horizontal distance + elevation + index (null if far) */
  nearest(x: number, y: number, maxDist?: number): { d: number; z: number; i?: number } | null;
  /** all samples within maxDist (for elevation-aware matching) */
  within(
    x: number,
    y: number,
    maxDist: number,
  ): { d: number; z: number; inner?: number; outer?: number; i?: number }[];
}

/** Spatial-hash proximity index over track samples. */
export function makeTrackProximity(
  trackSamples: { x: number; y: number; z: number; ok?: boolean; inner?: number; outer?: number }[],
): TrackProximity {
  const bucketSize = 128;
  const buckets = new Map<string, number[]>();
  trackSamples.forEach((p, i) => {
    if (p.ok === false) return; // structure-owned samples never carve
    const k = `${Math.floor(p.x / bucketSize)},${Math.floor(p.y / bucketSize)}`;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  });
  const gather = (x: number, y: number, maxDist: number) => {
    const bx = Math.floor(x / bucketSize);
    const by = Math.floor(y / bucketSize);
    const r = Math.ceil(maxDist / bucketSize);
    const out: { d: number; z: number; inner?: number; outer?: number; i?: number }[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (!arr) continue;
        for (const i of arr) {
          const p = trackSamples[i];
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= maxDist) out.push({ d, z: p.z, inner: p.inner, outer: p.outer, i });
        }
      }
    }
    return out;
  };
  return {
    nearest(x, y, maxDist = Infinity) {
      const cands = gather(x, y, Math.min(maxDist, bucketSize * 2.5));
      let best: { d: number; z: number } | null = null;
      for (const c of cands) {
        if (!best || c.d < best.d) best = c;
      }
      if (!best || best.d > maxDist) return null;
      return best;
    },
    within: gather,
  };
}

/**
 * Wrap a terrain sampler so the ground is flattened toward the road
 * elevation near the track corridor (the way driving sims seat the road
 * into the landscape). Elevation-aware: where two track sections approach
 * a point, the one whose elevation is most compatible with the local
 * ground wins, so bridges/cuts don't flatten terrain to the wrong deck.
 *
 * carveMask: 1 = terrain may be pulled toward the road; 0 = a structure
 * (bridge/tunnel) owns the gap and the terrain stays untouched. The carve
 * target sits 0.4 m below the road surface so the ribbon always floats
 * visibly proud of the flattened ground -- never z-fights, never clips.
 */
export function carveSampler(
  grid: TerrainSurface,
  trackSamples: { x: number; y: number; z: number }[],
  carveMask: Uint8Array | null = null,
  innerM = 40,
  outerM = 120,
  /** per-sample inner flat widths (cut spans bench narrowly); null = uniform */
  carveInner: Float32Array | null = null,
): (x: number, y: number) => number {
  const proximity = makeTrackProximity(
    trackSamples.map((p, i) => ({
      x: p.x,
      y: p.y,
      z: p.z - 0.4,
      ok: !carveMask || carveMask[i] === 1,
      inner: carveInner ? carveInner[i] : innerM,
      outer: carveInner ? Math.max(outerM, carveInner[i] + 70) : outerM,
    })),
  );
  return (x: number, y: number) => {
    const gz = grid.elevationAt(x, y);
    if (Number.isNaN(gz)) return gz;
    // elevation-aware pick: of the sections near this point, carve toward
    // the one most compatible with the local ground (a bridge deck 80 m
    // overhead must not flatten the valley floor beneath it)
    const cands = proximity.within(x, y, outerM);
    if (cands.length === 0) return gz;
    let best: { d: number; z: number; inner?: number; outer?: number } | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const score = c.d + 2.5 * Math.abs(c.z - gz);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return gz;
    // extreme deviations are structures, not earthworks: leave the ground
    // alone (the deck floats overhead / the tunnel dives beneath)
    if (Math.abs(best.z - gz) > 45) return gz;
    const inner = best.inner ?? innerM;
    const outer = Math.max(best.outer ?? outerM, inner + 20);
    if (best.d <= inner) return best.z;
    const t = (best.d - inner) / (outer - inner);
    const s = t * t * (3 - 2 * t);
    return best.z * (1 - s) + gz * s;
  };
}

// ---------------------------------------------------------------------------
// Mapterhorn provider (Terrarium-encoded webp tiles, no API key)
// ---------------------------------------------------------------------------

export interface TerrainProvider {
  name: string;
  fetchGrid(frame: LocalFrame, radiusMeters: number, targetResolution: number): Promise<TerrainGrid>;
}

const MAPTERHORN_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

/** Pick the coarsest zoom whose pixel size is still finer than target. */
export function pickZoom(lat: number, targetResolution: number): number {
  for (let z = 8; z <= 15; z++) {
    if (tileResolution(lat, z) <= targetResolution) return z;
  }
  return 15;
}

/**
 * Fetch and decode Mapterhorn DEM tiles covering a square around the site
 * origin. Runs in the browser (Image + canvas decode).
 */
export async function fetchMapterhornGrid(
  frame: LocalFrame,
  radiusMeters: number,
  targetResolution = 30,
  onProgress?: (done: number, total: number) => void,
): Promise<TerrainGrid> {
  const z = pickZoom(frame.origin.lat, targetResolution);
  const center = { x: 0, y: 0 };
  const half = radiusMeters * 1.15; // margin
  const nw = localToGeo(frame, center.x - half, center.y + half);
  const se = localToGeo(frame, center.x + half, center.y - half);

  const tx0 = Math.floor(lonToTileX(nw.lon, z));
  const tx1 = Math.floor(lonToTileX(se.lon, z));
  const ty0 = Math.floor(latToTileY(nw.lat, z));
  const ty1 = Math.floor(latToTileY(se.lat, z));
  const ntx = tx1 - tx0 + 1;
  const nty = ty1 - ty0 + 1;
  if (ntx * nty > 64) {
    throw new Error(`site too large for one grid (${ntx}x${nty} tiles); pick a smaller area`);
  }

  // decode all tiles
  const tileSize = 512;
  const mosaic = new Float32Array(ntx * tileSize * nty * tileSize);
  let done = 0;
  const total = ntx * nty;
  await Promise.all(
    Array.from({ length: nty }, async (_, tyi) => {
      for (let txi = 0; txi < ntx; txi++) {
        const tx = tx0 + txi;
        const ty = ty0 + tyi;
        const url = MAPTERHORN_URL.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty));
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`tile ${res.status}`);
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = tileSize;
          canvas.height = tileSize;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(bmp, 0, 0);
          const data = ctx.getImageData(0, 0, tileSize, tileSize).data;
          for (let py = 0; py < tileSize; py++) {
            const row = (tyi * tileSize + py) * ntx * tileSize;
            for (let px = 0; px < tileSize; px++) {
              const di = (py * tileSize + px) * 4;
              mosaic[row + txi * tileSize + px] = terrariumDecode(
                data[di],
                data[di + 1],
                data[di + 2],
              );
            }
          }
        } catch {
          // leave zeros; elevation 0 is a reasonable ocean fallback
        }
        done++;
        onProgress?.(done, total);
      }
    }),
  );

  // resample the mosaic onto a local metric grid
  const mosaicRes = tileResolution(frame.origin.lat, z, tileSize);
  const mosaicOriginGeo: GeoPoint = {
    lat: tileYToLat(ty0, z),
    lon: tileXToLon(tx0, z),
  };
  const mosaicOriginLocal = geoToLocal(frame, mosaicOriginGeo); // NW corner
  const gridRes = Math.max(5, Math.round(mosaicRes));
  const gw = Math.ceil((half * 2) / gridRes);
  const gh = gw;
  const elevation = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = center.y - half + gy * gridRes;
    // mosaic row: y decreases as row increases (NW origin)
    const my = (mosaicOriginLocal.y - y) / mosaicRes;
    const row0 = Math.max(0, Math.min(nty * tileSize - 2, Math.floor(my)));
    const fy = Math.max(0, Math.min(1, my - row0));
    for (let gx = 0; gx < gw; gx++) {
      const x = center.x - half + gx * gridRes;
      const mx = (x - mosaicOriginLocal.x) / mosaicRes;
      const col0 = Math.max(0, Math.min(ntx * tileSize - 2, Math.floor(mx)));
      const fx = Math.max(0, Math.min(1, mx - col0));
      const i00 = row0 * ntx * tileSize + col0;
      const i10 = i00 + 1;
      const i01 = i00 + ntx * tileSize;
      const i11 = i01 + 1;
      elevation[gy * gw + gx] =
        mosaic[i00] * (1 - fx) * (1 - fy) +
        mosaic[i10] * fx * (1 - fy) +
        mosaic[i01] * (1 - fx) * fy +
        mosaic[i11] * fx * fy;
    }
  }

  return new TerrainGrid(frame, gridRes, gw, gh, center.x - half, center.y - half, elevation);
}

// ---------------------------------------------------------------- corridor carve

const corridorCache = new WeakMap<import("./types").Track, import("./corridor").Corridor>();

/**
 * Corridor-aware carve sampler: the terrain is pulled to the CANONICAL
 * corridor surface (banked road edge, kerb lifts, capped runoff slopes,
 * engineered platform) at the query point's signed lateral offset — not
 * to the centerline z. Structure-owned samples (carveMask 0) never carve.
 * The result seats the ground SEAT_DROP below the engineered surface so no
 * coarse triangle can poke through the asphalt.
 */
export function corridorCarve(
  grid: TerrainSurface,
  track: import("./types").Track,
  outerM = 120,
): (x: number, y: number) => number {
  let corridor = corridorCache.get(track);
  if (!corridor) {
    corridor = new Corridor(track);
    corridorCache.set(track, corridor);
  }
  const ds = track.ds;
  const proximity = makeTrackProximity(
    track.samples.map((p, i) => ({ x: p.x, y: p.y, z: p.z, ok: !track.carveMask || track.carveMask[i] === 1 })),
  );
  // structure-owned sections (bridges/tunnels): terrain must never roof
  // over them — a nearby active-section carve could otherwise climb over
  const structProx = track.carveMask && track.carveMask.some((m) => m === 0)
    ? makeTrackProximity(track.samples.map((p, i) => ({ x: p.x, y: p.y, z: p.z, ok: track.carveMask![i] === 0 })))
    : null;
  const SEAT = 0.22;
  return (x: number, y: number) => {
    const gz = grid.elevationAt(x, y);
    if (Number.isNaN(gz)) return gz;
    const cands = proximity.within(x, y, outerM);
    if (cands.length === 0) return gz;
    // elevation-aware pick (parallel sections: the one whose elevation fits)
    let best: { d: number; i: number } | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      if (c.i === undefined) continue;
      const score = c.d + 2.5 * Math.abs(c.z - gz);
      if (score < bestScore) {
        bestScore = score;
        best = { d: c.d, i: c.i };
      }
    }
    if (!best) return gz;
    const smp = track.samples[best.i];
    if (Math.abs(smp.z - gz) > 45) return gz; // structure overhead/diving: leave ground
    // signed lateral offset from the centerline (plan-left normal)
    const nx = -Math.sin(smp.heading);
    const ny = Math.cos(smp.heading);
    const off = (x - smp.x) * nx + (y - smp.y) * ny;
    const s = best.i * ds;
    const surf = corridor!.surface(s, off);
    const aOff = Math.abs(off);
    const plat = corridor!.platformHalf(best.i);
    const platLimit = off >= 0 ? plat.l : plat.r;
    let target: number;
    if (aOff <= platLimit) {
      // inside the engineered envelope: seat just under the corridor surface
      target = surf.z - SEAT;
    } else {
      // outside: blend from the platform edge to untouched ground
      const edge = corridor!.surface(s, Math.sign(off) * platLimit).z - SEAT;
      const t = Math.min(1, (aOff - platLimit) / Math.max(10, outerM - platLimit));
      const sT = t * t * (3 - 2 * t);
      target = edge * (1 - sT) + gz * sT;
    }
    // never roof over a structure-owned section (bridge deck / tunnel cut)
    if (structProx) {
      const near = structProx.nearest(x, y, 45);
      if (near && near.z < target + 0.5) {
        target = Math.min(target, near.z - 1.5);
      }
    }
    return target;
  };
}
