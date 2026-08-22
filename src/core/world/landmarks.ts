/**
 * Hero landmarks: a few explicit, validated compositional anchors per world.
 * Never randomly scaled scenery — each is placed against the track for
 * onboard/aerial composition and checked against corridor clearances.
 */

import { Rng } from "../prng";
import type { Corner, TrackSample } from "../types";
import type { TerrainSurface } from "../terrain";
import { makeTrackProximity } from "../terrain";
import type {
  EnvironmentIdentity,
  EnvironmentParams,
  Landmark,
  RoleSpan,
  WaterBody,
} from "./types";

interface Ctx {
  samples: TrackSample[];
  corners: Corner[];
  spans: RoleSpan[];
  ds: number;
  trackLength: number;
  surface: TerrainSurface;
  identity: EnvironmentIdentity;
  params: EnvironmentParams;
  water: WaterBody[];
}

const ROAD_CLEAR = 14; // trunk/structure horizontal clearance from centerline
const CANOPY_CLEAR = 6.0; // over-road canopy vertical clearance

function placeHeroTree(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  // outside of a medium/fast corner, trunk beyond the runoff, canopy may
  // reach over the road (clearance enforced in realistic mode)
  const pool = ctx.corners.filter((c) => c.minRadius > 40 && c.minRadius < 400 && c.length > 60);
  if (pool.length === 0) return false;
  const c = pool[rng.int(0, pool.length - 1)];
  const ds = ctx.ds;
  const n = ctx.samples.length;
  const i = Math.round(c.sApex / ds) % n;
  const p = ctx.samples[i];
  const nx = -Math.sin(p.heading);
  const ny = Math.cos(p.heading);
  const side = c.direction === "L" ? -1 : 1; // outside of the corner (left normal = left of travel)
  // permissive/fantasy: closer, bigger — the canopy reaches over the road
  const permissive = ctx.params.realism !== "realistic";
  const off = ROAD_CLEAR + (permissive ? 1 + rng.next() * 4 : 6 + rng.next() * 8);
  const x = p.x + nx * off * side;
  const y = p.y + ny * off * side;
  const z = ctx.surface.elevationAt(x, y);
  if (!Number.isFinite(z)) return false;
  out.push({
    kind: "hero-tree",
    x,
    y,
    z,
    heading: rng.range(0, Math.PI * 2),
    scale: permissive ? 3.2 + rng.next() * 1.4 : 2.6 + rng.next() * 1.3,
    s: p.s,
    seed: rng.int(0, 1e9),
  });
  return true;
}

function placeCrestTree(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  // a solitary silhouette tree on the highest point near a ridge span
  const ridges = ctx.spans.filter((s) => s.kind === "ridge");
  if (ridges.length === 0) return false;
  const sp = ridges[rng.int(0, ridges.length - 1)];
  const sMid = (sp.sStart + (sp.sEnd - sp.sStart + (sp.sEnd < sp.sStart ? ctx.trackLength : 0)) / 2) % ctx.trackLength;
  const i = Math.round(sMid / ctx.ds) % ctx.samples.length;
  const p = ctx.samples[i];
  const nx = -Math.sin(p.heading);
  const ny = Math.cos(p.heading);
  const side = rng.next() < 0.5 ? 1 : -1;
  const off = ROAD_CLEAR + 10 + rng.next() * 14;
  const x = p.x + nx * off * side;
  const y = p.y + ny * off * side;
  const z = ctx.surface.elevationAt(x, y);
  if (!Number.isFinite(z)) return false;
  out.push({
    kind: "crest-tree",
    x,
    y,
    z,
    heading: rng.range(0, Math.PI * 2),
    scale: 1.7 + rng.next() * 0.8,
    s: p.s,
    seed: rng.int(0, 1e9),
  });
  return true;
}

function placeForestTunnel(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  const forests = ctx.spans.filter((s) => s.kind === "forest-corridor");
  if (forests.length === 0) return false;
  const sp = forests[rng.int(0, forests.length - 1)];
  const sMid = (sp.sStart + (sp.sEnd - sp.sStart + (sp.sEnd < sp.sStart ? ctx.trackLength : 0)) / 2) % ctx.trackLength;
  const i = Math.round(sMid / ctx.ds) % ctx.samples.length;
  const p = ctx.samples[i];
  out.push({
    kind: "forest-tunnel",
    x: p.x,
    y: p.y,
    z: p.z,
    heading: p.heading,
    scale: 1,
    s: p.s,
    seed: rng.int(0, 1e9),
  });
  return true;
}

function placeMonolith(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  const prox = makeTrackProximity(ctx.samples);
  for (let tries = 0; tries < 60; tries++) {
    const gx = 2 + rng.int(0, ctx.surface.width - 5);
    const gy = 2 + rng.int(0, ctx.surface.height - 5);
    const x = ctx.surface.originX + gx * ctx.surface.resolution;
    const y = ctx.surface.originY + gy * ctx.surface.resolution;
    const near = prox.nearest(x, y, 90);
    if (!near || near.d < 30) continue; // visible but well clear
    const z = ctx.surface.elevationAt(x, y);
    if (!Number.isFinite(z)) continue;
    if (ctx.surface.slopeAt(x, y) > 0.5) continue;
    out.push({
      kind: "monolith",
      x,
      y,
      z,
      heading: rng.range(0, Math.PI * 2),
      scale: 1 + rng.next() * 1.4,
      s: near.i !== undefined ? ctx.samples[near.i].s : 0,
      seed: rng.int(0, 1e9),
    });
    return true;
  }
  return false;
}

function placeWaterfall(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  const rivers = ctx.water.filter((w) => w.type === "river");
  if (rivers.length === 0) return false;
  const river = rivers[0];
  if (river.type !== "river" || river.points.length < 10) return false;
  // steepest drop along the centerline
  let best = 0;
  let bestDrop = 0;
  for (let i = 1; i < river.points.length; i++) {
    const drop = river.points[i - 1].z - river.points[i].z;
    if (drop > bestDrop) {
      bestDrop = drop;
      best = i;
    }
  }
  if (bestDrop < 3) return false;
  const p = river.points[best];
  const q = river.points[best - 1];
  out.push({
    kind: "waterfall",
    x: p.x,
    y: p.y,
    z: (p.z + q.z) / 2,
    heading: Math.atan2(p.y - q.y, p.x - q.x),
    scale: Math.min(2.5, bestDrop / 4),
    s: river.crossings[0] ?? 0,
    seed: rng.int(0, 1e9),
  });
  return true;
}

function placeRockArch(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  // straddles a straight; permissive/fantasy only (caller gates)
  const n = ctx.samples.length;
  const straights: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(ctx.samples[i].kappa) < 0.001) run++;
    else {
      if (run * ctx.ds > 220) straights.push(i - Math.floor(run / 2));
      run = 0;
    }
  }
  if (straights.length === 0) return false;
  const i = straights[rng.int(0, straights.length - 1)];
  const p = ctx.samples[i];
  out.push({
    kind: "rock-arch",
    x: p.x,
    y: p.y,
    z: p.z,
    heading: p.heading,
    scale: 1.1 + rng.next() * 0.5,
    s: p.s,
    seed: rng.int(0, 1e9),
  });
  return true;
}

function placeRuin(ctx: Ctx, rng: Rng, out: Landmark[]): boolean {
  const prox = makeTrackProximity(ctx.samples);
  for (let tries = 0; tries < 50; tries++) {
    const gx = 2 + rng.int(0, ctx.surface.width - 5);
    const gy = 2 + rng.int(0, ctx.surface.height - 5);
    const x = ctx.surface.originX + gx * ctx.surface.resolution;
    const y = ctx.surface.originY + gy * ctx.surface.resolution;
    const near = prox.nearest(x, y, 70);
    if (!near || near.d < 34) continue;
    const z = ctx.surface.elevationAt(x, y);
    if (!Number.isFinite(z)) continue;
    out.push({
      kind: "ruin",
      x,
      y,
      z,
      heading: rng.range(0, Math.PI * 2),
      scale: 0.8 + rng.next() * 0.7,
      s: near.i !== undefined ? ctx.samples[near.i].s : 0,
      seed: rng.int(0, 1e9),
    });
    return true;
  }
  return false;
}

/** Pick and place a sparse landmark set for the world. */
export function planLandmarks(
  samples: TrackSample[],
  corners: Corner[],
  spans: RoleSpan[],
  ds: number,
  trackLength: number,
  surface: TerrainSurface,
  identity: EnvironmentIdentity,
  params: EnvironmentParams,
  water: WaterBody[],
  envSeed: number,
): Landmark[] {
  const ctx: Ctx = { samples, corners, spans, ds, trackLength, surface, identity, params, water };
  const rng = new Rng(envSeed ^ 0x1ad4);
  const out: Landmark[] = [];

  // candidate pool ordered by identity fit
  const placers: { w: number; fn: (c: Ctx, r: Rng, o: Landmark[]) => boolean }[] = [];
  const wooded = identity.biome === "temperate-forest" || identity.biome === "highland" || identity.biome === "coastal";
  if (wooded) placers.push({ w: 3, fn: placeHeroTree });
  if (spans.some((s) => s.kind === "forest-corridor")) placers.push({ w: 2, fn: placeForestTunnel });
  if (spans.some((s) => s.kind === "ridge")) placers.push({ w: 2, fn: placeCrestTree });
  if (identity.biome === "volcanic" || identity.biome === "alpine" || identity.biome === "arid") {
    placers.push({ w: 3, fn: placeMonolith });
  }
  if (water.some((w) => w.type === "river")) placers.push({ w: 2, fn: placeWaterfall });
  if (params.realism !== "realistic") placers.push({ w: 2, fn: placeRockArch });
  if (identity.humanization === "heritage-road" || identity.humanization === "industrial") {
    placers.push({ w: 2, fn: placeRuin });
  }

  const target = params.realism === "fantasy" ? 4 : 3;
  const wsum = placers.reduce((a, p) => a + p.w, 0);
  let guard = 0;
  while (out.length < target && placers.length > 0 && guard++ < 24) {
    let pick = rng.next() * wsum;
    let idx = 0;
    for (let k = 0; k < placers.length; k++) {
      pick -= placers[k].w;
      if (pick <= 0) {
        idx = k;
        break;
      }
    }
    const ok = placers[idx].fn(ctx, rng, out);
    if (!ok) placers.splice(idx, 1);
    else placers.splice(idx, 1); // one of each kind max
    if (placers.length === 0) break;
  }

  return out;
}

/** landmark clearance constants exported for tests/validation */
export const LANDMARK_CLEAR = { ROAD_CLEAR, CANOPY_CLEAR };
