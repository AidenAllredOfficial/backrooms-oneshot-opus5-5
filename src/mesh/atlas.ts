// src/mesh/atlas.ts — lightmap atlas layout (§5 WP5 rule 12). Pure module.
// FLOOR_GRID at (0, 0), CEIL_GRID at (S + 2*PAD, 0) with S = 16*tpc + 2. Every other chart is shelf-packed in the
// order (h desc, w desc, id asc) with LM_PAD gutters: first into the strip right of the grids (rows [0, S)), then
// into full-width shelves below the grids. Height = the smallest of {256, 512, 768, 1024} that fits. Overflow:
// repeatedly halve the texel density (double axisU/axisV) of the largest non-grid chart with bakeGroup 0 until the
// charts fit; grid and tower/elevator charts (bakeGroup != 0) never change.

import { LM_ATLAS_W, LM_PAD, lmTexel, type LmTpc } from '../core/constants.ts';
import { specDims, type ChartSpec } from './plan.ts';

export const ATLAS_HEIGHTS = [256, 512, 768, 1024] as const;
const MAX_H = ATLAS_HEIGHTS[ATLAS_HEIGHTS.length - 1];

interface Shelf { x1: number; y: number; h: number; cur: number }

/** Shelf-pack the non-grid charts; returns the used height (Infinity if a chart is wider than the atlas). */
function tryPack(list: ChartSpec[], S: number): number {
  const W = LM_ATLAS_W, PAD = LM_PAD;
  const order = list.slice().sort((a, b) => b.h - a.h || b.w - a.w || a.id - b.id);
  const shelves: Shelf[] = [];
  const ax0 = 2 * S + 3 * PAD; // region A: right of the grids, rows [0, S)
  let aY = 0, bY = S + PAD; // next free shelf y in region A / region B
  let used = S;
  for (const c of order) {
    let placed = false;
    for (const sh of shelves) {
      if (c.h <= sh.h && sh.cur + c.w <= sh.x1) {
        c.x = sh.cur; c.y = sh.y; sh.cur += c.w + PAD; placed = true; break;
      }
    }
    if (placed) continue;
    if (c.w > W) return Infinity;
    let sh: Shelf;
    if (ax0 + c.w <= W && aY + c.h <= S) { sh = { x1: W, y: aY, h: c.h, cur: ax0 }; aY += c.h + PAD; }
    else { sh = { x1: W, y: bY, h: c.h, cur: 0 }; bY += c.h + PAD; }
    shelves.push(sh);
    c.x = sh.cur; c.y = sh.y; sh.cur += c.w + PAD;
    used = Math.max(used, c.y + c.h);
  }
  return used;
}

/** Place every chart; returns the atlas height. Mutates x/y (and halv/w/h on overflow). */
export function packAtlas(specs: ChartSpec[], tpc: LmTpc): number {
  const S = 16 * tpc + 2;
  const t = lmTexel(tpc);
  const others: ChartSpec[] = [];
  for (const s of specs) {
    if (s.grid === 1) { s.x = 0; s.y = 0; }
    else if (s.grid === 2) { s.x = S + 2 * LM_PAD; s.y = 0; }
    else others.push(s);
  }
  for (let iter = 0; iter < 100000; iter++) {
    const used = tryPack(others, S);
    if (used <= MAX_H) {
      for (const h of ATLAS_HEIGHTS) if (used <= h) return h;
    }
    let victim: ChartSpec | null = null;
    for (const s of others) {
      if (!s.halvable || (s.w <= 4 && s.h <= 4)) continue;
      if (!victim || s.w * s.h > victim.w * victim.h || (s.w * s.h === victim.w * victim.h && s.id < victim.id)) victim = s;
    }
    if (!victim) throw new Error(`atlas overflow: ${others.length} charts do not fit ${LM_ATLAS_W}x${MAX_H} at tpc ${tpc}`);
    victim.halv++;
    specDims(victim, t);
  }
  throw new Error('atlas: packing did not converge');
}
