// tests/mesh/buffers.test.ts — WP5 acceptance: valid buffers (no NaN, indices in range, no degenerate triangles,
// unit normals, winding matches normals), lmUv inside charts, non-overlapping charts that fit the atlas, the grid
// texel invariant and the triangle cap, over ASCII fixtures and generated chunks of every zone.

import { describe, expect, test, vi } from 'vitest';
import { CELL, LM_ATLAS_W, LM_PAD, LM_TPC_ALLOWED, WALL_T, lmTexel, type LmTpc } from '../../src/core/constants.ts';
import { EDGE_OCCLUDES, edgeBaseThickness } from '../../src/core/edges.ts';
import { ChartKind, type Chart, type MeshBuffers, type SurfaceSet } from '../../src/core/mesh.ts';
import { Zone, ZONE_COUNT, ZONE_NAMES, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { buildTile, faceSpec } from '../../src/mesh/buildTile.ts';
import { planTile } from '../../src/mesh/surfaces.ts';
import { blockerNb, mazeNb, mixNb, pitNb } from './fixtures.ts';
import { chartOverlaps, genNb, meshProblems, tileKey } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

const storeyOf = (z: number): StoreyId => (z >= 7 ? (z === 7 ? 2 : 1) : 0) as StoreyId;

function checkTile(nb: LayoutNeighborhood, s: StoreyId, cx: number, cz: number, q: number, tpc: LmTpc, label: string): { tris: number; surfaces: SurfaceSet } {
  const { mesh, surfaces } = buildTile(nb, tileKey(s, cx, cz, q), tpc);
  const probs: string[] = [];
  const bufs: [string, MeshBuffers | null][] = [['shell', mesh.shell], ['decals', mesh.decals], ['water', mesh.water]];
  for (const [n, m] of bufs) if (m) probs.push(...meshProblems(m, `${label} ${n}`));
  expect(probs).toEqual([]);
  // charts: inside the atlas, no overlap (including the LM_PAD gutters)
  const W = surfaces.atlasW, H = surfaces.atlasH;
  expect(W).toBe(LM_ATLAS_W);
  expect([256, 512, 768, 1024]).toContain(H);
  for (const c of surfaces.charts) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(W);
    expect(c.y + c.h).toBeLessThanOrEqual(H);
    expect(c.w).toBeGreaterThanOrEqual(4); // at least 2x2 plus the apron
    expect(c.h).toBeGreaterThanOrEqual(4);
  }
  const padded: Chart[] = surfaces.charts.map((c) => ({ ...c, w: c.w + LM_PAD, h: c.h + LM_PAD }));
  expect(chartOverlaps(padded)).toEqual([]);
  // every lmUv lies inside some chart rect (its own or a borrowed one)
  for (const [, m] of bufs) {
    if (!m) continue;
    for (let v = 0; v < m.vertexCount; v++) {
      const u = m.lmUv[v * 2] * W, w = m.lmUv[v * 2 + 1] * H;
      let inside = false;
      for (const c of surfaces.charts) if (u >= c.x - 1e-3 && u <= c.x + c.w + 1e-3 && w >= c.y - 1e-3 && w <= c.y + c.h + 1e-3) { inside = true; break; }
      if (!inside) throw new Error(`${label}: lmUv (${u.toFixed(2)}, ${w.toFixed(2)}) of vertex ${v} is outside every chart`);
    }
  }
  return { tris: mesh.shell.indexCount / 3, surfaces };
}

describe('mesh buffers', () => {
  test('ASCII fixtures (maze, blockers, pits, mixed edge kinds), both densities', () => {
    const fx: [string, LayoutNeighborhood][] = [['maze', mazeNb()], ['blocker', blockerNb()], ['pit', pitNb()], ['mix', mixNb()]];
    for (const [name, nb] of fx) {
      for (const tpc of LM_TPC_ALLOWED) for (let q = 0; q < 4; q++) checkTile(nb, 0, 0, 0, q, tpc, `${name} q${q} tpc${tpc}`);
    }
  });

  test('generated chunks of every zone: valid buffers and the 120k triangle cap at tpc 12', () => {
    const counts: string[] = [];
    for (let z = 0; z < ZONE_COUNT; z++) {
      const s = storeyOf(z);
      let max = 0;
      for (const [cx, cz] of [[0, 0], [3, -2]]) {
        const nb = genNb(7, s, cx, cz, z as ZoneId);
        for (let q = 0; q < 4; q++) {
          const { tris } = checkTile(nb, s, cx, cz, q, 12, `${ZONE_NAMES[z]} ${cx},${cz} q${q}`);
          expect(tris).toBeLessThanOrEqual(120000);
          max = Math.max(max, tris);
        }
      }
      counts.push(`${ZONE_NAMES[z]} ${max}`);
    }
    console.log(`max shell triangles per tile: ${counts.join(', ')}`);
  });

  test('every own-chart lmUv lies inside its own chart (not only some chart)', () => {
    const nb = mixNb();
    for (let q = 0; q < 4; q++) {
      const tp = planTile(nb, tileKey(0, 0, 0, q), 12);
      for (const f of tp.plan.faces) {
        const s = faceSpec(f);
        if (!s || !f.own || f.from || s.grid) continue;
        const lm = f.lm ?? f.p;
        for (let i = 0; i < lm.length; i += 3) {
          const dx = lm[i] - s.o[0], dy = lm[i + 1] - s.o[1], dz = lm[i + 2] - s.o[2];
          const tu = (dx * s.eu[0] + dy * s.eu[1] + dz * s.eu[2] - s.uBase) / s.tex + 1;
          const tv = (dx * s.ev[0] + dy * s.ev[1] + dz * s.ev[2] - s.vBase) / s.tex + 1;
          expect(tu).toBeGreaterThanOrEqual(1 - 1e-6);
          expect(tv).toBeGreaterThanOrEqual(1 - 1e-6);
          expect(tu).toBeLessThanOrEqual(s.w - 1 + 1e-6);
          expect(tv).toBeLessThanOrEqual(s.h - 1 + 1e-6);
        }
      }
    }
  });
});

/** Vertices whose lmUv, pushed back through the CONTRACT chart (origin + s*axisU + t*axisV), does not land on the
 * vertex itself: checked for every vertex lying on the plane of a non-grid, non-RAMP chart with the same normal (own
 * faces and coplanar borrowers; trims etc. sit off the plane and are skipped). */
function backProjectionErrors(m: MeshBuffers, surfaces: SurfaceSet, label: string): string[] {
  const bad: string[] = [];
  const W = surfaces.atlasW, H = surfaces.atlasH;
  let checked = 0;
  for (let v = 0; v < m.vertexCount && bad.length < 10; v++) {
    const ax = m.lmUv[v * 2] * W, ay = m.lmUv[v * 2 + 1] * H;
    const nx = m.normal[v * 4] / 127, ny = m.normal[v * 4 + 1] / 127, nz = m.normal[v * 4 + 2] / 127;
    const P = [m.position[v * 3], m.position[v * 3 + 1], m.position[v * 3 + 2]];
    for (const c of surfaces.charts) {
      if (c.kind === ChartKind.FLOOR_GRID || c.kind === ChartKind.CEIL_GRID || c.kind === ChartKind.RAMP) continue;
      if (ax < c.x - 1e-3 || ax > c.x + c.w + 1e-3 || ay < c.y - 1e-3 || ay > c.y + c.h + 1e-3) continue;
      if (nx * c.normal[0] + ny * c.normal[1] + nz * c.normal[2] < 0.99) continue;
      const s = ax - c.x, t = ay - c.y;
      const d = [0, 1, 2].map((i) => P[i] - (c.origin[i] + s * c.axisU[i] + t * c.axisV[i]));
      const dn = d[0] * c.normal[0] + d[1] * c.normal[1] + d[2] * c.normal[2];
      if (Math.abs(dn) > 1e-4) continue; // not on the chart plane (trim, plinth, frame)
      checked++;
      const ex = d[0] - dn * c.normal[0], ey = d[1] - dn * c.normal[1], ez = d[2] - dn * c.normal[2];
      // vertical faces reaching a TILES ceiling are extended 10 mm up to the tile back and sample the chart's top row
      // there (walls.ts ceilExt / clampLmTop): a purely vertical offset of up to 1 cm above the mapped point is fine
      const ext = Math.abs(c.normal[1]) < 0.01 && Math.hypot(ex, ez) < 1e-3 && ey > 0 && ey <= 0.0101;
      const e = ext ? 0 : Math.hypot(ex, ey, ez);
      if (e > 1e-3) bad.push(`${label}: vertex ${v} at ${P.map((x) => x.toFixed(3))} maps to chart ${c.id} (kind ${c.kind}) ${e.toFixed(4)} m away`);
    }
  }
  if (checked === 0) bad.push(`${label}: no vertex checked`);
  return bad;
}

describe('lightmap uv back-projection', () => {
  test('lmUv through the contract Chart (origin/axes) lands on the vertex (fixtures + generated zones, both densities)', () => {
    const cases: [string, LayoutNeighborhood, StoreyId, number, number][] = [
      ['mix', mixNb(), 0, 0, 0], ['pit', pitNb(), 0, 0, 0], ['blocker', blockerNb(), 0, 0, 0],
      ['lobby', genNb(1, 0, 0, 0, Zone.LOBBY), 0, 0, 0], ['office', genNb(5, 0, 1, 0, Zone.OFFICE), 0, 1, 0],
      ['pool', genNb(5, 2, 0, 1, Zone.POOLROOMS), 2, 0, 1],
    ];
    for (const [name, nb, s, cx, cz] of cases) {
      for (const tpc of LM_TPC_ALLOWED) {
        for (let q = 0; q < 4; q++) {
          const { mesh, surfaces } = buildTile(nb, tileKey(s, cx, cz, q), tpc);
          expect(backProjectionErrors(mesh.shell, surfaces, `${name} q${q} tpc${tpc}`)).toEqual([]);
        }
      }
    }
  });
});

describe('lightmap texel invariants', () => {
  test('lmTexel(tpc) <= WALL_T and every occluding kind is at least one texel thick at floor level', () => {
    for (const tpc of LM_TPC_ALLOWED) {
      expect(lmTexel(tpc)).toBeLessThanOrEqual(WALL_T + 1e-12);
      for (let k = 0; k < EDGE_OCCLUDES.length; k++) if (EDGE_OCCLUDES[k]) expect(edgeBaseThickness(k)).toBeGreaterThanOrEqual(lmTexel(tpc) - 1e-12);
    }
  });

  test('grid charts: texel boundaries fall on cell (wall) lines, 1-texel true-value apron', () => {
    const nb = mazeNb();
    for (const tpc of LM_TPC_ALLOWED) {
      const { surfaces } = buildTile(nb, tileKey(0, 0, 0, 1), tpc);
      const t = lmTexel(tpc), S = 16 * tpc + 2;
      const grids = surfaces.charts.filter((c) => c.kind === ChartKind.FLOOR_GRID || c.kind === ChartKind.CEIL_GRID);
      expect(grids.length).toBe(2);
      expect(surfaces.charts[0].kind).toBe(ChartKind.FLOOR_GRID);
      expect(surfaces.charts[1].kind).toBe(ChartKind.CEIL_GRID);
      expect([surfaces.charts[0].x, surfaces.charts[0].y]).toEqual([0, 0]);
      expect([surfaces.charts[1].x, surfaces.charts[1].y]).toEqual([S + 2 * LM_PAD, 0]);
      for (const g of grids) {
        expect(g.w).toBe(S);
        expect(g.h).toBe(S);
        expect(g.cont).toBe(15);
        expect(g.axisU[0]).toBeCloseTo(t, 9);
        expect(g.axisV[2]).toBeCloseTo(t, 9);
        // texel boundary u (between texel u-1 and u) at x = origin + u*t; cell line x = k*CELL at u = k*tpc + 1
        for (let k = 0; k <= 16; k++) {
          const u = k * tpc + 1;
          expect(g.origin[0] + u * g.axisU[0]).toBeCloseTo(k * CELL, 9);
          expect(g.origin[2] + u * g.axisV[2]).toBeCloseTo(k * CELL, 9);
        }
      }
    }
  });

  test('wall charts: texel rows are integral per 3 m and u is snapped to the world texel grid', () => {
    const nb = mixNb();
    const { surfaces } = buildTile(nb, tileKey(0, 0, 0, 0), 12);
    const t = lmTexel(12);
    for (const c of surfaces.charts) {
      if (c.kind !== ChartKind.WALL) continue;
      expect(Math.hypot(...c.axisU)).toBeCloseTo(t, 6);
      expect(c.axisV).toEqual([0, t, 0].map((v) => Math.round(v * 1e9) / 1e9));
      expect(3 / t).toBeCloseTo(Math.round(3 / t), 9);
      // u origin on the texel grid of the tile (run continuity across tiles)
      const along = Math.abs(c.axisU[0]) > 0 ? c.origin[0] : c.origin[2];
      expect(Math.abs(along / t - Math.round(along / t))).toBeLessThan(1e-6);
    }
  });
});
