// tests/mesh/tower.test.ts — WP5 acceptance: periodic stair towers. Replicas (solids, fixtures, props) are identical up
// to the y offset; the shell seen from inside the shaft is identical at y and y + 3 m (hit distance, normal, layer and
// material uv mod 1); tower charts carry the tower bake group and whole texel rows per 3 m.

import { describe, expect, test, vi } from 'vitest';
import { CELL, STOREY_PITCH, TOWER_SPAN, lmTexel } from '../../src/core/constants.ts';
import { tileCell0 } from '../../src/core/grid.ts';
import { CellFlag, type StoreyId } from '../../src/core/ids.ts';
import { TOWER_REPLICAS, towerGroups, type ChunkLayout } from '../../src/core/layout.ts';
import { TOWER_LAYERS } from '../../src/core/materials.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { expandPeriodicFixtures, expandPeriodicProps, expandPeriodicSolids } from '../../src/mesh/periodic.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { testSceneChunk, testTowerSite } from '../../src/world/testScenes.ts';
import { towerExitCell } from '../../src/world/structures/tower.ts';
import { tileKey } from './helpers.ts';
import { TriSoup, hitUv } from './raycast.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

const SEED = 1;
function towerNb(s: StoreyId = 0, warmth = -1): LayoutNeighborhood {
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = testSceneChunk('tower', { s, cx: dx, cz: dz }, SEED);
      if (warmth >= 0) l.warmth.fill(warmth); // real storeys have different (storey-seeded) fields
      ls.push(l);
    }
  }
  return makeNeighborhood(ls);
}

describe('periodic replication', () => {
  const l = towerNb().center;
  const groups = towerGroups(l);

  test('the tower scene has a tower with periodic solids', () => {
    expect(groups.length).toBe(1);
    expect(l.solids.some((s) => s.kind !== 'pipe' && groups.includes(s.bakeGroup))).toBe(true);
  });

  test('expandPeriodicSolids: replicas at y + 3k, clipped to |y| <= TOWER_SPAN, ids kept, non-tower solids unchanged', () => {
    const out = expandPeriodicSolids(l);
    const base = l.solids.filter((s) => s.kind === 'box' && groups.includes(s.bakeGroup));
    for (const b of base) {
      if (b.kind !== 'box') continue;
      const reps = out.filter((s) => s.kind === 'box' && s.id === b.id);
      expect(reps.length).toBeGreaterThanOrEqual(1);
      expect(reps.length).toBeLessThanOrEqual(TOWER_REPLICAS.length);
      for (const r of reps) {
        if (r.kind !== 'box') continue;
        expect(r.min[1]).toBeGreaterThanOrEqual(-TOWER_SPAN - 1e-9);
        expect(r.max[1]).toBeLessThanOrEqual(TOWER_SPAN + 1e-9);
        expect([r.min[0], r.min[2], r.max[0], r.max[2], r.mat, r.bakeGroup]).toEqual([b.min[0], b.min[2], b.max[0], b.max[2], b.mat, b.bakeGroup]);
      }
      // unclipped replicas are exact 3 m translations
      for (const k of TOWER_REPLICAS) {
        const y0 = b.min[1] + k * STOREY_PITCH, y1 = b.max[1] + k * STOREY_PITCH;
        if (y0 < -TOWER_SPAN || y1 > TOWER_SPAN) continue;
        expect(reps.some((r) => r.kind === 'box' && Math.abs(r.min[1] - y0) < 1e-9 && Math.abs(r.max[1] - y1) < 1e-9)).toBe(true);
      }
    }
    // extraK widens the span
    expect(expandPeriodicSolids(l, 2).length).toBeGreaterThan(out.length);
    for (const s of l.solids) if (s.kind === 'pipe' || !groups.includes(s.bakeGroup)) expect(out).toContain(s);
  });

  test('expandPeriodicFixtures: replicas keep the base id and seed', () => {
    const out = expandPeriodicFixtures(l);
    const tower = l.fixtures.filter((f) => groups.includes(f.bakeGroup));
    expect(tower.length).toBeGreaterThan(0);
    for (const f of tower) {
      const reps = out.filter((r) => r.id === f.id);
      expect(reps.length).toBeGreaterThan(1);
      for (const r of reps) {
        expect(r.seed).toBe(f.seed);
        expect(Math.abs(r.py)).toBeLessThanOrEqual(TOWER_SPAN + 1e-9);
        const k = (r.py - f.py) / STOREY_PITCH;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
        expect([r.px, r.pz, r.kind, r.state]).toEqual([f.px, f.pz, f.kind, f.state]);
      }
    }
  });

  test('expandPeriodicProps: props anchored in TOWER cells are replicated like solids, others unchanged', () => {
    const out = expandPeriodicProps(l);
    const inTower = (x: number, z: number): boolean => (l.flags[Math.floor(z / CELL) * 32 + Math.floor(x / CELL)] & CellFlag.TOWER) !== 0;
    const towerProps = l.props.filter((p) => inTower(p.x, p.z));
    for (const p of l.props) {
      const reps = out.filter((r) => r.x === p.x && r.z === p.z && r.kind === p.kind && r.seed === p.seed && r.yaw === p.yaw);
      if (!inTower(p.x, p.z)) { expect(reps).toEqual([p]); continue; }
      for (const k of TOWER_REPLICAS) {
        const y = p.y + k * STOREY_PITCH;
        if (Math.abs(y) > TOWER_SPAN) continue;
        expect(reps.some((r) => Math.abs(r.y - y) < 1e-9)).toBe(true);
      }
    }
    expect(out.length).toBeGreaterThanOrEqual(l.props.length + towerProps.length);
  });
});

describe('tower shell periodicity', () => {
  test('rays from inside the shaft see identical surfaces at y and y + 3 m (uv mod 1)', () => {
    const nb = towerNb();
    const l = nb.center;
    const soup = new TriSoup();
    for (let q = 0; q < 4; q++) {
      const { mesh } = buildTile(nb, tileKey(0, 0, 0, q), 12);
      const [li0, lj0] = tileCell0(q);
      soup.add(mesh.shell, li0 * CELL, lj0 * CELL);
    }
    const cells: [number, number][] = [];
    for (let lj = 0; lj < 32; lj++) for (let li = 0; li < 32; li++) if (l.flags[lj * 32 + li] & CellFlag.TOWER) cells.push([li, lj]);
    expect(cells.length).toBe(15);
    // the exit X (vestibule -> storey) exists only in the y = 0 copy by design: skip the cell behind it and any ray
    // that leaves the tower through it (hits a non-tower layer or nothing)
    const exit = towerExitCell(testTowerSite(SEED));
    const exitInside: [number, number] = [exit.li, exit.lj];
    let compared = 0;
    const bad: string[] = [];
    const frac = (v: number): number => v - Math.floor(v);
    const dfrac = (a: number, b: number): number => { const d = Math.abs(frac(a) - frac(b)); return Math.min(d, 1 - d); };
    for (const [li, lj] of cells) {
      if (Math.abs(li - exitInside[0]) + Math.abs(lj - exitInside[1]) <= 1) continue;
      for (const [ox, oz] of [[0.31, 0.47], [0.77, 0.23]]) {
        for (const y of [-2.7, -2.05, -1.3, -0.62]) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2 + 0.11;
            for (const pitch of [0, 0.25, -0.25]) {
              const d = [Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch)];
              const o0 = [(li + ox) * CELL, y, (lj + oz) * CELL], o1 = [o0[0], y + STOREY_PITCH, o0[2]];
              const h0 = soup.cast(o0, d, 6), h1 = soup.cast(o1, d, 6);
              if (!h0 && !h1) continue;
              if ((h0 && !TOWER_LAYERS.includes(soup.layer[h0.tri] as never)) || (h1 && !TOWER_LAYERS.includes(soup.layer[h1.tri] as never))) continue;
              if (!h0 || !h1) { bad.push(`hit mismatch at ${o0.map((v) => v.toFixed(2))} dir ${k}`); continue; }
              // skip rays that start inside a solid (both see a back face) — geometry is still compared
              compared++;
              const uv0 = hitUv(soup, h0), uv1 = hitUv(soup, h1);
              if (Math.abs(h0.t - h1.t) > 1e-4 || Math.abs(h0.nx - h1.nx) > 1e-3 || Math.abs(h0.ny - h1.ny) > 1e-3 || Math.abs(h0.nz - h1.nz) > 1e-3 ||
                soup.layer[h0.tri] !== soup.layer[h1.tri]) {
                bad.push(`geometry differs at ${o0.map((v) => v.toFixed(2))} dir ${k} pitch ${pitch}: t ${h0.t.toFixed(4)} vs ${h1.t.toFixed(4)} layer ${soup.layer[h0.tri]} vs ${soup.layer[h1.tri]}`);
              } else if (dfrac(uv0[0], uv1[0]) > 2e-3 || dfrac(uv0[1], uv1[1]) > 2e-3) {
                bad.push(`uv differs at ${o0.map((v) => v.toFixed(2))} dir ${k}: (${uv0.map((v) => v.toFixed(4))}) vs (${uv1.map((v) => v.toFixed(4))}) layer ${soup.layer[h0.tri]}`);
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(bad.slice(0, 15)).toEqual([]);
  });

  test('the tower shell is storey-free: identical vertices (position, uv, tint, layer, flags) in every storey', () => {
    const l0 = towerNb(0).center;
    let i0 = 32, j0 = 32, i1 = -1, j1 = -1;
    for (let lj = 0; lj < 32; lj++) {
      for (let li = 0; li < 32; li++) {
        if (!(l0.flags[lj * 32 + li] & CellFlag.TOWER)) continue;
        i0 = Math.min(i0, li); j0 = Math.min(j0, lj); i1 = Math.max(i1, li + 1); j1 = Math.max(j1, lj + 1);
      }
    }
    const m = 0.05; // strictly inside the footprint: storey-side faces of the perimeter walls lie outside it
    const inside = (x: number, z: number): boolean => x > i0 * CELL + m && x < i1 * CELL - m && z > j0 * CELL + m && z < j1 * CELL - m;
    const sig = (s: StoreyId, warmth: number): string[] => {
      const nb = towerNb(s, warmth);
      const out: string[] = [];
      for (let q = 0; q < 4; q++) {
        const sh = buildTile(nb, tileKey(s, 0, 0, q), 8).mesh.shell;
        const [li0, lj0] = tileCell0(q);
        for (let v = 0; v < sh.vertexCount; v++) {
          const x = sh.position[v * 3] + li0 * CELL, z = sh.position[v * 3 + 2] + lj0 * CELL;
          if (!inside(x, z)) continue;
          const f = (a: ArrayLike<number>, n: number): string => Array.from({ length: n }, (_, i) => Math.round(a[v * n + i] * 1e4)).join(',');
          out.push([f(sh.position, 3), f(sh.normal, 4), f(sh.uv, 2), f(sh.tint, 4), sh.layer[v], sh.flags[v], sh.emit[v], f(sh.aux, 4)].join('|'));
        }
      }
      return out.sort();
    };
    const a = sig(0, 128), b = sig(1, 20), c = sig(2, 240);
    expect(a.length).toBeGreaterThan(100);
    expect(b.length).toBe(a.length);
    expect(b.filter((x, i) => x !== a[i]).slice(0, 5)).toEqual([]);
    expect(c.filter((x, i) => x !== a[i]).slice(0, 5)).toEqual([]);
  });

  test('tower charts: tower bake group, TOWER_LAYERS only, whole texel rows per 3 m, never density-halved', () => {
    const nb = towerNb();
    const g = towerGroups(nb.center)[0];
    for (const tpc of [8, 12] as const) {
      let n = 0;
      for (let q = 0; q < 4; q++) {
        const { surfaces } = buildTile(nb, tileKey(0, 0, 0, q), tpc);
        for (const c of surfaces.charts) {
          if (c.bakeGroup !== g) continue;
          n++;
          expect(TOWER_LAYERS).toContain(c.layer);
          const t = lmTexel(tpc);
          expect(c.kind === ChartKind.RAMP ? Math.hypot(c.axisU[0], c.axisU[2]) : Math.hypot(...c.axisU)).toBeCloseTo(t, 6); // never halved
          if (c.kind === ChartKind.WALL) {
            expect(c.axisV[1]).toBeCloseTo(t, 9);
            const rows = STOREY_PITCH / t;
            expect(Math.abs(rows - Math.round(rows))).toBeLessThan(1e-9);
            // v origin on the 3 m-periodic texel lattice (relative to the tower floor -6 m)
            const v0 = (c.origin[1] + TOWER_SPAN) / t;
            expect(Math.abs(v0 - Math.round(v0))).toBeLessThan(1e-6);
          }
        }
      }
      expect(n).toBeGreaterThan(4);
    }
  });
});
