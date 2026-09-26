// tests/mesh/ownership.test.ts — WP5 acceptance: face ownership (centre + 1 cm * normal lies in a non-SOLID cell of
// the tile) and no coincident faces across a 2x2 block of tiles (inside a chunk and across chunk borders).

import { describe, expect, test, vi } from 'vitest';
import { CELL, CHUNK_SIZE, TILE_SIZE } from '../../src/core/constants.ts';
import { tileCell0, tileOfPoint } from '../../src/core/grid.ts';
import { CellFlag, isRecessedFixture, Zone, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { blockerNb, mazeNb, mixNb, pitNb } from './fixtures.ts';
import { genNb, tileKey, tri } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

/** Ownership violations of one tile's buffer. */
function ownershipProblems(nb: LayoutNeighborhood, q: number, m: MeshBuffers | null, label: string): string[] {
  if (!m) return [];
  const bad: string[] = [];
  const [li0, lj0] = tileCell0(q);
  // recessed fixture geometry is emitted whole in the tile of its centre (the explicit exception): exempt it
  const rec: number[][] = [];
  for (const f of nb.center.fixtures) {
    if (!isRecessedFixture(f.kind) || tileOfPoint(f.px, f.pz) !== q) continue;
    const r = Math.max(f.w, f.h) / 2 + 0.03;
    rec.push([f.px - li0 * CELL - r, f.px - li0 * CELL + r, f.pz - lj0 * CELL - r, f.pz - lj0 * CELL + r, f.py]);
  }
  for (let t = 0; t < m.indexCount / 3; t++) {
    const T = tri(m, t);
    if (rec.some((r) => T.centre[0] > r[0] && T.centre[0] < r[1] && T.centre[2] > r[2] && T.centre[2] < r[3] && Math.abs(T.centre[1] - r[4]) < 0.06)) continue;
    const x = T.centre[0] + T.n[0] * 0.01, z = T.centre[2] + T.n[2] * 0.01;
    if (x < -1e-6 || z < -1e-6 || x > TILE_SIZE + 1e-6 || z > TILE_SIZE + 1e-6) {
      bad.push(`${label}: triangle ${t} centre+1cm*n (${x.toFixed(3)}, ${z.toFixed(3)}) outside the tile`);
      continue;
    }
    const ci = Math.min(15, Math.floor(x / CELL + 1e-7)), cj = Math.min(15, Math.floor(z / CELL + 1e-7));
    if (nb.flags(li0 + ci, lj0 + cj) & CellFlag.SOLID) bad.push(`${label}: triangle ${t} owned by SOLID cell (${li0 + ci}, ${lj0 + cj})`);
    if (bad.length > 10) break;
  }
  return bad;
}

/** Quantized (1 mm) centre + normal keys of every triangle, in chunk-local or world metres (ox, oz). */
function addKeys(m: MeshBuffers | null, ox: number, oz: number, keys: Map<string, string>, label: string, dup: string[]): void {
  if (!m) return;
  for (let t = 0; t < m.indexCount / 3; t++) {
    const T = tri(m, t);
    const k = `${Math.round((T.centre[0] + ox) * 1000)},${Math.round(T.centre[1] * 1000)},${Math.round((T.centre[2] + oz) * 1000)}|` +
      `${Math.round(T.n[0] * 10)},${Math.round(T.n[1] * 10)},${Math.round(T.n[2] * 10)}`;
    const prev = keys.get(k);
    if (prev !== undefined) { if (dup.length < 10) dup.push(`${label} t${t} coincides with ${prev} at ${k}`); }
    else keys.set(k, `${label} t${t}`);
  }
}

describe('face ownership', () => {
  test('ASCII fixtures: every face lies in (faces into) a non-SOLID cell of its tile', () => {
    const fx: [string, LayoutNeighborhood][] = [['maze', mazeNb()], ['blocker', blockerNb()], ['pit', pitNb()], ['mix', mixNb()]];
    for (const [name, nb] of fx) {
      for (let q = 0; q < 4; q++) {
        const { mesh } = buildTile(nb, tileKey(0, 0, 0, q), 12);
        expect(ownershipProblems(nb, q, mesh.shell, `${name} q${q} shell`)).toEqual([]);
        expect(ownershipProblems(nb, q, mesh.decals, `${name} q${q} decals`)).toEqual([]);
      }
    }
  });

  test('generated chunks: ownership in every zone', () => {
    const zones: [ZoneId, StoreyId][] = [[Zone.LOBBY, 0], [Zone.OFFICE, 0], [Zone.MAZE, 0], [Zone.PILLAR_HALL, 0], [Zone.POOLROOMS, 2], [Zone.PARKING, 1], [Zone.PIPEWORKS, 1], [Zone.WAREHOUSE, 1], [Zone.CONCRETE, 1], [Zone.LOW_EXPANSE, 0]];
    for (const [z, s] of zones) {
      const nb = genNb(11, s, 1, 1, z);
      for (let q = 0; q < 4; q++) {
        const { mesh } = buildTile(nb, tileKey(s, 1, 1, q), 12);
        expect(ownershipProblems(nb, q, mesh.shell, `zone ${z} q${q}`)).toEqual([]);
      }
    }
  });
});

describe('no duplicate faces across a 2x2 block of tiles', () => {
  test('the four tiles of a chunk (ASCII fixtures and generated zones)', () => {
    const nbs: [string, LayoutNeighborhood, StoreyId, number, number][] = [
      ['mix', mixNb(), 0, 0, 0], ['maze', mazeNb(), 0, 0, 0], ['pit', pitNb(), 0, 0, 0],
      ['lobby', genNb(3, 0, 0, 0, Zone.LOBBY), 0, 0, 0], ['office', genNb(3, 0, 2, 1, Zone.OFFICE), 0, 2, 1],
      ['pool', genNb(3, 2, 0, 0, Zone.POOLROOMS), 2, 0, 0], ['parking', genNb(3, 1, 0, 0, Zone.PARKING), 1, 0, 0],
    ];
    for (const [name, nb, s, cx, cz] of nbs) {
      const keys = new Map<string, string>(), dup: string[] = [];
      for (let q = 0; q < 4; q++) {
        const { mesh } = buildTile(nb, tileKey(s, cx, cz, q), 12);
        const [li0, lj0] = tileCell0(q);
        addKeys(mesh.shell, li0 * CELL, lj0 * CELL, keys, `${name} q${q}`, dup);
      }
      expect(dup).toEqual([]);
    }
  });

  test('a 2x2 block straddling chunk corners (4 different chunks), mixed zones', () => {
    for (const seed of [1, 2]) {
      const keys = new Map<string, string>(), dup: string[] = [];
      // tiles around the corner shared by chunks (0,0), (1,0), (0,1), (1,1): q3 of (0,0), q2 of (1,0), q1 of (0,1), q0 of (1,1)
      const block: [number, number, number][] = [[0, 0, 3], [1, 0, 2], [0, 1, 1], [1, 1, 0]];
      for (const [cx, cz, q] of block) {
        const nb = genNb(seed, 0, cx, cz);
        const { mesh } = buildTile(nb, tileKey(0, cx, cz, q), 8);
        const [li0, lj0] = tileCell0(q);
        addKeys(mesh.shell, cx * CHUNK_SIZE + li0 * CELL, cz * CHUNK_SIZE + lj0 * CELL, keys, `${cx},${cz} q${q}`, dup);
      }
      expect(dup).toEqual([]);
    }
  });
});
