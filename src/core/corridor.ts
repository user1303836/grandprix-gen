/**
 * The canonical corridor cross-section.
 *
 * Every system that needs to know "what is the designed surface at this
 * point next to the road" asks this module: terrain analysis, terrain
 * carving, structure planning, mesh generation, barriers, exports, and
 * validation all share ONE cross-section description instead of private
 * approximations.
 *
 * Geometry convention: offsets are signed meters perpendicular to the
 * centerline, positive to the LEFT (in the direction of travel). Bands:
 *
 *   platformL | runoffL | kerbL | [ roadL | roadR ] | kerbR | runoffR | platformR
 *
 * The road crown follows the banked profile. Kerbs sit a few cm proud.
 * Runoff continues outward with its OWN capped cross-slope (it does not
 * follow steep banking into the scenery). The platform is the structural
 * bench/podium foundation limit, sloping gently away.
 */

import type { Track } from "./types";

export type CorridorBand =
  | "outside"
  | "platform_l"
  | "platform_r"
  | "runoff_l"
  | "runoff_r"
  | "kerb_l"
  | "kerb_r"
  | "road";

export interface CorridorSample {
  /** Design surface elevation at this offset (bank applied). */
  z: number;
  band: CorridorBand;
}

/** Kerb physical width/lift per kind (mirrors mesh.ts). */
const KERB_WIDTH = [0, 0.7, 1.3, 1.7, 1.0, 0.9, 1.2]; // none, flat, standard, aggressive, sausage, oldlow, high
const KERB_LIFT = [0, 0.006, 0.05, 0.13, 0.16, 0.02, 0.11];

/** Maximum runoff cross-slope (drainage ~3%). */
const RUNOFF_MAX_SLOPE = 0.032;
/** Platform slopes gently down away from the corridor. */
const PLATFORM_SLOPE = 0.04;
/** Platform width beyond the runoff edge. */
export const PLATFORM_EXTRA = 2.6;

export interface CorridorStation {
  halfL: number; // road half width left
  halfR: number;
  kerbWL: number;
  kerbWR: number;
  kerbLiftL: number;
  kerbLiftR: number;
  runWL: number; // runoff width
  runWR: number;
  runSlopeL: number; // signed: + falls to the left
  runSlopeR: number;
  /** outer platform limit (half width of the full engineered corridor) */
  platL: number;
  platR: number;
}

/**
 * The corridor: per-station cross-section anchors + the surface query.
 * Build once per track build (props must be final).
 */
export class Corridor {
  readonly stations: CorridorStation[];
  readonly ds: number;
  readonly length: number;

  constructor(readonly track: Track) {
    const n = track.samples.length;
    this.ds = track.ds;
    this.length = track.length;
    this.stations = new Array(n);
    const props = track.props;
    for (let i = 0; i < n; i++) {
      const smp = track.samples[i];
      const kL = props.kerbL[i];
      const kR = props.kerbR[i];
      const kerbWL = KERB_WIDTH[kL] || 0;
      const kerbWR = KERB_WIDTH[kR] || 0;
      const halfL = props.widthL[i];
      const halfR = props.widthR[i];
      const runWL = props.runoffWidthL[i];
      const runWR = props.runoffWidthR[i];
      // runoff slope: follow the bank but cap it; always drain away from the road
      const bankSlope = Math.tan(smp.bank);
      const runSlopeL = clampSlope(bankSlope);
      const runSlopeR = clampSlope(bankSlope);
      this.stations[i] = {
        halfL,
        halfR,
        kerbWL,
        kerbWR,
        kerbLiftL: KERB_LIFT[kL] || 0,
        kerbLiftR: KERB_LIFT[kR] || 0,
        runWL,
        runWR,
        runSlopeL,
        runSlopeR,
        platL: halfL + kerbWL + runWL + PLATFORM_EXTRA,
        platR: halfR + kerbWR + runWR + PLATFORM_EXTRA,
      };
    }
  }

  private iAt(s: number): number {
    const n = this.stations.length;
    return ((Math.round(s / this.ds) % n) + n) % n;
  }

  /** The surface query: designed elevation + band at (s, lateralOffset). */
  surface(s: number, off: number): CorridorSample {
    const st = this.stations[this.iAt(s)];
    const smp = this.track.samples[this.iAt(s)];
    const z0 = smp.z;
    const bankSlope = Math.tan(smp.bank);
    const a = Math.abs(off);
    const sgn = off >= 0 ? 1 : -1;
    const half = sgn > 0 ? st.halfL : st.halfR;
    const kerbW = sgn > 0 ? st.kerbWL : st.kerbWR;
    const runW = sgn > 0 ? st.runWL : st.runWR;
    const runSlope = sgn > 0 ? st.runSlopeL : st.runSlopeR;

    if (a <= half) {
      // road crown: bank applies across the road
      return { z: z0 - off * bankSlope, band: "road" };
    }
    const zEdge = z0 - sgn * half * bankSlope;
    if (a <= half + kerbW) {
      const lift = sgn > 0 ? st.kerbLiftL : st.kerbLiftR;
      return { z: zEdge + lift, band: sgn > 0 ? "kerb_l" : "kerb_r" };
    }
    const zKerb = zEdge + (sgn > 0 ? st.kerbLiftL : st.kerbLiftR);
    const dRun = a - half - kerbW;
    if (dRun <= runW) {
      // runoff continues along the bank direction, capped at drainage slope
      return { z: zKerb - sgn * dRun * runSlope, band: sgn > 0 ? "runoff_l" : "runoff_r" };
    }
    const zRun = zKerb - sgn * runW * runSlope;
    const platLimit = sgn > 0 ? st.platL : st.platR;
    // platform falls gently AWAY on both sides (d grows outward)
    const dPlat = a - half - kerbW - runW;
    if (a <= platLimit) {
      return { z: zRun - dPlat * PLATFORM_SLOPE, band: sgn > 0 ? "platform_l" : "platform_r" };
    }
    return { z: zRun - (platLimit - half - kerbW - runW) * PLATFORM_SLOPE, band: "outside" };
  }

  /** Full engineered half-width at station i (platform limit). */
  platformHalf(i: number): { l: number; r: number } {
    const st = this.stations[i];
    return { l: st.platL, r: st.platR };
  }
}

function clampSlope(bankSlope: number): number {
  return Math.max(-RUNOFF_MAX_SLOPE, Math.min(RUNOFF_MAX_SLOPE, bankSlope));
}
