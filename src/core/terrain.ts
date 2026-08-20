/**
 * Terrain: efficient local DEM structure with fast interpolation and
 * derived fields (slope/aspect), plus the Mapterhorn tile provider.
 */

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

export class TerrainGrid {
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
// Mapterhorn provider (Terrarium-encoded webp tiles, no API key)
// ---------------------------------------------------------------------------

export interface TerrainProvider {
  name: string;
  fetchGrid(frame: LocalFrame, radiusMeters: number, targetResolution: number): Promise<TerrainGrid>;
}

const MAPTERHORN_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

/** Pick a zoom level whose pixel size is near the target resolution. */
export function pickZoom(lat: number, targetResolution: number): number {
  for (let z = 15; z >= 8; z--) {
    if (tileResolution(lat, z) <= targetResolution) return z;
  }
  return 8;
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
