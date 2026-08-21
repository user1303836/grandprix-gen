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
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
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
      // tube: arc over the road; portals at both ends
      const SEG = 10;
      const step = 2;
      const tubeLen = idxs.length;
      for (let k = 0; k < tubeLen - step; k += step) {
        const a = frameAt(idxs[k]);
        const b = frameAt(idxs[k + step]);
        const rA = a.wL + a.wR + 2.5;
        const rB = b.wL + b.wR + 2.5;
        for (let sgm = 0; sgm < SEG; sgm++) {
          const t0 = (sgm / SEG) * Math.PI;
          const t1 = ((sgm + 1) / SEG) * Math.PI;
          // arc from left ground level over the top to the right
          const p00 = [a.x + a.nx * Math.cos(t0) * rA * -1, a.y + a.ny * Math.cos(t0) * rA * -1, a.z + Math.sin(t0) * rA * 0.85 + 0.4];
          const p01 = [a.x + a.nx * Math.cos(t1) * rA * -1, a.y + a.ny * Math.cos(t1) * rA * -1, a.z + Math.sin(t1) * rA * 0.85 + 0.4];
          const p10 = [b.x + b.nx * Math.cos(t0) * rB * -1, b.y + b.ny * Math.cos(t0) * rB * -1, b.z + Math.sin(t0) * rB * 0.85 + 0.4];
          const p11 = [b.x + b.nx * Math.cos(t1) * rB * -1, b.y + b.ny * Math.cos(t1) * rB * -1, b.z + Math.sin(t1) * rB * 0.85 + 0.4];
          tunnel.quad(p00, p10, p11, p01);
        }
      }
      // portals: ring frames slightly proud of the tube at both ends
      for (const endI of [idxs[0], idxs[idxs.length - 1]]) {
        const f = frameAt(endI);
        const r = f.wL + f.wR + 2.5;
        const R = r + 1.6;
        for (let sgm = 0; sgm < SEG; sgm++) {
          const t0 = (sgm / SEG) * Math.PI;
          const t1 = ((sgm + 1) / SEG) * Math.PI;
          const p0 = [f.x + f.nx * Math.cos(t0) * r * -1, f.y + f.ny * Math.cos(t0) * r * -1, f.z + Math.sin(t0) * r * 0.85 + 0.4];
          const p1 = [f.x + f.nx * Math.cos(t1) * r * -1, f.y + f.ny * Math.cos(t1) * r * -1, f.z + Math.sin(t1) * r * 0.85 + 0.4];
          const q0 = [f.x + f.nx * Math.cos(t0) * R * -1, f.y + f.ny * Math.cos(t0) * R * -1, f.z + Math.sin(t0) * R * 0.85 + 0.4];
          const q1 = [f.x + f.nx * Math.cos(t1) * R * -1, f.y + f.ny * Math.cos(t1) * R * -1, f.z + Math.sin(t1) * R * 0.85 + 0.4];
          portals.quad(p0, q0, q1, p1);
        }
      }
    } else if (sp.kind === "retaining" || sp.kind === "rock-cut") {
      const acc = sp.kind === "retaining" ? retaining : rock;
      const step = 2;
      const sides: (-1 | 1)[] = sp.side === "both" ? [-1, 1] : sp.side === "left" ? [-1] : [1];
      for (const side of sides) {
        for (let k = 0; k < idxs.length - step; k += step) {
          const a = frameAt(idxs[k]);
          const b = frameAt(idxs[k + step]);
          const wa = (side < 0 ? a.wL : a.wR) + 2.2;
          const wb = (side < 0 ? b.wL : b.wR) + 2.2;
          const ax = a.x + a.nx * wa * side;
          const ay = a.y + a.ny * wa * side;
          const bx = b.x + b.nx * wb * side;
          const by = b.y + b.ny * wb * side;
          // wall from below road level up to ground (+ cap)
          const gA = groundAt(ax + a.nx * 3 * side, ay + a.ny * 3 * side, a.z - sp.minD);
          const gB = groundAt(bx + b.nx * 3 * side, by + b.ny * 3 * side, b.z - sp.minD);
          const topA = Math.max(gA + 0.7, a.z + 1.2);
          const topB = Math.max(gB + 0.7, b.z + 1.2);
          const botA = a.z - 0.6;
          const botB = b.z - 0.6;
          acc.quad(
            [ax, ay, botA],
            [bx, by, botB],
            [bx, by, topB],
            [ax, ay, topA],
          );
          // cap
          acc.quad(
            [ax, ay, topA],
            [bx, by, topB],
            [bx + b.nx * 0.6 * side, by + b.ny * 0.6 * side, topB],
            [ax + a.nx * 0.6 * side, ay + a.ny * 0.6 * side, topA],
          );
        }
      }
    } else if (sp.kind === "embankment") {
      // grass skirts sloping from the corridor edge down to the ground
      const step = 2;
      for (const side of [-1, 1] as const) {
        for (let k = 0; k < idxs.length - step; k += step) {
          const a = frameAt(idxs[k]);
          const b = frameAt(idxs[k + step]);
          const wa = (side < 0 ? a.wL : a.wR) + 4;
          const wb = (side < 0 ? b.wL : b.wR) + 4;
          const ax = a.x + a.nx * wa * side;
          const ay = a.y + a.ny * wa * side;
          const bx = b.x + b.nx * wb * side;
          const by = b.y + b.ny * wb * side;
          const runA = Math.max(3.5, (a.z - groundAt(ax, ay, a.z)) * 1.4 + 2);
          const runB = Math.max(3.5, (b.z - groundAt(bx, by, b.z)) * 1.4 + 2);
          const oxA = ax + a.nx * runA * side;
          const oyA = ay + a.ny * runA * side;
          const oxB = bx + b.nx * runB * side;
          const oyB = by + b.ny * runB * side;
          const gA = groundAt(oxA, oyA, a.z - sp.maxD) - 0.25;
          const gB = groundAt(oxB, oyB, b.z - sp.maxD) - 0.25;
          embank.quad(
            [ax, ay, a.z - 0.12],
            [bx, by, b.z - 0.12],
            [oxB, oyB, gB],
            [oxA, oyA, gA],
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
