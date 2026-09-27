// tests/materials/samplerBudget.test.ts — the 16-unit surface sampler budget (the WebGL2 minimum
// MAX_TEXTURE_IMAGE_UNITS, and exactly what ANGLE on D3D11 and Metal expose). Every variant (shell, props, decal,
// water) of every preset is assembled the way three's WebGLProgram does it (includes, light counts of the scene's
// one flashlight: shadowed, with a cookie map; loop unrolling), its #if / #ifdef blocks are evaluated with the
// material's defines, and the sampler units the remaining code references are counted (array elements one by one;
// three's spot shadow map and cookie included). The presets are checked as they run today, with the final values of
// the graphics-realism flags (FINAL below) and with every define on. Runtime twin: materials/warmup.ts.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ShaderChunk, ShaderLib } from 'three';
import { QUALITY, QUALITY_NAMES } from '../../src/core/quality.ts';
import type { QualityConfig, QualityName } from '../../src/core/quality.ts';
import type { TextureSet } from '../../src/core/runtime.ts';
import { createMaterialSystem } from '../../src/materials/MaterialSystem.ts';
import { applySurfaceDefines, SURFACE_VARIANTS } from '../../src/materials/SurfaceMaterial.ts';
import type { SurfaceVariant } from '../../src/materials/SurfaceMaterial.ts';
import type { QualityDefines } from '../../src/materials/shared.ts';
import { SURFACE_SAMPLER_BUDGET } from '../../src/materials/warmup.ts';

/** The final values of the graphics-realism flags (the A.0 plan; owners flip QUALITY to these as they land). */
const FINAL: Record<QualityName, Partial<QualityConfig>> = {
  low: {},
  medium: {
    wetPuddles: true, clothSheen: true, specularAA: true, motionBlurTaps: 6, waterWaves: 3, waterRippleRes: 128,
    waterRippleTexel: 0.06, waterDebris: true, flashlightBounce: 1,
  },
  high: {
    ssr: 'half', ssrMaxRoughness: 0.45, ssrSteps: 48, reflectionProbe: 128, colorPyramidScale: 1, contactShadowSteps: 8,
    wetPuddles: true, detailMaps: true, pom: 1, clothSheen: true, specularAA: true, motionBlurTaps: 8, glareStreaks: true,
    waterRefractionSteps: 8, waterWaves: 6, waterRippleRes: 256, waterRippleTexel: 0.04, waterDebris: true,
    waterCaustics: 'full', waterVolumetrics: 2, volumetrics: 'high', dustMotes: 3000, flashlightBounce: 4, bakeNearRays: 16,
  },
  ultra: {
    ssr: 'half', ssrMaxRoughness: 0.6, ssrSteps: 56, ssrFilter: true, reflectionProbe: 256, colorPyramidScale: 0.67,
    contactShadowSteps: 8, wetPuddles: true, detailMaps: true, pom: 2, clothSheen: true, specularAA: true, motionBlurTaps: 10,
    glareStreaks: true, glareGhosts: true, waterRefractionSteps: 10, waterWaves: 8, waterRippleRes: 512, waterRippleTexel: 0.03,
    waterDebris: true, waterCaustics: 'full', waterVolumetrics: 4, volumetrics: 'ultra', dustMotes: 6000, flashlightBounce: 8,
    bakeNearRays: 32,
  },
};

const ALL_ON: QualityDefines = {
  floorRefl: true, airlight: true, lite: false, ssr: true, probe: true, ssao: true, cs: 8, puddles: true, detail: true, pom: 2,
  sheen: true, coat: true, specAA: true, waterRefract: true, waterWaves: 8, waterRipple: true, waterDebris: true,
  causticsFull: true, waterVolLight: 4, volumetric: true, bounce: 8,
};

// ---------------------------------------------------------------- program assembly (three r186 WebGLProgram)

function resolveIncludes(src: string, depth = 0): string {
  if (depth > 8) throw new Error('include recursion');
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
    const chunk = (ShaderChunk as unknown as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`unknown chunk ${name}`);
    return resolveIncludes(chunk, depth + 1);
  });
}

/** The scene's lights: the flashlight (one spot light, shadowed, with a cookie map). */
function replaceLightNums(s: string): string {
  return s
    .replace(/NUM_SUN_LIGHTS/g, '0').replace(/NUM_DIR_LIGHTS/g, '0').replace(/NUM_SPOT_LIGHTS/g, '1')
    .replace(/NUM_SPOT_LIGHT_MAPS/g, '1').replace(/NUM_SPOT_LIGHT_COORDS/g, '1').replace(/NUM_RECT_AREA_LIGHTS/g, '0')
    .replace(/NUM_POINT_LIGHTS/g, '0').replace(/NUM_HEMI_LIGHTS/g, '0').replace(/NUM_SUN_LIGHT_SHADOWS/g, '0')
    .replace(/NUM_DIR_LIGHT_SHADOWS/g, '0').replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g, '1')
    .replace(/NUM_SPOT_LIGHT_SHADOWS/g, '1').replace(/NUM_POINT_LIGHT_SHADOWS/g, '0')
    .replace(/NUM_CLIPPING_PLANES/g, '0').replace(/UNION_CLIPPING_PLANES/g, '0');
}

function unrollLoops(s: string): string {
  const re = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
  return s.replace(re, (_m, a: string, b: string, body: string) => {
    let out = '';
    for (let i = Number(a); i < Number(b); i++) out += body.replace(/\[\s*i\s*\]/g, `[ ${i} ]`).replace(/UNROLLED_LOOP_INDEX/g, String(i));
    return out;
  });
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Integer value of a #if expression (defined(), ! && || == != < > <= >= + - * /, parentheses; unknown names = 0). */
function evalExpr(expr: string, defs: Map<string, string>, depth = 0): number {
  if (depth > 16) throw new Error(`macro recursion in '${expr}'`);
  const t = expr.match(/defined|[A-Za-z_]\w*|\d+(?:\.\d+)?|&&|\|\||==|!=|<=|>=|[()!<>+\-*/]/g) ?? [];
  let i = 0;
  const bin = (next: () => number, ops: Record<string, (a: number, b: number) => number>) => (): number => {
    let v = next();
    while (i < t.length && ops[t[i]]) { const f = ops[t[i++]]; v = f(v, next()); }
    return v;
  };
  const unary = (): number => {
    const k = t[i++];
    if (k === '(') { const v = or(); i++; return v; }
    if (k === '!') return unary() ? 0 : 1;
    if (k === '-') return -unary();
    if (k === 'defined') {
      let n = t[i++];
      if (n === '(') { n = t[i++]; i++; }
      return defs.has(n) ? 1 : 0;
    }
    if (/^\d/.test(k)) return Number(k);
    const v = defs.get(k);
    return v === undefined || v.trim() === '' ? 0 : evalExpr(v, defs, depth + 1);
  };
  const mul = bin(unary, { '*': (a, b) => a * b, '/': (a, b) => Math.trunc(a / b) });
  const add = bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const rel = bin(add, { '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b) });
  const eq = bin(rel, { '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const and = bin(eq, { '&&': (a, b) => +(a !== 0 && b !== 0) });
  const or: () => number = bin(and, { '||': (a, b) => +(a !== 0 || b !== 0) });
  return or();
}

/** Keep the lines of the active #if branches (object-like #define / #undef tracked in active code). */
function preprocess(src: string, defines: Record<string, string>): string {
  const defs = new Map(Object.entries(defines));
  const out: string[] = [];
  const stack: { parent: boolean; active: boolean; taken: boolean }[] = [];
  const on = (): boolean => stack.length === 0 || stack[stack.length - 1].active;
  for (const line of src.split('\n')) {
    const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!m) { if (on()) out.push(line); continue; }
    const [, dir, rest] = m;
    const top = stack[stack.length - 1];
    if (dir === 'ifdef' || dir === 'ifndef' || dir === 'if') {
      const parent = on();
      const name = rest.trim().split(/\s+/)[0];
      const c = parent && (dir === 'ifdef' ? defs.has(name) : dir === 'ifndef' ? !defs.has(name) : evalExpr(rest, defs) !== 0);
      stack.push({ parent, active: c, taken: c });
    } else if (dir === 'elif') {
      const c = top.parent && !top.taken && evalExpr(rest, defs) !== 0;
      top.active = c;
      top.taken ||= c;
    } else if (dir === 'else') {
      top.active = top.parent && !top.taken;
      top.taken = true;
    } else if (dir === 'endif') {
      stack.pop();
    } else if (on()) {
      if (dir === 'define') {
        const d = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest);
        if (d) defs.set(d[1], d[2] ? '' : d[3].trim());
      } else if (dir === 'undef') defs.delete(rest.trim());
      out.push(line);
    }
  }
  expect(stack.length, 'unbalanced #if').toBe(0);
  return out.join('\n');
}

/** The fragment program text three links for a material (defines from material.defines + the renderer's shadows). */
function assembleFragment(src: string, defines: Record<string, string>): string {
  const full = unrollLoops(replaceLightNums(resolveIncludes(src)));
  return preprocess(stripComments(full), { USE_SHADOWMAP: '', SHADOWMAP_TYPE_PCF: '', ...defines });
}

/** Referenced sampler uniforms of assembled code: name -> texture units (array length). */
function referencedSamplers(code: string): Map<string, number> {
  const decl = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w*sampler\w*)\s+(\w+)\s*(?:\[\s*([^\]]+?)\s*\])?\s*;/g;
  const found = new Map<string, number>();
  for (const m of code.matchAll(decl)) found.set(m[2], m[3] ? evalExpr(m[3], new Map()) : 1);
  const body = code.replace(decl, '');
  const out = new Map<string, number>();
  for (const [name, n] of found) if (new RegExp(`\\b${name}\\b`).test(body)) out.set(name, n);
  return out;
}
const unitsOf = (s: Map<string, number>): number => [...s.values()].reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- materials

function fakeTextures(): TextureSet {
  const t = (): THREE.Texture => new THREE.Texture();
  return { size: 512, albedo: t(), normal: t(), ormh: t(), grime: t(), waterNormals: t(), cookie: t(), dispose() { /* test */ } };
}

interface Built { variant: SurfaceVariant | 'water'; samplers: Map<string, number> }

/** Every variant's referenced samplers for a preset (and optionally a forced define set for the surfaces). */
function build(q: QualityConfig, force?: QualityDefines): Built[] {
  const sys = createMaterialSystem({} as THREE.WebGLRenderer, fakeTextures(), q);
  const t = sys.createTileMaterials(true);
  const out: Built[] = [];
  for (const v of SURFACE_VARIANTS) {
    const m = t[v];
    if (force) applySurfaceDefines(m, v, force);
    const shader = { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
    (m.onBeforeCompile as (s: typeof shader, r: THREE.WebGLRenderer) => void)(shader, {} as THREE.WebGLRenderer);
    out.push({ variant: v, samplers: referencedSamplers(assembleFragment(shader.fragmentShader, m.defines as Record<string, string>)) });
  }
  const w = t.water as THREE.ShaderMaterial;
  out.push({ variant: 'water', samplers: referencedSamplers(assembleFragment(w.fragmentShader, w.defines as Record<string, string>)) });
  return out;
}

const CASES: [string, Built[]][] = [
  ...QUALITY_NAMES.map((n): [string, Built[]] => [n, build(QUALITY[n])]),
  ...QUALITY_NAMES.map((n): [string, Built[]] => [`${n} (final flags)`, build({ ...QUALITY[n], ...FINAL[n] })]),
  ['every define on', build(QUALITY.ultra, ALL_ON)],
];

describe('surface sampler budget (16 texture units)', () => {
  it('the budget constant is the WebGL2 minimum', () => {
    expect(SURFACE_SAMPLER_BUDGET).toBe(16);
  });

  it('the program assembly finds the known samplers (three\'s spot shadow map and cookie included)', () => {
    const [, low] = CASES[0];
    const shell = low.find((b) => b.variant === 'shell')!.samplers;
    for (const n of ['uBrAlbedo', 'uBrNormal', 'uBrOrmh', 'uBrGrime', 'uLmIrr', 'uLmDir', 'uLmMask', 'uLmFlick', 'uEmission', 'uVolMask', 'spotShadowMap', 'spotLightMap']) {
      expect(shell.has(n), n).toBe(true);
    }
    const props = low.find((b) => b.variant === 'props')!.samplers;
    for (const n of ['uVolA', 'uVolB', 'uVolC']) expect(props.has(n), n).toBe(true);
    const water = low.find((b) => b.variant === 'water')!.samplers;
    for (const n of ['uReflTex', 'uEmission', 'uBrWaterNormals', 'uLmIrr', 'uLmDir', 'uLmFlick', 'uVolMask', 'spotShadowMap', 'spotLightMap']) {
      expect(water.has(n), n).toBe(true);
    }
  });

  for (const [name, built] of CASES) {
    it(`${name}: every variant stays within ${SURFACE_SAMPLER_BUDGET} units`, () => {
      for (const b of built) {
        const units = unitsOf(b.samplers);
        expect(units, `${b.variant}: ${[...b.samplers.keys()].join(', ')}`).toBeLessThanOrEqual(SURFACE_SAMPLER_BUDGET);
      }
    });
  }

  it('three\'s own samplers: every surface program samples dfgLUT (material.dfg, lights_fragment_begin); water does not', () => {
    // the plan's inventory (12 shell samplers + probe, SSAO, froxel volume, detail = 16) did not count dfgLUT: with it
    // the high / ultra shell and decal programs reach 17 once all four land, and the budget checks above fail
    // (A.0 with stubs, high / ultra final flags: shell 13, props 12, decal 13, water 9 units)
    for (const [, built] of CASES) {
      for (const b of built) expect(b.samplers.has('dfgLUT'), b.variant).toBe(b.variant !== 'water');
    }
  });

  it('uVolA is referenced by the props program only', () => {
    for (const [, built] of CASES) {
      for (const b of built) expect(b.samplers.has('uVolA'), b.variant).toBe(b.variant === 'props');
    }
  });

  it('BR_SSR compiles the floor planar path (uReflTex) out of every surface program; water keeps it', () => {
    const on = CASES.find(([n]) => n === 'every define on')![1];
    for (const b of on) expect(b.samplers.has('uReflTex'), b.variant).toBe(b.variant === 'water');
    // without SSR: the shell / props floors and water read the planar reflection (decals have no reflection block)
    const high = CASES.find(([n]) => n === 'high')![1];
    for (const b of high) expect(b.samplers.has('uReflTex'), b.variant).toBe(b.variant !== 'decal');
  });

  it('the preprocessor twin evaluates #if expressions like GLSL', () => {
    const d = new Map([['A', ''], ['N', '3'], ['M', 'N']]);
    expect(evalExpr('defined( A ) && N > 2', d)).toBe(1);
    expect(evalExpr('! defined A || M == 3', d)).toBe(1);
    expect(evalExpr('( B + 1 ) * 2 < 2', d)).toBe(0);
    expect(preprocess('#ifdef A\na\n#elif N > 1\nb\n#else\nc\n#endif\n#if N == 3\nd\n#endif', { A: '', N: '3' }).split('\n')).toEqual(['a', 'd']);
    expect(preprocess('#ifdef X\na\n#elif N > 1\nb\n#else\nc\n#endif', { N: '3' })).toBe('b');
  });
});
