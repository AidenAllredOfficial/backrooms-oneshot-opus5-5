// src/world/content/props.ts — rule-driven prop placement (WP4).
//
// Rules are evaluated per 8x8-cell window of walkable area (never per labelled room: LOBBY "rooms" are huge and
// irregular): count = round(per100m2 * area / 100 * (0.5 + decay)). Placement modes:
//   wall        back against a wall face, facing the room, slid along the wall
//   corner      tucked into a cell corner formed by two perpendicular walls
//   center      at the local maximum of the distance-to-wall transform nearest a hashed cell (within the window)
//   wallMounted on a wall face at yCm above the floor (yCm < 0: |yCm| below the ceiling)
//   aisle       centred in a corridor-like cell (free run <= 2 cells across), along the aisle
//   cluster     2-5 of a kind within 1.5 m of a hashed spot
// Props never overlap walls (0.15 m edge boxes, posts), solids, other props or keepClear cells, and a COLLIDE prop
// is rejected if it would split walkable space (0.3 m configuration-space flood, see occupancy.ts).

import { CELL, CHUNK_SIZE, WALL_T } from '../../core/constants.ts';
import {
  CeilKind, CellFlag, DecalKind, PROP_DEFS, PropKind, SALT, SolidFlag, TileState, Zone, cellIdx, getTile, rngFor, setTile, worldToCell,
} from '../../core/index.ts';
import type { DecalPlacement, PropKindId, PropPlacement, PropRule, PropRuleSet, Rng, ZoneGenContext } from '../../core/index.ts';
import { yawOf } from '../structures/frame.ts';
import { OCC_N, OCC_RES, PlacementSpace } from './occupancy.ts';
import { canStep, DX, DZ, isOpenFloor, isSeamSide, isWallKind, N, sideHA, sideIsWall, sideKind } from './util.ts';

const WIN = 8;
const T2 = WALL_T / 2;

/** Default flags for a prop: its PROP_DEFS collide/occlude bits (explicit, so either reading of the override
 * convention yields the table default). */
export const defaultPropFlags = (kind: PropKindId): number =>
  (PROP_DEFS[kind].collide ? SolidFlag.COLLIDE : 0) | (PROP_DEFS[kind].occlude ? SolidFlag.OCCLUDE : 0);

/** Shared state of one placement pass. */
export class PropPlacer {
  readonly ctx: ZoneGenContext;
  space: PlacementSpace;
  private byKind = new Map<number, number[]>();
  constructor(ctx: ZoneGenContext, keepClear: Uint8Array) {
    this.ctx = ctx;
    this.space = new PlacementSpace(ctx.grid.layout, keepClear);
    for (const p of ctx.grid.layout.props) this.note(p.kind, p.x, p.z);
  }
  /** Rebuild the placement space from the layout (after edges were carved or props removed). */
  rebuild(): void {
    this.space = new PlacementSpace(this.ctx.grid.layout, this.space.keep);
  }
  /** Add a prop without a fit test (stacked items resting on a checked base); still recorded for later tests. */
  place(p: PropPlacement): PropPlacement {
    this.ctx.grid.addProp(p);
    this.space.commit(p);
    this.note(p.kind, p.x, p.z);
    return p;
  }
  private note(kind: number, x: number, z: number): void {
    let a = this.byKind.get(kind);
    if (!a) this.byKind.set(kind, (a = []));
    a.push(x, z);
  }
  spacingOk(kind: number, x: number, z: number, minSpacing: number): boolean {
    if (minSpacing <= 0) return true;
    const a = this.byKind.get(kind);
    if (!a) return true;
    const m2 = minSpacing * minSpacing;
    for (let i = 0; i < a.length; i += 2) {
      const dx = a[i] - x, dz = a[i + 1] - z;
      if (dx * dx + dz * dz < m2) return false;
    }
    return true;
  }
  /** Try to place; returns the placement or null. */
  tryPlace(kind: PropKindId, variant: number, x: number, y: number, z: number, yaw: number, seed: number,
    o: { wallMounted?: boolean; minSpacing?: number; flags?: number; allowKeepClear?: boolean; ignoreKinds?: readonly number[] } = {}): PropPlacement | null {
    if (!this.spacingOk(kind, x, z, o.minSpacing ?? 0)) return null;
    if (!this.space.fits(kind, x, z, yaw, y, { wallMounted: o.wallMounted, allowKeepClear: o.allowKeepClear, ignoreKinds: o.ignoreKinds })) return null;
    const p: PropPlacement = { kind, variant, x, y, z, yaw, scale: 1, flags: o.flags ?? defaultPropFlags(kind), seed };
    this.ctx.grid.addProp(p);
    this.space.commit(p);
    this.note(kind, x, z);
    return p;
  }
}

/** Open cells of an 8x8 window. */
function windowCells(ctx: ZoneGenContext, wi: number, wj: number): number[] {
  const l = ctx.grid.layout;
  const out: number[] = [];
  for (let lj = wj * WIN; lj < (wj + 1) * WIN; lj++) for (let li = wi * WIN; li < (wi + 1) * WIN; li++) {
    const c = cellIdx(li, lj);
    if (isOpenFloor(l, c)) out.push(c);
  }
  return out;
}

/** Free run of walkable cells through (li, lj) along axis (0 = x, 1 = z), capped at `cap` each way. */
export function freeRun(ctx: ZoneGenContext, li: number, lj: number, axis: 0 | 1, cap = 6): number {
  const l = ctx.grid.layout;
  let n = 1;
  for (const d of axis === 0 ? [0, 1] : [2, 3]) {
    let i = li, j = lj;
    for (let k = 0; k < cap; k++) {
      if (!canStep(l, i, j, d)) break;
      i += DX[d]; j += DZ[d]; n++;
    }
  }
  return n;
}

/** Wall-face anchor of side d of a cell at fraction t along it, pushed `out` metres into the cell. */
function faceAnchor(li: number, lj: number, d: number, t: number, out: number): { x: number; z: number; yaw: number; nx: number; nz: number } {
  const nx = -DX[d], nz = -DZ[d];
  const cx = (li + 0.5) * CELL, cz = (lj + 0.5) * CELL;
  const fx = cx + DX[d] * (CELL / 2 - T2), fz = cz + DZ[d] * (CELL / 2 - T2);
  const along = (t - 0.5) * CELL;
  return { x: fx + nx * out + (DZ[d] !== 0 ? along : 0), z: fz + nz * out + (DX[d] !== 0 ? along : 0), yaw: yawOf(nx, nz), nx, nz };
}

function placeOne(pl: PropPlacer, rule: PropRule, cells: number[], wi: number, wj: number, rng: Rng): boolean {
  const ctx = pl.ctx, l = ctx.grid.layout;
  const def = PROP_DEFS[rule.kind];
  const variant = rule.variants > 1 ? rng.int(0, rule.variants - 1) : 0;
  const c = cells[rng.int(0, cells.length - 1)];
  const li = c & 31, lj = c >> 5;
  const floor = l.floorCm[c] / 100;
  const depth = def.size[2], width = def.size[0];
  switch (rule.where) {
    case 'wall': {
      const sides: number[] = [];
      for (let d = 0; d < 4; d++) if (sideIsWall(l, li, lj, d)) sides.push(d);
      if (sides.length === 0) return false;
      const d = sides[rng.int(0, sides.length - 1)];
      const a = faceAnchor(li, lj, d, rng.range(0.15, 0.85), depth / 2 + 0.015);
      return pl.tryPlace(rule.kind, variant, a.x, floor, a.z, a.yaw, rng.next(), { minSpacing: rule.minSpacing }) !== null;
    }
    case 'corner': {
      const xs: number[] = [], zs: number[] = [];
      for (const d of [0, 1]) if (sideIsWall(l, li, lj, d)) xs.push(d);
      for (const d of [2, 3]) if (sideIsWall(l, li, lj, d)) zs.push(d);
      if (xs.length === 0 || zs.length === 0) return false;
      const dx = xs[rng.int(0, xs.length - 1)], dz = zs[rng.int(0, zs.length - 1)];
      const backX = rng.chance(0.5); // back against the x-facing wall (d = dx) or the z-facing one
      const nxw = -DX[dx], nzw = -DZ[dz];
      const yaw = backX ? yawOf(nxw, 0) : yawOf(0, nzw);
      const ex = backX ? depth / 2 : width / 2, ez = backX ? width / 2 : depth / 2; // half extents along x / z
      const x = (li + 0.5) * CELL + DX[dx] * (CELL / 2 - T2 - ex - 0.015);
      const z = (lj + 0.5) * CELL + DZ[dz] * (CELL / 2 - T2 - ez - 0.015);
      return pl.tryPlace(rule.kind, variant, x, floor, z, yaw, rng.next(), { minSpacing: rule.minSpacing }) !== null;
    }
    case 'center': {
      const D = pl.space.distance();
      let px = Math.min(OCC_N - 1, Math.floor(((li + 0.5) * CELL) / OCC_RES)), pz = Math.min(OCC_N - 1, Math.floor(((lj + 0.5) * CELL) / OCC_RES));
      const p0x = wi * WIN * 4, p0z = wj * WIN * 4, p1x = p0x + WIN * 4 - 1, p1z = p0z + WIN * 4 - 1;
      for (let it = 0; it < 64; it++) {
        let best = D[pz * OCC_N + px], bx = px, bz = pz;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, nz = pz + dz;
          if (nx < p0x || nz < p0z || nx > p1x || nz > p1z) continue;
          const v = D[nz * OCC_N + nx];
          if (v > best) { best = v; bx = nx; bz = nz; }
        }
        if (bx === px && bz === pz) break;
        px = bx; pz = bz;
      }
      if (D[pz * OCC_N + px] < 1) return false;
      const x = (px + 0.5) * OCC_RES, z = (pz + 0.5) * OCC_RES;
      const cc = cellIdx(Math.floor(x / CELL), Math.floor(z / CELL));
      const yaw = rng.int(0, 3) * (Math.PI / 2) + (rng.chance(0.5) ? rng.range(-0.35, 0.35) : 0);
      return pl.tryPlace(rule.kind, variant, x, l.floorCm[cc] / 100, z, yaw, rng.next(), { minSpacing: rule.minSpacing }) !== null;
    }
    case 'wallMounted': {
      const sides: number[] = [];
      for (let d = 0; d < 4; d++) if (isWallKind(sideKind(l, li, lj, d))) sides.push(d);
      if (sides.length === 0) return false;
      const d = sides[rng.int(0, sides.length - 1)];
      const kind = sideKind(l, li, lj, d);
      const y = rule.yCm < 0 ? l.ceilCm[c] / 100 + rule.yCm / 100 : floor + rule.yCm / 100;
      const top = kind === 1 /* WALL */ ? l.ceilCm[c] / 100 : kind === 8 /* WINDOW */ ? floor + sideHA(l, li, lj, d) / 100 : sideHA(l, li, lj, d) / 100;
      if (y < floor + 0.02 || y + def.size[1] > top - 0.02) return false;
      const hw = width / 2 / CELL;
      if (hw > 0.4) return false;
      const t = rng.range(0.1 + hw, 0.9 - hw);
      const a = faceAnchor(li, lj, d, t, depth / 2 + 0.003);
      return pl.tryPlace(rule.kind, variant, a.x, y, a.z, a.yaw, rng.next(), { wallMounted: true, minSpacing: rule.minSpacing }) !== null;
    }
    case 'aisle': {
      const rx = freeRun(ctx, li, lj, 0), rz = freeRun(ctx, li, lj, 1);
      let axis: 0 | 1;
      if (rx >= 3 && rz <= 2) axis = 0; else if (rz >= 3 && rx <= 2) axis = 1; else return false;
      const [x, z] = ctx.grid.cellCenter(li, lj);
      const yaw = axis === 0 ? (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2) : (rng.chance(0.5) ? 0 : Math.PI);
      return pl.tryPlace(rule.kind, variant, x, floor, z, yaw, rng.next(), { minSpacing: rule.minSpacing }) !== null;
    }
    case 'cluster': {
      const [cx, cz] = ctx.grid.cellCenter(li, lj);
      if (!pl.spacingOk(rule.kind, cx, cz, Math.max(rule.minSpacing, 1.5))) return false;
      const n = rng.int(2, 5);
      let k = 0;
      for (let a = 0; a < n * 4 && k < n; a++) {
        let ox = rng.range(-1.5, 1.5), oz = rng.range(-1.5, 1.5);
        if (ox * ox + oz * oz > 2.25) { ox *= 0.5; oz *= 0.5; }
        const x = cx + ox, z = cz + oz;
        const lc = cellIdx(Math.min(N - 1, Math.max(0, Math.floor(x / CELL))), Math.min(N - 1, Math.max(0, Math.floor(z / CELL))));
        const yaw = rng.int(0, 3) * (Math.PI / 2) + (rng.chance(0.6) ? rng.range(-0.4, 0.4) : 0);
        if (pl.tryPlace(rule.kind, variant, x, l.floorCm[lc] / 100, z, yaw, rng.next()) !== null) k++;
      }
      return k >= 2 || (k === 1 && n === 1);
    }
    default:
      return false;
  }
}

export function placeProps(ctx: ZoneGenContext, rules: PropRuleSet, keepClear: Uint8Array): void {
  if (rules.rules.length === 0) return;
  const l = ctx.grid.layout, key = ctx.key;
  const rng = rngFor(ctx.seed, SALT.PROP, key.s, key.cx, key.cz);
  const pl = new PropPlacer(ctx, keepClear);
  for (let wj = 0; wj < N / WIN; wj++) {
    for (let wi = 0; wi < N / WIN; wi++) {
      const cells = windowCells(ctx, wi, wj);
      if (cells.length === 0) continue;
      let dsum = 0;
      for (const c of cells) dsum += l.decay[c];
      const decay = dsum / cells.length / 256;
      const area = cells.length * CELL * CELL;
      const wr = rng.fork(wj * 4 + wi);
      for (const rule of rules.rules) {
        const count = Math.round(rule.per100m2 * area / 100 * (0.5 + decay));
        let placed = 0;
        for (let attempts = count * 6; placed < count && attempts > 0; attempts--) {
          if (placeOne(pl, rule, cells, wi, wj, wr)) placed++;
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------ R2 (B6): traces
// The "lived-in" layer: small signs that somebody was here, between the vignettes. One trace per TRACE_M2 m² of
// Level 0 floor at zone weight 1 and decay 0.5 (count per 8x8 window = floor(area / TRACE_M2 * zoneW * (0.4 + 1.2 *
// decay) + u)), kinds weighted by decay (neat stray chairs / boxes / papers where it is maintained, wet patches,
// fallen tiles and trash where it rots). Traces keep TRACE_SPACING from each other and TRACE_VIG_CLEAR from vignette
// anchors. rng = rngFor(seed, SALT.PROP, s, cx, cz, TRACE_TAG): independent of the rule props.

export const TRACE_M2 = 45;
export const TRACE_SPACING = 3.2;
export const TRACE_VIG_CLEAR = 3;
const TRACE_TAG = 0x7ace;
/** Trace weight per Level 0 zone (index = Zone id; deep zones 0). PILLAR_HALL / LOW_EXPANSE stay sparse. */
export const TRACE_ZONE_W: readonly number[] = [1.0, 1.0, 1.1, 0.8, 0.3, 0.25, 0.6];
export const TraceKind = {
  STRAY_CHAIR: 0, OFFICE_CHAIR: 1, PAPERS: 2, BOXES: 3, WET_PATCH: 4, BUCKET_MOP: 5, TRASH: 6, FALLEN_TILE: 7,
  DOOR_LEANING: 8, BOTTLES: 9, CHAIR_STACK: 10,
} as const;
/** [weight at decay 0, weight at decay 1] per TraceKind. */
export const TRACE_W: readonly (readonly [number, number])[] = [
  [10, 6], [4, 2], [9, 7], [8, 5], [3, 9], [4, 4], [4, 7], [2, 8], [1, 2], [3, 6], [3, 2],
];

interface Face { x: number; z: number; nx: number; nz: number; tx: number; tz: number; y: number; c: number }

/** Wall faces of a cell (wall-like side, not a chunk seam), as face points (on the wall surface) + inward normal. */
function facesOf(l: ZoneGenContext['grid']['layout'], c: number): Face[] {
  const li = c & 31, lj = c >> 5;
  const out: Face[] = [];
  for (let d = 0; d < 4; d++) {
    if (isSeamSide(li, lj, d) || !sideIsWall(l, li, lj, d)) continue;
    const nx = -DX[d], nz = -DZ[d];
    const x = (li + 0.5) * CELL + DX[d] * (CELL / 2 - T2), z = (lj + 0.5) * CELL + DZ[d] * (CELL / 2 - T2);
    out.push({ x, z, nx, nz, tx: Math.abs(nz), tz: Math.abs(nx), y: l.floorCm[c] / 100, c });
  }
  return out;
}

/** Linear tint of loose paper on the floor: aged, yellowed office paper rather than a white sprite. */
export const PAPER_TINT: [number, number, number] = [0.74, 0.69, 0.55];
const floorPaper = (x: number, y: number, z: number, rot: number, alpha: number): DecalPlacement => ({
  kind: DecalKind.PAPER, sign: false, px: x, py: y, pz: z, nx: 0, ny: 1, nz: 0, rot, w: 0.21, h: 0.297, alpha: alpha * 0.85, color: PAPER_TINT,
});

/** A floor decal centre that stays on open floor of the same height inside the chunk. */
function floorSpot(l: ZoneGenContext['grid']['layout'], x: number, z: number, y: number, r: number): boolean {
  if (x - r < 0.02 || z - r < 0.02 || x + r > CHUNK_SIZE - 0.02 || z + r > CHUNK_SIZE - 0.02) return false;
  const c = cellIdx(worldToCell(x), worldToCell(z));
  return isOpenFloor(l, c) && l.floorCm[c] / 100 === y;
}

/** Run one trace composition at cell c; true if anything was placed. Exported for tests. */
export function composeTrace(pl: PropPlacer, kind: number, c: number, rng: Rng): boolean {
  const ctx = pl.ctx, g = ctx.grid, l = g.layout;
  const li = c & 31, lj = c >> 5;
  const y = l.floorCm[c] / 100, ceil = l.ceilCm[c] / 100;
  const [cx, cz] = g.cellCenter(li, lj);
  const faces = facesOf(l, c);
  const face = faces.length > 0 ? faces[rng.int(0, faces.length - 1)] : null;
  const along = (f: Face, t: number, out: number): [number, number] => [f.x + f.nx * out + f.tx * t, f.z + f.nz * out + f.tz * t];
  const free = rng.range(0, Math.PI * 2);
  switch (kind) {
    case TraceKind.STRAY_CHAIR: {
      let p: PropPlacement | null = null;
      if (face && rng.chance(0.5)) {
        const [x, z] = along(face, rng.range(-0.3, 0.3), rng.range(0.35, 0.7));
        p = pl.tryPlace(PropKind.CHAIR_STACKING, rng.int(0, 3), x, y, z, yawOf(face.nx, face.nz) + Math.PI + rng.range(-0.9, 0.9), rng.next());
      } else {
        p = pl.tryPlace(PropKind.CHAIR_STACKING, rng.int(0, 3), cx + rng.range(-0.25, 0.25), y, cz + rng.range(-0.25, 0.25), free, rng.next());
      }
      if (p && rng.chance(0.35)) {
        const a = rng.range(0, Math.PI * 2);
        pl.tryPlace(PropKind.CHAIR_STACKING, p.variant, p.x + Math.cos(a) * 0.75, y, p.z + Math.sin(a) * 0.75, rng.range(0, Math.PI * 2), rng.next());
      }
      return p !== null;
    }
    case TraceKind.OFFICE_CHAIR: {
      const z0 = l.cellZone[c];
      if (z0 !== Zone.OFFICE && z0 !== Zone.MANILA && z0 !== Zone.LOBBY && z0 !== Zone.DARK) return false;
      return pl.tryPlace(PropKind.OFFICE_CHAIR, rng.int(0, 3), cx + rng.range(-0.3, 0.3), y, cz + rng.range(-0.3, 0.3), free, rng.next()) !== null;
    }
    case TraceKind.PAPERS: {
      let px = cx + rng.range(-0.3, 0.3), pz = cz + rng.range(-0.3, 0.3);
      if (face && rng.chance(0.5)) [px, pz] = along(face, rng.range(-0.3, 0.3), rng.range(0.3, 0.6));
      let n = 0;
      for (let k = 0, m = rng.int(3, 7); k < m; k++) {
        const r = Math.sqrt(rng.next() / 4294967296) * 0.9, a = rng.range(0, Math.PI * 2);
        const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
        if (!floorSpot(l, x, z, y, 0.2)) continue;
        g.addDecal(floorPaper(x, y, z, rng.range(0, Math.PI * 2), rng.range(0.75, 0.95)));
        n++;
      }
      if (n > 0 && rng.chance(0.3)) pl.tryPlace(PropKind.CARDBOARD_BOX, rng.int(0, 3), px + rng.range(-0.6, 0.6), y, pz + rng.range(-0.6, 0.6), rng.range(0, 6.28), rng.next());
      if (n > 0 && rng.chance(0.25)) pl.tryPlace(PropKind.BOTTLE, rng.int(0, 3), px + rng.range(-0.7, 0.7), y, pz + rng.range(-0.7, 0.7), rng.range(0, 6.28), rng.next());
      return n > 0;
    }
    case TraceKind.BOXES: {
      if (!face) return false;
      const n = rng.int(1, 3), t0 = rng.range(-0.3, 0.3);
      let first: PropPlacement | null = null, placed = 0;
      for (let k = 0; k < n; k++) {
        const [x, z] = along(face, t0 + (k - (n - 1) / 2) * 0.53, 0.22 + rng.range(0, 0.05));
        const b = pl.tryPlace(PropKind.CARDBOARD_BOX, rng.int(0, 3), x, y, z, yawOf(face.nx, face.nz), rng.next());
        if (b) { placed++; first ??= b; }
      }
      if (first && rng.chance(0.5) && ceil - y > 1.2) {
        pl.place({ ...first, variant: rng.int(0, 3), y: y + 0.4, yaw: first.yaw + rng.range(-0.25, 0.25), x: first.x + rng.range(-0.04, 0.04), z: first.z + rng.range(-0.04, 0.04), seed: rng.next() });
      }
      return placed > 0;
    }
    case TraceKind.WET_PATCH: {
      if (!isOpenFloor(l, c)) return false;
      const cells = [c];
      for (let d = 0; d < 4 && cells.length < 1 + rng.int(0, 2); d++) {
        const dd = rng.int(0, 3);
        if (!canStep(l, li, lj, dd)) continue;
        const n = cellIdx(li + DX[dd], lj + DZ[dd]);
        if (isOpenFloor(l, n) && !cells.includes(n)) cells.push(n);
      }
      for (const w of cells) g.setCells(w & 31, w >> 5, (w & 31) + 1, (w >> 5) + 1, { flagsSet: CellFlag.WET });
      const sx = cx + rng.range(-0.2, 0.2), sz = cz + rng.range(-0.2, 0.2), sw = rng.range(1.0, 1.7);
      if (floorSpot(l, sx, sz, y, sw / 2)) g.addDecal({ kind: DecalKind.WATER_STAIN, sign: false, px: sx, py: y, pz: sz, nx: 0, ny: 1, nz: 0, rot: rng.range(0, 6.28), w: sw, h: sw * rng.range(0.7, 1), alpha: rng.range(0.45, 0.7) });
      const fr = rng.range(0, Math.PI * 2), fx = sx - Math.sin(fr) * 0.9, fz = sz - Math.cos(fr) * 0.9;
      if (floorSpot(l, fx, fz, y, 0.6)) g.addDecal({ kind: DecalKind.FOOTPRINTS_WET, sign: false, px: fx, py: y, pz: fz, nx: 0, ny: 1, nz: 0, rot: fr, w: 0.5, h: 1.1, alpha: 0.7 });
      if (rng.chance(0.35)) pl.tryPlace(PropKind.BUCKET, rng.int(0, 3), sx + rng.range(-0.3, 0.3), y, sz + rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.next());
      return true;
    }
    case TraceKind.BUCKET_MOP: {
      if (!face) return false;
      const [x, z] = along(face, rng.range(-0.3, 0.3), 0.2);
      const b = pl.tryPlace(PropKind.BUCKET, rng.int(0, 3), x, y, z, yawOf(face.nx, face.nz) + rng.int(0, 3) * (Math.PI / 2), rng.next());
      if (!b) return false;
      if (rng.chance(0.55)) pl.place({ kind: PropKind.MOP, variant: 3, x, y: y + 0.03, z, yaw: yawOf(face.nx, face.nz) + rng.range(-0.4, 0.4), scale: 1, flags: 0, seed: rng.next() });
      else {
        const [mx, mz] = along(face, (b.x - face.x) * face.tx + (b.z - face.z) * face.tz + (rng.chance(0.5) ? 0.36 : -0.36), 0.17);
        pl.tryPlace(PropKind.MOP, rng.chance(0.5) ? 3 : 0, mx, y, mz, rng.range(0, 6.28), rng.next());
      }
      return true;
    }
    case TraceKind.TRASH: {
      if (!face) return false;
      const [x, z] = along(face, rng.range(-0.35, 0.35), 0.23);
      const t = pl.tryPlace(PropKind.TRASH_CAN, rng.int(0, 3), x, y, z, yawOf(face.nx, face.nz), rng.next());
      if (!t) return false;
      for (let k = 0, n = rng.int(1, 3); k < n; k++) {
        pl.tryPlace(PropKind.BOTTLE, rng.int(0, 3), x + face.nx * rng.range(0.3, 0.8) + face.tx * rng.range(-0.6, 0.6), y, z + face.nz * rng.range(0.3, 0.8) + face.tz * rng.range(-0.6, 0.6), rng.range(0, 6.28), rng.next());
      }
      for (let k = 0, n = rng.int(0, 2); k < n; k++) {
        const px = x + face.nx * rng.range(0.3, 0.9) + face.tx * rng.range(-0.7, 0.7), pz = z + face.nz * rng.range(0.3, 0.9) + face.tz * rng.range(-0.7, 0.7);
        if (floorSpot(l, px, pz, y, 0.2)) g.addDecal(floorPaper(px, y, pz, rng.range(0, 6.28), 0.85));
      }
      return true;
    }
    case TraceKind.FALLEN_TILE: {
      if (l.ceilKind[c] !== CeilKind.TILES || (l.flags[c] & CellFlag.NO_CEIL) !== 0) return false;
      const ts: number[] = [];
      for (let t = 0; t < 4; t++) { const st = getTile(l.tiles, c, t); if (st === TileState.NORMAL || st === TileState.STAINED || st === TileState.DIRTY) ts.push(t); }
      if (ts.length === 0) return false;
      const t = ts[rng.int(0, ts.length - 1)];
      const x = (li + 0.25 + 0.5 * (t & 1)) * CELL, z = (lj + 0.25 + 0.5 * (t >> 1)) * CELL;
      const f = pl.tryPlace(PropKind.TILE_FRAGMENT, rng.int(0, 3), x + rng.range(-0.2, 0.2), y, z + rng.range(-0.2, 0.2), rng.range(0, 6.28), rng.next(), { allowKeepClear: true });
      if (!f) return false;
      setTile(l.tiles, c, t, TileState.MISSING);
      if (rng.chance(0.5)) pl.tryPlace(PropKind.TILE_FRAGMENT, rng.int(0, 3), x + rng.range(-0.5, 0.5), y, z + rng.range(-0.5, 0.5), rng.range(0, 6.28), rng.next(), { allowKeepClear: true });
      return true;
    }
    case TraceKind.DOOR_LEANING: {
      if (!face || ceil - y < 2.2) return false;
      const [x, z] = along(face, rng.range(-0.1, 0.1), 0.06);
      return pl.tryPlace(PropKind.DOOR_LEAF, rng.int(0, 3), x, y, z, yawOf(face.nx, face.nz) + (rng.chance(0.5) ? Math.PI : 0), rng.next()) !== null;
    }
    case TraceKind.BOTTLES: {
      const base = face ? along(face, rng.range(-0.4, 0.4), rng.range(0.08, 0.25)) : [cx, cz];
      let n = 0;
      for (let k = 0, m = rng.int(1, 3); k < m; k++) {
        if (pl.tryPlace(PropKind.BOTTLE, rng.int(0, 3), base[0] + rng.range(-0.25, 0.25) * (face ? face.tx || 0.3 : 1), y, base[1] + rng.range(-0.25, 0.25) * (face ? face.tz || 0.3 : 1), rng.range(0, 6.28), rng.next(), { allowKeepClear: true })) n++;
      }
      return n > 0;
    }
    case TraceKind.CHAIR_STACK: {
      if (!face) return false;
      const [x, z] = along(face, rng.range(-0.3, 0.3), 0.32);
      const yaw = yawOf(face.nx, face.nz) + Math.PI;
      const b = pl.tryPlace(PropKind.CHAIR_STACKING, rng.int(0, 3), x, y, z, yaw, rng.next());
      if (!b) return false;
      stackChairs(pl, b, rng.int(2, 6), ceil, rng);
      return true;
    }
    default:
      return false;
  }
}

/** Stack `n` more stacking chairs on a placed one (nested: +5.5 cm and 1.5 cm back per chair), under the ceiling. */
export function stackChairs(pl: PropPlacer, base: PropPlacement, n: number, ceil: number, rng: Rng): number {
  const fw = { x: -Math.sin(base.yaw), z: -Math.cos(base.yaw) };
  let k = 0;
  for (; k < n; k++) {
    const yy = base.y + (k + 1) * 0.055;
    if (yy + 0.82 > ceil - 0.08) break;
    pl.place({ ...base, x: base.x - fw.x * 0.015 * (k + 1), z: base.z - fw.z * 0.015 * (k + 1), y: yy, yaw: base.yaw + rng.range(-0.03, 0.03), seed: rng.next() });
  }
  return k;
}

export function placeTraces(ctx: ZoneGenContext, pl: PropPlacer): void {
  const l = ctx.grid.layout, key = ctx.key;
  const rng = rngFor(ctx.seed, SALT.PROP, key.s, key.cx, key.cz, TRACE_TAG);
  const keep = pl.space.keep;
  const placed: [number, number][] = [];
  const clear = (x: number, z: number): boolean => {
    for (const v of l.vignettes) if ((v.x - x) * (v.x - x) + (v.z - z) * (v.z - z) < TRACE_VIG_CLEAR * TRACE_VIG_CLEAR) return false;
    for (const [px, pz] of placed) if ((px - x) * (px - x) + (pz - z) * (pz - z) < TRACE_SPACING * TRACE_SPACING) return false;
    return true;
  };
  for (let wj = 0; wj < N / WIN; wj++) {
    for (let wi = 0; wi < N / WIN; wi++) {
      const wr = rng.fork(wj * 4 + wi);
      const cells: number[] = [];
      let zw = 0, dsum = 0;
      for (let lj = wj * WIN; lj < (wj + 1) * WIN; lj++) for (let li = wi * WIN; li < (wi + 1) * WIN; li++) {
        const c = cellIdx(li, lj);
        const z = l.cellZone[c];
        if (z > Zone.OFFICE || !isOpenFloor(l, c) || keep[c] || (l.flags[c] & (CellFlag.LANDMARK | CellFlag.RESERVED)) !== 0) continue;
        cells.push(c); zw += TRACE_ZONE_W[z]; dsum += l.decay[c];
      }
      if (cells.length === 0) continue;
      const decay = dsum / cells.length / 256;
      const expect = (cells.length * CELL * CELL) / TRACE_M2 * (zw / cells.length) * (0.4 + 1.2 * decay);
      const n = Math.floor(expect + wr.float());
      const w = TRACE_W.map(([a, b]) => a + (b - a) * decay);
      let sum = 0;
      for (const x of w) sum += x;
      for (let k = 0; k < n; k++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const c = cells[wr.int(0, cells.length - 1)];
          const [x, z] = ctx.grid.cellCenter(c & 31, c >> 5);
          if (!clear(x, z)) continue;
          let u = wr.float() * sum, kind = 0;
          while (kind < w.length - 1 && u >= w[kind]) { u -= w[kind]; kind++; }
          if (composeTrace(pl, kind, c, wr.fork(k * 8 + attempt))) { placed.push([x, z]); break; }
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------ R2 (B6): storage clusters
// PILLAR_HALL / LOW_EXPANSE stay sparse, but every district gets one big storage cluster in the chunk that contains
// its site (pallet stacks, a wall of boxes, stacked chairs or pushed-together desks), and other chunks of those
// districts a medium one with p CLUSTER_P. A cluster is planned on a scratch placement space and committed only if at
// least its minimum number of bases fit (walkable space stays connected: `fits` rejects splitting props).

export const CLUSTER_P = 0.22;
export const ClusterKind = { PALLETS: 0, BOXES: 1, CHAIRS: 2, DESKS: 3 } as const;
const CLUSTER_TAG = 0xc105;

interface Frame { x: number; z: number; nx: number; nz: number; tx: number; tz: number; y: number; ceil: number }

function planCluster(pl: PropPlacer, kind: number, f: Frame, big: boolean, rng: Rng): PropPlacement[] | null {
  const l = pl.ctx.grid.layout;
  const scratch = new PlacementSpace(l, pl.space.keep);
  const plan: PropPlacement[] = [];
  const at = (t: number, out: number): [number, number] => [f.x + f.nx * out + f.tx * t, f.z + f.nz * out + f.tz * t];
  const face = yawOf(f.nx, f.nz); // local -Z toward the room
  const base = (k: PropKindId, v: number, x: number, z: number, yaw: number): PropPlacement | null => {
    if (!scratch.fits(k, x, z, yaw, f.y)) return null;
    const p: PropPlacement = { kind: k, variant: v, x, y: f.y, z, yaw, scale: 1, flags: defaultPropFlags(k), seed: rng.next() };
    scratch.commit(p); plan.push(p);
    return p;
  };
  const onTop = (p: PropPlacement, k: PropKindId, v: number, dy: number, jx = 0, jz = 0, dyaw = 0): PropPlacement | null => {
    const h = PROP_DEFS[k].size[1];
    if (p.y + dy + h > f.ceil - 0.1) return null;
    const q: PropPlacement = { kind: k, variant: v, x: p.x + jx, y: p.y + dy, z: p.z + jz, yaw: p.yaw + dyaw, scale: 1, flags: defaultPropFlags(k), seed: rng.next() };
    plan.push(q);
    return q;
  };
  let bases = 0, need = 2;
  switch (kind) {
    case ClusterKind.PALLETS: {
      const n = big ? rng.int(3, 5) : rng.int(2, 3);
      need = big ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const [x, z] = at((k - (n - 1) / 2) * 1.28, 0.56);
        const p = base(PropKind.PALLET, rng.int(0, 3), x, z, face);
        if (!p) continue;
        bases++;
        let top = p;
        for (let h = 1, m = rng.int(1, big ? 9 : 6); h < m; h++) top = onTop(top, PropKind.PALLET, rng.int(0, 3), 0.15, rng.range(-0.03, 0.03), rng.range(-0.03, 0.03), rng.range(-0.04, 0.04)) ?? top;
        if (rng.chance(0.5)) {
          for (let b = 0, m = rng.int(1, 4); b < m; b++) onTop(top, PropKind.CARDBOARD_BOX, rng.int(0, 3), 0.15, rng.range(-0.35, 0.35), rng.range(-0.3, 0.3), rng.range(-0.3, 0.3));
        }
      }
      // a loose pallet or two on the floor in front
      for (let k = 0, m = rng.int(0, 2); k < m; k++) {
        const [x, z] = at(rng.range(-2, 2), rng.range(1.8, 2.6));
        base(PropKind.PALLET, rng.int(0, 3), x, z, rng.int(0, 3) * (Math.PI / 2));
      }
      break;
    }
    case ClusterKind.BOXES: {
      const cols = big ? rng.int(5, 8) : rng.int(3, 5), rows = big ? 2 : rng.int(1, 2);
      need = Math.ceil(cols * rows / 2);
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
        const [x, z] = at((k - (cols - 1) / 2) * 0.52, 0.23 + r * 0.43);
        const p = base(PropKind.CARDBOARD_BOX, rng.int(0, 3), x, z, face);
        if (!p) continue;
        bases++;
        let top = p;
        for (let h = 1, m = rng.int(1, r === 0 ? 5 : 3); h < m; h++) top = onTop(top, PropKind.CARDBOARD_BOX, rng.int(0, 3), 0.4, rng.range(-0.03, 0.03), rng.range(-0.03, 0.03), rng.range(-0.08, 0.08)) ?? top;
      }
      for (let k = 0, m = rng.int(1, 4); k < m; k++) {
        const [x, z] = at(rng.range(-2.5, 2.5), rng.range(1.2, 2.2));
        base(PropKind.CARDBOARD_BOX, rng.int(0, 3), x, z, rng.int(0, 3) * (Math.PI / 2));
      }
      break;
    }
    case ClusterKind.CHAIRS: {
      const n = big ? rng.int(4, 7) : rng.int(2, 4);
      need = big ? 3 : 2;
      const v = rng.int(0, 3);
      for (let k = 0; k < n; k++) {
        const [x, z] = at((k - (n - 1) / 2) * 0.6, 0.34);
        const p = base(PropKind.CHAIR_STACKING, v, x, z, face + Math.PI);
        if (!p) continue;
        bases++;
        for (let h = 1, m = rng.int(3, big ? 12 : 8); h < m; h++) {
          if (!onTop(p, PropKind.CHAIR_STACKING, v, h * 0.055, 0, 0, rng.range(-0.03, 0.03))) break;
          const q = plan[plan.length - 1];
          q.x -= f.nx * -0.015 * h; q.z -= f.nz * -0.015 * h;
        }
      }
      for (let k = 0, m = rng.int(1, 3); k < m; k++) {
        const [x, z] = at(rng.range(-2, 2), rng.range(1.0, 2.0));
        base(PropKind.CHAIR_STACKING, v, x, z, rng.range(0, Math.PI * 2));
      }
      break;
    }
    default: { // DESKS: desks pushed together along the wall, chairs stacked on them, a filing cabinet
      const n = big ? rng.int(3, 5) : 2;
      for (let k = 0; k < n; k++) {
        const [x, z] = at((k - (n - 1) / 2) * 1.52, 0.4);
        const p = base(PropKind.DESK, rng.int(0, 3), x, z, face + Math.PI);
        if (!p) continue;
        bases++;
        for (let c = 0, m = rng.int(0, 2); c < m; c++) {
          const q = onTop(p, PropKind.CHAIR_STACKING, rng.int(0, 3), 0.75, (c - 0.5) * 0.6 * f.tx, (c - 0.5) * 0.6 * f.tz, rng.range(-0.3, 0.3));
          if (q && rng.chance(0.5)) for (let h = 1; h < rng.int(2, 4); h++) onTop(q, PropKind.CHAIR_STACKING, q.variant, h * 0.055);
        }
      }
      const [x, z] = at(((n + 1) / 2) * 1.52 - 0.2, 0.32);
      base(PropKind.FILING_CABINET, rng.int(0, 3), x, z, face);
      break;
    }
  }
  return bases >= need ? plan : null;
}

export function placeDistrictClusters(ctx: ZoneGenContext, pl: PropPlacer): void {
  const d = ctx.district;
  if (d.zone !== Zone.PILLAR_HALL && d.zone !== Zone.LOW_EXPANSE) return;
  const l = ctx.grid.layout, key = ctx.key;
  const rng = rngFor(ctx.seed, SALT.PROP, key.s, key.cx, key.cz, CLUSTER_TAG);
  const big = Math.floor(d.siteX) === key.cx && Math.floor(d.siteZ) === key.cz;
  if (!big && !rng.chance(CLUSTER_P)) return;
  const kind = rng.int(0, 3);
  const keep = pl.space.keep;
  // wall-backed anchors first (storage lines up against walls), then free-standing ones in the open
  const walls: Frame[] = [], open: Frame[] = [];
  const D = pl.space.distance();
  for (let c = 0; c < N * N; c++) {
    if (!isOpenFloor(l, c) || keep[c] || l.cellZone[c] !== d.zone || (l.flags[c] & (CellFlag.LANDMARK | CellFlag.RESERVED)) !== 0) continue;
    const y = l.floorCm[c] / 100, ceil = l.ceilCm[c] / 100;
    for (const f of facesOf(l, c)) walls.push({ x: f.x, z: f.z, nx: f.nx, nz: f.nz, tx: f.tx, tz: f.tz, y, ceil });
    const li = c & 31, lj = c >> 5;
    const px = Math.min(OCC_N - 1, Math.floor(((li + 0.5) * CELL) / OCC_RES)), pz = Math.min(OCC_N - 1, Math.floor(((lj + 0.5) * CELL) / OCC_RES));
    if (D[pz * OCC_N + px] >= 9) {
      const q = rng.int(0, 3), nx = DX[q], nz = DZ[q];
      open.push({ x: (li + 0.5) * CELL - nx * 0.6, z: (lj + 0.5) * CELL - nz * 0.6, nx, nz, tx: Math.abs(nz), tz: Math.abs(nx), y, ceil });
    }
  }
  rng.shuffle(walls);
  rng.shuffle(open);
  const tries = [...walls.slice(0, 40), ...open.slice(0, 20)];
  for (let k = 0; k < tries.length; k++) {
    const plan = planCluster(pl, kind, tries[k], big, rng.fork(k));
    if (!plan) continue;
    for (const p of plan) pl.place(p);
    return;
  }
}
