// src/post/frame/MrtComposite.ts — resolves the specular G-buffer of an MRT frame (post/ScenePass.ts) into the
// composer's input buffer: out = att0 (opaque colour without the fallback specular) + the specular term. Until
// package D lands, att1 carries the fallback specular x haze transmittance (0 today: nothing fills the split), so the
// output equals att0 bit for bit and SSR on / off frames are identical. Alpha is 1, as on non-MRT frames (the decals'
// SSR alpha blending scales att0.a, which nothing downstream may read).
// D owns this file after merge: it extends MRT_COMPOSITE_PARS / MRT_COMPOSITE_SPECULAR and createMrtCompositeUniforms
// (SSR hits replace the fallback by confidence) and keeps the uniform names below.

import * as THREE from 'three';
import { FullscreenQuad, quadMaterial } from './quad.ts';

/** Uniform declarations: tC0 = att0 (HDR colour), tS1 = att1 (fallback specular x T, Ws x T), tN2 = att2 (oct view
 * normal, lobe roughness); all nearest, read with texelFetch at the output pixel. */
export const MRT_COMPOSITE_PARS = /* glsl */ `
precision highp float;
uniform highp sampler2D tC0;
uniform highp sampler2D tS1;
uniform highp sampler2D tN2;
layout( location = 0 ) out highp vec4 outColor;
`;

/** Inside main(): sets `vec3 spec` from the G-buffer at pixel `p` (vec4 s1 = att1 is in scope). */
export const MRT_COMPOSITE_SPECULAR = /* glsl */ `
	vec3 spec = s1.rgb; // the fallback specular (D: mixed with the SSR hit by confidence)
`;

export const MRT_COMPOSITE_FRAG = /* glsl */ `
${MRT_COMPOSITE_PARS}
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	vec4 c0 = texelFetch( tC0, p, 0 );
	vec4 s1 = texelFetch( tS1, p, 0 );
${MRT_COMPOSITE_SPECULAR}
	outColor = vec4( c0.rgb + spec, 1.0 );
}
`;

export function createMrtCompositeUniforms(): Record<string, THREE.IUniform> {
  return { tC0: { value: null }, tS1: { value: null }, tN2: { value: null } };
}

export class MrtComposite {
  readonly material = quadMaterial('br-mrt-composite', MRT_COMPOSITE_FRAG, {}, createMrtCompositeUniforms());
  private readonly quad = new FullscreenQuad();

  /** Resolve `src` (the 3-attachment sceneRT) into `dst`. */
  render(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tC0.value = src.textures[0];
    u.tS1.value = src.textures[1];
    u.tN2.value = src.textures[2];
    this.quad.render(renderer, this.material, dst);
  }

  dispose(): void {
    this.material.dispose();
  }
}
