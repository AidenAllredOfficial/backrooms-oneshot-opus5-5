// tests/textures/registry.test.ts (WP8): recipe registry completeness and static GLSL sanity checks.
// GPU checks (albedo means, tile seams, arrow orientation) run in harness/materials.html.

import { describe, expect, it } from 'vitest';
import { Mat, MAT_COUNT, SignKind } from '../../src/core/ids.ts';
import { LAYER_DEFS, layerRepeatY } from '../../src/core/materials.ts';
import { buildRecipeFragment, buildStandaloneFragment, COMMON_GLSL, HEIGHT_PACK_GLSL, NORMAL_FRAGMENT, RECIPE_MAIN } from '../../src/textures/glsl/common.ts';
import { NOISE_GLSL } from '../../src/textures/glsl/noise.ts';
import { LAYER_RECIPES, LAYER_RECIPES_FULL } from '../../src/textures/registry.ts';
import { SIGN_ASPECT, signSlotRect, STENCIL_SLOTS } from '../../src/textures/signage.ts';
import { GRIME_GLSL } from '../../src/textures/grime.ts';
import { WATER_NORMALS_GLSL } from '../../src/textures/waterNormals.ts';
import { COOKIE_GLSL } from '../../src/textures/cookie.ts';

const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function balanced(src: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of stripComments(src)) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs) { if (stack.pop() !== pairs[ch]) return false; }
  }
  return stack.length === 0;
}

const isMultiple = (frame: number, pitch: number): boolean => {
  const k = frame / pitch;
  return Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1;
};

describe('LAYER_RECIPES', () => {
  it('covers every MatId exactly once, index = MatId', () => {
    expect(LAYER_RECIPES.length).toBe(MAT_COUNT);
    LAYER_RECIPES.forEach((r, i) => expect(r.layer).toBe(i));
    const ids = Object.values(Mat).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: MAT_COUNT }, (_, i) => i));
  });

  it('every GLSL snippet declares gen(vec2 uv, inout Surf s)', () => {
    for (const r of LAYER_RECIPES) {
      expect(stripComments(r.glsl), LAYER_DEFS[r.layer].name).toMatch(/void\s+gen\s*\(\s*vec2\s+uv\s*,\s*inout\s+Surf\s+s\s*\)/);
    }
  });

  it('has balanced brackets and sane parameters', () => {
    for (const r of LAYER_RECIPES_FULL) {
      const name = LAYER_DEFS[r.layer].name;
      expect(balanced(r.glsl), name).toBe(true);
      expect(Number.isFinite(r.normalStrength) && r.normalStrength > 0, name).toBe(true);
      expect(Number.isFinite(r.heightScale) && r.heightScale > 0 && r.heightScale < 0.1, name).toBe(true);
      for (const t of r.trim) expect(t > 0.7 && t < 1.6, `${name} trim ${t}`).toBe(true);
    }
  });

  it('never uses nondeterministic or per-frame inputs', () => {
    for (const r of LAYER_RECIPES) {
      const g = stripComments(r.glsl);
      expect(g, LAYER_DEFS[r.layer].name).not.toMatch(/\buTime\b|gl_FragCoord/);
    }
  });

  it('keeps integer periods: literal uv multipliers are integers', () => {
    for (const r of LAYER_RECIPES) {
      const g = stripComments(r.glsl);
      for (const m of g.matchAll(/\buv(?:\.[xy])?\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        expect(Number.isInteger(Number(m[1])), `${LAYER_DEFS[r.layer].name}: uv * ${m[1]}`).toBe(true);
      }
      for (const m of g.matchAll(/ivec2\(\s*([0-9.]+)\s*(?:,\s*([0-9.]+))?\s*\)/g)) {
        for (const v of [m[1], m[2]]) if (v !== undefined) expect(Number.isInteger(Number(v)), `${LAYER_DEFS[r.layer].name}: ivec2(${m[0]})`).toBe(true);
      }
    }
  });

  it('texel-band-limits literal uv-frequency grids near the texel Nyquist limit at 1024 (moire, even supersampled)', () => {
    // a regular grid of n cycles per frame beats into moire once n / 1024 approaches 0.5 cycles per texel; the 4x
    // supersampling box filter does not remove it, so such grids must fade with bandLimitPx(n) (texel based)
    for (const r of LAYER_RECIPES) {
      const g = stripComments(r.glsl);
      for (const m of g.matchAll(/\buv(?:\.[xy])?\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        const n = Number(m[1]);
        if (n < 0.3 * 1024) continue;
        expect(g, `${LAYER_DEFS[r.layer].name}: uv * ${n} needs bandLimitPx`).toMatch(new RegExp(`bandLimitPx\\(${n}(\\.0)?\\)`));
      }
    }
  });

  it('metric pitches divide the layer frame (repeat x repeatY), so geometry tiles', () => {
    for (const r of LAYER_RECIPES) {
      const d = LAYER_DEFS[r.layer];
      const frame = { x: d.repeat, y: layerRepeatY(d) };
      const g = stripComments(r.glsl);
      for (const m of g.matchAll(/(?:distLines|mod)\(\s*m\.([xy])\s*,\s*([0-9.]+)\s*\)|floor\(\s*m\.([xy])\s*\/\s*([0-9.]+)\s*\)/g)) {
        const axis = (m[1] ?? m[3]) as 'x' | 'y';
        const p = Number(m[2] ?? m[4]);
        expect(isMultiple(frame[axis], p), `${d.name}: ${m[0]} vs frame ${frame[axis]}`).toBe(true);
      }
      for (const m of g.matchAll(/tiles\(\s*m\s*,\s*vec2\(\s*([0-9.]+)\s*(?:,\s*([0-9.]+))?\s*\)\s*\)/g)) {
        const px = Number(m[1]);
        const py = m[2] !== undefined ? Number(m[2]) : px;
        expect(isMultiple(frame.x, px) && isMultiple(frame.y, py), `${d.name}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('physical-tile layers use a tileSize that divides their frame', () => {
    for (const d of LAYER_DEFS) {
      if (d.tileSize > 0) expect(isMultiple(d.repeat, d.tileSize) && isMultiple(layerRepeatY(d), d.tileSize), d.name).toBe(true);
    }
  });
});

describe('GLSL assembly', () => {
  it('NOISE_GLSL provides the periodic library, all with integer periods', () => {
    for (const sig of [
      /float vnoise\(vec2 uv, ivec2 Pi, int seed\)/, /float gnoise\(vec2 uv, ivec2 Pi, int seed\)/,
      /float fbm\(vec2 uv, ivec2 P, int oct, int seed\)/, /float ridged\(vec2 uv, ivec2 P, int oct, int seed\)/,
      /vec2 warp\(vec2 uv, ivec2 P, int oct, int seed, float amt\)/, /Cell worley\(vec2 uv, ivec2 Pi, float jitter, int seed\)/,
      /struct Cell \{ float f1; float f2; vec2 id; vec2 rel; \}/, /vec2 wrapCell\(vec2 c, vec2 P\)/,
    ]) expect(NOISE_GLSL).toMatch(sig);
    expect(balanced(NOISE_GLSL)).toBe(true);
    expect(balanced(COMMON_GLSL)).toBe(true);
    expect(balanced(RECIPE_MAIN)).toBe(true);
  });

  it('uOut is an int uniform (one program per recipe), never a define', () => {
    for (const r of LAYER_RECIPES_FULL) {
      const d = LAYER_DEFS[r.layer];
      const src = buildRecipeFragment({ layer: r.layer, frame: [d.repeat, layerRepeatY(d)], albedo: d.albedoMean, rough: d.roughness, metal: d.metal, trim: r.trim }, r.glsl);
      expect(src).toMatch(/uniform int uOut;/);
      expect(src).not.toMatch(/#define\s+uOut/);
      expect(src).toContain(`#define FRAME vec2(${d.repeat.toFixed(6)}, ${layerRepeatY(d).toFixed(6)})`);
      expect(balanced(src)).toBe(true);
      expect(src.indexOf('void gen(')).toBeLessThan(src.indexOf('void main()'));
    }
  });

  it('standalone generators define texel()', () => {
    for (const body of [GRIME_GLSL, WATER_NORMALS_GLSL, COOKIE_GLSL]) {
      expect(body).toMatch(/vec4 texel\(vec2 uv\)/);
      expect(balanced(buildStandaloneFragment(body, true))).toBe(true);
    }
  });
});

describe('signage atlas layout', () => {
  it('has one aspect per SignKind and maps slot s to v-row floor(s/4) (canvas row 3 - floor(s/4))', () => {
    expect(SIGN_ASPECT.length).toBe(16);
    expect(signSlotRect(SignKind.EXIT, 1024)).toEqual({ x: 0, y: 768, w: 256 });
    expect(signSlotRect(SignKind.ARROW_UP, 1024)).toEqual({ x: 512, y: 0, w: 256 });
    expect(signSlotRect(SignKind.STAIRS, 512)).toEqual({ x: 384, y: 384, w: 128 });
    for (const s of STENCIL_SLOTS) expect(s >= 0 && s < 16).toBe(true);
  });
});

describe('noise band limiting', () => {
  it('public single-octave vnoise / gnoise fade to their mean near Nyquist (octave functions use the raw lattice)', () => {
    expect(NOISE_GLSL).toMatch(/float vnoise\(vec2 uv, ivec2 Pi, int seed\) \{ return mix\(0\.5, br_vnoise\(uv, Pi, seed\), br_bandLimit\(vec2\(Pi\)\)\); \}/);
    expect(NOISE_GLSL).toMatch(/float gnoise\(vec2 uv, ivec2 Pi, int seed\) \{ return br_bandLimit\(vec2\(Pi\)\) \* br_gnoise\(uv, Pi, seed\); \}/);
    const octaves = NOISE_GLSL.slice(NOISE_GLSL.indexOf('float fbm('), NOISE_GLSL.indexOf('vec2 warp('));
    expect(octaves).not.toMatch(/[^_]gnoise\(|[^_]vnoise\(/); // no double band limit inside fbm / fbmV / turb / ridged
  });
});

describe('height scratch fallback (packed RGBA8)', () => {
  // JS mirror of HEIGHT_PACK_GLSL with 8-bit storage quantisation (texelFetch of RGBA8 returns k / 255)
  const pack = (h: number): [number, number] => {
    const q = Math.floor(Math.min(1, Math.max(0, (h + 0.5) * 0.5)) * 65535 + 0.5);
    const hi = Math.floor(q / 256);
    return [Math.round((hi / 255) * 255), Math.round(((q - hi * 256) / 255) * 255)];
  };
  const unpack = (b: [number, number]): number => (Math.floor(b[0] + 0.5) * 256 + Math.floor(b[1] + 0.5)) / 65535 * 2 - 0.5;

  it('round-trips heights in [-0.5, 1.5] to better than half-float precision near 1', () => {
    let maxErr = 0;
    for (let i = 0; i <= 4000; i++) {
      const h = -0.5 + (2 * i) / 4000;
      maxErr = Math.max(maxErr, Math.abs(unpack(pack(h)) - h));
    }
    expect(maxErr).toBeLessThan(2 / 65535);
    expect(HEIGHT_PACK_GLSL).toMatch(/vec4 br_packH\(float h\)/);
    expect(HEIGHT_PACK_GLSL).toMatch(/float br_unpackH\(vec4 t\)/);
  });

  it('every reader of the scratch honours uHPackIn and the HEIGHT pass can write packed', () => {
    expect(NORMAL_FRAGMENT).toMatch(/uniform int uHPackIn;/);
    expect(NORMAL_FRAGMENT).toMatch(/uHPackIn == 1 \? br_unpackH\(t\) : t\.r/);
    expect(RECIPE_MAIN).toMatch(/uHPackIn == 1 \? br_unpackH\(t\) : t\.r/);
    expect(RECIPE_MAIN).toMatch(/uHPackOut == 1 \? br_packH\(s\.height\)/);
    const r = LAYER_RECIPES_FULL[0];
    const d = LAYER_DEFS[0];
    const src = buildRecipeFragment({ layer: 0, frame: [d.repeat, layerRepeatY(d)], albedo: d.albedoMean, rough: d.roughness, metal: d.metal }, r.glsl);
    expect(src).toMatch(/uniform int uHPackIn;/);
    expect(src).toMatch(/uniform int uHPackOut;/);
    expect(src.indexOf('vec4 br_packH(')).toBeLessThan(src.indexOf('void main()'));
    expect(balanced(NORMAL_FRAGMENT)).toBe(true);
  });
});

describe('water normals', () => {
  it('keeps calm-water slopes (tangent xy scale <= 0.015 per unit of noise gradient)', () => {
    const m = /normalize\(vec3\(-hx \* ([0-9.]+), -hy \* ([0-9.]+), 1\.0\)\)/.exec(WATER_NORMALS_GLSL);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(0.015);
    expect(Number(m![2])).toBe(Number(m![1]));
  });
});
