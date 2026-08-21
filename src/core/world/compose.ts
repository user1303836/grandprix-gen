/**
 * World composer: the deterministic orchestrator.
 *   identity → relationship spans → macro+constraint terrain synthesis →
 *   hydrology (carves the grid) → boundary → vegetation → landmarks.
 */

import type { Corner, TrackSample } from "../types";
import type { TrackFeature } from "../character";
import type { TerrainSurface } from "../terrain";
import { rollEnvironmentIdentity } from "./identity";
import { planRelationships } from "./relationships";
import { synthesizeTerrain } from "./synthesis";
import { planHydrology } from "./hydrology";
import { planBoundary } from "./boundary";
import { planVegetation } from "./vegetation";
import { planLandmarks } from "./landmarks";
import type { EnvironmentParams, WorldPlan } from "./types";

export interface ComposeInput {
  samples: TrackSample[];
  corners: Corner[];
  features: TrackFeature[];
  ds: number;
  length: number;
  envSeed: number;
  envParams: EnvironmentParams;
}

export interface ComposeResult {
  plan: WorldPlan;
  surface: TerrainSurface;
}

export function composeWorld(input: ComposeInput): ComposeResult {
  const { samples, corners, features, ds, length, envSeed, envParams } = input;

  const identity = rollEnvironmentIdentity(envSeed, envParams);
  const spans = planRelationships({ samples, corners, features, ds, length, identity, params: envParams, envSeed });

  const { surface, moisture } = synthesizeTerrain(samples, spans, ds, length, identity, envParams, envSeed);

  // hydrology mutates the elevation grid (channel/bowl carving)
  const elev = (surface as unknown as { elevation: Float32Array }).elevation;
  const { water } = planHydrology(surface, elev, moisture, samples, spans, length, identity, envParams, envSeed);

  const boundary = planBoundary(samples, surface, identity, envParams.boundary, envSeed);

  const vegetation = planVegetation(surface, moisture, samples, spans, length, ds, identity, envParams, envSeed, water);

  const landmarks = planLandmarks(samples, corners, spans, ds, length, surface, identity, envParams, water, envSeed);

  const plan: WorldPlan = {
    version: 1,
    envSeed,
    envParams: { ...envParams },
    identity,
    spans,
    grid: {
      originX: surface.originX,
      originY: surface.originY,
      resolution: surface.resolution,
      width: surface.width,
      height: surface.height,
      minElevation: surface.minElevation,
      maxElevation: surface.maxElevation,
      elevation: elev,
      moisture,
    },
    boundary,
    water,
    vegetation,
    landmarks,
  };

  return { plan, surface };
}
