/**
 * Real pit-lane alignment: a separate centerline with entry / decel /
 * working / exit / accel phases, lane bands, pit wall, boxes and markings.
 * The lane travels in the same direction as race traffic, holds bounded
 * curvature and grade, and merges off the racing line.
 */

import { mulberry32 } from "../prng";
import { gradeAt, sampleAt } from "../types";
import type { Track } from "../types";
import type {
  FacilitySitePlan,
  PitBoxPlan,
  PitLaneBand,
  PitLanePlan,
  PitWallPlan,
  FacilityMarkingPlan,
  FacilityPathSample,
  GroundSurface,
} from "./types";
import type { Archetype } from "../../data/facilityArchetypes";

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface PitLaneResult {
  plan: PitLanePlan;
  violations: string[];
}

/**
 * Build the pit-lane plan for a chosen site.
 * @param track      the circuit
 * @param site       chosen pit-straight window + side
 * @param arch       facility archetype (band widths)
 * @param seed       facility seed
 * @param ground     optional ground surface (grade smoothing reads track z)
 */
export function buildPitLane(
  track: Track,
  site: FacilitySitePlan,
  arch: Archetype,
  seed: number,
  ground: GroundSurface | null,
): PitLaneResult {
  const violations: string[] = [];
  const rnd = mulberry32(seed ^ 0x917);
  const sideSign = site.side === "left" ? 1 : -1;
  const bands = arch.bands;

  // ---- lane-band layout (offsets measured from the main centerline) ------
  // halfW varies per sample; plan against the MAX half width on the site
  const s0 = site.sStart;
  const s1 = site.sEnd;
  let halfW = 6;
  for (let s = s0; s < s1; s += 10) {
    const p = sampleAt(track, s % track.length);
    const w = Math.max(
      (track.props.widthL?.[Math.round(p.s / track.ds) % track.samples.length] ?? 6),
      (track.props.widthR?.[Math.round(p.s / track.ds) % track.samples.length] ?? 6),
    );
    halfW = Math.max(halfW, w);
  }
  let o = halfW;
  const mk = (kind: PitLaneBand["kind"], w: number, surface: PitLaneBand["surface"]): PitLaneBand => {
    const b = { kind, offsetInner: o, offsetOuter: o + w, surface };
    o += w;
    return b;
  };
  const laneBands: PitLaneBand[] = [
    mk("verge", bands.verge, "grass"),
    mk("pit-wall", bands.pitWall, "concrete"),
    mk("fast-lane", bands.fastLane, "asphalt"),
    mk("working-lane", bands.workingLane, "asphalt"),
    mk("box-apron", bands.boxApron, "concrete"),
    mk("garage-apron", bands.garageApron, "concrete"),
  ];
  // the pit PATH (driving line) runs down the fast-lane/working-lane split
  const fastLane = laneBands.find((b) => b.kind === "fast-lane")!;
  const workingLane = laneBands.find((b) => b.kind === "working-lane")!;
  const pathOffset = (fastLane.offsetInner + workingLane.offsetOuter) / 2;

  // ---- path phases (in track-s along the site) ---------------------------
  const entryLen = 130 + rnd() * 40;
  const exitLen = 150 + rnd() * 50;
  const L = track.length;
  const entryTrackS = (((s0 - entryLen) % L) + L) % L;
  const exitTrackS = (s1 + exitLen) % L;

  // lateral offset profile as a function of track-s
  const edgeOffset = halfW + bands.verge * 0.5; // path starts/ends hugging the track edge
  const offsetAt = (trackS: number): number => {
    const d = ((trackS - entryTrackS) % L + L) % L; // distance along from entry start
    const entryEnd = ((s0 - entryTrackS) % L + L) % L;
    const workEnd = ((s1 - entryTrackS) % L + L) % L;
    const total = ((exitTrackS - entryTrackS) % L + L) % L;
    if (d < entryEnd) {
      // diverge: smoothstep from edge to full
      return edgeOffset + (pathOffset - edgeOffset) * smoothstep(d / Math.max(1, entryEnd));
    }
    if (d < workEnd) return pathOffset;
    // merge back
    const t = (d - workEnd) / Math.max(1, total - workEnd);
    return pathOffset + (edgeOffset - pathOffset) * smoothstep(t);
  };

  // ---- centerline samples -------------------------------------------------
  const step = 4;
  const totalLen = ((exitTrackS - entryTrackS) % L + L) % L;
  const centerline: FacilityPathSample[] = [];
  let px = 0;
  let py = 0;
  let hasPrev = false;
  let pitS = 0;
  const zRaw: number[] = [];
  const nS = Math.floor(totalLen / step);
  for (let k = 0; k <= nS; k++) {
    const d = k * step;
    const trackS = (entryTrackS + d) % L;
    const p = sampleAt(track, trackS);
    const off = offsetAt(trackS) * sideSign;
    const nx = -Math.sin(p.heading);
    const ny = Math.cos(p.heading);
    const x = p.x + nx * off;
    const y = p.y + ny * off;
    if (hasPrev) pitS += Math.hypot(x - px, y - py);
    px = x;
    py = y;
    hasPrev = true;
    zRaw.push(p.z);
    centerline.push({ s: pitS, x, y, z: p.z, heading: p.heading, kappa: 0, trackS });
  }
  // smooth plan positions (kills resampling kinks at blend boundaries)
  {
    const w = 3; // ~12 m
    const xs = centerline.map((c) => c.x);
    const ys = centerline.map((c) => c.y);
    for (let k = 0; k < centerline.length; k++) {
      let ax = 0;
      let ay = 0;
      let cnt = 0;
      for (let j = -w; j <= w; j++) {
        const idx = Math.min(centerline.length - 1, Math.max(0, k + j));
        ax += xs[idx];
        ay += ys[idx];
        cnt++;
      }
      centerline[k].x = ax / cnt;
      centerline[k].y = ay / cnt;
    }
  }
  // headings from the path itself
  for (let k = 0; k < centerline.length; k++) {
    const a = centerline[Math.max(0, k - 1)];
    const b = centerline[Math.min(centerline.length - 1, k + 1)];
    centerline[k].heading = Math.atan2(b.y - a.y, b.x - a.x);
    const ds = Math.max(1e-3, b.s - a.s);
    const dh = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading));
    centerline[k].kappa = dh / ds;
  }
  // z: gentle own grade — heavy smoothing so the lane never warps per-sample
  const win = Math.max(3, Math.round(90 / step));
  for (let k = 0; k < centerline.length; k++) {
    let acc = 0;
    let cnt = 0;
    for (let j = -win; j <= win; j++) {
      const idx = Math.min(centerline.length - 1, Math.max(0, k + j));
      acc += zRaw[idx];
      cnt++;
    }
    centerline[k].z = acc / cnt + 0.02;
  }

  // ---- phases along the pit path ------------------------------------------
  const sAtTrackS = (ts: number): number => {
    const d = ((ts - entryTrackS) % L + L) % L;
    return Math.min(pitS, d);
  };
  const speedLimitS = sAtTrackS(s0) + 12;
  const releaseS = sAtTrackS(s1) - 8;
  const phases: PitLanePlan["phases"] = {
    entryS: [0, speedLimitS],
    decelS: [0, speedLimitS],
    workingS: [speedLimitS, releaseS],
    exitS: [releaseS, pitS],
    accelS: [releaseS, pitS],
  };

  // ---- pit boxes ------------------------------------------------------------
  const boxCount = Math.max(6, Math.min(arch.garages[1], Math.floor((releaseS - speedLimitS - 20) / 16)));
  const pitBoxes: PitBoxPlan[] = [];
  for (let i = 0; i < boxCount; i++) {
    const bs = speedLimitS + 14 + i * ((releaseS - speedLimitS - 28) / Math.max(1, boxCount - 1));
    pitBoxes.push({
      index: i + 1,
      s: bs,
      bayId: i,
      width: 4.2,
      length: 14.5,
    });
  }

  // ---- pit wall -------------------------------------------------------------
  const openings: PitWallPlan["openings"] = [];
  const stations: PitWallPlan["stations"] = [];
  const nStations = Math.max(2, Math.floor(boxCount / 6));
  for (let i = 0; i < nStations; i++) {
    stations.push({ s: speedLimitS + ((i + 0.5) / nStations) * (releaseS - speedLimitS) });
  }
  openings.push({ s: speedLimitS - 6, length: 4 });
  openings.push({ s: releaseS + 2, length: 4 });
  const pitWall: PitWallPlan = { sStart: sAtTrackS(s0) - 18, sEnd: sAtTrackS(s1) + 14, openings, stations };

  // ---- markings --------------------------------------------------------------
  const markings: FacilityMarkingPlan[] = [];
  const edgeO = (edgeOffset + bands.verge * 0.3) * 0; // markings offsets are pit-path-relative
  markings.push({ kind: "pit-entry-line", s: 4, offset: 0, length: speedLimitS - 20 });
  markings.push({ kind: "pit-exit-line", s: releaseS + 6, offset: 0, length: pitS - releaseS - 12 });
  markings.push({ kind: "speed-limit-line", s: speedLimitS, offset: 0, length: 0.6 });
  markings.push({ kind: "release-line", s: releaseS, offset: 0, length: 0.6 });
  markings.push({ kind: "fast-lane-separation", s: speedLimitS, offset: (workingLane.offsetOuter - pathOffset) * 0 - 2.0, length: releaseS - speedLimitS });
  for (let k = 0; k < 4; k++) {
    markings.push({ kind: "arrow", s: 18 + k * 24, offset: 0, length: 6, angle: 0 });
  }
  for (const b of pitBoxes) {
    markings.push({ kind: "box-outline", s: b.s, offset: 0, length: b.length, text: undefined });
    markings.push({ kind: "box-number", s: b.s, offset: 0, length: 1.2, text: String(b.index) });
  }
  void edgeO;

  // ---- validation ------------------------------------------------------------
  // 1. travel direction matches the track at every sample
  for (let k = 2; k < centerline.length - 2; k += 4) {
    const c = centerline[k];
    const tp = sampleAt(track, c.trackS);
    const dh = Math.atan2(Math.sin(c.heading - tp.heading), Math.cos(c.heading - tp.heading));
    if (Math.abs(dh) > 0.6) {
      violations.push(`pit path diverges from travel direction at trackS=${c.trackS.toFixed(0)} (dh=${dh.toFixed(2)})`);
      break;
    }
  }
  // 2. grade: the lane legitimately follows the main-straight grade; flag
  // only excess over the track's own grade (and never below a sanity cap)
  for (let k = 4; k < centerline.length; k += 4) {
    const g = Math.abs(centerline[k].z - centerline[k - 4].z) / Math.max(1, centerline[k].s - centerline[k - 4].s);
    const tg = Math.abs(gradeAt(track, centerline[k].trackS));
    if (g > Math.max(0.07, tg + 0.025)) {
      violations.push(`pit path grade ${(g * 100).toFixed(1)}% exceeds track grade ${(tg * 100).toFixed(1)}% at s=${centerline[k].s.toFixed(0)}`);
      break;
    }
  }
  // 3. separation from the racing surface inside the working section
  const minSep = halfW + 0.8;
  for (const c of centerline) {
    const d = ((c.trackS - entryTrackS) % L + L) % L;
    const inMerge = d < 40 || d > totalLen - 40;
    if (inMerge) continue;
    const tp = sampleAt(track, c.trackS);
    const dist = Math.hypot(c.x - tp.x, c.y - tp.y);
    if (dist < minSep) {
      violations.push(`pit path too close to track (${dist.toFixed(1)}m) at trackS=${c.trackS.toFixed(0)}`);
      break;
    }
  }
  // 4. curvature sanity
  for (const c of centerline) {
    if (Math.abs(c.kappa) > 0.06) {
      violations.push(`pit path curvature too high (${c.kappa.toFixed(3)}) at s=${c.s.toFixed(0)}`);
      break;
    }
  }
  void gradeAt;
  void ground;

  const plan: PitLanePlan = {
    side: site.side,
    mainStraightSStart: s0,
    mainStraightSEnd: s1,
    centerline,
    phases,
    entryTrackS,
    exitTrackS,
    laneBands,
    pitBoxes,
    markings,
    pitWall,
    speedLimitS,
    releaseS,
    width: o - halfW,
  };
  return { plan, violations };
}
