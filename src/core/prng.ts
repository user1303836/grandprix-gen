/**
 * Deterministic PRNG (mulberry32) plus convenience wrapper.
 * All procedural generation flows through this so that
 * seed + params + generator version fully determines output.
 */

export type PRNG = () => number;

export function mulberry32(seed: number): PRNG {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a style string hash -> uint32 seed. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Combine a base seed with a numeric salt deterministically. */
export function saltSeed(seed: number, salt: number): number {
  let h = seed >>> 0;
  h ^= (salt * 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Rng {
  private next01: PRNG;

  constructor(seed: number) {
    this.next01 = mulberry32(seed >>> 0);
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next01();
  }

  /** Uniform in [-mag, mag). */
  spread(mag: number): number {
    return (this.next01() * 2 - 1) * mag;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next01() < probability;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next01() * arr.length))];
  }

  /** Standard normal via Box-Muller. */
  gaussian(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next01();
    while (v === 0) v = this.next01();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    return mean + std * mag * Math.cos(2.0 * Math.PI * v);
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next01() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Independent child stream. */
  fork(salt: number): Rng {
    return new Rng(saltSeed((this.next01() * 0xffffffff) >>> 0, salt));
  }

  static fromSalt(seed: number, salt: number): Rng {
    return new Rng(saltSeed(seed, salt));
  }
}
