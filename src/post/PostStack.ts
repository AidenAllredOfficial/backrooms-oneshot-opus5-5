// src/post/PostStack.ts — the calibrated post stack (WP11), pmndrs postprocessing 6.39.5.
// EffectComposer(HalfFloat, no MSAA); the renderer has NoToneMapping + SRGB output (WP14). Passes (POST_PASSES):
//  1. ScenePass(scene, camera), the frame graph (ScenePass.ts): a depth prepass, the afterDepth hooks (the pre-shade
//     SSAO 'ssao': AmbientOcclusionPass.ts SsaoPre, radius 0.7, distance falloff 0.6, exponent from the atmosphere),
//     shading with LEQUAL and no depth writes, the colour pyramid and the late layer
//  2. (no pass: the surface shader applies the SSAO to the indirect light)
//  3. AutoExposurePass (meter; needsSwap false)
//  4. EffectPass[MotionBlur (HDR camera blur, camcorder shutter; CONVOLUTION | DEPTH, sorted first), Glare (energy-
//     conserving angular PSF + aperture star / ghosts from its own half-res pyramid), Exposure (+ cos^4 vignette), AgX,
//     Grade (+ toe, highlight knee and black pedestal)]
//  5. EffectPass[SMAA | FXAA] (a convolution effect, alone)
//  6. EffectPass[Lens (CONVOLUTION, no mainUv; lens MTF softness + camcorder detail halo), FilmGrain] with dithering,
//     rendered directly to the canvas. Capture frames use an RGBA8 display target, blitted to the canvas and downsampled.
// The composer runs passes 1-5 (autoRenderToScreen off); pass 6 is rendered by hand from whichever ping-pong
// buffer holds the result. Grain encodes sRGB for both output paths.

import * as THREE from 'three';
import { effectiveDpr, maxScaleFor } from './DynamicResolution.ts';
import {
  EffectComposer, EffectPass, FXAAEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode,
} from 'postprocessing';
import type { EffectMaterial, Pass } from 'postprocessing';
import { PHOTOMETRY } from '../core/constants.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { Settings } from '../core/settings.ts';
import type { AtmosphereState, PostStack } from '../core/runtime.ts';
import { SsaoPre } from './AmbientOcclusionPass.ts';
import { AutoExposurePass } from './AutoExposurePass.ts';
import { createDisplayCapture } from './capture.ts';
import { ScenePass } from './ScenePass.ts';
import { ColorGradeEffect } from './effects/ColorGradeEffect.ts';
import { ExposureEffect } from './effects/ExposureEffect.ts';
import { FilmGrainEffect } from './effects/FilmGrainEffect.ts';
import { GlareEffect } from './effects/GlareEffect.ts';
import { MOTION_BLUR, MotionBlurEffect, motionShutter, rollingShutterUv } from './effects/MotionBlurEffect.ts';
import { LENS_MTF, LensEffect, VIGNETTE_FOCAL } from './effects/LensEffect.ts';
import { ev100FromLog2, exposureFromEv, meterClamp, stepExposure } from './exposureMath.ts';
import { FLARE, GLARE } from './glareMath.ts';
import type { ExposureState } from './exposureMath.ts';

/** Static description of the pass layout (asserted by tests/post/effects.test.ts; built by createPostStack). */
export const POST_PASSES: readonly { name: string; effects: readonly string[] }[] = [
  { name: 'RenderPass', effects: [] },
  { name: 'AutoExposurePass', effects: [] },
  { name: 'EffectPass', effects: ['MotionBlurEffect', 'GlareEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect'] },
  { name: 'EffectPass', effects: ['SMAAEffect|FXAAEffect'] },
  { name: 'EffectPass', effects: ['LensEffect', 'FilmGrainEffect'] },
];

export const POST_TUNING = {
  AO_RADIUS: 0.7, // R2-post: tighter, darker contact shadows at wall bases / under furniture
  AO_FALLOFF: 0.6,
  SSAO_POW_SCALE: 0.8, // pre-shade SSAO exponent = atmosphere aoIntensity x this (indirect light only)
  // lens scatter fraction per unit atmosphere bloomIntensity (x the mood's bloomMul): GlareEffect k = GLARE_K * bi
  GLARE_K: GLARE.K,
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

/** AO samples per texel for each preset AO level (the 4x4 interleave multiplies the directions per block by 16). */
export const AO_SAMPLES: Readonly<Record<Exclude<QualityConfig['ao'], 'off'>, number>> = {
  Performance: 8, Low: 10, Medium: 12, High: 16,
};

/** Internals exposed to the post harness / QA only (not part of the PostStack contract). */
export interface PostInternals {
  composer: EffectComposer;
  scenePass: ScenePass;
  /** the pre-shade SSAO helper (the frame graph's 'ssao' hook) */
  ao: SsaoPre;
  autoExposure: AutoExposurePass;
  glare: GlareEffect;
  motionBlur: MotionBlurEffect;
  passes: Pass[];
  finalPass: EffectPass;
  targetEv(): number;
  measurements(): number;
}
const internals = new WeakMap<PostStack, PostInternals>();
export function postInternals(p: PostStack): PostInternals | null {
  return internals.get(p) ?? null;
}

// ssr: read by ScenePass's MRT decision (package A frame graph); URL ssr=0 turns it off for A/B checks
type Toggle = 'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade' | 'ssr';

export function createPostStack(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualityConfig, s: Settings): PostStack {
  const P = POST_TUNING;
  let quality = q;
  const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.autoRenderToScreen = false;

  // 1. scene: the frame graph (depth prepass, hook stages, optional MRT, colour pyramid, late layer)
  const renderPass = new ScenePass(scene, camera);
  renderPass.setQuality(q);

  // 2. pre-shade SSAO: the frame graph's afterDepth hook 'ssao' (order 10). A quality change that alters the AO level
  // or halfRes builds a NEW helper (and disposes the old one) instead of mutating defines, so the program set does
  // not ratchet up across preset cycles.
  const makeAo = (qq: QualityConfig): SsaoPre => {
    const p = new SsaoPre(camera, { samples: qq.ao === 'off' ? AO_SAMPLES.Performance : AO_SAMPLES[qq.ao], halfRes: qq.aoHalfRes });
    p.radius = P.AO_RADIUS;
    p.distanceFalloff = P.AO_FALLOFF;
    p.powScale = P.SSAO_POW_SCALE;
    p.enabled = qq.ao !== 'off';
    return p;
  };
  let ao = makeAo(q);
  let aoKey = `${q.ao}:${q.aoHalfRes}`;
  renderPass.addHook('afterDepth', { name: 'ssao', order: 10, run: (ctx) => ao.run(ctx) });

  // 3. exposure meter
  const ae = new AutoExposurePass();

  // 4. motion blur + glare + exposure + AgX + grade (the motion blur stays in the pass at every preset: taps 0 is a
  // uniform branch, so a quality change never rebuilds this pass; the glare's star / ghost targets follow the flags)
  const motionBlur = new MotionBlurEffect(camera);
  const glare = new GlareEffect(q.bloomLevels);
  glare.setFlare(q.glareStreaks, q.glareGhosts);
  glare.setMotionSource(motionBlur.state);
  const exposureFx = new ExposureEffect();
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new ColorGradeEffect();
  const hdrPass = new EffectPass(camera, motionBlur, glare, exposureFx, toneMapping, grade);

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
  const enabled: Record<Toggle, boolean> = { ao: true, bloom: true, lens: true, grain: true, smaa: true, exposure: true, grade: true, ssr: true };
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
    ao.enabled = enabled.ao && quality.ao !== 'off';
    renderPass.setSsrEnabled(enabled.ssr);
    glare.active = enabled.bloom;
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
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    // glare: scatter fraction k (energy-conserving, no threshold); the PSF is angular, so it needs the FOV and the
    // buffer height. Aperture star / ghosts (C.5) are gated by the lens toggle and Settings.film.flare.
    const bi = atm ? atm.bloomIntensity : 0.5;
    glare.setParams(enabled.bloom ? P.GLARE_K * bi : 0, e, tanHalf, dbs.y);
    const flare = enabled.lens ? film.flare : 0;
    glare.setFlareGains(quality.glareStreaks ? FLARE.STAR_GAIN * flare : 0, quality.glareGhosts ? FLARE.GHOST_GAIN * flare : 0);
    // motion blur (C.4): the camcorder shutter lengthens from 1/60 to 1/30 s at max sensor gain (the same low-light
    // factor as the grain below); Settings.film.motionBlur scales it (0 = off, the motion-sickness opt-out)
    const low = smoothstep(P.LOW_LIGHT_EV, P.LOW_LIGHT_EV_MIN, exposure.ev100);
    motionBlur.set(quality.motionBlurTaps, motionShutter(low, film.motionBlur), MOTION_BLUR.MAX_BLUR * dbs.y);
    if (atm) {
      ao.intensity = atm.aoIntensity; // aoColor is retired: the SSAO multi-bounce keeps the albedo's hue
      grade.setGrade(atm.grade);
    }
    const frame = Math.floor(t * 24);
    // lens (film strengths) and glitch
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
    // CMOS rolling shutter (camcorder mode, C.6): skew from the camera's angular velocity over the frame that is
    // about to render (the motion-blur state of the previous update; zero after a cut or while paused)
    const av = motionBlur.angularVelocity;
    const rs = enabled.lens && film.camcorder && !paused && !motionBlur.wasCut ? rollingShutterUv(av.yaw, av.pitch, tanHalf, camera.aspect) : null;
    lens.setRollingShutter(rs ? rs[0] : 0, rs ? rs[1] : 0);
    // grain: sigma ~ grain * sqrt(scene exposure / exposure_ref) (dark footage is noisier), plus the low-light AGC boost
    // (grain and chroma noise grow as the metered EV falls below LOW_LIGHT_EV: a camcorder at max gain)
    const g = atm ? atm.grain : 0.5;
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
      renderPass.setQuality(nq);
      const nAoKey = `${nq.ao}:${nq.aoHalfRes}`;
      if (nAoKey !== aoKey) {
        aoKey = nAoKey;
        const old = ao;
        ao = makeAo(nq);
        ao.intensity = old.intensity;
        old.dispose();
      }
      glare.setLevels(nq.bloomLevels);
      glare.setFlare(nq.glareStreaks, nq.glareGhosts);
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
    setReflectionDebug(mode) {
      renderPass.composite.setDebug(mode); // package D: URL reflView (the SSR composite's debug outputs)
    },
    setExposureLock(ev100) {
      lockedEv = ev100 === null || !Number.isFinite(ev100) ? null : ev100;
      if (lockedEv !== null) { spring.ev = lockedEv; spring.vel = 0; }
      exposure.locked = lockedEv !== null;
      exposure.ev100 = spring.ev;
      exposure.value = exposureFromEv(spring.ev, atm ? atm.exposureBias : 0, brightnessEV);
    },
    snapExposure() {
      motionBlur.cut(); // teleport / new seed / time=: never blur across it
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
      motionBlur.cut();
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
      ao.dispose(); // a frame-graph hook, not a composer pass
      finalPass.dispose();
      cap.dispose();
      for (const c of captures.splice(0)) c.reject(new Error('post stack disposed'));
    },
  };
  applyEnabled();
  internals.set(post, {
    composer, scenePass: renderPass, get ao() { return ao; }, autoExposure: ae, glare, motionBlur, finalPass,
    get passes() { return composer.passes; },
    targetEv: () => targetEv,
    measurements: () => ae.measurements,
  });
  void frames;
  return post;
}
