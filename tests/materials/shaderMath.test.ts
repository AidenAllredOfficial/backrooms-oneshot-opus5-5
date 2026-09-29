import { describe, expect, it } from 'vitest';
import { ShaderChunk, ShaderLib } from 'three';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';
import { FRAG_MAP_GLSL } from '../../src/materials/chunks/surface.ts';
import { FRAG_MATERIAL_POST_GLSL } from '../../src/materials/chunks/materialPost.ts';
import { FRAG_DETAIL_SO_GLSL } from '../../src/materials/chunks/detail.ts';
import { TUNE } from '../../src/materials/chunks/params.ts';
import { LAYER_RECIPES } from '../../src/textures/registry.ts';
import { DETAIL_RECIPES, DETAIL_REPEAT } from '../../src/textures/detail.ts';
import { buildDetailFragment, buildStandaloneFragment } from '../../src/textures/glsl/common.ts';
import { COOKIE_GLSL } from '../../src/textures/cookie.ts';
import { GRIME_GLSL } from '../../src/textures/grime.ts';
import { WATER_NORMALS_GLSL } from '../../src/textures/waterNormals.ts';

describe('material shader maths', () => {
  it('uses ascending constant smoothstep edges in all surface and texture recipe programs', () => {
    const programs = [
      buildSurfaceFragment(ShaderLib.physical.fragmentShader),
      ...LAYER_RECIPES.map((r) => r.glsl),
      ...DETAIL_RECIPES.map((r, layer) => buildDetailFragment({ layer, repeat: DETAIL_REPEAT, slope: r.slope, cavity: r.cavity }, r.glsl)),
      ...[COOKIE_GLSL, GRIME_GLSL, WATER_NORMALS_GLSL].map((g) => buildStandaloneFragment(g)),
    ];
    // GLSL smoothstep is undefined for edge0 >= edge1. Decreasing ramps use 1 - smoothstep(low, high, value).
    const scalar = '(-?\\s*\\d+(?:\\.\\d+)?)';
    const pattern = new RegExp(`\\bsmoothstep\\(\\s*${scalar}\\s*,\\s*${scalar}\\s*,`, 'g');
    for (const src of programs) {
      const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of code.matchAll(pattern)) expect(Number(m[1].replace(/\s/g, '')), m[0]).toBeLessThan(Number(m[2].replace(/\s/g, '')));
    }
  });

  it('bounds the POM view cosine before taking sqrt(1 - cosine squared)', () => {
    expect(FRAG_MAP_GLSL).toContain('float brNdV = clamp( dot( brNv, brV ), 0.06, 1.0 );');
    // Dot products of normalised float32 vectors can exceed one through rounding at a face-on view.
    const n = Math.fround(1 / Math.sqrt(3));
    const raw = Math.fround(Math.fround(n * n) + Math.fround(n * n) + Math.fround(n * n));
    for (const dot of [raw, 1.0000001192092896, 1, 0.4, 0, -0.1]) {
      const cosine = Math.min(1, Math.max(0.06, dot));
      expect(Number.isFinite(Math.sqrt(1 - cosine * cosine) / cosine)).toBe(true);
    }
  });

  it('keeps direct, environment and SSR Fresnel weights consistent on wet metals without changing substrate diffuse', () => {
    // Execute the shader's two scalar F0 edit blocks for an isotropic material. Three uses specularColorBlended for
    // direct light, but mixes specularColor and diffuseColor for environment light. The SSR fallback follows it.
    const code = FRAG_MATERIAL_POST_GLSL.slice(FRAG_MATERIAL_POST_GLSL.indexOf('// 1. wet F0'), FRAG_MATERIAL_POST_GLSL.indexOf('// 3. rough diffuse'))
      .replace(/\bfloat\b/g, 'let');
    const shade = new Function('material', 'brFilm', 'brPuddle', 'brCov', 'BR_WET_FILM_F0', 'vec3', 'max', 'mix', `${code}\nreturn material;`);
    const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
    for (const metalness of [0, 0.5, 1]) for (const film of [0, 0.5, 1]) for (const puddle of [0, 0.5, 1]) for (const coverage of [0, 0.4, 1]) {
      const m = { diffuseColor: 0.6, diffuseContribution: 0.6 * (1 - metalness), specularColor: 0.04, specularColorBlended: mix(0.04, 0.6, metalness), specularF90: 1 };
      shade(m, film, puddle, coverage, TUNE.WET_FILM_F0, (v: number) => v, Math.max, mix);
      const environmentF0 = mix(m.specularColor, m.diffuseColor, metalness);
      expect(environmentF0).toBeCloseTo(m.specularColorBlended, 12);
      expect(m.diffuseContribution).toBe(0.6 * (1 - metalness));
      if (puddle === 1) expect(environmentF0).toBeCloseTo(0.02, 12);
    }
    expect(ShaderChunk.lights_physical_pars_fragment).toContain('vec3 f0 = material.specularColorBlended;');
    expect(ShaderChunk.lights_physical_pars_fragment).toContain('computeMultiscattering( material.dfg, material.diffuseColor, material.specularF90, singleScatteringMetallic, multiScatteringMetallic );');
  });

  it('applies the same detail cavity to inline, SSR and fallback environment reflection while retaining direct and coat light', () => {
    const code = FRAG_DETAIL_SO_GLSL.replace(/^\s*#.*$/gm, '').replace(/\bfloat\b/g, 'let');
    const shade = new Function('reflectedLight', 'brFbSpec', 'brWs', 'brWsRgb', 'brFbDir', 'brMrtSpec', 'brCoat', 'brL', 'BR_L_DETSO', 'brAm', 'brDetL', 'max', 'mix', `${code}\nreturn [reflectedLight.indirectSpecular, brFbSpec, brWs, brWsRgb];`);
    const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
    for (const cavity of [0, 0.4, 1]) for (const share of [0, 0.5, 1]) {
      const attenuation = Math.max(0.5, mix(1, cavity, 0.5 * share));
      const run = (routed: boolean, coat: boolean): number[] => shade({ indirectSpecular: 10 }, 12, 0.05, 0.08, 2, routed, coat, 0, [share], cavity, { y: 1 }, Math.max, mix);
      const inline = run(false, false), routed = run(true, false), coat = run(true, true);
      expect(inline[0]).toBeCloseTo(10 * attenuation, 12);
      expect(routed[1]).toBeCloseTo(2 + inline[0], 12); // fallback keeps its 2-nit baked direct lobe
      expect(routed[2]).toBeCloseTo(0.05 * attenuation, 12); // SSR inherits the same environment attenuation
      expect(routed[3]).toBeCloseTo(0.08 * attenuation, 12); // each RGB channel retains that same cavity visibility
      expect(coat[1]).toBe(12);
      expect(coat[2]).toBe(0.05);
      expect(coat[3]).toBe(0.08);
    }
  });
});
