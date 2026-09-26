// src/world/structures/windows.ts — R2 "windows to nowhere" (LOBBY / OFFICE generate()).
//
// A straight run of >= 4 WALL edges is thickened into an outer wall: the strip of cells behind it (side B) becomes
// SOLID mass (WALL-wrapped like a thick block) — only if that keeps every walkable cell reachable from the ports.
// Pier / window / window / pier ...: the window edges become WINDOW (sill 95, head 200) and each is backed by a
// frosted panel glowing like overcast daylight: a RECT fixture at 6500 K, 800-1500 nits, whose flat emissive lens
// sits 4 cm inside the reveal (FixtureKind.SODIUM geometry: lens + a shallow housing that disappears into the solid
// strip), with venetian slats (thin box solids) in front of the upper part on some. Pure module.

import { CELL, WALL_T } from '../../core/constants.ts';
import { cellIdx } from '../../core/grid.ts';
import { CellFlag, EdgeKind, EdgeTrim, FixtureKind, Mat, type MatId } from '../../core/ids.ts';
import type { Rng } from '../../core/rng.ts';
import type { ZoneGenContext } from '../../core/world.ts';
import { portCells } from '../connectivity.ts';
import { addCustomFixtureUnique } from '../zones/l0common.ts';
import { DECO_FLAGS, edgeKindAt, N, plainCell, propsInRect, putEdge, restore, snapshot, solidsInRect, unreachedWalkable } from './util.ts';

export const WINDOW_SILL = 95, WINDOW_HEAD = 200;
export interface WindowRun { axis: 'x' | 'z'; line: number; c0: number; c1: number; side: -1 | 1; windows: number }

/** Tries to build one window wall in the chunk. `pick` orders candidate runs (lower first; e.g. distance to a
 * district boundary). Returns the run or null. */
export function windowWall(ctx: ZoneGenContext, rng: Rng, busy: Uint8Array | null, wallMat: MatId, pick?: (axis: 'x' | 'z', line: number, c0: number, c1: number) => number): WindowRun | null {
  const g = ctx.grid, l = g.layout;
  const ports = new Uint8Array(N * N);
  for (const c of portCells(l)) ports[c] = 1;
  const cands: { axis: 'x' | 'z'; line: number; c0: number; c1: number; score: number }[] = [];
  for (const axis of ['x', 'z'] as const) {
    for (let line = 2; line < N - 1; line++) {
      let c = 0;
      while (c < N) {
        if (edgeKindAt(l, axis, axis === 'x' ? line : c, axis === 'x' ? c : line) !== EdgeKind.WALL || g.isFrozenEdge(axis, axis === 'x' ? line : c, axis === 'x' ? c : line)) { c++; continue; }
        let d = c;
        while (d < N && edgeKindAt(l, axis, axis === 'x' ? line : d, axis === 'x' ? d : line) === EdgeKind.WALL) d++;
        if (d - c >= 4) cands.push({ axis, line, c0: c, c1: Math.min(d, c + 7), score: pick ? pick(axis, line, c, d) : rng.float() });
        c = d;
      }
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.score - b.score || a.line - b.line || a.c0 - b.c0);
  const seen = new Uint8Array(N * N);
  const base0 = unreachedWalkable(l, seen);
  let tries = 0;
  for (const cd of cands) {
    if (tries++ >= 5) break;
    for (const side of (rng.chance(0.5) ? [-1, 1] : [1, -1]) as (-1 | 1)[]) {
      // strip cells on side B (the solid backing) and the room cells on side A
      const ok = (() => {
        for (let c = cd.c0; c < cd.c1; c++) {
          const bi = cd.axis === 'x' ? (side < 0 ? cd.line - 1 : cd.line) : c, bj = cd.axis === 'x' ? c : (side < 0 ? cd.line - 1 : cd.line);
          const ai = cd.axis === 'x' ? (side < 0 ? cd.line : cd.line - 1) : c, aj = cd.axis === 'x' ? c : (side < 0 ? cd.line : cd.line - 1);
          if (!plainCell(g, bi, bj) || !plainCell(g, ai, aj)) return false;
          if (ports[cellIdx(bi, bj)] || (busy && (busy[cellIdx(bi, bj)] || busy[cellIdx(ai, aj)]))) return false;
          if (l.floorCm[cellIdx(bi, bj)] !== l.floorCm[cellIdx(ai, aj)]) return false;
          if (l.ceilCm[cellIdx(ai, aj)] - l.floorCm[cellIdx(ai, aj)] < WINDOW_HEAD + 20) return false;
          if (solidsInRect(l, bi, bj, bi + 1, bj + 1) || propsInRect(l, bi, bj, bi + 1, bj + 1)) return false;
        }
        return true;
      })();
      if (!ok) continue;
      const snap = snapshot(l);
      const strip: [number, number][] = [];
      for (let c = cd.c0; c < cd.c1; c++) {
        const bi = cd.axis === 'x' ? (side < 0 ? cd.line - 1 : cd.line) : c, bj = cd.axis === 'x' ? c : (side < 0 ? cd.line - 1 : cd.line);
        strip.push([bi, bj]);
        g.setCells(bi, bj, bi + 1, bj + 1, { flagsSet: CellFlag.SOLID, flagsClear: CellFlag.WET });
      }
      const inStrip = (a: number, b: number): boolean => strip.some(([x, y]) => x === a && y === b);
      for (const [bi, bj] of strip) {
        if (!inStrip(bi - 1, bj)) putEdge(g, 'x', bi, bj, EdgeKind.WALL);
        if (!inStrip(bi + 1, bj)) putEdge(g, 'x', bi + 1, bj, EdgeKind.WALL);
        if (!inStrip(bi, bj - 1)) putEdge(g, 'z', bi, bj, EdgeKind.WALL);
        if (!inStrip(bi, bj + 1)) putEdge(g, 'z', bi, bj + 1, EdgeKind.WALL);
      }
      if (unreachedWalkable(l, seen) > base0) { restore(l, snap); continue; }
      // windows: pier, then pairs of windows separated by single piers
      let windows = 0;
      const blinds = rng.chance(0.5);
      const lum = rng.range(800, 1500);
      for (let c = cd.c0 + 1; c < cd.c1 - 1; c++) {
        if ((c - cd.c0) % 3 === 0) continue;
        const i = cd.axis === 'x' ? cd.line : c, j = cd.axis === 'x' ? c : cd.line;
        putEdge(g, cd.axis, i, j, EdgeKind.WINDOW, { hA: WINDOW_SILL, hB: WINDOW_HEAD, matNeg: wallMat, matPos: wallMat, trim: EdgeTrim.BASEBOARD });
        glowPanel(ctx, cd.axis, cd.line, c, -side as -1 | 1, lum, blinds, rng);
        windows++;
      }
      if (windows === 0) { restore(l, snap); continue; }
      return { axis: cd.axis, line: cd.line, c0: cd.c0, c1: cd.c1, side, windows };
    }
  }
  return null;
}

/** The frosted daylight panel of a WINDOW edge on `line`, cell `c`, glowing toward `into` (the room side). */
function glowPanel(ctx: ZoneGenContext, axis: 'x' | 'z', line: number, c: number, into: -1 | 1, lum: number, blinds: boolean, rng: Rng): void {
  const g = ctx.grid;
  const lineM = line * CELL, mid = (c + 0.5) * CELL;
  const off = into * (WALL_T / 2 - 0.04); // 4 cm inside the reveal
  const y = (WINDOW_SILL + WINDOW_HEAD) / 200;
  const x = axis === 'x' ? lineM + off : mid, z = axis === 'x' ? mid : lineM + off;
  addCustomFixtureUnique(ctx, {
    kind: FixtureKind.SODIUM, x, y, z,
    nx: axis === 'x' ? into : 0, ny: 0, nz: axis === 'x' ? 0 : into,
    tx: axis === 'x' ? 0 : 1, ty: 0, tz: axis === 'x' ? 1 : 0,
    w: CELL - 0.12, h: (WINDOW_HEAD - WINDOW_SILL) / 100 - 0.06, cct0: 6300, cct1: 6800, luminance: lum, hum: 0,
  });
  if (!blinds) return;
  // venetian slats over the upper part, 2 cm in front of the lens (dark silhouettes against the glow)
  const drop = rng.range(0.25, 0.7); // lowered part of the blind (fraction of the window height)
  const top = WINDOW_HEAD / 100 - 0.04, bottom = top - drop * ((WINDOW_HEAD - WINDOW_SILL) / 100 - 0.08);
  const sN = lineM + into * (WALL_T / 2 - 0.02);
  const half = CELL / 2 - 0.08;
  // slats 3 cm tall on a 5 cm pitch (a half-tilted blind seen from the room: dark bands with bright slits between;
  // hairline 4 mm slats read as drawn lines, not a blind)
  for (let yy = top - 0.01; yy - 0.03 > bottom; yy -= 0.05) {
    const a0 = mid - half, a1 = mid + half;
    const n0 = Math.min(sN, sN + into * 0.012), n1 = Math.max(sN, sN + into * 0.012);
    g.addSolid({
      kind: 'box', min: axis === 'x' ? [n0, yy - 0.03, a0] : [a0, yy - 0.03, n0], max: axis === 'x' ? [n1, yy, a1] : [a1, yy, n1],
      mat: Mat.PLASTIC, flags: DECO_FLAGS, bakeGroup: 0,
    });
  }
}
