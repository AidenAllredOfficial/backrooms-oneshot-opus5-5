// src/world/zones/warehouse.ts — WAREHOUSE generator (WP3). GLOBAL seams: rack rows, roof truss, mezzanines.
//
// - Racks: SHELF_RACK rows along x on a global row lattice (rack depth 1 cell, 2-cell aisles: one rack row every
//   3 cells, a 5-cell main aisle every 8th row). Along x the world is cut into 16-cell blocks (aligned with chunks,
//   so no rack straddles a seam): a 2-cell cross aisle, then a row of 10–14 cells (5–7 racks). Racks are props
//   (COLLIDE | OCCLUDE: baker boxes). WP6's rack mesh carries cardboard loads (variant 0 full, variant 1 sparse);
//   sparse racks (more of them with decay) get CRATE / CARDBOARD_BOX props in the free slot of their upper decks
//   (1.2 / 2.4 / 3.6 m). Yellow safety stripes line the rack faces and the cross aisles.
// - Roof (ceilCm 800, CeilKind TRUSS: WP5 draws the corrugated METAL_DECK): girders (0.3 × 0.6 m) along z every
//   9.6 m and bar joists (0.1 wide) along x every 2.4 m, both spanning y ∈ [7.4, 8.0]; joists run between the
//   girders (1 cm into them). Clipped per chunk; neighbouring chunks of the district add the continuation.
// - HIGHBAY over every rack aisle, 7.2 m apart, at 7.0 m (WP6 draws the rod to ceilCm − 0.6); R2 lighting.
// - Mezzanine (p 0.3 per chunk, away from seams): a 6 × 4-cell WALKABLE_TOP slab at 3.0 m on steel posts, HALF-height
//   rails on its open sides, a straight 16-step stair; cage bulbs under the slab; pallets and crates on top.
// Seams are all OPEN.

import { CELL, CHUNK_SIZE } from '../../core/constants.ts';
import { cellIdx, floorDiv, mod } from '../../core/grid.ts';
import { CeilKind, EdgeKind, EmitterKind, FixtureKind, Mat, Mood, PropKind, SolidFlag, Zone, type StoreyId } from '../../core/ids.ts';
import { hash01, hash2, hash4, hash5, Rng, SALT } from '../../core/rng.ts';
import type { DistrictInfo, LightingProfile, SeamEdges, ZoneGenContext, ZoneGenerator, ZonePalette } from '../../core/world.ts';
import {
  BOX_FLAGS, bulbSpec, createFixturePlacer, fieldAt, freeRuns, globalBlockedTest, inChunk, isReservedCell, N,
  paintStripe, RAIL_FLAGS, sameDistrictAcross, uniformSeam, WALK_FLAGS,
} from './deepcommon.ts';

const TAG = Zone.WAREHOUSE * 16;
const ROW_PITCH = 3; // rack row every 3 cells (1 rack + 2 aisle)
const MAIN_AISLE_EVERY = 8; // rows; the 5th row of every 8 is left out (a 5-cell main aisle)
const BLOCK = 16; // x-block (cells): 2-cell cross aisle + rack row
const CROSS = 2;
const GIRDER_PITCH = 8; // cells (9.6 m)
const JOIST_PITCH = 2; // cells (2.4 m)
const HIGHBAY_PITCH = 10; // cells (12 m): thin roofs (SPARSE / DARK moods)
const AISLE_BAY_PITCH = 6; // cells (7.2 m) between the high-bays of one aisle
const HIGHBAY_CD = 3200; // cd on axis (~250 W HID); R2: was 2000
const TRUSS_Y0 = 7.4, TRUSS_Y1 = 8.0;
const GIRDER_HALF = 0.15, JOIST_HALF = 0.05;
const SHELF_Y = [1.2, 2.4, 3.6] as const; // deck tops of WP6's SHELF_RACK (props/industrial.ts RACK_LEVELS)
const SLOT_X = 0.72; // rack-local x of the deck slot WP6's variant 1 leaves empty on the upper decks
const MEZZ_Y = 3.0, MEZZ_T = 0.2, RAIL_H = 1.05;
const HIGHBAY_CCT: readonly [number, number] = [4000, 5000];
const BULB_CCT: readonly [number, number] = [2700, 3000];
const SAFETY: readonly [number, number, number] = [1.0, 0.72, 0.06];

interface WhParams { rowPhase: number; mezzP: number }
const params = (d: DistrictInfo): WhParams => ({ rowPhase: d.params.rowPhase ?? 0, mezzP: d.params.mezzP ?? 0.3 });

/** Is global row gj a rack row? */
function isRackRow(p: WhParams, gj: number): boolean {
  if (mod(gj - p.rowPhase, ROW_PITCH) !== 0) return false;
  return mod(floorDiv(gj - p.rowPhase, ROW_PITCH), MAIN_AISLE_EVERY) !== 4;
}
/** Rack row extent inside x-block `bk` of row gj: [gi0, gi1) global cells, even length 10–14. */
function rackSpan(seed: number, s: number, gj: number, bk: number): [number, number] {
  const h = hash5(seed, SALT.GLOBAL_FEATURE, TAG + s, gj, bk);
  const len = 10 + 2 * (h % 3);
  const start = bk * BLOCK + CROSS + ((h >>> 4) % 2 === 0 ? 0 : 14 - len); // flush with one cross aisle or the other
  return [start, start + len];
}

function generate(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout;
  const { s } = ctx.key;
  const p = params(ctx.district);
  const gi0 = g.gi0, gj0 = g.gj0;
  const ceilY = ctx.palette.ceilCm / 100;
  const globalBlocked = globalBlockedTest(ctx);
  const placer = createFixturePlacer(ctx);
  const rng = ctx.rng;
  const propSeed = (a: number, b: number, k: number): number => hash5(ctx.seed, SALT.PROP, TAG + k, a, b);

  // ---- mezzanine (decided first so racks keep clear of it)
  const mezz = new Uint8Array(N * N); // slab + stair + 1-cell margin: no racks
  if (rng.chance(p.mezzP)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const alongX = rng.chance(0.5);
      const w = alongX ? 6 : 4, d = alongX ? 4 : 6; // slab size (cells) along x, z
      const i0 = rng.int(3, N - 3 - w - (alongX ? 0 : 4)), j0 = rng.int(3, N - 3 - d - (alongX ? 4 : 0));
      // the stair (1 x 4 cells) leaves the slab from the end of a long side
      const stairAtHigh = rng.chance(0.5);
      let st: { i0: number; j0: number; i1: number; j1: number; dir: 0 | 1 | 2 | 3 };
      if (alongX) {
        const si = stairAtHigh ? i0 + w - 1 : i0;
        st = { i0: si, j0: j0 + d, i1: si + 1, j1: j0 + d + 4, dir: 3 }; // south of the slab, ascending toward -z
      } else {
        const sj = stairAtHigh ? j0 + d - 1 : j0;
        st = { i0: i0 + w, j0: sj, i1: i0 + w + 4, j1: sj + 1, dir: 1 }; // east of the slab, ascending toward -x
      }
      const bi0 = Math.min(i0, st.i0) - 1, bj0 = Math.min(j0, st.j0) - 1, bi1 = Math.max(i0 + w, st.i1) + 1, bj1 = Math.max(j0 + d, st.j1) + 1;
      if (bi0 < 2 || bj0 < 2 || bi1 > N - 2 || bj1 > N - 2) continue;
      let ok = true;
      for (let lj = bj0; lj < bj1 && ok; lj++) for (let li = bi0; li < bi1 && ok; li++) {
        if (isReservedCell(l, cellIdx(li, lj)) || globalBlocked(gi0 + li, gj0 + lj)) ok = false;
      }
      if (!ok) continue;
      for (let lj = bj0; lj < bj1; lj++) for (let li = bi0; li < bi1; li++) mezz[cellIdx(li, lj)] = 1;
      buildMezzanine(ctx, i0, j0, w, d, st, placer);
      break;
    }
  }

  // ---- racks + shelf stock + safety stripes
  const stock = (c: number): number => 0.75 - 0.5 * fieldAt(l.decay, c);
  for (let lj = 0; lj < N; lj++) {
    const gj = gj0 + lj;
    if (!isRackRow(p, gj)) continue;
    for (let bk = floorDiv(gi0, BLOCK); bk * BLOCK < gi0 + N; bk++) {
      const [a, b] = rackSpan(ctx.seed, s, gj, bk);
      // racks sit on 2-cell pairs; a pair touching a stamp or the mezzanine is left out
      let runStart = -1; // local cell index of the current run's first rack (-1: none)
      const flushStripes = (endGi: number): void => {
        if (runStart < 0) return;
        const x0 = runStart * CELL, x1 = (endGi - gi0) * CELL;
        for (const zz of [lj * CELL - 0.1, (lj + 1) * CELL + 0.1]) {
          if (zz > 0.06 && zz < CHUNK_SIZE - 0.06) paintStripe(g, (x0 + x1) / 2, 0, zz, true, x1 - x0, 0.1, SAFETY, 0.85);
        }
        runStart = -1;
      };
      for (let gi = a; gi < b; gi += 2) {
        const li = gi - gi0;
        const c0 = cellIdx(li, lj), c1 = cellIdx(li + 1, lj);
        const free = inChunk(li, lj) && !isReservedCell(l, c0) && !isReservedCell(l, c1) && !mezz[c0] && !mezz[c1];
        if (!free) { flushStripes(gi); continue; }
        if (runStart < 0) runStart = li;
        const x = (li + 1) * CELL, z = (lj + 0.5) * CELL;
        const hv = hash4(ctx.seed, SALT.PROP, gi, gj);
        // WP6's SHELF_RACK carries its own cardboard loads: variant 0 is fully stocked (8 loads), variant 1 is
        // sparse (5 loads) and leaves the +x slot of the three upper decks free; decay makes racks sparser
        const fill = stock(c0);
        const variant = hash01(hash2(hv, 0x51)) < 0.35 + 0.8 * fieldAt(l.decay, c0) ? 1 : 0;
        g.addProp({
          kind: PropKind.SHELF_RACK, variant, x, y: 0, z, yaw: 0, scale: 1,
          flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE, seed: propSeed(gi, gj, 0),
        });
        if (variant !== 1) continue;
        // extra stock in the free slots: crates (scaled to the deck clearance) and cardboard boxes
        const r = new Rng(hash2(hv, 0x57c));
        for (const y of SHELF_Y) {
          if (!r.chance(fill)) continue;
          const sx = x + SLOT_X + r.range(-0.03, 0.03), sz = z + r.range(-0.05, 0.05);
          if (r.chance(0.4)) {
            g.addProp({ kind: PropKind.CRATE, variant: r.int(0, 2), x: sx, y, z: sz, yaw: 0, scale: 0.62, flags: 0, seed: r.next() });
          } else {
            const n = r.chance(0.5) ? 2 : 1;
            for (let k = 0; k < n; k++) {
              g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: r.int(0, 3), x: sx + r.range(-0.04, 0.04), y: y + 0.4 * k, z: sz, yaw: r.range(-0.12, 0.12), scale: 1, flags: 0, seed: r.next() });
            }
          }
        }
      }
      flushStripes(b);
    }
  }
  // cross-aisle stripes along z (both edges of every cross aisle), broken at stamps and the mezzanine
  for (let bk = floorDiv(gi0, BLOCK); bk * BLOCK < gi0 + N; bk++) {
    for (const xLine of [bk * BLOCK * CELL + 0.15, (bk * BLOCK + CROSS) * CELL - 0.15]) {
      const x = xLine - gi0 * CELL;
      if (x <= 0 || x >= CHUNK_SIZE) continue;
      const li = Math.floor(x / CELL);
      for (const [a, b] of freeRuns(0, N, (lj) => isReservedCell(l, cellIdx(li, lj)) || mezz[cellIdx(li, lj)] === 1)) {
        paintStripe(g, x, 0, (a + b) * CELL / 2, false, (b - a) * CELL, 0.1, SAFETY, 0.85);
      }
    }
  }

  // ---- roof structure
  const sameW = sameDistrictAcross(ctx, -1, 0), sameE = sameDistrictAcross(ctx, 1, 0);
  const sameN = sameDistrictAcross(ctx, 0, -1), sameS = sameDistrictAcross(ctx, 0, 1);
  const roofBlocked = (gi: number, gj: number): boolean => {
    const li = gi - gi0, lj = gj - gj0;
    if (inChunk(li, lj) && isReservedCell(l, cellIdx(li, lj))) return true;
    return globalBlocked(gi, gj);
  };
  const girderLive: boolean[] = [];
  for (let k = 0; k <= N / GIRDER_PITCH; k++) {
    const li = k * GIRDER_PITCH; // chunk origins are multiples of 9.6 m: girder lines are local 0, 8, 16, 24, 32
    const x = li * CELL;
    const live = (li !== 0 || sameW) && (li !== N || sameE);
    girderLive.push(live);
    if (!live) continue;
    for (const [a, b] of freeRuns(0, N, (lj) => roofBlocked(gi0 + li - 1, gj0 + lj) || roofBlocked(gi0 + li, gj0 + lj))) {
      const z0 = a === 0 ? (sameN ? 0 : 0.3) : a * CELL, z1 = b === N ? (sameS ? CHUNK_SIZE : CHUNK_SIZE - 0.3) : b * CELL;
      g.addSolid({ kind: 'box', min: [x - GIRDER_HALF, TRUSS_Y0, z0], max: [x + GIRDER_HALF, TRUSS_Y1, z1], mat: Mat.METAL_PAINTED, flags: BOX_FLAGS, bakeGroup: 0 });
    }
  }
  for (let lj = 0; lj <= N; lj += JOIST_PITCH) {
    const gj = gj0 + lj;
    if (mod(gj, JOIST_PITCH) !== 0) continue;
    if ((lj === 0 && !sameN) || (lj === N && !sameS)) continue;
    const z = lj * CELL;
    for (let k = 0; k < N / GIRDER_PITCH; k++) {
      const bayA = k * GIRDER_PITCH, bayB = bayA + GIRDER_PITCH;
      for (const [a, b] of freeRuns(bayA, bayB, (li) => roofBlocked(gi0 + li, gj - 1) || roofBlocked(gi0 + li, gj))) {
        const x0 = a === bayA && girderLive[k] ? a * CELL + GIRDER_HALF - 0.01 : a * CELL;
        const x1 = b === bayB && girderLive[k + 1] ? b * CELL - GIRDER_HALF + 0.01 : b * CELL;
        if (x1 - x0 < 0.2) continue;
        g.addSolid({ kind: 'box', min: [x0, TRUSS_Y0, z - JOIST_HALF], max: [x1, TRUSS_Y1, z + JOIST_HALF], mat: Mat.METAL_PAINTED, flags: BOX_FLAGS, bakeGroup: 0 });
      }
    }
  }

  // ---- high-bay lights (R2 lighting): one row over the centre line of every rack aisle (the 2-cell aisles and the
  // 5-cell main aisles), AISLE_BAY_PITCH cells (7.2 m) apart along x, staggered by half a pitch on alternate aisles,
  // at 7.0 m (from the truss). The racks (4.8 m) shade the neighbouring aisles, so a lattice of lights every 12 m
  // left 47% of the floor > 7 m from a lit fixture (black aisles). SPARSE / DARK moods keep a thin roof: every other
  // aisle, 12 m apart. 15-25% of them are dead (content/fixtureStates.ts HIGHBAY_OFF_P).
  const thin = l.mood === Mood.SPARSE || l.mood === Mood.DARK;
  const pitchX = thin ? HIGHBAY_PITCH : AISLE_BAY_PITCH;
  for (let gj = gj0 - ROW_PITCH - 3; gj < gj0 + N; gj++) {
    if (!isRackRow(p, gj)) continue;
    const k = floorDiv(gj - p.rowPhase, ROW_PITCH); // rack row index
    if (thin && mod(k, 2) === 1) continue;
    const zc = isRackRow(p, gj + ROW_PITCH) ? gj + 2 : gj + 3.5; // aisle centre line (global cells)
    const lz = zc - gj0;
    if (lz < 0.5 || lz > N - 0.5) continue;
    const cj = Math.floor(zc - 1e-6), cj1 = Math.floor(zc); // the cell rows the fixture sits over
    const stagger = mod(k, 2) === 1 ? pitchX >> 1 : 0;
    const hi0 = gi0 + mod(stagger + 3 - gi0, pitchX);
    for (let gi = hi0; gi < gi0 + N; gi += pitchX) {
      const li = gi - gi0;
      if (roofBlocked(gi, cj) || roofBlocked(gi, cj1)) continue;
      const c = cellIdx(li, cj - gj0 < 0 ? 0 : cj - gj0 >= N ? N - 1 : cj - gj0);
      if (l.ceilCm[c] !== ctx.palette.ceilCm) continue;
      placer.add({
        kind: FixtureKind.HIGHBAY, shape: 1, px: (li + 0.5) * CELL, py: ceilY - 1.0, pz: lz * CELL + 0.001,
        nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 0.45, h: 0.45, cct: HIGHBAY_CCT, luminance: HIGHBAY_CD, hum: 0.5,
      });
    }
  }

  // ---- ambience: roof exhaust fan
  const fr = new Rng(hash5(ctx.seed, SALT.EMITTER, TAG, ctx.key.cx, ctx.key.cz));
  const fi = fr.int(2, N - 3), fj = fr.int(2, N - 3);
  if (!isReservedCell(l, cellIdx(fi, fj))) g.addEmitter(EmitterKind.VENT, (fi + 0.5) * CELL, ceilY - 0.3, (fj + 0.5) * CELL, 0.3);
}

function buildMezzanine(ctx: ZoneGenContext, i0: number, j0: number, w: number, d: number,
  st: { i0: number; j0: number; i1: number; j1: number; dir: 0 | 1 | 2 | 3 },
  placer: ReturnType<typeof createFixturePlacer>): void {
  const g = ctx.grid;
  const x0 = i0 * CELL, z0 = j0 * CELL, x1 = (i0 + w) * CELL, z1 = (j0 + d) * CELL;
  const rng = new Rng(hash4(ctx.seed, SALT.GLOBAL_FEATURE, g.gi0 + i0, g.gj0 + j0));
  // slab
  g.addSolid({ kind: 'box', min: [x0, MEZZ_Y - MEZZ_T, z0], max: [x1, MEZZ_Y, z1], mat: Mat.CONCRETE_FLOOR, flags: WALK_FLAGS, bakeGroup: 0 });
  // steel posts at the corners and every ~3 cells along the long sides
  const posts: [number, number][] = [];
  const nx = w >= 6 ? 3 : 2, nz = d >= 6 ? 3 : 2;
  for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
    if (a !== 0 && a !== nx - 1 && b !== 0 && b !== nz - 1) continue;
    posts.push([x0 + 0.2 + (x1 - x0 - 0.4) * a / (nx - 1), z0 + 0.2 + (z1 - z0 - 0.4) * b / (nz - 1)]);
  }
  for (const [px, pz] of posts) {
    g.addSolid({ kind: 'box', min: [px - 0.1, 0, pz - 0.1], max: [px + 0.1, MEZZ_Y - MEZZ_T, pz + 0.1], mat: Mat.METAL_PAINTED, flags: BOX_FLAGS, bakeGroup: 0 });
  }
  // rails on the open sides (a gap where the stair arrives)
  const gapA = st.dir === 3 ? st.i0 * CELL : st.j0 * CELL, gapB = st.dir === 3 ? st.i1 * CELL : st.j1 * CELL;
  const railSeg = (ax0: number, az0: number, ax1: number, az1: number): void => {
    if (ax1 - ax0 < 0.04 || az1 - az0 < 0.04) return;
    g.addSolid({ kind: 'box', min: [ax0, MEZZ_Y, az0], max: [ax1, MEZZ_Y + RAIL_H, az1], mat: Mat.METAL_PAINTED, flags: RAIL_FLAGS, bakeGroup: 0 });
  };
  const T = 0.05;
  railSeg(x0, z0, x1, z0 + T); // north
  railSeg(x0, z0 + T, x0 + T, z1 - T); // west
  if (st.dir === 3) {
    railSeg(x1 - T, z0 + T, x1, z1 - T); // east
    railSeg(x0, z1 - T, gapA, z1); railSeg(gapB, z1 - T, x1, z1); // south with the stair gap
  } else {
    railSeg(x0, z1 - T, x1, z1); // south
    railSeg(x1 - T, z0 + T, x1, gapA); railSeg(x1 - T, gapB, x1, z1 - T); // east with the stair gap
  }
  // stair: 16 steps from the floor up to the slab edge, closed stringer walls (HALF edges) on both sides
  g.addSolid({
    kind: 'ramp', x0: st.i0 * CELL, z0: st.j0 * CELL, x1: st.i1 * CELL, z1: st.j1 * CELL, y0: 0, y1: MEZZ_Y,
    dir: st.dir, steps: 16, mat: Mat.METAL_PAINTED, flags: WALK_FLAGS, bakeGroup: 0,
  });
  const wallO = { matNeg: Mat.METAL_PAINTED, matPos: Mat.METAL_PAINTED, trim: 0 };
  for (let k = 0; k < 4; k++) {
    // k-th cell from the low end; parapet top 1 m above its high end
    const top = Math.round(MEZZ_Y * 100 * (k + 1) / 4) + 100;
    if (st.dir === 3) {
      const lj = st.j1 - 1 - k;
      g.setEdge('x', st.i0, lj, EdgeKind.HALF, { ...wallO, hA: top });
      g.setEdge('x', st.i1, lj, EdgeKind.HALF, { ...wallO, hA: top });
    } else {
      const li = st.i1 - 1 - k;
      g.setEdge('z', li, st.j0, EdgeKind.HALF, { ...wallO, hA: top });
      g.setEdge('z', li, st.j1, EdgeKind.HALF, { ...wallO, hA: top });
    }
  }
  // cage bulbs under the slab
  const cy = MEZZ_Y - MEZZ_T - 0.14; // WP6 cage-bulb default mount (0.14 m) when the ceiling is far: stem meets the slab
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const off = w >= d ? [[-(x1 - x0) / 4, 0], [(x1 - x0) / 4, 0]] : [[0, -(z1 - z0) / 4], [0, (z1 - z0) / 4]];
  for (const [ox, oz] of off) placer.add(bulbSpec(mx + ox, cy, mz + oz, 64, BULB_CCT, 0.3));
  // stock on top: pallets and crates, away from the stair landing
  const n = rng.int(2, 4);
  for (let k = 0; k < n; k++) {
    const px = rng.range(x0 + 0.9, x1 - 0.9), pz = rng.range(z0 + 0.9, z1 - 0.9);
    const lx = st.dir === 3 ? (st.i0 + 0.5) * CELL : x1, lz = st.dir === 3 ? z1 : (st.j0 + 0.5) * CELL;
    if (Math.abs(px - lx) < 1.6 && Math.abs(pz - lz) < 1.6) continue;
    const kind = rng.chance(0.5) ? PropKind.PALLET : PropKind.CRATE;
    g.addProp({ kind, variant: rng.int(0, 2), x: px, y: MEZZ_Y, z: pz, yaw: rng.chance(0.5) ? 0 : Math.PI / 2, scale: 1, flags: 0, seed: rng.next() });
  }
}

export const warehouseGenerator: ZoneGenerator = {
  id: Zone.WAREHOUSE,
  seamMode: 'global',
  districtParams(rng, _s) {
    return { rowPhase: rng.int(0, ROW_PITCH - 1), mezzP: 0.3 };
  },
  globalSeam(_q): SeamEdges {
    return uniformSeam(EdgeKind.OPEN);
  },
  generate,
  palette(_s: StoreyId, _d: DistrictInfo): ZonePalette {
    return {
      floorMat: Mat.CONCRETE_FLOOR, wallMat: Mat.CMU_PAINTED, ceilMat: Mat.METAL_DECK, trimMat: Mat.CMU_PAINTED,
      ceilKind: CeilKind.TRUSS, ceilCm: 800, baseboard: false,
    };
  },
  lighting(_s: StoreyId, _d: DistrictInfo): LightingProfile {
    return {
      kind: FixtureKind.HIGHBAY, placement: 'custom', lattice: [HIGHBAY_PITCH * 2, HIGHBAY_PITCH * 2], phase: [0, 0], axis: 0,
      cctRange: [HIGHBAY_CCT[0], HIGHBAY_CCT[1]], luminance: HIGHBAY_CD, zoneMul: 1, mountCm: 100,
    };
  },
  props: {
    rules: [
      { kind: PropKind.PALLET, where: 'aisle', per100m2: 0.25, variants: 3, minSpacing: 3, yCm: 0 },
      { kind: PropKind.CRATE, where: 'cluster', per100m2: 0.12, variants: 3, minSpacing: 6, yCm: 0 },
      { kind: PropKind.CARDBOARD_BOX, where: 'cluster', per100m2: 0.2, variants: 4, minSpacing: 4, yCm: 0 },
      { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 0.1, variants: 1, minSpacing: 12, yCm: 60 },
    ],
  },
};

/** Test hook: roof lattice constants (joist lines every JOIST_PITCH global cells on z = gj·CELL, gj even). */
export const warehouseRoof = { TRUSS_Y0, TRUSS_Y1, JOIST_PITCH, GIRDER_PITCH, HIGHBAY_PITCH, SHELF_Y };
