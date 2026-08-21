/**
 * Tire spray: small gray mist particles kicked up behind cars in the wet.
 * CPU-updated points, cheap (a few hundred alive at once).
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  PointsMaterial,
} from "three";

const MAX = 700;

export class SpraySystem {
  readonly points: Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private head = 0;

  constructor() {
    this.pos = new Float32Array(MAX * 3).fill(-10000);
    this.vel = new Float32Array(MAX * 3);
    this.age = new Float32Array(MAX).fill(1e9);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(this.pos, 3));
    const mat = new PointsMaterial({
      color: new Color(0xb8c4cc),
      size: 1.05,
      transparent: true,
      opacity: 0.2,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
  }

  /** Emit a couple of droplets behind a car (velocity = car backward dir). */
  emit(x: number, y: number, z: number, vx: number, vz: number): void {
    for (let k = 0; k < 1; k++) {
      const i = this.head;
      this.head = (this.head + 1) % MAX;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 1.6;
      this.pos[i * 3 + 1] = y + Math.random() * 0.4;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 1.6;
      this.vel[i * 3] = vx + (Math.random() - 0.5) * 3;
      this.vel[i * 3 + 1] = 2.5 + Math.random() * 3.5;
      this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 3;
      this.age[i] = 0;
    }
  }

  update(dt: number): void {
    const attr = this.points.geometry.attributes.position;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] > 1.4) continue;
      this.age[i] += dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 4.5 * dt; // droplets fall back
      if (this.age[i] > 1.4) {
        this.pos[i * 3 + 1] = -10000; // retired below the world (never NaN)
      }
    }
    attr.needsUpdate = true;
  }
}
