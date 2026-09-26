// src/post/effects/ExposureEffect.ts (WP11, R2-post) — multiplies the HDR image (nits) by the camera exposure.
// Sits after BloomEffect in the same EffectPass, so the bloom is exposed together with the image.
// R2-post halation: before exposing, it re-adds the two coarsest mips of the bloom's mipmap blur (in nits, like the
// bloom itself) tinted warm (uHalo.rgb = tint * strength): the wide, warm veil a cheap consumer lens throws around
// bright fluorescent panels. uHalo = 0 (bloom off) makes the two samplers dead code at runtime.
// R2-post vignette: the cos^4 natural vignetting moved here from LensEffect (optics act on scene radiance, before
// the sensor clips): a clipped troffer near the frame edge stays pure white instead of greying out.

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export const EXPOSURE_FRAG = /* glsl */ `
uniform float uExposure;
uniform vec3 uHalo;
uniform sampler2D uHal0;
uniform sampler2D uHal1;
uniform vec2 uVig; // x vignette exponent (0 = off), y effective tan(fov/2)
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, vec3(0.0));
  if (uHalo.r + uHalo.g + uHalo.b > 0.0) {
    c += uHalo * (texture2D(uHal0, uv).rgb + texture2D(uHal1, uv).rgb);
  }
  float v = 1.0;
  if (uVig.x > 0.0) {
    vec2 q = (uv - 0.5) * 2.0 * vec2(aspect, 1.0) * uVig.y;
    float c2 = 1.0 / (1.0 + dot(q, q));
    v = pow(c2 * c2, uVig.x);
  }
  outputColor = vec4(c * (uExposure * v), inputColor.a);
}
`;

export class ExposureEffect extends Effect {
  private readonly uHalo: THREE.Uniform<THREE.Vector3>;
  private readonly uHal0: THREE.Uniform<THREE.Texture | null>;
  private readonly uHal1: THREE.Uniform<THREE.Texture | null>;
  private readonly uVig: THREE.Uniform<THREE.Vector2>;
  constructor() {
    const uHalo = new THREE.Uniform(new THREE.Vector3(0, 0, 0));
    const uHal0 = new THREE.Uniform<THREE.Texture | null>(null);
    const uHal1 = new THREE.Uniform<THREE.Texture | null>(null);
    const uVig = new THREE.Uniform(new THREE.Vector2(0, 0.33));
    super('ExposureEffect', EXPOSURE_FRAG, {
      attributes: EffectAttribute.NONE,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uExposure', new THREE.Uniform(1)], ['uHalo', uHalo], ['uHal0', uHal0], ['uHal1', uHal1], ['uVig', uVig],
      ]),
    });
    this.uHalo = uHalo;
    this.uHal0 = uHal0;
    this.uHal1 = uHal1;
    this.uVig = uVig;
  }
  /** cos^4 vignette: exponent = Settings.film.vignette (0 disables), tanHalf = effective tan(fov / 2). */
  setVignette(exponent: number, tanHalf: number): void {
    this.uVig.value.set(Math.max(0, exponent), tanHalf);
  }
  get exposure(): number { return (this.uniforms.get('uExposure') as THREE.Uniform<number>).value; }
  set exposure(v: number) { (this.uniforms.get('uExposure') as THREE.Uniform<number>).value = v; }
  /** Halation: two wide blur textures (nits) re-added with weight rgb (0 = off). */
  setHalation(t0: THREE.Texture | null, t1: THREE.Texture | null, r: number, g: number, b: number): void {
    const on = t0 !== null && t1 !== null;
    this.uHal0.value = t0;
    this.uHal1.value = t1;
    this.uHalo.value.set(on ? Math.max(0, r) : 0, on ? Math.max(0, g) : 0, on ? Math.max(0, b) : 0);
  }
}
