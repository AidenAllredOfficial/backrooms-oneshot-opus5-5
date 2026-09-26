// tests/bake/pipeline.test.ts — WP7 acceptance: determinism, BakeCache transparency (byte-identical with and without
// a warm cache), chart-hash verification and output shapes.

import { describe, expect, it } from 'vitest';
import { EMISSION, LV } from '../../src/core/constants.ts';
import { Zone } from '../../src/core/ids.ts';
import type { LightmapData } from '../../src/core/mesh.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { bakeTile, createBakeCache } from '../../src/bake/index.ts';
import { Q_HIGH, surfacesOf, zoneNeighborhood } from './helpers.ts';

function expectSame(a: LightmapData, b: LightmapData): void {
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  expect(b.chartHash).toBe(a.chartHash);
  const eq = (x: ArrayLike<number> | null, y: ArrayLike<number> | null, name: string): void => {
    if (x === null || y === null) { expect(y === null, name).toBe(x === null); return; }
    expect(y.length, name).toBe(x.length);
    let diff = -1;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { diff = i; break; }
    expect(diff, `${name}: first differing element`).toBe(-1);
  };
  eq(a.irr, b.irr, 'irr'); eq(a.dir, b.dir, 'dir'); eq(a.flick, b.flick, 'flick'); eq(a.mask, b.mask, 'mask');
  eq(a.emission, b.emission, 'emission');
  eq(a.volume.a, b.volume.a, 'volume.a'); eq(a.volume.b, b.volume.b, 'volume.b'); eq(a.volume.c, b.volume.c, 'volume.c');
  eq(a.volume.wallMask, b.volume.wallMask, 'wallMask');
}

describe('bake pipeline', () => {
  const nb = zoneNeighborhood(Zone.LOBBY, 0, 0, 0, { lights: 'default' });
  const tile: TileKey = { s: 0, cx: 0, cz: 0, q: 3 };
  const s = surfacesOf(nb, tile, 12);

  it('output shapes', () => {
    const lm = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'all');
    expect(lm.tileKey).toBe('0:0:0:3');
    expect(lm.variant).toBe('preview');
    expect(lm.irr.length).toBe(s.atlasW * s.atlasH * 4);
    expect(lm.dir.length).toBe(s.atlasW * s.atlasH * 4);
    expect(lm.mask.length).toBe(s.atlasW * s.atlasH * 4);
    expect(lm.emission.length).toBe(EMISSION.RES * EMISSION.RES * 4);
    expect(lm.volume.a.length).toBe(LV.NX * LV.NY * LV.NZ * 4);
    expect(lm.volume.b.length).toBe(LV.NX * LV.NY * LV.NZ * 4);
    expect(lm.volume.wallMask.length).toBe(18 * 18 * 4);
    expect(lm.chartHash).toBe(s.hash);
    expect(lm.stats.texels).toBeGreaterThan(1000);
    expect(lm.stats.lights).toBeGreaterThan(0);
    if (lm.flick) expect(lm.volume.c).not.toBeNull();
  }, 60_000);

  it('is deterministic (full)', () => {
    const a = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all');
    const b = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all');
    expectSame(a, b);
  }, 120_000);

  it('is byte-identical with and without a warm BakeCache (full and preview)', () => {
    const fresh = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all');
    const freshP = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'all');
    const cache = createBakeCache();
    // warm the cache with the chunk's other tiles and a neighbouring chunk's tile (shared chunks)
    for (const q of [0, 1, 2] as const) {
      const t: TileKey = { s: 0, cx: 0, cz: 0, q };
      bakeTile(nb, t, surfacesOf(nb, t, 12), 'full', Q_HIGH, 'all', cache);
    }
    expect(cache.chunks).toBeGreaterThan(0);
    expect(cache.chunks).toBeLessThanOrEqual(16);
    const warm = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all', cache);
    expectSame(fresh, warm);
    const warmP = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'all', cache);
    expectSame(freshP, warmP);
    cache.clear();
    expect(cache.chunks).toBe(0);
  }, 180_000);

  it('verifies the chart hash of the SurfaceSet', () => {
    const bad = { ...s, hash: (s.hash + 1) >>> 0 };
    expect(() => bakeTile(nb, tile, bad, 'preview', Q_HIGH, 'all')).toThrow(/chartHash/);
    const moved = { ...s, charts: s.charts.map((c, i) => (i === 0 ? { ...c, x: c.x + 1 } : c)) };
    expect(() => bakeTile(nb, tile, moved, 'preview', Q_HIGH, 'all')).toThrow(/chartHash/);
    const other = { ...s, tileKey: '0:0:0:2' };
    expect(() => bakeTile(nb, tile, other, 'preview', Q_HIGH, 'all')).toThrow();
  }, 60_000);

  it('term !== all zeroes the other term', () => {
    const all = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'all');
    const dir = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'direct');
    const ind = bakeTile(nb, tile, s, 'preview', Q_HIGH, 'indirect');
    let sa = 0, sd = 0, si = 0;
    for (let i = 0; i < all.irr.length; i += 4) {
      sa += all.irr[i + 1]; sd += dir.irr[i + 1]; si += ind.irr[i + 1];
    }
    expect(sd).toBeGreaterThan(0);
    expect(si).toBeGreaterThan(0);
    expect(sd).toBeLessThan(sa);
    expect(si).toBeLessThan(sa);
    // the indirect-only bake has no directional part
    let maxW = 0;
    for (let i = 3; i < ind.dir.length; i += 4) maxW = Math.max(maxW, ind.dir[i]);
    expect(maxW).toBe(0);
  }, 60_000);
});
