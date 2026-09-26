// src/stream/WorldQueryImpl.ts — WorldQuery over one storey's data set (layouts + collision) (WP10).
// No three, no DOM: unit-testable in Node. World metres in, chunk-local maths in float64
// (lx = x - cx * CHUNK_SIZE). Cell, chunk and tile always derive from worldToCell (core/grid.ts).
//
// Hot-path rules: no allocation per call. Returned PortalHit / FixtureRef / EmitterRef objects are
// precomputed per chunk when its data is registered; propAt returns ONE reused PropHit object (overwritten
// by the next call).

import { CELL, CHUNK_CELLS, CHUNK_SIZE, PLAYER, STD_CEIL_CM, STOREY_PITCH, TOWER_SPAN } from '../core/constants.ts';
import { EDGE_SOUND, edgeOccludesAt } from '../core/edges.ts';
import {
  cellToChunk, exIdx, ezIdx, tileKeyStr, tileOfPoint, worldToCell, type ChunkKey,
} from '../core/grid.ts';
import { CellFlag, Mood, SolidFlag, SurfaceSound, Zone, type MoodId, type StoreyId, type SurfaceSoundId, type ZoneId } from '../core/ids.ts';
import { NO_WATER, TOWER_REPLICAS, towerGroups, type ChunkLayout, type Solid } from '../core/layout.ts';
import { LAYER_DEFS } from '../core/materials.ts';
import type { ChunkCollision } from '../core/mesh.ts';
import { INTERACTABLE_PROPS, PROP_DEFS } from '../core/props.ts';
import type { EmitterRef, FixtureRef, PortalHit, PropHit, WorldQuery } from '../core/runtime.ts';
import { STRUCTURE_ZONE } from '../core/zones.ts';

// ---------------------------------------------------------------- per-chunk data

export interface ChunkData {
  readonly key: ChunkKey;
  readonly ks: string;
  readonly ox: number; // chunk origin, world metres
  readonly oz: number;
  readonly layout: ChunkLayout;
  readonly collision: ChunkCollision;
  readonly nBoxes: number;
  readonly stamp: Uint32Array; // per-box dedupe stamp for boxesNear
  readonly fixtures: FixtureRef[]; // tower fixtures expanded (replicas share the base fixture / id)
  readonly emitters: EmitterRef[];
  readonly portals: PortalHit[];
  readonly interactable: number[]; // indices into layout.props
  readonly towers: readonly number[]; // towerGroups(layout): bakeGroups of periodic tower content (cached: no per-query alloc)
}

/** Smi-range numeric key (no string allocation on lookups). Collides only for chunks 32768 apart; the stored
 * key is verified on lookup. */
export const chunkNumKey = (cx: number, cz: number): number => (cx & 0x7fff) * 0x8000 + (cz & 0x7fff);

export function createChunkData(layout: ChunkLayout, collision: ChunkCollision): ChunkData {
  const k = layout.key;
  const ox = k.cx * CHUNK_SIZE, oz = k.cz * CHUNK_SIZE;
  const towers = towerGroups(layout);
  const fixtures: FixtureRef[] = [];
  for (const f of layout.fixtures) {
    const tileKey = tileKeyStr({ s: k.s, cx: k.cx, cz: k.cz, q: tileOfPoint(f.px, f.pz) });
    if (f.bakeGroup !== 0 && towers.includes(f.bakeGroup)) {
      for (const r of TOWER_REPLICAS) {
        const y = f.py + r * STOREY_PITCH;
        if (Math.abs(y) <= TOWER_SPAN + 1e-6) fixtures.push({ f, wx: ox + f.px, wy: y, wz: oz + f.pz, tileKey });
      }
    } else {
      fixtures.push({ f, wx: ox + f.px, wy: f.py, wz: oz + f.pz, tileKey });
    }
  }
  const emitters: EmitterRef[] = layout.emitters.map((e) => ({ e, wx: ox + e.x, wy: e.y, wz: oz + e.z }));
  const portals: PortalHit[] = [];
  for (const s of layout.structures) if (s.portal) portals.push({ spec: s.portal, ox, oz });
  const interactable: number[] = [];
  layout.props.forEach((p, i) => { if (INTERACTABLE_PROPS.includes(p.kind)) interactable.push(i); });
  const nBoxes = (collision.boxes.length / 6) | 0;
  return {
    key: k, ks: `${k.s}:${k.cx}:${k.cz}`, ox, oz, layout, collision, nBoxes, stamp: new Uint32Array(nBoxes),
    fixtures, emitters, portals, interactable, towers,
  };
}

/** One storey's query data set: registered chunk data by (cx, cz). */
export class StoreyData {
  readonly map = new Map<number, ChunkData>();
  private lastCx = NaN;
  private lastCz = NaN;
  private last: ChunkData | null = null;
  // chunk-coordinate bounds of the registered chunks (lazy; range queries clamp to them, so a huge or non-finite
  // radius can never turn into an unbounded loop)
  private bDirty = true;
  private bMinCx = 0; private bMaxCx = -1; private bMinCz = 0; private bMaxCz = -1;

  private updateBounds(): void {
    this.bDirty = false;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const d of this.map.values()) {
      if (d.key.cx < x0) x0 = d.key.cx;
      if (d.key.cx > x1) x1 = d.key.cx;
      if (d.key.cz < z0) z0 = d.key.cz;
      if (d.key.cz > z1) z1 = d.key.cz;
    }
    if (x0 > x1) { this.bMinCx = 0; this.bMaxCx = -1; this.bMinCz = 0; this.bMaxCz = -1; return; }
    this.bMinCx = x0; this.bMaxCx = x1; this.bMinCz = z0; this.bMaxCz = z1;
  }
  /** Chunk bounds of the registered chunks (max < min when empty). */
  get minCx(): number { if (this.bDirty) this.updateBounds(); return this.bMinCx; }
  get maxCx(): number { if (this.bDirty) this.updateBounds(); return this.bMaxCx; }
  get minCz(): number { if (this.bDirty) this.updateBounds(); return this.bMinCz; }
  get maxCz(): number { if (this.bDirty) this.updateBounds(); return this.bMaxCz; }

  get(cx: number, cz: number): ChunkData | null {
    if (cx === this.lastCx && cz === this.lastCz) return this.last;
    const d = this.map.get(chunkNumKey(cx, cz));
    const r = d !== undefined && d.key.cx === cx && d.key.cz === cz ? d : null;
    this.lastCx = cx; this.lastCz = cz; this.last = r;
    return r;
  }
  set(d: ChunkData): void {
    this.map.set(chunkNumKey(d.key.cx, d.key.cz), d);
    this.lastCx = NaN;
    this.bDirty = true;
  }
  delete(cx: number, cz: number): boolean {
    const d = this.get(cx, cz);
    if (!d) return false;
    this.map.delete(chunkNumKey(cx, cz));
    this.lastCx = NaN;
    this.bDirty = true;
    return true;
  }
  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); this.lastCx = NaN; this.bDirty = true; }
}

// ---------------------------------------------------------------- helpers

/** Surface height of a ramp at chunk-local (lx, lz); dir: 0 +x, 1 -x, 2 +z, 3 -z ascent. */
export function rampHeight(r: Float32Array, o: number, lx: number, lz: number): number {
  const x0 = r[o], z0 = r[o + 1], x1 = r[o + 2], z1 = r[o + 3], y0 = r[o + 4], y1 = r[o + 5], dir = r[o + 6];
  let t: number;
  if (dir === 0) t = (lx - x0) / (x1 - x0 || 1);
  else if (dir === 1) t = (x1 - lx) / (x1 - x0 || 1);
  else if (dir === 2) t = (lz - z0) / (z1 - z0 || 1);
  else t = (z1 - lz) / (z1 - z0 || 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return y0 + (y1 - y0) * t;
}

const inRampXZ = (r: Float32Array, o: number, lx: number, lz: number): boolean =>
  lx >= r[o] && lx <= r[o + 2] && lz >= r[o + 1] && lz <= r[o + 3];

/** Underside allowance of a stair/ramp slab when it overhangs the player (towers: the flight one period above). */
const RAMP_SLAB = 0.2;
/** rayDistance marches at most this far (m): far beyond any resident set (radius 3 = 7 chunks = 269 m). */
const MAX_RAY = 1000;
const EPS = 1e-6;
/** cellWalkable: flags that make a cell impassable on foot. TOWER / ELEVATOR cells stay walkable (the player walks
 * through them; their floors come from the collision boxes / ramps). */
const NOT_WALKABLE = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK;
const STEP_CM = Math.round(PLAYER.stepMax * 100);
const WADE_CM = Math.round(PLAYER.wadeMaxDepth * 100);

// ---------------------------------------------------------------- the query

export interface WorldQueryDeps {
  storey(): StoreyId;
  data(s: StoreyId): StoreyData;
}

export function createWorldQuery(deps: WorldQueryDeps): WorldQuery {
  // ---- locate scratch (no allocation): set by locateCell / locate
  let cur: ChunkData | null = null;
  let ci = 0; // cell index lj*32+li
  let lx = 0, lz = 0; // chunk-local metres of the last locate()
  let stampId = 0;
  const hit: PropHit = { kind: 0, x: 0, y: 0, z: 0, seed: 0, cx: 0, cz: 0 };

  const dataOf = (): StoreyData => deps.data(deps.storey());

  const locateCell = (gi: number, gj: number): ChunkData | null => {
    const cx = cellToChunk(gi), cz = cellToChunk(gj);
    cur = dataOf().get(cx, cz);
    ci = (gj - cz * CHUNK_CELLS) * CHUNK_CELLS + (gi - cx * CHUNK_CELLS);
    return cur;
  };
  const locate = (x: number, z: number): ChunkData | null => {
    const d = locateCell(worldToCell(x), worldToCell(z));
    if (d) { lx = x - d.ox; lz = z - d.oz; }
    return d;
  };
  /** Floor (m) of global cell (gi, gj), or NaN if unloaded. Clobbers the locate scratch. */
  const floorOfCell = (gi: number, gj: number): number => {
    const d = locateCell(gi, gj);
    return d ? d.layout.floorCm[ci] / 100 : NaN;
  };

  /** Does the cell at the current scratch block a ray at height y? (SOLID, below the floor, above the ceiling,
   * inside a cell-filling blocker). */
  const cellBlocks = (d: ChunkData, c: number, y: number): boolean => {
    const l = d.layout;
    const f = l.flags[c];
    if (f & CellFlag.SOLID) return true;
    const floor = l.floorCm[c] / 100;
    if ((f & CellFlag.VOID) === 0 && y < floor - EPS) return true;
    if ((f & CellFlag.NO_CEIL) === 0 && y > l.ceilCm[c] / 100 + EPS) return true;
    const blk = l.blockCm[c];
    if (blk > 0 && y < floor + blk / 100) return true;
    return false;
  };

  /** Does the edge on global line `line` (axis 'x': x = line*CELL, cells (line-1, g)|(line, g); axis 'z': z = line*CELL,
   * cells (g, line-1)|(g, line)) occlude at along-edge offset t and height y? Unloaded edges occlude. */
  const edgeBlocks = (axisX: boolean, line: number, g: number, t: number, y: number): boolean => {
    // floors of both sides for the sill rule
    const fa = axisX ? floorOfCell(line - 1, g) : floorOfCell(g, line - 1);
    const d = axisX ? locateCell(line, g) : locateCell(g, line);
    if (!d) return true;
    const l = d.layout;
    const fb = l.floorCm[ci] / 100;
    const li = axisX ? line - d.key.cx * CHUNK_CELLS : g - d.key.cx * CHUNK_CELLS;
    const lj = axisX ? g - d.key.cz * CHUNK_CELLS : line - d.key.cz * CHUNK_CELLS;
    const eg = axisX ? l.ex : l.ez;
    const idx = axisX ? exIdx(li, lj) : ezIdx(li, lj);
    const kind = eg.kind[idx];
    if (kind === 0) return false;
    const sill = Number.isNaN(fa) ? fb : Math.max(fa, fb);
    return edgeOccludesAt(kind, eg.hA[idx], eg.hB[idx], t, y, sill);
  };

  /** 2.5D DDA from (ax, ay, az) to (bx, by, bz). Returns the segment parameter s in [0, 1] of the first
   * occluder, or 2 when the segment is clear. */
  const march = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): number => {
    let gi = worldToCell(ax), gj = worldToCell(az);
    const ti = worldToCell(bx), tj = worldToCell(bz);
    const dx = bx - ax, dz = bz - az, dy = by - ay;
    let d = locateCell(gi, gj);
    if (!d || cellBlocks(d, ci, ay)) return 0;
    const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepI !== 0 ? CELL / Math.abs(dx) : Infinity;
    const tDeltaZ = stepJ !== 0 ? CELL / Math.abs(dz) : Infinity;
    let tMaxX = stepI > 0 ? ((gi + 1) * CELL - ax) / dx : stepI < 0 ? (gi * CELL - ax) / dx : Infinity;
    let tMaxZ = stepJ > 0 ? ((gj + 1) * CELL - az) / dz : stepJ < 0 ? (gj * CELL - az) / dz : Infinity;
    const maxSteps = Math.abs(ti - gi) + Math.abs(tj - gj) + 2;
    for (let n = 0; n < maxSteps && (gi !== ti || gj !== tj); n++) {
      let s: number;
      const pgi = gi, pgj = gj;
      if (tMaxX <= tMaxZ) {
        s = tMaxX;
        if (s > 1) break;
        const line = stepI > 0 ? gi + 1 : gi;
        const y = ay + dy * s;
        const t = az + dz * s - gj * CELL;
        // leaving cell at exit height
        d = locateCell(pgi, pgj);
        if (!d || cellBlocks(d, ci, y)) return s;
        if (edgeBlocks(true, line, gj, t, y)) return s;
        gi += stepI;
        tMaxX += tDeltaX;
      } else {
        s = tMaxZ;
        if (s > 1) break;
        const line = stepJ > 0 ? gj + 1 : gj;
        const y = ay + dy * s;
        const t = ax + dx * s - gi * CELL;
        d = locateCell(pgi, pgj);
        if (!d || cellBlocks(d, ci, y)) return s;
        if (edgeBlocks(false, line, gi, t, y)) return s;
        gj += stepJ;
        tMaxZ += tDeltaZ;
      }
      d = locateCell(gi, gj);
      if (!d || cellBlocks(d, ci, ay + dy * s)) return s;
    }
    // end point inside its cell
    d = locateCell(gi, gj);
    if (!d || cellBlocks(d, ci, by)) return 1;
    return 2;
  };

  const chunkRange = (x0: number, z0: number, x1: number, z1: number, fn: (d: ChunkData) => boolean): void => {
    const sd = dataOf();
    // clamped to the registered chunks: huge / infinite ranges stay bounded; NaN ranges visit nothing
    const cx0 = Math.max(cellToChunk(worldToCell(x0)), sd.minCx), cx1 = Math.min(cellToChunk(worldToCell(x1)), sd.maxCx);
    const cz0 = Math.max(cellToChunk(worldToCell(z0)), sd.minCz), cz1 = Math.min(cellToChunk(worldToCell(z1)), sd.maxCz);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const d = sd.get(cx, cz);
        if (d && !fn(d)) return;
      }
    }
  };

  // Scratch for the closure-based range scans (set before chunkRange, read inside the callbacks).
  let qx = 0, qz = 0, qr = 0, qn = 0;
  let qPortals: PortalHit[] = [];
  let qFixtures: FixtureRef[] = [];
  let qEmitters: EmitterRef[] = [];
  const portalScan = (d: ChunkData): boolean => {
    for (let i = 0; i < d.portals.length; i++) {
      const p = d.portals[i];
      const s = p.spec;
      const ddx = qx < d.ox + s.min[0] ? d.ox + s.min[0] - qx : qx > d.ox + s.max[0] ? qx - d.ox - s.max[0] : 0;
      const ddz = qz < d.oz + s.min[2] ? d.oz + s.min[2] - qz : qz > d.oz + s.max[2] ? qz - d.oz - s.max[2] : 0;
      if (ddx * ddx + ddz * ddz <= qr * qr) qPortals[qn++] = p;
    }
    return true;
  };
  const fixtureScan = (d: ChunkData): boolean => {
    for (let i = 0; i < d.fixtures.length; i++) {
      const f = d.fixtures[i];
      const ddx = f.wx - qx, ddz = f.wz - qz;
      if (ddx * ddx + ddz * ddz <= qr * qr) qFixtures[qn++] = f;
    }
    return true;
  };
  const emitterScan = (d: ChunkData): boolean => {
    for (let i = 0; i < d.emitters.length; i++) {
      const e = d.emitters[i];
      const ddx = e.wx - qx, ddz = e.wz - qz;
      if (ddx * ddx + ddz * ddz <= qr * qr) qEmitters[qn++] = e;
    }
    return true;
  };

  // propAt scratch
  let pdx = 0, pdz = 0, pmax = 0, pbest = Infinity;
  const propScan = (d: ChunkData): boolean => {
    const props = d.layout.props;
    for (let k = 0; k < d.interactable.length; k++) {
      const p = props[d.interactable[k]];
      const def = PROP_DEFS[p.kind];
      const hx = def.size[0] * p.scale / 2, hz = def.size[2] * p.scale / 2;
      // ray into prop-local frame (writer convention: world = R(yaw) * local; inverse below)
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const rx = qx - (d.ox + p.x), rz = qz - (d.oz + p.z);
      const ox = c * rx - s * rz, oz = s * rx + c * rz;
      const vx = c * pdx - s * pdz, vz = s * pdx + c * pdz;
      let t0 = 0, t1 = pmax;
      if (Math.abs(vx) < 1e-12) { if (ox < -hx || ox > hx) continue; } else {
        let a = (-hx - ox) / vx, b = (hx - ox) / vx;
        if (a > b) { const tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
      if (Math.abs(vz) < 1e-12) { if (oz < -hz || oz > hz) continue; } else {
        let a = (-hz - oz) / vz, b = (hz - oz) / vz;
        if (a > b) { const tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
      if (t0 > t1 || t0 >= pbest) continue;
      pbest = t0;
      hit.kind = p.kind; hit.x = d.ox + p.x; hit.y = p.y; hit.z = d.oz + p.z; hit.seed = p.seed; hit.cx = d.key.cx; hit.cz = d.key.cz;
    }
    return true;
  };

  /** Surface sound of a solid whose top is at height y under chunk-local (x, z), from layout.solids (ramps and
   * walkable boxes). Tower solids are periodic. Returns -1 if none matches. */
  const solidSoundAt = (d: ChunkData, x: number, z: number, y: number): number => {
    const l = d.layout, towers = d.towers;
    for (let i = 0; i < l.solids.length; i++) {
      const s: Solid = l.solids[i];
      if (s.kind === 'pipe') continue;
      const periodic = towers.length > 0 && s.bakeGroup !== 0 && towers.includes(s.bakeGroup);
      let top: number;
      if (s.kind === 'box') {
        if ((s.flags & SolidFlag.WALKABLE_TOP) === 0) continue;
        if (x < s.min[0] || x > s.max[0] || z < s.min[2] || z > s.max[2]) continue;
        top = s.max[1];
      } else {
        if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
        let t = s.dir === 0 ? (x - s.x0) / (s.x1 - s.x0 || 1) : s.dir === 1 ? (s.x1 - x) / (s.x1 - s.x0 || 1)
          : s.dir === 2 ? (z - s.z0) / (s.z1 - s.z0 || 1) : (s.z1 - z) / (s.z1 - s.z0 || 1);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        top = s.y0 + (s.y1 - s.y0) * t;
      }
      let dyy = y - top;
      if (periodic) dyy -= Math.round(dyy / STOREY_PITCH) * STOREY_PITCH;
      if (Math.abs(dyy) > 0.1) continue;
      if (s.kind === 'ramp' && s.steps > 0) return SurfaceSound.STAIR_CONCRETE;
      return LAYER_DEFS[s.mat]?.sound ?? SurfaceSound.CONCRETE;
    }
    return -1;
  };

  const q: WorldQuery = {
    get storey() { return deps.storey(); },

    isLoaded(x, z) {
      return locate(x, z) !== null;
    },

    floorAt(x, z, feetY) {
      const d = locate(x, z);
      if (!d) return NaN;
      const l = d.layout, c = d.collision, cell = ci;
      const lim = feetY + PLAYER.stepMax + EPS;
      let best = -Infinity, above = Infinity;
      const f = l.flags[cell];
      if (f & CellFlag.SOLID) {
        // full-height mass: never a floor. Report a surface far above (unstandable) unless a box/ramp says otherwise.
        above = Math.max(l.ceilCm[cell], l.floorCm[cell] + STD_CEIL_CM) / 100 + TOWER_SPAN;
      } else if ((f & CellFlag.VOID) === 0) {
        const floor = l.floorCm[cell] / 100;
        if (floor <= lim) best = floor; else above = floor;
        const blk = l.blockCm[cell];
        if (blk > 0) {
          const top = floor + blk / 100;
          if (top <= lim) { if (top > best) best = top; } else if (top < above) above = top;
        }
      }
      const b = c.boxes, fl = c.boxFlags;
      for (let k = c.cellStart[cell], e = c.cellStart[cell + 1]; k < e; k++) {
        const i = c.cellBoxes[k];
        if ((fl[i] & SolidFlag.WALKABLE_TOP) === 0) continue;
        const o = i * 6;
        if (lx < b[o] || lx > b[o + 3] || lz < b[o + 2] || lz > b[o + 5]) continue;
        const top = b[o + 4];
        if (top <= lim) { if (top > best) best = top; } else if (top < above) above = top;
      }
      const r = c.ramps;
      for (let o = 0; o < r.length; o += 8) {
        if (!inRampXZ(r, o, lx, lz)) continue;
        const h = rampHeight(r, o, lx, lz);
        if (h <= lim) { if (h > best) best = h; } else if (h < above) above = h;
      }
      // No surface within step reach: report the lowest one above (the controller treats it as too high to
      // step onto) rather than a fall; -Infinity only when the cell has no surface at all (VOID pit).
      return best > -Infinity ? best : above < Infinity ? above : -Infinity;
    },

    ceilingAt(x, z, y) {
      const d = locate(x, z);
      if (!d) return Infinity;
      const l = d.layout, c = d.collision, cell = ci;
      const f = l.flags[cell];
      if (f & CellFlag.SOLID) return y;
      let best = Infinity;
      if ((f & CellFlag.NO_CEIL) === 0) {
        const ceil = l.ceilCm[cell] / 100;
        if (ceil >= y - EPS) best = ceil;
      }
      const b = c.boxes;
      for (let k = c.cellStart[cell], e = c.cellStart[cell + 1]; k < e; k++) {
        const o = c.cellBoxes[k] * 6;
        if (lx < b[o] || lx > b[o + 3] || lz < b[o + 2] || lz > b[o + 5]) continue;
        const bottom = b[o + 1];
        if (bottom >= y - EPS && bottom < best) best = bottom;
      }
      const r = c.ramps;
      for (let o = 0; o < r.length; o += 8) {
        if (!inRampXZ(r, o, lx, lz)) continue;
        const under = rampHeight(r, o, lx, lz) - RAMP_SLAB;
        if (under >= y - EPS && under < best) best = under;
      }
      return best;
    },

    waterAt(x, z) {
      const d = locate(x, z);
      if (!d) return null;
      const w = d.layout.waterCm[ci];
      if (w !== NO_WATER) return w / 100;
      const rects = d.layout.water;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (lx >= r.x0 && lx <= r.x1 && lz >= r.z0 && lz <= r.z1) return r.y;
      }
      return null;
    },

    surfaceAt(x, z, y) {
      const d = locate(x, z);
      if (!d) return SurfaceSound.CONCRETE;
      const l = d.layout, cell = ci, px = lx, pz = lz;
      const water = q.waterAt(x, z); // re-locates the same cell
      if (water !== null && water > y + 0.02) return water - y > 0.45 ? SurfaceSound.WATER_DEEP : SurfaceSound.WATER_SHALLOW;
      const f = l.flags[cell];
      const floor = l.floorCm[cell] / 100;
      if (Math.abs(y - floor) > 0.05 || (f & CellFlag.VOID) !== 0) {
        const s = solidSoundAt(d, px, pz, y);
        if (s >= 0) return s as SurfaceSoundId;
        if (f & CellFlag.TOWER) return SurfaceSound.STAIR_CONCRETE;
      }
      const snd = LAYER_DEFS[l.floorMat[cell]]?.sound ?? SurfaceSound.CONCRETE;
      if ((f & CellFlag.WET) !== 0 && snd === SurfaceSound.CARPET) return SurfaceSound.CARPET_WET;
      return snd;
    },

    boxesNear(x, z, r, out) {
      const cap = (out.length / 6) | 0;
      let n = 0;
      stampId = (stampId + 1) >>> 0;
      if (stampId === 0) {
        // wrapped: clear every stamp so stale ids cannot alias
        for (const s of [0, 1, 2] as StoreyId[]) for (const d of deps.data(s).map.values()) d.stamp.fill(0);
        stampId = 1;
      }
      // cell range clamped to the registered chunks (a huge or infinite r must not become an unbounded loop)
      const sd = dataOf();
      const gi0 = Math.max(worldToCell(x - r), sd.minCx * CHUNK_CELLS), gi1 = Math.min(worldToCell(x + r), sd.maxCx * CHUNK_CELLS + CHUNK_CELLS - 1);
      const gj0 = Math.max(worldToCell(z - r), sd.minCz * CHUNK_CELLS), gj1 = Math.min(worldToCell(z + r), sd.maxCz * CHUNK_CELLS + CHUNK_CELLS - 1);
      const rr = r * r;
      for (let gj = gj0; gj <= gj1; gj++) {
        for (let gi = gi0; gi <= gi1; gi++) {
          const d = locateCell(gi, gj);
          if (!d) continue;
          const c = d.collision, b = c.boxes, st = d.stamp;
          for (let k = c.cellStart[ci], e = c.cellStart[ci + 1]; k < e; k++) {
            const i = c.cellBoxes[k];
            if (st[i] === stampId) continue;
            st[i] = stampId;
            const o = i * 6;
            const x0 = b[o] + d.ox, z0 = b[o + 2] + d.oz, x1 = b[o + 3] + d.ox, z1 = b[o + 5] + d.oz;
            const ddx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
            const ddz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
            if (ddx * ddx + ddz * ddz > rr) continue;
            if (n >= cap) return n;
            const w = n * 6;
            out[w] = x0; out[w + 1] = b[o + 1]; out[w + 2] = z0; out[w + 3] = x1; out[w + 4] = b[o + 4]; out[w + 5] = z1;
            n++;
          }
        }
      }
      return n;
    },

    portalAt(x, y, z) {
      const d0 = locate(x, z);
      if (!d0) return null;
      // the chunk of the point, plus neighbours when within one cell of a chunk border
      const nearW = lx < CELL, nearE = lx > CHUNK_SIZE - CELL, nearN = lz < CELL, nearS = lz > CHUNK_SIZE - CELL;
      const cx = d0.key.cx, cz = d0.key.cz;
      const sd = dataOf();
      for (let dz = nearN ? -1 : 0; dz <= (nearS ? 1 : 0); dz++) {
        for (let dx = nearW ? -1 : 0; dx <= (nearE ? 1 : 0); dx++) {
          const d = dx === 0 && dz === 0 ? d0 : sd.get(cx + dx, cz + dz);
          if (!d) continue;
          const px = x - d.ox, pz = z - d.oz;
          for (let i = 0; i < d.portals.length; i++) {
            const p = d.portals[i], s = p.spec;
            if (px >= s.min[0] && px <= s.max[0] && y >= s.min[1] && y <= s.max[1] && pz >= s.min[2] && pz <= s.max[2]) return p;
          }
        }
      }
      return null;
    },

    portalsNear(x, z, r, out) {
      qx = x; qz = z; qr = r; qn = 0; qPortals = out;
      chunkRange(x - r, z - r, x + r, z + r, portalScan);
      out.length = qn;
      return qn;
    },

    propAt(x, z, yaw, maxDist) {
      pdx = -Math.sin(yaw); pdz = -Math.cos(yaw);
      // walls between the player and a prop hide it (door leaves sit in openings, which are open at 1.2 m)
      pmax = Math.min(maxDist, q.rayDistance(x, 1.2, z, pdx, pdz, maxDist) + 0.3);
      pbest = Infinity;
      qx = x; qz = z;
      const ex = x + pdx * pmax, ez = z + pdz * pmax;
      chunkRange(Math.min(x, ex) - 3, Math.min(z, ez) - 3, Math.max(x, ex) + 3, Math.max(z, ez) + 3, propScan);
      return pbest <= pmax ? hit : null;
    },

    layoutAt(cx, cz) {
      return dataOf().get(cx, cz)?.layout ?? null;
    },

    zoneAt(x, z) {
      const d = locate(x, z);
      if (!d) return Zone.LOBBY;
      const f = d.layout.flags[ci];
      if (f & (CellFlag.TOWER | CellFlag.ELEVATOR)) return STRUCTURE_ZONE;
      return d.layout.cellZone[ci] as ZoneId;
    },

    moodAt(x, z) {
      const d = locate(x, z);
      if (!d) return Mood.NORMAL;
      if (d.layout.flags[ci] & (CellFlag.TOWER | CellFlag.ELEVATOR)) return Mood.NORMAL;
      return d.layout.mood as MoodId;
    },

    fixturesNear(x, z, r, out) {
      qx = x; qz = z; qr = r; qn = 0; qFixtures = out;
      chunkRange(x - r, z - r, x + r, z + r, fixtureScan);
      out.length = qn;
      return qn;
    },

    emittersNear(x, z, r, out) {
      qx = x; qz = z; qr = r; qn = 0; qEmitters = out;
      chunkRange(x - r, z - r, x + r, z + r, emitterScan);
      out.length = qn;
      return qn;
    },

    losClear(ax, ay, az, bx, by, bz) {
      return march(ax, ay, az, bx, by, bz) > 1;
    },

    rayDistance(x, y, z, dx, dz, maxDist) {
      const len = Math.sqrt(dx * dx + dz * dz);
      if (!(len > 0) || !(maxDist > 0)) return 0;
      const ux = dx / len, uz = dz / len;
      // unloaded chunks occlude, so no ray is ever clear beyond the loaded area: march at most MAX_RAY metres
      const md = maxDist < MAX_RAY ? maxDist : MAX_RAY;
      const s = march(x, y, z, x + ux * md, y, z + uz * md);
      return s > 1 ? maxDist : s * md;
    },

    edgeSound(axis, gi, gj) {
      const d = locateCell(gi, gj);
      if (!d) return 0;
      const li = gi - d.key.cx * CHUNK_CELLS, lj = gj - d.key.cz * CHUNK_CELLS;
      const k = axis === 'x' ? d.layout.ex.kind[exIdx(li, lj)] : d.layout.ez.kind[ezIdx(li, lj)];
      return EDGE_SOUND[k] ?? 0;
    },

    cellWalkable(gi, gj) {
      const d = locateCell(gi, gj);
      if (d === null) return false;
      const l = d.layout;
      if ((l.flags[ci] & NOT_WALKABLE) !== 0) return false;
      if (l.blockCm[ci] > STEP_CM) return false; // cell-filling blocker (rack, counter) taller than a step
      const w = l.waterCm[ci];
      return w === NO_WATER || w - l.floorCm[ci] <= WADE_CM; // deeper water is swum over by nobody
    },
  };
  return q;
}
