// src/mesh/water.ts — WP5 water surfaces (§5 WP5 rule 10): each WaterRect of nb.center intersecting the tile
// becomes a quad at its y in the separate `water` buffer, flag REFLECTIVE, lmUv from the FLOOR_GRID at the same xz.
// Material uv = tile-local metres. Per-quad data (package E; the water shader reads it through flat varyings):
//   tint = (1, 1, 1, kind): the water body kind (0 pool, 1 flooded room, 2 film);
//   aux.x = depth in 2 cm units (a 2 cm film is 1, 5.1 m max);
//   aux.y/z = regionKey (low, high byte) of the rect's cells inside the tile, 0 when they span more than one region
//             (the emission-map reflection then accepts any emitter);
//   aux.w = the emitter plane above the water in 5 cm units (floorAux's reflection plane of the rect's cells,
//           measured from the water surface): non-mirrored planes intersect their reflected rays with it.
// The body's optics on the submerged surfaces use the wall mask's water channels (bake/volume.ts). Pure module.

import { CELL, TILE_CELLS, TILE_SIZE } from '../core/constants.ts';
import { VFlag } from '../core/ids.ts';
import { BUF_WATER, mkFace, state, type Plan } from './plan.ts';
import type { TileGrid } from './tileGrid.ts';
import { tintRGB } from './uv.ts';

const clampB = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** aux of one water quad (tile-local rect x0..x1, z0..z1) from the tile's floorAux words (mesh/floors.ts). */
export function waterAux(x0: number, x1: number, z0: number, z1: number, y: number, floorY: number, floorAux: Uint32Array): number {
  const ci0 = Math.max(0, Math.floor(x0 / CELL + 1e-6)), ci1 = Math.min(TILE_CELLS, Math.ceil(x1 / CELL - 1e-6));
  const cj0 = Math.max(0, Math.floor(z0 / CELL + 1e-6)), cj1 = Math.min(TILE_CELLS, Math.ceil(z1 / CELL - 1e-6));
  // region key: common to every cell, else 0; reflection plane: the most frequent one (ties: the lowest)
  let key = -1;
  const cnt = new Map<number, number>();
  for (let cj = cj0; cj < cj1; cj++) {
    for (let ci = ci0; ci < ci1; ci++) {
      const a = floorAux[cj * TILE_CELLS + ci];
      const k = (a >>> 8) & 0xffff;
      key = key < 0 ? k : key === k ? key : 0;
      const rb = a & 255;
      cnt.set(rb, (cnt.get(rb) ?? 0) + 1);
    }
  }
  let rb = 0, n = 0;
  for (const [v, c] of cnt) if (c > n || (c === n && v < rb)) { rb = v; n = c; }
  const planeAbove = floorY + rb * 0.05 - y;
  return (clampB((y - floorY) * 50) | ((Math.max(key, 0) & 0xffff) << 8) | (clampB(planeAbove * 20) << 24)) >>> 0;
}

export function emitWater(plan: Plan, g: TileGrid, floorAux: Uint32Array): void {
  for (const w of g.nb.center.water) {
    const x0 = Math.max(0, Math.min(w.x0, w.x1) - g.ox), x1 = Math.min(TILE_SIZE, Math.max(w.x0, w.x1) - g.ox);
    const z0 = Math.max(0, Math.min(w.z0, w.z1) - g.oz), z1 = Math.min(TILE_SIZE, Math.max(w.z0, w.z1) - g.oz);
    if (x1 - x0 <= 1e-5 || z1 - z0 <= 1e-5) continue;
    const y = w.y;
    const aux = waterAux(x0, x1, z0, z1, y, w.floorY, floorAux);
    const st = state(0, VFlag.REFLECTIVE | VFlag.NO_GRIME, tintRGB(1, 1, 1, w.kind), 0, aux, BUF_WATER);
    const p = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
    const uv = [x0, z0, x1, z0, x1, z1, x0, z1];
    plan.borrow(mkFace(p, uv, 0, 1, 0, st), plan.floorGrid);
  }
}
