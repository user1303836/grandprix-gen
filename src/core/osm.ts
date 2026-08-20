/**
 * OpenStreetMap context data via the public Overpass API.
 * Building footprints for a site, converted into the local metric frame.
 * Best-effort: any failure yields an empty result, never blocks the app.
 */

import { geoToLocal, type LocalFrame } from "./geo";

export interface OsmBuilding {
  /** Footprint polygon in local meters [x,y]. */
  footprint: [number, number][];
  /** Estimated height in meters. */
  height: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const MAX_BUILDINGS = 2500;

export async function fetchOsmBuildings(
  frame: LocalFrame,
  radiusMeters: number,
  onStatus?: (msg: string) => void,
): Promise<OsmBuilding[]> {
  const { lat, lon } = frame.origin;
  const query = `[out:json][timeout:25];way["building"](around:${Math.round(radiusMeters)},${lat},${lon});out geom;`;
  for (const base of OVERPASS_URLS) {
    try {
      onStatus?.("fetching OSM buildings…");
      const res = await fetch(base, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(28000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { elements?: OverpassWay[] };
      const out: OsmBuilding[] = [];
      for (const w of json.elements ?? []) {
        if (out.length >= MAX_BUILDINGS) break;
        const g = w.geometry;
        if (!g || g.length < 4) continue;
        const fp: [number, number][] = g.map((p) => {
          const l = geoToLocal(frame, p);
          return [Math.round(l.x * 10) / 10, Math.round(l.y * 10) / 10];
        });
        // closed ring required
        if (fp[0][0] !== fp[fp.length - 1][0] || fp[0][1] !== fp[fp.length - 1][1]) {
          fp.push(fp[0]);
        }
        const tags = w.tags ?? {};
        const levels = Number(tags["building:levels"]);
        const height = Number(tags["height"]);
        const h = Number.isFinite(height) && height > 2 ? height : Number.isFinite(levels) && levels > 0 ? levels * 3 : 7;
        out.push({ footprint: fp, height: Math.min(80, h) });
      }
      onStatus?.(`${out.length} buildings`);
      return out;
    } catch {
      // try next endpoint
    }
  }
  onStatus?.("OSM buildings unavailable");
  return [];
}

// ---------------------------------------------------------------------------
// Building avoidance mask
// ---------------------------------------------------------------------------

export interface BuildingMask {
  data: Uint8Array;
  res: number;
  originX: number;
  originY: number;
  w: number;
  h: number;
}

export function maskHit(m: BuildingMask, x: number, y: number): boolean {
  const ix = Math.floor((x - m.originX) / m.res);
  const iy = Math.floor((y - m.originY) / m.res);
  if (ix < 0 || iy < 0 || ix >= m.w || iy >= m.h) return false;
  return m.data[iy * m.w + ix] !== 0;
}

/** Rasterize footprints (+ buffer) into a grid-resolution mask. */
export function rasterizeBuildingMask(
  buildings: OsmBuilding[],
  gridWidth: number,
  gridHeight: number,
  gridRes: number,
  originX: number,
  originY: number,
  bufferMeters = 28,
): BuildingMask {
  const data = new Uint8Array(gridWidth * gridHeight);
  const bufCells = Math.ceil(bufferMeters / gridRes);
  for (const b of buildings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of b.footprint) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const i0 = Math.max(0, Math.floor((minX - originX) / gridRes) - bufCells);
    const i1 = Math.min(gridWidth - 1, Math.ceil((maxX - originX) / gridRes) + bufCells);
    const j0 = Math.max(0, Math.floor((minY - originY) / gridRes) - bufCells);
    const j1 = Math.min(gridHeight - 1, Math.ceil((maxY - originY) / gridRes) + bufCells);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = originX + i * gridRes;
        const y = originY + j * gridRes;
        if (pointInPolygon(x, y, b.footprint) || nearPolygon(x, y, b.footprint, bufferMeters)) {
          data[j * gridWidth + i] = 1;
        }
      }
    }
  }
  return { data, res: gridRes, originX, originY, w: gridWidth, h: gridHeight };
}

function pointInPolygon(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearPolygon(x: number, y: number, ring: [number, number][], dist: number): boolean {
  const d2 = dist * dist;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((x - ax) * abx + (y - ay) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x - (ax + abx * t);
    const dy = y - (ay + aby * t);
    if (dx * dx + dy * dy < d2) return true;
  }
  return false;
}
