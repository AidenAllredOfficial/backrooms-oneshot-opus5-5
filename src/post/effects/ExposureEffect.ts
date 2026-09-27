// src/post/effects/ExposureEffect.ts (WP11, R2-post) — multiplies the HDR image (nits) by the camera exposure.
// Sits after GlareEffect in the same EffectPass, so the lens glare is exposed together with the image. (The R2-post
// warm halation veil that used to be re-added here is gone: package C's energy-conserving glare replaces it.)
// R2-post vignette: the cos^4 natural vignetting moved here from LensEffect (optics act on scene radiance, before
// the sensor clips): a clipped troffer near the frame edge stays pure white instead of greying out.

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export const EXPOSURE_FRAG = /* glsl */ `
uniform float uExposure;
uniform vec2 uVig; // x vignette exponent (0 = off), y effective tan(fov/2)
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, vec3(0.0));
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
  private readonly uVig: THREE.Uniform<THREE.Vector2>;
  constructor() {
    const uVig = new THREE.Uniform(new THREE.Vector2(0, 0.33));
    super('ExposureEffect', EXPOSURE_FRAG, {
      attributes: EffectAttribute.NONE,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['uExposure', new THREE.Uniform(1)], ['uVig', uVig]]),
    });
    this.uVig = uVig;
  }
  /** cos^4 vignette: exponent = Settings.film.vignette (0 disables), tanHalf = effective tan(fov / 2). */
  setVignette(exponent: number, tanHalf: number): void {
    this.uVig.value.set(Math.max(0, exponent), tanHalf);
  }
  get exposure(): number { return (this.uniforms.get('uExposure') as THREE.Uniform<number>).value; }
  set exposure(v: number) { (this.uniforms.get('uExposure') as THREE.Uniform<number>).value = v; }
}
