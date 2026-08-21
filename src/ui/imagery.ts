/**
 * Satellite imagery drape: fetch Esri World Imagery tiles covering the
 * site DEM grid and produce a single texture with a geo-accurate UV
 * transform. Best-effort: any tile failure just leaves hypsometry.
 */

import {
  geoToLocal,
  latToTileY,
  localToGeo,
  lonToTileX,
  tileXToLon,
  tileYToLat,
} from "../core/geo";
import type { TerrainGrid } from "../core/terrain";

const ESRI_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export interface ImageryDrape {
  canvas: HTMLCanvasElement;
  /** local-meters bounds covered by the canvas */
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
}

/**
 * Fetch imagery for the grid's local-meters extent. Zoom is chosen so the
 * mosaic stays under ~24 Mpx. Returns null on any failure (hypsometry
 * fallback stays).
 */
export async function fetchImageryDrape(
  grid: TerrainGrid,
  maxZoom = 16,
  onProgress?: (done: number, total: number) => void,
): Promise<ImageryDrape | null> {
  const frame = grid.frame;
  const minX = grid.originX;
  const minY = grid.originY;
  const maxX = grid.originX + (grid.width - 1) * grid.resolution;
  const maxY = grid.originY + (grid.height - 1) * grid.resolution;
  const nw = localToGeo(frame, minX, maxY);
  const se = localToGeo(frame, maxX, minY);

  // pick zoom: mosaic pixels ~= span / (res/3)
  let z = maxZoom;
  while (z > 12) {
    const tx0 = Math.floor(lonToTileX(nw.lon, z));
    const tx1 = Math.floor(lonToTileX(se.lon, z));
    const ty0 = Math.floor(latToTileY(nw.lat, z));
    const ty1 = Math.floor(latToTileY(se.lat, z));
    const ntx = tx1 - tx0 + 1;
    const nty = ty1 - ty0 + 1;
    if (ntx * 256 * nty * 256 < 24_000_000 && ntx * nty <= 49) break;
    z--;
  }
  const tx0 = Math.floor(lonToTileX(nw.lon, z));
  const tx1 = Math.floor(lonToTileX(se.lon, z));
  const ty0 = Math.floor(latToTileY(nw.lat, z));
  const ty1 = Math.floor(latToTileY(se.lat, z));
  const ntx = tx1 - tx0 + 1;
  const nty = ty1 - ty0 + 1;
  if (ntx * nty > 64) return null;

  const cv = document.createElement("canvas");
  cv.width = ntx * 256;
  cv.height = nty * 256;
  const ctx = cv.getContext("2d")!;
  let done = 0;
  const total = ntx * nty;
  await Promise.all(
    Array.from({ length: nty }, async (_, tyi) => {
      for (let txi = 0; txi < ntx; txi++) {
        const tx = tx0 + txi;
        const ty = ty0 + tyi;
        const url = ESRI_URL.replace("{z}", String(z)).replace("{y}", String(ty)).replace("{x}", String(tx));
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, txi * 256, tyi * 256, 256, 256);
        } catch {
          // leave blank (hypsometry shows through if used as fallback-less)
        } finally {
          done++;
          onProgress?.(done, total);
        }
      }
    }),
  );

  // local-meters bounds of the mosaic
  const lon0 = tileXToLon(tx0, z);
  const lat0 = tileYToLat(ty0, z); // north edge of top-left tile
  const lon1 = tileXToLon(tx1 + 1, z);
  const lat1 = tileYToLat(ty1 + 1, z); // south edge of bottom-right tile
  const p0 = geoToLocal(frame, { lon: lon0, lat: lat0 });
  const p1 = geoToLocal(frame, { lon: lon1, lat: lat1 });
  return {
    canvas: cv,
    minX: p0.x,
    minY: p1.y, // local y increases northward; lat1 is south -> smaller y
    spanX: p1.x - p0.x,
    spanY: p0.y - p1.y,
  };
}
