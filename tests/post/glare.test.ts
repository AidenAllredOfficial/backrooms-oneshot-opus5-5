// tests/post/glare.test.ts (package C.1 / C.5) — the lens-glare maths (glareMath.ts) and the GlareEffect shader.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EffectPass } from 'postprocessing';
import {
  FLARE, flareHotFraction, ghostUv, GLARE, glareEE, glareLevelTheta, glareRadialDensity, glareWeights, lumaNorm,
  starCompactWeight, starLevel, starStepScale, streakWeights,
} from '../../src/post/glareMath.ts';
import { GLARE_FRAG, GlareEffect } from '../../src/post/effects/GlareEffect.ts';
import { QUALITY } from '../../src/core/quality.ts';

const luma = (w: Float32Array, i: number): number => 0.2126 * w[3 * i] + 0.7152 * w[3 * i + 1] + 0.0722 * w[3 * i + 2];
const TAN_62 = Math.tan((62 * Math.PI) / 360);

describe('glare PSF (C.1)', () => {
  it('the encircled energy is a CDF: 0 at 0, monotone, -> 1', () => {
    expect(glareEE(0)).toBe(0);
    expect(glareEE(Infinity)).toBe(1);
    let prev = 0;
    for (let t = 1e-4; t < 3; t *= 1.2) {
      const e = glareEE(t);
      expect(e).toBeGreaterThanOrEqual(prev);
      expect(e).toBeLessThanOrEqual(1);
      prev = e;
    }
    expect(glareEE(1e3)).toBeGreaterThan(0.999);
  });

  it('the closed form matches numeric integration of its radial density within 1e-4', () => {
    let acc = 0;
    let t = 0;
    const h = 2e-6;
    for (const target of [0.002, 0.005, 0.0087, 0.0349, 0.14]) {
      // Simpson steps up to the target angle
      while (t < target - 1e-12) {
        const b = Math.min(target, t + h);
        acc += ((b - t) / 6) * (glareRadialDensity(t) + 4 * glareRadialDensity((t + b) / 2) + glareRadialDensity(b));
        t = b;
      }
      expect(Math.abs(acc - glareEE(target))).toBeLessThan(1e-4);
    }
  });

  it('about 60 % of the scattered energy stays within 0.6 deg (a halo hugging the source)', () => {
    const e = glareEE((0.6 * Math.PI) / 180);
    expect(e).toBeGreaterThan(0.5);
    expect(e).toBeLessThan(0.7);
  });

  it('level weights are positive and sum to 1 in luma; tints are luma-normalised, violet near, warm far', () => {
    for (const [h, L] of [[1080, 9], [2160, 10], [810, 5], [972, 6], [1080, 8]] as const) {
      const w = glareWeights(TAN_62, h, L);
      let s = 0;
      for (let i = 0; i < L; i++) {
        expect(luma(w, i)).toBeGreaterThan(0);
        s += luma(w, i);
      }
      expect(s).toBeCloseTo(1, 6);
      // first level bluer than the last (purple fringing near, warm veil far)
      const b0 = w[2] / luma(w, 0), bL = w[3 * (L - 1) + 2] / luma(w, L - 1);
      expect(b0).toBeGreaterThan(bL);
    }
    for (const t of [lumaNorm(GLARE.TINT_NEAR), lumaNorm(GLARE.TINT_FAR)]) expect(0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]).toBeCloseTo(1, 12);
    // the design's 1080 px / 62 deg / 9-level shape: ~.26 .22 .11 .10 .09 .07 .05 .03 + remainder
    const w = glareWeights(TAN_62, 1080, 9);
    expect(luma(w, 0)).toBeGreaterThan(0.2);
    expect(luma(w, 0)).toBeLessThan(0.32);
    expect(luma(w, 1)).toBeGreaterThan(0.15);
  });

  it('is resolution-invariant: 2160 px / 10 levels puts the same energy at the same angles as 1080 px / 9 levels', () => {
    const a = glareWeights(TAN_62, 1080, 9);
    const b = glareWeights(TAN_62, 2160, 10);
    // level i at 1080 covers the angles of level i + 1 at 2160 (levels 0 + 1 at 2160 = level 0 at 1080)
    expect(glareLevelTheta(3, TAN_62, 1080)).toBeCloseTo(glareLevelTheta(4, TAN_62, 2160), 12);
    expect(Math.abs(luma(b, 0) + luma(b, 1) - luma(a, 0)) / luma(a, 0)).toBeLessThan(0.02);
    for (let i = 1; i < 9; i++) expect(Math.abs(luma(b, i + 1) - luma(a, i)) / luma(a, i)).toBeLessThan(0.02);
    // and the same colour at the same angle (the tint follows the angle, not the level index)
    for (let i = 1; i < 9; i++) {
      const ra = a[3 * i + 2] / luma(a, i), rb = b[3 * (i + 1) + 2] / luma(b, i + 1);
      expect(Math.abs(ra - rb)).toBeLessThan(1e-6);
    }
  });

  it('the composite conserves energy: out = in (1 - k) + U0 k, no threshold', () => {
    expect(GLARE_FRAG).toMatch(/c = c \* \(1\.0 - uGlareK\) \+ texture2D\(uGlareMap, uv\)\.rgb \* uGlareK;/);
    expect(GLARE_FRAG).not.toMatch(/mainUv/);
    expect(GLARE_FRAG).toMatch(/void mainImage\(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor\)/);
    expect(GLARE.K * 0.5).toBeCloseTo(0.1, 9); // LOBBY bloomIntensity 0.5 -> 10 % scattered
  });

  it('merges into an EffectPass and exposes its chain', () => {
    const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 400);
    const g = new GlareEffect(9);
    const pass = new EffectPass(cam, g);
    expect(() => pass.recompile()).not.toThrow();
    expect(g.chain.levelCount).toBe(9);
    g.setSize(1920, 1080);
    expect(g.chain.down[0].width).toBe(960);
    expect(g.chain.down[0].height).toBe(540);
    expect(g.chain.down[8].width).toBe(4);
    expect(g.chain.up.length).toBe(8);
    expect(g.chain.output).toBe(g.chain.up[0]);
    g.setLevels(5);
    expect(g.chain.down.length).toBe(5);
    // star / ghost targets exist only while their flag is on
    expect(g.chain.starTexture).toBeNull();
    g.setFlare(true, true);
    expect(g.chain.star?.s.width).toBe(480);
    expect(g.chain.star?.e.width).toBe(480);
    expect(g.chain.ghost?.width).toBe(240);
    // ultra's 1.5x supersampled buffer runs the star one level coarser: same on-screen width, same cost
    expect(g.chain.starLevel).toBe(1);
    g.setSize(3840, 2160);
    expect(g.chain.starLevel).toBe(2);
    expect(g.chain.star?.s.width).toBe(480);
    expect(g.chain.ghost?.width).toBe(240);
    g.setFlare(false, false);
    expect(g.chain.star).toBeNull();
    expect(g.chain.ghost).toBeNull();
  });
});

describe('aperture flare (C.5)', () => {
  it('the ghost window uses increasing smoothstep edges for defined results across GPU drivers', () => {
    const g = new GlareEffect(9);
    const shader = g.chain.materials().find((m) => m.name === 'br-glare-ghost')!.fragmentShader;
    const edges = [...shader.matchAll(/smoothstep\(\s*([\d.]+),\s*([\d.]+),/g)];
    expect(edges.length).toBeGreaterThan(0);
    for (const [, lo, hi] of edges) expect(Number(lo)).toBeLessThan(Number(hi));
    g.dispose();
  });

  it('the streak kernels are normalised and decay as OMEGA^(|j| step)', () => {
    for (const step of FLARE.STAR_STEPS) {
      const w = streakWeights(step);
      expect(w.length).toBe(7);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(w[3]).toBeGreaterThan(w[4]);
      expect(w[2]).toBeCloseTo(w[4], 12); // symmetric
      expect(w[4] / w[3]).toBeCloseTo(FLARE.OMEGA ** step, 12);
    }
    // diamond iris: two axes at +-45 deg; rainbow tips: red longer than blue
    expect([...FLARE.STAR_ANGLES].sort()).toEqual([-45, 45]);
    expect(FLARE.STAR_CHROMA[0]).toBeGreaterThan(1);
    expect(FLARE.STAR_CHROMA[1]).toBeLessThan(1);
  });

  it('ghosts are mirrored / scaled through the frame centre', () => {
    expect(FLARE.GHOST_SCALES.length).toBe(FLARE.GHOST_TINTS.length);
    for (const s of FLARE.GHOST_SCALES) {
      expect(ghostUv([0.5, 0.5], s)).toEqual([0.5, 0.5]); // the centre maps to itself
      const [x, y] = ghostUv([0.8, 0.3], s);
      // on the line through the centre, on the opposite side for negative scales
      expect(Math.sign(x - 0.5)).toBe(Math.sign(s));
      expect(Math.abs((y - 0.5) / (x - 0.5) - (0.3 - 0.5) / (0.8 - 0.5))).toBeLessThan(1e-12);
    }
    // there are ghosts on both sides of the centre
    expect(FLARE.GHOST_SCALES.some((s) => s < 0)).toBe(true);
    expect(FLARE.GHOST_SCALES.some((s) => s > 0)).toBe(true);
  });

  it('only overexposed energy feeds the star and ghosts', () => {
    expect(flareHotFraction(1)).toBe(0);
    expect(flareHotFraction(FLARE.STAR_T)).toBe(0);
    expect(flareHotFraction(35)).toBeCloseTo((35 - FLARE.STAR_T) / 35, 12);
    expect(FLARE.STAR_GAIN).toBeGreaterThan(FLARE.GHOST_GAIN);
    expect(FLARE.STAR_GAIN).toBeLessThan(0.01); // subtle in lit rooms, obvious only on bulbs in the dark
  });

  it('the star arms keep their on-screen length at any buffer height (dynamic resolution, high on a 1440p screen)', () => {
    // arm length as a share of the frame height: steps x scale x the level's texel (2^(level+1) buffer px) / height
    const armShare = (h: number): number => {
      const l = starLevel(h, 9);
      return (FLARE.STAR_STEPS[2] * starStepScale(h, l) * 2 ** (l + 1)) / h;
    };
    const ref = armShare(FLARE.STAR_REF_H);
    expect(starStepScale(1080, 1)).toBe(1);
    expect(starStepScale(2160, 2)).toBe(1);
    for (const h of [720, 864, 972, 1080, 1296, 1440, 1500, 1501, 1620, 2160, 2880]) expect(armShare(h), `h ${h}`).toBeCloseTo(ref, 12);
    // continuous across the D1 -> D2 switch
    expect(starStepScale(1501, 2) * 4).toBeCloseTo(starStepScale(1500, 1) * 2, 2);
  });

  it('the star favours compact hot sources over extended ones', () => {
    const T = FLARE.STAR_T;
    // a point source: its hot energy spreads over the coarse level (~1/16 and less of the texel's)
    expect(starCompactWeight(400, 400 / 16)).toBe(1);
    expect(starCompactWeight(2000, 2000 / 30)).toBe(1);
    // a thin line fills a quarter of a coarse texel: mostly kept
    expect(starCompactWeight(200, T + (200 - T) * 0.2)).toBeGreaterThan(0.7);
    // a big tube strip / panel fills it: no broad X
    expect(starCompactWeight(180, 175)).toBe(0);
    expect(starCompactWeight(180, 0.6 * 180)).toBe(0);
    // monotone in the fill
    let prev = 2;
    for (let f = 0; f <= 1; f += 0.05) {
      const w = starCompactWeight(300, T + (300 - T) * f);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    // below the threshold nothing streaks anyway (the weight is irrelevant there)
    expect(flareHotFraction(T * 0.5)).toBe(0);
  });

  it('quality flags: streaks on high / ultra, ghosts on ultra only', () => {
    expect([QUALITY.low, QUALITY.medium, QUALITY.high, QUALITY.ultra].map((q) => q.glareStreaks)).toEqual([false, false, true, true]);
    expect([QUALITY.low, QUALITY.medium, QUALITY.high, QUALITY.ultra].map((q) => q.glareGhosts)).toEqual([false, false, false, true]);
  });
});
