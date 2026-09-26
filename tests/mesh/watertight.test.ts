// tests/mesh/watertight.test.ts — WP5 acceptance: wall faces meet posts (and each other, reveals, covers) with gaps
// < 1 mm. Every vertical boundary edge of a WALL-chart face (and of every post face) must be matched, over its whole
// height, by vertical edges of other shell faces at the same xz (within 1 mm). Faces on the chunk border are skipped
// (their continuation belongs to the neighbouring chunk, which is not built here).

import { describe, expect, test, vi } from 'vitest';
import { CELL, CHUNK_SIZE, PARTITION_BASE_CM, PARTITION_BASE_T } from '../../src/core/constants.ts';
import { tileCell0 } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Zone, type StoreyId } from '../../src/core/ids.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { faceSpec } from '../../src/mesh/buildTile.ts';
import { BUF_SHELL, type Face } from '../../src/mesh/plan.ts';
import { planTile } from '../../src/mesh/surfaces.ts';
import { eix } from '../../src/mesh/tileGrid.ts';
import { POST_H } from '../../src/mesh/walls.ts';
import { blockerNb, mazeNb, mixNb, pitNb } from './fixtures.ts';
import { genNb, tileKey } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

const Q = 2000; // 0.5 mm keys
interface VEdge { x: number; z: number; y0: number; y1: number; face: number }

interface Vol { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }

/** Shell faces of the 4 tiles (chunk-local offsets) + solid volumes: edge pieces (with thickness), partition plinths,
 * posts and SOLID cells. A face edge strictly inside a volume is hidden, not a gap. */
function chunkFaces(nb: LayoutNeighborhood, s: StoreyId, cx: number, cz: number): { faces: { f: Face; ox: number; oz: number }[]; vols: Vol[] } {
  const faces: { f: Face; ox: number; oz: number }[] = [];
  const vols: Vol[] = [];
  for (let q = 0; q < 4; q++) {
    const tp = planTile(nb, tileKey(s, cx, cz, q), 12);
    const [li0, lj0] = tileCell0(q);
    const ox = li0 * CELL, oz = lj0 * CELL;
    for (const f of tp.plan.faces) if (f.buf === BUF_SHELL) faces.push({ f, ox, oz });
    const wm = tp.walls;
    for (let a = 0; a < 2; a++) {
      for (let L = 0; L <= 16; L++) {
        for (let c = 0; c < 16; c++) {
          const e = eix(a, L, c);
          if (!wm.ok[e] || !wm.thick[e]) continue;
          const pr = wm.pieces(e), d = wm.half[e], lc = L * CELL, tb = c * CELL;
          const box = (t0: number, t1: number, y0: number, y1: number, h: number): void => {
            vols.push(a === 0
              ? { x0: ox + lc - h, x1: ox + lc + h, z0: oz + tb + t0, z1: oz + tb + t1, y0, y1 }
              : { x0: ox + tb + t0, x1: ox + tb + t1, z0: oz + lc - h, z1: oz + lc + h, y0, y1 });
          };
          for (let i = 0; i < wm.pn[e]; i++) box(pr[i * 4], pr[i * 4 + 1], pr[i * 4 + 2], pr[i * 4 + 3], d);
          if (tp.grid.eKind[e] === EdgeKind.PARTITION) box(0, CELL, wm.yLo[e], wm.ySill[e] + PARTITION_BASE_CM / 100, PARTITION_BASE_T / 2);
        }
      }
    }
    for (let vj = 0; vj <= 16; vj++) {
      for (let vi = 0; vi <= 16; vi++) {
        const iv = wm.post(vi, vj);
        if (!iv) continue;
        for (let i = 0; i < iv.length; i += 2) vols.push({ x0: ox + vi * CELL - POST_H, x1: ox + vi * CELL + POST_H, z0: oz + vj * CELL - POST_H, z1: oz + vj * CELL + POST_H, y0: iv[i], y1: iv[i + 1] });
      }
    }
  }
  for (let lj = -1; lj <= 32; lj++) {
    for (let li = -1; li <= 32; li++) {
      if (nb.flags(li, lj) & CellFlag.SOLID) vols.push({ x0: li * CELL, x1: (li + 1) * CELL, z0: lj * CELL, z1: (lj + 1) * CELL, y0: -100, y1: 100 });
    }
  }
  return { faces, vols };
}

function verticalEdges(f: Face, ox: number, oz: number, id: number, out: VEdge[]): void {
  const p = f.p, n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (Math.abs(p[i * 3] - p[j * 3]) < 1e-6 && Math.abs(p[i * 3 + 2] - p[j * 3 + 2]) < 1e-6 && Math.abs(p[i * 3 + 1] - p[j * 3 + 1]) > 1e-6) {
      out.push({ x: p[i * 3] + ox, z: p[i * 3 + 2] + oz, y0: Math.min(p[i * 3 + 1], p[j * 3 + 1]), y1: Math.max(p[i * 3 + 1], p[j * 3 + 1]), face: id });
    }
  }
}

function gaps(nb: LayoutNeighborhood, s: StoreyId = 0, cx = 0, cz = 0): string[] {
  const { faces, vols } = chunkFaces(nb, s, cx, cz);
  // axis-aligned vertical faces (for edges lying on another face's surface: T-junctions against posts / walls)
  const planes: { ax: number; c: number; lo: number; hi: number; y0: number; y1: number }[] = [];
  for (const { f, ox, oz } of faces) {
    if (Math.abs(f.ny) > 1e-3 || (Math.abs(f.nx) < 0.999 && Math.abs(f.nz) < 0.999)) continue;
    const ax = Math.abs(f.nx) > 0.5 ? 0 : 2, o = ax === 0 ? 2 : 0;
    let lo = Infinity, hi = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < f.p.length; i += 3) {
      lo = Math.min(lo, f.p[i + o]); hi = Math.max(hi, f.p[i + o]); y0 = Math.min(y0, f.p[i + 1]); y1 = Math.max(y1, f.p[i + 1]);
    }
    const off = o === 0 ? ox : oz;
    planes.push({ ax, c: f.p[ax] + (ax === 0 ? ox : oz), lo: lo + off, hi: hi + off, y0, y1 });
  }
  const edges: VEdge[] = [];
  faces.forEach(({ f, ox, oz }, id) => { if (Math.abs(f.ny) < 1e-3) verticalEdges(f, ox, oz, id, edges); });
  const buckets = new Map<string, VEdge[]>();
  for (const e of edges) {
    const k = `${Math.round(e.x * Q)},${Math.round(e.z * Q)}`;
    let l = buckets.get(k);
    if (!l) buckets.set(k, (l = []));
    l.push(e);
  }
  const bad: string[] = [];
  faces.forEach(({ f, ox, oz }, id) => {
    const spec = faceSpec(f);
    if (!spec || Math.abs(f.ny) > 1e-3 || f.p.length !== 12) return;
    const isWall = spec.kind === ChartKind.WALL && f.own && !f.from;
    const isPost = spec.key.startsWith('4p');
    if (!isWall && !isPost) return;
    const mine: VEdge[] = [];
    verticalEdges(f, ox, oz, id, mine);
    for (const e of mine) {
      if (e.x < 1e-4 || e.z < 1e-4 || e.x > CHUNK_SIZE - 1e-4 || e.z > CHUNK_SIZE - 1e-4) continue;
      const iv: [number, number][] = [];
      const kx = Math.round(e.x * Q), kz = Math.round(e.z * Q);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (const o of buckets.get(`${kx + dx},${kz + dz}`) ?? []) {
            if (o.face === id || Math.hypot(o.x - e.x, o.z - e.z) > 1e-3) continue;
            iv.push([o.y0, o.y1]);
          }
        }
      }
      for (const pl of planes) {
        const pc = pl.ax === 0 ? e.x : e.z, pt = pl.ax === 0 ? e.z : e.x;
        if (Math.abs(pc - pl.c) < 1e-3 && pt > pl.lo - 1e-3 && pt < pl.hi + 1e-3) iv.push([pl.y0, pl.y1]);
      }
      for (const v of vols) if (e.x > v.x0 + 5e-4 && e.x < v.x1 - 5e-4 && e.z > v.z0 + 5e-4 && e.z < v.z1 - 5e-4) iv.push([v.y0, v.y1]);
      iv.sort((a, b) => a[0] - b[0]);
      let cur = e.y0;
      for (const [a, b] of iv) { if (a <= cur + 1e-3) cur = Math.max(cur, b); }
      if (cur < e.y1 - 1e-3) bad.push(`${isPost ? 'post' : 'wall'} edge at (${e.x.toFixed(4)}, ${e.z.toFixed(4)}) y ${e.y0.toFixed(3)}..${e.y1.toFixed(3)} open above ${cur.toFixed(3)} (layer ${f.layer}, key ${spec.key})`);
    }
  });
  return bad;
}

describe('watertight walls', () => {
  test('ASCII fixtures: every wall / post edge meets another face (gap < 1 mm)', () => {
    for (const [name, nb] of [['maze', mazeNb()], ['blocker', blockerNb()], ['pit', pitNb()], ['mix', mixNb()]] as [string, LayoutNeighborhood][]) {
      const bad = gaps(nb);
      expect(bad.slice(0, 12), name).toEqual([]);
    }
  });
  test('generated chunks', () => {
    const cases: [number, StoreyId, number, number, number | null][] = [
      [5, 0, 0, 0, Zone.LOBBY], [5, 0, 1, 0, Zone.OFFICE], [5, 0, 0, 1, Zone.MAZE], [5, 2, 0, 0, Zone.POOLROOMS],
      [5, 1, 0, 0, Zone.WAREHOUSE], [5, 1, 1, 1, Zone.PARKING], [9, 0, 2, 2, null],
    ];
    for (const [seed, s, cx, cz, z] of cases) {
      const bad = gaps(genNb(seed, s, cx, cz, z as never), s, cx, cz);
      expect(bad.slice(0, 12), `seed ${seed} zone ${z}`).toEqual([]);
    }
  });
});
