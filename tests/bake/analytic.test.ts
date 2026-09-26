// tests/bake/analytic.test.ts — WP7 acceptance: closed-form single panel (full 2%, preview 10%), tall lights
// (ATRIUM lattice at 12 m >= 85% of the unwindowed sum), furniture shadow (floor under a DESK top < 35% of the
// open floor beside it) and directionality range / orientation.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { fromHalf } from '../../src/core/half.ts';
import { FixtureKind, LandmarkKind, PropKind } from '../../src/core/ids.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { EXACT_FULL, formFactor, LENS_NORM, lensW } from '../../src/bake/areaLight.ts';
import { createJob } from '../../src/bake/job.ts';
import { bakeTile, lastBake } from '../../src/bake/index.ts';
import {
  Q_HIGH, addLight, carveRoom, findChart, gridTexel, handNeighborhood, sampleGrid, solidLayout, surfacesOf, texelLum,
} from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

/** Irradiance factor (x luminance = lux) of an axis-aligned rectangle [x0,x1] x [z0,z1] (relative to the receiver,
 * m) in a plane h metres above it, facing down onto a receiver facing up (exact, parallel planes). */
function rectFactor(x0: number, x1: number, z0: number, z1: number, h: number): number {
  const fc = (x: number, y: number): number => {
    const X = x / h, Y = y / h;
    const a = Math.sqrt(1 + X * X), b = Math.sqrt(1 + Y * Y);
    return 0.5 * ((X / a) * Math.atan(Y / a) + (Y / b) * Math.atan(X / b));
  };
  return fc(x1, z1) - fc(x0, z1) - fc(x1, z0) + fc(x0, z0);
}

/** The same for a prismatic-lens emitter (troffers, areaLight.ts: I ~ cos^LENS_N normalised to the Lambertian
 * flux): numerical integration of cos_r cos_e lensW(cos_e) / d^2 over the rectangle (parallel planes). */
function lensRectFactor(x0: number, x1: number, z0: number, z1: number, h: number): number {
  const NU = 240, NV = 240;
  const du = (x1 - x0) / NU, dv = (z1 - z0) / NV;
  let s = 0;
  for (let b = 0; b < NV; b++) {
    const z = z0 + (b + 0.5) * dv;
    for (let a = 0; a < NU; a++) {
      const x = x0 + (a + 0.5) * du;
      const d2 = x * x + z * z + h * h, c = h / Math.sqrt(d2);
      s += (c * c * lensW(c)) / d2;
    }
  }
  return s * du * dv;
}

describe('analytic single panel', () => {
  // one 0.6 x 1.2 troffer at 2.7 m centred above a floor texel centre (tpc 12: centres at k * 0.1 + 0.05)
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  const px = 8.05, pz = 8.05;
  addLight(l, { px, pz, py: 2.7, w: 1.2, h: 0.6, tx: 1, tz: 0, luminance: 3300 });
  const nb = handNeighborhood(l);
  const s = surfacesOf(nb, TILE, 12);
  const floor = findChart(s, ChartKind.FLOOR_GRID);
  const h = 2.7 - 0.02; // floor samples are 2 cm above the floor
  const [au, av] = gridTexel(floor, 12, px, pz);
  // a troffer: prismatic lens distribution (the Lambertian closed form is checked against the same integration below)
  const expected = (ox: number, oz: number): number => 3300 * lensRectFactor(-0.6 - ox, 0.6 - ox, -0.3 - oz, 0.3 - oz, h);
  it('lens integration reduces to the closed form for a Lambertian emitter', () => {
    // sanity of the reference: lensW = 1 gives the parallel-plane closed form (checked via the ratio of the on-axis
    // lens-weighted value to the Lambertian one, which must lie between LENS_NORM * cos^0.5 at the corners and LENS_NORM)
    const lam = rectFactor(-0.6, 0.6, -0.3, 0.3, h), lens = lensRectFactor(-0.6, 0.6, -0.3, 0.3, h);
    expect(lens / lam).toBeGreaterThan(LENS_NORM * Math.sqrt(h / Math.hypot(0.6, 0.3, h)));
    expect(lens / lam).toBeLessThan(LENS_NORM);
  });
  it('full bake is within 2% of the closed-form polygon value', () => {
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'direct');
    const e = texelLum(lm, au, av);
    expect(Math.abs(e - expected(0, 0)) / expected(0, 0)).toBeLessThan(0.02);
    // and off-centre texels too (0.5 m and 1.0 m away along x)
    for (const d of [0.5, 1.0]) {
      const [bu, bv] = gridTexel(floor, 12, px + d, pz);
      const eo = texelLum(lm, bu, bv);
      expect(Math.abs(eo - expected(d, 0)) / expected(d, 0)).toBeLessThan(0.02);
    }
  });
  it('preview bake is within 10%', () => {
    const lm = bakeTile(nb, TILE, s, 'preview', Q_HIGH, 'direct');
    const e = texelLum(lm, au, av);
    expect(Math.abs(e - expected(0, 0)) / expected(0, 0)).toBeLessThan(0.1);
  });
});

describe('lens form factor continuity', () => {
  // the lens form factor switches method with distance (sub-rectangles / blend / whole polygon / point samples):
  // sweeping a receiver away from a troffer must never jump
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 8.05, pz: 8.05, py: 2.7, w: 1.2, h: 0.6, tx: 1, tz: 0, luminance: 3300 });
  const job = createJob(handNeighborhood(l), TILE, Q_HIGH, null);
  const L = job.L, o = 0;
  it('is smooth along floor, wall-like and ceiling sweeps', () => {
    // the per-step ratio f(k)/f(k-1) varies slowly on a smooth falloff; a method switch would show as a kink. The
    // Lambertian sweep (same geometry, lens off) is the reference for how much it may vary.
    const kink = (ny: number, nx: number, y: number): number => {
      let prev = -1, prevRatio = NaN, worst = 0;
      for (let k = 0; k <= 800; k++) {
        const dx = 0.3 + k * 0.01; // metres from the light centre along +x
        const f = formFactor(L, o, L.pos[0] + dx / CELL, y, L.pos[2] + 0.13 / CELL, nx, ny, 0, EXACT_FULL);
        if (prev > 1e-6 && f > 1e-6) {
          const r = f / prev;
          if (Number.isFinite(prevRatio)) worst = Math.max(worst, Math.abs(r - prevRatio));
          prevRatio = r;
        }
        prev = f;
      }
      return worst;
    };
    for (const [ny, nx, y] of [[1, 0, 0.02], [0, -1, 1.4], [0, -1, 2.5], [-1, 0, 2.68]] as const) {
      L.lens[o] = 0;
      const ref = kink(ny, nx, y);
      L.lens[o] = 1;
      expect(kink(ny, nx, y), `normal (${nx}, ${ny}) y ${y}`).toBeLessThan(1.5 * ref + 0.001);
    }
  });
});

describe('tall lights (ATRIUM lattice at 12 m)', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 20, 20, 1250);
  l.landmarks.push({ kind: LandmarkKind.ATRIUM, i0: 2, j0: 2, i1: 20, j1: 20 });
  const lights: [number, number][] = [];
  for (let j = 3; j < 20; j += 3) {
    for (let i = 3; i < 20; i += 3) {
      const x = (i + 0.5) * CELL, z = (j + 0.5) * CELL;
      lights.push([x, z]);
      addLight(l, { kind: FixtureKind.SKY_PANEL, px: x, pz: z, py: 12, w: 1.2, h: 1.2, luminance: 3200 });
    }
  }
  const nb = handNeighborhood(l);
  it('floor irradiance is >= 85% of the unwindowed sum', () => {
    const s = surfacesOf(nb, TILE, 12);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'direct');
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    for (const [x, z] of [[9.65, 9.65], [7.25, 12.05], [12.05, 9.65]]) { // under the lattice (not at the room's corners)
      let sum = 0;
      for (const [lx, lz] of lights) sum += 3200 * rectFactor(lx - 0.6 - x, lx + 0.6 - x, lz - 0.6 - z, lz + 0.6 - z, 12 - 0.02);
      const [u, v] = gridTexel(floor, 12, x, z);
      const e = texelLum(lm, u, v);
      expect(e).toBeGreaterThanOrEqual(0.85 * sum);
      expect(e).toBeLessThanOrEqual(1.05 * sum);
    }
  });
});

describe('furniture shadow', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 8.4, pz: 8.4, py: 2.7 });
  // desk centred 0.9 m beside the light, long axis along x
  l.props.push({ kind: PropKind.DESK, variant: 0, x: 8.4, y: 0, z: 9.3, yaw: 0, scale: 1, flags: 0, seed: 1 });
  const nb = handNeighborhood(l);
  for (const variant of ['full', 'preview'] as const) {
    it(`floor under a desk top is < 35% of the open floor 1 m beside it (${variant})`, () => {
      const s = surfacesOf(nb, TILE, 12);
      const lm = bakeTile(nb, TILE, s, variant, Q_HIGH, 'all');
      const floor = findChart(s, ChartKind.FLOOR_GRID);
      const under = sampleGrid(lm, floor, 12, 8.4, 9.25);
      const beside = sampleGrid(lm, floor, 12, 8.4 + 1.75, 9.25); // 1 m beyond the desk's 0.75 m half length
      expect(beside).toBeGreaterThan(50);
      expect(under).toBeLessThan(0.35 * beside);
    });
  }
});

describe('directionality', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 6.05, pz: 6.05, py: 2.7 });
  addLight(l, { px: 12.05, pz: 12.05, py: 2.7, luminance: 1500 });
  const nb = handNeighborhood(l);
  it('dir.a in [0, 1], and the direction points at the light', () => {
    const s = surfacesOf(nb, TILE, 12);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
    let n = 0;
    for (let i = 0; i < lm.width * lm.height; i++) {
      const a = lm.dir[i * 4 + 3] / 255;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      if (fromHalf(lm.irr[i * 4]) > 0) n++;
    }
    expect(n).toBeGreaterThan(1000);
    // floor texel 1.5 m east of light 1: the dominant direction leans west and up
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const [u, v] = gridTexel(floor, 12, 7.55, 6.05);
    const o = (v * lm.width + u) * 4;
    const dx = lm.dir[o] / 255 * 2 - 1, dy = lm.dir[o + 1] / 255 * 2 - 1;
    expect(dx).toBeLessThan(-0.3);
    expect(dy).toBeGreaterThan(0.5);
    expect(lm.dir[o + 3] / 255).toBeGreaterThan(0.4);
    void lastBake;
  });
});
