// src/world/landmarks/common.ts — shared stamping helpers for landmarks (WP4, private).
//
// A landmark claims a rotated W x L frame (structures/frame.ts) >= 2 cells from the seam lines, avoiding reserved
// cells (towers, elevators, arteries) with a 1-cell apron. Its cells get LANDMARK|RESERVED so zone generators leave
// them alone; its edges are written with `force` (never frozen seam edges). Everything is authored in frame metres
// (um across, vm along). Fixtures use lattice keys (core fixtureId); recessed rects are split at render-tile lines.

import { CELL, CEIL_TILE, CHUNK_CELLS, TILE_SIZE, WALL_T } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EdgeTrim, FixtureKind, Mat, NO_WATER, SALT, TileState, cellIdx, hash3, isRecessedFixture, setTile } from '../../core/index.ts';
import type {
  CeilKindId, CellPatch, ChunkGrid, DecalPlacement, EmitterKindId, Fixture, FixtureKindId, LandmarkSite, LightStateId, MatId, PropKindId,
  PropPlacement, Rng, Vec3, ZoneGenContext, ZoneId,
} from '../../core/index.ts';
import { Rng as RngClass, SolidFlag } from '../../core/index.ts';
import { defaultPropFlags } from '../content/props.ts';
import { addLatticeFixture, FIXTURE_DIMS, fixtureAt } from '../content/util.ts';
import { Frame, frameExtent, type Rot } from '../structures/frame.ts';

export const SEAM_MARGIN = 2;
const N = CHUNK_CELLS;

export interface Lm {
  g: ChunkGrid;
  ctx: ZoneGenContext;
  site: LandmarkSite;
  f: Frame;
  rng: Rng;
  W: number;
  L: number;
  entrances: [number, number][];
}

/** Deterministic landmark rng (storey-dependent: every storey has its own landmarks). */
export const landmarkRng = (ctx: ZoneGenContext, site: LandmarkSite): Rng => new RngClass(hash3(site.seed, SALT.LANDMARK, ctx.key.s));

/** Is the rotated footprint (+ apron) free of reserved cells and inside the margins? */
export function footprintFree(g: ChunkGrid, f: Frame, apron = 1, margin = SEAM_MARGIN): boolean {
  const [i0, j0, i1, j1] = f.rect();
  if (i0 < margin || j0 < margin || i1 > N - margin || j1 > N - margin) return false;
  for (let lj = Math.max(0, j0 - apron); lj < Math.min(N, j1 + apron); lj++) {
    for (let li = Math.max(0, i0 - apron); li < Math.min(N, i1 + apron); li++) {
      if (g.isReserved(li, lj)) return false;
      if (g.hasFlag(li, lj, CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.ARTERY | CellFlag.LANDMARK)) return false;
    }
  }
  return true;
}

/** Pick a rotation and position for a W x L landmark; null if nothing fits. */
export function chooseFrame(g: ChunkGrid, rng: Rng, W: number, L: number, rots: readonly Rot[] = [0, 1, 2, 3]): Frame | null {
  for (let a = 0; a < 48; a++) {
    const rot = rots[rng.int(0, rots.length - 1)];
    const [ex, ez] = frameExtent(W, L, rot);
    const hi = N - SEAM_MARGIN - ex, hj = N - SEAM_MARGIN - ez;
    if (hi < SEAM_MARGIN || hj < SEAM_MARGIN) continue;
    const f = new Frame(rng.int(SEAM_MARGIN, hi), rng.int(SEAM_MARGIN, hj), W, L, rot);
    if (footprintFree(g, f)) return f;
  }
  // deterministic scan (reserved-heavy chunks, e.g. forceLandmark next to a tower)
  for (const rot of rots) {
    const [ex, ez] = frameExtent(W, L, rot);
    for (let j0 = SEAM_MARGIN; j0 <= N - SEAM_MARGIN - ez; j0++) {
      for (let i0 = SEAM_MARGIN; i0 <= N - SEAM_MARGIN - ex; i0++) {
        const f = new Frame(i0, j0, W, L, rot);
        if (footprintFree(g, f)) return f;
      }
    }
  }
  return null;
}

export function begin(g: ChunkGrid, ctx: ZoneGenContext, site: LandmarkSite, W: number, L: number, rots?: readonly Rot[]): Lm | null {
  const rng = landmarkRng(ctx, site);
  const f = chooseFrame(g, rng, W, L, rots);
  if (!f) return null;
  return { g, ctx, site, f, rng, W, L, entrances: [] };
}

export interface Style { floorMat: MatId; wallMat: MatId; ceilMat: MatId; ceilKind: CeilKindId; ceilCm: number; trimMat?: MatId; baseboard?: boolean; zone?: ZoneId }

/** Claim the footprint: LANDMARK|RESERVED cells with the style, interior edges OPEN, perimeter WALL. */
export function claim(lm: Lm, st: Style, patch: CellPatch = {}): void {
  const { g, f } = lm;
  const l = g.layout;
  const [i0, j0, i1, j1] = f.rect();
  g.setCells(i0, j0, i1, j1, {
    floorCm: 0, ceilCm: st.ceilCm, waterCm: NO_WATER, blockCm: 0, floorMat: st.floorMat, ceilMat: st.ceilMat,
    ceilKind: st.ceilKind, cellZone: st.zone,
    flagsSet: CellFlag.LANDMARK | CellFlag.RESERVED,
    flagsClear: CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.WET | CellFlag.NO_CEIL | CellFlag.SEALED | CellFlag.SPAWN_OK,
    ...patch,
  }, true);
  for (let lj = j0; lj < j1; lj++) {
    for (let li = i0; li < i1; li++) {
      const c = cellIdx(li, lj);
      l.wallMat[c] = st.wallMat;
      l.trimMat[c] = st.trimMat ?? Mat.TRIM_PAINT;
      l.tiles[c] = 0;
    }
  }
  for (let v = 0; v < lm.L; v++) {
    for (let u = 0; u < lm.W; u++) {
      if (u + 1 < lm.W) f.setEdge(g, u, v, u + 1, v, EdgeKind.OPEN, st.wallMat, st.wallMat, { trim: 0 });
      if (v + 1 < lm.L) f.setEdge(g, u, v, u, v + 1, EdgeKind.OPEN, st.wallMat, st.wallMat, { trim: 0 });
    }
  }
  const trim = st.baseboard ? EdgeTrim.BASEBOARD : 0;
  for (let v = 0; v < lm.L; v++) {
    wall(lm, 0, v, -1, v, EdgeKind.WALL, st.wallMat, trim);
    wall(lm, lm.W - 1, v, lm.W, v, EdgeKind.WALL, st.wallMat, trim);
  }
  for (let u = 0; u < lm.W; u++) {
    wall(lm, u, 0, u, -1, EdgeKind.WALL, st.wallMat, trim);
    wall(lm, u, lm.L - 1, u, lm.L, EdgeKind.WALL, st.wallMat, trim);
  }
  g.addLandmark(lm.site.kind, i0, j0, i1, j1);
}

/** Palette wall material of a (possibly outside) frame cell. */
export function outsideMat(lm: Lm, u: number, v: number): MatId {
  const [li, lj] = lm.f.cell(u, v);
  if (li < 0 || lj < 0 || li >= N || lj >= N) return Mat.WALLPAPER_L0;
  return lm.g.layout.wallMat[cellIdx(li, lj)] as MatId;
}

/** Edge between inside cell (u, v) and neighbour (un, vn): inside face `mat`, outside face the outside palette. */
export function wall(lm: Lm, u: number, v: number, un: number, vn: number, kind: number, mat: MatId, trim = 0, hA?: number, hB?: number): void {
  const inside = un >= 0 && vn >= 0 && un < lm.W && vn < lm.L;
  const other = inside ? mat : outsideMat(lm, un, vn);
  lm.f.setEdge(lm.g, u, v, un, vn, kind, mat, other, { trim, hA, hB });
}

/** Opening on the perimeter at inside cell (u, v) toward side (du, dv); records the entrance. */
export function opening(lm: Lm, u: number, v: number, du: number, dv: number, kind: number, mat: MatId, trim = 0, hA?: number): void {
  wall(lm, u, v, u + du, v + dv, kind, mat, trim, hA);
  lm.entrances.push(lm.f.cell(u, v));
}

/** Frame-metre point -> chunk-local [x, z]. */
export const P = (lm: Lm, um: number, vm: number): [number, number] => lm.f.point(um, vm);

export function prop(lm: Lm, kind: PropKindId, um: number, vm: number, y: number, du: number, dv: number, variant = 0, flags?: number, yawJitter = 0): PropPlacement {
  const [x, z] = lm.f.point(um, vm);
  const p: PropPlacement = {
    kind, variant, x, y, z, yaw: lm.f.yaw(du, dv) + yawJitter, scale: 1,
    flags: flags ?? defaultPropFlags(kind), seed: lm.rng.next(),
  };
  lm.g.addProp(p);
  return p;
}

export function fixture(lm: Lm, kind: FixtureKindId, um: number, vm: number, y: number, n: readonly [number, number, number],
  tAlong: readonly [number, number], color: Vec3, luminance: number, state: LightStateId = 0, dims?: { shape?: 0 | 1; w?: number; h?: number; hum?: number }): number {
  const [x, z] = lm.f.point(um, vm);
  const [tx, tz] = lm.f.dir(tAlong[0], tAlong[1]);
  const [nx, nz] = n[1] === 0 ? lm.f.dir(n[0], n[2]) : [0, 0];
  const f = fixtureAt(kind, x, y, z, [nx, n[1], nz], [Math.abs(tx), 0, Math.abs(tz)], [color[0], color[1], color[2]], luminance, dims);
  f.state = state;
  return addLatticeFixture(lm.g, f);
}

/** Recessed ceiling fixture covering frame cells [u0,u1) x [v0,v1) (whole cells), split at render-tile lines; sets the
 * covered ceiling tiles to FIXTURE. Returns the number of fixtures added. */
export function recessedCells(lm: Lm, kind: FixtureKindId, u0: number, v0: number, u1: number, v1: number, ceilY: number,
  color: Vec3, luminance: number, state: LightStateId = 0): number {
  const a = lm.f.point(u0 * CELL, v0 * CELL), b = lm.f.point(u1 * CELL, v1 * CELL);
  return recessedRect(lm, kind, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), ceilY, color, luminance, state);
}

/** Recessed rect in chunk-local metres (tile-aligned), split at the render-tile lines. */
export function recessedRect(lm: Lm, kind: FixtureKindId, x0: number, z0: number, x1: number, z1: number, ceilY: number,
  color: Vec3, luminance: number, state: LightStateId = 0): number {
  const xs = [x0], zs = [z0];
  for (let k = 1; k * TILE_SIZE < x1 - 1e-6; k++) if (k * TILE_SIZE > x0 + 1e-6) xs.push(k * TILE_SIZE);
  for (let k = 1; k * TILE_SIZE < z1 - 1e-6; k++) if (k * TILE_SIZE > z0 + 1e-6) zs.push(k * TILE_SIZE);
  xs.push(x1); zs.push(z1);
  let n = 0;
  for (let j = 0; j + 1 < zs.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i], bx = xs[i + 1], az = zs[j], bz = zs[j + 1];
      const w = bx - ax, h = bz - az;
      const alongX = w >= h;
      const f = fixtureAt(kind, (ax + bx) / 2, ceilY, (az + bz) / 2, [0, -1, 0], alongX ? [1, 0, 0] : [0, 0, 1], [color[0], color[1], color[2]], luminance,
        { w: alongX ? w : h, h: alongX ? h : w });
      f.state = state;
      if (addLatticeFixture(lm.g, f) >= 0) n++;
      if (isRecessedFixture(kind)) markTiles(lm, ax, az, bx, bz);
    }
  }
  return n;
}

/** Ceiling tiles covered by a chunk-local rect -> FIXTURE. */
export function markTiles(lm: Lm, x0: number, z0: number, x1: number, z1: number): void {
  const l = lm.g.layout;
  const t0 = Math.round(x0 / CEIL_TILE), t1 = Math.round(x1 / CEIL_TILE), s0 = Math.round(z0 / CEIL_TILE), s1 = Math.round(z1 / CEIL_TILE);
  for (let tz = s0; tz < s1; tz++) for (let tx = t0; tx < t1; tx++) {
    if (tx < 0 || tz < 0 || tx >= 2 * N || tz >= 2 * N) continue;
    setTile(l.tiles, cellIdx(tx >> 1, tz >> 1), ((tz & 1) << 1) | (tx & 1), TileState.FIXTURE);
  }
}

export function emitter(lm: Lm, kind: EmitterKindId, um: number, vm: number, y: number, gain: number): void {
  const [x, z] = lm.f.point(um, vm);
  lm.g.addEmitter(kind, x, y, z, gain);
}

export function box(lm: Lm, um0: number, vm0: number, um1: number, vm1: number, y0: number, y1: number, mat: MatId,
  flags: number = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER): number {
  const b = lm.f.box(um0, vm0, um1, vm1, y0, y1);
  return lm.g.addSolid({ kind: 'box', min: b.min, max: b.max, mat, flags, bakeGroup: 0 });
}

/** Ramp over frame metres [um0,um1] x [vm0,vm1] ascending toward frame direction (du, dv). */
export function ramp(lm: Lm, um0: number, vm0: number, um1: number, vm1: number, du: number, dv: number, yLow: number, yHigh: number, steps: number, mat: MatId): number {
  const b = lm.f.box(um0, vm0, um1, vm1, yLow, yHigh);
  const [dx, dz] = lm.f.dir(du, dv);
  const dir: 0 | 1 | 2 | 3 = dx > 0 ? 0 : dx < 0 ? 1 : dz > 0 ? 2 : 3;
  return lm.g.addSolid({
    kind: 'ramp', x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2], y0: yLow, y1: yHigh, dir, steps, mat,
    flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER | SolidFlag.WALKABLE_TOP, bakeGroup: 0,
  });
}

/** Decal on the inside face of the perimeter/interior edge between (u,v) and (un,vn), t = 0..1 along it. */
export function wallDecal(lm: Lm, u: number, v: number, un: number, vn: number, t: number, y: number, d: Omit<DecalPlacement, 'px' | 'py' | 'pz' | 'nx' | 'ny' | 'nz'>): void {
  const fp = lm.f.facePoint(u, v, un, vn, t);
  lm.g.addDecal({ ...d, px: fp.x, py: y, pz: fp.z, nx: fp.nx, ny: 0, nz: fp.nz });
}
export function floorDecal(lm: Lm, um: number, vm: number, y: number, d: Omit<DecalPlacement, 'px' | 'py' | 'pz' | 'nx' | 'ny' | 'nz'>): void {
  const [x, z] = lm.f.point(um, vm);
  lm.g.addDecal({ ...d, px: x, py: y, pz: z, nx: 0, ny: 1, nz: 0 });
}

/** Set cells of frame rect [u0,u1) x [v0,v1) (force: landmark cells are reserved). */
export function cells(lm: Lm, u0: number, v0: number, u1: number, v1: number, p: CellPatch): void {
  const [a, b, c, d] = lm.f.cellRect(u0, v0, u1, v1);
  lm.g.setCells(a, b, c, d, p, true);
}

/** Frame direction (du, dv) of chunk-local cell sides, for fixtures facing into the room. */
export const N3 = (du: number, dv: number): [number, number, number] => [du, 0, dv];
export const DOWN: [number, number, number] = [0, -1, 0];

export const HALF_T = WALL_T / 2;
export type { Fixture };
export { FIXTURE_DIMS };

// ---------------------------------------------------------------------------------------------- R2 (B4) helpers

/** Water surface over frame cells [u0,u1) x [v0,v1) (the cells' waterCm is the caller's business). */
export function waterRect(lm: Lm, u0: number, v0: number, u1: number, v1: number, y: number, floorY: number, kind: 0 | 1 | 2 = 0): void {
  const a = lm.f.point(u0 * CELL, v0 * CELL), b = lm.f.point(u1 * CELL, v1 * CELL);
  lm.g.addWater({ x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]), y, floorY, kind });
}

/** Overhead-only (no collision) and low (colliding) solid flag sets. */
export const OVERHEAD = SolidFlag.OCCLUDE | SolidFlag.RENDER;
export const SOLID_F = SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;
export const WALK_F = SolidFlag.WALKABLE_TOP | SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER;
/** Thin detail (rails, slats, grilles): collides / renders but never occludes the bake. */
export const THIN_F = SolidFlag.COLLIDE | SolidFlag.RENDER;

/** Pipe between two frame-metre points (y absolute). */
export function pipeF(lm: Lm, um0: number, vm0: number, y0: number, um1: number, vm1: number, y1: number, r: number, mat: MatId, flags = OVERHEAD): void {
  const [ax, az] = lm.f.point(um0, vm0), [bx, bz] = lm.f.point(um1, vm1);
  lm.g.addSolid({ kind: 'pipe', a: [ax, y0, az], b: [bx, y1, bz], r, mat, flags });
}

/** 2x4 troffer (0.6 x 1.2 m, tile aligned) with its min corner at frame metres (um, vm); `alongU` lays it along u. */
export function troffer(lm: Lm, um: number, vm: number, ceilY: number, color: Vec3, luminance: number, state: LightStateId = 0, alongU = false): number {
  const a = lm.f.point(um, vm), b = lm.f.point(um + (alongU ? 1.2 : 0.6), vm + (alongU ? 0.6 : 1.2));
  return recessedRect(lm, FixtureKind.TROFFER_2x4, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), ceilY, color, luminance, state);
}

/** Storey styles: 0 = Level 0 office (wallpaper / carpet / tiles), 1 = sublevel concrete, 2 = poolrooms tile. */
export function storeyStyle(s: number, ceilCm: number, o: Partial<Style> = {}): Style {
  if (s === 1) return { floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED, ceilMat: Mat.CONCRETE_CEIL, ceilKind: CeilKind.CONCRETE, ceilCm, trimMat: Mat.METAL_PAINTED, ...o };
  if (s === 2) return { floorMat: Mat.POOL_TILE, wallMat: Mat.POOL_TILE, ceilMat: Mat.POOL_TILE, ceilKind: CeilKind.TILE_GLAZED, ceilCm, trimMat: Mat.POOL_TILE, ...o };
  return { floorMat: Mat.CARPET_L0, wallMat: Mat.WALLPAPER_L0, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm, baseboard: true, ...o };
}

/** Pseudo-random ageing of a claimed tiled ceiling: stained / sagging / missing tiles (FIXTURE tiles untouched). */
export function ageCeiling(lm: Lm, pStain: number, pSag: number, pMissing: number): void {
  const l = lm.g.layout;
  const [i0, j0, i1, j1] = lm.f.rect();
  for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) {
    const c = cellIdx(li, lj);
    for (let t = 0; t < 4; t++) {
      if (((l.tiles[c] >> (t * 4)) & 15) !== 0) continue;
      const r = lm.rng.float();
      if (r < pStain) setTile(l.tiles, c, t, TileState.STAINED);
      else if (r < pStain + pSag) setTile(l.tiles, c, t, TileState.SAGGING);
      else if (r < pStain + pSag + pMissing) setTile(l.tiles, c, t, TileState.MISSING);
    }
  }
}

/** Handrail along a frame-metre segment: a top rail at height h above the line (y0 -> y1) plus posts. Level rails
 * (and all posts) are thin boxes; only sloped rails are pipe solids (props/pipes.ts draws pipes as plumbing: level
 * runs would get ceiling hangers, which a rail must not have; runs steeper than ~17 degrees never do). */
export function handrail(lm: Lm, um0: number, vm0: number, y0: number, um1: number, vm1: number, y1: number, mat: MatId = Mat.METAL_PAINTED, h = 0.9, posts = 0): void {
  const r = 0.022;
  const level = Math.abs(y1 - y0) < 0.05;
  const axisAligned = Math.abs(um1 - um0) < 1e-6 || Math.abs(vm1 - vm0) < 1e-6;
  if (level && axisAligned) {
    const top = Math.max(y0, y1) + h;
    box(lm, Math.min(um0, um1) - r, Math.min(vm0, vm1) - r, Math.max(um0, um1) + r, Math.max(vm0, vm1) + r, top - 2 * r, top, mat, THIN_F);
    box(lm, Math.min(um0, um1) - r * 0.6, Math.min(vm0, vm1) - r * 0.6, Math.max(um0, um1) + r * 0.6, Math.max(vm0, vm1) + r * 0.6, top - h * 0.55, top - h * 0.55 + 0.025, mat, THIN_F); // mid rail
  } else {
    pipeF(lm, um0, vm0, y0 + h, um1, vm1, y1 + h, 0.025, mat, THIN_F);
  }
  const n = posts > 0 ? posts : Math.max(1, Math.round(Math.hypot(um1 - um0, vm1 - vm0) / 1.2));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const um = um0 + (um1 - um0) * t, vm = vm0 + (vm1 - vm0) * t, y = y0 + (y1 - y0) * t;
    box(lm, um - 0.018, vm - 0.018, um + 0.018, vm + 0.018, y, y + h, mat, THIN_F);
  }
}

/** A glowing flat panel (window, curtain, screen): an emissive BLANK sign decal at frame metres (um, vm), height y,
 * facing frame direction (du, dv). Visual only (decals do not light the bake): pair with a fixture when the glow must
 * light the room. */
export function glowPanel(lm: Lm, um: number, vm: number, y: number, du: number, dv: number, w: number, h: number, emit: number, color: Vec3): void {
  const [x, z] = lm.f.point(um, vm);
  const [nx, nz] = lm.f.dir(du, dv);
  lm.g.addDecal({ kind: 15 /* SignKind.BLANK */, sign: true, px: x, py: y, pz: z, nx, ny: 0, nz, rot: 0, w, h, alpha: 1, emit: Math.round(emit), color: [color[0], color[1], color[2]] });
}
