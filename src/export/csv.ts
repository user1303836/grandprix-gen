/**
 * CSV export of sampled engineering data.
 */

import { gradeAt } from "../core/types";
import { localToGeo, makeLocalFrame } from "../core/geo";
import { FeatureLabels, KerbNames, RunoffNames, SurfaceNames } from "../core/character";
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
    "width_l_m",
    "width_r_m",
    "surface",
    "roughness",
    "grip",
    "crossfall_deg",
    "kerb_l",
    "kerb_r",
    "runoff_l",
    "runoff_r",
    "barrier_l_m",
    "barrier_r_m",
    "feature",
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
    // heterogeneous property columns
    const i = Math.round(s.s / track.ds) % track.samples.length;
    const pr = track.props;
    if (pr) {
      const fi = pr.featureIdx[i];
      cols.push(
        pr.widthL[i].toFixed(2),
        pr.widthR[i].toFixed(2),
        SurfaceNames[pr.surface[i]] ?? "",
        pr.roughness[i].toFixed(3),
        pr.grip[i].toFixed(3),
        ((pr.crossfall[i] * 180) / Math.PI).toFixed(3),
        KerbNames[pr.kerbL[i]] ?? "",
        KerbNames[pr.kerbR[i]] ?? "",
        RunoffNames[pr.runoffL[i]] ?? "",
        RunoffNames[pr.runoffR[i]] ?? "",
        pr.barrierDistL[i].toFixed(1),
        pr.barrierDistR[i].toFixed(1),
        fi >= 0 && track.features[fi] ? `${track.features[fi].name} (${FeatureLabels[track.features[fi].kind]})` : "",
      );
    }
    rows.push(cols.join(","));
  }
  return rows.join("\n");
}
