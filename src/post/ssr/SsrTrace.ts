// src/post/ssr/SsrTrace.ts — package D: screen-space reflections on the frame graph (post/ScenePass.ts).
//  - afterDepth hook 'hiz' (order 20): the min device-depth pyramid (post/ssr/HiZ.ts) from the prepass depth.
//  - afterOpaque hook 'ssr' (order 10): one ray per 2x2 block (half resolution) from every pixel whose G-buffer holds a
//    replaceable specular (att1.a = Ws > 0) below the preset's ssrMaxRoughness: Hi-Z traversal for receding rays,
//    a linear march for rays toward the camera (ssrGlsl.ts SSR_TRACE_GLSL), thickness and facing tests, a
//    roughness cone into the colour pyramid with an anisotropic stretch along the screen-projected normal, and the
//    confidence fades (screen border, roughness cut-off, ray length, rays toward the camera, thickness). Ultra adds
//    a 3x3 bilateral filter (ssrFilter).
//  - The result reaches the MRT composite (post/frame/MrtComposite.ts setReflection), which upsamples it bilaterally
//    and replaces the fallback specular by its confidence.
// Both hooks run only on MRT frames (q.ssr on, the ssr toggle on, no debug view). BR_SSR_STEPS is compile-time: a
// quality change with other steps builds a new trace program.

import * as THREE from 'three';
import type { QualityConfig } from '../../core/quality.ts';
import type { FrameContext, FrameHook, ScenePass } from '../ScenePass.ts';
import { FullscreenQuad, quadMaterial } from '../frame/quad.ts';
import { HiZ } from './HiZ.ts';
import { SSR, SSR_FILTER_FRAG, SSR_TRACE_FRAG } from './ssrGlsl.ts';

export interface SsrSettings {
  maxRough: number;
  steps: number;
  filter: boolean;
}

export const ssrSettingsOf = (q: QualityConfig): SsrSettings => ({
  maxRough: q.ssrMaxRoughness, steps: Math.max(1, Math.round(q.ssrSteps)), filter: q.ssrFilter,
});

export class ScreenSpaceReflections {
  readonly hiz = new HiZ();
  /** q.ssr !== 'off': the hooks do nothing otherwise */
  enabled: boolean;
  private settings: SsrSettings;
  private trace: THREE.ShaderMaterial;
  private readonly filter: THREE.ShaderMaterial;
  private readonly ssrRT: THREE.WebGLRenderTarget;
  private readonly tmpRT: THREE.WebGLRenderTarget;
  private readonly quad = new FullscreenQuad();
  private readonly full = new THREE.Vector2(1, 1);
  private readonly pyrSize = new THREE.Vector2(1, 1);
  private readonly aoP = new THREE.Vector2();
  private attached: { sp: ScenePass; remove: (() => void)[] } | null = null;
  private readonly hizHook: FrameHook = { name: 'hiz', order: 20, run: (ctx) => this.runHiZ(ctx) };
  private readonly ssrHook: FrameHook = { name: 'ssr', order: 10, run: (ctx) => this.runTrace(ctx) };

  constructor(q: QualityConfig) {
    this.enabled = q.ssr !== 'off';
    this.settings = ssrSettingsOf(q);
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    } as const;
    // MRT: [0] premultiplied reflection + confidence, [1] metadata (linear depth, oct normal, roughness)
    this.ssrRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, count: 2 });
    this.ssrRT.textures[0].name = 'SSR.Trace';
    this.ssrRT.textures[1].name = 'SSR.Meta';
    this.tmpRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.tmpRT.texture.name = 'SSR.Filtered';
    this.trace = this.makeTrace(this.settings.steps);
    this.filter = quadMaterial('br-ssr-filter', SSR_FILTER_FRAG, {}, { tSsr: { value: null }, tMeta: { value: null } });
  }

  /** Every program (compiled ahead by boot / the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] {
    return [...this.hiz.materials, this.trace, this.filter];
  }

  /** The half-resolution result of the last traced frame (premultiplied rgb, a = confidence). */
  get texture(): THREE.Texture { return this.settings.filter ? this.tmpRT.texture : this.ssrRT.textures[0]; }

  private makeTrace(steps: number): THREE.ShaderMaterial {
    return quadMaterial('br-ssr-trace', SSR_TRACE_FRAG, { BR_SSR_STEPS: steps }, {
      tDepth: { value: null }, tSpec: { value: null }, tGNR: { value: null }, tPyr: { value: null },
      tAo: { value: null }, uAoP: { value: this.aoP },
      uHiZ: { value: this.hiz.texture }, uHiZInfo: { value: this.hiz.info },
      uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uFull: { value: this.full }, uPyrSize: { value: this.pyrSize }, uMaxRough: { value: this.settings.maxRough },
    });
  }

  /** Register the 'hiz' and 'ssr' hooks on the frame graph and give the colour pyramid its anisotropic filtering
   * (applied when its target is next allocated, so the pyramid is released here). */
  attach(sp: ScenePass): void {
    this.detach();
    sp.pyramid.texture.anisotropy = SSR.PYR_ANISO;
    sp.pyramid.release();
    this.attached = { sp, remove: [sp.addHook('afterDepth', this.hizHook), sp.addHook('afterOpaque', this.ssrHook)] };
  }

  detach(): void {
    if (!this.attached) return;
    for (const r of this.attached.remove) r();
    this.attached = null;
  }

  setQuality(q: QualityConfig): void {
    this.enabled = q.ssr !== 'off';
    const s = ssrSettingsOf(q);
    if (s.steps !== this.settings.steps) {
      this.trace.dispose();
      this.settings = s;
      this.trace = this.makeTrace(s.steps);
    }
    this.settings = s;
    this.trace.uniforms.uMaxRough.value = s.maxRough;
  }

  private runHiZ(ctx: FrameContext): void {
    const g = ctx.globals;
    if (!this.enabled || !ctx.mrt) {
      this.hiz.invalidate();
      if (g) this.hiz.publish(g, false);
      return;
    }
    this.hiz.build(ctx.renderer, ctx.depth, ctx.width, ctx.height);
    if (g) this.hiz.publish(g, true);
  }

  private runTrace(ctx: FrameContext): void {
    const sp = this.attached?.sp;
    const mrt = ctx.mrt;
    const pyr = ctx.pyramid;
    if (!this.enabled || !sp || !mrt || !pyr || this.hiz.info.w < 0.5) return;
    const renderer = ctx.renderer;
    const cam = ctx.camera;
    const hw = Math.max(1, Math.ceil(ctx.width / 2)), hh = Math.max(1, Math.ceil(ctx.height / 2));
    if (this.ssrRT.width !== hw || this.ssrRT.height !== hh) {
      this.ssrRT.setSize(hw, hh);
      this.tmpRT.setSize(hw, hh);
    }
    this.full.set(ctx.width, ctx.height);
    this.pyrSize.set(pyr.width, pyr.height);
    // the pre-shade SSAO ran this frame (afterDepth 'ssao'): its depth normals serve the facing test
    const g = ctx.globals;
    const aoOn = g !== null && g.ssaoParams.value.x > 0.5;
    this.aoP.set(aoOn ? 1 : 0, aoOn ? Math.max(1, g.ssaoParams.value.w) : 1);
    const u = this.trace.uniforms;
    u.tAo.value = aoOn ? g.ssaoTex.value : null;
    u.tDepth.value = ctx.depth;
    u.tSpec.value = mrt.textures[1];
    u.tGNR.value = mrt.textures[2];
    u.tPyr.value = pyr.texture;
    (u.uProj.value as THREE.Matrix4).copy(cam.projectionMatrix);
    (u.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    this.quad.render(renderer, this.trace, this.ssrRT);
    let result = this.ssrRT.textures[0];
    if (this.settings.filter) {
      const fu = this.filter.uniforms;
      fu.tSsr.value = this.ssrRT.textures[0];
      fu.tMeta.value = this.ssrRT.textures[1];
      this.quad.render(renderer, this.filter, this.tmpRT);
      result = this.tmpRT.texture;
    }
    sp.composite.setReflection(result, this.ssrRT.textures[1], cam);
  }

  dispose(): void {
    this.detach();
    this.hiz.dispose();
    this.trace.dispose();
    this.filter.dispose();
    this.ssrRT.dispose();
    this.tmpRT.dispose();
  }
}

export function createScreenSpaceReflections(q: QualityConfig): ScreenSpaceReflections {
  return new ScreenSpaceReflections(q);
}
