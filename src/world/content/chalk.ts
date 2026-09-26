// src/world/content/chalk.ts — chalk arrows at junctions (WP4).
//
// Junction cells (>= 3 passable sides, and a corridor-like crossing: >= 2 of the 4 diagonal corners unreachable in two
// steps, so open halls are not littered) get a CHALK_ARROW floor decal with p 0.12. 70% of arrows point along the
// passable direction that best leads to the nearest tower exit; the rest point along a random other passable
// direction. rot follows the DecalPlacement floor convention: +v along forwardXZ(rot), rot = atan2(-dx, -dz).

import { CELL } from '../../core/constants.ts';
import { DecalKind, SALT, cellIdx, hash01, hash2, hash5 } from '../../core/index.ts';
import type { ZoneGenContext } from '../../core/index.ts';
import { towerExits } from './signs.ts';
import { canStep, DX, DZ, edgeKindPassable, inChunk, isOpenFloor, N, sideHA, sideKind } from './util.ts';

export const CHALK_P = 0.12;
export const CHALK_TOWER_P = 0.7;
export const CHALK_MAX = 6;
export const CHALK_TOWER_RANGE = 4;

/** Passable sides of a cell (in-chunk steps and walkable seam edges). Bit d set = side d passable. */
export function passableMask(ctx: ZoneGenContext, li: number, lj: number): number {
  const l = ctx.grid.layout;
  let m = 0;
  for (let d = 0; d < 4; d++) {
    const ni = li + DX[d], nj = lj + DZ[d];
    const ok = inChunk(ni, nj) ? canStep(l, li, lj, d) : edgeKindPassable(sideKind(l, li, lj, d), sideHA(l, li, lj, d));
    if (ok) m |= 1 << d;
  }
  return m;
}

/** Junction test: >= 3 passable sides and >= 2 blocked diagonal corners. */
export function isJunction(ctx: ZoneGenContext, li: number, lj: number): boolean {
  const l = ctx.grid.layout;
  const m = passableMask(ctx, li, lj);
  let n = 0;
  for (let d = 0; d < 4; d++) if (m & (1 << d)) n++;
  if (n < 3) return false;
  let blocked = 0;
  for (const a of [0, 1]) {
    for (const b of [2, 3]) {
      const viaA = canStep(l, li, lj, a) && canStep(l, li + DX[a], lj, b);
      const viaB = canStep(l, li, lj, b) && canStep(l, li, lj + DZ[b], a);
      if (!viaA && !viaB) blocked++;
    }
  }
  return blocked >= 2;
}

export function placeChalk(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, s = ctx.key.s;
  const exits = towerExits(ctx, CHALK_TOWER_RANGE);
  // candidates first, then the CHALK_MAX with the lowest hash (a cap in scan order would favour the chunk's -z rows)
  const cand: { c: number; h: number }[] = [];
  for (let c = 0; c < N * N; c++) {
    if (!isOpenFloor(l, c)) continue;
    const li = c & 31, lj = c >> 5;
    const h = hash5(ctx.seed, SALT.CHALK, s, g.gi0 + li, g.gj0 + lj);
    if (hash01(h) >= CHALK_P) continue;
    if (!isJunction(ctx, li, lj)) continue;
    cand.push({ c, h });
  }
  if (cand.length > CHALK_MAX) {
    cand.sort((a, b) => a.h - b.h || a.c - b.c);
    cand.length = CHALK_MAX;
    cand.sort((a, b) => a.c - b.c);
  }
  for (const { c, h } of cand) {
    const li = c & 31, lj = c >> 5;
    const m = passableMask(ctx, li, lj);
    const dirs: number[] = [];
    for (let d = 0; d < 4; d++) if (m & (1 << d)) dirs.push(d);
    const cx = (li + 0.5) * CELL, cz = (lj + 0.5) * CELL;
    let towerDir = -1;
    if (exits.length > 0) {
      let bd = Infinity, tx = 0, tz = 0;
      for (const e of exits) {
        const d2 = (e[0] - cx) * (e[0] - cx) + (e[1] - cz) * (e[1] - cz);
        if (d2 < bd) { bd = d2; tx = e[0] - cx; tz = e[1] - cz; }
      }
      let best = -Infinity;
      for (const d of dirs) {
        const dot = DX[d] * tx + DZ[d] * tz;
        if (dot > best) { best = dot; towerDir = d; }
      }
    }
    let dir: number;
    if (towerDir >= 0 && hash01(hash2(h, 1)) < CHALK_TOWER_P) dir = towerDir;
    else {
      const others = dirs.filter((d) => d !== towerDir);
      dir = others.length > 0 ? others[Math.floor(hash01(hash2(h, 2)) * others.length)] : dirs[0];
    }
    const dx = DX[dir], dz = DZ[dir];
    const jx = (hash01(hash2(h, 3)) - 0.5) * 0.3, jz = (hash01(hash2(h, 4)) - 0.5) * 0.3;
    g.addDecal({
      kind: DecalKind.CHALK_ARROW, sign: false, px: cx + jx, py: l.floorCm[cellIdx(li, lj)] / 100, pz: cz + jz,
      nx: 0, ny: 1, nz: 0, rot: Math.atan2(-dx, -dz) + (hash01(hash2(h, 5)) - 0.5) * 0.15, w: 0.55, h: 0.55, alpha: 0.8,
    });
  }
}
