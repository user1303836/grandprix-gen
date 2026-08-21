# Procedural circuit worlds (blank-canvas mode)

Design notes for the track-first environment generator.

## Pipeline contrast

- **Site mode (terrain-first):** real DEM → track conforms (`conformToTerrain`) → civil plan → carve.
- **World mode (track-first):** generated track (free vertical identity) →
  relationship plan assigns landscape roles to track spans → synthetic terrain
  synthesized *around* the track → groundZ/corridor/civil/carve/validation run
  against the synthetic surface with the **same** machinery as site mode
  (minus conformance: the road keeps its designed profile; the terrain was
  shaped to meet it).

## Canonical model

`WorldPlan` (src/core/world/): deterministic in `(track geometry, envSeed,
envParams, version)`. Holds identity, relationship spans, the local-metric
heightfield (a `TerrainSurface` with `geographic: false` — never fake
lat/lon), moisture field, boundary ring + treatment, water bodies, vegetation
placements, hero landmarks. Three.js meshes are derived, never canonical.

## Terrain synthesis

Macro field (domain-warped fBm shaped by landform) + sparse corridor
constraints from relationship spans, blended by an iterative relaxation
solver. Multi-level sections: when constraints conflict in z at a cell, the
lowest cluster wins (ground belongs to the lower road, never pulled up
through a bridge deck). Corridor protection: within the bench width, ground
never exceeds road level except on deliberate cut/tunnel roles.

## Civil coordination

Ravine/river roles dig terrain beneath the road; the unmodified civil
planner then sees deep fill and plans bridges/viaducts — environmental set
pieces emerge from the terrain rather than being scripted onto it.
