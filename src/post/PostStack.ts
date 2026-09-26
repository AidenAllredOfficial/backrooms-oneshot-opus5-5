// src/post/PostStack.ts — the calibrated post stack (WP11), pmndrs postprocessing 6.39.5.
// EffectComposer(HalfFloat, no MSAA); the renderer has NoToneMapping + SRGB output (WP14). Passes (POST_PASSES):
//  1. RenderPass(scene, camera)
//  2. N8AOPostPass: aoRadius 0.7, distanceFalloff 0.6, intensity/color from the atmosphere, halfRes, gammaCorrection
//     false, autoDetectTransparency = false (never enters n8ao's transparency path: no extra scene renders)
//  3. AutoExposurePass (meter; needsSwap false)
//  4. EffectPass[Bloom (threshold 1/exposure nits), Exposure (+ warm halation from the two coarsest bloom mips), AgX,
//     Grade (+ highlight knee and black pedestal)]
//  5. EffectPass[SMAA | FXAA] (a convolution effect, alone)
//  6. EffectPass[Lens (CONVOLUTION, no mainUv; lens MTF softness + camcorder detail halo), FilmGrain] with dithering,
//     rendered directly to the canvas. Capture frames use an RGBA8 display target, blitted to the canvas and downsampled.
// The composer runs passes 1-5 (autoRenderToScreen off); pass 6 is rendered by hand from whichever ping-pong
// buffer holds the result. Grain encodes sRGB for both output paths.

import * as THREE from 'three';
import { effectiveDpr, maxScaleFor } from './DynamicResolution.ts';
import {
  BloomEffect, BlendFunction, EffectComposer, EffectPass, FXAAEffect, RenderPass, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';
import type { EffectMaterial, Pass } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { PHOTOMETRY } from '../core/constants.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { Settings } from '../core/settings.ts';
import type { AtmosphereState, PostStack } from '../core/runtime.ts';
import { AutoExposurePass } from './AutoExposurePass.ts';
import { createDisplayCapture } from './capture.ts';
import { ColorGradeEffect } from './effects/ColorGradeEffect.ts';
import { ExposureEffect } from './effects/ExposureEffect.ts';
import { FilmGrainEffect } from './effects/FilmGrainEffect.ts';
import { LENS_MTF, LensEffect, VIGNETTE_FOCAL } from './effects/LensEffect.ts';
import { ev100FromLog2, exposureFromEv, meterClamp, stepExposure } from './exposureMath.ts';
import type { ExposureState } from './exposureMath.ts';

/** Static description of the pass layout (asserted by tests/post/effects.test.ts; built by createPostStack). */
export const POST_PASSES: readonly { name: string; effects: readonly string[] }[] = [
  { name: 'RenderPass', effects: [] },
  { name: 'N8AOPostPass', effects: [] },
  { name: 'AutoExposurePass', effects: [] },
  { name: 'EffectPass', effects: ['BloomEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect'] },
  { name: 'EffectPass', effects: ['SMAAEffect|FXAAEffect'] },
  { name: 'EffectPass', effects: ['LensEffect', 'FilmGrainEffect'] },
];

export const POST_TUNING = {
  AO_RADIUS: 0.7, // R2-post: tighter, darker contact shadows at wall bases / under furniture
  AO_FALLOFF: 0.6,
  BLOOM_RADIUS: 0.85,
  BLOOM_SMOOTHING: 0.6, // x 1/exposure (absolute nits): a soft knee, bright ceiling tiles near a panel glow a little
  BLOOM_SCALE: 0.35, // atmosphere bloomIntensity (table 0.4-0.6) -> BloomEffect.intensity (soft camcorder bloom)
  HALATION: 0.3, // x the effective bloom intensity: the two coarsest bloom mips re-added (wide consumer-lens veil)
  HALATION_TINT: [1.0, 0.85, 0.7] as readonly [number, number, number],
  GRAIN_SIGMA: 0.009, // sRGB-encoded sigma at grain 1, exposure_ref (correlated 1.5 px grain reads stronger per sigma)
  GRAIN_CHROMA: 0.25,
  GRAIN_GAIN_MIN: 0.7,
  GRAIN_GAIN_MAX: 3.5,
  // sensor gain: below LOW_LIGHT_EV the camcorder AGC cranks up; grain x (1 + LOW_LIGHT_GAIN * k) and chroma
  // fraction + LOW_LIGHT_CHROMA * k, k = smoothstep(LOW_LIGHT_EV, LOW_LIGHT_EV_MIN, metered EV100)
  LOW_LIGHT_EV: 6.5,
  LOW_LIGHT_EV_MIN: 4.0,
  LOW_LIGHT_GAIN: 0.45,
  LOW_LIGHT_CHROMA: 0.3,
  BEAT_BAND: 0.025, // camcorder mode: fluorescent / rolling-shutter beat band amplitude (flicker Reduced x0.5, Off 0)
  EV_DEADBAND: 0.04, // EV; the camcorder AE stops hunting inside this band (stable frozen-time captures)
  SNAP_MEASUREMENTS: 3, // snapExposure(): the next N meter readings are applied without the spring
} as const;

const EXPOSURE_REF = exposureFromEv(PHOTOMETRY.EV100_L0, 0, 0);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** N8AOPostPass leaves its FullScreenTriangle quads (and their ShaderMaterials) out of Pass.dispose(). The quads
 * share one module-level triangle geometry, so only their materials are disposed. */
function disposeN8ao(p: N8AOPostPass): void {
  // the composer's shared depth texture must survive Pass.dispose() (which disposes every Texture property)
  p.setDepthTexture(null as unknown as THREE.Texture);
  const q = p as unknown as Record<string, { material?: THREE.Material } | null | undefined>;
  for (const k of ['effectShaderQuad', 'poissonBlurQuad', 'effectCompositerQuad', 'depthDownsampleQuad', 'accumulationQuad', 'copyQuad', 'depthCopyPass']) {
    const m = q[k]?.material;
    if (m && typeof m.dispose === 'function') m.dispose();
  }
  p.dispose();
}

/** Internals exposed to the post harness / QA only (not part of the PostStack contract). */
export interface PostInternals {
  composer: EffectComposer;
  n8ao: N8AOPostPass;
  autoExposure: AutoExposurePass;
  bloom: BloomEffect;
  passes: Pass[];
  finalPass: EffectPass;
  targetEv(): number;
  measurements(): number;
}
const internals = new WeakMap<PostStack, PostInternals>();
export function postInternals(p: PostStack): PostInternals | null {
  return internals.get(p) ?? null;
}

/** BloomEffect whose (costly) update can be skipped when bloom is disabled. */
class HdrBloom extends BloomEffect {
  active = true;
  override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, deltaTime?: number): void {
    if (this.active) super.update(renderer, inputBuffer, deltaTime);
  }
}

type Toggle = 'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade';

export function createPostStack(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualityConfig, s: Settings): PostStack {
  const P = POST_TUNING;
  let quality = q;
  const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.autoRenderToScreen = false;

  // 1. scene
  const renderPass = new RenderPass(scene, camera);

  // 2. N8AO. A quality change that alters the AO mode or halfRes builds a NEW pass (and disposes the old one with
  // all its quads) instead of mutating defines, so the program set does not ratchet up across preset cycles.
  let aoIntensitySet = -1;
  const aoColorLin = new THREE.Color(-1, -1, -1);
  const makeN8ao = (qq: QualityConfig, w: number, h: number): N8AOPostPass => {
    const p = new N8AOPostPass(scene, camera, Math.max(1, w), Math.max(1, h));
    p.autoDetectTransparency = false;
    if (p.configuration.transparencyAware) p.configuration.transparencyAware = false;
    p.configuration.aoRadius = P.AO_RADIUS;
    p.configuration.distanceFalloff = P.AO_FALLOFF;
    p.configuration.gammaCorrection = false; // also clears autosetGamma
    p.configuration.halfRes = qq.aoHalfRes;
    p.configuration.screenSpaceRadius = false;
    p.configuration.color = new THREE.Color(0, 0, 0);
    if (qq.ao !== 'off') p.setQualityMode(qq.ao);
    p.enabled = qq.ao !== 'off';
    aoIntensitySet = -1;
    aoColorLin.setRGB(-1, -1, -1);
    return p;
  };
  let n8ao = makeN8ao(q, dbs.x, dbs.y);
  let aoKey = `${q.ao}:${q.aoHalfRes}`;

  // 3. exposure meter
  const ae = new AutoExposurePass();

  // 4. bloom + exposure + AgX + grade
  const bloom = new HdrBloom({
    blendFunction: BlendFunction.ADD, mipmapBlur: true, levels: q.bloomLevels, radius: P.BLOOM_RADIUS,
    intensity: 0.5, luminanceThreshold: 1, luminanceSmoothing: P.BLOOM_SMOOTHING,
  });
  const exposureFx = new ExposureEffect();
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new ColorGradeEffect();
  const hdrPass = new EffectPass(camera, bloom, exposureFx, toneMapping, grade);

  // 5. AA (alone: SMAA and FXAA are convolution effects)
  const makeAA = (qq: QualityConfig): EffectPass =>
    new EffectPass(camera, qq.aa === 'smaa' ? new SMAAEffect({ preset: SMAAPreset[qq.smaaPreset] }) : new FXAAEffect());
  let aaPass = makeAA(q);
  let aaKey = q.aa === 'smaa' ? `smaa:${q.smaaPreset}` : 'fxaa';

  // 6. lens + grain -> canvas, or the display target on capture frames (rendered by hand)
  const lens = new LensEffect();
  const grain = new FilmGrainEffect();
  const finalPass = new EffectPass(camera, lens, grain);
  finalPass.dithering = true;
  finalPass.renderToScreen = false;

  composer.addPass(renderPass);
  composer.addPass(n8ao);
  composer.addPass(ae);
  composer.addPass(hdrPass);
  composer.addPass(aaPass);
  const alpha = renderer.getContext().getContextAttributes()?.alpha ?? false;
  finalPass.setRenderer(renderer);
  finalPass.initialize(renderer, alpha, THREE.HalfFloatType);
  finalPass.setSize(dbs.x, dbs.y);
  (finalPass.fullscreenMaterial as EffectMaterial).encodeOutput = false; // the grain effect encodes (sRGB) itself
  const cap = createDisplayCapture(dbs.x, dbs.y);

  // ---- state
  const enabled: Record<Toggle, boolean> = { ao: true, bloom: true, lens: true, grain: true, smaa: true, exposure: true, grade: true };
  let film: Settings['film'] = { ...s.film };
  let brightnessEV = s.brightnessEV;
  let atm: AtmosphereState | null = null;
  const exposure: { ev100: number; value: number; locked: boolean } = { ev100: PHOTOMETRY.EV100_L0, value: exposureFromEv(PHOTOMETRY.EV100_L0, 0, 0), locked: false };
  const spring: ExposureState = { ev: PHOTOMETRY.EV100_L0, vel: 0 };
  let lockedEv: number | null = null;
  let snapLeft = 0;
  let lastMeasure = 0;
  let targetEv: number = PHOTOMETRY.EV100_L0;
  let paused = false;
  let glitchLeft = 0;
  let glitchDur = 1;
  let glitchStrength = 0;
  let glitchSeed = 0;
  let frames = 0;
  let warmed = false;
  // the device-pixel ratio the render scale is relative to (renderScale = applied pixel ratio / this); stored when
  // it is applied so a later live devicePixelRatio change (window moved between monitors) cannot skew it
  let baseDpr = Math.max(1e-3, Math.min(globalThis.devicePixelRatio || 1, q.maxDpr));
  const captures: { w: number; h: number; resolve: (px: Uint8Array) => void; reject: (e: unknown) => void }[] = [];

  const applyEnabled = (): void => {
    n8ao.enabled = enabled.ao && quality.ao !== 'off';
    bloom.active = enabled.bloom;
    aaPass.enabled = enabled.smaa && quality.aa !== 'off';
    grade.enabled = enabled.grade;
  };

  /** Which composer ping-pong buffer holds the output after passes 1-5 (mirrors EffectComposer.render). */
  const resultBuffer = (): THREE.WebGLRenderTarget => {
    let a = composer.inputBuffer;
    let b = composer.outputBuffer;
    const ps = composer.passes;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.enabled) continue;
      if (p.needsSwap) { const t = a; a = b; b = t; }
    }
    return a;
  };

  const updateExposure = (realDt: number): void => {
    const range0 = atm ? atm.ev100Range[0] : 6.5;
    const range1 = atm ? atm.ev100Range[1] : 11;
    if (ae.measurements !== lastMeasure) {
      lastMeasure = ae.measurements;
      targetEv = Math.min(range1, Math.max(range0, ev100FromLog2(ae.measuredLog2)));
      if (snapLeft > 0) { snapLeft--; spring.ev = targetEv; spring.vel = 0; }
    } else {
      targetEv = Math.min(range1, Math.max(range0, targetEv));
    }
    if (lockedEv !== null) { spring.ev = lockedEv; spring.vel = 0; }
    else if (!enabled.exposure) { spring.ev = PHOTOMETRY.EV100_L0; spring.vel = 0; }
    else if (!paused) {
      if (Math.abs(targetEv - spring.ev) < P.EV_DEADBAND && Math.abs(spring.vel) < 0.05) spring.vel = 0;
      else stepExposure(spring, targetEv, realDt);
    }
    // exposure = 1 / (1.2 * 2^(EV100 - bias - brightnessEV)); a lock pins EV100 only, so the zone's look offset
    // (exposureBias) and the user's brightness still apply exactly as they do under auto-exposure.
    const bias = atm ? atm.exposureBias : 0;
    const e = exposureFromEv(spring.ev, bias, brightnessEV);
    exposure.ev100 = spring.ev;
    exposure.value = e;
    exposure.locked = lockedEv !== null;
    ae.maxLum = meterClamp(spring.ev);
    // flashlight on: the camcorder meters the beam (centre-weighted spot) rather than the whole dark frame
    ae.centerFocus = atm && atm.flashlight ? Math.min(1, Math.max(0, atm.flashlight)) : 0;
  };

  const updateUniforms = (realDt: number, t: number): void => {
    const e = exposure.value;
    exposureFx.exposure = e;
    // bloom threshold in absolute nits: starts where the exposed luminance exceeds 1
    bloom.luminanceMaterial.threshold = 1 / e;
    bloom.luminanceMaterial.smoothing = P.BLOOM_SMOOTHING / e;
    const bi = atm ? atm.bloomIntensity : 0.5;
    bloom.intensity = enabled.bloom ? bi * P.BLOOM_SCALE : 0;
    // halation: the two coarsest upsampling mips of the bloom blur (they already hold the coarser levels)
    const ups = (bloom.mipmapBlurPass as unknown as { upsamplingMipmaps: THREE.WebGLRenderTarget[] }).upsamplingMipmaps;
    if (enabled.bloom && ups.length >= 1) {
      const t0 = ups[Math.max(0, ups.length - 1)].texture;
      const t1 = ups[Math.max(0, ups.length - 2)].texture;
      const k = P.HALATION * bi * P.BLOOM_SCALE;
      const T = P.HALATION_TINT;
      exposureFx.setHalation(t0, t1, T[0] * k, T[1] * k, T[2] * k);
    } else exposureFx.setHalation(null, null, 0, 0, 0);
    if (atm) {
      if (Math.abs(atm.aoIntensity - aoIntensitySet) > 1e-3) { aoIntensitySet = atm.aoIntensity; n8ao.configuration.intensity = atm.aoIntensity; }
      const c = atm.aoColor;
      if (c[0] !== aoColorLin.r || c[1] !== aoColorLin.g || c[2] !== aoColorLin.b) {
        aoColorLin.setRGB(c[0], c[1], c[2]);
        // n8ao converts its colour sRGB -> linear; hand it the sRGB encoding of the linear table colour
        n8ao.configuration.color.setRGB(c[0], c[1], c[2]).convertLinearToSRGB();
      }
      grade.setGrade(atm.grade);
    }
    const frame = Math.floor(t * 24);
    // lens (film strengths) and glitch
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    // the optical vignette acts on HDR radiance (ExposureEffect) so clipped emitters stay white near the edges
    if (enabled.lens) { lens.setLens(film.distortion, film.chromaticAberration, 0, tanHalf); lens.setMtf(LENS_MTF.MIX, LENS_MTF.UNSHARP); }
    else { lens.setLens(0, 0, 0, tanHalf); lens.setMtf(0, 0); }
    exposureFx.setVignette(enabled.lens ? film.vignette : 0, tanHalf * VIGNETTE_FOCAL);
    // glitch: the displacement PATTERN derives from simulation t (frame index), the envelope decays with real
    // time so a glitch still ends while the simulation clock is frozen (time=)
    let ga = 0;
    if (glitchLeft > 0) {
      glitchLeft = Math.max(0, glitchLeft - realDt);
      const k = glitchLeft / glitchDur;
      ga = glitchStrength * Math.sqrt(k);
    }
    lens.setGlitch(ga, frame, glitchSeed);
    const fm = atm && atm.flickerMode !== undefined ? atm.flickerMode : 0;
    const band = fm >= 2 ? 0 : fm >= 1 ? P.BEAT_BAND * 0.5 : P.BEAT_BAND;
    lens.setCamcorder(enabled.lens && film.camcorder, frame, t, band);
    // grain: sigma ~ grain * sqrt(scene exposure / exposure_ref) (dark footage is noisier), plus the low-light AGC boost
    // (grain and chroma noise grow as the metered EV falls below LOW_LIGHT_EV: a camcorder at max gain)
    const g = atm ? atm.grain : 0.5;
    const low = smoothstep(P.LOW_LIGHT_EV, P.LOW_LIGHT_EV_MIN, exposure.ev100);
    // the gain follows the metered scene EV (not the zone's look bias, not the user's brightness)
    const eScene = exposureFromEv(exposure.ev100, 0, 0);
    const gain = Math.min(P.GRAIN_GAIN_MAX, Math.max(P.GRAIN_GAIN_MIN, Math.sqrt(eScene / EXPOSURE_REF)) * (1 + P.LOW_LIGHT_GAIN * low));
    const sigma = enabled.grain ? P.GRAIN_SIGMA * g * film.grain * gain * (film.camcorder ? 1.3 : 1) : 0;
    grain.setGrain(sigma, frame, P.GRAIN_CHROMA + P.LOW_LIGHT_CHROMA * low, grade.pedestal);
  };

  const setSizeAll = (w: number, h: number): void => {
    composer.setSize(w, h);
    renderer.getDrawingBufferSize(dbs);
    finalPass.setSize(dbs.x, dbs.y);
    cap.setSize(dbs.x, dbs.y);
  };

  const post: PostStack = {
    render(realDt, t) {
      frames++;
      updateExposure(realDt);
      updateUniforms(realDt, t);
      composer.render(realDt);
      const src = resultBuffer();
      // Keep the display copy only on capture frames. Normal play can write the final
      // encoded image straight to the canvas, avoiding a full-resolution copy and target.
      const capturing = captures.length > 0;
      finalPass.renderToScreen = !capturing;
      (finalPass.fullscreenMaterial as EffectMaterial).encodeOutput = false;
      finalPass.render(renderer, src, capturing ? cap.display : null, realDt, false);
      if (capturing) cap.blit(renderer);
      if (!warmed) { warmed = true; cap.warm(renderer); }
      if (captures.length > 0) {
        for (const c of captures.splice(0)) cap.read(renderer, c.w, c.h).then(c.resolve, c.reject);
      }
    },
    setSize(w, h) {
      setSizeAll(w, h);
    },
    setQuality(nq) {
      quality = nq;
      const nAoKey = `${nq.ao}:${nq.aoHalfRes}`;
      if (nAoKey !== aoKey) {
        aoKey = nAoKey;
        const old = n8ao;
        const idx = composer.passes.indexOf(old);
        renderer.getDrawingBufferSize(dbs);
        n8ao = makeN8ao(nq, dbs.x, dbs.y);
        // add before removing: the composer keeps its shared depth texture (removing the only depth user frees it)
        composer.addPass(n8ao, idx >= 0 ? idx : 1);
        composer.removePass(old);
        disposeN8ao(old);
      }
      if (bloom.mipmapBlurPass.levels !== nq.bloomLevels) bloom.mipmapBlurPass.levels = nq.bloomLevels;
      const key = nq.aa === 'smaa' ? `smaa:${nq.smaaPreset}` : 'fxaa';
      if (key !== aaKey) {
        aaKey = key;
        const old = aaPass;
        composer.removePass(old);
        old.dispose();
        aaPass = makeAA(nq);
        composer.addPass(aaPass);
      }
      applyEnabled();
      const css = renderer.getSize(new THREE.Vector2());
      baseDpr = effectiveDpr(nq);
      renderer.setPixelRatio(baseDpr * maxScaleFor(nq));
      setSizeAll(css.x, css.y);
    },
    setAtmosphere(a) {
      atm = a;
    },
    setFilm(f, bEV) {
      film = { ...f };
      brightnessEV = bEV;
    },
    setEnabled(p) {
      for (const k of Object.keys(p) as Toggle[]) {
        const v = p[k];
        if (typeof v === 'boolean') enabled[k] = v;
      }
      applyEnabled();
    },
    setExposureLock(ev100) {
      lockedEv = ev100 === null || !Number.isFinite(ev100) ? null : ev100;
      if (lockedEv !== null) { spring.ev = lockedEv; spring.vel = 0; }
      exposure.locked = lockedEv !== null;
      exposure.ev100 = spring.ev;
      exposure.value = exposureFromEv(spring.ev, atm ? atm.exposureBias : 0, brightnessEV);
    },
    snapExposure() {
      snapLeft = P.SNAP_MEASUREMENTS;
      if (lastMeasure > 0) { spring.ev = targetEv; spring.vel = 0; }
    },
    glitch(seconds, strength) {
      glitchDur = Math.max(0.05, seconds);
      glitchLeft = glitchDur;
      glitchStrength = Math.max(0, Math.min(1, strength));
      glitchSeed = (glitchSeed + 17.13) % 997;
    },
    setPaused(p) {
      paused = p;
      ae.paused = p;
    },
    capture(w, h) {
      return new Promise<Uint8Array>((resolve, reject) => { captures.push({ w, h, resolve, reject }); });
    },
    exposure,
    get renderScale() {
      return renderer.getPixelRatio() / baseDpr;
    },
    dispose() {
      composer.dispose();
      finalPass.dispose();
      cap.dispose();
      for (const c of captures.splice(0)) c.reject(new Error('post stack disposed'));
    },
  };
  applyEnabled();
  internals.set(post, {
    composer, get n8ao() { return n8ao; }, autoExposure: ae, bloom, finalPass,
    get passes() { return composer.passes; },
    targetEv: () => targetEv,
    measurements: () => ae.measurements,
  });
  void frames;
  return post;
}
