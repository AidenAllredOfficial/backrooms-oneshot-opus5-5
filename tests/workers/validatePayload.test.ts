// tests/workers/validatePayload.test.ts (WP10) — every validator catches what it must, and accepts valid payloads.

import { describe, expect, it } from 'vitest';
import { CHUNK_CELL_COUNT, EMISSION, LV } from '../../src/core/constants.ts';
import { toHalf } from '../../src/core/half.ts';
import { createEmptyLayout } from '../../src/core/layout.ts';
import type { ChunkCollision, LightmapData, MeshBuffers, TileMesh } from '../../src/core/mesh.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { validateBake, validateBuild, validateLayoutPayload } from '../../src/workers/validatePayload.ts';

function quadMesh(): MeshBuffers {
  const w = new GeometryWriter(8);
  w.setState(0, 0);
  const a = w.vertex(0, 0, 0, 0, 1, 0, 0, 0, 0.1, 0.1);
  const b = w.vertex(1, 0, 0, 0, 1, 0, 1, 0, 0.2, 0.1);
  const c = w.vertex(1, 0, 1, 0, 1, 0, 1, 1, 0.2, 0.2);
  const d = w.vertex(0, 0, 1, 0, 1, 0, 0, 1, 0.1, 0.2);
  w.quad(a, b, c, d);
  return w.finish();
}

function lightmap(variant: 'preview' | 'full', hash = 99, w = 512, h = 256): LightmapData {
  const n = w * h * 4, nv = LV.NX * LV.NY * LV.NZ * 4;
  return {
    tileKey: '0:0:0:0', variant, width: w, height: h, chartHash: hash, irr: new Uint16Array(n).fill(toHalf(300)), dir: new Uint8Array(n),
    flick: null, mask: new Uint8Array(n), emission: new Uint16Array(EMISSION.RES * EMISSION.RES * 4),
    volume: { a: new Uint16Array(nv), b: new Uint8Array(nv), c: null, wallMask: new Uint8Array(18 * 18 * 4) },
    stats: { ms: 1, texels: w * h, rays: 0, lights: 0 },
  };
}

function tileMesh(hash = 99): TileMesh {
  return {
    tileKey: '0:0:0:0', zone: 0, shell: quadMesh(), props: null, water: null, decals: null,
    atlas: { width: 512, height: 256, tpc: 12, chartHash: hash, chartCount: 3 }, dynLights: new Array(9).fill(null), tris: 2,
  };
}

function collision(): ChunkCollision {
  return {
    chunkKey: '0:0:0', boxes: new Float32Array([0, 0, 0, 1, 1, 1]), boxFlags: new Uint8Array([1]),
    cellStart: (() => { const a = new Uint32Array(CHUNK_CELL_COUNT + 1); for (let i = 1; i <= CHUNK_CELL_COUNT; i++) a[i] = 1; return a; })(),
    cellBoxes: new Uint32Array([0]), ramps: new Float32Array(0),
  };
}

function layout() {
  const l = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, 0, 1, 0);
  l.ceilCm.fill(270);
  return l;
}

describe('validateBuild / validateBake', () => {
  it('accepts a valid build and bake', () => {
    expect(validateBuild(tileMesh(), lightmap('preview'))).toEqual([]);
    expect(validateBake(lightmap('full'), 99)).toEqual([]);
  });

  it('build chartHash must equal the lightmap chartHash; bake chartHash must equal the surfaces hash', () => {
    expect(validateBuild(tileMesh(1), lightmap('preview', 2)).join()).toMatch(/chartHash mismatch/);
    expect(validateBake(lightmap('full', 5), 6).join()).toMatch(/chartHash mismatch/);
    expect(validateBake(lightmap('preview'), 99).join()).toMatch(/variant/);
  });

  it('NaN positions, out-of-range indices, lmUv outside the atlas', () => {
    const m = tileMesh();
    m.shell.position[4] = NaN;
    expect(validateBuild(m, lightmap('preview')).join()).toMatch(/position: non-finite/);
    const m2 = tileMesh();
    m2.shell.index[2] = 17;
    expect(validateBuild(m2, lightmap('preview')).join()).toMatch(/index: 17 out of range/);
    const m3 = tileMesh();
    m3.shell.lmUv[3] = 1.5;
    expect(validateBuild(m3, lightmap('preview')).join()).toMatch(/lmUv: 1.5 outside the atlas/);
    const m4 = tileMesh();
    m4.shell.bounds = [0, 0, 0, 0.5, 0, 1];
    expect(validateBuild(m4, lightmap('preview')).join()).toMatch(/outside bounds/);
    const m5 = tileMesh();
    m5.shell.uv = new Float32Array(3);
    expect(validateBuild(m5, lightmap('preview')).join()).toMatch(/shell.uv: length 3, expected 8/);
  });

  it('texture array lengths = w*h*4 and light-volume sizes', () => {
    const lm = lightmap('full');
    lm.dir = new Uint8Array(10);
    expect(validateBake(lm, 99).join()).toMatch(/lightmap.dir: length 10/);
    const lm2 = lightmap('full');
    lm2.volume.a = new Uint16Array(4);
    expect(validateBake(lm2, 99).join()).toMatch(/volume.a: length 4/);
    const lm3 = lightmap('full');
    lm3.volume.wallMask = new Uint8Array(18 * 18);
    expect(validateBake(lm3, 99).join()).toMatch(/wallMask/);
    const lm4 = lightmap('full', 99, 512, 300);
    expect(validateBake(lm4, 99).join()).toMatch(/height: 300/);
  });

  it('half-float NaN/Inf and negative irradiance are rejected; negative emission alpha (dynamic key) is fine', () => {
    const lm = lightmap('full');
    lm.irr[40] = 0x7e00; // NaN
    expect(validateBake(lm, 99).join()).toMatch(/irr: NaN\/Inf/);
    const lm2 = lightmap('full');
    lm2.irr[0] = toHalf(-5);
    expect(validateBake(lm2, 99).join()).toMatch(/irr: negative/);
    const lm3 = lightmap('full');
    lm3.emission[3] = toHalf(-12);
    expect(validateBake(lm3, 99)).toEqual([]);
    lm3.emission[0] = toHalf(-12);
    expect(validateBake(lm3, 99).join()).toMatch(/emission: negative/);
  });
});

describe('validateLayoutPayload', () => {
  it('accepts a valid layout and collision', () => {
    expect(validateLayoutPayload(layout(), collision())).toEqual([]);
  });

  it('collision prefix sums must be monotone and consistent', () => {
    const c = collision();
    c.cellStart[500] = 0;
    expect(validateLayoutPayload(layout(), c).join()).toMatch(/not monotone/);
    const c2 = collision();
    c2.cellBoxes[0] = 3;
    expect(validateLayoutPayload(layout(), c2).join()).toMatch(/cellBoxes\[0\] = 3/);
    const c3 = collision();
    c3.boxes[2] = NaN;
    expect(validateLayoutPayload(layout(), c3).join()).toMatch(/non-finite/);
    const c4 = collision();
    c4.ramps = new Float32Array([0, 0, 1, 1, 0, 1, 7, 0]);
    expect(validateLayoutPayload(layout(), c4).join()).toMatch(/dir 7/);
    const c5 = collision();
    c5.chunkKey = '0:1:0';
    expect(validateLayoutPayload(layout(), c5).join()).toMatch(/chunkKey/);
  });

  it('per-cell array sizes, enum ranges (incl. wallMat / trimMat) and ceilings', () => {
    const l = layout();
    l.wallMat = new Uint8Array(10);
    expect(validateLayoutPayload(l, collision()).join()).toMatch(/layout.wallMat: length 10/);
    const l2 = layout();
    l2.trimMat[3] = 200;
    expect(validateLayoutPayload(l2, collision()).join()).toMatch(/wallMat\/trimMat\[3\]/);
    const l3 = layout();
    l3.ex.kind[7] = 42;
    expect(validateLayoutPayload(l3, collision()).join()).toMatch(/ex.kind\[7\] = 42/);
    const l4 = layout();
    l4.ceilCm[9] = -10;
    expect(validateLayoutPayload(l4, collision()).join()).toMatch(/cell 9: ceilCm/);
    const l5 = layout();
    l5.fixtures.push({
      id: 1, kind: 0, state: 0, shape: 0, px: NaN, py: 2.7, pz: 1, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 1, h: 1,
      color: [1, 1, 1], luminance: 1, seed: 1, hum: 0, bakeGroup: 0, dynamic: false,
    });
    expect(validateLayoutPayload(l5, collision()).join()).toMatch(/fixtures\[0\]/);
  });
});
