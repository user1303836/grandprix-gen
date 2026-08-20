/**
 * Geographic <-> local engineering coordinate conversion.
 *
 * Geometry/optimization never happens in lat/lon. A site establishes a
 * local ENU (east-north-up) metric frame; conversion happens only at the
 * system boundaries (map display, georeferenced export).
 */

const EARTH_R = 6378137; // WGS84 semi-major axis

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LocalFrame {
  origin: GeoPoint;
  /** meters per degree latitude at origin */
  mPerDegLat: number;
  /** meters per degree longitude at origin */
  mPerDegLon: number;
}

export function makeLocalFrame(origin: GeoPoint): LocalFrame {
  const latRad = (origin.lat * Math.PI) / 180;
  // WGS84 radii of curvature
  const sinLat = Math.sin(latRad);
  const w = Math.sqrt(1 - 0.00669437999014 * sinLat * sinLat);
  const m = EARTH_R * (1 - 0.00669437999014) / (w * w * w); // meridional
  const nrm = EARTH_R / w; // prime vertical
  return {
    origin,
    mPerDegLat: (m * Math.PI) / 180,
    mPerDegLon: (nrm * Math.cos(latRad) * Math.PI) / 180,
  };
}

export function geoToLocal(frame: LocalFrame, p: GeoPoint): { x: number; y: number } {
  return {
    x: (p.lon - frame.origin.lon) * frame.mPerDegLon,
    y: (p.lat - frame.origin.lat) * frame.mPerDegLat,
  };
}

export function localToGeo(frame: LocalFrame, x: number, y: number): GeoPoint {
  return {
    lat: frame.origin.lat + y / frame.mPerDegLat,
    lon: frame.origin.lon + x / frame.mPerDegLon,
  };
}

/** Great-circle distance in meters (haversine). */
export function geoDistance(a: GeoPoint, b: GeoPoint): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Web Mercator tile math (for Mapterhorn DEM tiles)
// ---------------------------------------------------------------------------

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution (m/px) of a web-mercator tile at zoom/latitude. */
export function tileResolution(lat: number, z: number, tileSize = 512): number {
  return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_R) / (tileSize * 2 ** z);
}

/** Terrarium decoding: elevation = r*256 + g + b/256 - 32768. */
export function terrariumDecode(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}
