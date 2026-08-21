/**
 * Native lossless project format (.track.json).
 * Stores everything needed to restore the design exactly:
 * generator version, seed, params, DNA, samples, site, terrain meta.
 */

import { GENERATOR_VERSION, type PropertyProfiles, type Track } from "../core/types";

export interface ProjectFile {
  format: "grandprix-gen/track";
  version: number;
  savedAt: string;
  track: Track;
}

/** PropertyProfiles hold typed arrays; JSON needs plain arrays. */
function encodeProps(p: PropertyProfiles): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of Object.keys(p) as (keyof PropertyProfiles)[]) {
    out[k] = Array.from(p[k] as Float32Array | Uint8Array | Int16Array, (v) => v);
  }
  return out;
}

function decodeProps(raw: Record<string, number[]>): PropertyProfiles {
  return {
    widthL: Float32Array.from(raw.widthL),
    widthR: Float32Array.from(raw.widthR),
    surface: Uint8Array.from(raw.surface),
    roughness: Float32Array.from(raw.roughness),
    grip: Float32Array.from(raw.grip),
    crossfall: Float32Array.from(raw.crossfall),
    kerbL: Uint8Array.from(raw.kerbL),
    kerbR: Uint8Array.from(raw.kerbR),
    runoffL: Uint8Array.from(raw.runoffL),
    runoffR: Uint8Array.from(raw.runoffR),
    runoffWidthL: Float32Array.from(raw.runoffWidthL),
    runoffWidthR: Float32Array.from(raw.runoffWidthR),
    barrierDistL: Float32Array.from(raw.barrierDistL),
    barrierDistR: Float32Array.from(raw.barrierDistR),
    featureIdx: Int16Array.from(raw.featureIdx),
  };
}

export function serializeProject(track: Track): string {
  const file: ProjectFile = {
    format: "grandprix-gen/track",
    version: GENERATOR_VERSION,
    savedAt: new Date().toISOString(),
    track: {
      ...track,
      props: encodeProps(track.props) as unknown as PropertyProfiles,
      carveMask: track.carveMask ? (Array.from(track.carveMask) as unknown as Uint8Array) : null,
      carveInner: track.carveInner ? (Array.from(track.carveInner) as unknown as Float32Array) : null,
    },
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
  // restore typed property profiles (older/simple files may lack them)
  if (t.props && !ArrayBuffer.isView(t.props.widthL)) {
    t.props = decodeProps(t.props as unknown as Record<string, number[]>);
  }
  if (t.carveMask && !ArrayBuffer.isView(t.carveMask)) {
    t.carveMask = Uint8Array.from(t.carveMask as unknown as number[]);
  }
  if (t.carveInner && !ArrayBuffer.isView(t.carveInner)) {
    t.carveInner = Float32Array.from(t.carveInner as unknown as number[]);
  }
  if (!Array.isArray(t.structures)) t.structures = [];
  if (!Array.isArray(t.zones)) t.zones = [];
  return t;
}
