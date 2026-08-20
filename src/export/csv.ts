/**
 * CSV export of sampled engineering data.
 */

import { gradeAt } from "../core/types";
import { localToGeo, makeLocalFrame } from "../core/geo";
import type { Track } from "../core/types";

export function trackToCsv(track: Track): string {
  const hasSite = track.site !== null;
  const frame = hasSite ? makeLocalFrame({ lat: track.site!.lat, lon: track.site!.lon }) : null;
  const header = [
    "s",
    "x",
    "y",
    "z",
    ...(frame ? ["latitude", "longitude"] : []),
    "ground_z",
    "heading_deg",
    "curvature",
    "radius_m",
    "grade",
    "banking_deg",
    "width_m",
    "estimated_speed_kmh",
  ];
  const rows: string[] = [header.join(",")];
  const deg = 180 / Math.PI;
  for (const s of track.samples) {
    const grade = gradeAt(track, s.s);
    const radius = Math.abs(s.kappa) > 1e-9 ? 1 / Math.abs(s.kappa) : 0;
    const cols = [
      s.s.toFixed(2),
      s.x.toFixed(3),
      s.y.toFixed(3),
      s.z.toFixed(3),
    ];
    if (frame) {
      const g = localToGeo(frame, s.x, s.y);
      cols.push(g.lat.toFixed(8), g.lon.toFixed(8));
    }
    cols.push(
      Number.isFinite(s.groundZ) ? s.groundZ.toFixed(3) : "",
      (s.heading * deg).toFixed(3),
      s.kappa.toFixed(6),
      radius > 0 ? radius.toFixed(1) : "",
      grade.toFixed(5),
      (s.bank * deg).toFixed(3),
      s.width.toFixed(2),
      Number.isFinite(s.speed) ? (s.speed * 3.6).toFixed(1) : "",
    );
    rows.push(cols.join(","));
  }
  return rows.join("\n");
}
