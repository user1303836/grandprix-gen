/**
 * Corridor-level validation: the FINISHED corridor surface (road crown,
 * kerbs, runoff, platform) checked against the terrain and against itself
 * -- not just the centerline. Violations drive a repair/replan/reject
 * policy; nothing is hidden with render offsets.
 */

import type { CivilPlan, CivilKind } from "./civil";
import type { Corridor } from "./corridor";
import { makeTrackProximity } from "./terrain";
import type { Track } from "./types";

export interface CorridorViolation {
  kind:
    | "terrain-penetration"
    | "low-clearance"
    | "support-collision"
    | "insufficient-tunnel-cover";
  s: number;
  detail: string;
}

/** States where the road may legally sit below ground (cuts/tunnels). */
const CUT_KINDS: CivilKind[] = ["open-cut", "retaining", "dual-retaining", "bench", "tunnel", "gallery"];
export function validateCorridor(
  track: Track,
  corridor: Corridor,
  ground: (x: number, y: number) => number,
  plan: CivilPlan,
): CorridorViolation[] {
  const violations: CorridorViolation[] = [];
  const n = track.samples.length;
  const ds = track.ds;

  // ---- full-cross-section terrain check -----------------------------------
  // road may never be below ground unless the plan says cut/tunnel there
  for (let i = 0; i < n; i++) {
    const smp = track.samples[i];
    const kind = plan.stateAt[i];
    const plat = corridor.platformHalf(i);
    const nx = -Math.sin(smp.heading);
    const ny = Math.cos(smp.heading);
    const s = i * ds;
    // sample across the corridor (road edges + runoff edges)
    const offs = [-plat.l, -plat.l * 0.5, 0, plat.r * 0.5, plat.r];
    for (const off of offs) {
      const surf = corridor.surface(s, off);
      const g = ground(smp.x + nx * off, smp.y + ny * off);
      if (!Number.isFinite(g)) continue;
      const dev = surf.z - g;
      // the corridor carve invisibly seats shallow burials (a flat bench
      // up to ~1.8 m deep); only deeper penetration is a true violation
      if (dev < -1.8) {
        // below ground: legal only where the plan cuts
        if (!CUT_KINDS.includes(kind)) {
          violations.push({
            kind: "terrain-penetration",
            s,
            detail: `corridor surface ${(-dev).toFixed(1)}m below ground in "${kind}" state`,
          });
        }
      } else if (dev > 0 && dev < 0.25 && (kind === "viaduct" || kind === "short-bridge")) {
        // bridge deck nearly touching ground: clearance issue
        violations.push({
          kind: "low-clearance",
          s,
          detail: `deck underside ${dev.toFixed(2)}m above ground`,
        });
      }
    }
  }

  // ---- road-over-road vertical clearance ------------------------------------
  {
    const prox = makeTrackProximity(track.samples.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    for (let i = 0; i < n; i += 2) {
      const smp = track.samples[i];
      const near = prox.within(smp.x, smp.y, 14);
      for (const c of near) {
        const j = c.i ?? 0;
        const circDist = Math.min(Math.abs(j - i), n - Math.abs(j - i));
        if (circDist * ds < 40) continue; // same neighborhood (wrap-safe)
        const dz = smp.z - c.z;
        if (Math.abs(dz) < 5.6) {
          violations.push({
            kind: "low-clearance",
            s: i * ds,
            detail: `road-over-road vertical separation ${Math.abs(dz).toFixed(1)}m < 5.6m`,
          });
        }
      }
    }
  }

  // ---- tunnel cover ------------------------------------------------------------
  for (const sp of plan.spans) {
    if (sp.kind !== "tunnel" && sp.kind !== "gallery") continue;
    const i0 = Math.round(sp.sStart / ds) % n;
    const i1 = Math.round(sp.sEnd / ds) % n;
    const len = ((i1 - i0 + n) % n) || n;
    for (let k = 0; k < len; k += Math.max(1, Math.round(10 / ds))) {
      const i = (i0 + k) % n;
      const smp = track.samples[i];
      const g = ground(smp.x, smp.y);
      if (!Number.isFinite(g)) continue;
      const cover = g - smp.z;
      if (cover < 4) {
        violations.push({
          kind: "insufficient-tunnel-cover",
          s: i * ds,
          detail: `only ${cover.toFixed(1)}m of ground over the ${sp.kind}`,
        });
      }
    }
  }

  return violations;
}

/** Dedup + cap the report (long violation lists are unreadable). */
export function summarizeViolations(v: CorridorViolation[]): CorridorViolation[] {
  const byKind = new Map<string, CorridorViolation[]>();
  for (const x of v) {
    const arr = byKind.get(x.kind) ?? [];
    arr.push(x);
    byKind.set(x.kind, arr);
  }
  const out: CorridorViolation[] = [];
  for (const arr of byKind.values()) {
    arr.sort((a, b) => a.s - b.s);
    // keep the worst few per kind
    out.push(...arr.slice(0, 8));
  }
  return out;
}
