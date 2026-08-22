/**
 * The ONE canonical plan↔world coordinate conversion.
 *
 * Plan space: (x, y, z-up) — track plans, facility plans, terrain grids.
 * World space (three.js): (x, z-up, -y).
 *
 * Every mesh builder, exporter, and debug view consumes these helpers.
 * Never hand-permute coordinates inline again.
 */

export interface PlanPoint {
  x: number;
  y: number;
  z: number;
}

/** plan point/position → three.js world position */
export function planPointToWorld(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x, y: z, z: -y };
}

/** plan direction/normal → three.js world direction (same permutation) */
export function planVectorToWorld(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x, y: z, z: -y };
}

/** three.js world position → plan space */
export function worldPointToPlan(x: number, y: number, z: number): PlanPoint {
  return { x, y: -z, z: y };
}

/** Bounds for the blunt render-space sanity check. */
export interface WorldSanityBounds {
  /** track/world elevation range (plan z) */
  minZ: number;
  maxZ: number;
  /** plan-space XY extent center + radius */
  cx: number;
  cy: number;
  radius: number;
}

/**
 * Blunt render-space sanity: a vertex may not sit thousands of metres above
 * or below the elevation range, nor radically outside the world's XY bounds,
 * unless explicitly tagged exceptional. Returns a violation string or null.
 */
export function checkWorldVertexSane(
  p: { x: number; y: number; z: number }, // WORLD space
  bounds: WorldSanityBounds,
  exceptional = false,
): string | null {
  if (exceptional) return null;
  const planZ = p.y; // world y = plan z
  const zSlack = Math.max(400, (bounds.maxZ - bounds.minZ) * 0.8);
  if (planZ > bounds.maxZ + zSlack) return `vertex ${(planZ - bounds.maxZ).toFixed(0)}m above elevation range`;
  if (planZ < bounds.minZ - zSlack) return `vertex ${(bounds.minZ - planZ).toFixed(0)}m below elevation range`;
  const planX = p.x;
  const planY = -p.z;
  const d = Math.hypot(planX - bounds.cx, planY - bounds.cy);
  if (d > bounds.radius * 3 + 4000) return `vertex ${(d / 1000).toFixed(1)}km outside world bounds`;
  return null;
}

/** Validate a whole position buffer (world space). Returns violation strings. */
export function checkWorldGeometrySane(
  positions: Float32Array | number[],
  bounds: WorldSanityBounds,
  maxReport = 4,
): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 < positions.length && out.length < maxReport; i += 3) {
    const v = checkWorldVertexSane({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }, bounds);
    if (v) out.push(`${v} @(${positions[i].toFixed(0)}, ${positions[i + 1].toFixed(0)}, ${positions[i + 2].toFixed(0)})`);
  }
  return out;
}
