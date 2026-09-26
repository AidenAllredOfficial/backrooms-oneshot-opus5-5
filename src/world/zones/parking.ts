// src/world/zones/parking.ts — PARKING generator (WP3). GLOBAL seams: column lattice, beams, stalls, ramps.
//
// Everything structural is world-anchored on district-phased global lattices, so chunks agree across seams:
// - Columns: 0.6 m concrete boxes on a 6 x 5-cell vertex lattice (7.2 m bays along x, 6 m along z). A column that
//   straddles a seam is added by every chunk it intersects (core addSolid rule).
// - Beams: 40 cm downstand boxes along x on every column row (y ∈ [ceil − 0.4, ceil]), clipped per chunk (the clipped
//   ends face the neighbour chunk's cells, so face ownership never emits them), broken at stamps and slab openings,
//   capped 0.3 m short of a district boundary.
// - Bands: the 6 m strips between column rows cycle (stalls facing +z | drive aisle | stalls facing −z), so stall
//   rows stand back to back on every third column row. Stalls are 2.4 m wide (3 per bay) and 5 m deep, marked with
//   worn DECAL_PAINT_STRIPE lines (clipped per chunk), a WHEEL_STOP each and a CAR_SEDAN in 5% of them. Drive aisles
//   get a dashed centre line. Columns carry PARKING_NUMBER stencils on the face toward a stall row.
// - Lights: TUBE_STRIP battens between the beams (two per bay along each band's centre line), 10% SODIUM.
// - Dead-end ramp (one per ~6 chunks): a 4 x 8-cell ramp rising 1.5 m to a wall through a slab opening, with
//   stepped HALF parapets on its sides. Walkable; it leads nowhere.
// Seams are all OPEN (columns are solids).

import { CELL, CHUNK_SIZE } from '../../core/constants.ts';
import { cellIdx, floorDiv, mod } from '../../core/grid.ts';
import { CeilKind, DecalKind, EdgeKind, EmitterKind, FixtureKind, Mat, PropKind, Zone, type StoreyId } from '../../core/ids.ts';
import { hash01, hash2, hash5, Rng, SALT } from '../../core/rng.ts';
import type { DistrictInfo, LightingProfile, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import {
  BOX_FLAGS, createFixturePlacer, downRectSpec, freeRuns, globalBlockedTest, inChunk, isReservedCell, N,
  paintStripe, sameDistrictAcross, uniformSeam, WALK_FLAGS,
} from './deepcommon.ts';

const TAG = Zone.PARKING * 16;
const COL_PX = 6; // column pitch along x (cells)
const COL_PZ = 5; // column pitch along z (cells)
const COL_HALF = 0.3; // m
const BEAM_DEPTH = 0.4; // m
const BEAM_HALF = 0.2; // m (0.4 wide)
const STALL_W = 2.4; // m
const STALL_D = 5.0; // m
const STALL_BACK = 0.5; // m gap between the column row and the stall's back line
const CAR_P = 0.05;
const SODIUM_P = 0.1;
const RAMP_P = 1 / 6;
const RAMP_RISE = 1.5; // m
const RAMP_CEIL_CM = 450;
const TUBE_CCT: readonly [number, number] = [3900, 4300];
const SODIUM_CCT: readonly [number, number] = [2000, 2000];
const WHITE: readonly [number, number, number] = [0.95, 0.95, 0.9];
const YELLOW: readonly [number, number, number] = [1.0, 0.72, 0.08];

interface ParkParams { px: number; pz: number; band: number; yellow: boolean }
const params = (d: DistrictInfo): ParkParams => ({
  px: d.params.phaseX ?? 0, pz: d.params.phaseZ ?? 0, band: d.params.bandPhase ?? 0, yellow: (d.params.yellow ?? 0) > 0,
});
/** Band type of global band index b: 0 stalls backing on the band's min-z row, 1 drive aisle, 2 stalls backing on max-z. */
const bandType = (p: ParkParams, b: number): number => mod(b + p.band, 3);

function generate(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout;
  const { s, cx, cz } = ctx.key;
  const p = params(ctx.district);
  const gi0 = g.gi0, gj0 = g.gj0;
  const ceilCm = ctx.palette.ceilCm;
  const ceilY = ceilCm / 100;
  const globalBlocked = globalBlockedTest(ctx);
  const placer = createFixturePlacer(ctx);
  const paint = p.yellow ? YELLOW : WHITE;
  const propSeed = (a: number, b: number, k: number): number => hash5(ctx.seed, SALT.PROP, TAG + k, a, b);

  // ---- dead-end ramp (decided first: it clears stalls, beams and lights around it)
  const inRamp = new Uint8Array(N * N); // footprint
  const nearRamp = new Uint8Array(N * N); // footprint + 1-cell margin
  const rh = hash5(ctx.seed, SALT.GLOBAL_FEATURE, TAG + s, cx, cz);
  if (hash01(rh) < RAMP_P) {
    const rng = new Rng(hash2(rh, 0x4a3b));
    for (let attempt = 0; attempt < 6; attempt++) {
      // a 4-cell-wide bay between two column lines, 8 cells long along z
      const a = rng.int(-1, 5);
      const ri0 = mod(p.px - gi0, COL_PX) + COL_PX * a + 1;
      const rj0 = rng.int(2, N - 2 - 8);
      if (ri0 < 2 || ri0 + 4 > N - 2) continue;
      let ok = true;
      for (let lj = rj0 - 1; lj < rj0 + 9 && ok; lj++) for (let li = ri0 - 1; li < ri0 + 5 && ok; li++) {
        if (isReservedCell(l, cellIdx(li, lj)) || globalBlocked(gi0 + li, gj0 + lj)) ok = false;
      }
      if (!ok) continue;
      const up = rng.chance(0.5); // ascent toward +z (dir 2) or -z (dir 3)
      for (let lj = rj0 - 1; lj < rj0 + 9; lj++) for (let li = ri0 - 1; li < ri0 + 5; li++) nearRamp[cellIdx(li, lj)] = 1;
      for (let lj = rj0; lj < rj0 + 8; lj++) for (let li = ri0; li < ri0 + 4; li++) inRamp[cellIdx(li, lj)] = 1;
      g.addSolid({
        kind: 'ramp', x0: ri0 * CELL, z0: rj0 * CELL, x1: (ri0 + 4) * CELL, z1: (rj0 + 8) * CELL,
        y0: 0, y1: RAMP_RISE, dir: up ? 2 : 3, steps: 0, mat: Mat.CONCRETE_FLOOR, flags: WALK_FLAGS, bakeGroup: 0,
      });
      g.setCells(ri0, rj0, ri0 + 4, rj0 + 8, { ceilCm: RAMP_CEIL_CM, ceilKind: CeilKind.CONCRETE });
      const wallO = { matNeg: Mat.CONCRETE_WALL, matPos: Mat.CONCRETE_WALL, trim: 0 };
      for (let k = 0; k < 8; k++) {
        const lj = up ? rj0 + k : rj0 + 7 - k; // k counts from the low end
        const top = Math.round(RAMP_RISE * 100 * (k + 1) / 8) + 100; // parapet: 1 m above the ramp at the cell's high end
        g.setEdge('x', ri0, lj, EdgeKind.HALF, { ...wallO, hA: top });
        g.setEdge('x', ri0 + 4, lj, EdgeKind.HALF, { ...wallO, hA: top });
      }
      const topLine = up ? rj0 + 8 : rj0;
      for (let li = ri0; li < ri0 + 4; li++) g.setEdge('z', li, topLine, EdgeKind.WALL, wallO);
      // two cones at the dead end
      const zTop = up ? (rj0 + 8) * CELL - 0.6 : rj0 * CELL + 0.6;
      for (let k = 0; k < 2; k++) {
        g.addProp({
          kind: PropKind.CONE, variant: 0, x: (ri0 + 1 + 2 * k) * CELL, y: RAMP_RISE * (1 - 0.6 / (8 * CELL)), z: zTop,
          yaw: 0, scale: 1, flags: 0, seed: propSeed(gi0 + ri0, gj0 + rj0, 20 + k),
        });
      }
      break;
    }
  }

  /** Blocked for stalls / beams / columns: stamps (global view) or, inside this chunk, reserved cells and the ramp. */
  const blocked = (gi: number, gj: number, useRampMargin: boolean): boolean => {
    const li = gi - gi0, lj = gj - gj0;
    if (inChunk(li, lj)) {
      const c = cellIdx(li, lj);
      if (isReservedCell(l, c) || (useRampMargin ? nearRamp[c] : inRamp[c])) return true;
    }
    return globalBlocked(gi, gj);
  };
  const sameW = sameDistrictAcross(ctx, -1, 0), sameE = sameDistrictAcross(ctx, 1, 0);
  const sameN = sameDistrictAcross(ctx, 0, -1), sameS = sameDistrictAcross(ctx, 0, 1);

  // ---- columns
  const colI0 = gi0 - 1 + mod(p.px - (gi0 - 1), COL_PX), colJ0 = gj0 - 1 + mod(p.pz - (gj0 - 1), COL_PZ);
  for (let gj = colJ0; gj <= gj0 + N + 1; gj += COL_PZ) {
    for (let gi = colI0; gi <= gi0 + N + 1; gi += COL_PX) {
      const x = (gi - gi0) * CELL, z = (gj - gj0) * CELL;
      if (x + COL_HALF <= 0 || x - COL_HALF >= CHUNK_SIZE || z + COL_HALF <= 0 || z - COL_HALF >= CHUNK_SIZE) continue;
      // a column in a neighbouring chunk of another district is not ours to add
      if ((x < COL_HALF && !sameW) || (x > CHUNK_SIZE - COL_HALF && !sameE) || (z < COL_HALF && !sameN) || (z > CHUNK_SIZE - COL_HALF && !sameS)) continue;
      if (blocked(gi - 1, gj - 1, false) || blocked(gi, gj - 1, false) || blocked(gi - 1, gj, false) || blocked(gi, gj, false)) continue;
      g.addSolid({
        kind: 'box', min: [x - COL_HALF, 0, z - COL_HALF], max: [x + COL_HALF, ceilY, z + COL_HALF],
        mat: Mat.CONCRETE_WALL, flags: BOX_FLAGS, bakeGroup: 0,
      });
      // stencilled bay number on the face toward a stall row (only for columns owned by this chunk)
      if (x < 0.4 || x > CHUNK_SIZE - 0.4 || z < 0.4 || z > CHUNK_SIZE - 0.4) continue;
      const b = floorDiv(gj - p.pz, COL_PZ); // band on the +z side of this column row
      const tPlus = bandType(p, b), tMinus = bandType(p, b - 1);
      const h = hash5(ctx.seed, SALT.DECAL, TAG, gi, gj);
      const face = tPlus === 0 && (tMinus !== 2 || (h & 1) === 0) ? 1 : tMinus === 2 ? -1 : 0;
      if (face === 0) continue;
      g.addDecal({
        kind: DecalKind.PARKING_NUMBER, sign: false, px: x, py: 1.55, pz: z + face * COL_HALF, nx: 0, ny: 0, nz: face,
        rot: 0, w: 0.42, h: 0.42, alpha: 0.85 + 0.1 * hash01(h),
      });
    }
  }

  // ---- beams along x on every column row
  for (let gj = colJ0; gj <= gj0 + N + 1; gj += COL_PZ) {
    const z = (gj - gj0) * CELL;
    if (z + BEAM_HALF <= 0 || z - BEAM_HALF >= CHUNK_SIZE) continue;
    if ((z < BEAM_HALF && !sameN) || (z > CHUNK_SIZE - BEAM_HALF && !sameS)) continue;
    for (const [a, b] of freeRuns(0, N, (li) => blocked(gi0 + li, gj - 1, false) || blocked(gi0 + li, gj, false))) {
      const x0 = a === 0 ? (sameW ? 0 : 0.3) : a * CELL;
      const x1 = b === N ? (sameE ? CHUNK_SIZE : CHUNK_SIZE - 0.3) : b * CELL;
      if (x1 - x0 < 0.3) continue;
      g.addSolid({
        kind: 'box', min: [x0, ceilY - BEAM_DEPTH, z - BEAM_HALF], max: [x1, ceilY, z + BEAM_HALF],
        mat: Mat.CONCRETE_CEIL, flags: BOX_FLAGS, bakeGroup: 0,
      });
    }
  }

  // ---- stalls, stripes, wheel stops, cars; drive-aisle centre lines
  const bandJ0 = gj0 - COL_PZ + mod(p.pz - (gj0 - COL_PZ), COL_PZ);
  for (let bj = bandJ0; bj < gj0 + N; bj += COL_PZ) {
    const b = floorDiv(bj - p.pz, COL_PZ);
    const t = bandType(p, b);
    const zb0 = (bj - gj0) * CELL, zb1 = zb0 + COL_PZ * CELL; // band edges (column rows), chunk-local
    if (t === 1) {
      // dashed centre line: 3 m dashes every 6 m on a global pitch
      const zc = (zb0 + zb1) / 2;
      if (zc < 0 || zc >= CHUNK_SIZE) continue;
      const k0 = Math.floor(gi0 * CELL / 6) - 1;
      for (let k = k0; k * 6 < (gi0 + N) * CELL; k++) {
        const gx0 = k * 6 + 1.5, gx1 = gx0 + 3;
        const x0 = Math.max(gx0 - gi0 * CELL, 0), x1 = Math.min(gx1 - gi0 * CELL, CHUNK_SIZE);
        if (x1 - x0 < 0.3) continue;
        const cj = Math.floor(zc / CELL), ci0 = Math.floor(x0 / CELL), ci1 = Math.floor((x1 - 1e-6) / CELL);
        let clear = true;
        for (let ci = ci0; ci <= ci1 && clear; ci++) if (blocked(gi0 + ci, gj0 + cj, true)) clear = false;
        if (clear) paintStripe(g, (x0 + x1) / 2, 0, zc, true, x1 - x0, 0.12, YELLOW, 0.8);
      }
      // travel lanes (1.5 m either side of the centre line): the darker, polished drip line of passing cars, as
      // overlapping faint OIL blotches on a global 2.4 m pitch (owned by the chunk containing the blotch)
      for (const sd of [-1, 1]) {
        const zl = zc + sd * 1.5;
        if (zl < 0.8 || zl > CHUNK_SIZE - 0.8) continue;
        const k0 = Math.floor((gi0 * CELL) / 2.4) - 1;
        for (let k = k0; k * 2.4 < (gi0 + N) * CELL + 2.4; k++) {
          const h = hash5(ctx.seed, SALT.DECAL, TAG + 3, k, b * 2 + (sd > 0 ? 1 : 0));
          if (hash01(h) > 0.8) continue;
          const x = k * 2.4 + 1.2 * hash01(hash2(h, 1)) - gi0 * CELL, z = zl + 0.3 * (hash01(hash2(h, 2)) - 0.5);
          if (x < 0.9 || x > CHUNK_SIZE - 0.9) continue;
          const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
          if (blocked(gi0 + ci, gj0 + cj, true)) continue;
          g.addDecal({
            kind: DecalKind.OIL, sign: false, px: x, py: 0, pz: z, nx: 0, ny: 1, nz: 0, rot: 0.2 * (hash01(hash2(h, 3)) - 0.5),
            w: 1.2 + 0.6 * hash01(hash2(h, 4)), h: 0.45 + 0.3 * hash01(hash2(h, 5)), alpha: 0.18 + 0.2 * hash01(hash2(h, 6)),
          });
        }
      }
      continue;
    }
    const zs0 = t === 0 ? zb0 + STALL_BACK : zb1 - STALL_BACK - STALL_D; // stall z range (chunk-local)
    const zs1 = zs0 + STALL_D;
    if (zs1 <= 0 || zs0 >= CHUNK_SIZE) continue;
    const zBack = t === 0 ? zs0 : zs1;
    // stalls: 3 per 7.2 m bay; stall k of bay a spans x ∈ [(px + 6a)·CELL + 2.4k, + 2.4)
    const sa0 = gi0 - COL_PX + mod(p.px - (gi0 - COL_PX), COL_PX);
    for (let bi = sa0; bi < gi0 + N; bi += COL_PX) {
      for (let k = 0; k < 3; k++) {
        const sgi = bi + 2 * k; // first global cell of the stall
        const xs = (sgi - gi0) * CELL; // stall left edge (chunk-local)
        if (xs + STALL_W <= 0 || xs >= CHUNK_SIZE) continue;
        // the stall exists iff none of its cells is stamped (global test; both chunks agree)
        const gjA = gj0 + Math.floor(zs0 / CELL + 1e-7), gjB = gj0 + Math.floor((zs1 - 1e-6) / CELL);
        let free = true;
        for (let gj = gjA; gj <= gjB && free; gj++) for (let gi = sgi; gi < sgi + 2 && free; gi++) if (blocked(gi, gj, true)) free = false;
        if (!free) continue;
        // left stripe (a stripe centred on a chunk line moves 5 cm east so it lies in one chunk)
        let sx = xs;
        const snap = Math.round(sx / CHUNK_SIZE) * CHUNK_SIZE;
        if (Math.abs(sx - snap) < 0.05) sx = snap + 0.05;
        const sz0 = Math.max(zs0, 0), sz1 = Math.min(zs1, CHUNK_SIZE);
        if (sx >= 0 && sx < CHUNK_SIZE && sz1 - sz0 > 0.2) {
          const h = hash5(ctx.seed, SALT.DECAL, TAG + 1, sgi, b);
          paintStripe(g, sx, 0, (sz0 + sz1) / 2, false, sz1 - sz0, 0.1, paint, 0.6 + 0.35 * hash01(h));
        }
        // the closing stripe of the last stall in a run of free stalls is the next stall's left stripe; draw it
        // explicitly when the next stall is missing
        const nextGi = sgi + 2;
        let nextFree = true;
        for (let gj = gjA; gj <= gjB && nextFree; gj++) for (let gi = nextGi; gi < nextGi + 2 && nextFree; gi++) if (blocked(gi, gj, true)) nextFree = false;
        if (!nextFree) {
          let ex = xs + STALL_W;
          const snap2 = Math.round(ex / CHUNK_SIZE) * CHUNK_SIZE;
          if (Math.abs(ex - snap2) < 0.05) ex = snap2 + 0.05;
          if (ex >= 0 && ex < CHUNK_SIZE && sz1 - sz0 > 0.2) paintStripe(g, ex, 0, (sz0 + sz1) / 2, false, sz1 - sz0, 0.1, paint, 0.8);
        }
        // wheel stop and car, owned by the chunk containing them
        const xc = xs + STALL_W / 2;
        const zStop = zBack + (t === 0 ? 0.85 : -0.85);
        if (xc >= 0 && xc < CHUNK_SIZE && zStop >= 0 && zStop < CHUNK_SIZE) {
          g.addProp({ kind: PropKind.WHEEL_STOP, variant: 0, x: xc, y: 0, z: zStop, yaw: 0, scale: 1, flags: 0, seed: propSeed(sgi, b, 1) });
        }
        // tyre scuffs where cars swing into the stall mouth
        const zMouth = t === 0 ? zs1 - 0.5 : zs0 + 0.5;
        const hs = hash5(ctx.seed, SALT.DECAL, TAG + 4, sgi, b);
        if (hash01(hs) < 0.55 && xc > 1 && xc < CHUNK_SIZE - 1 && zMouth > 1 && zMouth < CHUNK_SIZE - 1) {
          g.addDecal({
            kind: DecalKind.SCUFF, sign: false, px: xc + 0.5 * (hash01(hash2(hs, 1)) - 0.5), py: 0, pz: zMouth, nx: 0, ny: 1, nz: 0,
            rot: (t === 0 ? 0 : Math.PI) + 0.5 * (hash01(hash2(hs, 2)) - 0.5), w: 1.5, h: 1.0, alpha: 0.3 + 0.25 * hash01(hash2(hs, 3)),
          });
        }
        const hc = hash5(ctx.seed, SALT.PROP, TAG + 2, sgi, b);
        const zc = (zs0 + zs1) / 2;
        if (hash01(hc) < CAR_P && xc >= 0 && xc < CHUNK_SIZE && zc >= 0 && zc < CHUNK_SIZE) {
          const noseIn = (hc & 16) !== 0;
          // yaw 0: front toward -z. Stalls of type 0 back onto -z.
          const yaw = (t === 0) === noseIn ? 0 : Math.PI;
          g.addProp({ kind: PropKind.CAR_SEDAN, variant: (hc >>> 5) % 3, x: xc, y: 0, z: zc, yaw, scale: 1, flags: 0, seed: propSeed(sgi, b, 3) });
        }
      }
    }
  }

  // ---- lights: two battens per bay along every band's centre line, between the beams
  for (let bj = bandJ0; bj < gj0 + N; bj += COL_PZ) {
    const cj = bj + 2 - gj0; // middle cell of the band
    if (cj < 0 || cj >= N) continue;
    const zc = (cj + 0.5) * CELL;
    const sa0 = gi0 - COL_PX + mod(p.px - (gi0 - COL_PX), COL_PX);
    for (let bi = sa0; bi < gi0 + N; bi += COL_PX) {
      for (const off of [1, 4]) {
        const ci = bi + off - gi0;
        if (ci < 0 || ci >= N) continue;
        const c = cellIdx(ci, cj);
        if (isReservedCell(l, c) || inRamp[c] || l.ceilCm[c] !== ceilCm) continue;
        const h = hash5(ctx.seed, SALT.FIXTURE, TAG, bi + off, bj);
        const x = (ci + 0.5) * CELL;
        if (hash01(h) < SODIUM_P) {
          placer.add(downRectSpec(FixtureKind.SODIUM, x, ceilY - 0.16, zc, true, 0.45, 0.25, 9000, SODIUM_CCT, 0.7));
        } else {
          placer.add(downRectSpec(FixtureKind.TUBE_STRIP, x, ceilY - 0.06, zc, true, 1.2, 0.1, 8600, TUBE_CCT, 0.6));
        }
      }
    }
  }

  // ---- exhaust fans (ambient emitters)
  const er = new Rng(hash2(rh, 0xfa2));
  for (let k = 0; k < 2; k++) {
    const li = er.int(2, N - 3), lj = er.int(2, N - 3);
    if (isReservedCell(l, cellIdx(li, lj))) continue;
    g.addEmitter(EmitterKind.VENT, (li + 0.5) * CELL, ceilY - 0.1, (lj + 0.5) * CELL, 0.25 + 0.2 * er.float());
  }
}

export const parkingGenerator: ZoneGenerator = {
  id: Zone.PARKING,
  seamMode: 'global',
  districtParams(rng, _s) {
    return { phaseX: rng.int(0, COL_PX - 1), phaseZ: rng.int(0, COL_PZ - 1), bandPhase: rng.int(0, 2), yellow: rng.chance(0.4) ? 1 : 0 };
  },
  globalSeam(_q): SeamEdges {
    return uniformSeam(EdgeKind.OPEN); // all OPEN; columns are solids added by both chunks
  },
  generate,
  palette(_s: StoreyId, _d: DistrictInfo): ZonePalette {
    return {
      floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CONCRETE_WALL, ceilMat: Mat.CONCRETE_CEIL, trimMat: Mat.CONCRETE_WALL,
      ceilKind: CeilKind.BEAMS, ceilCm: 260, baseboard: false,
    };
  },
  lighting(_s: StoreyId, _d: DistrictInfo): LightingProfile {
    return {
      kind: FixtureKind.TUBE_STRIP, placement: 'custom', lattice: [COL_PX * 2, COL_PZ * 2], phase: [0, 0], axis: 0,
      cctRange: [TUBE_CCT[0], TUBE_CCT[1]], luminance: 8600, zoneMul: 1, mountCm: 6,
    };
  },
  props: {
    rules: [
      { kind: PropKind.CONE, where: 'cluster', per100m2: 0.12, variants: 1, minSpacing: 8, yCm: 0 },
      { kind: PropKind.TRASH_CAN, where: 'wall', per100m2: 0.08, variants: 2, minSpacing: 10, yCm: 0 },
      { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 0.1, variants: 1, minSpacing: 12, yCm: 60 },
    ],
  },
};

// exported for tests: the band / column lattice of a district
export const parkingLattice = { COL_PX, COL_PZ, bandType: (d: DistrictInfo, b: number): number => bandType(params(d), b) };
