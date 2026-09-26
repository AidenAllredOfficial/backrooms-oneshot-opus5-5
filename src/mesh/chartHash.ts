// src/mesh/chartHash.ts — deterministic hash of a tile's chart list (§5 WP5 rule 13). Build and bake MUST agree.
// Pure module (no three/DOM).

import type { Chart } from '../core/mesh.ts';

const q = (v: number): number => Math.round(v * 1e5) | 0;

/** FNV over (kind, x, y, w, h, origin, axes quantized to 1e-5, cont, bakeGroup) of every chart, in order. */
export function chartHash(charts: readonly Chart[]): number {
  let h = 0x811c9dc5;
  const word = (v: number): void => {
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (i * 8)) & 255;
      h = Math.imul(h, 0x01000193);
    }
  };
  word(charts.length);
  for (const c of charts) {
    word(c.kind); word(c.x); word(c.y); word(c.w); word(c.h);
    for (const v of c.origin) word(q(v));
    for (const v of c.axisU) word(q(v));
    for (const v of c.axisV) word(q(v));
    word(c.cont);
    word(c.bakeGroup >>> 0);
    word(Math.floor(c.bakeGroup / 4294967296) >>> 0);
  }
  return h >>> 0;
}
