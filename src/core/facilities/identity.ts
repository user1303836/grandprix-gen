/**
 * Facility identity: resolves the user controls + track identity + facility
 * seed into one coherent FacilityIdentity (the "facility DNA").
 * Auto style is steered by the circuit's era/heritage, never a coin flip.
 */

import { ARCHETYPES, archetypeById, type ArchitectureStyle } from "../../data/facilityArchetypes";
import { mulberry32 } from "../prng";
import type { Track } from "../types";
import type { FacilityControls, FacilityIdentity } from "./types";

/** Steer style from the track identity when the user leaves it on auto. */
function autoStyle(track: Track, rnd: () => number): ArchitectureStyle {
  const era = track.identity?.era ?? "modern";
  const heritage = track.identity?.terrainCoupling ?? 0.5;
  const roll = rnd();
  if (era === "classic") {
    if (roll < 0.55) return "historic-low-rise";
    if (roll < 0.8) return "utilitarian";
    return "private-club";
  }
  if (heritage > 0.72) {
    if (roll < 0.4) return "utilitarian";
    if (roll < 0.6) return "historic-low-rise";
    if (roll < 0.8) return "modern-linear";
    return "desert-canopy";
  }
  // modern/mixed identities
  if (roll < 0.34) return "modern-linear";
  if (roll < 0.52) return "utilitarian";
  if (roll < 0.66) return "desert-canopy";
  if (roll < 0.78) return "monumental";
  if (roll < 0.9) return "private-club";
  return "experimental";
}

const STYLE_CLASS: Record<ArchitectureStyle, FacilityIdentity["facilityClass"]> = {
  "historic-low-rise": "regional",
  utilitarian: "national",
  "modern-linear": "international",
  monumental: "international",
  "desert-canopy": "international",
  "temporary-modular": "temporary-street",
  "private-club": "club",
  experimental: "endurance",
};

export function rollFacilityIdentity(
  track: Track,
  controls: FacilityControls,
): FacilityIdentity {
  const rnd = mulberry32(controls.seed ^ 0xfac11);
  const style: ArchitectureStyle = controls.style === "auto" ? autoStyle(track, rnd) : controls.style;
  const arch = archetypeById(style);
  // endurance tracks stretch the pit complex (Le Mans prior)
  const isEndurance = style === "experimental";
  const scale = Math.min(1, Math.max(0, controls.scale + rnd() * 0.14 - 0.07));
  const capacity = Math.round(
    (arch.capacity[0] + (arch.capacity[1] - arch.capacity[0]) * (0.25 + scale * 0.75)) *
      (0.5 + controls.grandstandDensity),
  );
  const night = Math.min(
    1,
    arch.nightLighting[0] + (arch.nightLighting[1] - arch.nightLighting[0]) * (0.3 + controls.nightReadiness * 0.7),
  );
  return {
    facilityClass: isEndurance ? "endurance" : STYLE_CLASS[style],
    architectureStyle: style,
    permanence: arch.permanence,
    scale,
    architecturalVariation: Math.min(1, Math.max(0, controls.variation + rnd() * 0.2 - 0.1)),
    crowdCapacity: capacity,
    crowdFill: Math.min(1, Math.max(0, controls.crowdDensity)),
    budget: Math.round((0.3 + scale * 1.7) * 100) / 100,
    nightEventReadiness: night,
  };
}

export { ARCHETYPES };
