// tests/bake/gradient.test.ts — the indirect gradient (TL2): the probes' hemisphere tangential moments give the exact
// first-order normal response of a known radiance field (where half the full-sphere moment is wrong whenever the field
// is not symmetric about the receiver plane), the per-face encoding round-trips through the shader's decode (TS twin),
// and a baked room stores the floor bounce as a downward gradient on its walls.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID } from '../../src/bake/context.ts';
import { decodeGrad, encodeGrad, gradAxes, LM_DIR_LAYERS } from '../../src/bake/encode.ts';
import { indirectGradient } from '../../src/bake/indirect.ts';
import { createJob } from '../../src/bake/job.ts';
import { addMoments } from '../../src/bake/probes.ts';
import { lmGradWorld } from '../../src/materials/chunks/common.ts';
import { Q_HIGH, addLight, carveRoom, handNeighborhood, solidLayout, surfacesOf } from './helpers.ts';

/** Dense Fibonacci sphere. */
function sphere(n: number): Float64Array {
  const d = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - y * y), ph = i * Math.PI * (3 - Math.sqrt(5));
    d[i * 3] = r * Math.cos(ph); d[i * 3 + 1] = y; d[i * 3 + 2] = r * Math.sin(ph);
  }
  return d;
}
const DIRS = sphere(200000);
const DW = (4 * Math.PI) / 200000;

type Field = (x: number, y: number, z: number) => number;
/** Uniform ambient plus a smooth lobe (cos^8) around the unit direction s. */
const field = (ambient: number, peak: number, s: readonly number[]): Field => (x, y, z) => {
  const c = x * s[0] + y * s[1] + z * s[2];
  return ambient + (c > 0 ? peak * c ** 8 : 0);
};

/** What a probe stores of a field: hemisphere moments (addMoments) and the ambient cube (luma in every channel). */
function probeOf(L: Field): { mom: Float64Array; cube: Float64Array } {
  const mom = new Float64Array(12), cube = new Float64Array(18);
  for (let i = 0; i < DIRS.length; i += 3) {
    const x = DIRS[i], y = DIRS[i + 1], z = DIRS[i + 2], v = L(x, y, z);
    addMoments(mom, x, y, z, v);
    const ax = [x > 0 ? 0 : 3, y > 0 ? 6 : 9, z > 0 ? 12 : 15], w = [Math.abs(x), Math.abs(y), Math.abs(z)];
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) cube[ax[a] + c] += v * w[a];
  }
  for (let k = 0; k < 12; k++) mom[k] *= DW;
  for (let k = 0; k < 18; k++) cube[k] *= DW;
  return { mom, cube };
}
/** The receiver's true irradiance E(n) = integral over the hemisphere of n of L cos. */
function irradiance(L: Field, n: readonly number[]): number {
  let e = 0;
  for (let i = 0; i < DIRS.length; i += 3) {
    const c = DIRS[i] * n[0] + DIRS[i + 1] * n[1] + DIRS[i + 2] * n[2];
    if (c > 0) e += L(DIRS[i], DIRS[i + 1], DIRS[i + 2]) * c;
  }
  return e * DW;
}
/** d E / d theta for n tilted toward the unit tangent t (central difference). */
function slope(L: Field, n: readonly number[], t: readonly number[], h = 0.02): number {
  const tilt = (a: number): number[] => n.map((v, k) => v * Math.cos(a) + t[k] * Math.sin(a));
  return (irradiance(L, tilt(h)) - irradiance(L, tilt(-h))) / (2 * h);
}
const norm = (v: number[]): number[] => { const l = Math.hypot(...v); return v.map((c) => c / l); };

describe('hemisphere moments: the first-order normal response of the indirect light', () => {
  const s = norm([0.5, 0.6, -0.3]);
  const L = field(1, 40, s);
  const P = probeOf(L);
  const G = new Float64Array(3);

  it('matches d E / d theta of the true hemisphere integral on the axis-aligned shell (within 1.5 %)', () => {
    const faces: [number[], number[][]][] = [
      [[1, 0, 0], [[0, 1, 0], [0, 0, 1]]], [[-1, 0, 0], [[0, 1, 0], [0, 0, 1]]],
      [[0, 1, 0], [[1, 0, 0], [0, 0, 1]]], [[0, -1, 0], [[1, 0, 0], [0, 0, 1]]],
      [[0, 0, 1], [[1, 0, 0], [0, 1, 0]]], [[0, 0, -1], [[1, 0, 0], [0, 1, 0]]],
    ];
    for (const [n, ts] of faces) {
      indirectGradient(P.mom, P.cube, n[0], n[1], n[2], G);
      expect(Math.abs(G[0] * n[0] + G[1] * n[1] + G[2] * n[2])).toBeLessThan(1e-9); // tangential
      const e = irradiance(L, n);
      for (const t of ts) {
        const want = slope(L, n, t), got = G[0] * t[0] + G[1] * t[1] + G[2] * t[2];
        expect(Math.abs(got - want), `n ${n} t ${t}: ${got} vs ${want}`).toBeLessThan(0.015 * Math.max(Math.abs(want), 0.05 * e));
      }
    }
  });

  it('a source behind the receiver gives it no gradient (half the full-sphere moment would give 0.5 of the lobe)', () => {
    const Lb = field(1, 40, norm([0.4, -0.9, 0.2])); // a lobe below a floor receiver (n = +y)
    const Pb = probeOf(Lb);
    indirectGradient(Pb.mom, Pb.cube, 0, 1, 0, G);
    const want = slope(Lb, [0, 1, 0], [1, 0, 0]);
    expect(Math.abs(G[0] - want)).toBeLessThan(0.01 * irradiance(Lb, [0, 1, 0]));
    const lum = (o: number): number => Pb.cube[o];
    const half = 0.5 * (lum(0) - lum(3)); // the full-sphere estimate along x
    expect(Math.abs(half - want)).toBeGreaterThan(0.3); // (it sees the lobe behind the floor)
  });

  it('sloped receivers (ramps): the blended hemisphere moment stays within 25 % of the true slope', () => {
    const n = norm([0.3, 0.95, 0]), t = norm([0.95, -0.3, 0]);
    indirectGradient(P.mom, P.cube, n[0], n[1], n[2], G);
    const want = slope(L, n, t), got = G[0] * t[0] + G[1] * t[1] + G[2] * t[2];
    expect(Math.abs(got - want)).toBeLessThan(0.25 * Math.abs(want));
  });
});

describe('the gradient encoding (bake/encode.ts) and the shader decode (TS twin lmGradWorld)', () => {
  it('128 is exactly zero; encodeGrad clamps to [-1, 1]', () => {
    expect(encodeGrad(0)).toBe(128);
    expect(decodeGrad(128)).toBe(0);
    expect(decodeGrad(encodeGrad(1))).toBe(1);
    expect(decodeGrad(encodeGrad(-1))).toBe(-1);
    expect(encodeGrad(3)).toBe(255);
    expect(encodeGrad(-3)).toBe(1);
  });

  it('every face (and a sloped one) round-trips its tangential gradient with the right axes and signs', () => {
    const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], norm([0.3, 0.95, 0]), norm([0, -0.4, 0.9])];
    for (const n of normals) {
      const raw = [0.31, -0.22, 0.47];
      const d = raw[0] * n[0] + raw[1] * n[1] + raw[2] * n[2];
      const g = raw.map((v, k) => v - d * n[k]); // tangential
      const [a0, a1] = gradAxes(n[0], n[1], n[2]);
      const back = lmGradWorld(encodeGrad(g[a0]), encodeGrad(g[a1]), n[0], n[1], n[2]);
      for (let k = 0; k < 3; k++) expect(Math.abs(back[k] - g[k]), `n ${n.map((v) => v.toFixed(2))} axis ${k}`).toBeLessThan(1.5 / 127);
      expect(Math.abs(back[0] * n[0] + back[1] * n[1] + back[2] * n[2])).toBeLessThan(1e-12);
    }
  });
});

describe('a baked room stores its indirect gradient in the dir map layer 1', () => {
  const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 2, 2, 10, 10);
  addLight(l, { px: 6 * CELL, pz: 6 * CELL, py: 2.7 });
  const nb = handNeighborhood(l);
  const s = surfacesOf(nb, TILE, 12);
  const T = setupTexels(createJob(nb, TILE, Q_HIGH, null), s);

  it('full bake: the walls get a downward gradient (the lit floor below outshines the ceiling); preview: none', () => {
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'all');
    const W = lm.width, H = lm.height, g1 = W * H * 4;
    expect(lm.dir.length).toBe(W * H * 4 * LM_DIR_LAYERS);
    let n = 0, down = 0, sum = 0;
    for (let t = 0; t < T.n; t++) {
      if (T.state[t] !== TX_VALID || Math.abs(T.ny[t]) > 0.1 || T.y[t] < 0.9 || T.y[t] > 1.8) continue;
      const o = g1 + T.atlas[t] * 4;
      const g = lmGradWorld(lm.dir[o], lm.dir[o + 1], T.nx[t], T.ny[t], T.nz[t]);
      n++; sum += g[1];
      if (g[1] < 0) down++;
    }
    expect(n).toBeGreaterThan(200);
    expect(down / n).toBeGreaterThan(0.9);
    expect(sum / n).toBeLessThan(-0.05);
    const pv = bakeTile(nb, TILE, s, 'preview', Q_HIGH, 'all');
    for (let i = pv.width * pv.height * 4; i < pv.dir.length; i++) if (pv.dir[i] !== 128) expect(pv.dir[i]).toBe(128);
  });
});
