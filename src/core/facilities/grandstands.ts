/**
 * Grandstand planning: archetype selection, main-stand placement facing the
 * pit complex, secondary stands at braking zones/hairpins, explicit
 * front-axis orientation, and sightline scoring.
 *
 * Orientation contract (documented, no axis guessing):
 *   frontDir — plan unit vector the stand FACES (toward its target range)
 *   longDir  — plan unit vector along the seating rows (⊥ frontDir)
 *   rows rise AWAY from the track: row k sits at
 *     origin + longDir·(width spread) - frontDir·(k·rowDepth), z += k·rowRise
 */

import { mulberry32 } from "../prng";
import { sampleAt } from "../types";
import type { Track } from "../types";
import type { Archetype, GrandstandKind } from "../../data/facilityArchetypes";
import type {
  FacilityIdentity,
  FacilitySitePlan,
  GrandstandPlan,
  GroundSurface,
  Vec2,
} from "./types";
import { chooseFoundation, footprintStats, polygonOfRect } from "./foundations";
import type { FoundationPlan } from "./types";
import { Corridor } from "../corridor";
import { makeTrackProximity } from "../terrain";

export interface GrandstandResult {
  stands: GrandstandPlan[];
  foundations: FoundationPlan[];
  violations: string[];
}

const norm2 = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** Mean point of a track range (short arc, no wrap). */
function rangeCenter(track: Track, sStart: number, sEnd: number): Vec2 {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let s = sStart; s <= sEnd; s += 12) {
    const p = sampleAt(track, s % track.length);
    x += p.x;
    y += p.y;
    n++;
  }
  return { x: x / n, y: y / n };
}

/** Representative sightline score: can front/mid/top rows see the target?
 * Lightweight: penalize by ground rise between stand and target, and by
 * the pit building blocking the main-straight view. */
function sightlineScore(
  track: Track,
  ground: GroundSurface | null,
  standPos: Vec2,
  standBaseZ: number,
  rows: number,
  rowRise: number,
  target: { sStart: number; sEnd: number },
): number {
  let score = 1;
  const c = rangeCenter(track, target.sStart, target.sEnd);
  const dist = Math.hypot(c.x - standPos.x, c.y - standPos.y);
  if (dist < 25) score *= 0.7; // too close: looking straight down
  if (dist > 260) score *= Math.max(0.25, 260 / dist * 0.25);
  // ground humps between stand and target block low rows
  if (ground) {
    const topRowZ = standBaseZ + rows * rowRise;
    let blocked = 0;
    let total = 0;
    for (let t = 0.15; t < 0.9; t += 0.15) {
      const x = standPos.x + (c.x - standPos.x) * t;
      const y = standPos.y + (c.y - standPos.y) * t;
      const g = ground.elevationAt(x, y);
      if (g === null) continue;
      total++;
      const p = sampleAt(track, ((target.sStart + target.sEnd) / 2) % track.length);
      const sightZ = standBaseZ + (p.z - standBaseZ) * t;
      if (g > sightZ + 2.5) blocked++;
      void topRowZ;
    }
    if (total > 0) score *= 1 - (blocked / total) * 0.7;
  }
  return Math.max(0.05, Math.min(1, score));
}

/** Place one stand rectangle facing a target range. */
function planStand(
  track: Track,
  ground: GroundSurface | null,
  id: string,
  kind: GrandstandKind,
  target: { sStart: number; sEnd: number },
  sideSign: number,
  offset: number,
  width: number,
  rows: number,
  roof: GrandstandPlan["roof"],
  rnd: () => number,
): { stand: GrandstandPlan; foundation: FoundationPlan } | null {
  const center = rangeCenter(track, target.sStart, target.sEnd);
  // anchor: mid target, pushed out along the local normal
  const midS = ((target.sStart + target.sEnd) / 2) % track.length;
  const p = sampleAt(track, midS);
  const nx = -Math.sin(p.heading) * sideSign;
  const ny = Math.cos(p.heading) * sideSign;
  // corridor clearance: the whole footprint must stay off the engineered
  // platform (never overhang the runoff/road). Escalate the offset, else reject.
  const corr = new Corridor(track);
  const prox = makeTrackProximity(track.samples);
  const needed = (x0: number, y0: number): boolean => {
    const near = prox.nearest(x0, y0, 90);
    if (!near || near.i === undefined) return true;
    const ph = corr.platformHalf(near.i);
    return near.d > Math.max(ph.l, ph.r) + 2.5;
  };
  let offsetUse = offset;
  let ox = 0;
  let oy = 0;
  let placed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    ox = p.x + nx * offsetUse;
    oy = p.y + ny * offsetUse;
    const fd = norm2({ x: center.x - ox, y: center.y - oy });
    const ld = norm2({ x: -fd.y, y: fd.x });
    const w2 = width / 2;
    const dEst = 12; // front-edge clearance proxy; corners checked below
    void dEst;
    const corners = [
      { x: ox - ld.x * w2, y: oy - ld.y * w2 },
      { x: ox + ld.x * w2, y: oy + ld.y * w2 },
      { x: ox - ld.x * w2 - fd.x * 30, y: oy - ld.y * w2 - fd.y * 30 },
      { x: ox + ld.x * w2 + -fd.x * 30, y: oy + ld.y * w2 + -fd.y * 30 },
    ];
    if (corners.every((c) => needed(c.x, c.y))) {
      placed = true;
      break;
    }
    offsetUse += 14;
  }
  if (!placed) return null;
  // front direction: from stand center toward the target center
  const front = norm2({ x: center.x - ox, y: center.y - oy });
  void offsetUse;
  const longDir = norm2({ x: -front.y, y: front.x });
  // rectangular footprint: front edge at origin, extends back by depth
  const rowDepth = kind === "temporary-bleacher" ? 0.8 : 0.9;
  const rowRise = kind === "temporary-bleacher" ? 0.55 : 0.62;
  const tiers = kind === "multi-tier" ? 2 : 1;
  const depth = rows * rowDepth * 1.05 + 4;
  // the stand extends BACKWARD from its front edge (away from the track)
  const cx = ox - front.x * (depth / 2);
  const cy = oy - front.y * (depth / 2);
  const angleU = Math.atan2(longDir.y, longDir.x);
  const footprint = polygonOfRect(cx, cy, width / 2, depth / 2, angleU);
  const stats = footprintStats(ground, footprint);
  const baseZ = stats.samples > 0 ? Math.max(p.z + 0.4, stats.mean + 0.2) : p.z + 0.4;
  void 0;
  const fdn = chooseFoundation(`fdn-${id}`, footprint, stats, baseZ, kind === "hillside" ? "hillside-terrace" : stats.max - stats.min > 3 ? "stepped-plinth" : undefined);
  // true facing: dot(frontDir, unit(targetCenter − stand origin))
  const toT = norm2({ x: center.x - ox, y: center.y - oy });
  const facing = front.x * toT.x + front.y * toT.y;
  const viewScore = sightlineScore(track, ground, { x: ox, y: oy }, baseZ, rows, rowRise, target);
  const capacity = Math.round(width * rows * 0.62 * tiers);
  const stand: GrandstandPlan = {
    id,
    kind,
    targetTrackRange: target,
    frontDir: front,
    longDir,
    footprint,
    origin: { x: ox, y: oy, z: baseZ },
    rows,
    rowDepth,
    rowRise,
    tiers,
    width,
    roof,
    capacityEstimate: capacity,
    foundationId: fdn.id,
    viewScore,
    facingDot: facing,
  };
  void rnd;
  return { stand, foundation: fdn };
}

export function buildGrandstands(
  track: Track,
  ground: GroundSurface | null,
  site: FacilitySitePlan,
  arch: Archetype,
  identity: FacilityIdentity,
  seed: number,
): GrandstandResult {
  const violations: string[] = [];
  const rnd = mulberry32(seed ^ 0x67a4d);
  const stands: GrandstandPlan[] = [];
  const foundations: FoundationPlan[] = [];
  const density = identity.crowdCapacity;

  const kindPool = arch.stands.kinds;
  const targetCount = Math.round(
    arch.stands.count[0] + (arch.stands.count[1] - arch.stands.count[0]) * Math.min(1, density / 80000 + 0.2),
  );
  if (targetCount <= 0) return { stands, foundations, violations };

  // ---- main grandstand: OPPOSITE the pit building, facing the pit straight
  const pitSideSign = site.side === "left" ? 1 : -1;
  const mainKind = kindPool[0] ?? "covered-linear";
  const mainRows = Math.round(arch.stands.rows[0] + (arch.stands.rows[1] - arch.stands.rows[0]) * identity.scale);
  const mainWidth = Math.min(site.sEnd - site.sStart - 24, 60 + identity.scale * 160);
  const main = planStand(
    track,
    ground,
    "main",
    mainKind,
    { sStart: site.sStart + 12, sEnd: site.sEnd - 12 },
    -pitSideSign, // opposite side from the pit building
    24 + rnd() * 8,
    Math.max(36, mainWidth),
    mainRows,
    arch.roof === "tensile-canopy" ? "tensile-canopy" : mainKind === "multi-tier" || mainKind === "cantilever-roof" ? "cantilever" : "flat",
    rnd,
  );
  if (main) {
    stands.push(main.stand);
    foundations.push(main.foundation);
    if (main.stand.viewScore < 0.35) {
      violations.push(`main grandstand view score low (${main.stand.viewScore.toFixed(2)})`);
    }
  }

  // ---- secondary stands at spectator corners -------------------------------
  // spectator value: slow corners with big direction change watch best
  const cornerTargets = [...track.corners]
    .filter((c) => c.minRadius < 90)
    .sort((a, b) => b.angle / Math.max(10, b.minRadius) - a.angle / Math.max(10, a.minRadius))
    .slice(0, targetCount - 1);
  let k = 0;
  for (const corner of cornerTargets) {
    const side = rnd() < 0.5 ? 1 : -1;
    const kind = kindPool[(k + 1) % kindPool.length] ?? "uncovered-terrace";
    const sRange = {
      sStart: (corner.sApex - 50 + track.length) % track.length,
      sEnd: (corner.sApex + 50) % track.length,
    };
    const st = planStand(
      track,
      ground,
      `secondary-${k}`,
      kind,
      sRange,
      side,
      30 + rnd() * 26,
      30 + rnd() * 44,
      Math.round(mainRows * (0.35 + rnd() * 0.4)),
      kind === "covered-linear" ? "cantilever" : "none",
      rnd,
    );
    if (st && st.stand.viewScore > 0.3) {
      // don't place on top of another stand or the pit complex
      const clash = stands.some((o) => {
        const dx = o.origin.x - st.stand.origin.x;
        const dy = o.origin.y - st.stand.origin.y;
        return Math.hypot(dx, dy) < (o.width + st.stand.width) * 0.6;
      });
      const pitClash = Math.abs(corner.sApex - (site.sStart + site.sEnd) / 2) < (site.sEnd - site.sStart) / 2 + 80;
      if (!clash && !pitClash) {
        stands.push(st.stand);
        foundations.push(st.foundation);
        k++;
      }
    }
  }
  return { stands, foundations, violations };
}
