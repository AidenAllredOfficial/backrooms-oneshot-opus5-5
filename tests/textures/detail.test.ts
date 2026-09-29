// tests/textures/detail.test.ts (package B) — the detail-map recipes (textures/detail.ts): static GLSL sanity, the
// periodicity of the world repeat, and the LEAN pack twin. GPU generation and the gallery run in
// harness/materials.html?extra=detail.

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP, STOREY_PITCH, TILE_SIZE } from '../../src/core/constants.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import { SURFACE_PHYS, TUNE } from '../../src/materials/chunks/params.ts';
import {
  Det, DETAIL_COUNT, DETAIL_RECIPES, DETAIL_REPEAT, DETAIL_RIPPLE, DETAIL_SIZE, detailPackSlope, detailVariance,
} from '../../src/textures/detail.ts';
import { buildDetailFragment, DETAIL_MAIN, NORMAL_FRAGMENT, SLOPE_GLSL } from '../../src/textures/glsl/common.ts';

const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const integral = (x: number): boolean => Math.abs(x - Math.round(x)) < 1e-9;

function balanced(src: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of stripComments(src)) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs) { if (stack.pop() !== pairs[ch]) return false; }
  }
  return stack.length === 0;
}

describe('detail recipes', () => {
  it('21 layers: D0-D10 surface detail, D11 the puddle ripple, D12-D20 the texture realism v2 slots; index = Det id', () => {
    expect(DETAIL_COUNT).toBe(21);
    expect(DETAIL_RIPPLE).toBe(11);
    expect(DETAIL_RECIPES[DETAIL_RIPPLE].name).toBe('RIPPLE');
    expect(new Set(DETAIL_RECIPES.map((r) => r.name)).size).toBe(DETAIL_COUNT);
    for (const [name, id] of Object.entries(Det)) expect(DETAIL_RECIPES[id].name, name).toBe(name);
  });

  it('reserved slots are neutral placeholders until their lanes fill them (flat, albedo 1, no cavity)', () => {
    // the ids each lane owns (plan: B SLAB / POLISH, C CMU_FACE / CMU_RAW, D ROLLER_STIPPLE / LINEN, E ENAMEL /
    // RUST_GRAIN / KRAFT); a filled slot must keep its name and index
    expect([Det.SLAB, Det.POLISH, Det.CMU_FACE, Det.CMU_RAW, Det.ROLLER_STIPPLE, Det.LINEN, Det.ENAMEL, Det.RUST_GRAIN, Det.KRAFT])
      .toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
    for (const r of DETAIL_RECIPES.slice(12)) {
      if (!/void\s+gen\s*\(\s*vec2\s+uv\s*,\s*inout\s+Surf\s+s\s*\)\s*\{\s*\}/.test(stripComments(r.glsl))) continue; // filled
      expect([r.heightScale, r.slope, r.roughK, r.cavity], r.name).toEqual([1e-4, 0.05, 0, 0]);
    }
  });

  it('every recipe declares gen(vec2 uv, inout Surf s), is balanced and deterministic, with sane parameters', () => {
    for (const r of DETAIL_RECIPES) {
      const g = stripComments(r.glsl);
      expect(g, r.name).toMatch(/void\s+gen\s*\(\s*vec2\s+uv\s*,\s*inout\s+Surf\s+s\s*\)/);
      expect(balanced(r.glsl), r.name).toBe(true);
      expect(g, r.name).not.toMatch(/\buTime\b|gl_FragCoord/);
      expect(r.heightScale > 0 && r.heightScale < 0.1, r.name).toBe(true);
      expect(r.slope, r.name).toBeGreaterThan(0);
      expect(r.roughK, r.name).toBeGreaterThanOrEqual(0);
      expect(r.cavity, r.name).toBeGreaterThanOrEqual(0);
    }
    // the ripple is slope only: its albedo multiplier must stay exactly neutral
    expect(DETAIL_RECIPES[DETAIL_RIPPLE].cavity).toBe(0);
    expect(stripComments(DETAIL_RECIPES[DETAIL_RIPPLE].glsl)).not.toMatch(/s\.albedo|s\.ao/);
  });

  it('keeps integer periods: literal uv multipliers and ivec2 periods are integers', () => {
    for (const r of DETAIL_RECIPES) {
      const g = stripComments(r.glsl);
      for (const m of g.matchAll(/\buv(?:\.[xy])?\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g)) expect(integral(Number(m[1])), `${r.name}: uv * ${m[1]}`).toBe(true);
      for (const m of g.matchAll(/ivec2\(\s*([0-9.]+)\s*(?:,\s*([0-9.]+))?\s*\)/g)) {
        for (const v of [m[1], m[2]]) if (v !== undefined) expect(integral(Number(v)), `${r.name}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('literal uv grids near the texel Nyquist limit are texel-band-limited (moire)', () => {
    for (const r of DETAIL_RECIPES) {
      const g = stripComments(r.glsl);
      for (const m of g.matchAll(/\buv(?:\.[xy])?\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g)) {
        const n = Number(m[1]);
        if (n < 0.3 * DETAIL_SIZE) continue;
        expect(g, `${r.name}: uv * ${n} needs bandLimitPx`).toMatch(new RegExp(`bandLimitPx\\(${n}(\\.0)?\\)`));
      }
    }
  });

  it('the 0.3 m repeat divides NOISE_WRAP, STOREY_PITCH and TILE_SIZE; the ripple repeat too', () => {
    // the shell samples the detail (and the ripple) at tile-local surface coordinates, which is the world pattern only
    // because both repeats divide TILE_SIZE (tile origins, and the wrapped noise origins, are multiples of it)
    for (const span of [NOISE_WRAP, STOREY_PITCH, TILE_SIZE]) expect(integral(span / DETAIL_REPEAT), `${span}`).toBe(true);
    for (const span of [NOISE_WRAP, TILE_SIZE]) expect(integral(span / TUNE.RIPPLE_SCALE), `${span}`).toBe(true);
    expect(integral(TUNE.RIPPLE_SCALE / DETAIL_REPEAT)).toBe(true);
  });

  it('layers with a detail map repeat a whole number of times per 0.3 m on props (vBrUv x round(repeat / 0.3))', () => {
    for (const d of LAYER_DEFS) {
      const p = SURFACE_PHYS[d.id];
      if (p.det < 0) continue;
      expect(p.det, d.name).not.toBe(DETAIL_RIPPLE); // the ripple layer is not a surface detail
      expect(p.det, d.name).toBeLessThan(DETAIL_COUNT);
      expect(integral(d.repeat / DETAIL_REPEAT), d.name).toBe(true);
    }
  });

  it('assembles the pack program; the normal pass shares the Scharr slope', () => {
    const src = buildDetailFragment({ layer: 3, repeat: DETAIL_REPEAT, slope: 0.15, cavity: 0.3 }, DETAIL_RECIPES[3].glsl);
    expect(src).toContain('#define FRAME vec2(0.300000, 0.300000)');
    expect(src).toContain('#define DETAIL_S 0.150000');
    expect(src).toContain(DETAIL_MAIN);
    expect(balanced(src)).toBe(true);
    expect(NORMAL_FRAGMENT).toContain(SLOPE_GLSL);
    expect(NORMAL_FRAGMENT).toMatch(/br_slope\(p, uTexelM, uScale\)/);
    expect(DETAIL_MAIN).toMatch(/br_slope\(c, FRAME \/ uRes, uHeightM\) \/ DETAIL_S/);
  });
});

describe('LEAN pack twin', () => {
  it('a single texel has no variance; its mean slope survives the pack', () => {
    const [r, g, a] = detailPackSlope(0.3, -0.12, 1.2);
    expect(detailVariance(r, g, a, 1.2)).toBeCloseTo(0, 12);
    expect((r * 2 - 1) * 1.2).toBeCloseTo(0.3, 12);
    expect((g * 2 - 1) * 1.2).toBeCloseTo(-0.12, 12);
  });

  it('box filtering keeps the moments exact: the mip of +-s texels holds variance s^2 and mean 0', () => {
    const s = 0.3;
    const p = detailPackSlope(s, 0, 1.2);
    const q = detailPackSlope(-s, 0, 1.2);
    const mip = p.map((v, i) => 0.5 * (v + q[i])) as [number, number, number];
    expect(detailVariance(mip[0], mip[1], mip[2], 1.2)).toBeCloseTo(s * s, 12);
    expect(mip[0]).toBeCloseTo(0.5, 12);
  });

  it('slopes beyond the normalisation are clamped (the pack stays in 0..1)', () => {
    const [r, g, a] = detailPackSlope(5, -5, 1);
    expect([r, g, a]).toEqual([1, 0, 1]);
  });
});
