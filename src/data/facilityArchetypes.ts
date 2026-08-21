/**
 * Facility archetypes — the machine-readable prior distilled from
 * docs/facilities-reference-catalog.md (34 real circuits).
 *
 * Each archetype is a parameter DISTRIBUTION, not a building: the
 * generator samples inside these envelopes under a coherent facility DNA.
 * Numbers without a doc citation are estimates (see the catalog).
 */

export type FacilityClass =
  | "club"
  | "regional"
  | "national"
  | "international"
  | "endurance"
  | "temporary-street";

export type ArchitectureStyle =
  | "historic-low-rise"
  | "utilitarian"
  | "modern-linear"
  | "monumental"
  | "desert-canopy"
  | "temporary-modular"
  | "private-club"
  | "experimental";

export type RoofKind =
  | "none"
  | "flat"
  | "shallow-pitch"
  | "cantilever"
  | "tensile-canopy"
  | "wave"
  | "fabric";

export type GrandstandKind =
  | "temporary-bleacher"
  | "uncovered-terrace"
  | "covered-linear"
  | "multi-tier"
  | "cantilever-roof"
  | "tensile-canopy"
  | "hillside"
  | "corner-bowl"
  | "vip-suite"
  | "club-deck";

/** Pit-lane lateral band widths (m), track → building. */
export interface PitLaneBands {
  /** separation between racing edge and pit wall (grass/paint strip) */
  verge: number;
  pitWall: number;
  fastLane: number; // FIA: ≤ 3.5 m
  workingLane: number; // FIA: pit lane ≥ 12 m total minus fast lane
  boxApron: number; // painted pit boxes band
  garageApron: number; // apron in front of the garage doors
}

export interface Archetype {
  id: ArchitectureStyle;
  classes: FacilityClass[];
  permanence: "permanent" | "temporary" | "hybrid";
  /** typical garage count range (bays) */
  garages: [number, number];
  /** floors above the garage level (0 = garages only) */
  upperFloors: [number, number];
  /** garage bay frontage (m); the 6–8 m rhythm from the catalog */
  bayWidth: [number, number];
  /** building depth (m) */
  depth: [number, number];
  bands: PitLaneBands;
  roof: RoofKind;
  canopyOverApron: boolean;
  balcony: "none" | "some" | "continuous";
  controlTower: "none" | "small" | "prominent" | "landmark";
  screens: [number, number];
  /** typical grandstand kinds + how many */
  stands: { kinds: GrandstandKind[]; count: [number, number]; rows: [number, number] };
  /** total spectator capacity prior */
  capacity: [number, number];
  /** night-readiness: 0 sparse practicals → 1 full floodlit */
  nightLighting: [number, number];
  /** crowd density default */
  crowd: [number, number];
  /** which real circuits ground this archetype */
  groundedIn: string[];
}

/** FIA-documented dimensional floor (Appendix O / F1 sporting regs). */
export const PIT_LANE_MIN_WIDTH = 12;
export const FAST_LANE_MAX_WIDTH = 3.5;

export const ARCHETYPES: Archetype[] = [
  {
    id: "historic-low-rise",
    classes: ["club", "regional", "national"],
    permanence: "permanent",
    garages: [10, 20],
    upperFloors: [0, 1],
    bayWidth: [6, 7.5],
    depth: [10, 14],
    bands: { verge: 1.5, pitWall: 0.8, fastLane: 3.0, workingLane: 6.0, boxApron: 4.5, garageApron: 5 },
    roof: "shallow-pitch",
    canopyOverApron: false,
    balcony: "none",
    controlTower: "small",
    screens: [0, 1],
    stands: { kinds: ["uncovered-terrace", "hillside"], count: [0, 3], rows: [6, 14] },
    capacity: [2000, 15000],
    nightLighting: [0.05, 0.3],
    crowd: [0.3, 0.7],
    groundedIn: ["Goodwood", "Monza(1922 layer)", "Brands Hatch", "Imola"],
  },
  {
    id: "utilitarian",
    classes: ["regional", "national", "endurance"],
    permanence: "permanent",
    garages: [18, 30],
    upperFloors: [1, 2],
    bayWidth: [6.5, 8],
    depth: [12, 16],
    bands: { verge: 2, pitWall: 1.0, fastLane: 3.5, workingLane: 7.5, boxApron: 5, garageApron: 7 },
    roof: "flat",
    canopyOverApron: true,
    balcony: "some",
    controlTower: "small",
    screens: [1, 2],
    stands: { kinds: ["uncovered-terrace", "covered-linear"], count: [1, 4], rows: [10, 20] },
    capacity: [8000, 35000],
    nightLighting: [0.2, 0.5],
    crowd: [0.4, 0.8],
    groundedIn: ["Zandvoort", "Interlagos", "Road America", "Watkins Glen", "Sebring"],
  },
  {
    id: "modern-linear",
    classes: ["international"],
    permanence: "permanent",
    garages: [28, 40],
    upperFloors: [2, 3],
    bayWidth: [6.5, 7.5],
    depth: [16, 22],
    bands: { verge: 2.5, pitWall: 1.2, fastLane: 3.5, workingLane: 8.5, boxApron: 6, garageApron: 8 },
    roof: "cantilever",
    canopyOverApron: true,
    balcony: "continuous",
    controlTower: "prominent",
    screens: [2, 3],
    stands: { kinds: ["multi-tier", "covered-linear", "cantilever-roof"], count: [2, 5], rows: [18, 34] },
    capacity: [40000, 120000],
    nightLighting: [0.6, 0.9],
    crowd: [0.7, 1],
    groundedIn: ["Fuji", "Suzuka", "Silverstone(Wing)", "COTA", "Yas Marina"],
  },
  {
    id: "monumental",
    classes: ["international"],
    permanence: "permanent",
    garages: [30, 44],
    upperFloors: [2, 4],
    bayWidth: [7, 8],
    depth: [18, 24],
    bands: { verge: 3, pitWall: 1.2, fastLane: 3.5, workingLane: 9, boxApron: 6.5, garageApron: 9 },
    roof: "wave",
    canopyOverApron: true,
    balcony: "continuous",
    controlTower: "landmark",
    screens: [2, 4],
    stands: { kinds: ["multi-tier", "cantilever-roof", "vip-suite"], count: [3, 6], rows: [24, 40] },
    capacity: [60000, 150000],
    nightLighting: [0.7, 1],
    crowd: [0.8, 1],
    groundedIn: ["Shanghai", "Sepang", "COTA(tower)", "Daytona"],
  },
  {
    id: "desert-canopy",
    classes: ["international", "national"],
    permanence: "permanent",
    garages: [26, 38],
    upperFloors: [1, 3],
    bayWidth: [7, 8],
    depth: [16, 22],
    bands: { verge: 3, pitWall: 1.2, fastLane: 3.5, workingLane: 8.5, boxApron: 6, garageApron: 8.5 },
    roof: "tensile-canopy",
    canopyOverApron: true,
    balcony: "continuous",
    controlTower: "prominent",
    screens: [2, 3],
    stands: { kinds: ["tensile-canopy", "covered-linear"], count: [2, 5], rows: [16, 30] },
    capacity: [30000, 70000],
    nightLighting: [0.8, 1],
    crowd: [0.7, 1],
    groundedIn: ["Bahrain", "Yas Marina", "Jeddah"],
  },
  {
    id: "temporary-modular",
    classes: ["temporary-street"],
    permanence: "temporary",
    garages: [18, 30],
    upperFloors: [0, 2],
    bayWidth: [6, 7.5],
    depth: [8, 14],
    bands: { verge: 1, pitWall: 0.8, fastLane: 3.5, workingLane: 7, boxApron: 5, garageApron: 6 },
    roof: "fabric",
    canopyOverApron: true,
    balcony: "some",
    controlTower: "small",
    screens: [1, 3],
    stands: { kinds: ["temporary-bleacher"], count: [3, 8], rows: [10, 24] },
    capacity: [20000, 90000],
    nightLighting: [0.5, 1],
    crowd: [0.7, 1],
    groundedIn: ["Singapore", "Monaco", "Baku", "Miami", "Las Vegas"],
  },
  {
    id: "private-club",
    classes: ["club"],
    permanence: "permanent",
    garages: [8, 18],
    upperFloors: [1, 2],
    bayWidth: [7, 9],
    depth: [12, 18],
    bands: { verge: 1.5, pitWall: 0.8, fastLane: 3, workingLane: 6, boxApron: 4.5, garageApron: 7 },
    roof: "shallow-pitch",
    canopyOverApron: false,
    balcony: "some",
    controlTower: "none",
    screens: [0, 1],
    stands: { kinds: ["club-deck", "hillside"], count: [0, 2], rows: [3, 8] },
    capacity: [200, 3000],
    nightLighting: [0.1, 0.4],
    crowd: [0.1, 0.4],
    groundedIn: ["Magarigawa", "Thermal Club", "Monticello", "Ascari"],
  },
  {
    id: "experimental",
    classes: ["international", "endurance"],
    permanence: "hybrid",
    garages: [30, 60],
    upperFloors: [2, 5],
    bayWidth: [6.5, 9],
    depth: [16, 26],
    bands: { verge: 2.5, pitWall: 1.2, fastLane: 3.5, workingLane: 9, boxApron: 6.5, garageApron: 9 },
    roof: "wave",
    canopyOverApron: true,
    balcony: "continuous",
    controlTower: "landmark",
    screens: [2, 5],
    stands: { kinds: ["multi-tier", "cantilever-roof", "corner-bowl", "vip-suite"], count: [3, 8], rows: [20, 44] },
    capacity: [50000, 200000],
    nightLighting: [0.7, 1],
    crowd: [0.7, 1],
    groundedIn: ["Le Mans(garage count)", "Daytona(scale)", "Shanghai(roof)", "COTA(tower)"],
  },
];

export function archetypeById(id: ArchitectureStyle): Archetype {
  return ARCHETYPES.find((a) => a.id === id) ?? ARCHETYPES[2];
}

/** Endurance events stretch the pit complex (Le Mans: 60+ garages). */
export const ENDURANCE_GARAGE_MULTIPLIER = 1.6;
