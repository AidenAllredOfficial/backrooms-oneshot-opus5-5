import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS, CHUNK_SIZE, LIGHT, LM_TPC_ALLOWED, REGION_MASK, STOREY_PITCH, TILE_CELLS, TILE_SIZE, WALL_T, lmTexel, regionKey } from '../../src/core/constants.ts';
import { LAYER_DEFS, TOWER_LAYERS, layerRepeatY } from '../../src/core/materials.ts';
import { EdgeKind, LANDMARK_COUNT, LANDMARK_NAMES, MAT_COUNT, PROP_KIND_COUNT, ZONE_COUNT } from '../../src/core/ids.ts';
import { EDGE_OCCLUDES, edgeBaseThickness } from '../../src/core/edges.ts';
import { cellToChunk, tileKeyAt, tileOfLocalCell, worldToCell, worldToChunk } from '../../src/core/grid.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { ZONE_INFO, STRATA_WEIGHTS } from '../../src/core/zones.ts';
import { QUALITY, QUALITY_NAMES } from '../../src/core/quality.ts';
import { hash3, hashN, Rng } from '../../src/core/rng.ts';
import { fromHalf, toHalf } from '../../src/core/half.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
describe('core invariants', () => {
  it('grid sizes are consistent', () => {
    expect(near(CELL * CHUNK_CELLS, CHUNK_SIZE)).toBe(true);
    expect(near(CELL * TILE_CELLS, TILE_SIZE)).toBe(true);
    expect(LIGHT.R_DYN).toBeLessThan(TILE_SIZE / 2);
  });
  it('no-leak invariant: every occluding edge kind is at least one texel thick at floor level', () => {
    for (const t of LM_TPC_ALLOWED) expect(lmTexel(t)).toBeLessThanOrEqual(WALL_T + 1e-9);
    for (const k of Object.values(EdgeKind)) {
      if (!EDGE_OCCLUDES[k]) continue;
      for (const t of LM_TPC_ALLOWED) expect(edgeBaseThickness(k)).toBeGreaterThanOrEqual(lmTexel(t) - 1e-9);
    }
    for (const q of QUALITY_NAMES) expect(LM_TPC_ALLOWED as readonly number[]).toContain(QUALITY[q].lmTpc);
  });
  it('material repeats divide the tile size; tower layers are storey-periodic', () => {
    expect(LAYER_DEFS.length).toBe(MAT_COUNT);
    const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
    LAYER_DEFS.forEach((d, i) => {
      expect(d.id).toBe(i);
      expect(isInt(TILE_SIZE / d.repeat)).toBe(true);
    });
    for (const m of TOWER_LAYERS) expect(isInt(STOREY_PITCH / layerRepeatY(LAYER_DEFS[m]))).toBe(true);
  });
  it('grid rounding is consistent at chunk and tile boundaries', () => {
    for (let k = -2000; k <= 2000; k++) {
      for (const d of [-1e-6, 0, 1e-6]) {
        for (const base of [k * CHUNK_SIZE, k * TILE_SIZE, k * CELL]) {
          const x = base + d;
          const gi = worldToCell(x), cx = worldToChunk(x), li = gi - cx * CHUNK_CELLS;
          expect(cx).toBe(cellToChunk(gi));
          expect(li >= 0 && li < CHUNK_CELLS).toBe(true);
          const t = tileKeyAt(0, x, x);
          expect(t.cx).toBe(cx);
          expect(t.q).toBe(tileOfLocalCell(li, li));
        }
      }
    }
  });
  it('region keys fit the packed range', () => {
    expect(regionKey(0)).toBe(0);
    for (const r of [1, 2, 2047, 2048, 2049, 9216]) {
      expect(regionKey(r)).toBeGreaterThanOrEqual(1);
      expect(regionKey(r)).toBeLessThanOrEqual(REGION_MASK + 1);
    }
  });
  it('tables are complete', () => {
    expect(PROP_DEFS.length).toBe(PROP_KIND_COUNT);
    PROP_DEFS.forEach((d, i) => expect(d.kind).toBe(i));
    expect(ZONE_INFO.length).toBe(ZONE_COUNT);
    ZONE_INFO.forEach((z, i) => expect(z.id).toBe(i));
    for (const s of [0, 1, 2] as const) expect(STRATA_WEIGHTS[s].length).toBe(ZONE_COUNT);
    expect(LANDMARK_NAMES.length).toBe(LANDMARK_COUNT);
  });
  it('hash/rng determinism', () => {
    expect(hash3(1, 2, 3)).toBe(hashN(1, 2, 3));
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('half round trip', () => {
    for (const v of [0, 1e-3, 0.5, 1, 326.7, 3300, 65504]) expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(v * 1e-3 + 1e-6);
  });
});
