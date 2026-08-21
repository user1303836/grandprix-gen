/**
 * Shared 3D road frame — the single source of truth for vehicle/camera/
 * spray orientation on the circuit.
 *
 * The car model (src/ui/car.ts) uses LOCAL -Z as forward and LOCAL +Y as
 * up (nose at z=-2.5, rear wing at z=+2.1). The previous Euler approach
 * (`rotation.y = -heading; rotation.z = -bank`) ignored the plan→world
 * y-flip and pitched/rolled nothing; measured dot(forward, tangent) was
 * ≈ -0.4 (cars effectively drove backwards).
 *
 * roadFrameAt() returns a plain-math orthonormal basis in PLAN space:
 *   tangent  — 3D direction of travel (central difference, captures grade)
 *   normal   — road surface normal (world-up rotated by banking)
 *   lateral  — normal × tangent (right-handed), points to the LEFT of travel
 *   heading  — plan heading angle (rad, atan2 of plan tangent)
 *   grade    — dz/ds along the tangent (signed)
 *   bank     — signed banking angle (rad, + = right side down? see types)
 *
 * planToWorld() converts plan vectors to three.js world space (x, z, -y).
 * basisQuaternion() maps the car's local axes into the road frame.
 */

import type { Track } from "./types";
import { sampleAt } from "./types";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RoadFrame {
  /** plan-space position on the centerline */
  position: Vec3;
  /** plan-space 3D direction of travel (normalized) */
  tangent: Vec3;
  /** plan-space road normal (banked up, normalized) */
  normal: Vec3;
  /** plan-space lateral axis = normal × tangent (points left of travel) */
  lateral: Vec3;
  heading: number;
  /** signed slope along direction of travel (dz per meter) */
  grade: number;
  bank: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/** Full 3D road frame at arc position s (wrap-safe, seam-continuous). */
export function roadFrameAt(track: Track, s: number): RoadFrame {
  const L = track.length;
  const sm = ((s % L) + L) % L;
  // central difference in 3D captures both horizontal turn and grade;
  // epsilon ~ 1.5 m: small enough for hairpins, large enough to be stable
  const eps = Math.min(1.5, L / 400);
  const a = sampleAt(track, (((sm - eps) % L) + L) % L);
  const b = sampleAt(track, (sm + eps) % L);
  const here = sampleAt(track, sm);
  const tangent = norm(sub(b, a));
  const grade = tangent.z;
  // road normal: start from world up, pitch back by the grade, then roll
  // by the banking around the tangent axis.
  // banking convention in this codebase: sample.bank rotates the road
  // around the direction of travel; positive bank = left edge raised.
  // unrolled road normal: world-up made perpendicular to the 3D tangent
  // (captures grade pitch), THEN rolled by the banking around the tangent.
  const up: Vec3 = { x: 0, y: 0, z: 1 };
  const along = dot(up, tangent);
  const up0 = norm({ x: up.x - tangent.x * along, y: up.y - tangent.y * along, z: up.z - tangent.z * along });
  // banking convention in this codebase: sample.bank rotates the road
  // around the direction of travel; positive bank = left edge raised.
  // Rodrigues rotation of `up0` around `tangent` by `bank`
  const th = here.bank;
  const c = Math.cos(th);
  const sN = Math.sin(th);
  const k = tangent;
  const kU = cross(k, up0);
  const normal = norm({
    x: up0.x * c + kU.x * sN + k.x * dot(k, up0) * (1 - c),
    y: up0.y * c + kU.y * sN + k.y * dot(k, up0) * (1 - c),
    z: up0.z * c + kU.z * sN + k.z * dot(k, up0) * (1 - c),
  });
  const lateral = norm(cross(normal, tangent));
  return {
    position: { x: here.x, y: here.y, z: here.z },
    tangent,
    normal,
    lateral,
    heading: here.heading,
    grade,
    bank: here.bank,
  };
}

/** Plan-space vector → three.js world vector (x, zUp, -yPlan). */
export function planToWorld(v: Vec3): Vec3 {
  return { x: v.x, y: v.z, z: -v.y };
}

/**
 * Basis vectors (WORLD space) for a rotation matrix whose columns map the
 * car model's local axes into the road frame. Car local: -Z forward, +Y up.
 * Returned basis: { x, y, z } are the world directions of the car's local
 * +X, +Y, +Z axes. Right-handed and orthonormal by construction.
 */
export function carBasisWorld(frame: RoadFrame): { x: Vec3; y: Vec3; z: Vec3 } {
  const t = planToWorld(frame.tangent); // car forward
  const n = planToWorld(frame.normal); // car up
  // local -Z → t  ⇒  local +Z → -t
  const z: Vec3 = { x: -t.x, y: -t.y, z: -t.z };
  const y: Vec3 = n;
  const x = norm(cross(y, z)); // y × z, orthonormalized
  // re-orthogonalize y against x,z for numerical cleanliness
  const yOrtho = norm(cross(z, x));
  return { x, y: yOrtho, z };
}
