// src/lighting/sparks.ts (WP11) — the SPARKING anomaly's particle burst: ONE permanent mesh added at construction
// (so warmup compiles its program), drawRange 0 while idle, 24 camera-facing streak quads, transparent = false,
// AdditiveBlending, depthWrite = false, renderOrder = 2, HDR clamp. Particles are ~20,000 nits for the first
// 60 ms (they bloom into a brief flash) and then cool from white-yellow to orange while falling.
// The motion is evaluated in the vertex shader from per-particle attributes and uTime (simulation time), so a
// burst costs one attribute upload and no per-frame CPU work.

import * as THREE from 'three';
import { HDR_CLAMP } from '../core/constants.ts';
import { hash2, hash01 } from '../core/rng.ts';

export const SPARK_COUNT = 24;
export const SPARK_FLASH_NITS = 20000;
export const SPARK_FLASH_S = 0.06;
export const SPARK_LIFE_MAX = 0.9;

const VERT = /* glsl */ `
attribute vec2 brCorner;
attribute vec3 brVel;
attribute vec3 brSpark; // x = birth offset (s), y = life (s), z = brightness scale
uniform float uTime;
uniform float uBirth;
varying vec2 vCorner;
varying float vHeat;
varying float vFade;
void main() {
  float tau = uTime - uBirth - brSpark.x;
  vCorner = brCorner;
  if (tau < 0.0 || tau > brSpark.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vHeat = 0.0; vFade = 0.0; return; }
  vec3 g = vec3(0.0, -9.81, 0.0);
  // light drag keeps the arcs short (sparks from a ceiling fixture)
  float drag = 2.2;
  float e = exp(-drag * tau);
  vec3 p = brVel * (1.0 - e) / drag + g * (tau / drag - (1.0 - e) / (drag * drag));
  vec3 v = brVel * e + g * (1.0 - e) / drag;
  vec4 pv = modelViewMatrix * vec4(p, 1.0);
  vec3 vv = (modelViewMatrix * vec4(v, 0.0)).xyz;
  // streak: long axis along the view-space velocity (shutter ~ 1/60 s), short axis across it
  vec2 dir = vv.xy;
  float len2 = dot(dir, dir);
  dir = len2 > 1e-8 ? dir * inversesqrt(len2) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float streak = 0.006 + length(vv) * 0.016;
  float width = 0.0045;
  pv.xy += dir * brCorner.x * streak + nrm * brCorner.y * width;
  gl_Position = projectionMatrix * pv;
  vHeat = tau;
  vFade = brSpark.z * (1.0 - smoothstep(brSpark.y * 0.6, brSpark.y, tau));
}
`;

const FRAG = /* glsl */ `
uniform float uFlashNits;
uniform float uFlashS;
varying vec2 vCorner;
varying float vHeat;
varying float vFade;
void main() {
  float r = length(vCorner * vec2(0.8, 1.0));
  float core = clamp(1.0 - r, 0.0, 1.0);
  core *= core;
  // blackbody-ish cooling: white-yellow -> orange -> dull red
  float cool = clamp((vHeat - uFlashS) / 0.35, 0.0, 1.0);
  vec3 hot = vec3(1.0, 0.86, 0.6);
  vec3 warm = vec3(1.0, 0.42, 0.1);
  vec3 col = mix(hot, warm, cool);
  float nits = vHeat < uFlashS ? uFlashNits : uFlashNits * 0.12 * exp(-(vHeat - uFlashS) / 0.18);
  gl_FragColor = vec4(min(col * nits * core * vFade, vec3(${HDR_CLAMP.toFixed(1)})), 1.0);
}
`;

export interface Sparks {
  readonly mesh: THREE.Mesh;
  /** Start a burst at world (x, y, z) at simulation time t (reuses all 24 quads). */
  burst(x: number, y: number, z: number, strength: number, t: number, seed: number): void;
  /** Per frame: advance uTime; hides the mesh (drawRange 0) once the burst is over. */
  update(t: number): void;
  readonly active: boolean;
  dispose(): void;
}

export function createSparks(scene: THREE.Scene): Sparks {
  const n = SPARK_COUNT;
  const geo = new THREE.BufferGeometry();
  const corner = new Float32Array(n * 4 * 2);
  const vel = new Float32Array(n * 4 * 3);
  const spark = new Float32Array(n * 4 * 3);
  const pos = new Float32Array(n * 4 * 3); // unused by the shader (three requires 'position')
  const index = new Uint16Array(n * 6);
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 4; v++) { corner[(i * 4 + v) * 2] = C[v * 2]; corner[(i * 4 + v) * 2 + 1] = C[v * 2 + 1]; }
    const b = i * 4;
    index.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('brCorner', new THREE.BufferAttribute(corner, 2));
  const velAttr = new THREE.BufferAttribute(vel, 3);
  velAttr.setUsage(THREE.DynamicDrawUsage);
  const sparkAttr = new THREE.BufferAttribute(spark, 3);
  sparkAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('brVel', velAttr);
  geo.setAttribute('brSpark', sparkAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1, 0), 3.5);
  geo.setDrawRange(0, 0);

  const uniforms = {
    uTime: { value: 0 },
    uBirth: { value: -1e6 },
    uFlashNits: { value: SPARK_FLASH_NITS },
    uFlashS: { value: SPARK_FLASH_S },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'br-sparks',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sparks';
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.matrixAutoUpdate = true;
  scene.add(mesh);

  let endT = -1;
  let active = false;
  const sp: Sparks = {
    mesh,
    get active() { return active; },
    burst(x, y, z, strength, t, seed) {
      mesh.position.set(x, y, z);
      mesh.updateMatrix();
      uniforms.uBirth.value = t;
      let maxLife = 0;
      for (let i = 0; i < n; i++) {
        const h = hash2(seed | 0, i);
        const u = (k: number): number => hash01(hash2(h, k));
        // mostly downward/outward spray from the fixture
        const az = u(1) * Math.PI * 2;
        const el = -0.2 - u(2) * 1.2; // below the horizon
        const sp0 = (1.2 + u(3) * 3.3) * (0.6 + 0.4 * strength);
        const vx = Math.cos(az) * Math.cos(el) * sp0;
        const vy = Math.sin(el) * sp0 + 0.8 * u(4);
        const vz = Math.sin(az) * Math.cos(el) * sp0;
        const delay = u(5) * 0.05;
        const life = 0.25 + u(6) * (SPARK_LIFE_MAX - 0.25);
        const bright = (0.35 + 0.65 * u(7)) * strength;
        if (delay + life > maxLife) maxLife = delay + life;
        for (let v = 0; v < 4; v++) {
          const o = (i * 4 + v) * 3;
          vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
          spark[o] = delay; spark[o + 1] = life; spark[o + 2] = bright;
        }
      }
      velAttr.needsUpdate = true;
      sparkAttr.needsUpdate = true;
      endT = t + maxLife;
      geo.setDrawRange(0, n * 6);
      active = true;
    },
    update(t) {
      uniforms.uTime.value = t;
      if (active && (t > endT || t < uniforms.uBirth.value)) {
        active = false;
        geo.setDrawRange(0, 0);
      }
    },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
  return sp;
}
