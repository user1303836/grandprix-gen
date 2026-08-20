# grandprix-gen

**Procedural racetrack generator / parametric circuit-design sandbox.**

Not a "random squiggly loop" toy — a lightweight experimental circuit-design
tool: deterministic seeds, road-design geometry (clothoid transitions),
character-driven parameters, continuous morphing, a simplified vehicle model,
real-world terrain integration, candidate search, track breeding, and serious
exports (CAD / GIS / Civil 3D / Blender / simulation).

![type](https://img.shields.io/badge/stack-Vite%20%2B%20TypeScript%20%2B%20Three.js%20%2B%20MapLibre-blue)

![2D design view with candidate search](docs/screenshot-2d.png)

![terrain-mode 2D: a circuit threading through a real town, contour lines + OSM buildings](docs/screenshot-terrain-2d.png)

![3D: shadow-mapped terrain with surrounding context, OSM buildings, trees](docs/screenshot-terrain-3d.png)

![onboard drive mode on a mountain circuit](docs/screenshot-terrain-drive.png)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: invariants, determinism, exports, fuzz
npm run build      # typecheck + production build
```

Everything is browser-local. No backend. Terrain DEM comes from
[Mapterhorn](https://mapterhorn.com) (Terrarium tiles, no key); the basemap is
[OpenFreeMap](https://openfreemap.org) via MapLibre GL.

## What you can do

1. **Generate** — a circuit from a seed. Same `seed + params + version` → same track.
2. **Morph** — drag Flow, Technicality, Severity, Compactness, Elevation… and
   watch *the same circuit* deform continuously (morphable vs structural params
   are explicitly distinguished; structural ones re-synthesize from the seed).
3. **Search ×24** — candidate search with rejection + scoring, then *diversity*
   selection: you get a labeled spread (FLOWING / TECHNICAL / FAST / WEIRD /
   EXTREME / BALANCED), not one canonical blob.
4. **Breed** — select two candidates, produce mutated offspring combining their
   structural DNA. Interactive evolutionary search; you are the fitness function.
5. **Analyze** — quasi-static vehicle model (GT3 / Prototype / Formula / Road):
   speed envelope, lap time, braking zones, full-throttle %, plus interpretable
   metrics (flow, technicality, corner diversity, rhythm, overtaking heuristic,
   elevation interest, earthwork…).
6. **Real terrain** — SITE MAP: navigate anywhere (try mountainous Japan),
   place a site, load the Mapterhorn DEM, and generate circuits where terrain
   is a *design constraint*: horizontal layouts are scored by grade-feasible
   earthwork, the vertical profile hugs the ground inside a cut/fill band with
   hard grade limits. OSM building footprints render as context and (soft/hard)
   steer generation around development. **SCOUT REGION** searches a whole
   region for promising sub-sites first (nested site→circuit optimization).
7. **Views** — 2D design view (heat layers: curvature / speed / elevation /
   grade / cut-fill / banking; contour lines; building footprints), 3D view
   (banked ribbon, striped kerbs where the car actually uses them, edge lines,
   carved + shadowed terrain, surrounding context, trees, buildings, water),
   DRIVE mode (onboard lap at the estimated speed profile).
8. **Export** — `.track.json` (lossless project), SVG, CSV, GeoJSON, DXF,
   LandXML (Civil 3D), OBJ, GLB, Blender reconstruction `.py`, OpenDRIVE
   `.xodr`, or everything at once as a zip package.

Keyboard: `g` generate · `1/2/3` views · `⌘Z` undo.

### Heterogeneous circuit model

The ribbon is not homogeneous. Every generated circuit rolls a latent
**identity** (era: classic/hybrid/modern, roughness + width-variation
baselines, runoff/kerb/barrier styles, terrain coupling, naming flavor) and a
set of **localized features** anchored to the structural DNA: banked concrete
bowls (karussell), blind/jump crests, compressions, resurfaced zones, legacy
narrows, wall runs, mixed-surface patches, widened braking zones. Features
alter several properties *simultaneously* -- geometry (banking, width, vertical
profile), surface, roughness, grip, kerbs, runoff, barriers -- and get
generated **place names**, so a lap develops recognizable places instead of
uniform procedural road. Physical properties vary per sample along s:
asymmetric widths, surface kind, roughness, grip, crossfall, kerb kind, runoff
kind + width, barrier distance. The vehicle model reads grip/roughness per
sample; the same circuit laps differently as its surface changes.

## Architecture

```
src/
  core/            UI-free engine (node-testable)
    prng.ts          deterministic mulberry32 + Rng helpers
    types.ts         canonical Track: samples queryable by distance s
    elements.ts      road-design DNA: straights + clothoid corners, morphs
    geometry.ts      curvature integration, closure repair, self-intersection
    build.ts         full pipeline: elements → κ(s) → integrate → deform →
                     resample → corners → vertical → banking → width
    generator.ts     character params → element sequences (corner complexes)
    morph.ts         identity-preserving deformation / structural re-synthesis
    validate.ts      plausibility linting (radius, jerk, intersections, grades)
    vehicle.ts       speed envelope (banking/grade-aware, fwd/bwd passes)
    metrics.ts       interpretable metric vector + request scoring
    search.ts        candidate search + max-min diversity selection
    breed.ts         element crossover + mutation, winding repair
    terrain.ts       TerrainGrid (bilinear, slope), Mapterhorn provider
    terrainGen.ts    terrain-aware candidate scoring + site scouting
    geo.ts           WGS84 ↔ local ENU metric frame, web-mercator tile math
    vertical.ts      vertical design: sinusoids / cut-fill band + grade limit
  engine/          plain-data jobs (generate/search/morph/breed/scout)
  workers/         web worker wrapper (main thread stays responsive)
  export/          json, svg, csv, geojson, dxf, landxml, obj, glb,
                   blender(.py), opendrive(.xodr), zip package, shared mesh
  ui/              vanilla-TS views: 2D canvas, three.js, MapLibre, controls
tests/             vitest: determinism, invariants, exports, fuzz
```

### Canonical representation

The rendered mesh is never the source of truth. A `Track` is:

- structural **DNA**: ordered straights + clothoid corners
  (`radius, angle, dir, transition`) + deform state + generation-time base
- canonical **samples**: uniform arc-length (`s`, x, y, z, heading, κ, bank,
  width, groundZ, speed) — everything else derives from these
- derived: corners, sectors, start/finish, speed profile, metrics

`seed + params + generator version + site` fully reproduces a design.
Morphs transform pristine DNA relative to the base snapshot (no drift).

### How closure works

Element sequences rarely close by construction. Two-stage fix:
least-squares adjustment of straight lengths, then an exact curvature-basis
repair (`c₀ + c₁·sin(2πs/L) + c₂·cos(2πs/L)`) solved on the linearized
3×3 system — residual closure error < 5 cm on a 5 km lap.

### Terrain vertical design

Ground profile → cut/fill band (earthwork params) → periodic grade limiter
(duplicated open-chain + seam correction; converges to the exact max grade)
→ projected relaxation toward ground. The road hugs terrain where grades
allow and does honest earthworks (cut/fill metrics) where the land is
steeper than the road may be.

## Testing philosophy

Procedural geometry begs for invariant testing:

- determinism (same seed → same samples)
- closure, no NaN/Infinity, min radius, curvature continuity
- length tolerance, self-intersection (grid broadphase)
- grade limits (blank + terrain), cut/fill band sanity
- geo frame round-trips, bilinear interpolation
- project JSON lossless round-trip; CSV/SVG/DXF/OpenDRIVE/LandXML sanity
- breeding/search determinism, diversity guarantees
- fuzz: 40 random param/seed combos never produce wild geometry

## Deliberate scope cuts

No accounts, no cloud, no collaboration, no OSM constraint layers yet, no
FIA-compliance claims ("Realistic" is plausibility linting, not certification).

## License

MIT
