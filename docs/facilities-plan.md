# Procedural Circuit Facilities — working plan

Branch: `feat/procedural-circuit-facilities`

Phases (commit per phase):

0. Inspect current pit/furniture/car implementation; build the real-world
   reference catalog (`docs/facilities-reference-catalog.md` +
   `src/data/facilityArchetypes.ts`); document model-local axes.
1. Vehicle orientation: shared `RoadFrame` (3D tangent/pitch/bank/normal),
   quaternion-based car orientation, spray/headlight/camera reuse, tests.
2. Canonical facility planning: identity, independent facility seed,
   pit-straight site selection + side scoring, reservations, validation.
3. Real pit-lane alignment: entry/decel/working/fast-lane/box-apron/exit
   bands, pit wall, markings, grade/crossfall profile.
4. Architecture grammar: garage modules, upper floors, hospitality,
   control tower, roof/canopy systems, screens; 7 archetypes.
5. Foundations: footprint terrain sampling, datum selection, slabs /
   stepped plinths / terraces / podiums / piles; clearings export.
6. Grandstands: archetypes, explicit front-axis orientation, sightline
   scoring, terrain-aware foundations, debug arrows.
7. Night treatment: emissive anchors, pooled real lights, screens.
8. Exports (GLB/OBJ/Blender/package), debug layers, screenshot seeds,
   full test suite + production build.

See `docs/facilities-reference-catalog.md` for the research basis.
