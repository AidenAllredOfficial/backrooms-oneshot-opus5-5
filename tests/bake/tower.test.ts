// tests/bake/tower.test.ts — WP7 acceptance: periodic stair-tower lighting. Texels at y and y + 3 m on tower walls
// agree within 1e-3 relative (the tower bakes with its own isolated group and a periodically replicated light
// and occluder set).

import { describe, expect, it } from 'vitest';
import { STOREY_PITCH } from '../../src/core/constants.ts';
import { fromHalf } from '../../src/core/half.ts';
import type { TileKey } from '../../src/core/grid.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID } from '../../src/bake/context.ts';
import { createJob } from '../../src/bake/job.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { testSceneChunk } from '../../src/world/testScenes.ts';
import { Q_HIGH, surfacesOf } from './helpers.ts';

describe('tower periodicity', () => {
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ls.push(testSceneChunk('tower', { s: 0, cx: dx, cz: dz }, 1));
  const nb = makeNeighborhood(ls);
  const tile: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

  for (const variant of ['full', 'preview'] as const) {
    it(`tower wall texels at y and y + 3 m agree within 1e-3 (${variant})`, () => {
      const s = surfacesOf(nb, tile, 12);
      const walls = s.charts.filter((c) => c.bakeGroup !== 0 && c.kind === ChartKind.WALL && Math.abs(c.axisV[1] - 0.1) < 1e-9);
      expect(walls.length).toBeGreaterThan(0);
      const lm = bakeTile(nb, tile, s, variant, Q_HIGH, 'all');
      const T = setupTexels(createJob(nb, tile, Q_HIGH, null), s);
      const period = Math.round(STOREY_PITCH / 0.1);
      let compared = 0, worst = 0, lit = 0, maskDiff = 0;
      for (const ch of walls) {
        for (let v = 0; v + period < ch.h; v++) {
          const y = ch.origin[1] + (v + 0.5) * ch.axisV[1];
          if (y < -4.5 || y + STOREY_PITCH > 4.5) continue; // stay away from the replicated span's ends
          for (let u = 0; u < ch.w; u++) {
            const ia = (ch.y + v) * s.atlasW + ch.x + u, ib = (ch.y + v + period) * s.atlasW + ch.x + u;
            const ta = T.map[ia], tb = T.map[ib];
            if (ta < 0 || tb < 0 || T.state[ta] !== TX_VALID || T.state[tb] !== TX_VALID) continue;
            for (let k = 0; k < 4; k++) maskDiff = Math.max(maskDiff, Math.abs(lm.mask[ia * 4 + k] - lm.mask[ib * 4 + k]));
            for (let k = 0; k < 3; k++) {
              const a = fromHalf(lm.irr[ia * 4 + k]), b = fromHalf(lm.irr[ib * 4 + k]);
              const m = Math.max(a, b);
              if (m > 1) lit++;
              if (m < 1e-3) continue;
              compared++;
              worst = Math.max(worst, Math.abs(a - b) / m);
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(1000);
      expect(lit).toBeGreaterThan(100);
      expect(worst).toBeLessThan(1e-3);
      expect(maskDiff).toBeLessThanOrEqual(1); // surface mask (grime / peel) is periodic too
    }, 120_000);
  }
});
