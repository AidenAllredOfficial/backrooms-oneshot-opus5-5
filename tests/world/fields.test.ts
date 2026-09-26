// WP1 — fields: range, continuity across chunk seams, spawn boost, storey offsets, decayAdd wrapper.
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS, CHUNK_SIZE } from '../../src/core/constants.ts';
import { cellIdx } from '../../src/core/grid.ts';
import type { StoreyId } from '../../src/core/ids.ts';
import { Rng } from '../../src/core/rng.ts';
import type { WorldGenOptions } from '../../src/core/world.ts';
import { createFieldSampler, fieldByte, withDecayAdd } from '../../src/world/fields.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

const opts = (seed: number): WorldGenOptions => ({
  seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default',
});
const N = CHUNK_CELLS;
const NAMES = ['power', 'decay', 'humidity', 'warmth'] as const;

describe('fields', () => {
  it('every field is in [0, 1) everywhere', () => {
    const rng = new Rng(5);
    for (const s of [0, 1, 2] as StoreyId[]) {
      const f = createFieldSampler(777, s);
      let bad = 0;
      for (let i = 0; i < 20000; i++) {
        const x = rng.range(-5000, 5000), z = rng.range(-5000, 5000);
        for (const n of NAMES) {
          const v = f[n](x, z);
          if (!(v >= 0 && v < 1)) bad++;
        }
      }
      expect(bad).toBe(0);
      for (const n of NAMES) expect(fieldByte(f[n](0, 0))).toBeLessThanOrEqual(255);
    }
  });

  it('adjacent cells across chunk seams differ by <= 0.05 (sampler)', () => {
    const rng = new Rng(9);
    for (const s of [0, 1, 2] as StoreyId[]) {
      const f = createFieldSampler(4321, s);
      let worst = 0;
      for (let i = 0; i < 3000; i++) {
        const cx = rng.int(-200, 200), cz = rng.int(-200, 200), c = rng.int(0, N - 1);
        const lineX = cx * CHUNK_SIZE, lineZ = cz * CHUNK_SIZE;
        const alongX = lineX + (c + 0.5) * CELL, alongZ = lineZ + (c + 0.5) * CELL;
        for (const n of NAMES) {
          // across an x seam (cells either side of x = lineX) and across a z seam
          worst = Math.max(worst, Math.abs(f[n](lineX - CELL / 2, alongZ) - f[n](lineX + CELL / 2, alongZ)));
          worst = Math.max(worst, Math.abs(f[n](alongX, lineZ - CELL / 2) - f[n](alongX, lineZ + CELL / 2)));
        }
      }
      expect(worst).toBeLessThanOrEqual(0.05);
    }
  });

  it('layout field bytes agree across generated chunk seams', () => {
    const g = createWorldGen(opts(2024));
    for (const s of [0, 1, 2] as StoreyId[]) {
      for (let k = 0; k < 4; k++) {
        const a = g.generateChunk({ s, cx: k - 2, cz: 1 - k });
        const b = g.generateChunk({ s, cx: k - 1, cz: 1 - k });
        const c = g.generateChunk({ s, cx: k - 2, cz: 2 - k });
        let worst = 0;
        for (let j = 0; j < N; j++) {
          for (const n of ['power', 'humidity', 'warmth'] as const) {
            worst = Math.max(worst, Math.abs(a[n][cellIdx(N - 1, j)] - b[n][cellIdx(0, j)]));
            worst = Math.max(worst, Math.abs(a[n][cellIdx(j, N - 1)] - c[n][cellIdx(j, 0)]));
          }
        }
        expect(worst).toBeLessThanOrEqual(0.05 * 256 + 1);
      }
    }
  });

  it('storey 0 power is boosted at the spawn; storey 2 is more humid', () => {
    for (let seed = 1; seed < 30; seed++) {
      const f0 = createFieldSampler(seed, 0);
      expect(f0.power(0, 0)).toBeGreaterThanOrEqual(0.45);
      expect(f0.power(4, -6)).toBeGreaterThanOrEqual(0.45);
    }
    const rng = new Rng(3);
    let h0 = 0, h2 = 0;
    const f0 = createFieldSampler(11, 0), f2 = createFieldSampler(11, 2);
    for (let i = 0; i < 4000; i++) {
      const x = rng.range(-3000, 3000), z = rng.range(-3000, 3000);
      h0 += f0.humidity(x, z); h2 += f2.humidity(x, z);
    }
    expect((h2 - h0) / 4000).toBeGreaterThan(0.15);
  });

  it('withDecayAdd offsets decay and clamps to [0, 0.999]', () => {
    const f = createFieldSampler(8, 1);
    const w = withDecayAdd(f, 0.2);
    let err = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 13.7, z = -i * 7.1;
      err = Math.max(err, Math.abs(w.decay(x, z) - Math.min(0.999, f.decay(x, z) + 0.2)), Math.abs(w.power(x, z) - f.power(x, z)));
    }
    expect(err).toBeLessThan(1e-12);
    expect(withDecayAdd(f, 0)).toBe(f);
  });
});
