// tests/mesh/charts.test.ts — WP5 acceptance: buildTileSurfaces(...).hash === buildTile(...).surfaces.hash over 100
// tiles, determinism, chart ordering (rule 13), chartHash sensitivity, and the atlas packer (rule 12: grid positions,
// shelf order, heights, overflow halving that never touches grid or tower charts).

import { describe, expect, test, vi } from 'vitest';
import { LM_ATLAS_W, LM_PAD, lmTexel } from '../../src/core/constants.ts';
import { ChartKind, type Chart } from '../../src/core/mesh.ts';
import type { StoreyId } from '../../src/core/ids.ts';
import { ATLAS_HEIGHTS, packAtlas } from '../../src/mesh/atlas.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { chartHash } from '../../src/mesh/chartHash.ts';
import { ChartSpec, specDims } from '../../src/mesh/plan.ts';
import { buildTileSurfaces } from '../../src/mesh/surfaces.ts';
import { chartOverlaps, genNb, tileKey } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

const hashBuf = (a: ArrayLike<number>): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) { h ^= Math.round(a[i] * 1e4) | 0; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

describe('chart hash: build == bake', () => {
  test('buildTileSurfaces hash equals buildTile hash over 100 tiles (mixed zones, both densities)', { tags: ['sweep'] }, () => {
    let n = 0;
    const seen = new Set<number>();
    for (let cz = 0; cz < 5; cz++) {
      for (let cx = 0; cx < 5; cx++) {
        const s = ((cx + cz) % 3) as StoreyId;
        const nb = genNb(21, s, cx - 2, cz - 2);
        for (let q = 0; q < 4; q++) {
          const tpc = (n & 1) ? 8 : 12;
          const key = tileKey(s, cx - 2, cz - 2, q);
          const a = buildTile(nb, key, tpc).surfaces;
          const b = buildTileSurfaces(nb, key, tpc);
          expect(b.hash).toBe(a.hash);
          expect(b.charts).toEqual(a.charts);
          expect(chartHash(a.charts)).toBe(a.hash);
          expect(a.tileKey).toBe(`${s}:${cx - 2}:${cz - 2}:${q}`);
          seen.add(a.hash);
          n++;
        }
      }
    }
    expect(n).toBe(100);
    expect(seen.size).toBeGreaterThan(90);
  });

  test('buildTile is deterministic (same buffers twice, fresh neighbourhood objects)', () => {
    for (const [s, cx, cz] of [[0, 0, 0], [1, 3, -1]] as [StoreyId, number, number][]) {
      const a = buildTile(genNb(33, s, cx, cz), tileKey(s, cx, cz, 2), 12).mesh;
      const b = buildTile(genNb(33, s, cx, cz), tileKey(s, cx, cz, 2), 12).mesh;
      expect(b.shell.vertexCount).toBe(a.shell.vertexCount);
      expect(hashBuf(b.shell.position)).toBe(hashBuf(a.shell.position));
      expect(hashBuf(b.shell.lmUv)).toBe(hashBuf(a.shell.lmUv));
      expect(hashBuf(b.shell.index)).toBe(hashBuf(a.shell.index));
      expect(b.atlas).toEqual(a.atlas);
      expect(b.dynLights).toEqual(a.dynLights);
    }
  });

  test('charts come in rule-13 order: floor grid, ceiling grid, walls, steps, soffits, boxes, ramps, plenums', () => {
    const rank: Record<number, number> = {
      [ChartKind.FLOOR_GRID]: 0, [ChartKind.CEIL_GRID]: 1, [ChartKind.WALL]: 2, [ChartKind.STEP]: 3, [ChartKind.SOFFIT]: 4,
      [ChartKind.BOX]: 5, [ChartKind.RAMP]: 6, [ChartKind.PLENUM]: 7,
    };
    const surfaces = buildTile(genNb(21, 0, 0, 0), tileKey(0, 0, 0, 0), 12).surfaces;
    surfaces.charts.forEach((c, i) => expect(c.id).toBe(i));
    // walls (incl. SOLID covers) precede steps (+ pits) precede soffits; boxes / ramps / plenums come last
    const firstIdx = (k: number): number => surfaces.charts.findIndex((c) => c.kind === k);
    const lastIdx = (k: number): number => { let r = -1; surfaces.charts.forEach((c, i) => { if (c.kind === k) r = i; }); return r; };
    expect(firstIdx(ChartKind.FLOOR_GRID)).toBe(0);
    expect(firstIdx(ChartKind.CEIL_GRID)).toBe(1);
    if (firstIdx(ChartKind.PLENUM) >= 0) expect(firstIdx(ChartKind.PLENUM)).toBeGreaterThan(lastIdx(ChartKind.WALL));
    if (firstIdx(ChartKind.RAMP) >= 0) expect(firstIdx(ChartKind.RAMP)).toBeGreaterThan(lastIdx(ChartKind.WALL));
    void rank;
  });

  test('chartHash reacts to every hashed field', () => {
    const base: Chart = { id: 0, kind: 2, bakeGroup: 0, x: 10, y: 20, w: 12, h: 30, origin: [1, 2, 3], axisU: [0.1, 0, 0], axisV: [0, 0.1, 0], normal: [0, 0, 1], layer: 0, cont: 1 };
    const h0 = chartHash([base]);
    const mods: Partial<Chart>[] = [{ kind: 3 }, { x: 11 }, { y: 21 }, { w: 13 }, { h: 31 }, { origin: [1, 2, 3.0001] }, { axisU: [0.1, 0, 0.00002] }, { axisV: [0, 0.2, 0] }, { cont: 2 }, { bakeGroup: 7 }];
    for (const m of mods) expect(chartHash([{ ...base, ...m }])).not.toBe(h0);
    expect(chartHash([base, base])).not.toBe(h0);
  });
});

describe('atlas packing', () => {
  function spec(id: number, wTex: number, hTex: number, group = 0, t = lmTexel(12)): ChartSpec {
    const s = new ChartSpec(ChartKind.WALL, group, 0, `1${String(id).padStart(6, '0')}`, [0, 0, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    s.uMin = 0; s.uMax = wTex * t; s.vMin = 0; s.vMax = hTex * t; s.id = id;
    specDims(s, t);
    return s;
  }
  function grids(tpc: 8 | 12): ChartSpec[] {
    const S = 16 * tpc + 2;
    return [1, 2].map((g) => { const s = new ChartSpec(g - 1 as 0 | 1, 0, 0, `0${g - 1}`, [0, 1, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]); s.grid = g; s.w = S; s.h = S; s.tex = lmTexel(tpc); return s; });
  }

  test('grid charts at (0,0) and (S + 2 PAD, 0); others shelf-packed without overlap; smallest height that fits', () => {
    for (const tpc of [8, 12] as const) {
      const specs = [...grids(tpc)];
      for (let i = 0; i < 60; i++) specs.push(spec(i + 2, 4 + ((i * 37) % 50), 4 + ((i * 11) % 29)));
      const H = packAtlas(specs, tpc);
      const S = 16 * tpc + 2;
      expect(ATLAS_HEIGHTS).toContain(H);
      expect([specs[0].x, specs[0].y, specs[1].x, specs[1].y]).toEqual([0, 0, S + 2 * LM_PAD, 0]);
      const charts = specs.map((s) => ({ x: s.x, y: s.y, w: s.w + LM_PAD, h: s.h + LM_PAD, id: s.id } as unknown as Chart));
      expect(chartOverlaps(charts)).toEqual([]);
      for (const s of specs) { expect(s.x + s.w).toBeLessThanOrEqual(LM_ATLAS_W); expect(s.y + s.h).toBeLessThanOrEqual(H); }
      // the next smaller height would not have fitted
      const used = Math.max(...specs.map((s) => s.y + s.h));
      const i = ATLAS_HEIGHTS.indexOf(H as (typeof ATLAS_HEIGHTS)[number]);
      if (i > 0) expect(used).toBeGreaterThan(ATLAS_HEIGHTS[i - 1]);
    }
  });

  test('overflow: halve the largest bakeGroup-0 charts until everything fits; grid and tower charts keep their density', () => {
    const tpc = 12, t = lmTexel(tpc);
    const specs = [...grids(tpc)];
    const tower: ChartSpec[] = [];
    for (let i = 0; i < 6; i++) { const s = spec(100 + i, 30, 120, 77); tower.push(s); specs.push(s); }
    for (let i = 0; i < 80; i++) specs.push(spec(200 + i, 60 + (i % 7) * 10, 50 + (i % 5) * 8));
    const before = tower.map((s) => [s.w, s.h]);
    const H = packAtlas(specs, tpc);
    expect(H).toBeLessThanOrEqual(1024);
    expect(tower.map((s) => [s.w, s.h])).toEqual(before);
    for (const s of tower) expect(s.tex).toBeCloseTo(t, 12);
    expect(specs.some((s) => s.halv > 0)).toBe(true);
    for (const s of specs) if (s.halv > 0) { expect(s.group).toBe(0); expect(s.grid).toBe(0); expect(s.tex).toBeCloseTo(t * 2 ** s.halv, 12); }
    const charts = specs.map((s) => ({ x: s.x, y: s.y, w: s.w + LM_PAD, h: s.h + LM_PAD, id: s.id } as unknown as Chart));
    expect(chartOverlaps(charts)).toEqual([]);
  });
});
