// src/world/content/fixtures.ts — lattice fixture placement (WP4).
//
// Candidates lie on the global 0.6 m ceiling-tile lattice: tile (tileX, tileZ) with (tileX - phaseX) % latticeX == 0
// (same for z) is the MIN tile of a w x h tile rect (w along lighting.axis). A rect is rejected if it crosses or
// touches a non-OPEN edge (walls are 0.15 m thick, so a rect touching a wall line would intersect it), overlaps a
// SOLID / RESERVED / TOWER / NO_CEIL cell or a solid, spans different ceiling heights, or straddles a render-tile
// line; rejected candidates retry shifted by one tile (+x, then +z). Rooms of >= 4 cells left without a fixture
// get one centred fixture with p 0.5. Ids come from core fixtureId via grid.addFixture({latticeI, latticeJ}).

import { CELL, CEIL_TILE, WALL_T } from '../../core/constants.ts';
import { EDGE_WALKABLE } from '../../core/edges.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, LightState, TileState, cellIdx, exIdx, ezIdx, getTile, hash01, hash2, hash4, isRecessedFixture, lerp, SALT, setTile } from '../../core/index.ts';
import type { ChunkLayout, Fixture, LightingProfile, ZoneGenContext } from '../../core/index.ts';
import { kelvinToLinearRGB } from './kelvin.ts';
import { addLatticeFixture, FIXTURE_DIMS, latticeIndex, N } from './util.ts';

const TN = 2 * N; // 64 tiles per chunk axis
const T2 = WALL_T / 2;
const BAD_CELL = CellFlag.SOLID | CellFlag.RESERVED | CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.NO_CEIL;

/** Low edges (PARTITION / HALF / RAIL) stop at hA; anything else reaches the ceiling (lintels, headers, walls). */
const isLowEdge = (k: number): boolean => k === EdgeKind.PARTITION || k === EdgeKind.HALF || k === EdgeKind.RAIL;

/** Does any non-OPEN edge (thickness box, including end posts) intersect the chunk-local rect?
 * `aboveCm` (ceiling-mounted rects): low edges whose top hA is below it are ignored, so a troffer can hang over a
 * cubicle partition (a dense cubicle farm otherwise gets no lattice fixture at all). */
export function rectHitsEdges(l: ChunkLayout, x0: number, z0: number, x1: number, z1: number, aboveCm = -Infinity): boolean {
  const e = 1e-6;
  // x-edges: line x = i*CELL, span z in [lj*CELL, (lj+1)*CELL]
  const i0 = Math.max(0, Math.floor((x0 - T2) / CELL)), i1 = Math.min(N, Math.ceil((x1 + T2) / CELL));
  const j0 = Math.max(0, Math.floor((z0 - T2) / CELL) - 1), j1 = Math.min(N - 1, Math.ceil((z1 + T2) / CELL));
  for (let i = i0; i <= i1; i++) {
    const X = i * CELL;
    if (!(X - T2 < x1 - e && X + T2 > x0 + e)) continue;
    for (let lj = j0; lj <= j1; lj++) {
      const ei = exIdx(i, lj), k = l.ex.kind[ei];
      if (k === EdgeKind.OPEN || (isLowEdge(k) && l.ex.hA[ei] < aboveCm)) continue;
      if (lj * CELL - T2 < z1 - e && (lj + 1) * CELL + T2 > z0 + e) return true;
    }
  }
  const k0 = Math.max(0, Math.floor((z0 - T2) / CELL)), k1 = Math.min(N, Math.ceil((z1 + T2) / CELL));
  const m0 = Math.max(0, Math.floor((x0 - T2) / CELL) - 1), m1 = Math.min(N - 1, Math.ceil((x1 + T2) / CELL));
  for (let j = k0; j <= k1; j++) {
    const Z = j * CELL;
    if (!(Z - T2 < z1 - e && Z + T2 > z0 + e)) continue;
    for (let li = m0; li <= m1; li++) {
      const ei = ezIdx(li, j), k = l.ez.kind[ei];
      if (k === EdgeKind.OPEN || (isLowEdge(k) && l.ez.hA[ei] < aboveCm)) continue;
      if (li * CELL - T2 < x1 - e && (li + 1) * CELL + T2 > x0 + e) return true;
    }
  }
  return false;
}

/** Does any solid (box / ramp / pipe bounds) reach into [x0,x1] x [z0,z1] at heights >= yMin? */
export function rectHitsSolids(l: ChunkLayout, x0: number, z0: number, x1: number, z1: number, yMin: number): boolean {
  for (const s of l.solids) {
    let a0: number, a1: number, b0: number, b1: number, top: number;
    if (s.kind === 'box') { a0 = s.min[0]; a1 = s.max[0]; b0 = s.min[2]; b1 = s.max[2]; top = s.max[1]; }
    else if (s.kind === 'ramp') { a0 = s.x0; a1 = s.x1; b0 = s.z0; b1 = s.z1; top = Math.max(s.y0, s.y1); }
    else {
      a0 = Math.min(s.a[0], s.b[0]) - s.r; a1 = Math.max(s.a[0], s.b[0]) + s.r;
      b0 = Math.min(s.a[2], s.b[2]) - s.r; b1 = Math.max(s.a[2], s.b[2]) + s.r; top = Math.max(s.a[1], s.b[1]) + s.r;
    }
    if (top < yMin) continue;
    if (a0 < x1 && a1 > x0 && b0 < z1 && b1 > z0) return true;
  }
  return false;
}

/** Tile occupancy (64 x 64 local ceiling tiles) of the fixtures already in the layout. */
function fixtureTiles(l: ChunkLayout): Uint8Array {
  const occ = new Uint8Array(TN * TN);
  for (const f of l.fixtures) {
    const hw = (f.shape === 1 ? f.w : Math.abs(f.tx) > 0.5 ? f.w : f.h) / 2;
    const hd = (f.shape === 1 ? f.w : Math.abs(f.tx) > 0.5 ? f.h : f.w) / 2;
    const ta = Math.max(0, Math.floor((f.px - hw) / CEIL_TILE + 1e-6)), tb = Math.min(TN - 1, Math.ceil((f.px + hw) / CEIL_TILE - 1e-6) - 1);
    const tc = Math.max(0, Math.floor((f.pz - hd) / CEIL_TILE + 1e-6)), td = Math.min(TN - 1, Math.ceil((f.pz + hd) / CEIL_TILE - 1e-6) - 1);
    for (let tz = tc; tz <= td; tz++) for (let tx = ta; tx <= tb; tx++) occ[tz * TN + tx] = 1;
  }
  return occ;
}

interface PlaceCtx { l: ChunkLayout; lp: LightingProfile; wx: number; wz: number; occ: Uint8Array }

/** Is the rect of tiles [tx, tx+wx) x [tz, tz+wz) (chunk-local tiles) a valid fixture site? */
function rectOk(p: PlaceCtx, tx: number, tz: number): boolean {
  const { l, lp, wx, wz, occ } = p;
  if (tx < 0 || tz < 0 || tx + wx > TN || tz + wz > TN) return false;
  // render-tile lines at local tiles 0, 32, 64 (32 tiles = 16 cells)
  if (tx < 32 && tx + wx > 32) return false;
  if (tz < 32 && tz + wz > 32) return false;
  const recessed = isRecessedFixture(lp.kind);
  let ceil = -1;
  for (let z = tz; z < tz + wz; z++) {
    for (let x = tx; x < tx + wx; x++) {
      if (occ[z * TN + x]) return false;
      const c = cellIdx(x >> 1, z >> 1);
      if ((l.flags[c] & BAD_CELL) !== 0) return false;
      const k = l.ceilKind[c];
      if (k === CeilKind.OPEN_DARK) return false;
      if (ceil < 0) ceil = l.ceilCm[c];
      else if (l.ceilCm[c] !== ceil) return false;
      if (l.blockCm[c] > 0 && l.floorCm[c] + l.blockCm[c] > l.ceilCm[c] - 60) return false;
      if (recessed && k === CeilKind.TILES) {
        const st = getTile(l.tiles, c, ((z & 1) << 1) | (x & 1));
        if (st === TileState.MISSING || st === TileState.VENT || st === TileState.FIXTURE) return false;
      }
    }
  }
  const x0 = tx * CEIL_TILE, z0 = tz * CEIL_TILE, x1 = (tx + wx) * CEIL_TILE, z1 = (tz + wz) * CEIL_TILE;
  const py = ceil / 100 - lp.mountCm / 100;
  // low edges are fine under the fixture if their top clears its underside by 0.5 m (partitions 1.5 m vs >= 2.4 m)
  if (rectHitsEdges(l, x0, z0, x1, z1, (py - 0.5) * 100)) return false;
  if (rectHitsSolids(l, x0 - 0.05, z0 - 0.05, x1 + 0.05, z1 + 0.05, py - 0.3)) return false;
  return true;
}

// ---------------------------------------------------------------- photometric scatter (R2 lighting)
// Real ceilings are not uniform: tube batches differ in colour (a few hundred K and a visible green / magenta
// shift), lumen output drifts with lamp age (roughly lognormal), and some 2x4 troffers run with one lamp pair out.
// Only + - * / and core hashing are used (layout hashes must be bit-identical on every engine).

/** exp(x) for |x| <= ~1 by a degree-10 Taylor polynomial (pure arithmetic, error < 1e-8 on that range). */
export function expPoly(x: number): number {
  let term = 1, sum = 1;
  for (let k = 1; k <= 10; k++) { term *= x / k; sum += term; }
  return sum;
}
/** Approximately standard-normal deviate from a hash (Irwin-Hall of 4 uniforms, variance-normalised; |g| <= 3.46). */
export function gaussOf(h: number): number {
  let s = 0;
  for (let k = 0; k < 4; k++) s += hash01(hash2(h, 0x9a55 + k));
  return (s - 2) * Math.sqrt(3);
}
/** Lamp-age luminance scatter: exp(LUM_SIGMA * gauss). */
export const LUM_SIGMA = 0.18;
/** Per-fixture CCT jitter (K, +-) and green / magenta tint (base +- span). */
export const CCT_JITTER = 350, TINT_BASE = 0.02, TINT_SPAN = 0.03;
/** Probability that a lattice 2x4 troffer runs with one lamp pair out (half the rect emits, same nits). */
export const HALF_OUT_P = 0.07;

/** Luminance multiplier, CCT offset (K) and green tint of the fixture hashed by h. */
export function fixtureScatter(h: number): { lumMul: number; dK: number; tint: number } {
  return {
    lumMul: expPoly(LUM_SIGMA * gaussOf(hash2(h, 1))),
    dK: CCT_JITTER * (2 * hash01(hash2(h, 2)) - 1),
    tint: TINT_BASE + TINT_SPAN * (2 * hash01(hash2(h, 6)) - 1),
  };
}

function emit(ctx: ZoneGenContext, p: PlaceCtx, tx: number, tz: number): number {
  const { l, lp, wx, wz, occ } = p;
  const g = ctx.grid;
  const dims = FIXTURE_DIMS[lp.kind];
  const x = (tx + wx / 2) * CEIL_TILE, z = (tz + wz / 2) * CEIL_TILE;
  const c = cellIdx(tx >> 1, tz >> 1);
  const latticeI = latticeIndex(g.gi0, x), latticeJ = latticeIndex(g.gj0, z);
  const h = hash4(ctx.seed, SALT.FIXTURE, latticeI, latticeJ);
  const warm = l.warmth[c] / 256;
  // warmth field: warm (1) -> the low-K end of cctRange (DESIGN: colour drift follows the warmth field), plus the
  // per-fixture tube-batch scatter
  const lo = Math.min(lp.cctRange[0], lp.cctRange[1]), hi = Math.max(lp.cctRange[0], lp.cctRange[1]);
  const sc = fixtureScatter(h);
  const cct = lerp(hi, lo, warm) + sc.dK;
  const color = kelvinToLinearRGB(cct, sc.tint);
  const lum = lp.luminance * sc.lumMul;
  const py = l.ceilCm[c] / 100 - lp.mountCm / 100;
  const tX = lp.axis === 0 ? 1 : 0, tZ = lp.axis === 0 ? 0 : 1;
  const f: Omit<Fixture, 'id' | 'seed' | 'dynamic'> = {
    kind: lp.kind, state: 0, shape: dims.shape, px: x, py, pz: z,
    nx: 0, ny: -1, nz: 0, tx: tX, ty: 0, tz: tZ,
    w: dims.w, h: dims.h, color, luminance: lum, hum: dims.hum, bakeGroup: 0,
  };
  let id: number;
  if (lp.kind === FixtureKind.TROFFER_2x4 && dims.tl === 2 && hash01(hash2(h, 3)) < HALF_OUT_P) {
    // one lamp pair out: two half-size records on the troffer's two tiles, the dead one with luminance 0 (forced
    // OFF by assignFixtureStates: grey lens, no light). Each keeps its own lattice key (distinct tiles).
    const live = hash01(hash2(h, 4)) < 0.5 ? -1 : 1;
    const q = dims.w / 4;
    id = -1;
    for (const sgn of [-1, 1]) {
      const hx = x + sgn * q * tX, hz = z + sgn * q * tZ;
      const half = { ...f, px: hx, pz: hz, w: dims.w / 2, luminance: sgn === live ? lum : 0, hum: sgn === live ? dims.hum : 0 };
      const hid = g.addFixture(half, { latticeI: latticeIndex(g.gi0, hx), latticeJ: latticeIndex(g.gj0, hz) });
      if (sgn === live) id = hid;
    }
  } else id = g.addFixture(f, { latticeI, latticeJ });
  for (let zz = tz; zz < tz + wz; zz++) {
    for (let xx = tx; xx < tx + wx; xx++) {
      occ[zz * TN + xx] = 1;
      if (isRecessedFixture(lp.kind)) setTile(l.tiles, cellIdx(xx >> 1, zz >> 1), ((zz & 1) << 1) | (xx & 1), TileState.FIXTURE);
    }
  }
  return id;
}

export function placeFixtures(ctx: ZoneGenContext): void {
  const lp = ctx.lighting;
  if (lp.placement !== 'lattice') return;
  const g = ctx.grid, l = g.layout;
  const dims = FIXTURE_DIMS[lp.kind];
  const wx = lp.axis === 0 ? dims.tl : dims.ts, wz = lp.axis === 0 ? dims.ts : dims.tl;
  const p: PlaceCtx = { l, lp, wx, wz, occ: fixtureTiles(l) };
  const latX = Math.max(1, lp.lattice[0] | 0), latZ = Math.max(1, lp.lattice[1] | 0);
  const t0x = g.gi0 * 2, t0z = g.gj0 * 2;
  const mod = (a: number, m: number): number => ((a % m) + m) % m;
  const fx = mod(lp.phase[0] - t0x, latX), fz = mod(lp.phase[1] - t0z, latZ);
  for (let tz = fz; tz < TN; tz += latZ) {
    for (let tx = fx; tx < TN; tx += latX) {
      if (rectOk(p, tx, tz)) emit(ctx, p, tx, tz);
      else if (rectOk(p, tx + 1, tz)) emit(ctx, p, tx + 1, tz);
      else if (rectOk(p, tx, tz + 1)) emit(ctx, p, tx, tz + 1);
    }
  }

  // rooms of >= 4 cells without any fixture: one centred fixture with p 0.5
  const count = new Map<number, { n: number; sx: number; sz: number; min: number }>();
  for (let c = 0; c < N * N; c++) {
    const r = l.room[c];
    if (r === 0 || (l.flags[c] & BAD_CELL) !== 0) continue;
    let e = count.get(r);
    if (!e) count.set(r, (e = { n: 0, sx: 0, sz: 0, min: c }));
    e.n++; e.sx += c & 31; e.sz += c >> 5;
  }
  const lit = new Set<number>();
  for (const f of l.fixtures) {
    const li = Math.floor(f.px / CELL), lj = Math.floor(f.pz / CELL);
    if (li >= 0 && lj >= 0 && li < N && lj < N) lit.add(l.room[cellIdx(li, lj)]);
  }
  const rooms = [...count.entries()].sort((a, b) => a[1].min - b[1].min);
  for (const [r, e] of rooms) {
    if (e.n < 4 || lit.has(r)) continue;
    if (hash01(hash4(ctx.seed, SALT.FIXTURE, ctx.key.s, g.gi0 * 4096 + g.gj0 * 64 + e.min)) >= 0.5) continue;
    const ci = e.sx / e.n, cj = e.sz / e.n;
    // room cells by distance to the centroid; the first valid centred rect wins
    const cells: number[] = [];
    for (let c = 0; c < N * N; c++) if (l.room[c] === r) cells.push(c);
    cells.sort((a, b) => {
      const ax = (a & 31) - ci, az = (a >> 5) - cj, bx = (b & 31) - ci, bz = (b >> 5) - cj;
      return ax * ax + az * az - (bx * bx + bz * bz) || a - b;
    });
    for (let k = 0; k < Math.min(cells.length, 12); k++) {
      const li = cells[k] & 31, lj = cells[k] >> 5;
      const tx = 2 * li + 1 - Math.ceil(wx / 2), tz = 2 * lj + 1 - Math.ceil(wz / 2);
      if (rectOk(p, tx, tz)) { emit(ctx, p, tx, tz); lit.add(r); break; }
    }
  }
}

// ---------------------------------------------------------------- emergency lights (R2 lighting)
// Called by assignFixtureStates (after the states and the dynamic rule) outside the DARK zone / DARK mood. A cell
// is "lit" when a lit fixture is within its reach (ON / BUZZ 6 cells, FLICKER 5, DYING 4: a dim lamp reaches less;
// exit signs do not count) AND in line of sight on the cell grid (the segment between the cell centres crosses no
// edge that blocks light: walls, windows; open edges, doorways, arches, headers and low partitions pass). Chunk-border
// cells within EMERGENCY_BORDER of the edge count as lit (the neighbour chunk may light them). While dark open cells
// remain, the dark cell whose bulb would light the most dark cells (>= EMERGENCY_MIN_GAIN; lowest index on ties) gets
// a dim caged bulb (CAGE_BULB, EMERGENCY_CD cd x lamp scatter, 2700-3200 K, ON) hanging EMERGENCY_DROP below its
// ceiling; at most EMERGENCY_MAX per chunk. Landmark cells are left to their landmark. The bulb keeps a dead area a
// dark room lit by spill, never a black void.

export const EMERGENCY_CD = 38;
export const EMERGENCY_BORDER = 2, EMERGENCY_MAX = 6, EMERGENCY_MIN_GAIN = 6, EMERGENCY_REACH = 4;
const EMERGENCY_DROP = 0.14;
const EMERGENCY_CCT: readonly [number, number] = [2700, 3200];
const NO_LIGHT_CELL = BAD_CELL | CellFlag.LANDMARK | CellFlag.VOID;

/** Reach (cells) of a fixture for the pocket rule (0: not a light source). */
function sourceReach(f: Fixture): number {
  if (f.state === LightState.OFF || !(f.luminance > 0) || f.kind === FixtureKind.EXIT_SIGN) return 0;
  if (f.state === LightState.DYING) return 4;
  if (f.state === LightState.FLICKER) return 5;
  return 6;
}
/** Does light pass edge kind k? */
const passes = (k: number): boolean => k === EdgeKind.OPEN || EDGE_WALKABLE[k] || isLowEdge(k);

/** Line of sight between the centres of cells a and b (chunk-local), through edges light passes and open cells. */
function cellLos(l: ChunkLayout, a: number, b: number, open: (c: number) => boolean): boolean {
  let i = a & 31, j = a >> 5;
  const bi = b & 31, bj = b >> 5;
  const dx = bi - i, dz = bj - j;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  // parametric crossings of the x- and z-lines from centre (i + 0.5, j + 0.5)
  const tdx = dx !== 0 ? 1 / Math.abs(dx) : Infinity, tdz = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
  let tx = dx !== 0 ? 0.5 * tdx : Infinity, tz = dz !== 0 ? 0.5 * tdz : Infinity;
  while (i !== bi || j !== bj) {
    if (tx < tz - 1e-9) {
      const k = l.ex.kind[exIdx(sx > 0 ? i + 1 : i, j)];
      if (!passes(k)) return false;
      i += sx; tx += tdx;
    } else if (tz < tx - 1e-9) {
      const k = l.ez.kind[ezIdx(i, sz > 0 ? j + 1 : j)];
      if (!passes(k)) return false;
      j += sz; tz += tdz;
    } else {
      // exact corner crossing: both L-paths must be open (conservative)
      const kx = l.ex.kind[exIdx(sx > 0 ? i + 1 : i, j)], kz = l.ez.kind[ezIdx(i, sz > 0 ? j + 1 : j)];
      if (!passes(kx) || !passes(kz)) return false;
      i += sx; j += sz; tx += tdx; tz += tdz;
    }
    if (i < 0 || j < 0 || i >= N || j >= N) return false;
    if (!(i === bi && j === bj) && !open(cellIdx(i, j))) return false;
  }
  return true;
}

export function placeEmergencyLights(ctx: ZoneGenContext): void {
  const l = ctx.grid.layout;
  const open = (c: number): boolean => (l.flags[c] & NO_LIGHT_CELL) === 0 && l.ceilKind[c] !== CeilKind.OPEN_DARK && l.blockCm[c] === 0;
  const lit = new Uint8Array(N * N);
  const lightFrom = (src: number, reach: number): void => {
    const si = src & 31, sj = src >> 5;
    for (let j = Math.max(0, sj - reach); j <= Math.min(N - 1, sj + reach); j++) {
      for (let i = Math.max(0, si - reach); i <= Math.min(N - 1, si + reach); i++) {
        const c = cellIdx(i, j);
        if (lit[c] || !open(c) || (i - si) * (i - si) + (j - sj) * (j - sj) > reach * reach) continue;
        if (cellLos(l, src, c, open)) lit[c] = 1;
      }
    }
  };
  for (const f of l.fixtures) {
    const r = sourceReach(f);
    if (r === 0) continue;
    const li = Math.floor(f.px / CELL), lj = Math.floor(f.pz / CELL);
    if (li >= 0 && lj >= 0 && li < N && lj < N) lightFrom(cellIdx(li, lj), r);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (i < EMERGENCY_BORDER || j < EMERGENCY_BORDER || i >= N - EMERGENCY_BORDER || j >= N - EMERGENCY_BORDER) lit[cellIdx(i, j)] = 1;
  }
  const tried = new Uint8Array(N * N);
  const R = EMERGENCY_REACH;
  // gain of a candidate = dark open cells its bulb would light. Gains only change near a placed bulb (the cells it
  // lit lie within R of it, so only candidates within 2R see a different count): they are recomputed there only,
  // which gives exactly the same greedy choices as a full rescan per step.
  const gain = new Int32Array(N * N);
  const gainOf = (c: number): number => {
    const ci = c & 31, cj = c >> 5;
    let n = 0;
    for (let j = Math.max(0, cj - R); j <= Math.min(N - 1, cj + R); j++) {
      for (let i = Math.max(0, ci - R); i <= Math.min(N - 1, ci + R); i++) {
        const d = cellIdx(i, j);
        if (lit[d] || !open(d) || (i - ci) * (i - ci) + (j - cj) * (j - cj) > R * R) continue;
        if (cellLos(l, c, d, open)) n++;
      }
    }
    return n;
  };
  for (let c = 0; c < N * N; c++) if (!lit[c] && open(c)) gain[c] = gainOf(c);
  for (let placed = 0, guard = 0; placed < EMERGENCY_MAX && guard < 32; guard++) {
    let best = -1, bestGain = EMERGENCY_MIN_GAIN - 1;
    for (let c = 0; c < N * N; c++) {
      if (lit[c] || tried[c] || !open(c)) continue;
      if (gain[c] > bestGain) { bestGain = gain[c]; best = c; }
    }
    if (best < 0) break;
    tried[best] = 1;
    if (!emergencyBulb(ctx, best)) continue;
    placed++;
    lightFrom(best, R);
    const bi = best & 31, bj = best >> 5;
    for (let j = Math.max(0, bj - 2 * R); j <= Math.min(N - 1, bj + 2 * R); j++) {
      for (let i = Math.max(0, bi - 2 * R); i <= Math.min(N - 1, bi + 2 * R); i++) {
        const c = cellIdx(i, j);
        if (!lit[c] && !tried[c] && open(c)) gain[c] = gainOf(c);
      }
    }
  }
}

/** A caged emergency bulb under the ceiling of cell c (false if it does not fit). */
function emergencyBulb(ctx: ZoneGenContext, c: number): boolean {
  const g = ctx.grid, l = g.layout;
  const li = c & 31, lj = c >> 5;
  const ceil = l.ceilCm[c] / 100, floor = l.floorCm[c] / 100;
  if (ceil - floor < 2.3) return false;
  const x = (li + 0.5) * CELL, z = (lj + 0.5) * CELL, y = ceil - EMERGENCY_DROP;
  if (rectHitsEdges(l, x - 0.1, z - 0.1, x + 0.1, z + 0.1, (y - 0.5) * 100)) return false;
  if (rectHitsSolids(l, x - 0.15, z - 0.15, x + 0.15, z + 0.15, y - 0.4)) return false;
  const wx = g.gi0 * CELL + x, wz = g.gj0 * CELL + z;
  const h = hash4(ctx.seed, SALT.FIXTURE, Math.floor(wx / CEIL_TILE), Math.floor(wz / CEIL_TILE)) ^ 0xe3e;
  const sc = fixtureScatter(h);
  const cct = EMERGENCY_CCT[0] + (EMERGENCY_CCT[1] - EMERGENCY_CCT[0]) * hash01(hash2(h, 5));
  const dims = FIXTURE_DIMS[FixtureKind.CAGE_BULB];
  return addLatticeFixture(g, {
    kind: FixtureKind.CAGE_BULB, state: LightState.ON, shape: dims.shape, px: x, py: y, pz: z,
    nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: dims.w, h: dims.h,
    color: kelvinToLinearRGB(cct, sc.tint), luminance: EMERGENCY_CD * sc.lumMul, hum: dims.hum, bakeGroup: 0,
  }) >= 0;
}
