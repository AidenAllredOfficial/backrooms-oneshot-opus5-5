// src/mesh/faceIndex.ts — WP5 private: own vertical shell faces bucketed by owner cell, used to borrow the wall
// chart behind trims and wall decals. Pure module.

import type { Face, Plan } from './plan.ts';
import { cix, type TileGrid } from './tileGrid.ts';

/** Own vertical shell faces bucketed by owner cell (for borrowing the wall chart behind a trim). */
export class VFaceIndex {
  private m = new Map<number, Face[]>();
  constructor(plan: Plan, g: TileGrid) {
    for (const f of plan.faces) {
      if (!f.own || f.buf !== 0 || Math.abs(f.ny) > 0.01 || (f.spec && f.spec.grid)) continue; // run faces get their spec at finalize
      let cx = 0, cz = 0;
      const n = f.p.length / 3;
      for (let i = 0; i < f.p.length; i += 3) { cx += f.p[i]; cz += f.p[i + 2]; }
      const [ci, cj] = g.cellAt(cx / n + f.nx * 0.01, cz / n + f.nz * 0.01);
      const k = cix(ci, cj);
      let l = this.m.get(k);
      if (!l) this.m.set(k, (l = []));
      l.push(f);
    }
  }
  /** A face owned by cell k with normal (nx, nz), in the plane `plane` (x for nx != 0, z otherwise), covering t. */
  find(k: number, nx: number, nz: number, plane: number, t: number, y: number, tol = 2e-3): Face | null {
    const l = this.m.get(k);
    if (!l) return null;
    const ax = nx !== 0 ? 0 : 2, oth = ax === 0 ? 2 : 0;
    let best: Face | null = null;
    for (const f of l) {
      if (Math.abs(f.nx - nx) > 1e-3 || Math.abs(f.nz - nz) > 1e-3 || Math.abs(f.p[ax] - plane) > tol) continue;
      let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
      for (let i = 0; i < f.p.length; i += 3) {
        lo = Math.min(lo, f.p[i + oth]); hi = Math.max(hi, f.p[i + oth]);
        ylo = Math.min(ylo, f.p[i + 1]); yhi = Math.max(yhi, f.p[i + 1]);
      }
      if (t < lo - 1e-3 || t > hi + 1e-3) continue;
      if (y >= ylo - 1e-3 && y <= yhi + 1e-3) return f;
      best ??= f;
    }
    return best;
  }
}

