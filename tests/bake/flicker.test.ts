// tests/bake/flicker.test.ts — WP7 acceptance: dynamic (flicker-channel) lights appear only in `flick` (never in
// `irr`), the channel is tileChannel(tile containing the light), two same-channel lights never both reach a texel
// (asserted during the bake), and tiles with `flick` also fill `volume.c`. Integration regressions: the dynamic
// channel bounces through the probes (the ceiling around a flickering panel is not black) and its penumbrae are
// smooth (16 shadow samples; 4 made blotchy walls).

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { fromHalf } from '../../src/core/half.ts';
import { tileChannel, type TileKey } from '../../src/core/grid.ts';
import { EdgeKind, LightState } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { ChartKind, type LightmapData } from '../../src/core/mesh.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { Q_HIGH, addLight, carveRoom, findChart, gridTexel, handNeighborhood, setEx, solidLayout, surfacesOf, texelLum } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

function scene(withDynamic: boolean, second: 'none' | 'sameTile' | 'otherTile'): ChunkLayout {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 30, 14);
  addLight(l, { id: 11, px: 4.2, pz: 4.2 }); // static
  addLight(l, { id: 12, px: 13.2, pz: 13.2 }); // static
  if (withDynamic) addLight(l, { id: 13, px: 9.0, pz: 9.0, state: LightState.FLICKER, dynamic: true });
  if (second === 'sameTile') addLight(l, { id: 14, px: 12.0, pz: 6.0, state: LightState.FLICKER, dynamic: true });
  if (second === 'otherTile') addLight(l, { id: 15, px: 16 * CELL + 3.0, pz: 9.0, state: LightState.FLICKER, dynamic: true });
  return l;
}

const sumChannel = (lm: LightmapData, ch: number): number => {
  if (!lm.flick) return 0;
  let s = 0;
  for (let i = ch; i < lm.flick.length; i += 4) s += fromHalf(lm.flick[i]);
  return s;
};

describe('flicker channels', () => {
  for (const variant of ['preview', 'full'] as const) {
    it(`dynamic light only in flick, own channel (${variant})`, () => {
      const nbDyn = handNeighborhood(scene(true, 'none'));
      const nbStatic = handNeighborhood(scene(false, 'none'));
      const s = surfacesOf(nbDyn, TILE, 12);
      const withDyn = bakeTile(nbDyn, TILE, s, variant, Q_HIGH, 'all');
      const without = bakeTile(nbStatic, TILE, surfacesOf(nbStatic, TILE, 12), variant, Q_HIGH, 'all');
      expect(withDyn.flick).not.toBeNull();
      expect(without.flick).toBeNull();
      // irr is byte-identical whether or not the dynamic light exists
      let diff = -1;
      for (let i = 0; i < withDyn.irr.length; i++) if (withDyn.irr[i] !== without.irr[i]) { diff = i; break; }
      expect(diff).toBe(-1);
      // channel of the light's tile
      const ch = tileChannel(TILE);
      expect(ch).toBe(0);
      expect(sumChannel(withDyn, ch)).toBeGreaterThan(1000);
      for (let k = 0; k < 4; k++) if (k !== ch) expect(sumChannel(withDyn, k)).toBe(0);
      // the light volume carries the channel too
      expect(withDyn.volume.c).not.toBeNull();
      let v = 0;
      for (let i = ch; i < (withDyn.volume.c as Uint16Array).length; i += 4) v += fromHalf((withDyn.volume.c as Uint16Array)[i]);
      expect(v).toBeGreaterThan(0);
    });
  }

  it('a dynamic light in the neighbouring tile uses the channel of its own tile', () => {
    const nb = handNeighborhood(scene(true, 'otherTile'));
    const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'full', Q_HIGH, 'all');
    const other = tileChannel({ s: 0, cx: 0, cz: 0, q: 1 });
    expect(other).toBe(1);
    expect(sumChannel(lm, 0)).toBeGreaterThan(0);
    expect(sumChannel(lm, other)).toBeGreaterThan(0);
    expect(sumChannel(lm, 2)).toBe(0);
    expect(sumChannel(lm, 3)).toBe(0);
  });

  it('two same-channel dynamic lights reaching one texel throw', () => {
    const nb = handNeighborhood(scene(true, 'sameTile'));
    expect(() => bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'full', Q_HIGH, 'all')).toThrow(/channel/);
    expect(() => bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'preview', Q_HIGH, 'all')).toThrow(/channel/);
  });

  it('no dynamic light in reach => flick is null', () => {
    const nb = handNeighborhood(scene(false, 'none'));
    const lm = bakeTile(nb, TILE, surfacesOf(nb, TILE, 12), 'preview', Q_HIGH, 'all');
    expect(lm.flick).toBeNull();
    expect(lm.volume.c).toBeNull();
  });

  it('the full bake bounces the dynamic light onto the ceiling around it', () => {
    const nb = handNeighborhood(scene(true, 'none'));
    const s = surfacesOf(nb, TILE, 12);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
    const floor = findChart(s, ChartKind.FLOOR_GRID), ceil = findChart(s, ChartKind.CEIL_GRID);
    let fSum = 0, cSum = 0, n = 0;
    for (let dz = -1.5; dz <= 1.5; dz += 0.3) {
      for (let dx = -1.5; dx <= 1.5; dx += 0.3) {
        if (Math.hypot(dx, dz) < 0.9) continue; // not under / beside the emitter itself
        const [fu, fv] = gridTexel(floor, 12, 9.0 + dx, 9.0 + dz);
        const [cu, cv] = gridTexel(ceil, 12, 9.0 + dx, 9.0 + dz);
        fSum += texelLum(lm, fu, fv, 'flick', 0); cSum += texelLum(lm, cu, cv, 'flick', 0); n++;
      }
    }
    expect(n).toBeGreaterThan(0);
    // direct only reaches the floor; the ceiling ring gets bounce only. The old per-light constant gave ~0.3%.
    expect(cSum / fSum).toBeGreaterThan(0.04);
    // the preview keeps the cheap constant (no probes), but still gives the ceiling something
    const pv = bakeTile(nb, TILE, s, 'preview', Q_HIGH, 'all');
    const [cu, cv] = gridTexel(ceil, 12, 10.2, 9.0);
    expect(texelLum(pv, cu, cv, 'flick', 0)).toBeGreaterThan(0);
  });

  it('a dynamic light\'s penumbra is smooth (no per-texel sampling noise)', () => {
    // a 105 cm HALF wall on x-line 8 with the flickering panel 1 m in front of it: the floor behind the wall lies in
    // the panel's penumbra; along the wall (z) the true irradiance is smooth, so neighbouring texels must agree.
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 2, 2, 14, 12);
    for (let j = 2; j < 12; j++) setEx(l, 8, j, EdgeKind.HALF, 105);
    addLight(l, { id: 21, px: 8 * CELL - 1.0, pz: 7 * CELL, state: LightState.FLICKER, dynamic: true, tx: 0, tz: 1 });
    const nb = handNeighborhood(l);
    const s = surfacesOf(nb, TILE, 12);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    let worst = 0, rows = 0; // worst: sum of per-row relative variation
    for (let dx = 0.25; dx <= 0.85; dx += 0.1) {
      const x = 8 * CELL + dx;
      let prev = -1, diff = 0, sum = 0, k = 0;
      for (let z = 7 * CELL - 1.0; z <= 7 * CELL + 1.0; z += CELL / 12) {
        const [u, v] = gridTexel(floor, 12, x, z);
        const f = texelLum(lm, u, v, 'flick', 0);
        if (prev >= 0) { diff += Math.abs(f - prev); k++; }
        sum += f; prev = f;
      }
      const mean = sum / (k + 1);
      if (mean < 5) continue; // umbra
      rows++;
      worst += diff / k / mean;
    }
    expect(rows).toBeGreaterThan(1);
    // mean relative texel-to-texel variation across the penumbra rows (4 Halton samples per texel: ~0.3-0.4)
    expect(worst / rows).toBeLessThan(0.1);
  });
});
