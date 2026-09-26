// tests/post/effects.test.ts (WP11) — effect ordering and attributes. Full EffectPass rendering needs WebGL, so the
// post harness (harness/post.html) verifies the rendered stack; here we assert the static layout and let
// postprocessing's own shader-integration code (EffectPass.recompile, which throws on illegal merges) run in Node.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BloomEffect, EffectAttribute, EffectPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { LensEffect, LENS_FRAG } from '../../src/post/effects/LensEffect.ts';
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
    expect(POST_PASSES.map((p) => p.name)).toEqual(['RenderPass', 'N8AOPostPass', 'AutoExposurePass', 'EffectPass', 'EffectPass', 'EffectPass']);
    expect(POST_PASSES[3].effects).toEqual(['BloomEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect']);
    expect(POST_PASSES[4].effects).toEqual(['SMAAEffect|FXAAEffect']); // alone
    expect(POST_PASSES[5].effects).toEqual(['LensEffect', 'FilmGrainEffect']);
  });

  it('the lens is CONVOLUTION without mainUv; grain/exposure/grade are plain', () => {
    const lens = new LensEffect();
    expect(lens.getAttributes() & EffectAttribute.CONVOLUTION).toBe(EffectAttribute.CONVOLUTION);
    expect(LENS_FRAG).not.toMatch(/mainUv/);
    expect(LENS_FRAG).toMatch(/inputBuffer/); // samples the input itself
    for (const [fx, src] of [[new FilmGrainEffect(), GRAIN_FRAG], [new ExposureEffect(), EXPOSURE_FRAG], [new ColorGradeEffect(), GRADE_FRAG]] as const) {
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

  it('bloom, exposure, AgX and grade keep their order in pass 4', () => {
    const pass = new EffectPass(camera, new BloomEffect({ mipmapBlur: true }), new ExposureEffect(), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new ColorGradeEffect());
    expect(() => pass.recompile()).not.toThrow();
    const names = (pass as unknown as { effects: { name: string }[] }).effects.map((e) => e.name);
    expect(names).toEqual(['BloomEffect', 'ExposureEffect', 'ToneMappingEffect', 'ColorGradeEffect']);
    expect(ToneMappingMode.AGX).toBe(7);
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

  it('grain floors softly at the pedestal; bloom is a visible camcorder bloom', () => {
    expect(GRAIN_FRAG).toMatch(/max\(e \+ n \+ cn, vec3\(0\.25 \* uGrain\.w\)\)/);
    expect(GRAIN_FRAG).toMatch(/1\.0 \/ 1\.5/); // correlated 1.5 px lattice
    expect(POST_TUNING.BLOOM_SCALE).toBeGreaterThanOrEqual(0.3);
    expect(POST_TUNING.GRAIN_GAIN_MAX).toBeGreaterThan(POST_TUNING.GRAIN_GAIN_MIN);
    expect(POST_TUNING.LOW_LIGHT_EV).toBeGreaterThan(POST_TUNING.LOW_LIGHT_EV_MIN);
    expect(EXPOSURE_FRAG).toMatch(/uHal0/);
    expect(EXPOSURE_FRAG).toMatch(/uVig/); // optical vignette before the clip
  });

  it('exposure (halation + vignette) and lens (MTF + camcorder) still integrate into their passes', () => {
    const hdr = new EffectPass(camera, new BloomEffect({ mipmapBlur: true }), new ExposureEffect(), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new ColorGradeEffect());
    expect(() => hdr.recompile()).not.toThrow();
    const frag = (hdr.fullscreenMaterial as THREE.ShaderMaterial).fragmentShader;
    expect(frag).toMatch(/Hal0/); // (uniform names are prefixed when merged)
    const lens = new LensEffect();
    lens.setMtf(0.7, 0.25);
    lens.setCamcorder(true, 3, 1.5, 0.025);
    const fin = new EffectPass(camera, lens, new FilmGrainEffect());
    expect(() => fin.recompile()).not.toThrow();
    expect(LENS_FRAG).toMatch(/uMtf/);
  });
});
