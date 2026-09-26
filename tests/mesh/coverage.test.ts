// tests/mesh/coverage.test.ts — WP5 acceptance: every cell side between walkable and SOLID / blocker / VOID space is
// covered (ray casts from walkable cells at 0.5 / 1.5 m in 16 directions, plus down/up-tilted rays, never escape and
// never see a back face), and partitions stand on plinths that hide the floor within PARTITION_BASE_T/2 of the line.

import { describe, expect, test, vi } from 'vitest';
import { CELL, PARTITION_BASE_CM, PARTITION_BASE_T, PARTITION_T, TILE_SIZE } from '../../src/core/constants.ts';
import { tileCell0 } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mat } from '../../src/core/ids.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { blockerNb, mazeNb, mixNb, pitNb } from './fixtures.ts';
import { tileKey } from './helpers.ts';
import { TriSoup } from './raycast.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

function chunkSoup(nb: LayoutNeighborhood): TriSoup {
  const soup = new TriSoup();
  for (let q = 0; q < 4; q++) {
    const { mesh } = buildTile(nb, tileKey(0, 0, 0, q), 12);
    const [li0, lj0] = tileCell0(q);
    soup.add(mesh.shell, li0 * CELL, lj0 * CELL);
  }
  return soup;
}

/** Walkable cells of the centre chunk: not SOLID / VOID, no blocker. */
function walkable(nb: LayoutNeighborhood): [number, number][] {
  const out: [number, number][] = [];
  for (let lj = 0; lj < 32; lj++) {
    for (let li = 0; li < 32; li++) {
      if (nb.flags(li, lj) & (CellFlag.SOLID | CellFlag.VOID)) continue;
      if (nb.blockCm(li, lj) > 0) continue;
      out.push([li, lj]);
    }
  }
  return out;
}

/** Is a point inside a box / ramp solid of the centre chunk (rays from there see back faces by construction)? */
function insideSolid(nb: LayoutNeighborhood, p: number[]): boolean {
  for (const s of nb.center.solids) {
    if (s.kind === 'box') {
      if (p[0] > s.min[0] && p[0] < s.max[0] && p[1] > s.min[1] && p[1] < s.max[1] && p[2] > s.min[2] && p[2] < s.max[2]) return true;
    } else if (s.kind === 'ramp') {
      const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1), z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1);
      if (p[0] > x0 && p[0] < x1 && p[2] > z0 && p[2] < z1 && p[1] < Math.max(s.y0, s.y1)) return true;
    }
  }
  return false;
}

function escapes(nb: LayoutNeighborhood, soup: TriSoup): string[] {
  const bad: string[] = [];
  for (const [li, lj] of walkable(nb)) {
    const fl = nb.floorCm(li, lj) / 100, cl = nb.ceilCm(li, lj) / 100;
    for (const h of [0.5, 1.5]) {
      if (fl + h >= cl - 0.05) continue;
      // slightly off-centre origin so rays do not run exactly along cell lines
      const o = [(li + 0.5) * CELL + 0.013, fl + h, (lj + 0.5) * CELL - 0.021];
      if (insideSolid(nb, o)) continue;
      for (const pitch of [0, -0.45, 0.45, -1.2]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + 0.07;
          const d = [Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch)];
          const hit = soup.cast(o, d, 120);
          if (!hit) bad.push(`escape from (${li},${lj}) h=${h} pitch=${pitch} dir=${k}`);
          else if (!hit.front) bad.push(`back face seen from (${li},${lj}) h=${h} pitch=${pitch} dir=${k} t=${hit.t.toFixed(3)} n=(${hit.nx.toFixed(2)},${hit.ny.toFixed(2)},${hit.nz.toFixed(2)}) layer=${soup.layer[hit.tri]}`);
        }
      }
      // straight up / down
      for (const dy of [-1, 1]) {
        const hit = soup.cast(o, [0.0003, dy, 0.0002], 120);
        if (!hit || !hit.front) bad.push(`${hit ? 'back face' : 'escape'} vertical ${dy} from (${li},${lj})`);
      }
    }
  }
  return bad;
}

describe('coverage fixtures (rays never escape to the clear colour)', () => {
  test('narrow maze: SOLID wall cells behind OPEN edges', () => {
    const nb = mazeNb();
    const bad = escapes(nb, chunkSoup(nb));
    expect(bad.slice(0, 20)).toEqual([]);
  });
  test('SOLID pillars, blockers, steps and soffits', () => {
    const nb = blockerNb();
    const bad = escapes(nb, chunkSoup(nb));
    expect(bad.slice(0, 20)).toEqual([]);
  });
  test('pits (VOID cells)', () => {
    const nb = pitNb();
    const bad = escapes(nb, chunkSoup(nb));
    expect(bad.slice(0, 20)).toEqual([]);
  });
  test('from inside pits (a player falling in): rim strips, blocker sides and pit walls are closed', () => {
    const nb = pitNb();
    const soup = chunkSoup(nb);
    const bad: string[] = [];
    for (let lj = 0; lj < 32; lj++) {
      for (let li = 0; li < 32; li++) {
        if (!(nb.flags(li, lj) & CellFlag.VOID) || nb.flags(li, lj) & CellFlag.SOLID) continue;
        for (const y of [-0.4, -2.5]) {
          const o = [(li + 0.5) * CELL + 0.013, y, (lj + 0.5) * CELL - 0.021];
          for (const pitch of [0, 0.3, 0.8, 1.3, -0.6]) {
            for (let k = 0; k < 16; k++) {
              const a = (k / 16) * Math.PI * 2 + 0.07;
              const d = [Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch)];
              const hit = soup.cast(o, d, 120);
              if (!hit || !hit.front) bad.push(`${hit ? 'back face' : 'escape'} from pit (${li},${lj}) y=${y} pitch=${pitch} dir=${k}`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
  test('mixed edge kinds, openings, trims, ceilings, solids and water', () => {
    const nb = mixNb();
    const bad = escapes(nb, chunkSoup(nb));
    expect(bad.slice(0, 20)).toEqual([]);
  });
});

describe('partitions', () => {
  test('every PARTITION edge has a plinth, and no floor within PARTITION_BASE_T/2 of the line is visible', () => {
    const nb = mixNb();
    const soup = chunkSoup(nb);
    let edges = 0;
    const bad: string[] = [];
    for (let axis = 0; axis < 2; axis++) {
      for (let line = 1; line < 32; line++) {
        for (let c = 0; c < 32; c++) {
          const kind = axis === 0 ? nb.exKind(line, c) : nb.ezKind(c, line);
          if (kind !== EdgeKind.PARTITION) continue;
          const [ai, aj, bi, bj] = axis === 0 ? [line - 1, c, line, c] : [c, line - 1, c, line];
          if ((nb.flags(ai, aj) | nb.flags(bi, bj)) & CellFlag.SOLID) continue;
          edges++;
          const fl = Math.max(nb.floorCm(ai, aj), nb.floorCm(bi, bj)) / 100;
          const lc = line * CELL;
          // rays straight down onto points between the panel and the plinth edge, both sides, along the edge
          for (let k = 1; k < 12; k++) {
            const t = c * CELL + (k / 12) * CELL;
            for (const sg of [-1, 1]) {
              for (const off of [PARTITION_T / 2 + 0.005, 0.05, PARTITION_BASE_T / 2 - 0.004]) {
                const n = lc + sg * off;
                const o = axis === 0 ? [n, fl + 0.5, t] : [t, fl + 0.5, n];
                const hit = soup.cast(o, [0, -1, 0], 2);
                if (!hit || !hit.front) { bad.push(`no front face below ${o.map((v) => v.toFixed(3))}`); continue; }
                const yHit = o[1] - hit.t;
                if (Math.abs(yHit - (fl + PARTITION_BASE_CM / 100)) > 1e-3) bad.push(`floor visible at ${o.map((v) => v.toFixed(3))} (hit y=${yHit.toFixed(3)}, layer ${soup.layer[hit.tri]})`);
                else if (soup.layer[hit.tri] !== Mat.RUBBER) bad.push(`plinth top at ${o.map((v) => v.toFixed(3))} is layer ${soup.layer[hit.tri]}`);
              }
            }
          }
        }
      }
    }
    expect(edges).toBeGreaterThan(8);
    expect(bad.slice(0, 20)).toEqual([]);
    void TILE_SIZE;
  });
});
