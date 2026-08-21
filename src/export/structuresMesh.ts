/**
 * Structure meshes: the visible concrete/rock/earth that seats the road
 * into the landscape wherever it leaves the ground plane. Bridges get
 * decks, edge beams, parapets and piers; cuts get retaining walls or rock
 * faces; deep bores get tunnel tubes with portals; fills get grass
 * embankment skirts. Positions use the track-mesh convention
 * [x, y_plan, z_up]; the viewer converts.
 */

import type { Track } from "../core/types";

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
  groundSampler: ((x: number, y: number) => number) | null,
): StructureMeshPart[] {
  const spans = track.structures ?? [];
  if (spans.length === 0) return [];
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
    return Number.isFinite(g) ? g : fallback;
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

    if (sp.kind === "bridge") {
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
      const sides: (-1 | 1)[] = sp.side === "both" ? [-1, 1] : sp.side === "left" ? [-1] : [1];
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
