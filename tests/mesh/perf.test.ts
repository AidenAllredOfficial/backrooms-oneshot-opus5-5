// tests/mesh/perf.test.ts — WP5 acceptance: build takes <= 20 ms per tile, excluding props (median over warm runs in
// the densest zones at tpc 12). Timing is informational under heavy machine load: the assertion uses the median.

import { expect, test, vi } from 'vitest';
import { Zone, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { buildTile } from '../../src/mesh/buildTile.ts';
import { buildTileProps } from '../../src/props/tileProps.ts';
import { genNb, tileKey } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000 }); // heavy generation + meshing under shared-machine load

test('buildTile (excluding props) median <= 20 ms per tile at tpc 12', { tags: ['sweep'] }, () => {
  const cases: [ZoneId, StoreyId][] = [[Zone.OFFICE, 0], [Zone.LOBBY, 0], [Zone.MAZE, 0], [Zone.DARK, 0], [Zone.POOLROOMS, 2], [Zone.WAREHOUSE, 1], [Zone.PIPEWORKS, 1]];
  const nbs = cases.map(([z, s]) => ({ nb: genNb(13, s, 0, 0, z), s }));
  // warm-up (JIT)
  for (const { nb, s } of nbs) for (let q = 0; q < 4; q++) buildTile(nb, tileKey(s, 0, 0, q), 12);
  const ms: number[] = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const { nb, s } of nbs) {
      for (let q = 0; q < 4; q++) {
        const key = tileKey(s, 0, 0, q);
        const a = performance.now();
        buildTile(nb, key, 12);
        const b = performance.now();
        buildTileProps(nb, key);
        const c = performance.now();
        ms.push(Math.max(0, (b - a) - (c - b)));
      }
    }
  }
  ms.sort((x, y) => x - y);
  const median = ms[ms.length >> 1], p90 = ms[Math.floor(ms.length * 0.9)];
  console.log(`buildTile excl. props: median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms over ${ms.length} tiles`);
  expect(median).toBeLessThanOrEqual(20);
});
