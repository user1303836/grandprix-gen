/**
 * Heavy computation jobs, expressed as plain-data in/out so they can run
 * inside a Web Worker or synchronously (tests / fallback).
 */

import { generateValidTrack } from "../core/generator";
import { generateTerrainTrack, scoutSites } from "../core/terrainGen";
import { localToGeo } from "../core/geo";
import { searchCandidates, type Candidate } from "../core/search";
import { breedTracks } from "../core/breed";
import { computeSpeedProfile, VEHICLE_PRESETS, type SpeedProfile, type VehicleSpec } from "../core/vehicle";
import { computeMetrics, type CircuitMetrics } from "../core/metrics";
import { validateTrack, type ValidationReport } from "../core/validate";
import { morphTrack, regenerateStructure } from "../core/morph";
import { TerrainGrid } from "../core/terrain";
import type { SiteRef, Track, TrackParams } from "../core/types";

export interface TerrainGridData {
  frame: { origin: { lat: number; lon: number }; mPerDegLat: number; mPerDegLon: number };
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  elevation: Float32Array;
}

export function gridToData(g: TerrainGrid): TerrainGridData {
  return {
    frame: { origin: g.frame.origin, mPerDegLat: g.frame.mPerDegLat, mPerDegLon: g.frame.mPerDegLon },
    resolution: g.resolution,
    width: g.width,
    height: g.height,
    originX: g.originX,
    originY: g.originY,
    elevation: g.elevation,
  };
}

export function dataToGrid(d: TerrainGridData): TerrainGrid {
  return new TerrainGrid(d.frame, d.resolution, d.width, d.height, d.originX, d.originY, d.elevation);
}

export interface AnalysisOut {
  track: Track;
  metrics: CircuitMetrics;
  profile: SpeedProfile;
  validation: ValidationReport;
}

export function analyze(track: Track, vehicle: VehicleSpec): AnalysisOut {
  const profile = computeSpeedProfile(track, vehicle);
  const metrics = computeMetrics(track, profile);
  const validation = validateTrack(track, track.params);
  for (let i = 0; i < track.samples.length; i++) track.samples[i].speed = profile.v[i];
  return { track, metrics, profile, validation };
}

export interface GenerateJob {
  seed: number;
  params: TrackParams;
  vehicleId: string;
  site?: SiteRef | null;
  terrain?: TerrainGridData | null;
  terrainCandidates?: number;
  onProgress?: (done: number, total: number) => void;
}

export function runGenerate(job: GenerateJob): AnalysisOut | null {
  const vehicle = VEHICLE_PRESETS[job.vehicleId] ?? VEHICLE_PRESETS.gt3;
  if (job.terrain) {
    const grid = dataToGrid(job.terrain);
    const r = generateTerrainTrack(job.seed, job.params, grid, {
      site: job.site ?? undefined,
      candidates: job.terrainCandidates ?? 8,
      onProgress: job.onProgress,
    });
    if (!r.track) return null;
    return analyze(r.track, vehicle);
  }
  const r = generateValidTrack(job.seed, job.params, {}, 12);
  if (!r.track) return null;
  return analyze(r.track, vehicle);
}

export interface SearchJob {
  seed: number;
  params: TrackParams;
  vehicleId: string;
  count: number;
  keep: number;
  site?: SiteRef | null;
  terrain?: TerrainGridData | null;
  onProgress?: (done: number, total: number) => void;
}

export interface SearchOut {
  candidates: Candidate[];
  evaluated: number;
  validCount: number;
}

export function runSearch(job: SearchJob): SearchOut {
  const vehicle = VEHICLE_PRESETS[job.vehicleId] ?? VEHICLE_PRESETS.gt3;
  const terrainOpts = job.terrain
    ? (() => {
        const grid = dataToGrid(job.terrain!);
        return {
          site: job.site ?? null,
          terrain: grid.meta(),
          terrainSampler: (x: number, y: number) => grid.elevationAt(x, y),
          maxFootprintRadius: (Math.min(grid.width, grid.height) * grid.resolution) / 2 * 0.72,
        };
      })()
    : {};
  const result = searchCandidates(job.seed, job.params, {
    vehicle,
    candidates: job.count,
    keep: job.keep,
    onProgress: job.onProgress,
    ...terrainOpts,
  });
  // attach speed to samples for downstream use
  for (const c of result.candidates) {
    const profile = computeSpeedProfile(c.track, vehicle);
    for (let i = 0; i < c.track.samples.length; i++) c.track.samples[i].speed = profile.v[i];
  }
  return result;
}

export interface MorphJob {
  track: Track;
  params: TrackParams;
  vehicleId: string;
  structural: boolean;
  terrain?: TerrainGridData | null;
}

export function runMorph(job: MorphJob): AnalysisOut | null {
  const vehicle = VEHICLE_PRESETS[job.vehicleId] ?? VEHICLE_PRESETS.gt3;
  const terrainOpts = job.terrain
    ? (() => {
        const grid = dataToGrid(job.terrain!);
        return {
          site: job.track.site,
          terrain: grid.meta(),
          terrainSampler: (x: number, y: number) => grid.elevationAt(x, y),
          maxFootprintRadius: (Math.min(grid.width, grid.height) * grid.resolution) / 2 * 0.72,
        };
      })()
    : {};
  const r = job.structural
    ? regenerateStructure(job.track.seed, job.params, terrainOpts)
    : morphTrack(job.track, job.params, terrainOpts);
  if (!r.track) return null;
  return analyze(r.track, vehicle);
}

export interface ScoutJob {
  params: TrackParams;
  terrain: TerrainGridData;
  regionRadiusMeters: number;
  count: number;
}

export interface ScoutOut {
  sites: {
    x: number;
    y: number;
    lat: number;
    lon: number;
    radiusMeters: number;
    relief: number;
    roughness: number;
    meanSlope: number;
    score: number;
    label: string;
  }[];
}

export function runScout(job: ScoutJob): ScoutOut {
  const grid = dataToGrid(job.terrain);
  const found = scoutSites(grid, job.params, job.regionRadiusMeters, job.count);
  return {
    sites: found.map((s) => {
      const geo = localToGeo(grid.frame, s.x, s.y);
      return { ...s, lat: geo.lat, lon: geo.lon };
    }),
  };
}

export interface BreedJob {
  parentA: Track;
  parentB: Track;
  seed: number;
  params: TrackParams;
  vehicleId: string;
  count: number;
  mutation: number;
  terrain?: TerrainGridData | null;
}

export interface BreedOut {
  offspring: Candidate[];
}

export function runBreed(job: BreedJob): BreedOut {
  const vehicle = VEHICLE_PRESETS[job.vehicleId] ?? VEHICLE_PRESETS.gt3;
  const terrainOpts = job.terrain
    ? (() => {
        const grid = dataToGrid(job.terrain!);
        return {
          terrain: grid.meta(),
          terrainSampler: (x: number, y: number) => grid.elevationAt(x, y),
          maxFootprintRadius: (Math.min(grid.width, grid.height) * grid.resolution) / 2 * 0.72,
        };
      })()
    : {};
  const results = breedTracks(job.parentA, job.parentB, job.seed, job.params, {
    count: job.count,
    mutation: job.mutation,
    ...terrainOpts,
  });
  const offspring: Candidate[] = [];
  for (const r of results) {
    if (!r.track) continue;
    const out = analyze(r.track, vehicle);
    if (!out.validation.valid) continue;
    offspring.push({
      track: r.track,
      metrics: out.metrics,
      score: 0,
      vector: [],
      label: "OFFSPRING",
    });
  }
  return { offspring };
}
