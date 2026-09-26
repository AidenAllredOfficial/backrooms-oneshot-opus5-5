// src/world/zones/pillarHall.ts — PILLAR_HALL generator (WP2). GLOBAL seams: pillar lattice on global vertices.
//
// A tall (450-700 cm) hall: square pillars on a global vertex lattice (pitch P cells, offset (ox, oz)), linear
// pendants hung 320 cm above the floor in the middle of every pillar bay, sparse wall fragments from the LOW_EXPANSE
// feature process (p 0.15), and in humid districts a 2 cm water film over the whole walkable floor. Pillars that
// straddle a seam are added by every chunk they intersect (core addSolid duplicate rule).

import { ARTERY, CELL, CHUNK_CELLS, DOOR_CM } from '../../core/constants.ts';
import { cellIdx, floorDiv } from '../../core/grid.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, Mat, PropKind, SolidFlag, Zone } from '../../core/ids.ts';
import { hash01 } from '../../core/rng.ts';
import { transitionStamps } from '../structures/transitions.ts';
import {
  towerFootprint, type ArterySpan, type ChunkGrid, type LightingProfile, type PropRuleSet, type SeamEdges, type TowerSite,
  type ZoneGenContext, type ZoneGenerator, type ZonePalette,
} from '../../core/world.ts';
import {
  addCustomFixture, cellWalkable, districtHumidity, FEATURE_TAG, featureSeam, maskRects, num, rasterizeFeaturesLocal,
  storeyStyle, styleLighting, stylePalette, vertexHash, writeFeatures, type FeatureParams,
} from './l0common.ts';

const N = CHUNK_CELLS;

export const PILLAR_PITCHES: readonly number[] = [3, 4, 5];
export const PILLAR_SIZES: readonly number[] = [0.5, 0.7, 0.9];
/** Emitting surface of the linear pendants (m above the floor, §5.WP2). */
export const PENDANT_HANG_CM = 320;
const PENDANT_W = 1.2, PENDANT_H = 0.2;
const MISSING_P = 0.04;
const FRAGMENT_KEEP = 0.15;
const HUMID = 0.6;
const PILLAR_TAG = 0x9111;

export const pillarHallFeatures = (seed: number, s: number): FeatureParams =>
  ({ seed, s: s as FeatureParams['s'], tag: FEATURE_TAG.PILLAR_HALL, keepP: FRAGMENT_KEEP, wallsOnly: true, doorHa: DOOR_CM });

export interface PillarLattice { P: number; size: number; ox: number; oz: number }
export function pillarLattice(p: Readonly<Record<string, number>>): PillarLattice {
  const P = Math.max(2, num(p, 'pitch', 4) | 0);
  return { P, size: num(p, 'size', 0.7), ox: (((num(p, 'ox', 0) | 0) % P) + P) % P, oz: (((num(p, 'oz', 0) | 0) % P) + P) % P };
}

export const pillarHallGenerator: ZoneGenerator = {
  id: Zone.PILLAR_HALL,
  seamMode: 'global',
  districtParams(rng, _s) {
    const pitch = rng.pick(PILLAR_PITCHES);
    return {
      pitch,
      size: rng.pick(PILLAR_SIZES),
      ceilCm: 450 + 10 * rng.int(0, 25),
      ox: rng.int(0, pitch - 1),
      oz: rng.int(0, pitch - 1),
      floor: rng.chance(0.5) ? 1 : 0, // 1 = TERRAZZO, 0 = CARPET_L0
      pillarMat: rng.chance(0.5) ? 1 : 0, // 1 = TERRAZZO-clad pillars, 0 = wallpapered
      axis: rng.chance(0.5) ? 1 : 0, // pendant long axis
      phaseX: rng.int(0, 5),
      phaseZ: rng.int(0, 5),
    };
  },
  globalSeam(q): SeamEdges {
    // OPEN except for the wall fragments (pillars are solids, not edges)
    return featureSeam(pillarHallFeatures(q.seed, q.s), q.axis, q.line, q.g0);
  },
  generate(ctx) {
    generatePillarHall(ctx);
  },
  palette(s, d) {
    const base: ZonePalette = {
      floorMat: num(d.params, 'floor', 1) === 1 ? Mat.TERRAZZO : Mat.CARPET_L0, wallMat: Mat.WALLPAPER_L0,
      ceilMat: Mat.CEILING_TILE, trimMat: Mat.TRIM_PAINT, ceilKind: CeilKind.TILES,
      ceilCm: num(d.params, 'ceilCm', 500), baseboard: true,
    };
    return stylePalette(storeyStyle(d.zone, s), base);
  },
  lighting(s, d) {
    const ceilCm = num(d.params, 'ceilCm', 500);
    const base: LightingProfile = {
      kind: FixtureKind.PENDANT_LINEAR, placement: 'custom', lattice: [6, 6],
      phase: [num(d.params, 'phaseX', 0) % 6, num(d.params, 'phaseZ', 0) % 6], axis: num(d.params, 'axis', 0) === 1 ? 1 : 0,
      cctRange: [3800, 4400], luminance: 4200, zoneMul: 1, mountCm: Math.max(0, ceilCm - PENDANT_HANG_CM),
    };
    return styleLighting(storeyStyle(d.zone, s), base, d.params);
  },
  props: {
    rules: [
      { kind: PropKind.CHAIR_STACKING, where: 'center', per100m2: 0.1, variants: 3, minSpacing: 10, yCm: 0 },
      { kind: PropKind.CHAIR_STACKING, where: 'cluster', per100m2: 0.05, variants: 3, minSpacing: 14, yCm: 0 },
      { kind: PropKind.OUTLET, where: 'wallMounted', per100m2: 0.6, variants: 2, minSpacing: 4, yCm: 30 },
      { kind: PropKind.TRASH_CAN, where: 'corner', per100m2: 0.05, variants: 2, minSpacing: 14, yCm: 0 },
    ],
  } satisfies PropRuleSet,
};

// ------------------------------------------------------------------------------------------------ generate

function inLane(spans: readonly ArterySpan[], gi: number, gj: number): boolean {
  for (const a of spans) {
    if (a.axis === 'x') { if (gj >= a.row && gj < a.row + ARTERY.WIDTH_CELLS && gi >= a.g0 && gi < a.g1) return true; }
    else if (gi >= a.row && gi < a.row + ARTERY.WIDTH_CELLS && gj >= a.g0 && gj < a.g1) return true;
  }
  return false;
}

/** Global cell (gi, gj) lies in a tower footprint (towers are world sites, so every chunk sees the same answer). */
function inTower(towers: readonly TowerSite[], gi: number, gj: number): boolean {
  for (const t of towers) {
    const [i0, j0, i1, j1] = towerFootprint(t);
    const li = gi - t.cx * N, lj = gj - t.cz * N;
    if (li >= i0 && li < i1 && lj >= j0 && lj < j1) return true;
  }
  return false;
}

/** Pillar at global vertex (vx, vz) is placed: not missing (global hash), its 4 cells free of stamps and every chunk
 * it touches belongs to this district.
 *
 * Seam pillars (vertex on a chunk line) are decided by each chunk they touch, so the decision must be the same on
 * both sides. Everything world-level is checked globally (missing hash, artery lanes, tower footprints, districts);
 * the local cell flags (reserved stamps, SOLID) are only visible on the chunk's own side, which is sound because
 * towers, elevators and landmarks keep >= 2 cells from the seam lines (WP1 SITE_MARGIN, WP4 landmark frames) and
 * PILLAR_HALL writes no SOLID cells; the only stamp reaching a seam is the artery / endless hall lane, checked
 * globally. tests/world/zones-l0.test.ts checks seam pillars agree across chunks in the full pipeline. */
function pillarAllowed(
  ctx: ZoneGenContext, lat: PillarLattice, spans: readonly ArterySpan[], towers: readonly TowerSite[], vx: number, vz: number,
): boolean {
  if (hash01(vertexHash(ctx.seed, ctx.key.s, PILLAR_TAG, vx, vz)) < MISSING_P) return false;
  const g = ctx.grid;
  for (let d = 0; d < 4; d++) {
    const gi = vx - 1 + (d & 1), gj = vz - 1 + (d >> 1);
    if (inLane(spans, gi, gj) || inTower(towers, gi, gj)) return false;
    const li = gi - g.gi0, lj = gj - g.gj0;
    if (li >= 0 && lj >= 0 && li < N && lj < N) {
      if (g.isReserved(li, lj) || g.hasFlag(li, lj, CellFlag.SOLID | CellFlag.VOID)) return false;
    }
  }
  // pillar box extent (never beyond the 4 cells around the vertex since size < CELL)
  const half = lat.size / 2;
  const x0 = vx * CELL - half, x1 = vx * CELL + half, z0 = vz * CELL - half, z1 = vz * CELL + half;
  const cx0 = floorDiv(Math.floor(x0 / CELL + 1e-7), N), cx1 = floorDiv(Math.floor(x1 / CELL - 1e-7), N);
  const cz0 = floorDiv(Math.floor(z0 / CELL + 1e-7), N), cz1 = floorDiv(Math.floor(z1 / CELL - 1e-7), N);
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (cx === ctx.key.cx && cz === ctx.key.cz) continue;
      if (ctx.world.districtAt(ctx.key.s, cx, cz).id !== ctx.district.id) return false;
    }
  }
  return true;
}

function generatePillarHall(ctx: ZoneGenContext): void {
  const g = ctx.grid, L = g.layout, p = ctx.district.params;
  const lat = pillarLattice(p);
  const style = storeyStyle(ctx.district.zone, ctx.key.s);

  // 1. sparse wall fragments (same feature process as LOW_EXPANSE, walls and L corners only, p 0.15)
  writeFeatures(g, rasterizeFeaturesLocal(pillarHallFeatures(ctx.seed, ctx.key.s), g.gi0, g.gj0), DOOR_CM);

  // 2. pillars on the global vertex lattice (ox + i*P, oz + j*P), floor to ceiling
  const spans = ctx.world.arteriesNear(ctx.key.s, ctx.key.cx, ctx.key.cz);
  const towers = ctx.world.towersNear(ctx.key.s, ctx.key.cx, ctx.key.cz);
  const ceil = ctx.palette.ceilCm;
  const pillarMat = style === 2 ? Mat.POOL_TILE : num(p, 'pillarMat', 0) === 1 ? Mat.TERRAZZO : Mat.WALLPAPER_L0;
  const half = lat.size / 2;
  const vx0 = g.gi0 + ((((lat.ox - g.gi0) % lat.P) + lat.P) % lat.P);
  const vz0 = g.gj0 + ((((lat.oz - g.gj0) % lat.P) + lat.P) % lat.P);
  for (let vz = vz0; vz <= g.gj0 + N; vz += lat.P) {
    for (let vx = vx0; vx <= g.gi0 + N; vx += lat.P) {
      if (!pillarAllowed(ctx, lat, spans, towers, vx, vz)) continue;
      // the pillar spans the lowest floor .. highest ceiling of the in-chunk cells around the vertex
      let top = ceil, bottom = 0;
      for (let d = 0; d < 4; d++) {
        const li = vx - 1 + (d & 1) - g.gi0, lj = vz - 1 + (d >> 1) - g.gj0;
        if (li < 0 || lj < 0 || li >= N || lj >= N) continue;
        top = Math.max(top, L.ceilCm[cellIdx(li, lj)]);
        bottom = Math.min(bottom, L.floorCm[cellIdx(li, lj)]);
      }
      const lx = (vx - g.gi0) * CELL, lz = (vz - g.gj0) * CELL;
      g.addSolid({
        kind: 'box', min: [lx - half, bottom / 100, lz - half], max: [lx + half, top / 100, lz + half], mat: pillarMat,
        flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER, bakeGroup: 0,
      });
    }
  }

  // R2: zone-transition connectors / palette dither on district boundaries (before the pendants: connector cells
  // get a 230 cm bulkhead ceiling, too low for a pendant)
  transitionStamps(ctx, null);

  // 3. linear pendants in the middle of every bay (custom placement; storey 2 uses the SKY_PANEL lattice instead)
  if (ctx.lighting.placement === 'custom') placePendants(ctx, lat);

  // 4. humid districts: a 2 cm water film over the walkable floor (WET cells + WaterRect kind 2)
  if (districtHumidity(ctx) > HUMID) humidFilm(ctx);
}

function edgeBlocks(g: ChunkGrid, axis: 'x' | 'z', i: number, j: number): boolean {
  if (axis === 'x' ? i < 0 || i > N || j < 0 || j >= N : i < 0 || i >= N || j < 0 || j > N) return false;
  return g.getEdge(axis, i, j) !== EdgeKind.OPEN;
}

function placePendants(ctx: ZoneGenContext, lat: PillarLattice): void {
  const g = ctx.grid, L = g.layout;
  const P = lat.P;
  const cct0 = ctx.lighting.cctRange[0], cct1 = ctx.lighting.cctRange[1];
  // bay centres in global vertex units: (ox + (i + 0.5) P, oz + (j + 0.5) P); owned by the chunk containing them
  const b0x = Math.floor((g.gi0 - lat.ox) / P) - 1, b1x = Math.floor((g.gi0 + N - lat.ox) / P) + 1;
  const b0z = Math.floor((g.gj0 - lat.oz) / P) - 1, b1z = Math.floor((g.gj0 + N - lat.oz) / P) + 1;
  for (let bz = b0z; bz <= b1z; bz++) {
    for (let bx = b0x; bx <= b1x; bx++) {
      const cxv = lat.ox + (bx + 0.5) * P, czv = lat.oz + (bz + 0.5) * P; // global vertex units (may be .5)
      const x = (cxv - g.gi0) * CELL, z = (czv - g.gj0) * CELL; // chunk-local metres
      const li = Math.floor(x / CELL + 1e-7), lj = Math.floor(z / CELL + 1e-7);
      if (li < 0 || lj < 0 || li >= N || lj >= N) continue;
      if (g.isReserved(li, lj) || g.hasFlag(li, lj, CellFlag.SOLID | CellFlag.VOID)) continue;
      const floor = L.floorCm[cellIdx(li, lj)], ceilCm = L.ceilCm[cellIdx(li, lj)];
      if (ceilCm - floor < PENDANT_HANG_CM + 30) continue;
      // the 1.2 m body must not pass through a wall fragment: try the district axis, then the other one
      let axis = ctx.lighting.axis;
      if (pendantHitsWall(g, x, z, axis)) {
        axis = axis === 0 ? 1 : 0;
        if (pendantHitsWall(g, x, z, axis)) continue;
      }
      addCustomFixture(ctx, {
        kind: FixtureKind.PENDANT_LINEAR, x, y: (floor + PENDANT_HANG_CM) / 100, z,
        nx: 0, ny: -1, nz: 0, tx: axis === 0 ? 1 : 0, ty: 0, tz: axis === 0 ? 0 : 1,
        w: PENDANT_W, h: PENDANT_H, cct0, cct1, luminance: ctx.lighting.luminance, hum: 0.4,
      });
    }
  }
}

/** Whether the pendant footprint (PENDANT_W along `axis`, 0.25 m across) crosses a non-OPEN edge. */
function pendantHitsWall(g: ChunkGrid, x: number, z: number, axis: 0 | 1): boolean {
  const hw = axis === 0 ? PENDANT_W / 2 + 0.1 : 0.125, hd = axis === 0 ? 0.125 : PENDANT_W / 2 + 0.1;
  const i0 = Math.floor((x - hw) / CELL + 1e-7), i1 = Math.floor((x + hw) / CELL - 1e-7);
  const j0 = Math.floor((z - hd) / CELL + 1e-7), j1 = Math.floor((z + hd) / CELL - 1e-7);
  for (let j = j0; j <= j1; j++) for (let i = i0 + 1; i <= i1; i++) if (edgeBlocks(g, 'x', i, j)) return true;
  for (let i = i0; i <= i1; i++) for (let j = j0 + 1; j <= j1; j++) if (edgeBlocks(g, 'z', i, j)) return true;
  return false;
}

/** Humid district: a 2 cm water film (WaterRect kind 2) over every walkable cell, cells flagged WET (§5.WP2). One
 * rect per maximal rectangle of equal-floor walkable cells. */
function humidFilm(ctx: ZoneGenContext): void {
  const g = ctx.grid, L = g.layout;
  const mask = new Uint8Array(N * N);
  const levels: number[] = [];
  for (let lj = 0; lj < N; lj++) {
    for (let li = 0; li < N; li++) {
      if (g.isReserved(li, lj) || !cellWalkable(g, li, lj)) continue;
      mask[cellIdx(li, lj)] = 1;
      const f = L.floorCm[cellIdx(li, lj)];
      if (!levels.includes(f)) levels.push(f);
    }
  }
  const level = new Uint8Array(N * N);
  for (const f of levels) {
    for (let c = 0; c < N * N; c++) level[c] = mask[c] && L.floorCm[c] === f ? 1 : 0;
    for (const [i0, j0, i1, j1] of maskRects(level)) {
      g.setCells(i0, j0, i1, j1, { flagsSet: CellFlag.WET, waterCm: f + 2 });
      g.addWater({ x0: i0 * CELL, z0: j0 * CELL, x1: i1 * CELL, z1: j1 * CELL, y: (f + 2) / 100, floorY: f / 100, kind: 2 });
    }
  }
}
