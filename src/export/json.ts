/**
 * Native lossless project format (.track.json).
 * Stores everything needed to restore the design exactly:
 * generator version, seed, params, DNA, samples, site, terrain meta.
 */

import { GENERATOR_VERSION, type Track } from "../core/types";

export interface ProjectFile {
  format: "grandprix-gen/track";
  version: number;
  savedAt: string;
  track: Track;
}

export function serializeProject(track: Track): string {
  const file: ProjectFile = {
    format: "grandprix-gen/track",
    version: GENERATOR_VERSION,
    savedAt: new Date().toISOString(),
    track,
  };
  return JSON.stringify(file, null, 1);
}

export function deserializeProject(json: string): Track {
  const file = JSON.parse(json) as ProjectFile;
  if (file.format !== "grandprix-gen/track") {
    throw new Error("not a grandprix-gen project file");
  }
  if (typeof file.version !== "number" || file.version > GENERATOR_VERSION) {
    throw new Error(`unsupported project version ${file.version}`);
  }
  const t = file.track;
  if (!t || !Array.isArray(t.samples) || t.samples.length === 0) {
    throw new Error("project file has no samples");
  }
  // basic structural sanity
  const s0 = t.samples[0];
  for (const key of ["x", "y", "z", "heading", "kappa", "bank", "width", "s"] as const) {
    if (typeof s0[key] !== "number") throw new Error(`sample missing ${key}`);
  }
  // NaN becomes null in JSON; restore it for fields that use NaN semantics
  for (const sm of t.samples) {
    if ((sm.speed as unknown) === null || sm.speed === undefined) sm.speed = NaN;
    if ((sm.groundZ as unknown) === null || sm.groundZ === undefined) sm.groundZ = NaN;
  }
  return t;
}
