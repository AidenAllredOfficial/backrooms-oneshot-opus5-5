// src/post/ScenePass.ts — the composer's scene pass and the frame graph (package A). pmndrs RenderPass with a depth
// prepass (materials/prepass.ts; each visible pixel is shaded once) and ordered hook stages around the opaque render:
//
//   clear -> depth prepass (+ flashlight shadow map) -> afterDepth hooks (ssao 10, hiz 20, lightAtlas 30,
//   volumetrics 40) -> opaque shading (MRT sceneRT when SSR is on; LAYER_LATE left out on split frames) ->
//   ColorPyramid (split frames) -> afterOpaque hooks (ssr 10) -> MRT composite into the input buffer + depth blit ->
//   late render of LAYER_LATE (water, sparks, motes) into the input buffer.
//
// - MRT frame: q.ssr on, the ssr toggle on and no debug view. The opaque view renders into sceneRT (3 x RGBA16F:
//   colour, fallback specular x T, oct normal + roughness; FloatType depth). Attachments 1-2 are zeroed after the
//   prepass render (its colour background clears every attachment to the background colour) and the shading render
//   then runs with autoClearColor off, so the forced background clear leaves them alone. MrtComposite resolves them into
//   the input buffer and the depth is blitted across, so the late render and the composer's own depth copy see it.
// - Split frame: q.colorPyramidScale > 0, no debug view other than WATER, and an MRT frame or a LAYER_LATE mesh in view
//   (recorded by the prepass). The opaque render leaves LAYER_LATE out; the pyramid (rgb opaque HDR, a = linear depth)
//   is built from it; then LAYER_LATE draws alone (shadow auto-update off, no clears, depth writes locked as in the
//   shading render), in the same order as the single render would. MaterialGlobals.waterVolOn is 1 from the depth
//   hooks to the end of the late render.
// - Low and medium have neither: one prepass + shading render, exactly as before the frame graph.
// Hooks see FrameContext; they bind their own targets and size them from ctx.width / ctx.height. Hooks read the
// target's own depth texture (ctx.depth) while it is not bound: the composer's stable depth copy is only filled
// after this pass. needsDepthTexture keeps the composer's FloatType depth textures.

import * as THREE from 'three';
import { RenderPass } from 'postprocessing';
import { DebugView } from '../core/ids.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { MaterialGlobals } from '../core/runtime.ts';
import { PREPASS_LATE, renderWithPrepass } from '../materials/prepass.ts';
import type { PrepassOptions } from '../materials/prepass.ts';
import { LAYER_LATE, MRT_PASS, setWirePixel } from '../materials/shared.ts';
import { blitDepth } from './frame/blitDepth.ts';
import { ColorPyramid } from './frame/ColorPyramid.ts';
import { MrtComposite } from './frame/MrtComposite.ts';

export type FrameStage = 'afterDepth' | 'afterOpaque';

export interface FrameContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** the opaque render's target: sceneRT on MRT frames, else the composer's input buffer */
  target: THREE.WebGLRenderTarget;
  /** target's depth texture (the complete prepass depth; FloatType) */
  depth: THREE.DepthTexture;
  /** full-resolution size (px) */
  width: number;
  height: number;
  /** sceneRT on MRT frames (textures 0-2), else null */
  mrt: THREE.WebGLRenderTarget | null;
  /** afterOpaque on split frames: the colour + depth pyramid of this frame, else null */
  pyramid: ColorPyramid | null;
  debugView: number;
  /** the material globals to publish into (null until bindGlobals: the post harness renders plain scenes) */
  globals: MaterialGlobals | null;
}

export interface FrameHook {
  /** also the gpuProfile segment label */
  name: string;
  /** ascending within a stage; convention: afterDepth ssao 10, hiz 20, lightAtlas 30, volumetrics 40 | afterOpaque ssr 10 */
  order: number;
  run(ctx: FrameContext): void;
}

/** What the last render did (tests, debug). */
export interface FrameInfo { mrt: boolean; split: boolean }

const ZERO4 = new Float32Array(4);

export class ScenePass extends RenderPass {
  readonly hooks: Readonly<Record<FrameStage, FrameHook[]>> = { afterDepth: [], afterOpaque: [] };
  readonly pyramid = new ColorPyramid();
  readonly composite = new MrtComposite();
  readonly lastFrame: FrameInfo = { mrt: false, split: false };
  private readonly cam: THREE.PerspectiveCamera;
  private quality: QualityConfig | null = null;
  private globals: MaterialGlobals | null = null;
  private ssr = true;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private split = false;
  private readonly ctx: FrameContext;
  private readonly prepassOpts: PrepassOptions;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super(scene, camera);
    this.cam = camera;
    this.needsDepthTexture = true;
    const dummy = null as unknown as THREE.WebGLRenderTarget;
    this.ctx = {
      renderer: null as unknown as THREE.WebGLRenderer, camera, target: dummy, depth: null as unknown as THREE.DepthTexture,
      width: 1, height: 1, mrt: null, pyramid: null, debugView: 0, globals: null,
    };
    this.prepassOpts = { afterDepth: () => this.afterDepth(), excludeLayer: () => (this.split ? LAYER_LATE : undefined) };
  }

  /** Add a hook to a stage (kept sorted by order; equal orders keep insertion order). Returns its remover. */
  addHook(stage: FrameStage, hook: FrameHook): () => void {
    const list = this.hooks[stage];
    let i = list.length;
    while (i > 0 && list[i - 1].order > hook.order) i--;
    list.splice(i, 0, hook);
    return () => this.removeHook(stage, hook);
  }

  removeHook(stage: FrameStage, hook: FrameHook): void {
    const list = this.hooks[stage];
    const i = list.indexOf(hook);
    if (i >= 0) list.splice(i, 1);
  }

  setQuality(q: QualityConfig): void {
    this.quality = q;
    if (q.ssr === 'off') this.disposeSceneRT();
  }

  /** The URL / debug `ssr` toggle (PostStack.setEnabled): off renders the plain non-MRT path. */
  setSsrEnabled(on: boolean): void {
    this.ssr = on;
    if (!on) this.disposeSceneRT();
  }

  /** The material globals this pass publishes into (sceneColor, sceneInvSize, waterVolOn; hooks via ctx.globals). */
  bindGlobals(g: MaterialGlobals | null): void {
    this.globals = g;
    this.ctx.globals = g;
  }

  /** Programs this pass owns (compiled ahead by boot / the quality switch). */
  get materials(): readonly THREE.ShaderMaterial[] {
    return [...this.pyramid.materials, this.composite.material];
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    const q = this.quality;
    const g = this.globals;
    const ctx = this.ctx;
    const dv = g ? g.debugView.value : 0;
    const mrtOn = q !== null && q.ssr !== 'off' && this.ssr && dv === 0;
    const target = mrtOn ? this.ensureSceneRT(inputBuffer.width, inputBuffer.height) : inputBuffer;
    ctx.renderer = renderer;
    ctx.target = target;
    ctx.depth = target.depthTexture as THREE.DepthTexture;
    ctx.width = target.width;
    ctx.height = target.height;
    ctx.mrt = mrtOn ? target : null;
    ctx.pyramid = null;
    ctx.debugView = dv;
    this.split = false;

    const clear = this.getClearPass();
    if (clear.enabled) clear.render(renderer, target, outputBuffer);
    renderer.setRenderTarget(this.renderToScreen ? null : target);
    setWirePixel(this.cam, target.height);
    MRT_PASS.value = mrtOn ? 1 : 0;
    const autoClearColor = renderer.autoClearColor;
    try {
      renderWithPrepass(renderer, this.scene, this.cam, this.prepassOpts);
    } finally {
      MRT_PASS.value = 0;
      renderer.autoClearColor = autoClearColor;
    }

    if (this.split) {
      const s = q ? q.colorPyramidScale : 1;
      this.pyramid.setSize(target.width, target.height, s);
      this.pyramid.build(renderer, mrtOn ? target.textures[0] : inputBuffer.texture, ctx.depth, this.cam);
      ctx.pyramid = this.pyramid;
      if (g) {
        g.sceneColor.value = this.pyramid.texture;
        g.sceneInvSize.value.copy(this.pyramid.invSize);
      }
    }
    const opaque = this.hooks.afterOpaque;
    for (let i = 0; i < opaque.length; i++) opaque[i].run(ctx);
    if (mrtOn) {
      this.composite.render(renderer, target, inputBuffer);
      blitDepth(renderer, target, inputBuffer);
    }
    if (this.split) this.renderLate(renderer, inputBuffer);
    if (g) g.waterVolOn.value = 0;
    this.lastFrame.mrt = mrtOn;
    this.lastFrame.split = this.split;
    // leave the input buffer bound, as a plain RenderPass does
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
  }

  /** Between the prepass and the shading render: decide the split, run the depth hooks, rebind, prepare MRT. */
  private afterDepth(): void {
    const ctx = this.ctx;
    const q = this.quality;
    const renderer = ctx.renderer;
    this.split = q !== null && q.colorPyramidScale > 0 && (ctx.debugView === 0 || ctx.debugView === DebugView.WATER) &&
      (ctx.mrt !== null || PREPASS_LATE.visible);
    if (this.globals) this.globals.waterVolOn.value = this.split ? 1 : 0;
    const hooks = this.hooks.afterDepth;
    for (let i = 0; i < hooks.length; i++) hooks[i].run(ctx);
    renderer.setRenderTarget(this.renderToScreen ? null : ctx.target);
    if (ctx.mrt) {
      // the specular G-buffer starts at zero; the shading render's background clear must not refill it
      const gl = renderer.getContext() as WebGL2RenderingContext;
      renderer.state.buffers.color.setMask(true);
      gl.clearBufferfv(gl.COLOR, 1, ZERO4);
      gl.clearBufferfv(gl.COLOR, 2, ZERO4);
      renderer.autoClearColor = false;
    }
  }

  /** LAYER_LATE alone into `dst` over the opaque colour, with the shading render's state. */
  renderLate(renderer: THREE.WebGLRenderer, dst: THREE.WebGLRenderTarget): void {
    const cam = this.cam;
    const depthBuf = renderer.state.buffers.depth;
    const layerMask = cam.layers.mask;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const autoClear = renderer.autoClear;
    const cc = renderer.autoClearColor, cd = renderer.autoClearDepth, cs = renderer.autoClearStencil;
    renderer.setRenderTarget(dst);
    renderer.shadowMap.autoUpdate = false; // updated by the prepass this frame
    renderer.autoClear = false;
    // the colour background forces a clear on every render: clear nothing
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.autoClearStencil = false;
    depthBuf.setMask(false);
    depthBuf.setLocked(true);
    cam.layers.set(LAYER_LATE);
    try {
      renderer.render(this.scene, cam);
    } finally {
      cam.layers.mask = layerMask;
      depthBuf.setLocked(false);
      depthBuf.setMask(true);
      renderer.shadowMap.autoUpdate = shadowAuto;
      renderer.autoClear = autoClear;
      renderer.autoClearColor = cc;
      renderer.autoClearDepth = cd;
      renderer.autoClearStencil = cs;
    }
  }

  private ensureSceneRT(w: number, h: number): THREE.WebGLRenderTarget {
    let rt = this.sceneRT;
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        count: 3, type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
        depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
      });
      rt.textures[0].name = 'Frame.Colour';
      rt.textures[1].name = 'Frame.Specular';
      rt.textures[2].name = 'Frame.NormalRough';
      this.sceneRT = rt;
    } else if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
    }
    return rt;
  }

  private disposeSceneRT(): void {
    if (!this.sceneRT) return;
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.sceneRT = null;
  }

  override dispose(): void {
    this.disposeSceneRT();
    this.pyramid.dispose();
    this.composite.dispose();
    super.dispose();
  }
}
