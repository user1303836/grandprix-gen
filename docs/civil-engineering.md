# Civil engineering: diagnosis of the extreme-terrain failure mode

*Why a circuit placed on Mt. Fuji–class terrain turned into a roller coaster:
hundreds of identical slender piers under a narrow deck.*

## The chain of decisions that produced it

1. **Vertical design constraint priority.** `conformToTerrain()`
   (`src/core/vertical.ts`) treats the *floor* (`z >= ground - maxCut`) and
   the *grade limit* as hard constraints, and the fill ceiling as a soft
   preference. On steep terrain the grade-limited profile climbs ridges at
   exactly max grade; descending into the next valley at max grade takes
   longer than the valley width, so the profile "flies" the valley. With no
   hard ceiling, deviations of +50..+200 m are possible. That is the correct
   *physics* — the failure is what the downstream systems did with it.

2. **Centerline-only classification.** `classifyStructures()`
   (`src/core/structures.ts`) computed a single scalar per station,
   `z_centerline - ground_centerline`, and thresholded it:
   fill > 4.2 m → `bridge`, cut > 9 m → `tunnel`, etc. On a steep hillside a
   road benched into the slope (cut uphill, fill downhill — the classic
   mountain-road platform) shows ~0 deviation at the centerline or moderate
   fill — but the *cross-section* is what matters and it was never measured.
   There was no concept of "platform", "bench", "retained fill", or "shelf".

3. **One bridge kind, one pier plan.** The single `bridge` kind rendered as a
   deck with identical 2.6 × 1.6 m piers every 32 m (`structuresMesh.ts`),
   irrespective of height, span length, curvature, or what lies *below*
   (including other parts of the same circuit — supports were placed with no
   track-over-track clearance check). No abutments, no span variation, no
   hammerheads, no platforms.

4. **Runoff vanished on decks.** The mesh builder narrowed runoff to a 1.1 m
   concrete pad on every bridge/tunnel sample — no shoulders, no parapets —
   so elevated corners read as bare ribbon.

5. **Clearance was centerline-only.** The no-clipping guarantee sampled the
   road centerline; the banked edges and the runoff were never validated
   against terrain, so edges and shoulders could clip into cut slopes.

## The fix (this refactor)

- A canonical **corridor cross-section** (`src/core/corridor.ts`):
  `corridorSurface(s, lateralOffset) -> { z, band }` used by terrain
  analysis, carving, structure planning, mesh generation, exports, and
  validation. Road, kerbs, runoff, and outer platform are related but
  distinct surfaces (runoff has its own cross-slope and does not continue
  the road banking indefinitely).
- **Corridor-wide terrain analysis**: ground sampled at several lateral
  offsets; per-station max cut/fill, cross-sectional area, cross-slope,
  asymmetry, required platform width; earthwork volume integrated along s.
- A **structure planner** (dynamic programming over span states) instead of
  threshold classification: at-grade, open cut, cut-and-fill bench,
  embankment, terraced embankment, retaining wall, dual retaining platform,
  broad concrete platform, hillside shelf, short bridge, viaduct, tunnel,
  gallery — chosen by local cost + transition cost + civil-style preference
  + budget, with minimum span lengths and coherent transitions.
- A **latent civil identity** per circuit (terrain-following / heritage
  mountain road / mountain club / modern permanent / viaduct heavy /
  megaproject) plus a small set of user controls. Deterministic by seed.
- **Feasibility is a real outcome**: Realistic mode caps pier height,
  elevated fraction, earthwork volume, tunnel fraction; the civil cost feeds
  the horizontal candidate search so alignments reroute around contours;
  total infeasibility rejects the candidate with a clear message instead of
  silently building a roller coaster. Megaproject mode keeps the fantasy
  available intentionally.
- **Planned support layout**: variable spans, terrain-aware footings,
  abutments, tapered piers, hammerhead caps, box-girder decks, portal bents
  or longer spans where a lower corridor passes beneath; a pier never
  penetrates another corridor's clearance envelope.
- **Runoff as a safety envelope**: asymmetric, speed- and corner-aware,
  extended at braking zones, shrunk on heritage sections, replaced by
  shoulders + parapets on elevated structures — and seated on its own
  platform/earthworks.
- **Corridor-level validation**: the finished corridor surface (not the
  centerline) is checked against terrain; supports are checked against
  corridors; violations trigger repair/replan/reject — never hidden with
  z-offsets.
- **Debug views**: structure-kind coloring, cut/fill shading, clipping
  points in red, and a station inspector with the cross-section and the
  planner's reasoning.
