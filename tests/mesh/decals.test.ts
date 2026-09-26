// tests/mesh/decals.test.ts — WP5 acceptance: decal orientation follows the core/layout.ts `rot` convention.
// Floor decal rot = 0 => +v along -Z; rot = PI/2 => +v along -X; wall decal rot = 0 => +v = +Y (and rot = PI/2 turns
// +v counter-clockwise as seen by a viewer in front of the wall). Also: 2 mm offset, DECAL flag, layers, stripe uv,
// clipping to the owner tile's cells.

import { describe, expect, test, vi } from 'vitest';
import { CELL, lmTexel } from '../../src/core/constants.ts';
import { DECAL_PAINT_STRIPE, Mat, VFlag } from '../../src/core/ids.ts';
import type { ChunkLayout, DecalPlacement } from '../../src/core/layout.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { decalFrame, digitRect, parkingNumber } from '../../src/mesh/decals.ts';
import { Scene } from './fixtures.ts';
import { asciiNb, tileKey } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

function roomWith(decals: DecalPlacement[]): ReturnType<typeof asciiNb> {
  const s = new Scene().room(2, 2, 10, 10);
  return asciiNb(s.text(), undefined, (l: ChunkLayout) => { l.decals.push(...decals); });
}
const D = (p: Partial<DecalPlacement>): DecalPlacement => ({
  kind: 1, sign: false, px: 6.6, py: 0, pz: 6.6, nx: 0, ny: 1, nz: 0, rot: 0, w: 0.5, h: 0.4, alpha: 1, ...p,
});

/** Direction (unit, 3D) in which the material v coordinate increases on triangle t, plus the u direction. */
function uvDirs(m: MeshBuffers, t: number): { dv: number[]; du: number[] } {
  const I = m.index, P = m.position, U = m.uv;
  const p = [0, 1, 2].map((k) => [P[I[t * 3 + k] * 3], P[I[t * 3 + k] * 3 + 1], P[I[t * 3 + k] * 3 + 2]]);
  const uv = [0, 1, 2].map((k) => [U[I[t * 3 + k] * 2], U[I[t * 3 + k] * 2 + 1]]);
  const e1 = [0, 1, 2].map((i) => p[1][i] - p[0][i]), e2 = [0, 1, 2].map((i) => p[2][i] - p[0][i]);
  const du1 = uv[1][0] - uv[0][0], dv1 = uv[1][1] - uv[0][1], du2 = uv[2][0] - uv[0][0], dv2 = uv[2][1] - uv[0][1];
  const det = du1 * dv2 - du2 * dv1;
  // position derivatives dP/du, dP/dv (tangent frame)
  const dPdu = [0, 1, 2].map((i) => (e1[i] * dv2 - e2[i] * dv1) / det);
  const dPdv = [0, 1, 2].map((i) => (e2[i] * du1 - e1[i] * du2) / det);
  const n = (v: number[]): number[] => { const l = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / l); };
  return { dv: n(dPdv), du: n(dPdu) };
}

function onlyDecal(d: DecalPlacement, q = 0): MeshBuffers {
  const { mesh } = buildTile(roomWith([d]), tileKey(0, 0, 0, q), 12);
  expect(mesh.decals).not.toBeNull();
  return mesh.decals!;
}

describe('decal orientation (rot convention)', () => {
  test('floor decal rot = 0: +v along -Z', () => {
    const m = onlyDecal(D({ rot: 0 }));
    for (let t = 0; t < m.indexCount / 3; t++) {
      const { dv } = uvDirs(m, t);
      expect(dv[2]).toBeCloseTo(-1, 6);
    }
  });
  test('floor decal rot = PI/2: +v along -X', () => {
    const m = onlyDecal(D({ rot: Math.PI / 2 }));
    for (let t = 0; t < m.indexCount / 3; t++) expect(uvDirs(m, t).dv[0]).toBeCloseTo(-1, 6);
  });
  test('wall decal rot = 0: +v = +Y; rot = PI/2: +v turned counter-clockwise as seen from the front', () => {
    // west wall of the room: line x = 2.4, face toward +x at x = 2.4 + WALL_T/2
    const wall = D({ nx: 1, ny: 0, nz: 0, px: 2.475, py: 1.4, pz: 6.6, rot: 0 });
    let m = onlyDecal(wall);
    for (let t = 0; t < m.indexCount / 3; t++) expect(uvDirs(m, t).dv[1]).toBeCloseTo(1, 6);
    // viewer in front looks along -x; their right is -z, so a counter-clockwise quarter turn points +v to +z
    m = onlyDecal({ ...wall, rot: Math.PI / 2 });
    for (let t = 0; t < m.indexCount / 3; t++) expect(uvDirs(m, t).dv[2]).toBeCloseTo(1, 6);
    // u is the viewer's right at rot 0
    m = onlyDecal(wall);
    for (let t = 0; t < m.indexCount / 3; t++) expect(uvDirs(m, t).du[2]).toBeCloseTo(-1, 6);
  });
  test('decalFrame is right-handed about the normal (u x v = n)', () => {
    for (const d of [D({ rot: 0.3 }), D({ nx: 0, ny: -1, nz: 0, rot: 1.1 }), D({ nx: 0, ny: 0, nz: -1, rot: 2 }), D({ nx: -1, ny: 0, nz: 0, rot: -0.7 })]) {
      const { n, u, v } = decalFrame(d);
      const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(n[i], 9);
    }
  });
});

describe('decal buffer contents', () => {
  test('2 mm offset, DECAL flag, atlas slot uv, colour / emit / alpha, borrowed lightmap uv', () => {
    const m = onlyDecal(D({ kind: 5, px: 6.6, pz: 6.6, alpha: 0.5, emit: 12, color: [1, 0.5, 0.25] }));
    for (let v = 0; v < m.vertexCount; v++) {
      expect(m.position[v * 3 + 1]).toBeCloseTo(0.002, 9);
      expect(m.flags[v] & VFlag.DECAL).toBe(VFlag.DECAL);
      expect(m.layer[v]).toBe(Mat.DECAL_ATLAS);
      expect(m.emit[v]).toBe(12);
      expect(m.tint[v * 4 + 3]).toBe(128);
      expect(m.tint[v * 4 + 1]).toBe(128);
      // slot 5 = column 1, row 1 of the 4x4 atlas
      expect(m.uv[v * 2]).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(m.uv[v * 2]).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(m.uv[v * 2 + 1]).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(m.uv[v * 2 + 1]).toBeLessThanOrEqual(0.5 + 1e-6);
      // lightmap uv of the floor grid at the same xz (FLOOR_GRID at atlas (0,0))
      const t = lmTexel(12);
      expect(m.lmUv[v * 2] * 512).toBeCloseTo(m.position[v * 3] / t + 1, 4);
    }
  });
  test('signage layer, paint stripes in metres, decals split at cell lines and clipped to the tile', () => {
    let m = onlyDecal(D({ sign: true, kind: 3 }));
    expect(m.layer[0]).toBe(Mat.SIGNAGE);
    m = onlyDecal(D({ kind: DECAL_PAINT_STRIPE, w: 2.0, h: 0.1, px: 6.0 }));
    expect(m.layer[0]).toBe(Mat.FLOOR_PAINT);
    for (let v = 0; v < m.vertexCount; v++) expect(m.uv[v * 2]).toBeCloseTo(m.position[v * 3] / 1.2, 6);
    // a 2 m stripe centred on a cell line is split into pieces that never cross x = k * CELL
    for (let t = 0; t < m.indexCount / 3; t++) {
      const xs = [0, 1, 2].map((k) => m.position[m.index[t * 3 + k] * 3]);
      const lo = Math.min(...xs), hi = Math.max(...xs);
      expect(Math.floor(lo / CELL + 1e-6)).toBe(Math.floor(hi / CELL - 1e-6));
    }
    // a decal straddling the tile line x = 19.2 is clipped: each tile only gets its own half
    const nb = roomWith([]);
    const d = D({ px: 19.2, pz: 6.6, w: 1.0, h: 0.4 });
    const big = asciiNb(new Scene().room(10, 2, 26, 10).text(), undefined, (l) => { l.decals.push(d); });
    void nb;
    const a = buildTile(big, tileKey(0, 0, 0, 0), 12).mesh.decals!, b = buildTile(big, tileKey(0, 0, 0, 1), 12).mesh.decals!;
    for (let v = 0; v < a.vertexCount; v++) expect(a.position[v * 3]).toBeLessThanOrEqual(19.2 + 1e-5);
    for (let v = 0; v < b.vertexCount; v++) expect(b.position[v * 3]).toBeGreaterThanOrEqual(-1e-5);
    const area = (mm: MeshBuffers): number => {
      let s = 0;
      for (let t = 0; t < mm.indexCount / 3; t++) {
        const p = [0, 1, 2].map((k) => [mm.position[mm.index[t * 3 + k] * 3], mm.position[mm.index[t * 3 + k] * 3 + 2]]);
        s += Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;
      }
      return s;
    };
    expect(area(a) + area(b)).toBeCloseTo(0.4, 6);
  });
});

describe('decal variants (B3)', () => {
  test('parking stencils: bay numbers vary along a column row and every digit cell lies inside the atlas slot', () => {
    const row = Array.from({ length: 12 }, (_, k) => parkingNumber(k * 7.2 + 3.6, 12.3));
    expect(new Set(row).size).toBe(12);
    for (let k = 1; k < row.length; k++) expect((row[k] - row[k - 1] + 99) % 99).toBe(1);
    for (const n of row) { expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(99); }
    for (let d = 0; d < 10; d++) {
      const r = digitRect(d);
      for (const v of [r.u0, r.u1, r.v0, r.v1]) { expect(v).toBeGreaterThan(0.02); expect(v).toBeLessThan(0.98); }
      expect(r.u1).toBeGreaterThan(r.u0);
      expect(r.v1).toBeGreaterThan(r.v0);
    }
  });
  test('a PARKING_NUMBER decal becomes two digit quads, each inside slot 15', () => {
    const m = onlyDecal(D({ kind: 15, nx: 1, ny: 0, nz: 0, px: 2.475, py: 1.4, pz: 6.6, w: 0.42, h: 0.42 }));
    expect(m.indexCount / 3).toBeGreaterThanOrEqual(4);
    for (let v = 0; v < m.vertexCount; v++) {
      expect(m.uv[v * 2]).toBeGreaterThanOrEqual(0.75 - 1e-6);
      expect(m.uv[v * 2 + 1]).toBeGreaterThanOrEqual(0.75 - 1e-6);
    }
  });
});
