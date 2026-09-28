// tests/bake/ao.test.ts — analytic AO regressions (src/bake/ao.ts).
//   - a long straight wall darkens a receiver strip running along it UNIFORMLY: the 1.2 m edge segments of one wall
//     line count once (min distance per line), not once per segment (the old per-segment product gave a lumpy
//     1.2 m-periodic dark band along every ceiling-wall junction);
//   - a room corner is still darker than the middle of a wall (two perpendicular lines);
//   - round bases (office chairs) get a disc of contact AO darkest under the centre; boxy props keep the rectangle.

import { describe, expect, it } from 'vitest';
import { CELL, STD_CEIL_CM } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { PropKind } from '../../src/core/ids.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { aoAt, aoOut, CONTACT_CORE } from '../../src/bake/ao.ts';
import { createJob } from '../../src/bake/job.ts';
import { Q_HIGH, carveRoom, handNeighborhood, solidLayout } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

describe('AO along a long straight wall', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const g = job.g, n = g.n;
  const ceil = STD_CEIL_CM / 100;
  /** AO of a receiver at chunk-local cell coordinates (x, z), height y, normal n. */
  const ao = (x: number, z: number, y: number, nx: number, ny: number, nz: number): number => {
    const hx = x - g.hl0, hz = z - g.hm0;
    const c = Math.floor(hz) * n + Math.floor(hx);
    aoAt(job, hx, y, hz, nx, ny, nz, c, 0, false);
    return aoOut.ao;
  };

  it('is uniform along the wall (ceiling strip and floor strip, several offsets)', () => {
    for (const [y, ny] of [[ceil - 0.02, -1], [0.02, 1]] as const) {
      for (const off of [0.12, 0.25, 0.5]) {
        let lo = Infinity, hi = -Infinity;
        for (let x = 3; x <= 12; x += 0.05) {
          const a = ao(x, 1 + off, y, 0, ny, 0);
          if (a < lo) lo = a;
          if (a > hi) hi = a;
        }
        expect(hi / lo, `y ${y} offset ${off} cells`).toBeLessThan(1.005);
      }
    }
  });
  it('still darkens a corner more than the middle of a wall', () => {
    const mid = ao(8, 1.2, ceil - 0.02, 0, -1, 0);
    const corner = ao(1.2, 1.2, ceil - 0.02, 0, -1, 0);
    expect(corner).toBeLessThan(mid * 0.95);
  });
});

describe('contact AO footprints', () => {
  /** The contact AO on the floor at metres (x, z) around one prop of `kind` standing at (8.4, 8.4) m, yaw 0.3 rad:
   * relative to the empty room (the room's own planes stay out of it), prop boxes skipped (skipProps; chairs keep
   * their contact AO there: no box of theirs stands on the floor). */
  const floorAo = (kind: number): ((x: number, z: number) => number) => {
    const at = (withProp: boolean): ((x: number, z: number) => number) => {
      const l = solidLayout({ s: 0, cx: 0, cz: 0 });
      carveRoom(l, 1, 1, 15, 15);
      if (withProp) l.props.push({ kind: kind as never, variant: 0, x: 8.4, y: 0, z: 8.4, yaw: 0.3, scale: 1, flags: 0, seed: 1 });
      const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
      const g = job.g, n = g.n;
      return (x, z) => {
        const hx = x / CELL - g.hl0, hz = z / CELL - g.hm0;
        aoAt(job, hx, 0.02, hz, 0, 1, 0, Math.floor(hz) * n + Math.floor(hx), 0, false, true);
        return aoOut.ao;
      };
    };
    const a = at(true), b = at(false);
    return (x, z) => a(x, z) / b(x, z);
  };

  it('an office chair casts a round blob: equal at equal radius, darkest under the centre, gone past R + 0.3 m', () => {
    const ao = floorAo(PropKind.OFFICE_CHAIR);
    const R = 0.5 * PROP_DEFS[PropKind.OFFICE_CHAIR].size[0];
    const c = ao(8.4, 8.4);
    expect(c).toBeCloseTo(0.5, 2); // the core: full strength
    for (const r of [CONTACT_CORE * R + 0.05, R, R + 0.15]) {
      const axis = ao(8.4 + r, 8.4), diag = ao(8.4 + r / Math.SQRT2, 8.4 + r / Math.SQRT2);
      expect(Math.abs(axis - diag), `r ${r}`).toBeLessThan(1e-3); // no square corners
      expect(axis, `r ${r}`).toBeGreaterThan(c);
    }
    expect(ao(8.4 + R, 8.4)).toBeLessThan(ao(8.4 + R + 0.15, 8.4));
    expect(ao(8.4 + R + 0.31, 8.4)).toBeCloseTo(1, 6);
  });

  it('a boxy prop keeps the flat rectangle, darkest out to its footprint edge', () => {
    const ao = floorAo(PropKind.CHAIR_STACKING);
    expect(ao(8.4, 8.4)).toBeCloseTo(0.5, 2);
    expect(ao(8.4 + 0.2, 8.4)).toBeCloseTo(0.5, 2);
  });
});
