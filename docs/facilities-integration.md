# Facilities integration note

For the concurrent landscape-generator branch: what this branch adds, what
to consume, and where merge friction is expected.

## New modules

```
src/data/facilityArchetypes.ts   8 archetype parameter distributions (prior)
src/core/facilities/
  types.ts                       canonical FacilityPlan + controls + GroundSurface
  identity.ts                    facility DNA (auto-styled by circuit era)
  siteSelection.ts               straight-window scan + side/land/structure scoring,
                                 shrink-to-at-grade, rejection reasons
  pitLane.ts                     real pit alignment: entry/decel/working/exit/accel,
                                 lane bands, pit wall, boxes, markings, own grade
  pitComplex.ts                  architecture grammar: segmented garage block,
                                 bays, upper floors, tower, hospitality, canopy,
                                 paddock, service road
  grandstands.ts                 stand archetypes, explicit front/long axes,
                                 sightline scoring, placement
  foundations.ts                 footprint stats, datum, foundation kinds,
                                 cut-and-fill pads (makeFacilityCarve)
  lighting.ts                    emissive anchors + bounded real-light pool
  plan.ts                        orchestrator → FacilityPlan (deterministic)
src/core/roadFrame.ts            shared 3D road frame (tangent/normal/lateral)
                                 used by cars, cameras, spray, headlights
src/ui/facilities3d.ts           Three.js rendering of the plan (not source of truth)
src/export/facilityMesh.ts       export parts (GLB/OBJ/Blender/package)
tests/facilities.test.ts         12 tests · tests/roadframe.test.ts  8 tests
docs/facilities-reference-catalog.md   34-circuit research corpus + sources
```

## Shared interfaces (merge contract)

- **`track.facilities?: FacilityPlan | null`** — optional field on Track.
  Plain JSON data (no typed arrays, no functions); serialized inside
  project files automatically. Loading an old project without it is fine.
- **`GroundSurface`** (`facilities/types.ts`) — the narrow terrain
  abstraction: `elevationAt(x,y) → number | null`, optional `slopeAt`.
  The landscape generator can hand us any world (DEM, synthetic, flat)
  through this. **Please implement `elevationAt` against your final carved
  surface** so foundation stats match what you render.
- **Stage-A reservation** — `FacilityPlan.reservation`:
  `developedPolygons` (no trees/rocks/landmarks), `vegetationExclusionPolygons`,
  `preferredElevationBands`, `requiredAccessCorridors`. **Wired** as of the
  merge: `buildVegetation` in `src/ui/worldMeshes.ts` filters world trees
  against `vegetationExclusionPolygons`. World planners should ALSO consume
  the polygons during placement (cheaper than filtering instances).
- **Stage-B pads** — `makeFacilityCarve(base, foundations)` returns a
  GroundSurface where every foundation footprint is flattened to its datum
  (9 m blend). Apply it over your carved surface so buildings sit on ground.
- **roadFrameAt(track, s)** — use it for anything that must align with the
  road (props, signs, vehicles). Never Euler-guess from `heading` alone.

## Expected merge points (low conflict risk)

- `src/core/types.ts` — one optional field added (`facilities`).
- `src/ui/view3d.ts` — facility meshes appended in `buildTrackGroup`;
  car/camera orientation switched to roadFrame (touches the drive loop).
- `src/export/{glb,obj,blender}.ts` — one array-spread line each.
- `src/export/structuresMesh.ts`, `src/ui/furniture.ts` — legacy pit lane /
  garage boxes / grandstand wedges are skipped when `track.facilities` has
  content (delete those code paths once this lands).
- `src/ui/state.ts`, `sidebar.ts`, `app.ts` — facility controls + re-plan
  wiring (independent facility seed; regenerating never rebuilds the track).

## Coexistence notes

- Facility planning runs in the main thread (ms, not worker); re-planning
  on facility-seed change does not touch the track or the landscape.
- If the landscape generator later owns vegetation inside
  `reservation.vegetationExclusionPolygons`, remove it there; sparse
  ornamental rows around the complex are welcome.
- `track.facilities === undefined` must stay valid everywhere (old saves,
  in-flight worker results).
