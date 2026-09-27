// tests/post/volumetric.test.ts (package F) — froxel volumetrics: the exponential slice mapping, the atlas tiling, the
// phase functions' normalisation, the TS twin of the energy-conserving scan (associativity, the uniform-medium closed
// form, the two-level fold), and the shader contracts (every uniform the passes set is declared; the surface lookup
// only reads the A.0 globals; brHaze stays affine in the colour).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dualHg, hg, PHASE } from '../../src/lighting/phase.ts';
import { LightAtlas } from '../../src/lighting/LightAtlas.ts';
import { GLOBAL_UNIFORMS_GLSL, HAZE_FUNCS_GLSL } from '../../src/materials/chunks/common.ts';
import { VOLUMETRIC_GLSL } from '../../src/materials/chunks/volumetric.ts';
import {
  atlasSize, gridWidth, scanCompose, scanStep, sliceCoord, sliceDepth, VOL, VOL_GRIDS, VolumetricFog,
} from '../../src/post/VolumetricFog.ts';

describe('froxel volumetrics', () => {
  it('slice boundaries: s(b_k) = k, zN and zF at 1 and N, monotone, and the inverse', () => {
    for (const g of Object.values(VOL_GRIDS)) {
      const zN = VOL.ZN, zF = g.zF, n = g.n;
      expect(sliceDepth(0, zN, zF, n)).toBe(0);
      expect(sliceDepth(1, zN, zF, n)).toBeCloseTo(zN, 12);
      expect(sliceDepth(n, zN, zF, n)).toBeCloseTo(zF, 9);
      let prev = -1;
      for (let k = 0; k <= n; k++) {
        const b = sliceDepth(k, zN, zF, n);
        expect(sliceCoord(b, zN, zF, n)).toBeCloseTo(k, 9);
        expect(b).toBeGreaterThan(prev);
        prev = b;
      }
      for (let z = 0.01; z < zF; z *= 1.37) expect(sliceCoord(z * 1.01, zN, zF, n)).toBeGreaterThan(sliceCoord(z, zN, zF, n));
      // slices stay under a metre deep at 10 m
      const s10 = sliceCoord(10, zN, zF, n);
      expect(sliceDepth(Math.floor(s10) + 1, zN, zF, n) - sliceDepth(Math.floor(s10), zN, zF, n)).toBeLessThan(0.8);
    }
    // the ultra far plane stays inside the light atlas window (3 tiles = 57.6 m from the camera tile's edge)
    expect(VOL_GRIDS.ultra.zF).toBeLessThanOrEqual(56);
  });

  it('the atlas tiling covers every slice of both grids at 16:9', () => {
    expect(gridWidth(90, 16 / 9)).toBe(160);
    expect(gridWidth(108, 16 / 9)).toBe(192);
    expect(gridWidth(90, 21 / 9) % 8).toBe(0);
    expect(atlasSize(160, 90, 64)).toEqual([1280, 720]);
    expect(atlasSize(192, 108, 80)).toEqual([1536, 1080]);
    for (const g of Object.values(VOL_GRIDS)) {
      const w = gridWidth(g.h, 16 / 9);
      const [aw, ah] = atlasSize(w, g.h, g.n);
      expect((aw / w) * (ah / g.h)).toBeGreaterThanOrEqual(g.n);
    }
  });

  it('phase functions integrate to 1 over the sphere; HG(g = 0) = 1 / 4 PI', () => {
    const integ = (p: (mu: number) => number): number => {
      let s = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) { const mu = -1 + (2 * (i + 0.5)) / n; s += p(mu); }
      return (2 * Math.PI * 2 * s) / n;
    };
    for (const g of [0, 0.3, PHASE.G_F, PHASE.G_B, PHASE.MIST_G]) expect(integ((mu) => hg(mu, g))).toBeCloseTo(1, 3);
    for (const w of [0, 0.3, PHASE.W_F, 1]) expect(integ((mu) => dualHg(mu, w))).toBeCloseTo(1, 3);
    expect(hg(0.37, 0)).toBeCloseTo(1 / (4 * Math.PI), 12);
    // forward-peaked lamps, a back lobe for the torch at the eye
    expect(dualHg(1)).toBeGreaterThan(5 * dualHg(0));
    expect(dualHg(-1)).toBeGreaterThan(dualHg(0));
  });

  it('the scan: the uniform-medium closed form, associativity, and the two-level fold equals the flat fold', () => {
    // uniform medium: S(z) = s / sigma (1 - exp(-sigma z)), T = exp(-sigma z)
    for (const [s, sigma] of [[0.4, 0.02], [3, 0.3], [0.1, 0]] as const) {
      const acc: [number, number] = [0, 1];
      let z = 0;
      for (let k = 0; k < 64; k++) { const D = sliceDepth(k + 1, 0.5, 48, 64) - sliceDepth(k, 0.5, 48, 64); scanStep(acc, s, sigma, D); z += D; }
      const exact = sigma > 0 ? (s / sigma) * (1 - Math.exp(-sigma * z)) : s * z;
      expect(Math.abs(acc[0] - exact) / exact).toBeLessThan(1e-4);
      expect(acc[1]).toBeCloseTo(Math.exp(-sigma * z), 9);
    }
    // associativity of the composition
    const seg = (s: number, sig: number, D: number): [number, number] => { const a: [number, number] = [0, 1]; scanStep(a, s, sig, D); return a; };
    const a = seg(1.2, 0.1, 0.7), b = seg(0.3, 0.5, 1.1), c = seg(2.5, 0.02, 3);
    const l = scanCompose(scanCompose(a, b), c), r = scanCompose(a, scanCompose(b, c));
    expect(l[0]).toBeCloseTo(r[0], 12);
    expect(l[1]).toBeCloseTo(r[1], 12);
    // two-level: groups of 8 folded locally, then composed, equal the flat front-to-back fold
    const sl = Array.from({ length: 80 }, (_, i) => [0.5 + Math.sin(i) * 0.4, 0.01 + 0.05 * ((i * 7) % 5), 0.1 + 0.03 * i] as const);
    const flat: [number, number] = [0, 1];
    for (const [s, sig, D] of sl) scanStep(flat, s, sig, D);
    let two: [number, number] = [0, 1];
    for (let g = 0; g < 10; g++) {
      const loc: [number, number] = [0, 1];
      for (let i = g * 8; i < g * 8 + 8; i++) scanStep(loc, sl[i][0], sl[i][1], sl[i][2]);
      two = scanCompose(two, loc);
    }
    expect(two[0]).toBeCloseTo(flat[0], 10);
    expect(two[1]).toBeCloseTo(flat[1], 12);
  });

  it('every uniform the passes set is declared in their shaders; the lookup reads only A.0 globals', () => {
    const light = new THREE.SpotLight();
    const fog = new VolumetricFog(new LightAtlas(), light, 'high');
    for (const m of fog.materials) {
      for (const name of Object.keys(m.uniforms)) {
        expect(m.fragmentShader, `${m.name}: ${name}`).toMatch(new RegExp(`uniform [\\w ]+ ${name}\\b`));
      }
    }
    for (const u of ['uVolTex', 'uVolGrid', 'uVolZ', 'uVolScreen']) {
      expect(VOLUMETRIC_GLSL).toContain(u);
      expect(GLOBAL_UNIFORMS_GLSL).toMatch(new RegExp(`uniform \\w+ ${u};`));
    }
    // the haze functions carry the lookup (water takes them without the surface common block), guarded once
    expect(HAZE_FUNCS_GLSL).toContain('vec4 brVolLookup( vec3 viewPos )');
    expect(HAZE_FUNCS_GLSL).toContain('! defined( BR_VOL_LOOKUP )');
    fog.dispose();
  });

  it('brHaze stays affine in the colour on both paths: brHaze(c) = c brHazeT + brHaze(0)', () => {
    // structural check of the GLSL: the froxel path multiplies the colour by v.a (and the far-remainder and edge-fog
    // factors that brVolT multiplies too), and adds only colour-independent terms
    const g = HAZE_FUNCS_GLSL;
    expect(g).toMatch(/if \( brVolOn\(\) \) return brVolFog\( col, irrLocal, viewPos \);/);
    expect(g).toMatch(/if \( brVolOn\(\) \) return brVolT\( viewPos \);/);
    expect(g).toMatch(/col = col \* v\.a \+ v\.rgb;/);
    expect(g).toMatch(/return brVolLookup\( viewPos \)\.a \* exp\( - uHazeDensity \* max\( d - dF, 0\.0 \) \) \* \( 1\.0 - smoothstep/);
    // reflection passes and an invalid volume keep the analytic haze
    expect(g).toMatch(/bool brVolOn\(\) \{ return uVolZ\.w > 0\.5 && uBrReflPass < 0\.5; \}/);
  });
});
