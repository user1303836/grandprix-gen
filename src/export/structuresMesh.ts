/**
 * Structure meshes: the visible concrete/rock/earth that seats the road
 * into the landscape wherever it leaves the ground plane. Bridges get
 * decks, edge beams, parapets and piers; cuts get retaining walls or rock
 * faces; deep bores get tunnel tubes with portals; fills get grass
 * embankment skirts. Positions use the track-mesh convention
 * [x, y_plan, z_up]; the viewer converts.
 */

import type { Track } from "../core/types";
import { makeTrackProximity } from "../core/terrain";
import { Rng } from "../core/prng";

export interface StructureMeshPart {
  name: string; // e.g. "bridge-deck", "pier", "tunnel", "portal", "retaining", "rock", "embankment"
  positions: Float32Array;
  indices: Uint32Array;
}

class GeoAcc {
  pos: number[] = [];
  idx: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[]) {
    // a,b,c,d in PERIMETER order; consistent CCW triangles
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a: number[], b: number[], c: number[]) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c);
    this.idx.push(base, base + 1, base + 2);
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, heading: number) {
    // axis box rotated by heading around z-up; cz = center height
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    const corners: number[][] = [];
    for (const dz of [-hz, hz]) {
      for (const [dx, dy] of [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ]) {
        corners.push([cx + dx * ch - dy * sh, cy + dx * sh + dy * ch, cz + dz]);
      }
    }
    const [b0, b1, b2, b3, t0, t1, t2, t3] = corners;
    this.quad(b0, b1, b2, b3); // bottom
    this.quad(t0, t2, t1, t3); // top (note winding for outward normal)
    this.quad(b0, t0, t1, b1);
    this.quad(b1, t1, t2, b2);
    this.quad(b2, t2, t3, b3);
    this.quad(b3, t3, t0, b0);
  }
  finish(name: string): StructureMeshPart {
    return {
      name,
      positions: new Float32Array(this.pos),
      indices: new Uint32Array(this.idx),
    };
  }
}

interface Frame {
  x: number;
  y: number;
  z: number;
  nx: number; // left normal
  ny: number;
  wL: number;
  wR: number;
  heading: number;
}

/** Boxcar smooth a per-station profile (structure crests/heights). */
function smoothLine(vals: number[], win: number): number[] {
  return vals.map((_, i) => {
    let acc = 0;
    let cnt = 0;
    for (let k = -win; k <= win; k++) {
      const j = Math.min(vals.length - 1, Math.max(0, i + k));
      acc += vals[j];
      cnt++;
    }
    return acc / cnt;
  });
}

export function buildStructureMeshes(
  track: Track,
  groundSampler: ((x: number, y: number) => number | null) | null,
): StructureMeshPart[] {
  const civilSpans = track.civil?.spans ?? [];
  const legacySpans = track.structures ?? [];
  if (civilSpans.length === 0 && legacySpans.length === 0) return [];
  // normalized span shape: both stat fields and side conventions present
  const spans = civilSpans.length > 0
    ? civilSpans.map((c) => ({
        ...c,
        kind: c.kind as string,
        sideNum: c.side,
        sideStr: c.side > 0 ? ("left" as const) : c.side < 0 ? ("right" as const) : ("both" as const),
        minD: -c.maxCut,
        maxD: c.maxFill,
      }))
    : legacySpans.map((l) => ({
        ...l,
        kind: l.kind as string,
        sideNum: l.side === "left" ? 1 : l.side === "right" ? -1 : 0,
        sideStr: l.side,
        maxFill: Math.max(0, l.maxD),
        maxCut: Math.max(0, -l.minD),
        maxHeight: Math.max(0, l.maxD),
        side: l.side === "left" ? 1 : l.side === "right" ? -1 : 0,
      }));
  const n = track.samples.length;
  const ds = track.ds;
  const props = track.props;

  const frameAt = (i: number): Frame => {
    const s = track.samples[((i % n) + n) % n];
    const ii = ((i % n) + n) % n;
    return {
      x: s.x,
      y: s.y,
      z: s.z,
      nx: -Math.sin(s.heading),
      ny: Math.cos(s.heading),
      wL: props.widthL[ii] + 1.6, // past kerb
      wR: props.widthR[ii] + 1.6,
      heading: s.heading,
    };
  };
  const groundAt = (x: number, y: number, fallback: number): number => {
    if (!groundSampler) return fallback;
    const g = groundSampler(x, y);
    return g !== null && Number.isFinite(g) ? g : fallback;
  };

  const bridgeDeck = new GeoAcc();
  const piers = new GeoAcc();
  const tunnel = new GeoAcc();
  const portals = new GeoAcc();
  const retaining = new GeoAcc();
  const rock = new GeoAcc();
  const embank = new GeoAcc();

  for (const sp of spans) {
    const i0 = Math.round(sp.sStart / ds);
    const i1 = Math.round(sp.sEnd / ds);
    const len = ((i1 - i0) % n + n) % n || n;
    const idxs: number[] = [];
    for (let k = 0; k <= len; k++) idxs.push(i0 + k);

    if (sp.kind === "viaduct" || sp.kind === "short-bridge" || sp.kind === "bridge") {
      buildElevated(sp, idxs, {
        frameAt, groundAt, deck: bridgeDeck, sup: piers,
      }, track, props, groundSampler);
    } else if (sp.kind === "platform") {
      buildPlatform(sp, idxs, { frameAt, groundAt, acc: piers }, track, props, groundSampler);
    } else if (sp.kind === "shelf") {
      buildShelf({ ...sp, side: sp.sideNum || 1 }, idxs, { frameAt, groundAt, acc: piers, deck: bridgeDeck }, track, props, groundSampler);
    } else if (sp.kind === "terraced") {
      buildTerraced(sp, idxs, { frameAt, groundAt, acc: embank }, track, props, groundSampler);
    } else if (sp.kind === "gallery") {
      buildGallery({ ...sp, side: sp.sideNum || 1 }, idxs, { frameAt, groundAt, tunnel, portals, retaining }, track, props, groundSampler);
    } else if (sp.kind === "bench") {
      buildBench({ ...sp, side: sp.sideNum || 1 }, idxs, { frameAt, groundAt, retaining, embank }, track, props, groundSampler);
    } else if (sp.kind === "dual-retaining") {
      buildRetainingLegacy({ ...sp, side: sp.sideStr }, idxs, { frameAt, groundAt, acc: retaining }, "both");
    } else if (sp.kind === "bridge-disabled") {
      // deck edge beams + parapets, piers every ~32 m
      const step = 2; // samples per quad segment
      for (let k = 0; k < idxs.length - step; k += step) {
        const a = frameAt(idxs[k]);
        const b = frameAt(idxs[k + step]);
        for (const side of [-1, 1] as const) {
          const wa = side < 0 ? a.wL : a.wR;
          const wb = side < 0 ? b.wL : b.wR;
          const ax = a.x + a.nx * wa * side;
          const ay = a.y + a.ny * wa * side;
          const bx = b.x + b.nx * wb * side;
          const by = b.y + b.ny * wb * side;
          // edge beam: from deck underside to slightly above road
          const topA = a.z + 1.0;
          const topB = b.z + 1.0;
          const botA = a.z - 1.3;
          const botB = b.z - 1.3;
          if (side < 0) {
            bridgeDeck.quad(
              [ax, ay, botA],
              [bx, by, botB],
              [bx, by, topB],
              [ax, ay, topA],
            );
          } else {
            bridgeDeck.quad(
              [ax, ay, botA],
              [bx, by, botB],
              [bx, by, topB],
              [ax, ay, topA],
            );
          }
        }
        // deck underside slab (visible from below)
        bridgeDeck.quad(
          [a.x + a.nx * a.wL, a.y + a.ny * a.wL, a.z - 1.25],
          [b.x + b.nx * b.wL, b.y + b.ny * b.wL, b.z - 1.25],
          [b.x - b.nx * b.wR, b.y - b.ny * b.wR, b.z - 1.25],
          [a.x - a.nx * a.wR, a.y - a.ny * a.wR, a.z - 1.25],
        );
      }
      // piers
      const pierEvery = Math.max(1, Math.round(32 / ds));
      for (let k = 0; k < idxs.length; k += pierEvery) {
        const f = frameAt(idxs[k]);
        const g = groundAt(f.x, f.y, f.z - sp.maxD);
        const top = f.z - 1.2;
        const h = top - (g - 1.5);
        if (h < 2) continue;
        piers.box(f.x, f.y, g - 1.5 + h / 2, 2.6, 1.6, h, f.heading);
        // pier cap
        piers.box(f.x, f.y, top + 0.3, Math.min(f.wL + f.wR + 2, 20), 2.0, 0.7, f.heading + Math.PI / 2);
      }
    } else if (sp.kind === "tunnel") {
      // tube: arc over the road; portals at both ends, extended proud
      const SEG = 10;
      const step = 2;
      const extS = Math.round(18 / ds);
      const idxsExt: number[] = [];
      for (let k = -extS; k < len + extS; k++) {
        idxsExt.push(i0 + k);
      }
      idxs.length = 0;
      idxs.push(...idxsExt);
      const tubeLen = idxs.length;
      // adaptive elliptical arch: lateral = road + margin, crown height
      // capped to stay below the ground surface (a 15 m tube pokes out of
      // a 10 m bore and the hill slices through the interior)
      const smpArr = track.samples;
      // precompute + smooth the arch profile along the span
      const rawLat: number[] = [];
      const rawH: number[] = [];
      for (const ii of idxs) {
        const i2 = ((ii % n) + n) % n;
        const smp = smpArr[i2];
        const f = frameAt(ii);
        rawLat.push(Math.max(f.wL, f.wR) + 1.3);
        const depth = Number.isFinite(smp.groundZ) ? smp.groundZ - smp.z : 12;
        rawH.push(Math.max(2.6, Math.min(6.2, depth - 0.8)));
      }
      const smLat = smoothLine(rawLat, 6);
      const smH = smoothLine(rawH, 6);
      const archAt = (k: number): { lat: number; h: number } => ({
        lat: smLat[Math.min(smLat.length - 1, Math.max(0, k))],
        h: smH[Math.min(smH.length - 1, Math.max(0, k))],
      });
      for (let k = 0; k < tubeLen - step; k += step) {
        const a = frameAt(idxs[k]);
        const b = frameAt(idxs[k + step]);
        const aa = archAt(k);
        const ab = archAt(k + step);
        for (let sgm = 0; sgm < SEG; sgm++) {
          const t0 = (sgm / SEG) * Math.PI;
          const t1 = ((sgm + 1) / SEG) * Math.PI;
          // right ground -> crown -> left ground (elliptical)
          const p00 = [a.x + a.nx * Math.cos(t0) * aa.lat * -1, a.y + a.ny * Math.cos(t0) * aa.lat * -1, a.z + Math.sin(t0) * aa.h + 0.35];
          const p01 = [a.x + a.nx * Math.cos(t1) * aa.lat * -1, a.y + a.ny * Math.cos(t1) * aa.lat * -1, a.z + Math.sin(t1) * aa.h + 0.35];
          const p10 = [b.x + b.nx * Math.cos(t0) * ab.lat * -1, b.y + b.ny * Math.cos(t0) * ab.lat * -1, b.z + Math.sin(t0) * ab.h + 0.35];
          const p11 = [b.x + b.nx * Math.cos(t1) * ab.lat * -1, b.y + b.ny * Math.cos(t1) * ab.lat * -1, b.z + Math.sin(t1) * ab.h + 0.35];
          tunnel.quad(p00, p10, p11, p01);
        }
      }
      // portals: ring frames slightly proud of the tube at both ends
      for (const endK of [0, idxs.length - 1]) {
        const f = frameAt(idxs[endK]);
        const aa = archAt(endK);
        const lat = aa.lat;
        const h = aa.h;
        const lat2 = lat + 1.1;
        const h2 = h + 0.8;
        for (let sgm = 0; sgm < SEG; sgm++) {
          const t0 = (sgm / SEG) * Math.PI;
          const t1 = ((sgm + 1) / SEG) * Math.PI;
          const p0 = [f.x + f.nx * Math.cos(t0) * lat * -1, f.y + f.ny * Math.cos(t0) * lat * -1, f.z + Math.sin(t0) * h + 0.35];
          const p1 = [f.x + f.nx * Math.cos(t1) * lat * -1, f.y + f.ny * Math.cos(t1) * lat * -1, f.z + Math.sin(t1) * h + 0.35];
          const q0 = [f.x + f.nx * Math.cos(t0) * lat2 * -1, f.y + f.ny * Math.cos(t0) * lat2 * -1, f.z + Math.sin(t0) * h2 + 0.35];
          const q1 = [f.x + f.nx * Math.cos(t1) * lat2 * -1, f.y + f.ny * Math.cos(t1) * lat2 * -1, f.z + Math.sin(t1) * h2 + 0.35];
          portals.quad(p0, q0, q1, p1);
        }
      }
    } else if (sp.kind === "retaining" || sp.kind === "rock-cut") {
      const acc = sp.kind === "retaining" ? retaining : rock;
      const sides: (-1 | 1)[] = sp.sideStr === "both" ? [-1, 1] : sp.sideStr === "left" ? [-1] : [1];
      for (const side of sides) {
        // sample the wall line densely, then SMOOTH the crest so the wall
        // top follows the hillside without sawteeth
        const line: { x: number; y: number; z: number; top: number }[] = [];
        for (let k = 0; k < idxs.length; k++) {
          const a = frameAt(idxs[k]);
          const w = (side < 0 ? a.wL : a.wR) + 2.2;
          const x = a.x + a.nx * w * side;
          const y = a.y + a.ny * w * side;
          const g = groundAt(x + a.nx * 3 * side, y + a.ny * 3 * side, a.z - sp.minD);
          line.push({ x, y, z: a.z - 0.6, top: Math.max(g + 0.7, a.z + 1.2) });
        }
        const sm = line.map((p, i) => {
          let acc2 = 0;
          let cnt = 0;
          for (let k = -4; k <= 4; k++) {
            const j = Math.min(line.length - 1, Math.max(0, i + k));
            acc2 += line[j].top;
            cnt++;
          }
          return { ...p, top: acc2 / cnt };
        });
        for (let k = 0; k < sm.length - 1; k++) {
          const a = sm[k];
          const b = sm[k + 1];
          acc.quad([a.x, a.y, a.z], [b.x, b.y, b.z], [b.x, b.y, b.top], [a.x, a.y, a.top]);
          // cap strip
          const fA = frameAt(idxs[k]);
          acc.quad(
            [a.x, a.y, a.top],
            [b.x, b.y, b.top],
            [b.x + (-Math.sin(fA.heading)) * 0.6 * side, b.y + Math.cos(fA.heading) * 0.6 * side, b.top],
            [a.x + (-Math.sin(fA.heading)) * 0.6 * side, a.y + Math.cos(fA.heading) * 0.6 * side, a.top],
          );
        }
      }
    } else if (sp.kind === "embankment") {
      // grass skirts sloping from the corridor edge down to the ground;
      // ground references smoothed along s so the skirt doesn't zigzag
      const step = 2;
      for (const side of [-1, 1] as const) {
        const inner: { x: number; y: number; z: number }[] = [];
        const outerG: number[] = [];
        const runs: number[] = [];
        for (const ii of idxs) {
          const a = frameAt(ii);
          const w = (side < 0 ? a.wL : a.wR) + 4;
          const x = a.x + a.nx * w * side;
          const y = a.y + a.ny * w * side;
          const gIn = groundAt(x, y, a.z - sp.maxD);
          const run = Math.max(3.5, (a.z - gIn) * 1.4 + 2);
          const ox = x + a.nx * run * side;
          const oy = y + a.ny * run * side;
          inner.push({ x, y, z: a.z - 0.12 });
          runs.push(run);
          outerG.push(groundAt(ox, oy, a.z - sp.maxD) - 0.25);
        }
        const smG = smoothLine(outerG, 5);
        for (let k = 0; k < inner.length - step; k += step) {
          const a = inner[k];
          const b = inner[k + step];
          const fa = frameAt(idxs[k]);
          const fb = frameAt(idxs[k + step]);
          const oxA = a.x + fa.nx * runs[k] * side;
          const oyA = a.y + fa.ny * runs[k] * side;
          const oxB = b.x + fb.nx * runs[k + step] * side;
          const oyB = b.y + fb.ny * runs[k + step] * side;
          embank.quad(
            [a.x, a.y, a.z],
            [b.x, b.y, b.z],
            [oxB, oyB, smG[k + step]],
            [oxA, oyA, smG[k]],
          );
        }
      }
    }
  }

  const out: StructureMeshPart[] = [];
  if (bridgeDeck.idx.length) out.push(bridgeDeck.finish("bridge"));
  if (piers.idx.length) out.push(piers.finish("piers"));
  if (tunnel.idx.length) out.push(tunnel.finish("tunnel"));
  if (portals.idx.length) out.push(portals.finish("portals"));
  if (retaining.idx.length) out.push(retaining.finish("retaining"));
  if (rock.idx.length) out.push(rock.finish("rock"));
  if (embank.idx.length) out.push(embank.finish("embankment"));
  return out;
}


// ---------------------------------------------------------------------------
// civil-kind builders
// ---------------------------------------------------------------------------

interface BuildCtx {
  frameAt: (i: number) => Frame;
  groundAt: (x: number, y: number, fallback: number) => number;
  deck?: GeoAcc;
  sup?: GeoAcc;
  acc?: GeoAcc;
  tunnel?: GeoAcc;
  portals?: GeoAcc;
  retaining?: GeoAcc;
  embank?: GeoAcc;
}

/** Terrain-aware support planner for elevated spans. */
function planSupports(
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  ds: number,
  groundSampler: ((x: number, y: number) => number | null) | null,
): { i: number; x: number; y: number; z: number; ground: number; portal: boolean }[] {
  const n = track.samples.length;
  const lenM = idxs.length * ds;
  // proximity index over ALL track samples for lower-corridor clearance
  const prox = makeTrackProximity(track.samples.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  const spanS = idxs[0] * ds;
  const conflictAt = (x: number, y: number, zDeck: number, selfI: number): boolean => {
    const near = prox.within(x, y, 40);
    for (const c of near) {
      const ii = c.i ?? 0;
      // ignore the deck's own neighborhood
      if (Math.abs(ii - selfI) * ds < 30) continue;
      const lowerZ = c.z;
      if (lowerZ < zDeck - 1.2) {
        // a lower corridor passes beneath: conflict if within its platform
        const halfW = Math.max(track.props.widthL[ii], track.props.widthR[ii]) + 4.5;
        if (c.d < halfW) return true;
      }
    }
    return false;
  };
  // span target grows with height: 26 m .. 64 m, seeded variation
  const rng = new Rng(track.seed ^ 0x5a1);
  const supports: { i: number; x: number; y: number; z: number; ground: number; portal: boolean }[] = [];
  let k = 0;
  while (k < idxs.length - 1) {
    const f = ctx.frameAt(idxs[k]);
    const g0 = ctx.groundAt(f.x, f.y, f.z - 30);
    const h = f.z - g0;
    const target = Math.max(24, Math.min(64, 26 + h * 0.85)) * rng.range(0.85, 1.15);
    let step = Math.max(8, Math.round(target / ds));
    if (k + step >= idxs.length - 1) step = idxs.length - 1 - k;
    if (step < 6) break;
    // local search: prefer the highest valid ground within +-35% of the step
    const lo = Math.max(5, Math.round(step * 0.65));
    const hi = Math.min(idxs.length - 1 - k, Math.round(step * 1.35));
    let bestK = -1;
    let bestGround = -Infinity;
    for (let dk = lo; dk <= hi; dk += 2) {
      const f2 = ctx.frameAt(idxs[k + dk]);
      const g2 = ctx.groundAt(f2.x, f2.y, f2.z - 30);
      if (!Number.isFinite(g2)) continue;
      if (conflictAt(f2.x, f2.y, f2.z, idxs[k + dk])) continue;
      if (g2 > bestGround) {
        bestGround = g2;
        bestK = k + dk;
      }
    }
    if (bestK < 0) {
      // no clean footing: lengthen the span past the obstruction
      k += hi;
      continue;
    }
    const f3 = ctx.frameAt(idxs[bestK]);
    supports.push({ i: idxs[bestK], x: f3.x, y: f3.y, z: f3.z, ground: bestGround, portal: false });
    k = bestK;
  }
  void spanS;
  void lenM;
  void n;
  return supports;
}

/** Viaduct / short-bridge: planned supports, tapered piers, hammerhead caps. */
function buildElevated(
  sp: { sStart: number; sEnd: number; seed: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const deck = ctx.deck!;
  const sup = ctx.sup!;
  const ds = track.ds;
  const step = 2;
  // box-girder edge beams + soffit slab
  for (let k = 0; k < idxs.length - step; k += step) {
    const a = ctx.frameAt(idxs[k]);
    const b = ctx.frameAt(idxs[k + step]);
    for (const side of [-1, 1] as const) {
      const wa = side < 0 ? a.wL : a.wR;
      const wb = side < 0 ? b.wL : b.wR;
      const ax = a.x + a.nx * wa * side;
      const ay = a.y + a.ny * wa * side;
      const bx = b.x + b.nx * wb * side;
      const by = b.y + b.ny * wb * side;
      deck.quad([ax, ay, a.z - 1.5], [bx, by, b.z - 1.5], [bx, by, b.z + 1.0], [ax, ay, a.z + 1.0]);
    }
    deck.quad(
      [a.x + a.nx * a.wL, a.y + a.ny * a.wL, a.z - 1.45],
      [b.x + b.nx * b.wL, b.y + b.ny * b.wL, b.z - 1.45],
      [b.x - b.nx * b.wR, b.y - b.ny * b.wR, b.z - 1.45],
      [a.x - a.nx * a.wR, a.y - a.ny * a.wR, a.z - 1.45],
    );
  }
  // abutments at both ends
  for (const endIdx of [idxs[0], idxs[idxs.length - 1]]) {
    const f = ctx.frameAt(endIdx);
    const g = ctx.groundAt(f.x, f.y, f.z - 4);
    const h = f.z - g + 1.5;
    if (h > 1.5) {
      sup.box(f.x, f.y, g - 1 + h / 2, f.wL + f.wR + 3, 3.2, h, f.heading + Math.PI / 2);
    }
  }
  // planned supports
  const supports = planSupports(idxs, ctx, track, ds, groundSampler);
  for (const s of supports) {
    const f = ctx.frameAt(s.i);
    const top = f.z - 1.4;
    const base = s.ground - 1.2;
    const h = top - base;
    if (h < 2.5) continue;
    // tapered pier: wider at the footing... visually: shaft + hammerhead cap
    const shaftW = Math.min(3.4, 1.7 + h * 0.02);
    sup.box(s.x, s.y, base + h / 2, shaftW + h * 0.012, 1.8, h, f.heading); // tapered shaft
    sup.box(s.x, s.y, top + 0.35, Math.min(f.wL + f.wR + 2.5, 18), 2.4, 0.8, f.heading + Math.PI / 2); // hammerhead
  }
}

/** Broad concrete platform supporting the FULL corridor (runoff included). */
function buildPlatform(
  sp: { sStart: number; sEnd: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const acc = ctx.acc!;
  const step = 2;
  // deck slab across the full platform width + stepped side walls to ground
  for (let k = 0; k < idxs.length - step; k += step) {
    const a = ctx.frameAt(idxs[k]);
    const b = ctx.frameAt(idxs[k + step]);
    const wLa = a.wL + props.runoffWidthL[idxs[k] % track.samples.length] * 0.9;
    const wRa = a.wR + props.runoffWidthR[idxs[k] % track.samples.length] * 0.9;
    const wLb = b.wL + props.runoffWidthL[idxs[k + step] % track.samples.length] * 0.9;
    const wRb = b.wR + props.runoffWidthR[idxs[k + step] % track.samples.length] * 0.9;
    // top slab
    acc.quad(
      [a.x + a.nx * wLa, a.y + a.ny * wLa, a.z - 0.35],
      [b.x + b.nx * wLb, b.y + b.ny * wLb, b.z - 0.35],
      [b.x - b.nx * wRb, b.y - b.ny * wRb, b.z - 0.35],
      [a.x - a.nx * wRa, a.y - a.ny * wRa, a.z - 0.35],
    );
    // side walls down to ground (both sides)
    for (const side of [-1, 1] as const) {
      const wa = side < 0 ? wLa : wRa;
      const wb = side < 0 ? wLb : wRb;
      const ax = a.x + a.nx * wa * side;
      const ay = a.y + a.ny * wa * side;
      const bx = b.x + b.nx * wb * side;
      const by = b.y + b.ny * wb * side;
      const gA = ctx.groundAt(ax, ay, a.z - 6) - 0.6;
      const gB = ctx.groundAt(bx, by, b.z - 6) - 0.6;
      acc.quad([ax, ay, gA], [bx, by, gB], [bx, by, b.z - 0.35], [ax, ay, a.z - 0.35]);
    }
  }
}

/** Hillside shelf: half-podium with posts on the downhill side. */
function buildShelf(
  sp: { sStart: number; sEnd: number; side: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const acc = ctx.acc!;
  const deck = ctx.deck!;
  const step = 2;
  const side = (sp.side || 1) as -1 | 1; // downhill side (fill side)
  for (let k = 0; k < idxs.length - step; k += step) {
    const a = ctx.frameAt(idxs[k]);
    const b = ctx.frameAt(idxs[k + step]);
    const wA = (side < 0 ? a.wL : a.wR) + 3.5;
    const wB = (side < 0 ? b.wL : b.wR) + 3.5;
    const ax = a.x + a.nx * wA * side;
    const ay = a.y + a.ny * wA * side;
    const bx = b.x + b.nx * wB * side;
    const by = b.y + b.ny * wB * side;
    // downhill face: slab edge + wall to ground
    const gA = ctx.groundAt(ax, ay, a.z - 6) - 0.5;
    const gB = ctx.groundAt(bx, by, b.z - 6) - 0.5;
    acc.quad([ax, ay, gA], [bx, by, gB], [bx, by, b.z - 0.3], [ax, ay, a.z - 0.3]);
    deck.quad(
      [a.x, a.y, a.z - 0.3],
      [b.x, b.y, b.z - 0.3],
      [bx, by, b.z - 0.3],
      [ax, ay, a.z - 0.3],
    );
  }
  void props;
  void groundSampler;
}

/** Terraced embankment: stepped grass benches down the fill slope. */
function buildTerraced(
  sp: { sStart: number; sEnd: number; maxFill: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const acc = ctx.acc!;
  const step = 2;
  for (const side of [-1, 1] as const) {
    for (let k = 0; k < idxs.length - step; k += step) {
      const a = ctx.frameAt(idxs[k]);
      const b = ctx.frameAt(idxs[k + step]);
      const wa = (side < 0 ? a.wL : a.wR) + 3.5;
      const wb = (side < 0 ? b.wL : b.wR) + 3.5;
      const ax = a.x + a.nx * wa * side;
      const ay = a.y + a.ny * wa * side;
      const bx = b.x + b.nx * wb * side;
      const by = b.y + b.ny * wb * side;
      const gA = ctx.groundAt(ax, ay, a.z - sp.maxFill) - 0.3;
      const gB = ctx.groundAt(bx, by, b.z - sp.maxFill) - 0.3;
      // two terraces: mid bench + toe
      const midA = (a.z + gA) / 2;
      const midB = (b.z + gB) / 2;
      const runOut = 2.2;
      acc.quad([ax, ay, a.z - 0.15], [bx, by, b.z - 0.15], [bx + b.nx * runOut * side, by + b.ny * runOut * side, midB], [ax + a.nx * runOut * side, ay + a.ny * runOut * side, midA]);
      const a2x = ax + a.nx * runOut * side;
      const a2y = ay + a.ny * runOut * side;
      const b2x = bx + b.nx * runOut * side;
      const b2y = by + b.ny * runOut * side;
      acc.quad([a2x, a2y, midA], [b2x, b2y, midB], [b2x + b.nx * runOut * side, b2y + b.ny * runOut * side, gB], [a2x + a.nx * runOut * side, a2y + a.ny * runOut * side, gA]);
    }
  }
  void props;
  void groundSampler;
}

/** Gallery (half-tunnel): uphill wall + roof slab + downhill posts/parapet. */
function buildGallery(
  sp: { sStart: number; sEnd: number; side: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const tunnel = ctx.tunnel!;
  const retaining = ctx.retaining!;
  const uphill = (sp.side || 1) as -1 | 1;
  const step = 2;
  for (let k = 0; k < idxs.length - step; k += step) {
    const a = ctx.frameAt(idxs[k]);
    const b = ctx.frameAt(idxs[k + step]);
    const wA = (uphill > 0 ? a.wL : a.wR) + 2.2;
    const wB = (uphill > 0 ? b.wL : b.wR) + 2.2;
    // uphill wall
    const ax = a.x + a.nx * wA * uphill;
    const ay = a.y + a.ny * wA * uphill;
    const bx = b.x + b.nx * wB * uphill;
    const by = b.y + b.ny * wB * uphill;
    retaining.quad([ax, ay, a.z - 0.5], [bx, by, b.z - 0.5], [bx, by, b.z + 6.4], [ax, ay, a.z + 6.4]);
    // roof slab from the uphill wall across to the downhill edge
    const wAo = (uphill > 0 ? a.wR : a.wL) + 1.2;
    const wBo = (uphill > 0 ? b.wR : b.wL) + 1.2;
    const axo = a.x - a.nx * wAo * uphill;
    const ayo = a.y - a.ny * wAo * uphill;
    const bxo = b.x - b.nx * wBo * uphill;
    const byo = b.y - b.ny * wBo * uphill;
    tunnel.quad([ax, ay, a.z + 6.4], [bx, by, b.z + 6.4], [bxo, byo, b.z + 6.4], [axo, ayo, a.z + 6.4]);
    // downhill posts + parapet every ~9 m
    if (k % 9 === 0) {
      const gA = ctx.groundAt(axo, ayo, a.z - 8);
      if (a.z + 6.4 - gA > 2) {
        retaining.quad(
          [axo - 0.35, ayo, gA - 0.5],
          [axo + 0.35, ayo, gA - 0.5],
          [axo + 0.35, ayo, a.z + 6.4],
          [axo - 0.35, ayo, a.z + 6.4],
        );
      }
    }
  }
  void props;
  void groundSampler;
}

/** Bench: open cut face uphill + low toe wall downhill. */
function buildBench(
  sp: { sStart: number; sEnd: number; side: number },
  idxs: number[],
  ctx: BuildCtx,
  track: Track,
  props: Track["props"],
  groundSampler: ((x: number, y: number) => number | null) | null,
): void {
  const retaining = ctx.retaining!;
  const uphill = (sp.side || 1) as -1 | 1;
  const down = -uphill as -1 | 1;
  const step = 2;
  for (let k = 0; k < idxs.length - step; k += step) {
    const a = ctx.frameAt(idxs[k]);
    const b = ctx.frameAt(idxs[k + step]);
    // uphill cut face (rocky)
    const wAu = (uphill > 0 ? a.wL : a.wR) + 2.4;
    const wBu = (uphill > 0 ? b.wL : b.wR) + 2.4;
    const axu = a.x + a.nx * wAu * uphill;
    const ayu = a.y + a.ny * wAu * uphill;
    const bxu = b.x + b.nx * wBu * uphill;
    const byu = b.y + b.ny * wBu * uphill;
    const gA = ctx.groundAt(axu + a.nx * 3 * uphill, ayu + a.ny * 3 * uphill, a.z - 4);
    const gB = ctx.groundAt(bxu + b.nx * 3 * uphill, byu + b.ny * 3 * uphill, b.z - 4);
    const topA = Math.max(gA + 0.6, a.z + 1.1);
    const topB = Math.max(gB + 0.6, b.z + 1.1);
    retaining.quad([axu, ayu, a.z - 0.5], [bxu, byu, b.z - 0.5], [bxu, byu, topB], [axu, ayu, topA]);
    // low toe wall downhill
    const wAd = (down > 0 ? a.wL : a.wR) + 2.6;
    const wBd = (down > 0 ? b.wL : b.wR) + 2.6;
    const axd = a.x + a.nx * wAd * down;
    const ayd = a.y + a.ny * wAd * down;
    const bxd = b.x + b.nx * wBd * down;
    const byd = b.y + b.ny * wBd * down;
    retaining.quad([axd, ayd, a.z - 1.6], [bxd, byd, b.z - 1.6], [bxd, byd, b.z + 0.5], [axd, ayd, a.z + 0.5]);
  }
  void props;
  void groundSampler;
}

/** Legacy retaining wall builder (used for dual-retaining). */
function buildRetainingLegacy(
  sp: { sStart: number; sEnd: number; side: string },
  idxs: number[],
  ctx: BuildCtx,
  sideOverride: "both" | "left" | "right",
): void {
  const acc = ctx.acc ?? ctx.retaining!;
  const side = sp.side === "both" ? "both" : sp.side;
  const sides: (-1 | 1)[] = sideOverride === "both" || side === "both" ? [-1, 1] : side === "left" ? [-1] : [1];
  for (const side2 of sides) {
    const line: { x: number; y: number; z: number; top: number }[] = [];
    for (let k = 0; k < idxs.length; k++) {
      const a = ctx.frameAt(idxs[k]);
      const w = (side2 < 0 ? a.wL : a.wR) + 2.2;
      const x = a.x + a.nx * w * side2;
      const y = a.y + a.ny * w * side2;
      const g = ctx.groundAt(x + a.nx * 3 * side2, y + a.ny * 3 * side2, a.z + 3);
      line.push({ x, y, z: a.z - 0.6, top: Math.max(g + 0.7, a.z + 1.2) });
    }
    const sm = smoothLine(line.map((p) => p.top), 4);
    for (let k = 0; k < line.length - 1; k++) {
      const a = line[k];
      const b = line[k + 1];
      acc.quad([a.x, a.y, a.z], [b.x, b.y, b.z], [b.x, b.y, sm[k + 1]], [a.x, a.y, sm[k]]);
      const fA = ctx.frameAt(idxs[k]);
      acc.quad(
        [a.x, a.y, sm[k]],
        [b.x, b.y, sm[k + 1]],
        [b.x + -Math.sin(fA.heading) * 0.6 * side2, b.y + Math.cos(fA.heading) * 0.6 * side2, sm[k + 1]],
        [a.x + -Math.sin(fA.heading) * 0.6 * side2, a.y + Math.cos(fA.heading) * 0.6 * side2, sm[k]],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// feature geometry: pit lane ribbon, service road crossing
// ---------------------------------------------------------------------------

export function buildFeatureMeshes(track: Track): StructureMeshPart[] {
  const feats = track.features ?? [];
  const n = track.samples.length;
  const ds = track.ds;
  const props = track.props;
  const pit = new GeoAcc();
  const pitWall = new GeoAcc();
  const service = new GeoAcc();

  const frameAt = (i: number): Frame => {
    const s = track.samples[((i % n) + n) % n];
    const ii = ((i % n) + n) % n;
    return {
      x: s.x,
      y: s.y,
      z: s.z,
      nx: -Math.sin(s.heading),
      ny: Math.cos(s.heading),
      wL: props.widthL[ii],
      wR: props.widthR[ii],
      heading: s.heading,
    };
  };

  for (const f of feats) {
    if (f.kind === "pit-lane" && track.facilities?.pitLane) continue; // canonical facility plan owns the pit lane now
    if (f.kind === "pit-lane") {
      const i0 = Math.round(f.sStart / ds);
      const i1 = Math.round(f.sEnd / ds);
      const len = ((i1 - i0) % n + n) % n || n;
      const laneW = 7;
      const gapW = 2.2; // grass/wall strip between track and lane
      // lane runs on the right of the main straight
      for (let k = 0; k < len; k += 2) {
        const a = frameAt(i0 + k);
        const b = frameAt(i0 + k + 2);
        const ease = (x: number) => x * x * (3 - 2 * x);
        // taper in/out over the first/last 15% of the span
        const tA = Math.min(1, Math.min(k, len - k) / (len * 0.15));
        const offA0 = a.wR + gapW + laneW * (1 - ease(Math.max(0, tA)));
        const offA1 = offA0 + laneW * ease(Math.max(0, tA));
        const tB = Math.min(1, Math.min(k + 2, len - k - 2) / (len * 0.15));
        const offB0 = b.wR + gapW + laneW * (1 - ease(Math.max(0, tB)));
        const offB1 = offB0 + laneW * ease(Math.max(0, tB));
        // lane deck (right side = negative offset in mesh convention: use -)
        pit.quad(
          [a.x - a.nx * offA0, a.y - a.ny * offA0, a.z + 0.02],
          [b.x - b.nx * offB0, b.y - b.ny * offB0, b.z + 0.02],
          [b.x - b.nx * offB1, b.y - b.ny * offB1, b.z + 0.02],
          [a.x - a.nx * offA1, a.y - a.ny * offA1, a.z + 0.02],
        );
        // low pit wall on the track side of the gap
        if (tA > 0.95 && tB > 0.95) {
          const wA = a.wR + 0.6;
          const wB = b.wR + 0.6;
          pitWall.quad(
            [a.x - a.nx * wA, a.y - a.ny * wA, a.z],
            [b.x - b.nx * wB, b.y - b.ny * wB, b.z],
            [b.x - b.nx * wB, b.y - b.ny * wB, b.z + 0.55],
            [a.x - a.nx * wA, a.y - a.ny * wA, a.z + 0.55],
          );
        }
      }
    } else if (f.kind === "service-road") {
      const iMid = Math.round(((f.sStart + f.sEnd) / 2) / ds);
      const fr = frameAt(iMid);
      const half = 2.1;
      const ext = Math.max(28, fr.wL + fr.wR + 18);
      // narrow strip crossing perpendicular-ish (slight skew)
      const skew = 0.12;
      const tx = Math.cos(fr.heading);
      const ty = Math.sin(fr.heading);
      const corners = [
        [fr.x + fr.nx * ext + tx * -half - fr.nx * skew * ext, fr.y + fr.ny * ext + ty * -half - fr.ny * skew * ext],
        [fr.x - fr.nx * ext + tx * -half + fr.nx * skew * ext, fr.y - fr.ny * ext + ty * -half + fr.ny * skew * ext],
        [fr.x - fr.nx * ext + tx * half + fr.nx * skew * ext, fr.y - fr.ny * ext + ty * half + fr.ny * skew * ext],
        [fr.x + fr.nx * ext + tx * half - fr.nx * skew * ext, fr.y + fr.ny * ext + ty * half - fr.ny * skew * ext],
      ];
      service.quad(
        [corners[0][0], corners[0][1], fr.z + 0.03],
        [corners[1][0], corners[1][1], fr.z + 0.03],
        [corners[2][0], corners[2][1], fr.z + 0.03],
        [corners[3][0], corners[3][1], fr.z + 0.03],
      );
    }
  }

  const out: StructureMeshPart[] = [];
  if (pit.idx.length) out.push(pit.finish("pit-lane"));
  if (pitWall.idx.length) out.push(pitWall.finish("pit-wall"));
  if (service.idx.length) out.push(service.finish("service-road"));
  return out;
}
