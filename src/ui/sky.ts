/**
 * Stylized sky dome: saturated gradient, sun disk + halo, drifting fbm
 * clouds, and a star field + moon for night. Art-directed (not physical)
 * so every time of day reads beautifully at any framing.
 */

import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

export interface SkyStyle {
  zenith: number;
  horizon: number;
  ground: number;
  sunColor: number;
  sunIntensity: number;
  cloudCover: number; // 0..1
  cloudTint: number;
  stars: number; // 0..1 star field visibility
  haze: number; // horizon haze thickness
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunColor;
uniform float sunIntensity;
uniform vec3 sunDir;
uniform float cloudCover;
uniform vec3 cloudTint;
uniform float stars;
uniform float haze;
uniform float time;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1));
  float d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.13 + 17.7;
    a *= 0.52;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;

  // base gradient
  float hz = pow(clamp(y * 1.6 + 0.06, 0.0, 1.0), 0.62);
  vec3 col = mix(horizon, zenith, hz);
  if (y < 0.0) {
    col = mix(horizon, ground, clamp(-y * 4.0, 0.0, 1.0));
  }
  // horizon haze band
  col = mix(col, horizon, exp(-abs(y) * 22.0) * haze);

  // sun disk + halo
  float sd = dot(dir, sunDir);
  float halo = pow(clamp(sd, 0.0, 1.0), 24.0) * 0.5 + pow(clamp(sd, 0.0, 1.0), 350.0) * 1.4;
  float disk = smoothstep(0.99965, 0.99985, sd);
  col += sunColor * (halo * 0.55 + disk * 2.2) * sunIntensity;

  // clouds (projected on a virtual plane above)
  if (y > 0.015 && cloudCover > 0.001) {
    vec2 cuv = dir.xz / (y + 0.12);
    cuv = cuv * 1.6 + vec2(time * 0.008, time * 0.0027);
    float c = fbm(cuv);
    float cov = smoothstep(1.0 - cloudCover * 0.9, 1.25 - cloudCover * 0.4, c);
    float shade = fbm(cuv * 2.7 + 4.2);
    vec3 cloudCol = cloudTint * (0.82 + shade * 0.35);
    // sun-lit edges on the sun side
    float lit = pow(clamp(sd, 0.0, 1.0), 6.0);
    cloudCol += sunColor * lit * 0.35 * sunIntensity;
    float fade = smoothstep(0.015, 0.12, y); // fade at the horizon
    col = mix(col, cloudCol, cov * 0.82 * fade);
  }

  // stars
  if (stars > 0.001 && y > 0.02) {
    vec2 sp = dir.xz / (dir.y + 0.35) * 160.0;
    vec2 cell = floor(sp);
    float h = hash21(cell);
    float star = step(0.9965, h);
    float tw = 0.6 + 0.4 * sin(time * (1.5 + h * 4.0) + h * 40.0);
    vec2 f = fract(sp) - 0.5;
    float dot2 = smoothstep(0.16, 0.02, length(f));
    col += vec3(0.9, 0.93, 1.0) * star * dot2 * tw * stars * smoothstep(0.02, 0.25, y);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyDome {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;
  private sunDir = new Vector3(0.3, 0.6, 0.4).normalize();

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        zenith: { value: new Color(0x2a5a9e) },
        horizon: { value: new Color(0xadc6de) },
        ground: { value: new Color(0x6a7c8a) },
        sunColor: { value: new Color(0xfff3dc) },
        sunIntensity: { value: 1.0 },
        sunDir: { value: this.sunDir },
        cloudCover: { value: 0.35 },
        cloudTint: { value: new Color(0xf4f6f8) },
        stars: { value: 0 },
        haze: { value: 0.35 },
        time: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 32, 20), this.mat);
    this.mesh.scale.setScalar(28000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  setStyle(style: SkyStyle): void {
    const u = this.mat.uniforms;
    u.zenith.value.setHex(style.zenith);
    u.horizon.value.setHex(style.horizon);
    u.ground.value.setHex(style.ground);
    u.sunColor.value.setHex(style.sunColor);
    u.sunIntensity.value = style.sunIntensity;
    u.cloudCover.value = style.cloudCover;
    u.cloudTint.value.setHex(style.cloudTint);
    u.stars.value = style.stars;
    u.haze.value = style.haze;
  }

  setSunDirection(dir: Vector3): void {
    this.sunDir.copy(dir).normalize();
    this.mat.uniforms.sunDir.value = this.sunDir;
  }

  setTime(t: number): void {
    this.mat.uniforms.time.value = t;
  }

  setPosition(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
  }
}
