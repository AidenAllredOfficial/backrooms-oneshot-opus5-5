// tests/post/effects.test.ts (WP11) — effect ordering and attributes. Full EffectPass rendering needs WebGL, so the
// post harness (harness/post.html) verifies the rendered stack; here we assert the static layout and let
// postprocessing's own shader-integration code (EffectPass.recompile, which throws on illegal merges) run in Node.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EffectAttribute, EffectPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { LENS_CA, LensEffect, LENS_FRAG } from '../../src/post/effects/LensEffect.ts';
import { GlareEffect, GLARE_FRAG } from '../../src/post/effects/GlareEffect.ts';
import { MB_FRAG, MotionBlurEffect } from '../../src/post/effects/MotionBlurEffect.ts';
import { FilmGrainEffect, GRAIN_FRAG } from '../../src/post/effects/FilmGrainEffect.ts';
import { ExposureEffect, EXPOSURE_FRAG } from '../../src/post/effects/ExposureEffect.ts';
import { ColorGradeEffect, GRADE_FRAG, whiteBalance } from '../../src/post/effects/ColorGradeEffect.ts';
import { POST_PASSES, POST_TUNING } from '../../src/post/PostStack.ts';
import { ATMOSPHERES } from '../../src/lighting/atmospheres.ts';
import { ZONE_COUNT } from '../../src/core/ids.ts';
import type { ColorGrade } from '../../src/core/runtime.ts';

// CPU mirror of GRADE_FRAG (R2-post), in sRGB-encoded units after white balance: used to pin the white / black ends.
const W = [0.2126, 0.7152, 0.0722];
const ss = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function gradeCpu(g: ColorGrade, e0: [number, number, number]): number[] {
  let e = e0.map((c, i) => g.gain[i] * (c + g.lift[i] * (1 - c)));
  e = e.map((c, i) => Math.max(c, 0) ** (1 / g.gamma[i]));
  const toe = g.toe ?? 0;
  e = e.map((c) => c + (c * c * 1.12 / (c + 0.12) - c) * toe);
  let y = e[0] * W[0] + e[1] * W[1] + e[2] * W[2];
  const sh = ss(0.2, 0.8, y), wh = ss(0.85, 1, y);
  e = e.map((c, i) => c * ((g.shadowTint[i] + (g.highlightTint[i] - g.shadowTint[i]) * sh) * (1 - wh) + wh));
  y = e[0] * W[0] + e[1] * W[1] + e[2] * W[2];
  const k = g.saturation * (0.5 + 0.5 * ss(0.06, 0.65, y));
  e = e.map((c) => y + (c - y) * k);
  const m = Math.max(...e);
  const kn = ss(0.8, 0.97, m);
  e = e.map((c) => Math.min(1, Math.max(0, c + (m - c) * kn)));
  y = e[0] * W[0] + e[1] * W[1] + e[2] * W[2];
  const y2 = y + (g.contrast - 1) * 4 * (y - 0.5) * y * (1 - y);
  e = e.map((c) => c * (y2 / Math.max(y, 1e-4)));
  const p = g.pedestal ?? 0;
  return e.map((c) => p + (1 - p) * Math.min(1, Math.max(0, c)));
}

const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 400);

describe('post effect layout', () => {
  it('pass order matches DESIGN §5.WP11', () => {
    expect(POST_PASSES.map((p) => p.name)).toEqual(['RenderPass', 'AmbientOcclusionPass', 'AutoExposurePass', 'EffectPass', 'EffectPass', 'EffectPass']);
    expect(POST_PASSES[3].effects).toEqual(['MotionBlurEffect', 'GlareEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect']);
    expect(POST_PASSES[4].effects).toEqual(['SMAAEffect|FXAAEffect']); // alone
    expect(POST_PASSES[5].effects).toEqual(['LensEffect', 'FilmGrainEffect']);
  });

  it('the lens is CONVOLUTION without mainUv; grain/exposure/grade are plain', () => {
    const lens = new LensEffect();
    expect(lens.getAttributes() & EffectAttribute.CONVOLUTION).toBe(EffectAttribute.CONVOLUTION);
    expect(LENS_FRAG).not.toMatch(/mainUv/);
    expect(LENS_FRAG).toMatch(/inputBuffer/); // samples the input itself
    for (const [fx, src] of [[new FilmGrainEffect(), GRAIN_FRAG], [new ExposureEffect(), EXPOSURE_FRAG], [new ColorGradeEffect(), GRADE_FRAG], [new GlareEffect(8), GLARE_FRAG]] as const) {
      expect(fx.getAttributes()).toBe(EffectAttribute.NONE);
      expect(src).not.toMatch(/mainUv/);
      expect(src).toMatch(/void mainImage\(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor\)/);
    }
  });

  it('lens + grain merge into one pass (postprocessing integration accepts it)', () => {
    const pass = new EffectPass(camera, new LensEffect(), new FilmGrainEffect());
    expect(() => pass.recompile()).not.toThrow();
    // CONVOLUTION effects are sorted first; the grain runs last (it encodes the display output)
    const names = (pass as unknown as { effects: { name: string }[] }).effects.map((e) => e.name);
    expect(names).toEqual(['LensEffect', 'FilmGrainEffect']);
    const frag = (pass.fullscreenMaterial as THREE.ShaderMaterial).fragmentShader;
    expect(frag).toMatch(/MainImage/);
    expect(frag).not.toMatch(/transformedUv/); // no UV transformation in the merged pass
  });

  it('motion blur, glare, exposure, AgX and grade keep their order in pass 4 (motion blur first, reading depth)', () => {
    const pass = new EffectPass(camera, new MotionBlurEffect(camera), new GlareEffect(9), new ExposureEffect(), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new ColorGradeEffect());
    expect(() => pass.recompile()).not.toThrow();
    const names = (pass as unknown as { effects: { name: string }[] }).effects.map((e) => e.name);
    expect(names).toEqual(['MotionBlurEffect', 'GlareEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect']);
    expect(ToneMappingMode.AGX).toBe(7);
    const mb = new MotionBlurEffect(camera);
    expect(mb.getAttributes()).toBe(EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH);
    expect(MB_FRAG).toMatch(/void mainImage\(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor\)/);
    expect(MB_FRAG).not.toMatch(/mainUv/);
    // the merged pass reads the depth once and hands it to the motion blur only
    const frag = (pass.fullscreenMaterial as THREE.ShaderMaterial).fragmentShader;
    expect(frag).toMatch(/float depth = readDepth\(UV\)/);
    expect(pass.needsDepthTexture).toBe(true);
  });

  it('two convolution effects can never share a pass (why SMAA/FXAA sit alone)', () => {
    const pass = new EffectPass(camera, new LensEffect(), new LensEffect());
    expect(() => pass.recompile()).toThrow(/Convolution effects cannot be merged/);
  });

  it('white balance keeps unit luma', () => {
    const v = new THREE.Vector3();
    for (const [t, g] of [[0, 0], [0.1, -0.05], [-0.2, 0.1]]) {
      whiteBalance(t, g, v);
      expect(0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z).toBeCloseTo(1, 10);
    }
    whiteBalance(0.1, 0, v);
    expect(v.x).toBeGreaterThan(v.z); // warmer
  });
});

describe('camcorder grade (R2-post)', () => {
  it('every zone grade clips white to pure white and lifts black to its pedestal', () => {
    for (let z = 0; z < ZONE_COUNT; z++) {
      const g = ATMOSPHERES[z].grade;
      expect(g.gain).toEqual([1, 1, 1]);
      const white = gradeCpu(g, [1, 1, 1]);
      for (const c of white) expect(c).toBeGreaterThanOrEqual(0.995);
      // a slightly warm near-white (a troffer after AgX) still lands on neutral white: >= 250/255 in every channel
      const panel = gradeCpu(g, [1, 0.985, 0.95]);
      for (const c of panel) expect(c * 255).toBeGreaterThanOrEqual(250);
      const ped = g.pedestal ?? 0;
      expect(ped).toBeGreaterThanOrEqual(0.02);
      expect(ped).toBeLessThanOrEqual(0.05);
      const black = gradeCpu(g, [0, 0, 0]);
      for (const c of black) expect(c).toBeGreaterThanOrEqual(ped);
    }
  });

  it('the filmic toe (C.7a): deep shadows fall toward the pedestal, mids and white stay', () => {
    expect(GRADE_FRAG).toMatch(/e = mix\(e, e \* e \* 1\.12 \/ \(e \+ 0\.12\), uToe\);/);
    // directly after the gamma line
    expect(GRADE_FRAG.indexOf('uToe);')).toBeGreaterThan(GRADE_FRAG.indexOf('1.0 / uGamma'));
    for (let z = 0; z < ZONE_COUNT; z++) {
      const t = ATMOSPHERES[z].grade.toe ?? 0;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(0.7);
    }
    const L0 = ATMOSPHERES[0].grade; // LOBBY
    expect(L0.toe).toBeGreaterThan(0);
    expect(Math.max(...gradeCpu(L0, [0.05, 0.05, 0.05]))).toBeLessThanOrEqual(0.075);
    const mid = gradeCpu(L0, [0.5, 0.5, 0.5]);
    const y = W[0] * mid[0] + W[1] * mid[1] + W[2] * mid[2];
    expect(y).toBeGreaterThanOrEqual(0.44);
    expect(y).toBeLessThanOrEqual(0.54);
    const fx = new ColorGradeEffect();
    fx.setGrade(L0);
    expect((fx.uniforms.get('uToe') as THREE.Uniform<number>).value).toBeCloseTo(L0.toe ?? 0, 9);
  });

  it('the shader carries the highlight fade, the knee and the pedestal', () => {
    expect(GRADE_FRAG).toMatch(/smoothstep\(0\.85, 1\.0, y\)/);
    expect(GRADE_FRAG).toMatch(/smoothstep\(0\.8, 0\.97, m\)/);
    expect(GRADE_FRAG).toMatch(/uSatCon\.z \+ \(1\.0 - uSatCon\.z\)/);
    const fx = new ColorGradeEffect();
    fx.setGrade(ATMOSPHERES[0].grade);
    expect(fx.pedestal).toBeCloseTo(ATMOSPHERES[0].grade.pedestal ?? 0, 6);
    fx.enabled = false;
    expect(fx.pedestal).toBe(0);
  });

  it('grain floors softly at the pedestal; the glare scatters a few percent; no halation veil', () => {
    expect(GRAIN_FRAG).toMatch(/max\(e \+ n \+ cn, vec3\(0\.25 \* uGrain\.w\)\)/);
    expect(GRAIN_FRAG).toMatch(/1\.0 \/ 1\.5/); // correlated 1.5 px lattice
    // k = GLARE_K * bloomIntensity (0.3-0.6): 4-9 % of the light is scattered, never added
    expect(POST_TUNING.GLARE_K).toBeGreaterThan(0.05);
    expect(POST_TUNING.GLARE_K).toBeLessThan(0.3);
    expect(GLARE_FRAG).toMatch(/c \* \(1\.0 - uGlareK\) \+ texture2D\(uGlareMap, uv\)\.rgb \* uGlareK/);
    expect(POST_TUNING.GRAIN_GAIN_MAX).toBeGreaterThan(POST_TUNING.GRAIN_GAIN_MIN);
    expect(POST_TUNING.LOW_LIGHT_EV).toBeGreaterThan(POST_TUNING.LOW_LIGHT_EV_MIN);
    expect(EXPOSURE_FRAG).not.toMatch(/uHal/);
    expect(EXPOSURE_FRAG).toMatch(/uVig/); // optical vignette before the clip
  });

  it('glare + exposure (vignette) and lens (MTF + camcorder + rolling shutter) still integrate into their passes', () => {
    const hdr = new EffectPass(camera, new MotionBlurEffect(camera), new GlareEffect(5), new ExposureEffect(), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new ColorGradeEffect());
    expect(() => hdr.recompile()).not.toThrow();
    const frag = (hdr.fullscreenMaterial as THREE.ShaderMaterial).fragmentShader;
    expect(frag).toMatch(/GlareMap/); // (uniform names are prefixed when merged)
    expect(frag).toMatch(/Toe/);
    expect(frag).not.toMatch(/Hal0/);
    const lens = new LensEffect();
    lens.setMtf(0.7, 0.25);
    lens.setCamcorder(true, 3, 1.5, 0.025);
    const fin = new EffectPass(camera, lens, new FilmGrainEffect());
    expect(() => fin.recompile()).not.toThrow();
    expect(LENS_FRAG).toMatch(/uMtf/);
    expect(LENS_FRAG).toMatch(/uRS \* \(st\.y - 0\.5\)/);
    expect((fin.fullscreenMaterial as THREE.ShaderMaterial).fragmentShader).toMatch(/RS/);
  });

  it('spectral CA: 5 full-RGB taps, each channel normalised (red outward, blue inward, green centred)', () => {
    const fetch = LENS_FRAG.slice(LENS_FRAG.indexOf('vec3 brLensFetch'), LENS_FRAG.indexOf('void mainImage'));
    expect(fetch.match(/texture2D\(inputBuffer/g)?.length).toBe(5);
    for (const ch of [LENS_CA.R, LENS_CA.G, LENS_CA.B]) {
      expect(ch.length).toBe(5);
      expect(ch.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    const mean = (w: readonly number[]): number => w.reduce((a, x, i) => a + x * LENS_CA.SCALES[i], 0);
    expect(mean(LENS_CA.R)).toBeGreaterThan(0.5);
    expect(mean(LENS_CA.G)).toBeCloseTo(0, 12);
    expect(mean(LENS_CA.B)).toBeLessThan(-0.5);
    // the shader's per-tap weights are the table's columns
    for (let i = 0; i < 5; i++) {
      const v = `vec3(${[LENS_CA.R[i], LENS_CA.G[i], LENS_CA.B[i]].map((x) => (Number.isInteger(x) ? x.toFixed(1) : String(x))).join(', ')}) * t${i}`;
      expect(fetch).toContain(v);
    }
  });
});
