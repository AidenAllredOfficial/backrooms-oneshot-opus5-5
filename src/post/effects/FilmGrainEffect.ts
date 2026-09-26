// src/post/effects/FilmGrainEffect.ts (WP11) — luminance-dependent sensor grain + the display encode.
// The last effect of the last pass: it converts the finished linear image to sRGB-encoded values, adds grain in
// that (perceptual) domain and outputs encoded values; the pass renders them into an RGBA8 target with
// EffectPass dithering (so the dither also lives in the encoded domain) and PostStack blits that raw to the canvas.
// sigma = grain * sensor gain (PostStack computes uGrain.x): dark footage gets noisier. Luma noise is spatially
// correlated (1.5 px lattice, bilinear) plus a fine per-pixel part; chroma noise grows in the deep shadows; the
// result is floored softly at a quarter of the grade's black pedestal (uGrain.w), never clamped to 0.
// The frame index is floor(t * 24) of SIMULATION time, so captures under time= are deterministic.
// No mainUv, no convolution: merges with LensEffect.

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export const GRAIN_FRAG = /* glsl */ `
uniform vec4 uGrain; // x sigma (encoded units at mid grey), y frame index, z chroma fraction, w pedestal (encoded)
uvec3 brGrainPcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 brGrainEnc(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// one unit gaussian per lattice point (Box-Muller on two PCG outputs)
float brGrainGauss(uvec2 p, uint fr) {
  uvec3 h = brGrainPcg(uvec3(p, fr ^ 0x5bd1u));
  vec2 u = vec2(h.xy >> 8u) * (1.0 / 16777216.0);
  return sqrt(-2.0 * log(max(u.x, 1e-7))) * cos(6.2831853 * u.y);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 e = brGrainEnc(clamp(inputColor.rgb, 0.0, 1.0));
  float sigma = uGrain.x;
  if (sigma > 0.0) {
    uint fr = uint(uGrain.y);
    uvec3 h = brGrainPcg(uvec3(uvec2(gl_FragCoord.xy), fr));
    vec3 u = vec3(h >> 8u) * (1.0 / 16777216.0);
    float r = sqrt(-2.0 * log(max(u.x, 1e-7)));
    float g0 = r * cos(6.2831853 * u.y);
    float g1 = r * sin(6.2831853 * u.y);
    float g2 = (u.z - 0.5) * 3.4641;
    // spatially correlated sensor noise: gaussians on a 1.5 px lattice, bilinear, renormalised to unit variance
    vec2 cp = gl_FragCoord.xy * (1.0 / 1.5);
    vec2 ci = floor(cp);
    vec2 f = cp - ci;
    uvec2 c0 = uvec2(ci);
    float n00 = brGrainGauss(c0, fr);
    float n10 = brGrainGauss(c0 + uvec2(1u, 0u), fr);
    float n01 = brGrainGauss(c0 + uvec2(0u, 1u), fr);
    float n11 = brGrainGauss(c0 + uvec2(1u, 1u), fr);
    vec2 a = 1.0 - f;
    vec4 wq = vec4(a.x * a.y, f.x * a.y, a.x * f.y, f.x * f.y);
    float nc = dot(wq, vec4(n00, n10, n01, n11)) * inversesqrt(max(dot(wq, wq), 1e-4));
    float y = dot(e, vec3(0.2126, 0.7152, 0.0722));
    // video-like: visible in the blacks, strongest in the low mids, calmer in the bright mids, gone in the clip
    float w = (0.8 + 0.5 * sqrt(y)) * (1.0 - 0.45 * smoothstep(0.35, 0.8, y)) * (1.0 - 0.85 * smoothstep(0.8, 1.0, y));
    float n = (0.8 * nc + 0.6 * g0) * sigma * w;
    // chroma noise grows in the deep shadows (a camcorder at high gain: blotchy colour speckle in the murk)
    float cf = uGrain.z * mix(1.8, 1.0, smoothstep(0.0, 0.15, y));
    vec3 cn = vec3(g1, -0.5 * g1 - 0.3 * g2, g2) * (sigma * w * cf);
    // noise sits around the black pedestal with a soft floor (no clamp-to-zero crush of the zero-mean noise)
    e = max(e + n + cn, vec3(0.25 * uGrain.w));
  }
  outputColor = vec4(e, inputColor.a);
}
`;

export class FilmGrainEffect extends Effect {
  private readonly uGrain: THREE.Uniform<THREE.Vector4>;
  constructor() {
    const uGrain = new THREE.Uniform(new THREE.Vector4(0.014, 0, 0.35, 0));
    super('FilmGrainEffect', GRAIN_FRAG, {
      attributes: EffectAttribute.NONE,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['uGrain', uGrain]]),
    });
    this.uGrain = uGrain;
  }
  /** sigma in sRGB-encoded units; frame = floor(t * 24); pedestal = the grade's encoded black level. */
  setGrain(sigma: number, frame: number, chroma: number, pedestal = 0): void {
    this.uGrain.value.set(Math.max(0, sigma), frame, chroma, Math.max(0, pedestal));
  }
}
