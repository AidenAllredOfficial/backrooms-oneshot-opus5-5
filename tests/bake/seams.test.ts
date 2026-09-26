// tests/bake/seams.test.ts — WP7 acceptance: two adjacent tiles baked independently (fresh caches), in the same
// chunk and across a chunk seam, agree on their shared border texels (the 1-texel grid-chart aprons) within 2%.
// Run on LOBBY and the open zones where probe rays and light sets reach farthest. Wall charts split at a tile line
// (chart `cont` bits) share their apron texels too: those are matched by world position and compared as well.

import { describe, expect, it } from 'vitest';
import { fromHalf } from '../../src/core/half.ts';
import { Zone, ZONE_NAMES, type ZoneId } from '../../src/core/ids.ts';
import { ChartKind, type Chart, type LightmapData, type SurfaceSet } from '../../src/core/mesh.ts';
import { tileOriginX, tileOriginZ, type TileKey } from '../../src/core/grid.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { bakeTile, createBakeCache } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID, type TexelSet } from '../../src/bake/context.ts';
import { createJob } from '../../src/bake/job.ts';
import { Q_HIGH, findChart, surfacesOf, zoneNeighborhood } from './helpers.ts';

const TPC = 12;
const SIDE = 16 * TPC + 2;

interface Side { lm: LightmapData; s: SurfaceSet; valid: Uint8Array; T: TexelSet; tile: TileKey }
function bakeSide(nb: LayoutNeighborhood, tile: TileKey): Side {
  const s = surfacesOf(nb, tile, TPC);
  const lm = bakeTile(nb, tile, s, 'full', Q_HIGH, 'all', createBakeCache());
  const T = setupTexels(createJob(nb, tile, Q_HIGH, null), s);
  const valid = new Uint8Array(s.atlasW * s.atlasH);
  for (let t = 0; t < T.n; t++) if (T.state[t] === TX_VALID) valid[T.atlas[t]] = 1;
  return { lm, s, valid, T, tile };
}

/** Shared (seam) texels of the non-grid charts keyed by world texel-centre position, normal and bake group. */
function wallSeamTexels(a: Side): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const ox = tileOriginX(a.tile), oz = tileOriginZ(a.tile);
  for (let t = 0; t < a.T.n; t++) {
    if (a.T.state[t] !== TX_VALID || a.T.seam[t] === 0) continue;
    const ch = a.s.charts[a.T.chart[t]];
    if (ch.kind === ChartKind.FLOOR_GRID || ch.kind === ChartKind.CEIL_GRID) continue;
    const u = a.T.u[t] + 0.5, v = a.T.v[t] + 0.5;
    const x = ch.origin[0] + u * ch.axisU[0] + v * ch.axisV[0] + ox;
    const y = ch.origin[1] + u * ch.axisU[1] + v * ch.axisV[1];
    const z = ch.origin[2] + u * ch.axisU[2] + v * ch.axisV[2] + oz;
    const key = [x, y, z].map((c) => Math.round(c * 1000)).join(',') + '|' + ch.normal.map((c) => Math.round(c * 100)).join(',') + '|' + ch.bakeGroup;
    const o = a.T.atlas[t] * 4;
    out.set(key, [fromHalf(a.lm.irr[o]), fromHalf(a.lm.irr[o + 1]), fromHalf(a.lm.irr[o + 2])]);
  }
  return out;
}
function compareWalls(a: Side, b: Side): { n: number; worst: number } {
  const ma = wallSeamTexels(a), mb = wallSeamTexels(b);
  let n = 0, worst = 0;
  for (const [k, va] of ma) {
    const vb = mb.get(k);
    if (!vb) continue;
    for (let c = 0; c < 3; c++) {
      const m = Math.max(va[c], vb[c]);
      if (m < 0.5) continue;
      n++;
      worst = Math.max(worst, Math.abs(va[c] - vb[c]) / m);
    }
  }
  return { n, worst };
}
/** Zones whose seed-1 layouts have wall runs crossing the q0 | q1 tile line (checked to be non-empty). */
const WALL_SEAM_ZONES: ZoneId[] = [Zone.LOBBY, Zone.WAREHOUSE];

/** Compare the shared border columns (east apron of A / first columns of B) of one grid chart kind. */
function compareX(a: Side, b: Side, kind: number): { n: number; worst: number; mask: number } {
  const ca: Chart = findChart(a.s, kind), cb: Chart = findChart(b.s, kind);
  let n = 0, worst = 0, mask = 0;
  // A's u = 16 tpc (last interior) and 16 tpc + 1 (apron) are B's u = 0 (apron) and 1 (first interior)
  for (const [ua, ub] of [[SIDE - 2, 0], [SIDE - 1, 1]]) {
    for (let v = 0; v < SIDE; v++) {
      const ia = (ca.y + v) * a.lm.width + ca.x + ua, ib = (cb.y + v) * b.lm.width + cb.x + ub;
      if (!a.valid[ia] || !b.valid[ib]) continue;
      for (let k = 0; k < 4; k++) mask = Math.max(mask, Math.abs(a.lm.mask[ia * 4 + k] - b.lm.mask[ib * 4 + k]));
      for (let k = 0; k < 3; k++) {
        const x = fromHalf(a.lm.irr[ia * 4 + k]), y = fromHalf(b.lm.irr[ib * 4 + k]);
        const m = Math.max(x, y);
        const d = Math.abs(x - y);
        if (m < 0.5) continue; // imperceptible (< 0.5 lux)
        n++;
        worst = Math.max(worst, d / m);
      }
    }
  }
  return { n, worst, mask };
}

const ZONES: ZoneId[] = [Zone.LOBBY, Zone.LOW_EXPANSE, Zone.PILLAR_HALL, Zone.WAREHOUSE];

describe('tile seams', () => {
  for (const zone of ZONES) {
    it(`${ZONE_NAMES[zone]}: same chunk (q0 | q1) and across a chunk seam (cx 0 q1 | cx 1 q0)`, () => {
      const nb0 = zoneNeighborhood(zone, 0, 0);
      const nb1 = zoneNeighborhood(zone, 1, 0);
      const t00 = bakeSide(nb0, { s: 0, cx: 0, cz: 0, q: 0 });
      const t01 = bakeSide(nb0, { s: 0, cx: 0, cz: 0, q: 1 });
      const t10 = bakeSide(nb1, { s: 0, cx: 1, cz: 0, q: 0 });
      for (const [a, b, label] of [[t00, t01, 'in-chunk'], [t01, t10, 'chunk seam']] as const) {
        for (const kind of [ChartKind.FLOOR_GRID, ChartKind.CEIL_GRID]) {
          const r = compareX(a, b, kind);
          if (kind === ChartKind.FLOOR_GRID) expect(r.n, `${label}: compared floor texels`).toBeGreaterThan(50);
          expect(r.worst, `${label} kind ${kind}: worst relative difference`).toBeLessThan(0.02);
          expect(r.mask, `${label} kind ${kind}: surface mask difference`).toBeLessThanOrEqual(1);
        }
        const w = compareWalls(a, b);
        if (label === 'in-chunk' && WALL_SEAM_ZONES.includes(zone)) expect(w.n, `${label}: compared wall seam texels`).toBeGreaterThan(50);
        expect(w.worst, `${label}: wall seam worst relative difference`).toBeLessThan(0.02);
      }
    }, 300_000);
  }
});
