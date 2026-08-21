/**
 * Weather: rain mode. Wet asphalt (low roughness = reflective sheen),
 * rain streak particles around the camera, heavy overcast light.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  PointsMaterial,
} from "three";

export class RainSystem {
  readonly points: Points;
  private velocities: Float32Array;
  private area = 160; // m box around the camera
  private count: number;

  constructor(count = 1600) {
    this.count = count;
    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * this.area;
      positions[i * 3 + 1] = Math.random() * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * this.area;
      this.velocities[i] = 22 + Math.random() * 14;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    const mat = new PointsMaterial({
      color: new Color(0x9ab4cc),
      size: 0.26,
      transparent: true,
      opacity: 0.42,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  setActive(v: boolean): void {
    this.points.visible = v;
  }

  /** Keep the volume centered on the camera; fall the drops. */
  update(dt: number, camX: number, camY: number, camZ: number): void {
    if (!this.points.visible) return;
    const attr = this.points.geometry.attributes.position;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      arr[i * 3 + 1] -= this.velocities[i] * dt;
      if (arr[i * 3 + 1] < camY - 12) {
        arr[i * 3 + 1] = camY + 45 + Math.random() * 15;
        arr[i * 3] = camX + (Math.random() - 0.5) * this.area;
        arr[i * 3 + 2] = camZ + (Math.random() - 0.5) * this.area;
      }
    }
    attr.needsUpdate = true;
  }
}
