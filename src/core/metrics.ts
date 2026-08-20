/**
 * Interpretable circuit metrics. Deliberately NOT a single "fun score" --
 * a vector of explainable measurements the UI and search can reason about.
 */

import type { Track, TrackParams } from "./types";
import type { SpeedProfile } from "./vehicle";

export interface CircuitMetrics {
  // headline
  lapTime: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  minSpeedKmh: number;
  fullThrottlePct: number;

  // geometry
  lengthKm: number;
  cornerCount: number;
  leftCorners: number;
  rightCorners: number;
  minCornerRadius: number;
  straightProportion: number;
  directionBalance: number; // 0..100, 100 = perfectly balanced

  // character scores 0..100
  flow: number;
  technicality: number;
  cornerDiversity: number;
  speedDiversity: number;
  rhythmicComplexity: number;
  highSpeedCornerProportion: number; // 0..100
  overtakingPotential: number;
  elevationInterest: number;

  // braking
  brakingZoneCount: number;
  heavyBrakingZones: number;
  speedVariance: number;

  // vertical
  elevationRange: number;
  maxGradePct: number;
  meanAbsCutFill: number; // 0 in blank-canvas mode
  maxCut: number;
  maxFill: number;
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Entropy of a histogram, normalized to 0..1. */
function normEntropy(bins: number[]): number {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const b of bins) {
    if (b === 0) continue;
    const p = b / total;
    h -= p * Math.log(p);
  }
  const maxH = Math.log(bins.length);
  return maxH > 0 ? h / maxH : 0;
}

export function computeMetrics(track: Track, speed: SpeedProfile): CircuitMetrics {
  const n = track.samples.length;
  const ds = track.ds;
  const L = track.length;

  // straights
  let straightLen = 0;
  for (const s of track.samples) {
    if (Math.abs(s.kappa) < 1 / 500) straightLen += ds;
  }
  const straightProportion = straightLen / L;

  // corner stats
  const corners = track.corners;
  const left = corners.filter((c) => c.direction === "L");
  const right = corners.filter((c) => c.direction === "R");
  const turnL = left.reduce((a, c) => a + c.angle, 0);
  const turnR = right.reduce((a, c) => a + c.angle, 0);
  const directionBalance = clamp100(
    100 * (1 - Math.abs(turnL - turnR) / Math.max(0.01, turnL + turnR)),
  );

  // apex speeds
  const apexV = corners.map((c) => {
    const idx = Math.min(n - 1, Math.max(0, Math.round(c.sApex / ds)));
    return speed.v[idx];
  });
  const vMaxLap = speed.vMax;

  // flow: high mean speed + low relative variance
  const vMean = speed.vAvg;
  let vVar = 0;
  for (let i = 0; i < n; i++) vVar += (speed.v[i] - vMean) ** 2;
  vVar /= n;
  const vStd = Math.sqrt(vVar);
  const cv = vStd / Math.max(1, vMean);
  const flow = clamp100(100 * (1 - cv * 2.1));

  // technicality
  const slowCornerFrac =
    corners.length > 0
      ? corners.filter((_, i) => apexV[i] < 0.45 * vMaxLap).length / corners.length
      : 0;
  const cornerDensity = corners.length / (L / 1000);
  const grossTurning = track.samples.reduce((a, s) => a + Math.abs(s.kappa) * ds, 0);
  const dirChangeRate = grossTurning / (2 * Math.PI) / 3;
  const technicality = clamp100(
    100 * (0.45 * slowCornerFrac + 0.3 * Math.min(1, cornerDensity / 3) + 0.25 * Math.min(1, dirChangeRate)),
  );

  // corner diversity: entropy over log-radius buckets x angle buckets
  const radiusBins = new Array(6).fill(0);
  const angleBins = new Array(5).fill(0);
  for (const c of corners) {
    const rb = Math.max(0, Math.min(5, Math.floor(Math.log2(Math.max(10, c.minRadius) / 10))));
    radiusBins[rb]++;
    const ab = Math.max(0, Math.min(4, Math.floor((c.angle / Math.PI) * 5)));
    angleBins[ab]++;
  }
  const cornerDiversity = clamp100(100 * (0.6 * normEntropy(radiusBins) + 0.4 * normEntropy(angleBins)));

  // speed diversity: entropy of apex speed buckets
  const speedBins = new Array(6).fill(0);
  for (const v of apexV) {
    const b = Math.max(0, Math.min(5, Math.floor((v / Math.max(1, vMaxLap)) * 6)));
    speedBins[b]++;
  }
  const speedDiversity = clamp100(100 * normEntropy(speedBins));

  // rhythmic complexity: direction alternations + spacing irregularity
  let alternations = 0;
  for (let i = 1; i < corners.length; i++) {
    if (corners[i].direction !== corners[i - 1].direction) alternations++;
  }
  const gaps: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    gaps.push(((b.sStart - a.sEnd) % L + L) % L);
  }
  const gapMean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const gapVar = gaps.reduce((a, g) => a + (g - gapMean) ** 2, 0) / Math.max(1, gaps.length);
  const gapCV = Math.sqrt(gapVar) / Math.max(1, gapMean);
  const rhythmicComplexity = clamp100(
    100 * (0.55 * (corners.length > 1 ? alternations / (corners.length - 1) : 0) + 0.45 * Math.min(1, gapCV)),
  );

  const highSpeedCornerProportion = clamp100(
    100 *
      (corners.length > 0
        ? corners.filter((_, i) => apexV[i] > 0.75 * vMaxLap).length / corners.length
        : 0),
  );

  // overtaking: heavy braking after a long fast approach
  let overtakes = 0;
  for (const z of speed.brakingZones) {
    if (z.vEntry > 0.8 * vMaxLap && z.vMin < 0.55 * z.vEntry && z.severity > 6) {
      overtakes++;
    }
  }
  const overtakingPotential = clamp100(overtakes * 22 + (straightProportion > 0.3 ? 12 : 0));

  // elevation
  let zMin = Infinity;
  let zMax = -Infinity;
  let gMax = 0;
  for (let i = 0; i < n; i++) {
    const z = track.samples[i].z;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    const g = Math.abs(track.samples[(i + 1) % n].z - z) / ds;
    if (g > gMax) gMax = g;
  }
  const zRange = zMax - zMin;
  const elevationInterest = clamp100(100 * (zRange / ((L / 1000) * 14)));

  // earthwork
  let cutFillSum = 0;
  let maxCut = 0;
  let maxFill = 0;
  if (track.terrain) {
    for (const s of track.samples) {
      const d = s.z - s.groundZ;
      cutFillSum += Math.abs(d);
      if (d < -maxCut) maxCut = -d;
      if (d > maxFill) maxFill = d;
    }
  }

  const heavyBraking = speed.brakingZones.filter((z) => z.severity > 8).length;

  return {
    lapTime: speed.lapTime,
    avgSpeedKmh: speed.vAvg * 3.6,
    maxSpeedKmh: speed.vMax * 3.6,
    minSpeedKmh: speed.vMin * 3.6,
    fullThrottlePct: speed.fullThrottle * 100,

    lengthKm: L / 1000,
    cornerCount: corners.length,
    leftCorners: left.length,
    rightCorners: right.length,
    minCornerRadius: corners.reduce((a, c) => Math.min(a, c.minRadius), Infinity),
    straightProportion,
    directionBalance,

    flow,
    technicality,
    cornerDiversity,
    speedDiversity,
    rhythmicComplexity,
    highSpeedCornerProportion,
    overtakingPotential,
    elevationInterest,

    brakingZoneCount: speed.brakingZones.length,
    heavyBrakingZones: heavyBraking,
    speedVariance: vStd,

    elevationRange: zRange,
    maxGradePct: gMax * 100,
    meanAbsCutFill: cutFillSum / Math.max(1, n),
    maxCut,
    maxFill,
  };
}

// ---------------------------------------------------------------------------
// Objective scoring for search: how well does a track match the REQUEST?
// ---------------------------------------------------------------------------

/** Weighted match between requested character params and measured metrics. */
export function scoreAgainstRequest(m: CircuitMetrics, p: TrackParams): number {
  const dFlow = (m.flow - p.flow * 100) / 100;
  const dTech = (m.technicality - p.technicality * 100) / 100;
  const dVariety = (m.cornerDiversity - (0.35 + p.cornerVariety * 0.65) * 100) / 100;
  const dElevation = (m.elevationInterest - p.elevationIntensity * 100) / 100;
  const dStraights =
    (m.straightProportion * 100 - (0.15 + p.longStraightBias * 0.55) * 100) / 100;
  const dCorners = (m.cornerCount - p.cornerCount) / Math.max(4, p.cornerCount);

  let score = 100;
  score -= 42 * dFlow * dFlow;
  score -= 42 * dTech * dTech;
  score -= 16 * dVariety * dVariety;
  score -= 18 * dElevation * dElevation;
  score -= 14 * dStraights * dStraights;
  score -= 30 * dCorners * dCorners;
  // small bonuses for universally nice properties
  score += Math.min(6, m.directionBalance * 0.04);
  score += Math.min(4, m.overtakingPotential * 0.03);
  return score;
}

/** Metric vector for diversity comparison (normalized 0..1). */
export function metricVector(m: CircuitMetrics): number[] {
  return [
    m.flow / 100,
    m.technicality / 100,
    m.cornerDiversity / 100,
    m.speedDiversity / 100,
    m.rhythmicComplexity / 100,
    m.highSpeedCornerProportion / 100,
    m.overtakingPotential / 100,
    m.elevationInterest / 100,
    m.straightProportion,
    Math.min(1, m.avgSpeedKmh / 260),
  ];
}

export function metricDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  return Math.sqrt(d);
}
