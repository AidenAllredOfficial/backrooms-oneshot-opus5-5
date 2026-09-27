// src/post/frame/MrtComposite.ts — resolves the specular G-buffer of an MRT frame (post/ScenePass.ts) into the
// composer's input buffer: out = att0 (opaque colour without the replaceable specular) + the specular term.
// Package D owns it (from A): the term is att1 (the fallback specular x haze transmittance) where no reflection was
// traced, else the screen-space reflection (post/ssr/SsrTrace.ts, handed over each frame by setReflection) upsampled
// bilaterally from half resolution and mixed over the fallback by its confidence (post/ssr/ssrGlsl.ts
// SSR_COMPOSITE_SPECULAR). Without a reflection this frame (uSsrP.x = 0) the output is att0 + att1 exactly. Alpha is
// 1, as on non-MRT frames (the decals' SSR alpha blending scales att0.a, which nothing downstream may read).
// Uniform names tC0 / tS1 / tN2 are the frame graph's contract; URL reflView selects the debug outputs.

import * as THREE from 'three';
import type { ReflView } from '../../core/debug.ts';
import { REFL_DEBUG, SSR_COMPOSITE_DEBUG, SSR_COMPOSITE_PARS, SSR_COMPOSITE_SPECULAR } from '../ssr/ssrGlsl.ts';
import { FullscreenQuad, quadMaterial } from './quad.ts';

/** Uniform declarations: tC0 = att0 (HDR colour), tS1 = att1 (fallback specular x T, Ws x T), tN2 = att2 (oct view
 * normal, lobe roughness, 1 where written); all nearest, read with texelFetch; then the reflection inputs. */
export const MRT_COMPOSITE_PARS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tC0;
uniform highp sampler2D tS1;
uniform highp sampler2D tN2;
layout( location = 0 ) out highp vec4 outColor;
${SSR_COMPOSITE_PARS}
`;

/** Inside main(): sets `vec3 spec` (and `vec4 ssr`) from the G-buffer at pixel `p` (vec4 s1 = att1 is in scope). */
export const MRT_COMPOSITE_SPECULAR = SSR_COMPOSITE_SPECULAR;

export const MRT_COMPOSITE_FRAG = /* glsl */ `
${MRT_COMPOSITE_PARS}
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	vec4 c0 = texelFetch( tC0, p, 0 );
	vec4 s1 = texelFetch( tS1, p, 0 );
${MRT_COMPOSITE_SPECULAR}
	vec3 outc = min( c0.rgb + spec, vec3( BR_HDR_CLAMP ) );
${SSR_COMPOSITE_DEBUG}
	outColor = vec4( outc, 1.0 );
}
`;

export function createMrtCompositeUniforms(): Record<string, THREE.IUniform> {
  return {
    tC0: { value: null }, tS1: { value: null }, tN2: { value: null },
    tSsr: { value: null }, tMeta: { value: null }, tDepth: { value: null }, uSsrP: { value: new THREE.Vector4() },
    uLin: { value: new THREE.Vector3(1, 1, 1) },
  };
}

export class MrtComposite {
  readonly material = quadMaterial('br-mrt-composite', MRT_COMPOSITE_FRAG, {}, createMrtCompositeUniforms());
  private readonly quad = new FullscreenQuad();
  private ssr: THREE.Texture | null = null;
  private meta: THREE.Texture | null = null;
  private debug = 0;

  /** This frame's reflection and its metadata (the SSR hook calls it before the composite; consumed by the next
   * render). */
  setReflection(tex: THREE.Texture | null, meta: THREE.Texture | null, camera: THREE.PerspectiveCamera): void {
    this.ssr = tex;
    this.meta = meta;
    (this.material.uniforms.uLin.value as THREE.Vector3).set(camera.near * camera.far, camera.far - camera.near, camera.far);
  }

  /** URL reflView: the reflection alone or its confidence (misses magenta). */
  setDebug(mode: ReflView): void {
    this.debug = REFL_DEBUG[mode] ?? 0;
  }

  /** Resolve `src` (the 3-attachment sceneRT) into `dst`. */
  render(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tC0.value = src.textures[0];
    u.tS1.value = src.textures[1];
    u.tN2.value = src.textures[2];
    u.tDepth.value = src.depthTexture;
    u.tSsr.value = this.ssr;
    u.tMeta.value = this.meta;
    const on = this.ssr !== null && this.meta !== null;
    (u.uSsrP.value as THREE.Vector4).set(on ? 1 : 0, on ? this.debug : 0, 0, 0);
    this.quad.render(renderer, this.material, dst);
    this.ssr = null;
    this.meta = null;
  }

  dispose(): void {
    this.material.dispose();
  }
}
