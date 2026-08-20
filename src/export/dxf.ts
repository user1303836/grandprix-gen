/**
 * DXF export (AC1015 ASCII) with sensible CAD layers.
 * 3D polylines carry real elevation; metric units declared.
 */

import type { Track } from "../core/types";

function dxfPair(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function polyline3d(layer: string, pts: [number, number, number][], closed: boolean): string {
  const out: string[] = [];
  out.push(dxfPair(0, "POLYLINE"));
  out.push(dxfPair(8, layer));
  out.push(dxfPair(66, 1)); // vertices follow
  out.push(dxfPair(70, closed ? 9 : 8)); // bit 1 closed + bit 8 = 3D
  out.push(dxfPair(10, 0));
  out.push(dxfPair(20, 0));
  out.push(dxfPair(30, 0));
  for (const [x, y, z] of pts) {
    out.push(dxfPair(0, "VERTEX"));
    out.push(dxfPair(8, layer));
    out.push(dxfPair(10, x.toFixed(4)));
    out.push(dxfPair(20, y.toFixed(4)));
    out.push(dxfPair(30, z.toFixed(4)));
  }
  out.push(dxfPair(0, "SEQEND"));
  return out.join("\n");
}

export function trackToDxf(track: Track): string {
  const layers: [string, number][] = [
    ["TRACK_CENTERLINE", 7],
    ["TRACK_LEFT_EDGE", 8],
    ["TRACK_RIGHT_EDGE", 8],
    ["CURB_LEFT", 1],
    ["CURB_RIGHT", 1],
    ["START_FINISH", 5],
    ["SECTOR_LINES", 4],
    ["CORNERS", 3],
    ["SITE_BOUNDARY", 2],
  ];

  const out: string[] = [];
  // HEADER
  out.push(dxfPair(0, "SECTION"));
  out.push(dxfPair(2, "HEADER"));
  out.push(dxfPair(9, "$ACADVER"));
  out.push(dxfPair(1, "AC1015"));
  out.push(dxfPair(9, "$INSUNITS"));
  out.push(dxfPair(70, 6)); // meters
  out.push(dxfPair(9, "$MEASUREMENT"));
  out.push(dxfPair(70, 1));
  out.push(dxfPair(0, "ENDSEC"));
  // TABLES (layers)
  out.push(dxfPair(0, "SECTION"));
  out.push(dxfPair(2, "TABLES"));
  out.push(dxfPair(0, "TABLE"));
  out.push(dxfPair(2, "LAYER"));
  out.push(dxfPair(70, layers.length));
  for (const [name, color] of layers) {
    out.push(dxfPair(0, "LAYER"));
    out.push(dxfPair(2, name));
    out.push(dxfPair(70, 0));
    out.push(dxfPair(62, color));
    out.push(dxfPair(6, "CONTINUOUS"));
  }
  out.push(dxfPair(0, "ENDTAB"));
  out.push(dxfPair(0, "ENDSEC"));
  // ENTITIES
  out.push(dxfPair(0, "SECTION"));
  out.push(dxfPair(2, "ENTITIES"));

  const s = track.samples;
  const n = s.length;
  const center: [number, number, number][] = s.map((p) => [p.x, p.y, p.z]);
  const left: [number, number, number][] = [];
  const right: [number, number, number][] = [];
  const curbL: [number, number, number][] = [];
  const curbR: [number, number, number][] = [];
  for (const p of s) {
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    const cosB = Math.cos(p.bank);
    const sinB = Math.sin(p.bank);
    const hw = p.width / 2;
    left.push([p.x + nx * hw * cosB, p.y + ny * hw * cosB, p.z - hw * sinB]);
    right.push([p.x - nx * hw * cosB, p.y - ny * hw * cosB, p.z + hw * sinB]);
    const cw = hw + 1.2;
    curbL.push([p.x + nx * cw * cosB, p.y + ny * cw * cosB, p.z - cw * sinB + 0.04]);
    curbR.push([p.x - nx * cw * cosB, p.y - ny * cw * cosB, p.z + cw * sinB + 0.04]);
  }
  out.push(polyline3d("TRACK_CENTERLINE", center, true));
  out.push(polyline3d("TRACK_LEFT_EDGE", left, true));
  out.push(polyline3d("TRACK_RIGHT_EDGE", right, true));
  out.push(polyline3d("CURB_LEFT", curbL, true));
  out.push(polyline3d("CURB_RIGHT", curbR, true));

  // start/finish line across the track
  const sf = s[0];
  const sfN = { x: -Math.sin(sf.heading), y: Math.cos(sf.heading) };
  out.push(
    polyline3d(
      "START_FINISH",
      [
        [sf.x + sfN.x * (sf.width / 2), sf.y + sfN.y * (sf.width / 2), sf.z],
        [sf.x - sfN.x * (sf.width / 2), sf.y - sfN.y * (sf.width / 2), sf.z],
      ],
      false,
    ),
  );

  // sector boundary lines
  for (const sec of track.sectors.slice(1)) {
    const idx = Math.round(sec.sStart / track.ds) % n;
    const p = s[idx];
    const pnx = -Math.sin(p.heading);
    const pny = Math.cos(p.heading);
    out.push(
      polyline3d(
        "SECTOR_LINES",
        [
          [p.x + pnx * p.width, p.y + pny * p.width, p.z],
          [p.x - pnx * p.width, p.y - pny * p.width, p.z],
        ],
        false,
      ),
    );
  }

  // corner apex markers (small crosses)
  for (const c of track.corners) {
    const idx = Math.round(c.sApex / track.ds) % n;
    const p = s[idx];
    const r = 6;
    out.push(
      polyline3d(
        "CORNERS",
        [
          [p.x - r, p.y, p.z],
          [p.x + r, p.y, p.z],
        ],
        false,
      ),
    );
    out.push(
      polyline3d(
        "CORNERS",
        [
          [p.x, p.y - r, p.z],
          [p.x, p.y + r, p.z],
        ],
        false,
      ),
    );
  }

  // site boundary
  if (track.site?.polygon && track.site.polygon.length >= 3) {
    out.push(
      polyline3d(
        "SITE_BOUNDARY",
        track.site.polygon.map(([x, y]) => [x, y, 0] as [number, number, number]),
        true,
      ),
    );
  }

  out.push(dxfPair(0, "ENDSEC"));
  out.push(dxfPair(0, "EOF"));
  return out.join("\n");
}
