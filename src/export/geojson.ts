/**
 * GeoJSON export: georeferenced centerline, edges, sectors, S/F, site.
 * Blank-canvas tracks export in a local CRS (still valid GeoJSON geometry,
 * with a foreign member noting the CRS).
 */

import { localToGeo, makeLocalFrame } from "../core/geo";
import type { Track } from "../core/types";

type Position = [number, number] | [number, number, number];

interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

export function trackToGeoJSON(track: Track): string {
  const hasSite = track.site !== null;
  const frame = hasSite ? makeLocalFrame({ lat: track.site!.lat, lon: track.site!.lon }) : null;
  const toPos = (x: number, y: number, z: number): Position => {
    if (frame) {
      const g = localToGeo(frame, x, y);
      return [round(g.lon), round(g.lat), round(z)];
    }
    return [round(x), round(y), round(z)];
  };
  const round = (v: number) => Math.round(v * 1e7) / 1e7;

  const features: Feature[] = [];

  // centerline
  features.push({
    type: "Feature",
    properties: {
      kind: "centerline",
      length_m: track.length,
      seed: track.seed,
      generator: `grandprix-gen v${track.version}`,
    },
    geometry: {
      type: "LineString",
      coordinates: track.samples.map((s) => toPos(s.x, s.y, s.z)),
    },
  });

  // track band polygon
  const left: Position[] = [];
  const right: Position[] = [];
  for (const s of track.samples) {
    const nx = -Math.sin(s.heading);
    const ny = Math.cos(s.heading);
    const hw = s.width / 2;
    left.push(toPos(s.x + nx * hw, s.y + ny * hw, s.z));
    right.push(toPos(s.x - nx * hw, s.y - ny * hw, s.z));
  }
  right.reverse();
  features.push({
    type: "Feature",
    properties: { kind: "track_band" },
    geometry: { type: "Polygon", coordinates: [[...left, ...right, left[0]]] },
  });

  // sectors
  for (const sec of track.sectors) {
    const pts: Position[] = [];
    const n = track.samples.length;
    const i0 = Math.round(sec.sStart / track.ds);
    const i1 = Math.round(sec.sEnd / track.ds);
    for (let k = i0; ; k = (k + 1) % n) {
      const s = track.samples[k];
      pts.push(toPos(s.x, s.y, s.z));
      if (k === i1 || pts.length > n) break;
    }
    features.push({
      type: "Feature",
      properties: { kind: "sector", index: sec.index },
      geometry: { type: "LineString", coordinates: pts },
    });
  }

  // corners
  for (const c of track.corners) {
    const idx = Math.round(c.sApex / track.ds) % track.samples.length;
    const s = track.samples[idx];
    features.push({
      type: "Feature",
      properties: {
        kind: "corner",
        id: c.id,
        direction: c.direction,
        min_radius_m: c.minRadius,
      },
      geometry: { type: "Point", coordinates: toPos(s.x, s.y, s.z) },
    });
  }

  // start/finish
  const sf = track.samples[0];
  features.push({
    type: "Feature",
    properties: { kind: "start_finish" },
    geometry: { type: "Point", coordinates: toPos(sf.x, sf.y, sf.z) },
  });

  // site polygon
  if (track.site?.polygon && frame) {
    features.push({
      type: "Feature",
      properties: { kind: "site_boundary" },
      geometry: {
        type: "Polygon",
        coordinates: [
          track.site.polygon.map(([x, y]) => {
            const g = localToGeo(frame, x, y);
            return [round(g.lon), round(g.lat)] as Position;
          }),
        ],
      },
    });
  }

  const collection: Record<string, unknown> = {
    type: "FeatureCollection",
    features,
  };
  if (!hasSite) {
    collection["foreign_members"] = {
      crs: "local-metric",
      note: "coordinates are local engineering meters (x east, y north, z elevation); no geographic reference",
    };
  } else {
    collection["foreign_members"] = {
      crs: "urn:ogc:def:crs:OGC:1.3:CRS84",
      site: { lat: track.site!.lat, lon: track.site!.lon },
    };
  }
  return JSON.stringify(collection, null, 1);
}
