// src/audio/spatial.ts — runtime side of propagation: the listener's Dijkstra field over the resident world
// (5 Hz), source resolution against it, and reachable-cell picking for ambient / dread events.

import type { Rng } from '../core/rng.ts';
import type { WorldQuery } from '../core/runtime.ts';
import { CELL } from '../core/constants.ts';
import {
  createPropagationField, createResolution, fieldIndex, propagate, PROPAGATION_RADIUS, resolveSource,
  type PropagationField, type PropagationGrid, type SightTest, type SourceResolution,
} from './propagation.ts';

const cellOf = (m: number): number => Math.floor(m / CELL + 1e-7);

export class Spatializer {
  readonly field: PropagationField = createPropagationField(PROPAGATION_RADIUS);
  world: WorldQuery | null = null;
  lx = 0; ly = 1.6; lz = 0;
  /** increments every propagate() */
  version = 0;
  private readonly lcell: [number, number] = [0, 0];
  private readonly grid: PropagationGrid;
  readonly sight: SightTest;
  private readonly scratch: SourceResolution = createResolution();

  constructor() {
    this.grid = {
      walkable: (gi, gj) => this.world !== null && this.world.cellWalkable(gi, gj),
      edge: (axis, gi, gj) => (this.world !== null ? this.world.edgeSound(axis, gi, gj) : 0),
    };
    this.sight = (ax, ay, az, bx, by, bz) => this.world !== null && this.world.losClear(ax, ay, az, bx, by, bz);
  }

  setListener(x: number, y: number, z: number): void { this.lx = x; this.ly = y; this.lz = z; }

  update(world: WorldQuery): void {
    this.world = world;
    this.lcell[0] = cellOf(this.lx);
    this.lcell[1] = cellOf(this.lz);
    propagate(this.grid, this.lcell, PROPAGATION_RADIUS, this.field);
    this.version++;
  }

  resolve(sx: number, sy: number, sz: number, out: SourceResolution): SourceResolution {
    if (!this.world) {
      out.kind = 0; out.x = sx; out.y = sy; out.z = sz; out.cutoff = 20000; out.gain = 1; out.bends = 0; out.excess = 0;
      out.euclid = out.path = Math.hypot(sx - this.lx, sy - this.ly, sz - this.lz);
      return out;
    }
    return resolveSource(this.field, this.sight, this.lx, this.ly, this.lz, sx, sy, sz, out);
  }

  /** Path distance in metres through the field (Infinity if unreachable / outside); cheap, no sight tests. */
  pathMetres(x: number, z: number): number {
    const k = fieldIndex(this.field, cellOf(x), cellOf(z));
    if (k < 0) return Infinity;
    const d = this.field.dist[k];
    return d < Infinity ? d * CELL : Infinity;
  }

  /** Effective distance for scoring: euclid when in sight, else path (or a penalty when unreachable). */
  effectiveDistance(x: number, y: number, z: number): number {
    const r = this.resolve(x, y, z, this.scratch);
    return r.kind === 0 ? r.euclid : r.kind === 1 ? r.path : r.euclid * 2;
  }

  /**
   * A reachable cell whose path distance lies in [minM, maxM] (uniformly among candidates); falls back to the
   * farthest reachable cell >= minM * 0.6. Writes the cell centre to out = [x, z]; false if nothing qualifies.
   */
  pickReachable(rng: Rng, minM: number, maxM: number, out: [number, number]): boolean {
    const f = this.field;
    const n = f.size * f.size;
    let count = 0;
    for (let k = 0; k < n; k++) { const d = f.dist[k] * CELL; if (d >= minM && d <= maxM) count++; }
    let pick = -1;
    if (count > 0) {
      let r = Math.floor(rng.float() * count);
      for (let k = 0; k < n; k++) {
        const d = f.dist[k] * CELL;
        if (d >= minM && d <= maxM && r-- === 0) { pick = k; break; }
      }
    } else {
      let best = minM * 0.6;
      for (let k = 0; k < n; k++) { const d = f.dist[k] * CELL; if (d < Infinity && d >= best) { best = d; pick = k; } }
    }
    if (pick < 0) return false;
    const i = pick % f.size, j = (pick - i) / f.size;
    out[0] = (f.gi0 + i + 0.5) * CELL;
    out[1] = (f.gj0 + j + 0.5) * CELL;
    return true;
  }

  /** Step one cell further from the listener along the field (for "moving away" sources). Returns false at a
   * dead end. `cell` = [x, z] cell centre, updated in place. */
  stepAway(rng: Rng, cell: [number, number]): boolean {
    const f = this.field;
    const k = fieldIndex(f, cellOf(cell[0]), cellOf(cell[1]));
    if (k < 0) return false;
    const d0 = f.dist[k];
    const i = k % f.size, j = (k - i) / f.size;
    let best = -1, bestScore = -Infinity;
    for (let dd = 0; dd < 4; dd++) {
      const ni = i + (dd === 0 ? 1 : dd === 1 ? -1 : 0), nj = j + (dd === 2 ? 1 : dd === 3 ? -1 : 0);
      if (ni < 0 || nj < 0 || ni >= f.size || nj >= f.size) continue;
      const nk = nj * f.size + ni;
      const d = f.dist[nk];
      if (!(d < Infinity) || d <= d0) continue;
      const s = d + rng.float() * 0.5;
      if (s > bestScore) { bestScore = s; best = nk; }
    }
    if (best < 0) return false;
    const bi = best % f.size, bj = (best - bi) / f.size;
    cell[0] = (f.gi0 + bi + 0.5) * CELL;
    cell[1] = (f.gj0 + bj + 0.5) * CELL;
    return true;
  }
}
