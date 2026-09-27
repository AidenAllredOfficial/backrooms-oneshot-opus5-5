// tests/mesh/rampFill.test.ts — FILLED ramps (SolidFlag.FILLED: masonry steps, pool entries, daises) are meshed as
// built-up bodies: sides down to the floor on their own vertical BOX charts, no soffit and no open wedge under the
// flight; open flights keep their stringers and sloped soffit.

import { describe, expect, test } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { Mat, SolidFlag } from '../../src/core/ids.ts';
import type { Solid } from '../../src/core/layout.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import type { Face } from '../../src/mesh/plan.ts';
import { planTile } from '../../src/mesh/surfaces.ts';
import { asciiNb, tileKey } from './helpers.ts';

const ROOM = [
  '+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+',
  ...Array.from({ length: 12 }, () => '|. . . . . . . . . . . . . . . .|\n+                               +').join('\n').split('\n'),
  '|. . . . . . . . . . . . . . . .|',
  '+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+',
].join('\n');

const BASE = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.WALKABLE_TOP | SolidFlag.RENDER;
/** A free-standing 4-step flight 0 -> 0.6 m over one cell, ascending +x, at cell (i, j). */
const flight = (id: number, i: number, j: number, filled: boolean): Solid => ({
  kind: 'ramp', id, x0: i * CELL, z0: j * CELL, x1: (i + 1) * CELL, z1: (j + 1) * CELL, y0: 0, y1: 0.6, dir: 0, steps: 4,
  mat: Mat.POOL_TILE, flags: BASE | (filled ? SolidFlag.FILLED : 0), bakeGroup: 0,
});

function rampFaces(filled: boolean): Face[] {
  const nb = asciiNb(ROOM, undefined, (l) => { l.solids.push(flight(7, 5, 5, filled)); });
  const { plan } = planTile(nb, tileKey(0, 0, 0, 0), 12);
  const x0 = 5 * CELL, x1 = 6 * CELL, z0 = 5 * CELL, z1 = 6 * CELL;
  return plan.faces.filter((f) => {
    if (!f.spec || !f.spec.key.startsWith('5')) return false; // ramp charts (RAMP, SOFFIT, the filled sides)
    for (let k = 0; k < f.p.length; k += 3) if (f.p[k] < x0 - 1e-6 || f.p[k] > x1 + 1e-6 || f.p[k + 2] < z0 - 1e-6 || f.p[k + 2] > z1 + 1e-6) return false;
    return true;
  });
}
const minY = (f: Face): number => { let m = Infinity; for (let k = 1; k < f.p.length; k += 3) m = Math.min(m, f.p[k]); return m; };

describe('FILLED ramps', () => {
  test('an open flight keeps its soffit and stringers that stop above the floor at the back', () => {
    const faces = rampFaces(false);
    expect(faces.some((f) => f.ny < -0.5 && f.spec!.kind === ChartKind.SOFFIT)).toBe(true);
    const sides = faces.filter((f) => Math.abs(f.nz) > 0.99);
    expect(sides.length).toBeGreaterThan(0);
    // the stringer strip under the top tread hangs above the floor (the wedge under the flight is open)
    expect(Math.max(...sides.map(minY))).toBeGreaterThan(0.2);
  });

  test('a filled flight has no soffit, and its sides reach the floor on vertical BOX charts', () => {
    const faces = rampFaces(true);
    expect(faces.some((f) => f.ny < -0.1)).toBe(false);
    expect(faces.some((f) => f.spec!.kind === ChartKind.SOFFIT)).toBe(false);
    const sides = faces.filter((f) => Math.abs(f.nz) > 0.99);
    expect(sides.length).toBeGreaterThan(0);
    for (const f of sides) {
      expect(minY(f)).toBeCloseTo(0, 6);
      expect(f.spec!.kind).toBe(ChartKind.BOX);
      expect(Math.abs(f.spec!.nrm[2])).toBe(1); // a vertical chart in the side's own plane
      expect(Math.abs(f.spec!.o[2] - f.p[2])).toBeLessThan(1e-6);
    }
    // one chart per side, the two sides on different charts
    const specs = new Set(sides.map((f) => f.spec));
    expect(specs.size).toBe(2);
    // a free-standing back face (s = L, facing +x) from the floor to the top tread, on its own vertical chart
    const back = faces.filter((f) => f.nx > 0.99);
    expect(back.length).toBeGreaterThan(0);
    for (const f of back) { expect(minY(f)).toBeCloseTo(0, 6); expect(f.spec!.kind).toBe(ChartKind.BOX); }
    // treads and risers stay on the sloped RAMP chart
    expect(faces.some((f) => f.ny > 0.99 && f.spec!.kind === ChartKind.RAMP)).toBe(true);
  });

  test('the filled body is closed from the side: side area = the stepped profile down to the floor', () => {
    const area = (f: Face): number => { // polygon area in the side plane (x, y)
      let a = 0;
      const n = f.p.length / 3;
      for (let k = 0; k < n; k++) { const q = (k + 1) % n; a += f.p[k * 3] * f.p[q * 3 + 1] - f.p[q * 3] * f.p[k * 3 + 1]; }
      return Math.abs(a) / 2;
    };
    const one = rampFaces(true).filter((f) => f.nz < -0.99).reduce((s, f) => s + area(f), 0);
    // 3 treads of 0.4 m at 0.15 / 0.3 / 0.45 m: 0.4 * (0.15 + 0.3 + 0.45)
    expect(one).toBeCloseTo(0.4 * 0.9, 6);
  });
});
