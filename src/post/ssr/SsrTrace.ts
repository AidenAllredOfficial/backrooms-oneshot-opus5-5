// src/post/ssr/SsrTrace.ts — package D: screen-space reflections on the frame graph (post/ScenePass.ts).
//  - afterDepth hook 'hiz' (order 20): the min device-depth pyramid (post/ssr/HiZ.ts) from the prepass depth.
//  - afterOpaque hook 'ssr' (order 10): one ray per 2x2 block (half the display resolution: 3x3 on ultra's 1.4x
//    buffer, ssrStepFor) whose top-left pixel holds a replaceable specular in the G-buffer (att1.a = Ws > 0) below
//    the preset's ssrMaxRoughness, with the block's averaged lobe: Hi-Z traversal for receding rays,
//    a linear march for rays toward the camera (ssrGlsl.ts SSR_TRACE_GLSL), thickness and facing tests, the glossy
//    lobe's footprint on the hit surface (narrowed by N.V out of the plane of incidence) looked up anisotropically in
//    the low-passed colour pyramid (a core and a GGX tail), and the confidence fades (screen border, roughness
//    cut-off, ray length, rays toward the camera, thickness). The resolve then gathers each texel's neighbours over
//    the lobe's spread on the receiver (ssrGlsl.ts SSR_RESOLVE_FRAG; 8 taps on ultra (ssrFilter), 6 on high).
//  - The result reaches the MRT composite (post/frame/MrtComposite.ts setReflection), which upsamples it bilaterally
//    and replaces the fallback specular by its confidence.
// Both hooks run only on MRT frames (q.ssr on, the ssr toggle on, no debug view). BR_SSR_STEPS and BR_SSR_TAPS are
// compile-time: a quality change with other steps or taps builds a new trace or resolve program.

import * as THREE from 'three';
import type { QualityConfig } from '../../core/quality.ts';
import type { FrameContext, FrameHook, ScenePass } from '../ScenePass.ts';
import { FullscreenQuad, quadMaterial } from '../frame/quad.ts';
import { HiZ } from './HiZ.ts';
import { SSR, SSR_RESOLVE_FRAG, SSR_TRACE_FRAG } from './ssrGlsl.ts';

export interface SsrSettings {
  maxRough: number;
  steps: number;
  filter: boolean;
}

export const ssrSettingsOf = (q: QualityConfig): SsrSettings => ({
  maxRough: q.ssrMaxRoughness, steps: Math.max(1, Math.round(q.ssrSteps)), filter: q.ssrFilter,
});

/** Full-resolution pixels per trace texel: half the DISPLAY resolution, so ultra's 1.4x supersampled buffer traces
 * one ray per 3 x 3 pixels (about the rays per display pixel of high; 2 x 2 cost 2.25x as much there). */
export const ssrStepFor = (renderScale: number): number => (renderScale > 1.25 ? 3 : 2);

export class ScreenSpaceReflections {
  readonly hiz = new HiZ();
  /** q.ssr !== 'off': the hooks do nothing otherwise */
  enabled: boolean;
  private settings: SsrSettings;
  private trace: THREE.ShaderMaterial;
  private resolve: THREE.ShaderMaterial;
  private readonly ssrRT: THREE.WebGLRenderTarget;
  private readonly tmpRT: THREE.WebGLRenderTarget;
  private readonly quad = new FullscreenQuad();
  private readonly full = new THREE.Vector2(1, 1);
  private readonly aoP = new THREE.Vector2();
  private readonly projP = new THREE.Vector4();
  private readonly renderScale: () => number;
  private step = 2;
  private attached: { sp: ScenePass; remove: (() => void)[] } | null = null;
  private readonly hizHook: FrameHook = { name: 'hiz', order: 20, run: (ctx) => this.runHiZ(ctx) };
  private readonly ssrHook: FrameHook = { name: 'ssr', order: 10, run: (ctx) => this.runTrace(ctx) };

  /** renderScale: the post stack's current render scale (the trace step follows it). */
  constructor(q: QualityConfig, renderScale: () => number = () => 1) {
    this.renderScale = renderScale;
    this.enabled = q.ssr !== 'off';
    this.settings = ssrSettingsOf(q);
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    } as const;
    // MRT: [0] premultiplied reflection + confidence, [1] metadata (linear depth, oct normal, roughness), [2] the
    // resolve's kernel
    this.ssrRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, count: 3 });
    this.ssrRT.textures[0].name = 'SSR.Trace';
    this.ssrRT.textures[1].name = 'SSR.Meta';
    this.ssrRT.textures[2].name = 'SSR.Kernel';
    this.tmpRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.tmpRT.texture.name = 'SSR.Resolved';
    this.trace = this.makeTrace(this.settings.steps);
    this.resolve = this.makeResolve(this.settings.filter);
  }

  /** Every program (compiled ahead by boot / the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] {
    return [...this.hiz.materials, this.trace, this.resolve];
  }

  /** The trace-resolution result of the last traced frame, resolved (premultiplied rgb, a = confidence). */
  get texture(): THREE.Texture { return this.tmpRT.texture; }

  private makeTrace(steps: number): THREE.ShaderMaterial {
    return quadMaterial('br-ssr-trace', SSR_TRACE_FRAG, { BR_SSR_STEPS: steps }, {
      tDepth: { value: null }, tSpec: { value: null }, tGNR: { value: null }, tPyr: { value: null },
      tAo: { value: null }, uAoP: { value: this.aoP },
      uHiZ: { value: this.hiz.texture }, uHiZInfo: { value: this.hiz.info },
      uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uFull: { value: this.full }, uMaxRough: { value: this.settings.maxRough },
      uStep: { value: this.step },
    });
  }

  /** The resolve: SSR.RESOLVE_TAPS[0] taps with ssrFilter (ultra), [1] without (compile-time, like the trace's steps). */
  private makeResolve(full: boolean): THREE.ShaderMaterial {
    return quadMaterial('br-ssr-resolve', SSR_RESOLVE_FRAG, { BR_SSR_TAPS: SSR.RESOLVE_TAPS[full ? 0 : 1] }, {
      tSsr: { value: null }, tMeta: { value: null }, tKer: { value: null }, uProjP: { value: this.projP },
      uFull: { value: this.full }, uStep: { value: this.step },
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
    const prev = this.settings;
    this.settings = s;
    if (s.steps !== prev.steps) {
      this.trace.dispose();
      this.trace = this.makeTrace(s.steps);
    }
    if (s.filter !== prev.filter) {
      this.resolve.dispose();
      this.resolve = this.makeResolve(s.filter);
    }
    this.trace.uniforms.uMaxRough.value = s.maxRough;
    if (!this.enabled) {
      // free the GL targets on presets without SSR (they reallocate on the next traced frame)
      this.hiz.release();
      this.ssrRT.dispose();
      this.tmpRT.dispose();
    }
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
    const step = ssrStepFor(this.renderScale());
    this.step = step;
    const hw = Math.max(1, Math.ceil(ctx.width / step)), hh = Math.max(1, Math.ceil(ctx.height / step));
    if (this.ssrRT.width !== hw || this.ssrRT.height !== hh) {
      this.ssrRT.setSize(hw, hh);
      this.tmpRT.setSize(hw, hh);
    }
    this.full.set(ctx.width, ctx.height);
    // the pre-shade SSAO ran this frame (afterDepth 'ssao'): its depth normals serve the facing test
    const g = ctx.globals;
    const aoOn = g !== null && g.ssaoParams.value.x > 0.5;
    this.aoP.set(aoOn ? 1 : 0, aoOn ? Math.max(1, g.ssaoParams.value.w) : 1);
    const u = this.trace.uniforms;
    u.uStep.value = step;
    u.tAo.value = aoOn ? g.ssaoTex.value : null;
    u.tDepth.value = ctx.depth;
    u.tSpec.value = mrt.textures[1];
    u.tGNR.value = mrt.textures[2];
    u.tPyr.value = pyr.texture;
    (u.uProj.value as THREE.Matrix4).copy(cam.projectionMatrix);
    (u.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    this.quad.render(renderer, this.trace, this.ssrRT);
    const e = cam.projectionMatrix.elements;
    this.projP.set(e[0], e[5], e[8], e[9]);
    const ru = this.resolve.uniforms;
    ru.tSsr.value = this.ssrRT.textures[0];
    ru.tMeta.value = this.ssrRT.textures[1];
    ru.tKer.value = this.ssrRT.textures[2];
    ru.uStep.value = step;
    this.quad.render(renderer, this.resolve, this.tmpRT);
    sp.composite.setReflection(this.tmpRT.texture, this.ssrRT.textures[1], step, cam);
  }

  dispose(): void {
    this.detach();
    this.hiz.dispose();
    this.trace.dispose();
    this.resolve.dispose();
    this.ssrRT.dispose();
    this.tmpRT.dispose();
  }
}

export function createScreenSpaceReflections(q: QualityConfig, renderScale?: () => number): ScreenSpaceReflections {
  return new ScreenSpaceReflections(q, renderScale);
}
