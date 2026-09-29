// tests/materials/wallsCeiling.test.ts — texture realism v2 lane D: the anti-aliasing maths of the wall and ceiling
// hooks (chunks/family/walls.ts, ceiling.ts) and their world lattices. The GLSL helpers are evaluated as written (their
// bodies run as JS with the types dropped), so the test checks the shader's own formulas: a drying front's deposit, a
// seam or crack line, an edge band (torn fibres, lips, cast shadows) and a tack hole keep their integral at every pixel
// footprint (no darkening or fading with distance), and every world lattice repeats over NOISE_WRAP along the surface
// and STOREY_PITCH up a wall.

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP, STOREY_PITCH } from '../../src/core/constants.ts';
import { CEILING_HOOKS } from '../../src/materials/chunks/family/ceiling.ts';
import { WALL_HOOKS, WALL_STAIN } from '../../src/materials/chunks/family/walls.ts';
import { STAIN_FRONT } from '../../src/materials/chunks/grimeLib.ts';

const LIB: Record<string, unknown> = {
  clamp: (v: number, a: number, b: number) => Math.min(Math.max(v, a), b),
  smoothstep: (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  },
  min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp,
};

/** The GLSL function `name` of the walls family's pars as JS: typed declarations become `let`, a vec2 argument is an
 * { x, y } object, `out` parameters are returned in an object (else the return value as `value`). Helpers it calls
 * must have been loaded first (they join the scope). */
function glslFn(name: string): (...a: unknown[]) => Record<string, number> {
  // the closing brace: at the start of a line (a multi-line body) or after a space (a one-line body)
  const m = new RegExp(`(?:float|void) ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)(?:\\n| )\\}\\n`).exec(WALL_HOOKS.pars);
  if (!m) throw new Error(`${name} not found in WALL_HOOKS.pars`);
  const params = m[1].split(',').map((p) => p.trim().split(/\s+/));
  const ins = params.filter((p) => p[0] !== 'out').map((p) => p[p.length - 1]);
  const outs = params.filter((p) => p[0] === 'out').map((p) => p[p.length - 1]);
  const body = m[2]
    .replace(/\b(?:float|int)\s+(\w+)\s*=/g, 'let $1 =')
    .replace(/\bfloat\(\s*(\w+)\s*\)/g, '($1)')
    .replace(/(\w+) \+\+/g, '$1++')
    .replace(/\breturn ([^;]+);/, 'return { value: $1 };');
  const ret = outs.length ? `return { ${outs.join(', ')} };` : '';
  const src = `return (${ins.join(', ')}) => { ${outs.length ? `let ${outs.join(', ')};` : ''} ${body} ${ret} };`;
  const f = new Function(...Object.keys(LIB), src) as (...l: unknown[]) => (...a: unknown[]) => Record<string, number>;
  return f(...Object.values(LIB));
}
/** A GLSL function returning a float, as a JS function that also joins the scope of the functions loaded after it. */
function scalar(name: string): (...a: unknown[]) => number {
  const g = glslFn(name);
  const h = (...a: unknown[]): number => g(...a).value;
  LIB[name] = h;
  return h;
}

/** Integral of g over [a, b], midpoint rule. */
function integral(g: (x: number) => number, a: number, b: number, n = 40000): number {
  const dx = (b - a) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += g(a + (i + 0.5) * dx) * dx;
  return s;
}

const divides = (c: number, P: number): boolean => Math.abs(P / c - Math.round(P / c)) < 1e-9;

describe('lane D wall and ceiling anti-aliasing', () => {
  const fronts = glslFn('brWlFronts');
  const line = scalar('brWlLine');
  const dot = scalar('brWlDot');

  it('brWlFronts: a drying front keeps its deposit integral at every pixel footprint (no darkening with distance)', () => {
    const wp = 0.004; // a 3 mm tide line on a field of ~1.3 / m
    const I0 = (Math.sqrt(Math.PI) / 2 + STAIN_FRONT.INNER) * wp;
    for (const wAA of [0, 0.3 * wp, wp, 3 * wp, 10 * wp, 40 * wp]) {
      // one front: the inner two far away
      const I = integral((sp) => fronts(sp, wp, wAA, 0, 10, 20).tide, -8 * (wp + wAA), 30 * (wp + wAA));
      expect(I / I0, `footprint ${wAA / wp} wp`).toBeCloseTo(1, 2);
    }
  });

  it('brWlFronts: the deposit peaks at 1 when resolved, never exceeds it, and the inner fronts are fainter', () => {
    const wp = 0.004;
    expect(fronts(0, wp, 0, 0, 0.1, 0.2).tide).toBeCloseTo(1, 9);
    for (const wAA of [0, wp, 10 * wp]) {
      for (let sp = -0.05; sp < 0.3; sp += 0.001) expect(fronts(sp, wp, wAA, 0, 0.1, 0.2).tide).toBeLessThanOrEqual(1 + 1e-9);
    }
    const inner = fronts(0.1, wp, 0, 0, 0.1, 0.2).tide;
    expect(inner).toBeCloseTo(1 - WALL_STAIN.NEST_FADE, 2);
    expect(fronts(-0.05, wp, 0, 0, 0.1, 0.2).inside).toBe(0);
    expect(fronts(0.05, wp, 0, 0, 0.1, 0.2).inside).toBe(1);
  });

  it('brWlLine: a seam, crack or runnel keeps its width as the integral at every footprint, and never over-covers', () => {
    for (const hw of [0.0002, 0.00075, 0.005]) {
      for (const fp of [0.00005, 0.0003, 0.001, 0.004, 0.03]) {
        const I = integral((d) => line(d, hw, fp), -(hw + fp + 0.001), hw + fp + 0.001);
        expect(I / (2 * hw), `hw ${hw} fp ${fp}`).toBeCloseTo(1, 3);
        for (const d of [0, 0.5 * hw, hw, 2 * hw]) {
          expect(line(d, hw, fp)).toBeLessThanOrEqual(Math.min(1, (2 * hw) / fp) + 1e-12);
        }
      }
    }
    expect(line(0, 0.005, 0.001)).toBe(1); // resolved: full cover inside
  });

  it('brWlBand: an edge band (torn fibres, a lip, a cast shadow) keeps its integral at every footprint', () => {
    const band = scalar('brWlBand');
    for (const [w0, w1] of [[0.0015, 0.0025], [0.002, 0.009], [0, 0.0006]]) {
      for (const fp of [0, 0.0003, 0.002, 0.01, 0.05]) {
        const I = integral((d) => band(d, w0, w1, fp), 0, w1 + fp + 0.001);
        expect(I / ((w0 + w1) / 2), `band ${w0}-${w1} fp ${fp}`).toBeCloseTo(1, 3);
      }
    }
    expect(band(0, 0.0015, 0.0025, 0)).toBe(1); // resolved: full strength at the edge
  });

  it('brWlDot: a tack or nail hole keeps its area at every footprint', () => {
    const r = 0.0008;
    for (const fp of [0.0001, 0.001, 0.005]) {
      const L = r + fp + 0.001;
      const I = integral((x) => integral((y) => dot({ x, y }, r, fp), -L, L, 400), -L, L, 400);
      expect(I / (Math.PI * r * r), `fp ${fp}`).toBeCloseTo(1, 2);
    }
  });
});

describe('lane D world lattices', () => {
  const cells = (src: string, fn: string): number[] =>
    [...src.matchAll(new RegExp(`${fn}\\( [^,]+, ([0-9.]+), \\d+u \\)`, 'g'))].map((m) => Number(m[1]));

  it('the wall noise cells divide NOISE_WRAP and STOREY_PITCH (no seam at the wrap or up a stair tower)', () => {
    const wall = [...cells(WALL_HOOKS.pars, 'brWlNoise'), ...cells(WALL_HOOKS.grime, 'brWlNoise'),
      ...cells(WALL_HOOKS.grime, 'brWlNoiseD')];
    expect(wall.length).toBeGreaterThanOrEqual(7);
    for (const c of wall) {
      expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
      expect(divides(c, STOREY_PITCH), `${c} | STOREY_PITCH`).toBe(true);
    }
    const ceil = cells(CEILING_HOOKS.grime, 'brClNoise');
    expect(ceil.length).toBeGreaterThanOrEqual(2);
    for (const c of ceil) expect(divides(c, NOISE_WRAP), `${c} | NOISE_WRAP`).toBe(true);
  });

  it('the hashed feature lattices repeat with the world', () => {
    // screw spots 0.4 x 0.3 m (10 rows per storey), blisters 15 mm (200 rows), trim chips 12 mm, runnel columns
    // 0.1 m, life marks 2.4 m, ceiling tiles 0.6 m
    expect(WALL_HOOKS.postSample).toContain('ivec2( int( BR_NOISE_WRAP / 0.4 + 0.5 ), 10 )');
    expect(divides(0.4, NOISE_WRAP) && Math.abs(10 * 0.3 - STOREY_PITCH) < 1e-9).toBe(true);
    expect(WALL_HOOKS.grime).toContain('ivec2( int( BR_NOISE_WRAP / 0.015 + 0.5 ), 200 )');
    expect(divides(0.015, NOISE_WRAP) && Math.abs(200 * 0.015 - STOREY_PITCH) < 1e-9).toBe(true);
    for (const c of [0.012, 0.1, 2.4, 0.6]) expect(divides(c, NOISE_WRAP), `${c}`).toBe(true);
    expect(divides(0.012, STOREY_PITCH)).toBe(true);
  });
});
