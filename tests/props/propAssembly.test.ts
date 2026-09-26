// tests/props/propAssembly.test.ts — every prop kind is one assembled object that stays inside its rotated
// footprint at arbitrary (non-quarter) yaws:
// - rotated footprint: every vertex, mapped back through the inverse yaw, lies inside PROP_DEFS.size (so no part
//   is built in a frame that the prop's yaw does not reach);
// - no floating parts: the prop's surface pieces (vertices welded by position) form ONE cluster when pieces whose
//   bounding boxes touch (within 4 mm) are joined. Resting on the floor does not count as a connection, so e.g. a
//   pair of wheels lying next to a lounger (not attached to its frame) fails. Scatter kinds are exempt; flat
//   applied labels may stand off 1 cm; a rack's floor-slot cartons may stand free.

import { describe, expect, it } from 'vitest';
import { PROP_KIND_COUNT, PropKind, type PropKindId } from '../../src/core/ids.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import type { PropPlacement } from '../../src/core/layout.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { GeometryWriter } from '../../src/core/writer.ts';
import { emitProp, PROP_VARIANTS } from '../../src/props/index.ts';

const X0 = 5, Y0 = 0.5, Z0 = 7;
const YAWS = [0, 0.37, 1.1, Math.PI / 2 + 0.2, 2.6, Math.PI, -0.9, -2.2];
const TOL = 3e-4;

function build(kind: number, variant: number, yaw: number): MeshBuffers {
  const p: PropPlacement = { kind: kind as PropKindId, variant, x: X0, y: Y0, z: Z0, yaw, scale: 1, flags: 0, seed: 4321 };
  const w = new GeometryWriter(1024);
  emitProp(w, p, 0, 0);
  return w.finish();
}

/** Pieces = connected components of triangles sharing (position-welded) vertices; returns each piece's AABB. */
function pieces(m: MeshBuffers): number[][] {
  const P = m.position, I = m.index;
  const weld = new Map<string, number>();
  const id = new Int32Array(m.vertexCount);
  for (let v = 0; v < m.vertexCount; v++) {
    const k = `${Math.round(P[v * 3] * 2000)},${Math.round(P[v * 3 + 1] * 2000)},${Math.round(P[v * 3 + 2] * 2000)}`;
    let w = weld.get(k);
    if (w === undefined) { w = weld.size; weld.set(k, w); }
    id[v] = w;
  }
  const par = Array.from({ length: weld.size }, (_, i) => i);
  const find = (a: number): number => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let t = 0; t < m.indexCount; t += 3) {
    const a = find(id[I[t]]);
    par[find(id[I[t + 1]])] = a;
    par[find(id[I[t + 2]])] = a;
  }
  const boxes = new Map<number, number[]>();
  for (let v = 0; v < m.vertexCount; v++) {
    const r = find(id[v]);
    let b = boxes.get(r);
    if (!b) { b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; boxes.set(r, b); }
    for (let k = 0; k < 3; k++) {
      const x = P[v * 3 + k];
      if (x < b[k]) b[k] = x;
      if (x > b[k + 3]) b[k + 3] = x;
    }
  }
  return [...boxes.values()];
}

/** Clusters of pieces whose AABBs touch within `gap` metres. Flat pieces (thinner than 1 mm: applied labels /
 * decal cards on curved bodies) may stand off up to 1 cm. */
function clusters(boxes: number[][], gap: number): number[][][] {
  const flat = (b: number[]): boolean => Math.min(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < 1e-3;
  const n = boxes.length;
  const par = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = boxes[i], b = boxes[j];
      const g = flat(a) || flat(b) ? Math.max(gap, 0.01) : gap;
      if (a[0] <= b[3] + g && b[0] <= a[3] + g && a[1] <= b[4] + g && b[1] <= a[4] + g && a[2] <= b[5] + g && b[2] <= a[5] + g) {
        par[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[][]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(boxes[i]);
    groups.set(r, g);
  }
  return [...groups.values()];
}

// Kinds that are deliberately several loose objects (scattered debris / shards). Only true scatter kinds belong here.
const SCATTER = new Set<number>([PropKind.CEILING_DEBRIS, PropKind.TILE_FRAGMENT]);
// Kinds that may carry extra free-standing objects on the floor inside their footprint (cartons stored in a rack's
// floor slot). Every other group must still hang together.
const FLOOR_ITEMS = new Set<number>([PropKind.SHELF_RACK]);
const KINDS = Array.from({ length: PROP_KIND_COUNT }, (_, i) => i);

describe('props: assembled and inside the rotated footprint at any yaw', () => {
  for (const kind of KINDS) {
    const def = PROP_DEFS[kind];
    it(`${def.name}: every part stays inside the yawed PROP_DEFS box`, () => {
      const [sx, sy, sz] = def.size;
      for (let v = 0; v < PROP_VARIANTS; v++) {
        for (const yaw of YAWS) {
          const m = build(kind, v, yaw);
          const c = Math.cos(yaw), s = Math.sin(yaw);
          let worst = 0, where = '';
          for (let i = 0; i < m.vertexCount; i++) {
            const dx = m.position[i * 3] - X0, dy = m.position[i * 3 + 1] - Y0, dz = m.position[i * 3 + 2] - Z0;
            const lx = c * dx - s * dz, lz = s * dx + c * dz; // inverse of the writer's R_y(yaw)
            const over = Math.max(Math.abs(lx) - sx / 2, Math.abs(lz) - sz / 2, -dy, dy - sy);
            if (over > worst) { worst = over; where = `local (${lx.toFixed(3)}, ${dy.toFixed(3)}, ${lz.toFixed(3)})`; }
          }
          expect(worst, `${def.name} v${v} yaw ${yaw.toFixed(2)}: vertex ${where} outside size ${def.size.join('x')}`).toBeLessThanOrEqual(TOL);
        }
      }
    });

    if (SCATTER.has(kind)) continue;
    it(`${def.name}: no detached parts (one connected assembly)`, () => {
      for (let v = 0; v < PROP_VARIANTS; v++) {
        for (const yaw of [0, 1.1]) {
          let cl = clusters(pieces(build(kind, v, yaw)), 0.004);
          if (FLOOR_ITEMS.has(kind)) {
            // drop free-standing floor items (a group whose lowest point is on the floor and that is not the largest)
            const size = (g: number[][]): number => g.length;
            const main = cl.reduce((a, g) => (size(g) > size(a) ? g : a));
            cl = cl.filter((g) => g === main || Math.min(...g.map((x) => x[1])) > Y0 + 1e-3);
          }
          const desc = cl.length > 1
            ? cl.map((g) => {
              const b = g.reduce((a, x) => [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.min(a[2], x[2]), Math.max(a[3], x[3]), Math.max(a[4], x[4]), Math.max(a[5], x[5])]);
              return `[${g.length} pieces, x ${(b[0] - X0).toFixed(2)}..${(b[3] - X0).toFixed(2)} y ${(b[1] - Y0).toFixed(2)}..${(b[4] - Y0).toFixed(2)} z ${(b[2] - Z0).toFixed(2)}..${(b[5] - Z0).toFixed(2)}]`;
            }).join(' ')
            : '';
          expect(cl.length, `${def.name} v${v} yaw ${yaw}: ${cl.length} detached groups ${desc}`).toBe(1);
        }
      }
    });
  }
});
