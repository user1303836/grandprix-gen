/**
 * Animated water: fbm ripple normals, sun glint, fresnel-ish brightening.
 * And a drifting cloud-shadow layer: a huge translucent plane with
 * scrolling fbm alpha that reads as clouds sweeping the landscape.
 */

import {
  Color,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from "three";

const NOISE_GLSL = /* glsl */ `
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
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.11 + 19.3;
    a *= 0.5;
  }
  return v;
}
`;

export function makeWaterMaterial(sunDir: Vector3): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      sunDir: { value: sunDir },
      deep: { value: new Color(0x1c3a52) },
      shallow: { value: new Color(0x2b5a74) },
      sunColor: { value: new Color(0xfff2dd) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float time;
      uniform vec3 sunDir;
      uniform vec3 deep;
      uniform vec3 shallow;
      uniform vec3 sunColor;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vWorld.xz * 0.08;
        float n1 = fbm(p + vec2(time * 0.14, time * 0.06));
        float n2 = fbm(p * 1.7 - vec2(time * 0.11, time * 0.09));
        vec3 nrm = normalize(vec3((n1 - 0.5) * 0.6, 1.0, (n2 - 0.5) * 0.6));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(viewDir, nrm), 0.0), 3.0);
        vec3 col = mix(deep, shallow, n1 * 0.7 + fres * 0.3);
        // sun glints
        vec3 hv = normalize(viewDir + sunDir);
        float spec = pow(max(dot(nrm, hv), 0.0), 220.0) * 2.2;
        col += sunColor * spec;
        // sky-ish fresnel lift
        col += vec3(0.35, 0.45, 0.55) * fres * 0.4;
        gl_FragColor = vec4(col, 0.93);
      }
    `,
    transparent: true,
    side: DoubleSide,
  });
}

export class CloudShadows {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: { time: { value: 0 }, strength: { value: 0.32 } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        uniform float time;
        uniform float strength;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vWorld.xz * 0.00055 + vec2(time * 0.011, time * 0.004);
          float c = fbm(p);
          float a = smoothstep(0.52, 0.78, c) * strength;
          gl_FragColor = vec4(0.02, 0.03, 0.05, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const geo = new PlaneGeometry(1, 1);
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 5;
  }

  configure(centerX: number, centerZ: number, y: number, size: number, strength = 0.32): void {
    this.mesh.position.set(centerX, y, centerZ);
    this.mesh.scale.set(size, size, 1);
    this.mat.uniforms.strength.value = strength;
  }

  setTime(t: number): void {
    this.mat.uniforms.time.value = t;
  }
}
