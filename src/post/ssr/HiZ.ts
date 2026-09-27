// src/post/ssr/HiZ.ts — package D: the half-resolution min device-depth pyramid the SSR trace (and package E's water)
// steps through (post/ssr/ssrGlsl.ts SSR_TRACE_GLSL), built by the frame graph's afterDepth hook 'hiz' from the
// complete prepass depth.
//  - R32F, level 0 = ceil(W / 2) x ceil(H / 2); the whole mip chain is allocated (floor-halved, as three does for a
//    render target with `texture.mipmaps`), so the texture is complete for any filter; the first HIZ_LEVELS levels are
//    built. Read with texelFetch only.
//  - Level 0 renders straight into mip 0 from the depth texture. Level k renders into a scratch target while
//    sampling mip k - 1 (the Hi-Z is not attached to the bound framebuffer, so there is no feedback loop), and a
//    NEAREST blit copies it into mip k.
//  - Published as MaterialGlobals.hiZ / hiZInfo = (W / 2, H / 2, levels built, 1 while valid this frame).

import * as THREE from 'three';
import type { MaterialGlobals } from '../../core/runtime.ts';
import { FullscreenQuad, quadMaterial } from '../frame/quad.ts';
import { HIZ_FRAG, hiZLayout } from './ssrGlsl.ts';

interface FramebufferProps { __webglFramebuffer?: WebGLFramebuffer | WebGLFramebuffer[] }

export class HiZ {
  readonly target: THREE.WebGLRenderTarget;
  /** (W / 2, H / 2, levels built, 1 = valid): MaterialGlobals.hiZInfo layout */
  readonly info = new THREE.Vector4(1, 1, 0, 0);
  private readonly scratch: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad = new FullscreenQuad();
  private readonly srcSize = new THREE.Vector2(1, 1);
  private readonly dstSize = new THREE.Vector2(1, 1);
  private sizes: [number, number][] = [[1, 1]];
  private built = 0;
  private fullW = 0;
  private fullH = 0;

  constructor() {
    const opts = {
      type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.NearestMipmapNearestFilter, magFilter: THREE.NearestFilter,
    } as const;
    this.target = new THREE.WebGLRenderTarget(1, 1, opts);
    this.target.texture.name = 'SSR.HiZ';
    this.scratch = new THREE.WebGLRenderTarget(1, 1, { ...opts, minFilter: THREE.NearestFilter });
    this.scratch.texture.name = 'SSR.HiZScratch';
    this.material = quadMaterial('br-hiz', HIZ_FRAG, {}, {
      tSrc: { value: null }, uLevel: { value: 0 }, uSrcSize: { value: this.srcSize }, uDstSize: { value: this.dstSize },
    });
  }

  get texture(): THREE.Texture { return this.target.texture; }
  get materials(): readonly THREE.ShaderMaterial[] { return [this.material]; }

  /** Size for a w x h full-resolution frame (reallocates only on change). */
  setSize(w: number, h: number): void {
    if (w === this.fullW && h === this.fullH) return;
    this.fullW = w;
    this.fullH = h;
    const L = hiZLayout(w, h);
    this.sizes = L.sizes;
    this.built = L.built;
    // the mip descriptors make three allocate every level and a framebuffer per level (setupRenderTarget)
    this.target.texture.mipmaps = L.sizes.map(([mw, mh]) => ({ data: null, width: mw, height: mh })) as unknown as THREE.Texture['mipmaps'];
    this.target.setSize(L.sizes[0][0], L.sizes[0][1]);
    const s1 = L.sizes[Math.min(1, L.sizes.length - 1)];
    this.scratch.setSize(s1[0], s1[1]);
    this.info.set(w / 2, h / 2, this.built, 0);
  }

  /** Build the pyramid from `depth` (full-resolution device depth, not bound); binds only its own targets. */
  build(renderer: THREE.WebGLRenderer, depth: THREE.Texture, width: number, height: number): void {
    this.setSize(width, height);
    const u = this.material.uniforms;
    // level 0: the min of each 2x2 block of the full-resolution depth
    u.tSrc.value = depth;
    u.uLevel.value = 0;
    this.srcSize.set(width, height);
    this.dstSize.set(this.sizes[0][0], this.sizes[0][1]);
    this.quad.render(renderer, this.material, this.target);
    // levels 1..built-1: scratch <- mip k-1, then blit scratch -> mip k
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const state = renderer.state;
    u.tSrc.value = this.target.texture;
    const vp = this.scratch.viewport;
    for (let k = 1; k < this.built; k++) {
      const [w, h] = this.sizes[k];
      u.uLevel.value = k - 1;
      this.srcSize.set(this.sizes[k - 1][0], this.sizes[k - 1][1]);
      this.dstSize.set(w, h);
      vp.set(0, 0, w, h);
      this.quad.render(renderer, this.material, this.scratch);
      const src = (renderer.properties.get(this.scratch) as FramebufferProps).__webglFramebuffer as WebGLFramebuffer;
      const dst = ((renderer.properties.get(this.target) as FramebufferProps).__webglFramebuffer as WebGLFramebuffer[])[k];
      state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    vp.set(0, 0, this.scratch.width, this.scratch.height);
    renderer.setRenderTarget(null);
    this.info.w = 1;
  }

  /** Publish into the material globals (valid = built this frame; otherwise the inert null texture). */
  publish(g: MaterialGlobals, valid: boolean): void {
    g.hiZ.value = valid ? this.target.texture : null;
    g.hiZInfo.value.copy(this.info);
    g.hiZInfo.value.w = valid ? 1 : 0;
  }

  /** Free the GL targets (a preset without SSR); the next build reallocates them. */
  release(): void {
    this.target.dispose();
    this.scratch.dispose();
    this.info.w = 0;
  }

  /** Mark the pyramid stale (a frame that did not build it). */
  invalidate(): void {
    this.info.w = 0;
  }

  dispose(): void {
    this.target.dispose();
    this.scratch.dispose();
    this.material.dispose();
  }
}
