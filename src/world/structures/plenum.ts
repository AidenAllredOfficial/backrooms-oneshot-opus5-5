// src/world/structures/plenum.ts — R2 "missing ceiling" stamps called from LOBBY / OFFICE generate():
//   - openCeiling: a patch of cells whose suspended ceiling is gone (CellFlag.NO_CEIL + CeilKind.OPEN_DARK, so no
//     tiles and no lattice fixtures): the cells' ceilCm rises to the structural deck (+75..110 cm), walls run up to
//     it, and the plenum is furnished with solids — a dark deck slab, bar joists, a sheet-metal duct, a pipe or two
//     and dangling cables — lit only by the fixtures below. Fallen tiles lie on the floor underneath;
//   - missingTiles: scattered TileState.MISSING tiles over a rect (the grid stays; each hole shows WP5's plenum box);
//   - removedFixtures: MISSING tiles on the lattice fixture slots of a rect ("fixtures pulled out"): the lattice
//     placer rejects those rects, so the bay falls off into gloom.
// Pure module: no three / DOM / Math.random.

import { CELL, CHUNK_CELLS } from '../../core/constants.ts';
import { cellIdx } from '../../core/grid.ts';
import { CeilKind, CellFlag, Mat, PropKind, TileState } from '../../core/ids.ts';
import { getTile, setTile } from '../../core/layout.ts';
import type { Rng } from '../../core/rng.ts';
import type { ZoneGenContext } from '../../core/world.ts';
import { FIXTURE_DIMS } from '../content/util.ts';
import { DECO_FLAGS, OCC_FLAGS } from './util.ts';

const N = CHUNK_CELLS;

export interface OpenCeilingInfo { cells: number; solids: number }

/** Opens the ceiling over cells [i0,i1) x [j0,j1) (all must be plain, non-reserved cells of one ceiling height). */
export function openCeiling(ctx: ZoneGenContext, i0: number, j0: number, i1: number, j1: number, rng: Rng): OpenCeilingInfo {
  const g = ctx.grid, l = g.layout;
  const base = l.ceilCm[cellIdx(i0, j0)];
  const plen = 10 * rng.int(8, 11); // 80..110 cm of plenum
  const deck = base + plen;
  g.setCells(i0, j0, i1, j1, { ceilCm: deck, ceilKind: CeilKind.OPEN_DARK, ceilMat: Mat.PLENUM, flagsSet: CellFlag.NO_CEIL, flagsClear: CellFlag.SPAWN_OK });
  for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) l.tiles[cellIdx(li, lj)] = 0;
  const x0 = i0 * CELL, x1 = i1 * CELL, z0 = j0 * CELL, z1 = j1 * CELL;
  const alongX = x1 - x0 >= z1 - z0;
  const yDeck = deck / 100;
  let solids = 0;
  const box = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, mat: number, flags: number): void => {
    g.addSolid({ kind: 'box', min: [ax, ay, az], max: [bx, by, bz], mat: mat as never, flags, bakeGroup: 0 });
    solids++;
  };
  // the corrugated deck: a dark slab closing the hole 10 cm above the cells' ceiling line (walls end at ceilCm)
  box(x0, yDeck - 0.02, z0, x1, yDeck + 0.1, z1, Mat.METAL_DECK, OCC_FLAGS);
  // bar joists across the short axis every 1.2 m
  const jd = 0.28;
  if (alongX) {
    for (let x = x0 + 0.6; x < x1 - 0.1; x += 1.2) box(x - 0.03, yDeck - 0.02 - jd, z0, x + 0.03, yDeck - 0.02, z1, Mat.METAL_RUST, DECO_FLAGS);
  } else {
    for (let z = z0 + 0.6; z < z1 - 0.1; z += 1.2) box(x0, yDeck - 0.02 - jd, z - 0.03, x1, yDeck - 0.02, z + 0.03, Mat.METAL_RUST, DECO_FLAGS);
  }
  // a sheet-metal duct along the long axis (under the joists, above the old ceiling line)
  const dH = Math.min(0.4, plen / 100 - jd - 0.1);
  if (dH >= 0.25) {
    const top = yDeck - 0.02 - jd - 0.02, bot = top - dH;
    const across = rng.range(0.25, 0.75);
    if (alongX) { const zc = z0 + (z1 - z0) * across; box(x0, bot, zc - 0.3, x1, top, zc + 0.3, Mat.METAL_PAINTED, OCC_FLAGS); }
    else { const xc = x0 + (x1 - x0) * across; box(xc - 0.3, bot, z0, xc + 0.3, top, z1, Mat.METAL_PAINTED, OCC_FLAGS); }
  }
  // one or two pipes, and a sprinkler main
  const np = rng.int(1, 2);
  for (let k = 0; k < np; k++) {
    const r = rng.chance(0.5) ? 0.05 : 0.035;
    const y = yDeck - 0.1 - rng.range(0.0, 0.15);
    const t = rng.range(0.1, 0.9);
    if (alongX) { const zc = z0 + (z1 - z0) * t; g.addSolid({ kind: 'pipe', a: [x0, y, zc], b: [x1, y, zc], r, mat: rng.chance(0.5) ? Mat.METAL_RUST : Mat.METAL_PAINTED, flags: DECO_FLAGS }); }
    else { const xc = x0 + (x1 - x0) * t; g.addSolid({ kind: 'pipe', a: [xc, y, z0], b: [xc, y, z1], r, mat: rng.chance(0.5) ? Mat.METAL_RUST : Mat.METAL_PAINTED, flags: DECO_FLAGS }); }
    solids++;
  }
  // dangling cables below the old ceiling line
  const nc = rng.int(1, 3);
  for (let k = 0; k < nc; k++) {
    const x = rng.range(x0 + 0.3, x1 - 0.3), z = rng.range(z0 + 0.3, z1 - 0.3);
    const yb = base / 100 - rng.range(0.15, 0.6);
    g.addSolid({ kind: 'pipe', a: [x, yDeck - 0.05, z], b: [x + rng.range(-0.15, 0.15), yb, z + rng.range(-0.15, 0.15)], r: 0.006, mat: Mat.RUBBER, flags: DECO_FLAGS });
    solids++;
  }
  // fallen tiles and debris on the floor under the hole
  for (let lj = j0; lj < j1; lj++) {
    for (let li = i0; li < i1; li++) {
      if (!rng.chance(0.4)) continue;
      const c = cellIdx(li, lj);
      const fy = l.floorCm[c] / 100;
      const [cx, cz] = g.cellCenter(li, lj);
      if (rng.chance(0.4)) g.addProp({ kind: PropKind.CEILING_DEBRIS, variant: rng.int(0, 3), x: cx + rng.range(-0.2, 0.2), y: fy, z: cz + rng.range(-0.2, 0.2), yaw: rng.int(0, 3) * Math.PI / 2, scale: 1, flags: 0, seed: rng.next() });
      else g.addProp({ kind: PropKind.TILE_FRAGMENT, variant: rng.int(0, 3), x: cx + rng.range(-0.35, 0.35), y: fy, z: cz + rng.range(-0.35, 0.35), yaw: rng.range(0, 6.283), scale: 1, flags: 0, seed: rng.next() });
    }
  }
  return { cells: (i1 - i0) * (j1 - j0), solids };
}

/** Scatters TileState.MISSING over the TILES cells of a rect with probability p per tile (fixture tiles kept). */
export function missingTiles(ctx: ZoneGenContext, i0: number, j0: number, i1: number, j1: number, p: number, rng: Rng, state: number = TileState.MISSING): number {
  const l = ctx.grid.layout;
  let n = 0;
  for (let lj = Math.max(0, j0); lj < Math.min(N, j1); lj++) {
    for (let li = Math.max(0, i0); li < Math.min(N, i1); li++) {
      const c = cellIdx(li, lj);
      if (l.ceilKind[c] !== CeilKind.TILES || (l.flags[c] & (CellFlag.RESERVED | CellFlag.NO_CEIL | CellFlag.SOLID)) !== 0) continue;
      for (let t = 0; t < 4; t++) {
        if (getTile(l.tiles, c, t) !== TileState.NORMAL || !rng.chance(p)) continue;
        setTile(l.tiles, c, t, state);
        n++;
      }
    }
  }
  return n;
}

/** Pulls the lattice fixtures of a rect: marks MISSING the tiles every candidate rect of each lattice slot inside it
 * would use (the slot and its +x / +z retries), so WP4's lattice placer leaves the bay dark. */
export function removedFixtures(ctx: ZoneGenContext, i0: number, j0: number, i1: number, j1: number, state: number = TileState.MISSING): number {
  const lp = ctx.lighting, g = ctx.grid, l = g.layout;
  if (lp.placement !== 'lattice') return 0;
  const dims = FIXTURE_DIMS[lp.kind];
  if (!dims) return 0;
  const wz = lp.axis === 0 ? dims.ts : dims.tl;
  const latX = Math.max(1, lp.lattice[0] | 0), latZ = Math.max(1, lp.lattice[1] | 0);
  const mod = (a: number, m: number): number => ((a % m) + m) % m;
  const fx = mod(lp.phase[0] - g.gi0 * 2, latX), fz = mod(lp.phase[1] - g.gj0 * 2, latZ);
  let n = 0;
  const kill = (tx: number, tz: number): void => {
    const li = tx >> 1, lj = tz >> 1;
    if (li < i0 || li >= i1 || lj < j0 || lj >= j1) return;
    const c = cellIdx(li, lj);
    if (l.ceilKind[c] !== CeilKind.TILES || (l.flags[c] & CellFlag.RESERVED) !== 0) return;
    const t = ((tz & 1) << 1) | (tx & 1);
    if (getTile(l.tiles, c, t) === TileState.FIXTURE) return;
    setTile(l.tiles, c, t, state);
    n++;
  };
  for (let tz = fz; tz < 2 * N; tz += latZ) {
    for (let tx = fx; tx < 2 * N; tx += latX) {
      if ((tx >> 1) < i0 - 1 || (tx >> 1) >= i1 || (tz >> 1) < j0 - 1 || (tz >> 1) >= j1) continue;
      // one MISSING tile in each candidate: the slot, its +z retry (shared tile when wz >= 2) and its +x retry
      if (wz >= 2) kill(tx, tz + 1);
      else { kill(tx, tz); kill(tx, tz + 1); }
      kill(tx + 1, tz);
    }
  }
  return n;
}
