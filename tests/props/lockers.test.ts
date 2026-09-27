// tests/props/lockers.test.ts — locker banks dressed onto tall METAL_PAINTED PARTITION edges (lockers.ts via
// buildTileProps): only locker-height metal partitions get them, valid geometry wound to its normals, the dressing
// stays within the bank's slab + locker depth (+ ajar doors) and under the top cap, it covers both faces and the
// top of the slab, detail per door, the enamel's clearcoat bit, deterministic.

import { describe, expect, it } from 'vitest';
import { CELL, PARTITION_T } from '../../src/core/constants.ts';
import { exIdx, ezIdx, type TileKey } from '../../src/core/grid.ts';
import { EdgeKind, Mat, Mood, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import { buildTileProps, lastTilePropsStats } from '../../src/props/tileProps.ts';
import { bounds, fakeNeighborhood, validate, windingMismatch } from './meshUtil.ts';

const key: TileKey = { s: 2, cx: 0, cz: 0, q: 0 };

function room(hA: number, mat: number = Mat.METAL_PAINTED): ChunkLayout {
  const l = createEmptyLayout({ s: 2, cx: 0, cz: 0 }, Zone.POOLROOMS, 0, Mood.NORMAL);
  l.ceilCm.fill(280);
  // a bank of 5 cells along z = 3 * CELL (ez edges, x cells 2..6) and one along x = 10 * CELL (ex edges, z cells 4..7)
  for (let li = 2; li < 7; li++) {
    const e = ezIdx(li, 3);
    l.ez.kind[e] = EdgeKind.PARTITION; l.ez.hA[e] = hA; l.ez.matNeg[e] = mat; l.ez.matPos[e] = mat;
  }
  for (let lj = 4; lj < 8; lj++) {
    const e = exIdx(10, lj);
    l.ex.kind[e] = EdgeKind.PARTITION; l.ex.hA[e] = hA; l.ex.matNeg[e] = mat; l.ex.matPos[e] = mat;
  }
  return l;
}

describe('locker banks on tall metal partitions', () => {
  it('leaves restroom-height (150 cm) and non-metal partitions alone', () => {
    expect(buildTileProps(fakeNeighborhood(room(150)), key)).toBeNull();
    expect(buildTileProps(fakeNeighborhood(room(200, Mat.FABRIC_PARTITION)), key)).toBeNull();
  });

  it('dresses both faces of every 2 m METAL_PAINTED partition edge: valid, wound to normals, inside the bank volume', () => {
    const m = buildTileProps(fakeNeighborhood(room(200)), key)!;
    expect(m).not.toBeNull();
    expect(validate(m)).toEqual([]);
    expect(windingMismatch(m)).toBe(0);
    expect(m.indexCount / 3).toBe(lastTilePropsStats.lockerTris);
    const perEdge = lastTilePropsStats.lockerTris / 9;
    expect(perEdge).toBeGreaterThan(600); // doors, louvres, plates, digits, handles on both faces
    expect(perEdge).toBeLessThan(2600);
    const b = bounds(m);
    expect(b[1]).toBeGreaterThanOrEqual(-1e-4);
    expect(b[4]).toBeLessThanOrEqual(2.0 + 0.013);
    // no vertex strays from its bank: within the bank's length (+ end panels around the end posts) and 0.7 m of the edge line (ajar doors)
    const P = m.position;
    for (let v = 0; v < m.vertexCount; v++) {
      const x = P[v * 3], z = P[v * 3 + 2];
      const bankZ = Math.abs(z - 3 * CELL) <= 0.7 && x >= 2 * CELL - 0.1 && x <= 7 * CELL + 0.1;
      const bankX = Math.abs(x - 10 * CELL) <= 0.7 && z >= 4 * CELL - 0.1 && z <= 8 * CELL + 0.1;
      expect(bankZ || bankX, `vertex ${v} (${x.toFixed(3)}, ${z.toFixed(3)})`).toBe(true);
    }
    // both faces covered: geometry beyond the slab face on either side of each bank, and a cap above the slab top
    let zNeg = 0, zPos = 0, xNeg = 0, xPos = 0, cap = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      if (x > 2 * CELL && x < 7 * CELL) {
        if (z < 3 * CELL - PARTITION_T) zNeg++;
        if (z > 3 * CELL + PARTITION_T) zPos++;
        if (y > 2.0) cap++;
      }
      if (z > 4 * CELL && z < 8 * CELL) {
        if (x < 10 * CELL - PARTITION_T) xNeg++;
        if (x > 10 * CELL + PARTITION_T) xPos++;
      }
    }
    expect(Math.min(zNeg, zPos, xNeg, xPos)).toBeGreaterThan(500);
    expect(cap).toBeGreaterThan(0);
  });

  it('the enamel paint carries the clearcoat bit (aux.z & 2); handles, plates and interiors do not', () => {
    const m = buildTileProps(fakeNeighborhood(room(200)), key)!;
    let coat = 0, bare = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      if ((m.aux[v * 4 + 2] & 2) === 0) { bare++; continue; }
      coat++;
      expect(m.layer[v]).toBe(Mat.METAL_PAINTED);
    }
    expect(coat).toBeGreaterThan(m.vertexCount / 3);
    expect(bare).toBeGreaterThan(0);
  });

  it('skips the face toward a SOLID cell and is deterministic', () => {
    const a = buildTileProps(fakeNeighborhood(room(200)), key)!;
    const b = buildTileProps(fakeNeighborhood(room(200)), key)!;
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.index)).toEqual(Array.from(b.index));
    const l = room(200);
    // cells z-row 3 (the +z side of the ez bank) solid
    for (let li = 0; li < 32; li++) l.flags[3 * 32 + li] |= 1; // CellFlag.SOLID
    const c = buildTileProps(fakeNeighborhood(l), key)!;
    expect(c.indexCount).toBeLessThan(a.indexCount);
  });
});
