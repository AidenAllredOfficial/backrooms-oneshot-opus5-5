// src/world/content/leaks.ts — ceiling tile ageing, damp floor patches, ceiling leaks, stains and wet floors (WP4, R2 B6).
//
// 1. ageCeilingTiles (R2): every NORMAL tile of a TILES ceiling (0.6 m, hashed per global tile) may become NEW /
//    DIRTY / STAINED / SAGGING / MISSING. Base rates TILE_AGE_P (2 / 6 / 3 / 0.7 / 0.3 %), scaled per cell by decay
//    (dirty, missing up; new down) and humidity (stains, sagging up), and per 2.4 m tile block by a clumping factor
//    (3u^2, mean 1) so stained / dirty tiles come in patches like real water damage. FIXTURE / VENT tiles untouched.
// 2. placeDampCells (R2): humid Level 0 floor (humidity > 0.6) gets damp patches of 1-4 WET cells, dampest cells
//    first, with a faint WATER_STAIN, until DAMP_TARGET (5.5 %) of the chunk's humid cells are WET.
// 3. leaks: count = floor(mean(humidity) * 4 + hash01) per chunk, each at a random walkable cell's ceiling, strength
//    0.3-1. Ceiling tiles within 0.9 m become STAINED (p 0.6) / SAGGING (p 0.2) / MISSING (p 0.1); floor cells below
//    get WET with p 0.7; a DRIP emitter marks the drops. The baker's grime mask reads layout.leaks.
// 4. A REPEATED_ROOM pair gets room A's tiles / WET flags again (syncRepeatedRoom).

import { CELL, CHUNK_SIZE } from '../../core/constants.ts';
import { CeilKind, CellFlag, DecalKind, EmitterKind, SALT, TileState, Zone, cellIdx, getTile, hash01, hash2, hash5, rngFor, setTile } from '../../core/index.ts';
import type { ZoneGenContext } from '../../core/index.ts';
import { syncRepeatedRoom } from './anomalies.ts';
import { canStep, DX, DZ, inChunk, isOpenFloor, meanField, N } from './util.ts';

export const LEAK_RADIUS = 0.9;

/** Base ageing rates per tile (mean over Level 0 ceilings). */
export const TILE_AGE_P = { NEW: 0.02, DIRTY: 0.06, STAINED: 0.03, SAGGING: 0.007, MISSING: 0.003 } as const;
const AGE_SKIP = CellFlag.SOLID | CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.NO_CEIL | CellFlag.LANDMARK;

/** Ageing state of a NORMAL tile at global tile (ti, tj) with cell decay / humidity in [0, 1). Exported for tests. */
export function agedTileState(seed: number, s: number, ti: number, tj: number, decay: number, humid: number): number {
  const u = hash01(hash5(seed, SALT.TILE_STATE, s, ti, tj));
  // clumping per 4 x 4 tile block (2.4 m): 3 v^2 has mean 1 and puts most of the damage into a few blocks
  const vb = hash01(hash5(seed, SALT.TILE_STATE, s + 16, ti >> 2, tj >> 2));
  const vd = hash01(hash2(hash5(seed, SALT.TILE_STATE, s + 32, ti >> 2, tj >> 2), 7));
  const wet = 3 * vb * vb, grime = 0.3 + 1.4 * vd;
  let p = TILE_AGE_P.MISSING * (0.3 + 1.4 * decay) * wet;
  if (u < p) return TileState.MISSING;
  p += TILE_AGE_P.SAGGING * (0.2 + 1.6 * humid) * wet;
  if (u < p) return TileState.SAGGING;
  p += TILE_AGE_P.STAINED * (0.3 + 1.4 * humid) * wet;
  if (u < p) return TileState.STAINED;
  p += TILE_AGE_P.DIRTY * (0.4 + 1.2 * decay) * grime;
  if (u < p) return TileState.DIRTY;
  p += TILE_AGE_P.NEW * (1.6 - 1.2 * decay) * (2 - grime);
  if (u < p) return TileState.NEW;
  return TileState.NORMAL;
}

export function ageCeilingTiles(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, s = ctx.key.s;
  for (let c = 0; c < N * N; c++) {
    if (l.ceilKind[c] !== CeilKind.TILES || (l.flags[c] & AGE_SKIP) !== 0) continue;
    const li = c & 31, lj = c >> 5;
    const decay = l.decay[c] / 256, humid = l.humidity[c] / 256;
    for (let t = 0; t < 4; t++) {
      if (getTile(l.tiles, c, t) !== TileState.NORMAL) continue;
      const st = agedTileState(ctx.seed, s, 2 * (g.gi0 + li) + (t & 1), 2 * (g.gj0 + lj) + (t >> 1), decay, humid);
      if (st !== TileState.NORMAL) setTile(l.tiles, c, t, st);
    }
  }
}

/** Humidity threshold (byte) above which Level 0 floors get damp patches. */
export const DAMP_HUMID = Math.round(0.6 * 256);
/** Target share of WET cells among humid (> DAMP_HUMID) Level 0 floor cells of a chunk (issue: 5-8 %). */
export const DAMP_TARGET = 0.055;

/** Damp patches of 1-4 WET cells on humid Level 0 floor until DAMP_TARGET of the chunk's humid cells are WET (other
 * passes' wet cells count). Seeds are taken in order of hash / (humidity above the threshold): the dampest first. */
export function placeDampCells(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, { s, cx, cz } = ctx.key;
  let humid = 0, wet = 0;
  const seeds: { c: number; k: number }[] = [];
  for (let c = 0; c < N * N; c++) {
    const h = l.humidity[c];
    if (h <= DAMP_HUMID || l.cellZone[c] > Zone.OFFICE || !isOpenFloor(l, c) || (l.flags[c] & CellFlag.LANDMARK) !== 0) continue;
    humid++;
    if ((l.flags[c] & CellFlag.WET) !== 0) { wet++; continue; }
    const u = hash01(hash5(ctx.seed, SALT.LEAK, s, g.gi0 + (c & 31), g.gj0 + (c >> 5)));
    seeds.push({ c, k: u / ((h - DAMP_HUMID) / (256 - DAMP_HUMID) + 0.05) });
  }
  if (humid < 8) return;
  const goal = Math.round(humid * DAMP_TARGET);
  seeds.sort((p, q) => p.k - q.k || p.c - q.c);
  const rng = rngFor(ctx.seed, SALT.LEAK, s, cx, cz, 0xda);
  for (const { c } of seeds) {
    if (wet >= goal) break;
    if ((l.flags[c] & CellFlag.WET) !== 0) continue;
    const r = rng.fork(c);
    const cells = [c];
    for (let k = 0, n = r.int(0, 3); k < n; k++) {
      const from = cells[r.int(0, cells.length - 1)], d = r.int(0, 3);
      if (!canStep(l, from & 31, from >> 5, d)) continue;
      const nb = cellIdx((from & 31) + DX[d], (from >> 5) + DZ[d]);
      if (isOpenFloor(l, nb) && !cells.includes(nb) && l.floorCm[nb] === l.floorCm[c] && (l.flags[nb] & CellFlag.WET) === 0) cells.push(nb);
    }
    let sx = 0, sz = 0;
    for (const w of cells) {
      g.setCells(w & 31, w >> 5, (w & 31) + 1, (w >> 5) + 1, { flagsSet: CellFlag.WET });
      if (l.humidity[w] > DAMP_HUMID && l.cellZone[w] <= Zone.OFFICE) wet++;
      sx += ((w & 31) + 0.5) * CELL; sz += ((w >> 5) + 0.5) * CELL;
    }
    sx /= cells.length; sz /= cells.length;
    const w = r.range(1.2, 2.2);
    if (sx - w / 2 > 0.05 && sz - w / 2 > 0.05 && sx + w / 2 < CHUNK_SIZE - 0.05 && sz + w / 2 < CHUNK_SIZE - 0.05) {
      g.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: sx + r.range(-0.2, 0.2), py: l.floorCm[c] / 100, pz: sz + r.range(-0.2, 0.2), nx: 0, ny: 1, nz: 0, rot: r.range(0, 6.28), w, h: w * r.range(0.6, 1), alpha: r.range(0.3, 0.5) });
    }
  }
}

export function placeLeaks(ctx: ZoneGenContext): void {
  ageCeilingTiles(ctx);
  placeDampCells(ctx);
  placeLeakSites(ctx);
  syncRepeatedRoom(ctx.grid.layout);
}

/** The leak sites alone (step 3; exported for tests). */
export function placeLeakSites(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, { s, cx, cz } = ctx.key;
  const rng = rngFor(ctx.seed, SALT.LEAK, s, cx, cz);
  const count = Math.floor(meanField(l, l.humidity) * 4 + rng.float());
  if (count <= 0) return;
  const cells: number[] = [];
  for (let c = 0; c < N * N; c++) {
    if (!isOpenFloor(l, c)) continue;
    if (l.ceilKind[c] === CeilKind.OPEN_DARK || (l.flags[c] & CellFlag.NO_CEIL) !== 0) continue;
    cells.push(c);
  }
  if (cells.length === 0) return;
  for (let k = 0; k < count; k++) {
    const c = cells[rng.int(0, cells.length - 1)];
    const li = c & 31, lj = c >> 5;
    const x = (li + 0.5) * CELL + rng.range(-0.35, 0.35), z = (lj + 0.5) * CELL + rng.range(-0.35, 0.35);
    const strength = rng.range(0.3, 1);
    g.addLeak({ x, y: l.ceilCm[c] / 100, z, strength });
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = li + di, b = lj + dj;
        if (!inChunk(a, b)) continue;
        const cc = cellIdx(a, b);
        if (l.ceilKind[cc] === CeilKind.TILES) {
          for (let t = 0; t < 4; t++) {
            const tx = (a + 0.25 + 0.5 * (t & 1)) * CELL - x, tz = (b + 0.25 + 0.5 * (t >> 1)) * CELL - z;
            if (tx * tx + tz * tz > LEAK_RADIUS * LEAK_RADIUS) continue;
            const cur = getTile(l.tiles, cc, t);
            if (cur === TileState.FIXTURE || cur === TileState.VENT || cur === TileState.MISSING) continue;
            const u = rng.float();
            if (u < 0.6) setTile(l.tiles, cc, t, TileState.STAINED);
            else if (u < 0.8) setTile(l.tiles, cc, t, TileState.SAGGING);
            else if (u < 0.9) setTile(l.tiles, cc, t, TileState.MISSING);
          }
        }
        // floor cells (partly) within the radius below the leak
        const nx = Math.max(a * CELL, Math.min(x, (a + 1) * CELL)) - x, nz = Math.max(b * CELL, Math.min(z, (b + 1) * CELL)) - z;
        if (nx * nx + nz * nz <= LEAK_RADIUS * LEAK_RADIUS && isOpenFloor(l, cc) && rng.chance(0.7)) {
          g.setCells(a, b, a + 1, b + 1, { flagsSet: CellFlag.WET });
        }
      }
    }
    g.addEmitter(EmitterKind.DRIP, x, l.floorCm[c] / 100 + 0.02, z, 0.2 + 0.3 * strength);
  }
}
