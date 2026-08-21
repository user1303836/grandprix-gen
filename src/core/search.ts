/**
 * Candidate search: generate many, reject invalid, score, and select a
 * DIVERSE set of strong solutions rather than one canonical optimum.
 */

import { generateValidTrack } from "./generator";
import { computeMetrics, metricDistance, metricVector, scoreAgainstRequest, type CircuitMetrics } from "./metrics";
import { computeSpeedProfile, type VehicleSpec, VEHICLE_PRESETS } from "./vehicle";
import { Rng, saltSeed } from "./prng";
import type { BuildOptions } from "./build";
import type { Track, TrackParams } from "./types";

export interface Candidate {
  track: Track;
  metrics: CircuitMetrics;
  score: number;
  vector: number[];
  label: string;
}

export interface SearchOptions extends BuildOptions {
  vehicle?: VehicleSpec;
  candidates?: number;
  keep?: number;
  /** Extra per-candidate cost (e.g. terrain fit) subtracted from score. */
  candidateCost?: (track: Track) => number;
  costWeight?: number;
  onProgress?: (done: number, total: number) => void;
  /** When set (site mode), candidates relocate within +-this radius. */
  siteHalfSpan?: number;
}

export interface SearchResult {
  candidates: Candidate[];
  evaluated: number;
  validCount: number;
}

/**
 * Run a candidate search. Deterministic in (seed, params, vehicle).
 */
export function searchCandidates(
  seed: number,
  params: TrackParams,
  opts: SearchOptions = {},
): SearchResult {
  const vehicle = opts.vehicle ?? VEHICLE_PRESETS.gt3;
  const total = opts.candidates ?? 24;
  const keep = opts.keep ?? 6;

  const valid: Candidate[] = [];
  let evaluated = 0;
  const placeRng = Rng.fromSalt(seed, 5519);
  for (let i = 0; i < total; i++) {
    const sub = saltSeed(seed, 501 + i * 37);
    let genOpts: SearchOptions = opts;
    if (opts.siteHalfSpan && opts.terrainSampler) {
      const ang = placeRng.range(0, Math.PI * 2);
      const rad = i === 0 ? 0 : placeRng.range(0, opts.siteHalfSpan * 0.3);
      genOpts = {
        ...opts,
        maxFootprintRadius: Math.max(opts.siteHalfSpan * 0.3, opts.siteHalfSpan * 0.9 - rad),
        centerOffset: { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad },
      };
    }
    const r = generateValidTrack(sub, params, genOpts, 6);
    evaluated++;
    opts.onProgress?.(i + 1, total);
    if (!r.track) continue;
    const profile = computeSpeedProfile(r.track, vehicle);
    const metrics = computeMetrics(r.track, profile);
    let score = scoreAgainstRequest(metrics, params);
    if (opts.candidateCost) {
      score -= (opts.costWeight ?? 6) * opts.candidateCost(r.track);
    }
    valid.push({
      track: r.track,
      metrics,
      score,
      vector: metricVector(metrics),
      label: "",
    });
  }

  // sort by score, then greedy max-min diversity selection
  valid.sort((a, b) => b.score - a.score);
  const pool = valid.slice(0, Math.max(keep * 3, keep));
  const selected: Candidate[] = [];
  if (pool.length > 0) selected.push(pool[0]);
  while (selected.length < Math.min(keep, pool.length)) {
    let best: Candidate | null = null;
    let bestD = -1;
    for (const c of pool) {
      if (selected.includes(c)) continue;
      let minD = Infinity;
      for (const s of selected) {
        const d = metricDistance(c.vector, s.vector);
        if (d < minD) minD = d;
      }
      // blend diversity with score so we don't select junk
      const combined = minD * 60 + c.score;
      if (combined > bestD) {
        bestD = combined;
        best = c;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  assignLabels(selected);
  return { candidates: selected, evaluated, validCount: valid.length };
}

/** Assign character labels (FLOWING / TECHNICAL / FAST / ...). */
function assignLabels(cands: Candidate[]): void {
  const remaining = new Set(cands);
  const take = (
    label: string,
    key: (m: CircuitMetrics) => number,
  ): void => {
    let best: Candidate | null = null;
    let bestV = -Infinity;
    for (const c of remaining) {
      const v = key(c.metrics);
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best) {
      best.label = label;
      remaining.delete(best);
    }
  };
  take("FLOWING", (m) => m.flow);
  take("TECHNICAL", (m) => m.technicality);
  take("FAST", (m) => m.avgSpeedKmh);
  take("EXTREME", (m) => m.elevationInterest + m.speedDiversity * 0.4);
  take("WEIRD", (m) => 100 - m.directionBalance + m.rhythmicComplexity * 0.5);
  for (const c of remaining) c.label = "BALANCED";
}
