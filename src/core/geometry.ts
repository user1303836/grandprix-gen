/**
 * Dense-polyline geometry utilities: integration of curvature profiles,
 * closure repair, uniform resampling, curvature estimation and
 * self-intersection / proximity analysis.
 */

export interface Polyline {
  x: Float64Array;
  y: Float64Array;
  n: number;
}

export interface DenseCurve extends Polyline {
  ds: number;
  heading: Float64Array;
  kappa: Float64Array;
  /** Closure error magnitude in meters after repair (0 for exact). */
  closureError: number;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/**
 * Integrate a signed curvature profile into a planar curve.
 * Returns n+1 points; point 0 is origin with heading 0.
 */
export function integrateKappa(kappa: Float64Array, ds: number): DenseCurve {
  const n = kappa.length;
  const x = new Float64Array(n + 1);
  const y = new Float64Array(n + 1);
  const heading = new Float64Array(n + 1);
  const kOut = new Float64Array(n + 1);

  let h = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const k = kappa[i];
    // exact arc step for constant curvature over ds
    const dh = k * ds;
    let dx: number;
    let dy: number;
    if (Math.abs(dh) < 1e-9) {
      dx = Math.cos(h) * ds;
      dy = Math.sin(h) * ds;
    } else {
      const h2 = h + dh;
      dx = (Math.sin(h2) - Math.sin(h)) / k;
      dy = (-Math.cos(h2) + Math.cos(h)) / k;
    }
    x[i] = px;
    y[i] = py;
    heading[i] = h;
    kOut[i] = k;
    px += dx;
    py += dy;
    h += dh;
  }
  x[n] = px;
  y[n] = py;
  heading[n] = h;
  kOut[n] = kappa[n - 1];

  const closureError = Math.hypot(px, py);
  return { x, y, n: n + 1, ds, heading, kappa: kOut, closureError };
}

// ---------------------------------------------------------------------------
// Closure repair
// ---------------------------------------------------------------------------

/**
 * Repair loop closure by adding c0 + c1*sin(2pi s/L) + c2*cos(2pi s/L) to
 * the curvature profile. Solves the linearized 3x3 system for:
 *   total turning = targetWinding * 2pi
 *   integral cos(theta) ds = 0
 *   integral sin(theta) ds = 0
 * Iterated a few times; returns corrected kappa (or null if divergent).
 */
export function repairClosure(
  kappaIn: Float64Array,
  ds: number,
  targetWinding: number,
  iterations = 6,
): { kappa: Float64Array; closureError: number } | null {
  const n = kappaIn.length;
  const L = n * ds;
  let kappa = Float64Array.from(kappaIn);

  for (let iter = 0; iter < iterations; iter++) {
    const curve = integrateKappa(kappa, ds);
    const errX = curve.x[n];
    const errY = curve.y[n];
    const errH = curve.heading[n] - targetWinding * 2 * Math.PI;
    const errMag = Math.hypot(errX, errY);
    if (errMag < 0.05 && Math.abs(errH) < 1e-4) {
      return { kappa, closureError: errMag };
    }
    if (!Number.isFinite(errMag) || errMag > L * 2) return null;

    // Build normal equations for basis functions b0=1, b1=sin(2pi s/L), b2=cos(2pi s/L).
    // delta(s) = c0 + c1 sin(w s) + c2 cos(w s), w = 2pi/L
    // theta'(s) = theta(s) + integral0..s delta
    // Unknowns c solve:
    //   [int delta ds]                 = -errH
    //   [int -D(s) sin(theta) ds]      = -errX
    //   [int  D(s) cos(theta) ds]      = -errY
    // where D(s) = c0*s + c1*(1-cos(ws))/w + c2*sin(ws)/w  (integral of basis)
    const w = (2 * Math.PI) / L;
    // Basis integrals B0(s)=s, B1(s)=(1-cos(ws))/w, B2(s)=sin(ws)/w
    // Accumulate 3x3 normal system A c = b from the three residual rows.
    const A = new Float64Array(9);
    const b = new Float64Array(3);

    // Row 0 (heading): int of basis over whole lap: [L, 0, 0]
    A[0] = L;
    b[0] = -errH;

    // Rows 1,2: accumulate over stations
    let B0 = 0;
    let B1 = 0;
    let B2 = 0;
    // We need int f(s) Bk(s) ds for f in {-sin(theta), cos(theta)} and
    // int f(s) ds for the constant row contributions... but rows 1 and 2
    // are: sum_k ck * int f(s) Bk(s) ds = -err, because d(delta position).
    // Note b0 (constant curvature) contributes B0(s)=s.
    const m11 = [0, 0, 0];
    const m22 = [0, 0, 0];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const th = curve.heading[i];
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      B0 = s;
      B1 = (1 - Math.cos(w * s)) / w;
      B2 = Math.sin(w * s) / w;
      // d(errX)/dck = int -sin(theta) Bk ds  -> accumulate
      m11[0] += -sn * B0 * ds;
      m11[1] += -sn * B1 * ds;
      m11[2] += -sn * B2 * ds;
      m22[0] += cs * B0 * ds;
      m22[1] += cs * B1 * ds;
      m22[2] += cs * B2 * ds;
      s += ds;
    }
    // A rows: [row0 = (L,0,0)], [row1 = m11], [row2 = m22]
    A[0] = L;
    A[1] = 0;
    A[2] = 0;
    A[3] = m11[0];
    A[4] = m11[1];
    A[5] = m11[2];
    A[6] = m22[0];
    A[7] = m22[1];
    A[8] = m22[2];
    b[0] = -errH;
    b[1] = -errX;
    b[2] = -errY;

    const c = solve3x3(A, b);
    if (!c) return null;

    // Limit per-iteration step for stability on large errors.
    const maxC = 1 / (L * 0.05);
    const c0 = clamp(c[0], -maxC, maxC);
    const c1 = clamp(c[1], -maxC, maxC);
    const c2 = clamp(c[2], -maxC, maxC);

    const k2 = new Float64Array(n);
    s = 0;
    for (let i = 0; i < n; i++) {
      k2[i] = kappa[i] + c0 + c1 * Math.sin(w * s) + c2 * Math.cos(w * s);
      s += ds;
    }
    kappa = k2;
  }
  const curve = integrateKappa(kappa, ds);
  return { kappa, closureError: Math.hypot(curve.x[n], curve.y[n]) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Solve 3x3 system (row-major) via Cramer; null if singular. */
export function solve3x3(A: Float64Array, b: Float64Array): [number, number, number] | null {
  const det =
    A[0] * (A[4] * A[8] - A[5] * A[7]) -
    A[1] * (A[3] * A[8] - A[5] * A[6]) +
    A[2] * (A[3] * A[7] - A[4] * A[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const detX =
    b[0] * (A[4] * A[8] - A[5] * A[7]) -
    A[1] * (b[1] * A[8] - A[5] * b[2]) +
    A[2] * (b[1] * A[7] - A[4] * b[2]);
  const detY =
    A[0] * (b[1] * A[8] - A[5] * b[2]) -
    b[0] * (A[3] * A[8] - A[5] * A[6]) +
    A[2] * (A[3] * b[2] - b[1] * A[6]);
  const detZ =
    A[0] * (A[4] * b[2] - b[1] * A[7]) -
    A[1] * (A[3] * b[2] - b[1] * A[6]) +
    b[0] * (A[3] * A[7] - A[4] * A[6]);
  return [detX / det, detY / det, detZ / det];
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/** Resample a closed dense polyline to n uniform arc-length points. */
export function resampleClosed(curve: Polyline, n: number): {
  x: Float64Array;
  y: Float64Array;
  ds: number;
  length: number;
} {
  const m = curve.n;
  // cumulative length (include closing segment)
  const cum = new Float64Array(m + 1);
  let total = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    total += Math.hypot(curve.x[j] - curve.x[i], curve.y[j] - curve.y[i]);
    cum[i + 1] = total;
  }
  const ds = total / n;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = i * ds;
    while (seg < m - 1 && cum[seg + 1] < target) seg++;
    const segStart = cum[seg];
    const segLen = Math.max(1e-9, cum[seg + 1] - segStart);
    const t = (target - segStart) / segLen;
    const j = (seg + 1) % m;
    x[i] = curve.x[seg] + (curve.x[j] - curve.x[seg]) * t;
    y[i] = curve.y[seg] + (curve.y[j] - curve.y[seg]) * t;
  }
  return { x, y, ds, length: total };
}

/** Heading + curvature from a uniform closed polyline (central differences). */
export function deriveHeadingKappa(
  x: Float64Array,
  y: Float64Array,
  ds: number,
): { heading: Float64Array; kappa: Float64Array } {
  const n = x.length;
  const heading = new Float64Array(n);
  const kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n;
    const i1 = (i + 1) % n;
    heading[i] = Math.atan2(y[i1] - y[i0], x[i1] - x[i0]);
  }
  // unwrap
  for (let i = 1; i < n; i++) {
    let d = heading[i] - heading[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    heading[i] = heading[i - 1] + d;
  }
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n;
    const i1 = (i + 1) % n;
    let d = heading[i1] - heading[i0];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    kappa[i] = d / (2 * ds);
  }
  return { heading, kappa };
}

/** Circular Gaussian smoothing of a periodic signal. */
export function smoothCircular(arr: Float64Array, sigma: number): Float64Array {
  const n = arr.length;
  if (sigma <= 0.01) return Float64Array.from(arr);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    kSum += v;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = (i + j + n) % n;
      acc += arr[idx] * kernel[j + radius];
    }
    out[i] = acc / kSum;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-intersection / proximity
// ---------------------------------------------------------------------------

export interface IntersectionReport {
  /** Number of distinct self-intersection points. */
  intersections: number;
  /** Closest approach (meters) between non-neighboring segments. */
  minSeparation: number;
}

/**
 * Grid broadphase self-intersection test for a closed polyline.
 * Skips segment pairs closer than `skip` sample indices (along the loop).
 */
export function analyzeIntersections(
  x: Float64Array,
  y: Float64Array,
  ds: number,
  skip = 6,
): IntersectionReport {
  const n = x.length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i];
    if (y[i] < minY) minY = y[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const cell = Math.max(4 * ds, 8);
  const gw = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const gh = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const grid: number[][] = new Array(gw * gh);
  const cellOf = (px: number, py: number) => {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor((px - minX) / cell)));
    const cy = Math.min(gh - 1, Math.max(0, Math.floor((py - minY) / cell)));
    return cy * gw + cx;
  };
  for (let i = 0; i < n; i++) {
    const c = cellOf(x[i], y[i]);
    (grid[c] ??= []).push(i);
  }

  let intersections = 0;
  let minSeparation = Infinity;
  const sepSkip = Math.max(skip, Math.round(30 / ds)); // ignore local neighborhood

  for (let i = 0; i < n; i++) {
    const j1 = (i + 1) % n;
    const cx = Math.floor((x[i] - minX) / cell);
    const cy = Math.floor((y[i] - minY) / cell);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1); gx++) {
        const bucket = grid[gy * gw + gx];
        if (!bucket) continue;
        for (const k of bucket) {
          if (k <= i) continue;
          // cyclic index distance
          let d = k - i;
          if (n - d < d) d = n - d;
          if (d < skip) continue;
          const k1 = (k + 1) % n;
          if (segmentsIntersect(x[i], y[i], x[j1], y[j1], x[k], y[k], x[k1], y[k1])) {
            intersections++;
          }
          if (d >= sepSkip) {
            const dist = segSegDistance(x[i], y[i], x[j1], y[j1], x[k], y[k], x[k1], y[k1]);
            if (dist < minSeparation) minSeparation = dist;
          }
        }
      }
    }
  }
  return { intersections, minSeparation: Number.isFinite(minSeparation) ? minSeparation : Infinity };
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segSegDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

function pointSegDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function polygonCentroid(x: Float64Array, y: Float64Array): { cx: number; cy: number } {
  let cx = 0;
  let cy = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    cx += x[i];
    cy += y[i];
  }
  return { cx: cx / n, cy: cy / n };
}

/** Minimum radius encountered in a curvature profile. */
export function minRadius(kappa: Float64Array): number {
  let kMax = 0;
  for (let i = 0; i < kappa.length; i++) {
    const a = Math.abs(kappa[i]);
    if (a > kMax) kMax = a;
  }
  return kMax > 1e-9 ? 1 / kMax : Infinity;
}
