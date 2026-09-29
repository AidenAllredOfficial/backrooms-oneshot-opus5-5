// tests/materials/concreteSlab.test.ts — texture realism v2 lane B: the anti-aliasing maths of the concrete slab
// system (chunks/family/concrete.ts). The GLSL helpers are evaluated as written (their one-line bodies run as JS), so
// the test checks the shader's own formulas: a sub-pixel kerf and the dirt bands beside joints and cracks keep their
// integral at every pixel footprint, so far joints neither fade nor darken with distance.

import { describe, expect, it } from 'vitest';
import { CONCRETE_HOOKS } from '../../src/materials/chunks/family/concrete.ts';

type Fn = (...a: number[]) => number;

/** The one-statement GLSL function `name` from the family's pars, as a JS function. */
function glslFn(name: string): Fn {
  const m = new RegExp(`float ${name}\\(([^)]*)\\) \\{\\s*return ([^;]+);\\s*\\}`).exec(CONCRETE_HOOKS.pars);
  if (!m) throw new Error(`${name} not found in CONCRETE_HOOKS.pars`);
  const args = m[1].split(',').map((p) => p.trim().split(/\s+/)[1]);
  const lib = {
    clamp: (v: number, a: number, b: number) => Math.min(Math.max(v, a), b),
    smoothstep: (a: number, b: number, x: number) => {
      const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
      return t * t * (3 - 2 * t);
    },
    min: Math.min, max: Math.max, abs: Math.abs,
  };
  const f = new Function(...Object.keys(lib), `return (${args.join(', ')}) => ${m[2]};`) as (...l: unknown[]) => Fn;
  return f(...Object.values(lib));
}

/** Integral of g over x (m), midpoint rule over [-L, L]. */
function integral(g: (x: number) => number, L: number, n = 40000): number {
  const dx = (2 * L) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += g(-L + (i + 0.5) * dx) * dx;
  return s;
}

describe('concrete slab anti-aliasing (chunks/family/concrete.ts)', () => {
  const box = glslFn('brcBox');
  const band = glslFn('brcBand');

  it('brcBox: a 4.4 mm kerf covers the same integral (its width) at every footprint, 0.2 mm to 20 cm', () => {
    const w = 0.0044;
    for (const f of [0.0002, 0.001, 0.003, 0.0044, 0.0066, 0.01, 0.03, 0.2]) {
      const I = integral((x) => box(x, w, f), w + f + 0.01);
      expect(I / w, `footprint ${f}`).toBeCloseTo(1, 3);
    }
  });

  it('brcBox: full cover inside a line wider than the footprint, at most width / footprint otherwise', () => {
    expect(box(0, 0.0044, 0.001)).toBe(1);
    expect(box(0.0015, 0.0044, 0.001)).toBe(1);
    expect(box(0.004, 0.0044, 0.001)).toBe(0);
    for (const f of [0.005, 0.02, 0.1]) {
      for (const x of [0, 0.001, 0.003, 0.01]) expect(box(x, 0.0044, f)).toBeLessThanOrEqual(0.0044 / f + 1e-12);
    }
  });

  it('brcBand: the joint dirt band and the crack halo keep their integral (the half-width) at every footprint', () => {
    for (const h of [0.003, 0.006, 0.025]) {
      for (const f of [0, 0.0005, 0.005, 0.03, 0.2]) {
        const I = integral((d) => band(d, h, f), h + f + 0.01);
        expect(I / h, `half-width ${h} footprint ${f}`).toBeCloseTo(1, 3);
      }
    }
  });
});
