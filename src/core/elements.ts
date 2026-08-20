/**
 * Element-sequence (road-design primitive) representation.
 *
 * A track's structural DNA is an ordered list of straights and corners.
 * Corners use clothoid transitions: curvature ramps linearly from 0 to
 * +/-1/R over `transition` meters, holds through an arc, then ramps back.
 *
 * element sequence -> kappa(s) -> heading(s) -> position(s)
 */

import type { AlignmentElement } from "./types";
import { integrateKappa } from "./geometry";

export interface KappaProfile {
  /** Sample spacing, meters. */
  ds: number;
  /** Signed curvature at each station (length n). */
  kappa: Float64Array;
  /** Total length, meters. */
  length: number;
}

export interface CornerGeom {
  radius: number;
  angle: number;
  dir: 1 | -1;
  transition: number;
}

/** Arc + transition lengths implied by desired heading change. */
export function cornerLengths(g: CornerGeom): { arc: number; trans: number; total: number } {
  const R = Math.max(4, g.radius);
  const a = Math.abs(g.angle);
  // heading = (arc + trans) / R
  const needed = a * R;
  const trans = Math.min(Math.max(0, g.transition), needed);
  const arc = Math.max(0, needed - trans);
  return { arc, trans, total: arc + 2 * trans };
}

export function elementLength(el: AlignmentElement): number {
  if (el.type === "straight") return el.length;
  return cornerLengths(el).total;
}

export function elementsTotalLength(elements: AlignmentElement[]): number {
  let L = 0;
  for (const el of elements) L += elementLength(el);
  return L;
}

/**
 * Rasterize elements to a signed-curvature profile at fixed station spacing.
 * Output length n = round(totalLength / ds).
 */
export function kappaFromElements(elements: AlignmentElement[], ds: number): KappaProfile {
  const total = elementsTotalLength(elements);
  const n = Math.max(64, Math.round(total / ds));
  const realDs = total / n;
  const kappa = new Float64Array(n);

  let s = 0;
  for (const el of elements) {
    if (el.type === "straight") {
      s += el.length;
      continue;
    }
    const { arc, trans } = cornerLengths(el);
    const kMax = el.dir / Math.max(4, el.radius);
    // clothoid in
    for (let u = 0; u < trans; u += realDs * 0.5) {
      const f = trans > 0 ? u / trans : 1;
      setK(kappa, realDs, s + u, kMax * f);
    }
    s += trans;
    // arc
    for (let u = 0; u < arc; u += realDs * 0.5) {
      setK(kappa, realDs, s + u, kMax);
    }
    s += arc;
    // clothoid out
    for (let u = 0; u < trans; u += realDs * 0.5) {
      const f = trans > 0 ? 1 - u / trans : 0;
      setK(kappa, realDs, s + u, kMax * f);
    }
    s += trans;
  }
  return { ds: realDs, kappa, length: total };
}

function setK(kappa: Float64Array, ds: number, s: number, k: number): void {
  const n = kappa.length;
  const i = Math.floor(s / ds);
  if (i >= 0 && i < n) kappa[i] = k;
}

/** Total signed turning of a curvature profile. */
export function totalTurning(p: KappaProfile): number {
  let t = 0;
  for (let i = 0; i < p.kappa.length; i++) t += p.kappa[i] * p.ds;
  return t;
}

/** Scale all straight lengths by a factor. */
export function scaleStraights(elements: AlignmentElement[], f: number): AlignmentElement[] {
  return elements.map((el) =>
    el.type === "straight" ? { ...el, length: Math.max(8, el.length * f) } : { ...el },
  );
}

/** Scale corner curvatures (1/R) by factor; transitions adjust too. */
export function scaleCornerSeverity(elements: AlignmentElement[], f: number): AlignmentElement[] {
  return elements.map((el) => {
    if (el.type !== "corner") return { ...el };
    const radius = Math.max(6, el.radius / f);
    return { ...el, radius };
  });
}

// ---------------------------------------------------------------------------
// Element-level morphs (relative to generation-time base snapshot)
// ---------------------------------------------------------------------------

export interface BaseMorphWeights {
  severity: number;
  straightBias: number;
  flow: number;
  technicality: number;
  cornerVariety: number;
}

const severityWeight = (s: number) => 0.55 + s * 1.1;
const straightWeight = (s: number) => 0.6 + s * 1.4;
const transitionWeight = (f: number) => 0.75 + f * 0.5;

/**
 * Continuous morph of pristine elements toward new parameter values.
 * Deterministic; designed so sliders visibly deform the same circuit.
 */
export function morphElements(
  elements: AlignmentElement[],
  params: {
    curvatureSeverity: number;
    longStraightBias: number;
    flow: number;
    technicality: number;
    cornerVariety: number;
    mode: "experimental" | "realistic";
  },
  base: BaseMorphWeights,
): AlignmentElement[] {
  const sevScale = severityWeight(params.curvatureSeverity) / severityWeight(base.severity);
  const straightScale = straightWeight(params.longStraightBias) / straightWeight(base.straightBias);
  const flowScale = transitionWeight(params.flow) / transitionWeight(base.flow);
  const techRadius = 1 - 0.22 * (params.technicality - base.technicality);
  const varietyExp = Math.exp((params.cornerVariety - base.cornerVariety) * 1.1);

  const radii = elements
    .filter((e): e is Extract<AlignmentElement, { type: "corner" }> => e.type === "corner")
    .map((e) => e.radius);
  radii.sort((a, b) => a - b);
  const median = radii.length > 0 ? radii[Math.floor(radii.length / 2)] : 90;

  return elements.map((el) => {
    if (el.type === "straight") {
      return { ...el, length: Math.max(10, el.length * straightScale) };
    }
    const vRatio = Math.pow(Math.max(0.2, el.radius / median), varietyExp);
    let radius = median * vRatio;
    radius = (radius / sevScale) * techRadius;
    radius = Math.max(params.mode === "realistic" ? 15 : 9, Math.min(700, radius));
    const transition = Math.min(el.transition * flowScale, radius * 2.5);
    return { ...el, radius, transition };
  });
}

// ---------------------------------------------------------------------------
// Pre-closure via straight-length least squares
// ---------------------------------------------------------------------------

/**
 * Adjust straight lengths so the loop nearly closes (keeps the exact
 * curvature-basis closure repair small and well-conditioned).
 */
export function preCloseElements(elements: AlignmentElement[], iterations = 3): AlignmentElement[] {
  const els = elements.map((e) => ({ ...e }));
  for (let iter = 0; iter < iterations; iter++) {
    const profile = kappaFromElements(els, 1.0);
    const curve = integrateKappa(profile.kappa, profile.ds);
    const n = profile.kappa.length;
    const ex = curve.x[n];
    const ey = curve.y[n];
    if (Math.hypot(ex, ey) < 0.5) break;

    const straightIdx: number[] = [];
    const headings: number[] = [];
    let s = 0;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const len = el.type === "straight" ? el.length : cornerLengths(el).total;
      if (el.type === "straight" && el.length > 12) {
        const midS = s + len / 2;
        const idx = Math.min(n - 1, Math.max(0, Math.floor(midS / profile.ds)));
        straightIdx.push(i);
        headings.push(curve.heading[idx]);
      }
      s += len;
    }
    if (straightIdx.length < 2) break;

    let aa00 = 0;
    let aa01 = 0;
    let aa11 = 0;
    for (const h of headings) {
      const cx = Math.cos(h);
      const sy = Math.sin(h);
      aa00 += cx * cx;
      aa01 += cx * sy;
      aa11 += sy * sy;
    }
    const det = aa00 * aa11 - aa01 * aa01;
    if (Math.abs(det) < 1e-6) break;
    const i00 = aa11 / det;
    const i01 = -aa01 / det;
    const i11 = aa00 / det;
    const tx = -(i00 * ex + i01 * ey);
    const ty = -(i01 * ex + i11 * ey);
    for (let k = 0; k < straightIdx.length; k++) {
      const h = headings[k];
      const d = Math.cos(h) * tx + Math.sin(h) * ty;
      const el = els[straightIdx[k]];
      if (el.type === "straight") {
        el.length = Math.max(12, el.length + d * 0.85);
      }
    }
  }
  return els;
}
