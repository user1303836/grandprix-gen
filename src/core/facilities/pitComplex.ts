/**
 * Pit-complex architecture grammar: assembles the pit building from
 * meaningful modules (garage bays, upper floors, hospitality volumes,
 * race-control/tower, canopy, paddock apron, service road) inside the
 * archetype envelope. Coherent facility DNA at whole-complex scale,
 * controlled mutation at segment/bay scale.
 */

import { mulberry32 } from "../prng";
import { sampleAt } from "../types";
import type { Track } from "../types";
import type { Archetype, RoofKind } from "../../data/facilityArchetypes";
import type {
  BuildingVolumePlan,
  CanopyPlan,
  FacilityIdentity,
  GarageBayPlan,
  PitComplexPlan,
  PitLanePlan,
  FacilitySitePlan,
  Vec2,
} from "./types";

export interface PitComplexResult {
  plan: PitComplexPlan;
  violations: string[];
}

const TEAM_WORDS_A = ["Apex", "Vertex", "Komet", "Stern", "Falke", "Raben", "Nord", "Volt", "Berg", "Sturm", "Pfeil", "Werk", "Adler", "Luchs", "Otter", "Marder"];
const TEAM_WORDS_B = ["Racing", "Motorsport", "Speedworks", "Competizione", "Course", "Team", "Engineering", "Rennstall", "Dynamics", "Autosport"];

/**
 * Local frame for the complex: u runs along the pit straight (direction of
 * travel), v points away from the track toward the building. Buildings are
 * placed in (u, v) and projected to plan coordinates per sample.
 */
export function complexFrame(track: Track, site: FacilitySitePlan): {
  uOf: (s: number) => number;
  pointAt: (u: number, v: number) => { x: number; y: number; z: number; heading: number };
} {
  const sign = site.side === "left" ? 1 : -1;
  const uOf = (s: number) => s - site.sStart;
  const pointAt = (u: number, v: number) => {
    const s = site.sStart + u;
    const p = sampleAt(track, ((s % track.length) + track.length) % track.length);
    const nx = -Math.sin(p.heading) * sign;
    const ny = Math.cos(p.heading) * sign;
    return { x: p.x + nx * v, y: p.y + ny * v, z: p.z, heading: p.heading };
  };
  return { uOf, pointAt };
}

export function buildPitComplex(
  track: Track,
  site: FacilitySitePlan,
  pitLane: PitLanePlan,
  arch: Archetype,
  identity: FacilityIdentity,
  seed: number,
): PitComplexResult {
  const violations: string[] = [];
  const rnd = mulberry32(seed ^ 0xc04);
  const { pointAt } = complexFrame(track, site);
  const sign = site.side === "left" ? 1 : -1;

  const siteLen = site.sEnd - site.sStart;
  const garageApron = pitLane.laneBands.find((b) => b.kind === "garage-apron")!;
  const vFront = garageApron.offsetOuter + 0.4; // building face
  const scale = identity.scale;

  // ---- whole-complex DNA ---------------------------------------------------
  const garageTarget = Math.round(
    arch.garages[0] + (arch.garages[1] - arch.garages[0]) * (0.25 + scale * 0.75),
  );
  const bayW = arch.bayWidth[0] + (arch.bayWidth[1] - arch.bayWidth[0]) * rnd();
  const depth = arch.depth[0] + (arch.depth[1] - arch.depth[0]) * rnd();
  const maxBays = Math.max(4, Math.floor((siteLen - 30) / bayW));
  const bays = Math.min(garageTarget, maxBays);
  if (bays < garageTarget * 0.7) {
    violations.push(`site fits only ${bays}/${garageTarget} garage bays`);
  }
  const floors = 1 + Math.round(arch.upperFloors[0] + (arch.upperFloors[1] - arch.upperFloors[0]) * rnd());
  const floorH = style_floorHeight(identity.architectureStyle);
  const buildingLen = bays * bayW;
  const u0 = (siteLen - buildingLen) / 2; // centered on the site window

  // structural rhythm: segment the long block into 2–5 volumes with small
  // setbacks/joins (expansion logic), one of them glazed hospitality
  const nSeg = Math.max(1, Math.min(5, Math.round(buildingLen / 90)));
  const segLens: number[] = [];
  let remaining = buildingLen;
  for (let k = 0; k < nSeg; k++) {
    const left = nSeg - k - 1;
    const len = k === nSeg - 1 ? remaining : Math.max(30, Math.round((remaining / (left + 1)) * (0.85 + rnd() * 0.3)));
    segLens.push(len);
    remaining -= len;
  }
  const glazedSeg = floors > 1 && identity.architectureStyle !== "historic-low-rise"
    ? Math.floor(rnd() * nSeg)
    : -1;

  const volumes: BuildingVolumePlan[] = [];
  const bays_out: GarageBayPlan[] = [];
  let uCur = u0;
  let bayIdx = 0;
  const doorPalette = [0xc83a2a, 0x2a5a9e, 0x3a9a5a, 0xe8a83a, 0x7a4a9e, 0x3aa8b8, 0xb84a78, 0x4a7a3a];

  for (let seg = 0; seg < nSeg; seg++) {
    const len = segLens[seg];
    const cx = pointAt(uCur + len / 2, vFront + depth / 2);
    const vol: BuildingVolumePlan = {
      id: `garage-block-${seg}`,
      kind: "garage-block",
      cx: cx.x,
      cy: cx.y,
      angleU: cx.heading,
      widthU: len,
      depthV: depth,
      baseZ: cx.z, // refined by foundations in phase 5
      floors,
      floorHeight: floorH,
      facade: [
        "garage-doors",
        ...Array.from({ length: floors - 1 }, (_, f) =>
          seg === glazedSeg ? "glazed" : rnd() < 0.4 ? "balcony" : "solid",
        ),
      ] as BuildingVolumePlan["facade"],
      roof: arch.roof,
      foundationId: `fdn-garage-${seg}`,
    };
    volumes.push(vol);
    // bays inside this segment
    const segBays = Math.round(len / bayW);
    for (let b = 0; b < segBays && bayIdx < bays; b++) {
      const bu = uCur + (b + 0.5) * (len / segBays);
      const bp = pointAt(bu, vFront);
      bays_out.push({
        id: bayIdx,
        volumeId: vol.id,
        u: bu,
        frontOffsetV: vFront,
        x: bp.x,
        y: bp.y,
        z: bp.z,
        heading: bp.heading,
        sideSign: sign,
        width: bayW - 0.6,
        doorColor: doorPalette[(bayIdx + (rnd() < 0.25 ? 1 : 0)) % doorPalette.length],
        doorOpen: rnd() < 0.3,
        number: bayIdx + 1,
        teamName: `${TEAM_WORDS_A[Math.floor(rnd() * TEAM_WORDS_A.length)]} ${TEAM_WORDS_B[Math.floor(rnd() * TEAM_WORDS_B.length)]}`,
      });
      bayIdx++;
    }
    uCur += len;
  }

  // ---- race control / tower near start/finish (u near track s=0 or mid) --
  let tower: BuildingVolumePlan | null = null;
  if (arch.controlTower !== "none") {
    const tu = u0 + buildingLen * (0.35 + rnd() * 0.3);
    const tp = pointAt(tu, vFront + depth + 6);
    const towerH = arch.controlTower === "landmark" ? 3 + rnd() * 2 : 1 + rnd();
    tower = {
      id: "race-control-tower",
      kind: arch.controlTower === "landmark" ? "tower" : "race-control",
      cx: tp.x,
      cy: tp.y,
      angleU: tp.heading,
      widthU: 10 + rnd() * 6,
      depthV: 10 + rnd() * 4,
      baseZ: tp.z,
      floors: Math.round(towerH * 2) + 2,
      floorHeight: floorH * 0.9,
      facade: ["solid", ...Array.from({ length: Math.round(towerH * 2) + 1 }, () => "glazed" as const)],
      roof: "flat",
      foundationId: "fdn-tower",
    };
    volumes.push(tower);
  }

  // ---- hospitality volumes (separate masses behind/above) -----------------
  const hospitality: BuildingVolumePlan[] = [];
  if (arch.balcony !== "none" && floors >= 2 && rnd() < 0.75) {
    const hu = u0 + buildingLen * (rnd() < 0.5 ? 0.15 : 0.85);
    const hp = pointAt(hu, vFront + depth + 4);
    hospitality.push({
      id: "hospitality-0",
      kind: "hospitality",
      cx: hp.x,
      cy: hp.y,
      angleU: hp.heading,
      widthU: 18 + rnd() * 22,
      depthV: 10 + rnd() * 6,
      baseZ: hp.z,
      floors: Math.max(1, floors - 1),
      floorHeight: floorH,
      facade: Array.from({ length: Math.max(1, floors - 1) }, () => "glazed" as const),
      roof: arch.roof === "tensile-canopy" ? "flat" : arch.roof,
      foundationId: "fdn-hospitality-0",
    });
    volumes.push(...hospitality);
  }

  // ---- canopy over the apron ----------------------------------------------
  let canopy: CanopyPlan | null = null;
  if (arch.canopyOverApron) {
    canopy = {
      kind: arch.roof,
      uStart: u0 - 4,
      uEnd: u0 + buildingLen + 4,
      vFront: vFront - Math.min(garageApron.offsetOuter - garageApron.offsetInner, 6),
      vBack: vFront + 2.5,
      z: 0, // set at render: building base + 1 floor
      columns: Math.max(2, Math.round(buildingLen / 24)),
    };
  }

  // ---- paddock apron + service road ----------------------------------------
  const padInner = vFront + depth + (tower ? 14 : 8);
  const padOuter = padInner + 18 + scale * 14;
  const padPts: Vec2[] = [];
  const padBack: Vec2[] = [];
  for (let u = u0 - 20; u <= u0 + buildingLen + 20; u += 16) {
    const a = pointAt(u, padInner);
    const b = pointAt(u, padOuter);
    padPts.push({ x: a.x, y: a.y });
    padBack.push({ x: b.x, y: b.y });
  }
  const paddockApron = {
    polygon: [...padPts, ...padBack.reverse()] as Vec2[],
    z: pointAt(u0, padInner).z,
    surface: identity.permanence === "temporary" ? ("gravel" as const) : ("asphalt" as const),
  };
  const serviceRoad =
    identity.permanence !== "temporary"
      ? {
          points: Array.from({ length: 8 }, (_, k) => {
            const p = pointAt(u0 - 30 + ((buildingLen + 60) * k) / 7, padOuter + 6);
            return { x: p.x, y: p.y };
          }),
          width: 6,
        }
      : null;

  void sign;
  return {
    plan: {
      volumes,
      garageBays: bays_out,
      canopy,
      paddockApron,
      serviceRoad,
      pedestrianBridges:
        identity.facilityClass === "international" && rnd() < 0.5
          ? [{ u: u0 + buildingLen * 0.5, width: 3.2, z: 0 }]
          : [],
    },
    violations,
  };
}

function style_floorHeight(style: string): number {
  switch (style) {
    case "historic-low-rise":
      return 3.4;
    case "temporary-modular":
      return 3.0;
    case "monumental":
      return 4.6;
    default:
      return 3.9;
  }
}

export type { RoofKind };
