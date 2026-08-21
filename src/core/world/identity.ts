/**
 * Latent environment identity: one coherent roll of landform, biome,
 * hydrology, and humanization from the environment seed. Friendly presets
 * map onto factorized combinations; "auto" rolls a compatible set.
 */

import { Rng } from "../prng";
import type {
  Biome,
  EnvironmentIdentity,
  EnvironmentParams,
  EnvironmentStyle,
  Humanization,
  HydrologyKind,
  Landform,
} from "./types";

interface Preset {
  landform: Landform;
  biome: Biome;
  hydrology: HydrologyKind;
  humanization: Humanization | "roll";
  label: string;
}

const PRESETS: Record<Exclude<EnvironmentStyle, "auto">, Preset> = {
  "highland-forest": {
    landform: "rolling-hills",
    biome: "highland",
    hydrology: "seasonal-stream",
    humanization: "heritage-road",
    label: "Highland Forest",
  },
  "river-valley": {
    landform: "valley",
    biome: "temperate-forest",
    hydrology: "river",
    humanization: "heritage-road",
    label: "Forest River Valley",
  },
  cliffside: {
    landform: "ridges",
    biome: "alpine",
    hydrology: "seasonal-stream",
    humanization: "mountain-club",
    label: "Cliffside",
  },
  "volcanic-plateau": {
    landform: "plateau",
    biome: "volcanic",
    hydrology: "dry",
    humanization: "wilderness",
    label: "Volcanic Plateau",
  },
  "coastal-island": {
    landform: "island",
    biome: "coastal",
    hydrology: "coast",
    humanization: "modern-circuit",
    label: "Coastal Island",
  },
  "alpine-canyon": {
    landform: "canyon",
    biome: "alpine",
    hydrology: "river",
    humanization: "mountain-club",
    label: "Alpine Canyon",
  },
  "plinth-fantasy": {
    landform: "basin",
    biome: "highland",
    hydrology: "lake",
    humanization: "fantasy-megaproject",
    label: "Plinth Fantasy",
  },
};

const LANDFORMS: Landform[] = ["rolling-hills", "plateau", "ridges", "valley", "canyon", "basin", "island"];
const HUMANS: Humanization[] = [
  "wilderness",
  "heritage-road",
  "mountain-club",
  "modern-circuit",
  "industrial",
  "fantasy-megaproject",
];

/** biome compatibility: which biomes make sense on which landforms */
const BIOME_FOR: Record<Landform, Biome[]> = {
  "rolling-hills": ["temperate-forest", "highland"],
  plateau: ["volcanic", "arid", "highland"],
  ridges: ["alpine", "highland", "arid"],
  valley: ["temperate-forest", "highland", "alpine"],
  canyon: ["alpine", "arid", "volcanic"],
  basin: ["highland", "arid", "volcanic"],
  island: ["coastal", "temperate-forest"],
};

const HYDRO_FOR: Record<Landform, HydrologyKind[]> = {
  "rolling-hills": ["seasonal-stream", "river", "lake", "dry"],
  plateau: ["dry", "seasonal-stream", "lake"],
  ridges: ["seasonal-stream", "dry", "river"],
  valley: ["river", "seasonal-stream", "lake"],
  canyon: ["river", "seasonal-stream", "dry"],
  basin: ["lake", "dry", "seasonal-stream"],
  island: ["coast"],
};

export function rollEnvironmentIdentity(
  envSeed: number,
  params: EnvironmentParams,
): EnvironmentIdentity {
  const rng = new Rng(envSeed ^ 0x1d3a);
  let landform: Landform;
  let biome: Biome;
  let hydrology: HydrologyKind;
  let humanization: Humanization;
  let label: string;

  if (params.style !== "auto") {
    const p = PRESETS[params.style];
    landform = p.landform;
    biome = p.biome;
    hydrology = p.hydrology;
    humanization = p.humanization === "roll" ? HUMANS[rng.int(0, HUMANS.length - 1)] : p.humanization;
    label = p.label;
  } else {
    landform = LANDFORMS[rng.int(0, LANDFORMS.length - 1)];
    biome = BIOME_FOR[landform][rng.int(0, BIOME_FOR[landform].length - 1)];
    hydrology = HYDRO_FOR[landform][rng.int(0, HYDRO_FOR[landform].length - 1)];
    humanization = HUMANS[rng.int(0, HUMANS.length - 1)];
    label = `${biome
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")} ${landform
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")}`;
  }

  // water amount can mute planned hydrology
  if (params.water < 0.15 && hydrology !== "coast") hydrology = "dry";
  if (params.water < 0.35 && hydrology === "river") hydrology = "seasonal-stream";
  if (params.water >= 0.35 && hydrology === "dry" && params.style === "auto") {
    hydrology = landform === "basin" ? "lake" : "seasonal-stream";
  }
  if (landform === "island") hydrology = "coast";

  // fantasy realism can escalate humanization
  if (params.realism === "fantasy" && humanization === "wilderness") {
    humanization = "fantasy-megaproject";
  }
  if (params.realism === "realistic" && humanization === "fantasy-megaproject") {
    humanization = "modern-circuit";
  }

  return { landform, biome, hydrology, humanization, label };
}

/** Default boundary treatment for an identity (used when mode ≠ open). */
export function defaultBoundaryTreatment(
  identity: EnvironmentIdentity,
  rng: Rng,
): import("./types").BoundaryTreatment {
  switch (identity.landform) {
    case "island":
      return "coastline";
    case "canyon":
    case "ridges":
      return "rock-cliff";
    case "plateau":
      return identity.biome === "volcanic" ? "rock-cliff" : "stratified-earth";
    case "basin":
      return identity.humanization === "fantasy-megaproject" ? "concrete-plinth" : "stratified-earth";
    case "valley":
    case "rolling-hills":
    default:
      return rng.next() < 0.5 ? "stratified-earth" : "fog-drop";
  }
}
