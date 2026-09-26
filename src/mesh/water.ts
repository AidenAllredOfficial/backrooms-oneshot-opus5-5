// src/mesh/water.ts — WP5 water surfaces (§5 WP5 rule 10): each WaterRect of nb.center intersecting the tile
// becomes a quad at its y in the separate `water` buffer, flag REFLECTIVE, lmUv from the FLOOR_GRID at the same xz,
// aux.x = depth in 5 cm units, aux.w = plane height byte ((y*100 + 320) / 5). Material uv = tile-local metres.
// The optics of the water body live on the submerged surfaces (UNDERWATER, see walls/floors). Pure module.

import { TILE_SIZE } from '../core/constants.ts';
import { VFlag } from '../core/ids.ts';
import { BUF_WATER, mkFace, state, type Plan } from './plan.ts';
import type { TileGrid } from './tileGrid.ts';

const clampB = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export function emitWater(plan: Plan, g: TileGrid): void {
  for (const w of g.nb.center.water) {
    const x0 = Math.max(0, Math.min(w.x0, w.x1) - g.ox), x1 = Math.min(TILE_SIZE, Math.max(w.x0, w.x1) - g.ox);
    const z0 = Math.max(0, Math.min(w.z0, w.z1) - g.oz), z1 = Math.min(TILE_SIZE, Math.max(w.z0, w.z1) - g.oz);
    if (x1 - x0 <= 1e-5 || z1 - z0 <= 1e-5) continue;
    const y = w.y;
    const aux = (clampB((y - w.floorY) * 20) | (clampB((y * 100 + 320) / 5) << 24)) >>> 0;
    const st = state(0, VFlag.REFLECTIVE | VFlag.NO_GRIME, 0xffffff, 0, aux, BUF_WATER);
    const p = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
    const uv = [x0, z0, x1, z0, x1, z1, x0, z1];
    plan.borrow(mkFace(p, uv, 0, 1, 0, st), plan.floorGrid);
  }
}
