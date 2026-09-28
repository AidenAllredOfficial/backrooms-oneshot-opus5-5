// tests/world/zones-deep.test.ts — WP3 deep-strata zone generators (POOLROOMS, PARKING, PIPEWORKS, WAREHOUSE,
// CONCRETE). The generators are driven through a minimal re-implementation of WP1's pipeline steps 2–7 (palette
// fill, fields, seams + freeze, optional artery stamp, generate) on top of WP1's real createChunkGrid, so the tests
// do not depend on the rest of the chunk pipeline. Set DUMP_DEEP=1 to write ASCII maps to /tmp/wp3-maps.

import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE } from '../../src/core/constants.ts';
import { EDGE_WALKABLE } from '../../src/core/edges.ts';
import { cellIdx, exIdx, ezIdx, type ChunkKey } from '../../src/core/grid.ts';
import {
  CeilKind, CellFlag, DECAL_PAINT_STRIPE, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, Mat, Mood,
  PropKind, SeamMode, SolidFlag, Zone, type LandmarkKindId, type StoreyId, type ZoneId,
} from '../../src/core/ids.ts';
import { createEmptyLayout, NO_WATER, type ChunkLayout, type Solid } from '../../src/core/layout.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { Rng, rngFor, SALT } from '../../src/core/rng.ts';
import type {
  ArterySpan, DistrictInfo, SeamEdges, SeamSpec, WorldGenQuery, ZoneGenContext, ZoneGenerator,
} from '../../src/core/world.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { cellWalkable as wp1Walkable, find, portCells, repairConnectivity, walkComponents } from '../../src/world/connectivity.ts';
import { labelRooms } from '../../src/world/rooms.ts';
import { createFieldSampler } from '../../src/world/fields.ts';
import { layoutHash, validateLayout } from '../../src/world/validate.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { defaultPatternSeam } from '../../src/world/zones/defaultSeam.ts';
import { concreteGenerator } from '../../src/world/zones/concrete.ts';
import { parkingGenerator } from '../../src/world/zones/parking.ts';
import { pipeworksGenerator } from '../../src/world/zones/pipeworks.ts';
import { PoolVariant, poolroomsGenerator, poolroomsRoomInfo, poolroomsWallRemoved } from '../../src/world/zones/poolrooms.ts';
import { warehouseGenerator, warehouseRoof } from '../../src/world/zones/warehouse.ts';
import { sweepSize } from '../scale.ts';
import { sameValues } from '../util/check.ts';

const N = CHUNK_CELLS;
const GENS: Record<string, ZoneGenerator> = {
  POOLROOMS: poolroomsGenerator, PARKING: parkingGenerator, PIPEWORKS: pipeworksGenerator,
  WAREHOUSE: warehouseGenerator, CONCRETE: concreteGenerator,
};
const STOREY: Record<string, StoreyId> = { POOLROOMS: 2, PARKING: 1, PIPEWORKS: 1, WAREHOUSE: 1, CONCRETE: 1 };

// ---------------------------------------------------------------- mini pipeline

interface WorldOpts {
  seed: number;
  s: StoreyId;
  gen: ZoneGenerator;
  params?: Record<string, number>;
  arteries?: ArterySpan[];
  /** district id per chunk (default: one district everywhere) */
  districtOf?: (cx: number, cz: number) => number;
}
interface TestWorld { opts: WorldOpts; district(cx: number, cz: number): DistrictInfo; query: WorldGenQuery }

function makeWorld(o: WorldOpts): TestWorld {
  const params = o.params ?? o.gen.districtParams(rngFor(o.seed, SALT.DISTRICT_PARAMS, o.s, 0, 0), o.s);
  const cache = new Map<number, DistrictInfo>();
  const district = (cx: number, cz: number): DistrictInfo => {
    const id = o.districtOf ? o.districtOf(cx, cz) : 4242;
    let d = cache.get(id);
    if (!d) {
      d = {
        id, s: o.s, zone: id === 4242 ? o.gen.id : Zone.LOBBY, mood: Mood.NORMAL, siteX: 0, siteZ: 0, seed: o.seed,
        params: id === 4242 ? params : {},
      };
      cache.set(id, d);
    }
    return d;
  };
  const query: WorldGenQuery = {
    districtAt: (_s, cx, cz) => district(cx, cz),
    arteriesNear: () => o.arteries ?? [],
    towersNear: () => [],
  };
  return { opts: o, district, query };
}

function seamEdges(w: TestWorld, axis: 'x' | 'z', cx: number, cz: number): SeamEdges {
  const { gen, seed, s } = w.opts;
  const dB = w.district(cx, cz);
  const dA = axis === 'x' ? w.district(cx - 1, cz) : w.district(cx, cz - 1);
  if (dA.id !== dB.id) {
    // boundary seam stand-in: WALL with two 2-cell OPEN gaps
    const e: SeamEdges = { kind: new Uint8Array(N).fill(EdgeKind.WALL), hA: new Int16Array(N), hB: new Int16Array(N) };
    e.kind[7] = e.kind[8] = e.kind[22] = e.kind[23] = EdgeKind.OPEN;
    return e;
  }
  if (gen.seamMode === 'global') {
    return gen.globalSeam!({ seed, s, district: dB, axis, line: axis === 'x' ? cx * N : cz * N, g0: axis === 'x' ? cz * N : cx * N });
  }
  const rng = rngFor(seed, SALT.SEAM, s, axis === 'x' ? 0 : 1, cx, cz);
  return gen.seamPattern ? gen.seamPattern(rng, dB) : defaultPatternSeam(rng);
}

function seamSpec(w: TestWorld, axis: 'x' | 'z', cx: number, cz: number): SeamSpec {
  const e = seamEdges(w, axis, cx, cz);
  // WP1 post-rules used here: artery lanes forced OPEN, >= 1 walkable edge
  for (const a of w.opts.arteries ?? []) {
    if ((a.axis === 'x') === (axis === 'x')) {
      // lanes along x cross 'x' lines (lines x = const) ... an axis-'x' artery runs along x, crossing lines x = const
      const line = axis === 'x' ? cx * N : cz * N;
      const g0 = axis === 'x' ? cz * N : cx * N;
      if (line >= a.g0 && line <= a.g1) for (let k = 0; k < 2; k++) { const c = a.row + k - g0; if (c >= 0 && c < N) e.kind[c] = EdgeKind.OPEN; }
    }
  }
  let walk = 0;
  for (let c = 0; c < N; c++) if (EDGE_WALKABLE[e.kind[c]]) walk++;
  if (walk === 0) e.kind[4] = EdgeKind.OPEN;
  const pal = w.opts.gen.palette(w.opts.s, w.district(cx, cz));
  return {
    ...e, mode: w.opts.gen.seamMode === 'global' ? SeamMode.GLOBAL : SeamMode.PATTERN,
    matNeg: new Uint8Array(N).fill(pal.wallMat), matPos: new Uint8Array(N).fill(pal.wallMat), trim: new Uint8Array(N),
  };
}

/** Stamps an artery lane like WP1 step 5 (RESERVED|ARTERY cells, flanking walls with a door every 6 cells). */
function stampArteries(l: ChunkLayout, grid: ReturnType<typeof createChunkGrid>, arteries: readonly ArterySpan[]): void {
  const { cx, cz } = l.key;
  for (const a of arteries) {
    for (let k = 0; k < N; k++) {
      for (let w = 0; w < 2; w++) {
        const gi = a.axis === 'x' ? cx * N + k : a.row + w, gj = a.axis === 'x' ? a.row + w : cz * N + k;
        const along = a.axis === 'x' ? gi : gj;
        if (along < a.g0 || along >= a.g1) continue;
        const li = gi - cx * N, lj = gj - cz * N;
        if (li < 0 || lj < 0 || li >= N || lj >= N) continue;
        grid.setCells(li, lj, li + 1, lj + 1, { flagsSet: CellFlag.RESERVED | CellFlag.ARTERY, floorCm: 0, ceilCm: 300, floorMat: Mat.CONCRETE_FLOOR });
      }
    }
    // flanking walls
    for (let k = 0; k < N; k++) {
      const along = (a.axis === 'x' ? cx : cz) * N + k;
      if (along < a.g0 || along >= a.g1) continue;
      for (const lineG of [a.row, a.row + 2]) {
        const line = lineG - (a.axis === 'x' ? cz : cx) * N;
        if (line <= 0 || line >= N) continue;
        const kind = k % 6 === 3 ? EdgeKind.DOORWAY : EdgeKind.WALL;
        if (a.axis === 'x') grid.setEdge('z', k, line, kind, undefined, true);
        else grid.setEdge('x', line, k, kind, undefined, true);
      }
    }
  }
}

interface GenOut {
  l: ChunkLayout; before: ChunkLayout; ctx: ZoneGenContext;
  /** share of walkable cells in the largest component right after generate() (before WP1's repair) */
  share: number;
  repair: { carved: number; sealed: number };
  /** problems found right after generate() (reserved cells / frozen seams touched) */
  early: string[];
}

/** Ports as WP1 computes them: maximal runs of walkable seam edges, W, N, E, S. */
function ports(l: ChunkLayout): ChunkLayout['ports'] {
  const out: ChunkLayout['ports'] = [];
  const walk = (e: typeof l.ex, i: number): boolean => EDGE_WALKABLE[e.kind[i]] && (e.kind[i] !== EdgeKind.HEADER || e.hA[i] >= 190);
  const side = (name: 'W' | 'N' | 'E' | 'S', f: (c: number) => boolean): void => {
    let from = -1;
    for (let c = 0; c <= N; c++) {
      const w = c < N && f(c);
      if (w && from < 0) from = c;
      else if (!w && from >= 0) { out.push({ side: name, from, to: c }); from = -1; }
    }
  };
  side('W', (c) => walk(l.ex, exIdx(0, c)));
  side('N', (c) => walk(l.ez, ezIdx(c, 0)));
  side('E', (c) => walk(l.ex, exIdx(N, c)));
  side('S', (c) => walk(l.ez, ezIdx(c, N)));
  return out;
}

function genChunk(w: TestWorld, cx: number, cz: number): GenOut {
  const { gen, seed, s } = w.opts;
  const key: ChunkKey = { s, cx, cz };
  const district = w.district(cx, cz);
  const palette = gen.palette(s, district);
  const lighting = gen.lighting(s, district);
  const l = createEmptyLayout(key, gen.id, district.id, Mood.NORMAL);
  l.floorCm.fill(0);
  l.ceilCm.fill(palette.ceilCm);
  l.floorMat.fill(palette.floorMat);
  l.ceilMat.fill(palette.ceilMat);
  l.ceilKind.fill(palette.ceilKind);
  l.cellZone.fill(gen.id);
  l.wallMat.fill(palette.wallMat);
  l.trimMat.fill(palette.trimMat);
  const fields = createFieldSampler(seed, s);
  for (let lj = 0; lj < N; lj++) for (let li = 0; li < N; li++) {
    const x = (cx * N + li + 0.5) * CELL, z = (cz * N + lj + 0.5) * CELL, c = cellIdx(li, lj);
    l.power[c] = Math.floor(fields.power(x, z) * 256);
    l.decay[c] = Math.floor(fields.decay(x, z) * 256);
    l.humidity[c] = Math.floor(fields.humidity(x, z) * 256);
    l.warmth[c] = Math.floor(fields.warmth(x, z) * 256);
  }
  const grid = createChunkGrid(l);
  const seams = { W: seamSpec(w, 'x', cx, cz), E: seamSpec(w, 'x', cx + 1, cz), N: seamSpec(w, 'z', cx, cz), S: seamSpec(w, 'z', cx, cz + 1) };
  grid.setSeam('W', seams.W); grid.setSeam('E', seams.E); grid.setSeam('N', seams.N); grid.setSeam('S', seams.S);
  grid.freezeSeams();
  if (w.opts.arteries?.length) stampArteries(l, grid, w.opts.arteries);
  const before = structuredClone(l);
  const ctx: ZoneGenContext = {
    key, seed, opts: { seed, seedText: String(seed), forceZone: gen.id, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
    rng: rngFor(seed, SALT.ZONE_LAYOUT, s, cx, cz), district, grid, seams,
    neighbors: { W: w.district(cx - 1, cz).zone, N: w.district(cx, cz - 1).zone, E: w.district(cx + 1, cz).zone, S: w.district(cx, cz + 1).zone },
    fields, palette, lighting, world: w.query,
  };
  gen.generate(ctx);
  const early = checkUntouched(l, before);
  const share = largestShare(l);
  const repair = repairConnectivity(grid, [], 'open');
  labelRooms(l);
  l.ports = ports(l);
  return { l, before, ctx, share, repair, early };
}

// ---------------------------------------------------------------- layout analysis helpers

const NOT_WALK = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.TOWER | CellFlag.ELEVATOR;
function walkable(l: ChunkLayout, c: number): boolean {
  if ((l.flags[c] & NOT_WALK) !== 0 || l.blockCm[c] !== 0) return false;
  const w = l.waterCm[c];
  return w === NO_WATER || w - l.floorCm[c] <= 110;
}
function walkFraction(l: ChunkLayout): number {
  let n = 0;
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (walkable(l, c)) n++;
  return n / CHUNK_CELL_COUNT;
}
/** Ramp link rule (as WP1): the edge crosses the ramp along its ascent axis, overlaps it by >= 0.3 m, and each side
 * is on the ramp or within a step of the ramp height at the edge. */
function rampLinks(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean {
  const along = axis === 'x' ? i * CELL : j * CELL;
  const w0 = (axis === 'x' ? j : i) * CELL, w1 = w0 + CELL;
  const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
  for (const s of l.solids) {
    if (s.kind !== 'ramp') continue;
    const xAxis = s.dir === 0 || s.dir === 1;
    if (xAxis !== (axis === 'x')) continue;
    const a0 = xAxis ? s.x0 : s.z0, a1 = xAxis ? s.x1 : s.z1, b0 = xAxis ? s.z0 : s.x0, b1 = xAxis ? s.z1 : s.x1;
    if (along < a0 - 0.01 || along > a1 + 0.01 || Math.min(w1, b1) - Math.max(w0, b0) < 0.3) continue;
    const t = (along - a0) / (a1 - a0);
    const f = s.dir === 0 || s.dir === 2 ? t : 1 - t;
    const h = (s.y0 + (s.y1 - s.y0) * f) * 100;
    const on = (c: number): boolean => {
      const px = ((c & 31) + 0.5) * CELL, pz = ((c >> 5) + 0.5) * CELL;
      const pa = xAxis ? px : pz, pb = xAxis ? pz : px;
      return pa > a0 && pa < a1 && pb > b0 && pb < b1;
    };
    if ((on(ca) || Math.abs(l.floorCm[ca] - h) <= 36) && (on(cb) || Math.abs(l.floorCm[cb] - h) <= 36)) return true;
  }
  return false;
}
function passable(l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): boolean {
  const e = axis === 'x' ? l.ex : l.ez, k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
  const kind = e.kind[k];
  if (!EDGE_WALKABLE[kind] || (kind === EdgeKind.HEADER && e.hA[k] < 190)) return false;
  const ca = axis === 'x' ? cellIdx(i - 1, j) : cellIdx(i, j - 1), cb = cellIdx(i, j);
  return Math.abs(l.floorCm[ca] - l.floorCm[cb]) <= 36 || rampLinks(l, axis, i, j);
}
/** Connected components of walkable cells; returns labels (-1 = not walkable) and the component sizes. */
function components(l: ChunkLayout): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(CHUNK_CELL_COUNT).fill(-1);
  const sizes: number[] = [];
  for (let c0 = 0; c0 < CHUNK_CELL_COUNT; c0++) {
    if (label[c0] >= 0 || !walkable(l, c0)) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [c0];
    label[c0] = id;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const li = c & 31, lj = c >> 5;
      const nb: [number, 'x' | 'z', number, number][] = [];
      if (li > 0) nb.push([c - 1, 'x', li, lj]);
      if (li < N - 1) nb.push([c + 1, 'x', li + 1, lj]);
      if (lj > 0) nb.push([c - N, 'z', li, lj]);
      if (lj < N - 1) nb.push([c + N, 'z', li, lj + 1]);
      for (const [n2, ax, i, j] of nb) {
        if (label[n2] >= 0 || !walkable(l, n2) || !passable(l, ax, i, j)) continue;
        label[n2] = id;
        stack.push(n2);
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}
const largestShare = (l: ChunkLayout): number => {
  const { sizes } = components(l);
  const tot = sizes.reduce((a, b) => a + b, 0);
  return tot ? Math.max(...sizes) / tot : 1;
};

/** Reserved cells and frozen seam edges must be exactly as before generate(). */
function checkUntouched(l: ChunkLayout, before: ChunkLayout): string[] {
  const bad: string[] = [];
  const tag = `${l.key.cx},${l.key.cz}`;
  // reserved cells untouched
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (!(before.flags[c] & CellFlag.RESERVED)) continue;
    if (l.flags[c] !== before.flags[c] || l.floorCm[c] !== before.floorCm[c] || l.ceilCm[c] !== before.ceilCm[c] || l.waterCm[c] !== before.waterCm[c]) {
      bad.push(`${tag}: reserved cell ${c} modified`);
      break;
    }
  }
  // frozen seams untouched
  for (let k = 0; k < N; k++) {
    for (const [e0, e1] of [[l.ex, before.ex], [l.ez, before.ez]] as const) {
      for (const idx of e0 === l.ex ? [exIdx(0, k), exIdx(N, k)] : [ezIdx(k, 0), ezIdx(k, N)]) {
        if (e0.kind[idx] !== e1.kind[idx] || e0.hA[idx] !== e1.hA[idx]) { bad.push(`${tag}: seam edge changed`); break; }
      }
    }
  }
  return bad;
}

/** Common structural invariants every deep layout must satisfy. Returns a list of problems. */
function checkInvariants(o: GenOut): string[] {
  const { l, before } = o;
  const bad: string[] = [];
  const tag = `${l.key.cx},${l.key.cz}`;
  bad.push(...o.early);
  // heights sane
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (l.flags[c] & CellFlag.SOLID) continue;
    if (l.ceilCm[c] - l.floorCm[c] < 200) bad.push(`${tag}: cell ${c} headroom ${l.ceilCm[c] - l.floorCm[c]}`);
    if (l.waterCm[c] !== NO_WATER && l.waterCm[c] <= l.floorCm[c]) bad.push(`${tag}: cell ${c} water below floor`);
  }
  // water rects match the per-cell water
  const cover = new Int16Array(CHUNK_CELL_COUNT);
  for (const w of l.water) {
    const i0 = Math.round(w.x0 / CELL), i1 = Math.round(w.x1 / CELL), j0 = Math.round(w.z0 / CELL), j1 = Math.round(w.z1 / CELL);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const c = cellIdx(i, j);
      cover[c]++;
      if (Math.round(w.y * 100) !== l.waterCm[c] || Math.round(w.floorY * 100) !== l.floorCm[c]) bad.push(`${tag}: water rect mismatch at ${c}`);
    }
  }
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if (before.flags[c] & CellFlag.RESERVED) continue;
    const want = l.waterCm[c] !== NO_WATER ? 1 : 0;
    if (cover[c] !== want) { bad.push(`${tag}: water cover ${cover[c]} != ${want} at ${c}`); break; }
  }
  // fixtures: unique ids, inside the chunk, inside their cell's air space, not in SOLID cells
  const ids = new Set<number>();
  for (const f of l.fixtures) {
    if (ids.has(f.id)) bad.push(`${tag}: duplicate fixture id`);
    ids.add(f.id);
    const vals = [f.px, f.py, f.pz, f.nx, f.ny, f.nz, f.luminance, ...f.color];
    if (vals.some((v) => !Number.isFinite(v))) bad.push(`${tag}: NaN fixture`);
    if (f.px < 0 || f.pz < 0 || f.px >= CHUNK_SIZE || f.pz >= CHUNK_SIZE) { bad.push(`${tag}: fixture outside chunk`); continue; }
    const c = cellIdx(Math.floor(f.px / CELL), Math.floor(f.pz / CELL));
    if (l.flags[c] & CellFlag.SOLID) bad.push(`${tag}: fixture in SOLID cell`);
    if (f.py > l.ceilCm[c] / 100 + 1e-6 || f.py < l.floorCm[c] / 100 - 1e-6) bad.push(`${tag}: fixture ${f.kind} y ${f.py} outside [${l.floorCm[c]}, ${l.ceilCm[c]}]`);
    if (Math.max(...f.color) > 1 + 1e-6) bad.push(`${tag}: fixture colour > 1`);
  }
  // props: finite, inside the chunk, not in SOLID cells
  for (const p of l.props) {
    if (![p.x, p.y, p.z, p.yaw, p.scale].every(Number.isFinite)) { bad.push(`${tag}: NaN prop`); continue; }
    if (p.x < 0 || p.z < 0 || p.x >= CHUNK_SIZE || p.z >= CHUNK_SIZE) { bad.push(`${tag}: prop ${PROP_DEFS[p.kind].name} outside chunk`); continue; }
    const c = cellIdx(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
    if (l.flags[c] & CellFlag.SOLID) bad.push(`${tag}: prop ${PROP_DEFS[p.kind].name} in SOLID cell`);
  }
  // solids: finite and at least partly inside the chunk
  for (const s of l.solids) {
    const v = s.kind === 'box' ? [...s.min, ...s.max] : s.kind === 'ramp' ? [s.x0, s.x1, s.z0, s.z1, s.y0, s.y1] : [...s.a, ...s.b, s.r];
    if (!v.every(Number.isFinite)) { bad.push(`${tag}: NaN solid`); continue; }
    const [x0, z0, x1, z1] = s.kind === 'box' ? [s.min[0], s.min[2], s.max[0], s.max[2]]
      : s.kind === 'ramp' ? [s.x0, s.z0, s.x1, s.z1]
        : [Math.min(s.a[0], s.b[0]), Math.min(s.a[2], s.b[2]), Math.max(s.a[0], s.b[0]), Math.max(s.a[2], s.b[2])];
    if (x1 < 0 || z1 < 0 || x0 > CHUNK_SIZE || z0 > CHUNK_SIZE) bad.push(`${tag}: solid outside chunk`);
    if (s.kind === 'box' && (s.max[0] <= s.min[0] || s.max[1] <= s.min[1] || s.max[2] <= s.min[2])) bad.push(`${tag}: degenerate box`);
    // a zero-length pipe is a degenerate elbow partner for WP6 (NaN geometry in the tile's prop mesh)
    if (s.kind === 'pipe' && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]) < 0.01) bad.push(`${tag}: degenerate pipe`);
  }
  // decals finite
  for (const d of l.decals) if (![d.px, d.py, d.pz, d.rot, d.w, d.h].every(Number.isFinite)) bad.push(`${tag}: NaN decal`);
  // WP1 validation (when implemented)
  for (const e of validateLayout(l)) bad.push(`${tag}: validate: ${e}`);
  return bad;
}

// ---------------------------------------------------------------- ASCII dump (evidence)

function ascii(l: ChunkLayout): string {
  const rows: string[] = [];
  const glyph = (c: number): string => {
    const f = l.flags[c];
    if (f & CellFlag.RESERVED) return 'R';
    if (f & CellFlag.SOLID) return '#';
    if (l.waterCm[c] !== NO_WATER) return (f & CellFlag.NOWALK) ? '≈' : '~';
    if (l.floorCm[c] > 0) return '^';
    if (l.floorCm[c] < 0) return 'v';
    if (l.floorMat[c] === Mat.METAL_GRATE) return '=';
    return '.';
  };
  const ek = (k: number, vertical: boolean): string => {
    switch (k) {
      case EdgeKind.OPEN: return ' ';
      case EdgeKind.WALL: return vertical ? '|' : '-';
      case EdgeKind.ARCH: return 'a';
      case EdgeKind.DOORWAY: return 'd';
      case EdgeKind.HEADER: return 'h';
      case EdgeKind.HALF: return '=';
      default: return '?';
    }
  };
  const fixCell = new Map<number, string>();
  const at = (x: number, z: number): number => cellIdx(Math.max(0, Math.min(N - 1, Math.floor(x / CELL))), Math.max(0, Math.min(N - 1, Math.floor(z / CELL))));
  for (const p of l.props) {
    const ch = p.kind === PropKind.SHELF_RACK ? 'r' : p.kind === PropKind.CAR_SEDAN ? 'c' : p.kind === PropKind.FLOAT_ROPE ? 'f' : 'p';
    if (p.kind === PropKind.SHELF_RACK) { fixCell.set(at(p.x - 0.6, p.z), ch); fixCell.set(at(p.x + 0.6, p.z), ch); }
    else if (!fixCell.has(at(p.x, p.z)) || ch !== 'p') fixCell.set(at(p.x, p.z), ch);
  }
  for (const s of l.solids) {
    if (s.kind === 'box' && s.min[1] < 0.5 && s.max[0] - s.min[0] < 1 && s.max[2] - s.min[2] < 1) fixCell.set(at((s.min[0] + s.max[0]) / 2, (s.min[2] + s.max[2]) / 2), 'o');
    if (s.kind === 'ramp') for (let z = s.z0 + 0.6; z < s.z1; z += CELL) for (let x = s.x0 + 0.6; x < s.x1; x += CELL) fixCell.set(at(x, z), '/');
  }
  for (const f of l.fixtures) fixCell.set(at(f.px, f.pz), 'L');
  for (let j = 0; j <= N; j++) {
    let top = '';
    for (let i = 0; i < N; i++) top += '+' + ek(l.ez.kind[ezIdx(i, j)], false);
    rows.push(top + '+');
    if (j === N) break;
    let mid = '';
    for (let i = 0; i < N; i++) {
      const c = cellIdx(i, j);
      mid += ek(l.ex.kind[exIdx(i, j)], true) + (fixCell.get(c) && !(l.flags[c] & CellFlag.SOLID) ? fixCell.get(c) : glyph(c));
    }
    rows.push(mid + ek(l.ex.kind[exIdx(N, j)], true));
  }
  return rows.join('\n');
}
function dump(name: string, l: ChunkLayout): void {
  if (!process.env.DUMP_DEEP) return;
  mkdirSync('/tmp/wp3-maps', { recursive: true });
  const stats = `zone ${name} chunk ${l.key.s}:${l.key.cx}:${l.key.cz} fixtures ${l.fixtures.length} solids ${l.solids.length} props ${l.props.length} decals ${l.decals.length} water ${l.water.length} emitters ${l.emitters.length} walk ${(walkFraction(l) * 100).toFixed(1)}%`;
  writeFileSync(`/tmp/wp3-maps/${name}_${l.key.cx}_${l.key.cz}.txt`, `${stats}\n${ascii(l)}\n`);
}

// ---------------------------------------------------------------- tests

const zoneNames = Object.keys(GENS);
const SEEDS = 200;
/** Minimum walkable share of a zone's own cells. R2 (B4): the POOLROOMS TUNNELS variant is solid tile except a 2-cell
 * cross of tube corridors per 8x8 room (by design ~44% walkable), so it gets its own floor. */
const TUNNEL_MIN_WALK = 0.4;
function minWalkFor(name: string, d: DistrictInfo): number {
  if (name === 'PIPEWORKS' || name === 'CONCRETE') return 0.45;
  if (name === 'POOLROOMS' && d.params.variant === PoolVariant.TUNNELS) return TUNNEL_MIN_WALK;
  return 0.7;
}

describe('WP3 deep zones: generic acceptance', () => {
  // an invariant sweep (per-seed checks, minima): all 200 seeds under `npm test`, the first 25 in the quick tiers
  const INVARIANT_SEEDS = sweepSize(SEEDS, 25);
  for (const name of zoneNames) {
    it(`${name}: invariants, validateLayout and walkable fraction over ${SEEDS} seeds`, () => {
      const gen = GENS[name];
      const problems: string[] = [];
      let minFrac = 1, sumFrac = 0, minShare = 1, sumCarved = 0, minMargin = Infinity;
      for (let k = 0; k < INVARIANT_SEEDS; k++) {
        const r = new Rng(9000 + k);
        const w = makeWorld({ seed: r.next(), s: STOREY[name], gen });
        const cx = r.int(-40, 40), cz = r.int(-40, 40);
        const out = genChunk(w, cx, cz);
        problems.push(...checkInvariants(out));
        const f = walkFraction(out.l);
        minMargin = Math.min(minMargin, f - minWalkFor(name, w.district(cx, cz)));
        minFrac = Math.min(minFrac, f);
        sumFrac += f;
        minShare = Math.min(minShare, out.share);
        sumCarved += out.repair.carved;
        if (k < 3) dump(name, out.l);
        if (k < 3 && process.env.DUMP_DEEP) console.log(name, out.l.decals.slice(0, 6).map((d) => [d.kind, d.px.toFixed(2), d.pz.toFixed(2), d.w, d.h.toFixed(2)].join(" ")));
      }
      expect(problems.slice(0, 10)).toEqual([]);
      expect(minMargin).toBeGreaterThanOrEqual(0);
      // generators produce (nearly) connected layouts themselves; WP1's repair only fixes stragglers
      expect(minShare).toBeGreaterThanOrEqual(name === 'PIPEWORKS' || name === 'CONCRETE' ? 0.85 : 0.9);
      console.log(`${name}: walkable mean ${(sumFrac / INVARIANT_SEEDS * 100).toFixed(1)}% min ${(minFrac * 100).toFixed(1)}%, main-component share min ${(minShare * 100).toFixed(1)}%, repair carved ${(sumCarved / INVARIANT_SEEDS).toFixed(2)}/chunk (${INVARIANT_SEEDS} seeds)`);
    });

    it(`${name}: deterministic`, () => {
      const w = makeWorld({ seed: 77, s: STOREY[name], gen: GENS[name] });
      const a = genChunk(w, 3, -2).l, b = genChunk(makeWorld({ seed: 77, s: STOREY[name], gen: GENS[name] }), 3, -2).l;
      expect(layoutHash(a)).toBe(layoutHash(b));
      expect(JSON.stringify([a.fixtures, a.solids, a.props, a.decals, a.water, a.emitters]))
        .toBe(JSON.stringify([b.fixtures, b.solids, b.props, b.decals, b.water, b.emitters]));
    });

    it(`${name}: respects reserved artery cells and district boundaries`, () => {
      const problems: string[] = [];
      for (let k = 0; k < 30; k++) {
        const r = new Rng(500 + k);
        const cx = r.int(-5, 5), cz = r.int(-5, 5);
        const arteries: ArterySpan[] = [
          { axis: 'x', row: cz * N + r.int(3, 27), g0: (cx - 3) * N, g1: (cx + 3) * N, seed: 1 },
          { axis: 'z', row: cx * N + r.int(3, 27), g0: (cz - 3) * N, g1: (cz + 3) * N, seed: 2 },
        ];
        const w = makeWorld({ seed: r.next(), s: STOREY[name], gen: GENS[name], arteries, districtOf: (x, z) => (x === cx + 1 ? 7 : 4242) });
        problems.push(...checkInvariants(genChunk(w, cx, cz)));
      }
      expect(problems.slice(0, 10)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------- full pipeline (WP1 generateChunk, forceZone)

describe('WP3 deep zones through the full chunk pipeline', () => {
  const ZONES: [string, ZoneId][] = [
    ['POOLROOMS', Zone.POOLROOMS], ['PARKING', Zone.PARKING], ['PIPEWORKS', Zone.PIPEWORKS],
    ['WAREHOUSE', Zone.WAREHOUSE], ['CONCRETE', Zone.CONCRETE],
  ];
  it(`validateLayout = [] and walkable fraction for ${SEEDS} seeds x each deep zone`, { tags: ['sweep'] }, () => {
    const report: string[] = [];
    for (const [name, zone] of ZONES) {
      let minFrac = 1, sum = 0, minMargin = Infinity;
      const bad: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const wg = createWorldGen({ seed, seedText: String(seed), forceZone: zone, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
        const key: ChunkKey = { s: (seed % 3) as StoreyId, cx: (seed % 13) - 6, cz: ((seed * 7) % 13) - 6 };
        const l = wg.generateChunk(key); // throws under vitest when validateLayout fails
        for (const e of validateLayout(l, wg)) bad.push(`${name} seed ${seed}: ${e}`);
        // walkable share of the cells the zone owns (stamps such as towers / landmarks excluded)
        let own = 0, walk = 0;
        for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
          if (l.flags[c] & (CellFlag.RESERVED | CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.LANDMARK)) continue;
          own++;
          if (wp1Walkable(l, c)) walk++;
        }
        const f = own ? walk / own : 1;
        minFrac = Math.min(minFrac, f);
        minMargin = Math.min(minMargin, f - minWalkFor(name, wg.districtAt(key.s, key.cx, key.cz)));
        sum += f;
      }
      expect(bad.slice(0, 8)).toEqual([]);
      expect(minMargin, name).toBeGreaterThanOrEqual(0);
      report.push(`${name} ${(sum / SEEDS * 100).toFixed(1)}% (min ${(minFrac * 100).toFixed(1)}%)`);
    }
    console.log(`[zones-deep] pipeline walkable fraction: ${report.join(', ')}`);
  });
});

// ---------------------------------------------------------------- POOLROOMS

/** Connected groups of pool cells (water with a sunken floor: pools and channels). */
function poolGroups(l: ChunkLayout): number[][] {
  const seen = new Uint8Array(CHUNK_CELL_COUNT);
  const isPool = (c: number): boolean => l.waterCm[c] !== NO_WATER && l.floorCm[c] < 0 && !(l.flags[c] & CellFlag.RESERVED);
  const out: number[][] = [];
  for (let c0 = 0; c0 < CHUNK_CELL_COUNT; c0++) {
    if (seen[c0] || !isPool(c0)) continue;
    const grp: number[] = [];
    const st = [c0];
    seen[c0] = 1;
    while (st.length) {
      const c = st.pop()!;
      grp.push(c);
      const li = c & 31, lj = c >> 5;
      for (const [ni, nj] of [[li - 1, lj], [li + 1, lj], [li, lj - 1], [li, lj + 1]]) {
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const n = cellIdx(ni, nj);
        if (!seen[n] && isPool(n)) { seen[n] = 1; st.push(n); }
      }
    }
    out.push(grp);
  }
  return out;
}

describe('WP3 POOLROOMS', () => {
  const gen = poolroomsGenerator;
  it('every pool is reachable via its stepped entry; deep water is NOWALK behind float ropes', () => {
    let pools = 0, ropes = 0, deepCells = 0, ladders = 0, underwater = 0, flooded = 0, terraces = 0, channels = 0;
    for (let k = 0; k < 120; k++) {
      const r = new Rng(31000 + k);
      const w = makeWorld({ seed: r.next(), s: 2, gen });
      const { l } = genChunk(w, r.int(-30, 30), r.int(-30, 30));
      const parent = walkComponents(l);
      // main component: the one holding the first walkable port cell
      let main = -1;
      for (const c of portCells(l)) if (parent[c] >= 0) { main = find(parent, c); break; }
      expect(main).toBeGreaterThanOrEqual(0);
      for (const grp of poolGroups(l)) {
        const inGrp = new Set(grp);
        const deepest = Math.min(...grp.map((c) => l.floorCm[c]));
        if (deepest > -36) { channels++; continue; } // a lone channel stub (the pool it joins is in the next chunk)
        pools++;
        // a stepped ramp (0.3 m treads) whose footprint lies in the pool, descending from the deck
        const ramp = l.solids.find((s) => s.kind === 'ramp' && s.y1 === 0 && s.y0 < 0 && s.steps >= 3
          && inGrp.has(cellIdx(Math.floor((s.x0 + s.x1) / 2 / CELL), Math.floor((s.z0 + s.z1) / 2 / CELL))));
        expect(ramp, `pool without stepped entry in ${l.key.cx},${l.key.cz}`).toBeDefined();
        if (ramp && ramp.kind === 'ramp') {
          const len = ramp.dir < 2 ? ramp.x1 - ramp.x0 : ramp.z1 - ramp.z0;
          expect(len / ramp.steps).toBeGreaterThan(0.2);
          expect(len / ramp.steps).toBeLessThan(0.45);
        }
        // the pool's wadeable water is part of the main walkable component (reachable from the deck)
        const wade = grp.filter((c) => wp1Walkable(l, c));
        expect(wade.length).toBeGreaterThan(0);
        expect(wade.some((c) => find(parent, c) === main), `pool unreachable in ${l.key.cx},${l.key.cz}`).toBe(true);
        if (l.props.some((p) => p.kind === PropKind.POOL_LADDER && inGrp.has(cellIdx(Math.floor(p.x / CELL), Math.floor(p.z / CELL))))) ladders++;
      }
      // deep water NOWALK
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
        if (l.waterCm[c] === NO_WATER) continue;
        const depth = l.waterCm[c] - l.floorCm[c];
        if (depth > 110) { deepCells++; if (!(l.flags[c] & CellFlag.NOWALK)) expect(l.flags[c] & CellFlag.NOWALK).toBeTruthy(); }
        else if (l.flags[c] & CellFlag.NOWALK) expect(l.flags[c] & CellFlag.NOWALK).toBeFalsy();
      }
      // every wadeable | NOWALK water edge carries a FLOAT_ROPE at its midpoint
      const ropeAt = new Set(l.props.filter((p) => p.kind === PropKind.FLOAT_ROPE).map((p) => `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`));
      const wet = (c: number): boolean => l.waterCm[c] !== NO_WATER;
      const nowalk = (c: number): boolean => (l.flags[c] & CellFlag.NOWALK) !== 0;
      for (let lj = 0; lj < N; lj++) for (let li = 0; li < N; li++) {
        const c = cellIdx(li, lj);
        for (const [ni, nj, x, z] of [[li + 1, lj, (li + 1) * CELL, (lj + 0.5) * CELL], [li, lj + 1, (li + 0.5) * CELL, (lj + 1) * CELL]]) {
          if (ni >= N || nj >= N) continue;
          const n = cellIdx(ni, nj);
          if (!wet(c) || !wet(n) || nowalk(c) === nowalk(n)) continue;
          ropes++;
          const rope = ropeAt.has(`${Math.round(x * 100)},${Math.round(z * 100)}`);
          if (!Object.is(rope, true)) expect(rope, `missing float rope at ${x},${z}`).toBe(true);
        }
      }
      for (const f of l.fixtures) if (f.kind === FixtureKind.UNDERWATER) {
        underwater++;
        const c = cellIdx(Math.floor(f.px / CELL), Math.floor(f.pz / CELL));
        // R2 (B4) DRAINED variant: the basin lights keep burning on dry tile (no water above them)
        if (l.waterCm[c] !== NO_WATER) expect(f.py * 100).toBeLessThan(l.waterCm[c]); // submerged
        expect(f.py * 100).toBeGreaterThan(l.floorCm[c]);
      }
      for (const wr of l.water) if (wr.kind === 1) flooded++;
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (l.floorCm[c] === 45) { terraces++; break; }
    }
    console.log(`[zones-deep] POOLROOMS 120 chunks: pools ${pools} (ladders ${ladders}), channel stubs ${channels}, deep cells ${deepCells}, rope edges ${ropes}, underwater lights ${underwater}, flooded rects ${flooded}, chunks with terraces ${terraces}`);
    expect(pools).toBeGreaterThan(120); // ~0.6 per room group
    expect(ropes).toBeGreaterThan(50);
    expect(ladders).toBeGreaterThan(pools * 0.5);
    expect(underwater).toBeGreaterThan(0);
    expect(flooded).toBeGreaterThan(0);
    expect(terraces).toBeGreaterThan(10);
  });

  it('palette, lighting and room lattice match the spec', () => {
    const w = makeWorld({ seed: 5, s: 2, gen, params: { vaulted: 0, phaseX: 0, phaseZ: 0, variant: PoolVariant.CLASSIC } });
    const d = w.district(0, 0);
    const pal = gen.palette(2, d), li = gen.lighting(2, d);
    expect([pal.floorMat, pal.wallMat, pal.ceilKind]).toEqual([Mat.POOL_TILE, Mat.POOL_TILE, CeilKind.TILE_GLAZED]);
    expect([li.kind, li.placement, li.lattice, li.luminance, li.cctRange]).toEqual([FixtureKind.SKY_PANEL, 'lattice', [6, 6], 2500, [6000, 6800]]);
    // R2 (B4) variants: SUNLIT is a dense bright daylight lattice under a vault; TUNNELS a dense dim lattice in 250 cm tubes
    const variant = (v: number): DistrictInfo => makeWorld({ seed: 5, s: 2, gen, params: { vaulted: 0, phaseX: 0, phaseZ: 0, variant: v } }).district(0, 0);
    const sun = gen.lighting(2, variant(PoolVariant.SUNLIT)), tun = gen.lighting(2, variant(PoolVariant.TUNNELS));
    expect([sun.lattice, sun.luminance, sun.cctRange, gen.palette(2, variant(PoolVariant.SUNLIT)).ceilCm]).toEqual([[4, 4], 5200, [6500, 7000], 720]);
    expect([tun.lattice, tun.luminance, gen.palette(2, variant(PoolVariant.TUNNELS)).ceilCm]).toEqual([[4, 4], 1800, 250]);
    // per-room ceilings 360..600 (720 when vaulted); arches only on the 8-cell lattice lines
    const ceilings = new Set<number>();
    for (let k = 0; k < 40; k++) {
      const { l } = genChunk(makeWorld({ seed: 900 + k, s: 2, gen, params: { vaulted: 0, phaseX: 0, phaseZ: 0 } }), k, -k);
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!(l.flags[c] & CellFlag.RESERVED)) ceilings.add(l.ceilCm[c]);
      for (let j = 0; j < N; j++) for (let i = 0; i <= N; i++) {
        if (l.ex.kind[exIdx(i, j)] === EdgeKind.ARCH) expect(i % 8).toBe(0);
      }
    }
    for (const c of ceilings) { expect(c).toBeGreaterThanOrEqual(360); expect(c).toBeLessThanOrEqual(600); }
    expect(ceilings.size).toBeGreaterThan(4);
    const v = genChunk(makeWorld({ seed: 3, s: 2, gen, params: { vaulted: 1, phaseX: 0, phaseZ: 0 } }), 0, 0).l;
    expect(v.ceilCm[cellIdx(4, 4)]).toBe(720);
  });

  it('room data is a pure function of the lattice room (merged rooms share the lowest id)', () => {
    for (let k = 0; k < 200; k++) {
      const r = new Rng(777 + k);
      const seed = r.next(), rx = r.int(-100, 100), rz = r.int(-100, 100);
      const a = poolroomsRoomInfo(seed, 2, false, rx, rz);
      const b = poolroomsRoomInfo(seed, 2, false, rx, rz);
      expect(a).toEqual(b);
      // a merged neighbour inside the same group reports the same anchor and features
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const n = poolroomsRoomInfo(seed, 2, false, rx + dx, rz + dz);
        if (n.anchor === a.anchor) expect(n).toEqual(a);
      }
      if (a.pool) {
        expect(a.pool.shallowF).toBeLessThanOrEqual(-40);
        expect(a.pool.deepF).toBeGreaterThanOrEqual(-180);
      }
    }
  });
});

// ---------------------------------------------------------------- PARKING

describe('WP3 PARKING', () => {
  const gen = parkingGenerator;
  it('columns on the 6x5 lattice, 40 cm beams on every column row, stalls with stripes / wheel stops, cars ~5%, ramps ~1/6', () => {
    let stalls = 0, cars = 0, ramps = 0, chunks = 0, sodium = 0, tubes = 0;
    for (let k = 0; k < 150; k++) {
      const r = new Rng(41000 + k);
      const w = makeWorld({ seed: r.next(), s: 1, gen });
      const d = w.district(0, 0);
      const { l, ctx } = genChunk(w, r.int(-40, 40), r.int(-40, 40));
      chunks++;
      const ceilY = ctx.palette.ceilCm / 100;
      expect(ctx.palette.ceilCm).toBe(260);
      for (const s of l.solids) {
        if (s.kind === 'ramp') {
          ramps++;
          expect(s.y1 - s.y0).toBeCloseTo(1.5, 6);
          expect([Math.round((s.x1 - s.x0) / CELL), Math.round((s.z1 - s.z0) / CELL)]).toEqual([4, 8]);
          expect(s.flags & SolidFlag.WALKABLE_TOP).toBeTruthy();
          continue;
        }
        if (s.kind !== 'box') continue;
        const dx = s.max[0] - s.min[0], dz = s.max[2] - s.min[2];
        if (s.min[1] === 0) {
          // column: 0.6 m square (clipped at nothing: straddlers are added whole), on a lattice vertex
          expect(dx).toBeCloseTo(0.6, 6); expect(dz).toBeCloseTo(0.6, 6);
          const vx = Math.round((s.min[0] + 0.3) / CELL) + l.key.cx * N, vz = Math.round((s.min[2] + 0.3) / CELL) + l.key.cz * N;
          expect(((vx - (d.params.phaseX ?? 0)) % 6 + 6) % 6).toBe(0);
          expect(((vz - (d.params.phaseZ ?? 0)) % 5 + 5) % 5).toBe(0);
          expect(s.max[1]).toBeCloseTo(ceilY, 6);
        } else {
          // beam: 40 cm downstand along x on a column row
          expect(s.min[1]).toBeCloseTo(ceilY - 0.4, 6); expect(s.max[1]).toBeCloseTo(ceilY, 6);
          expect(dz).toBeCloseTo(0.4, 6);
          const vz = Math.round((s.min[2] + 0.2) / CELL) + l.key.cz * N;
          expect(((vz - (d.params.phaseZ ?? 0)) % 5 + 5) % 5).toBe(0);
        }
      }
      stalls += l.props.filter((p) => p.kind === PropKind.WHEEL_STOP).length;
      cars += l.props.filter((p) => p.kind === PropKind.CAR_SEDAN).length;
      for (const dc of l.decals) {
        if (dc.kind !== DECAL_PAINT_STRIPE) continue;
        expect(dc.ny).toBe(1);
        expect(Math.min(dc.w, dc.h)).toBeLessThanOrEqual(0.12);
      }
      const stripes5 = l.decals.filter((dc) => dc.kind === DECAL_PAINT_STRIPE && Math.abs(dc.h - 5) < 1e-6 && dc.w === 0.1).length;
      if (l.props.some((p) => p.kind === PropKind.WHEEL_STOP)) expect(stripes5).toBeGreaterThan(0);
      for (const f of l.fixtures) {
        if (f.kind === FixtureKind.SODIUM) sodium++;
        else if (f.kind === FixtureKind.TUBE_STRIP) tubes++;
      }
      expect(l.decals.some((dc) => dc.kind === DecalKind.PARKING_NUMBER) || l.solids.length < 4).toBe(true);
    }
    console.log(`[zones-deep] PARKING ${chunks} chunks: wheel stops ${stalls}, cars ${cars} (${(cars / stalls * 100).toFixed(1)}%), ramps ${ramps}, tubes ${tubes}, sodium ${sodium}`);
    expect(cars / stalls).toBeGreaterThan(0.02);
    expect(cars / stalls).toBeLessThan(0.09);
    expect(ramps / chunks).toBeGreaterThan(0.07);
    expect(ramps / chunks).toBeLessThan(0.3);
    expect(sodium / (sodium + tubes)).toBeGreaterThan(0.05);
    expect(sodium / (sodium + tubes)).toBeLessThan(0.16);
  });
});

// ---------------------------------------------------------------- PIPEWORKS

describe('WP3 PIPEWORKS', () => {
  const gen = pipeworksGenerator;
  it('seam pattern: node-row ports only, >= 2, no wall run > 12', () => {
    for (let k = 0; k < 500; k++) {
      const e = gen.seamPattern!(new Rng(k), makeWorld({ seed: k, s: 1, gen }).district(0, 0));
      let open = 0, run = 0, maxRun = 0;
      for (let c = 0; c < N; c++) {
        if (e.kind[c] === EdgeKind.OPEN) { open++; if (!Object.is(c % 2, 1)) expect(c % 2).toBe(1); run = 0; } else { run++; maxRun = Math.max(maxRun, run); }
      }
      expect(open).toBeGreaterThanOrEqual(2);
      expect(maxRun).toBeLessThanOrEqual(12);
    }
  });
  it('pipes along corridors at 1.8–2.6 m (r 0.04–0.15), grates, boiler rooms, cage bulbs every 4–6 cells', () => {
    let pipes = 0, grates = 0, boilers = 0, tanks = 0, bulbs = 0, valves = 0, chunks = 0;
    for (let k = 0; k < 120; k++) {
      const r = new Rng(51000 + k);
      const w = makeWorld({ seed: r.next(), s: 1, gen });
      const { l, ctx } = genChunk(w, r.int(-40, 40), r.int(-40, 40));
      chunks++;
      for (const s of l.solids) {
        if (s.kind !== 'pipe') continue;
        pipes++;
        if (!(s.r >= 0.04 - 1e-9)) expect(s.r).toBeGreaterThanOrEqual(0.04 - 1e-9);
        if (!(s.r <= 0.15 + 1e-9)) expect(s.r).toBeLessThanOrEqual(0.15 + 1e-9);
        if (Math.abs(s.a[1] - s.b[1]) < 1e-9) {
          // horizontal pipe (corridor runs and boiler-room plumbing)
          if (!(s.a[1] - s.r >= 1.8 - 1e-6)) expect(s.a[1] - s.r).toBeGreaterThanOrEqual(1.8 - 1e-6);
          if (!(s.a[1] + s.r <= 2.6 + 1e-6)) expect(s.a[1] + s.r).toBeLessThanOrEqual(2.6 + 1e-6);
        }
      }
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (l.floorMat[c] === Mat.METAL_GRATE) { grates++; if (l.flags[c] & CellFlag.SOLID) expect(l.flags[c] & CellFlag.SOLID).toBeFalsy(); }
      boilers += l.props.filter((p) => p.kind === PropKind.BOILER).length;
      tanks += l.props.filter((p) => p.kind === PropKind.TANK).length;
      valves += l.props.filter((p) => p.kind === PropKind.PIPE_VALVE).length;
      const bl = l.fixtures.filter((f) => f.kind === FixtureKind.CAGE_BULB);
      bulbs += bl.length;
      for (const f of bl) if (!(f.luminance > 55)) expect(f.luminance).toBeGreaterThan(55);
      expect(ctx.lighting.zoneMul).toBe(0.7);
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!(l.flags[c] & (CellFlag.SOLID | CellFlag.RESERVED))) {
        if (!(l.ceilCm[c] >= 300)) expect(l.ceilCm[c]).toBeGreaterThanOrEqual(300);
        if (!(l.ceilCm[c] <= 420)) expect(l.ceilCm[c]).toBeLessThanOrEqual(420);
      }
      expect(l.emitters.some((e) => e.kind === EmitterKind.PIPE) || pipes === 0).toBe(true);
    }
    console.log(`[zones-deep] PIPEWORKS ${chunks} chunks: pipes ${pipes}, grate cells ${grates}, boilers ${boilers}, tanks ${tanks}, valves ${valves}, bulbs ${bulbs}`);
    expect(pipes / chunks).toBeGreaterThan(20);
    expect(grates).toBeGreaterThan(chunks * 5);
    expect(boilers).toBeGreaterThan(chunks * 0.3);
    expect(tanks).toBeGreaterThan(boilers * 0.5);
    expect(bulbs / chunks).toBeGreaterThan(15);
  });
  it('every maximal straight corridor run carries 1–4 pipes along it', () => {
    let runs = 0;
    for (let k = 0; k < 60; k++) {
      const r = new Rng(52000 + k);
      const w = makeWorld({ seed: r.next(), s: 1, gen });
      const { l } = genChunk(w, r.int(-40, 40), r.int(-40, 40));
      const corr = (li: number, lj: number): boolean => {
        if (li < 0 || lj < 0 || li >= N || lj >= N) return false;
        const c = cellIdx(li, lj);
        return !(l.flags[c] & (CellFlag.SOLID | CellFlag.RESERVED)) && l.ceilCm[c] < 420;
      };
      const horiz = l.solids.filter((s): s is Extract<Solid, { kind: 'pipe' }> => s.kind === 'pipe' && Math.abs(s.a[1] - s.b[1]) < 1e-9);
      for (const axis of [0, 1] as const) {
        for (let line = 0; line < N; line++) {
          let k0 = 0;
          while (k0 < N) {
            const at = (t: number): [number, number] => (axis === 0 ? [t, line] : [line, t]);
            if (!corr(...at(k0))) { k0++; continue; }
            let k1 = k0;
            while (k1 + 1 < N && corr(...at(k1 + 1))) k1++;
            if (k1 > k0) {
              runs++;
              const lo = (line) * CELL, hi = (line + 1) * CELL, a0 = k0 * CELL, a1 = (k1 + 1) * CELL;
              // distinct pipe lines (lateral offset, height): a line may be split into pieces at tees
              const n = new Set(horiz.filter((p) => {
                const along = axis === 0 ? Math.abs(p.a[2] - p.b[2]) < 1e-9 : Math.abs(p.a[0] - p.b[0]) < 1e-9;
                if (!along) return false;
                const lat = axis === 0 ? p.a[2] : p.a[0];
                const mid = axis === 0 ? (p.a[0] + p.b[0]) / 2 : (p.a[2] + p.b[2]) / 2;
                return lat > lo && lat < hi && mid > a0 && mid < a1;
              }).map((p) => `${(axis === 0 ? p.a[2] : p.a[0]).toFixed(4)},${p.a[1].toFixed(4)}`)).size;
              if (!(n >= 1)) expect(n, `run axis ${axis} line ${line} [${k0}, ${k1}]`).toBeGreaterThanOrEqual(1);
              if (!(n <= 4)) expect(n).toBeLessThanOrEqual(4);
            }
            k0 = k1 + 1;
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(60 * 20);
  });
});

// ---------------------------------------------------------------- WAREHOUSE

describe('WP3 WAREHOUSE', () => {
  const gen = warehouseGenerator;
  it('every TRUSS cell is under a joist within 2.4 m; HIGHBAYs hang within 1.2 m of a joist at 7.0 m', () => {
    let highbays = 0, mezz = 0, racks = 0, stock = 0;
    for (let k = 0; k < 100; k++) {
      const r = new Rng(61000 + k);
      const w = makeWorld({ seed: r.next(), s: 1, gen });
      const { l, ctx } = genChunk(w, r.int(-40, 40), r.int(-40, 40));
      expect(ctx.palette.ceilCm).toBe(800);
      const joists = l.solids.filter((s): s is Extract<Solid, { kind: 'box' }> => s.kind === 'box'
        && Math.abs(s.min[1] - warehouseRoof.TRUSS_Y0) < 1e-9 && Math.abs(s.max[1] - warehouseRoof.TRUSS_Y1) < 1e-9 && s.max[2] - s.min[2] < 0.11);
      const girders = l.solids.filter((s) => s.kind === 'box' && Math.abs(s.min[1] - warehouseRoof.TRUSS_Y0) < 1e-9 && s.max[0] - s.min[0] > 0.29 && s.max[0] - s.min[0] < 0.31);
      expect(girders.length).toBeGreaterThan(0);
      const distToJoist = (x: number, z: number): number => {
        let best = Infinity;
        for (const j of joists) {
          const dx = Math.max(j.min[0] - x, 0, x - j.max[0]), dz = Math.max(j.min[2] - z, 0, z - j.max[2]);
          best = Math.min(best, Math.hypot(dx, dz));
        }
        return best;
      };
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
        if (l.ceilKind[c] !== CeilKind.TRUSS || (l.flags[c] & CellFlag.RESERVED)) continue;
        const dj = distToJoist(((c & 31) + 0.5) * CELL, ((c >> 5) + 0.5) * CELL);
        if (!(dj <= 2.4)) expect(dj).toBeLessThanOrEqual(2.4);
      }
      for (const f of l.fixtures) {
        if (f.kind !== FixtureKind.HIGHBAY) continue;
        highbays++;
        if (!(Math.abs(f.py - 7.0) < 10 ** -6 / 2)) expect(f.py).toBeCloseTo(7.0, 6);
        if (!(f.luminance > 1800)) expect(f.luminance).toBeGreaterThan(1800);
        const dj = distToJoist(f.px, f.pz);
        if (!(dj <= 1.2)) expect(dj).toBeLessThanOrEqual(1.2);
      }
      // racks: COLLIDE | OCCLUDE props, 2 cells wide, in rows along x
      const sparse = l.props.filter((p) => p.kind === PropKind.SHELF_RACK && p.variant === 1);
      for (const p of l.props) {
        if (p.kind === PropKind.SHELF_RACK) {
          racks++;
          if (!Object.is(p.flags & (SolidFlag.COLLIDE | SolidFlag.OCCLUDE), SolidFlag.COLLIDE | SolidFlag.OCCLUDE)) expect(p.flags & (SolidFlag.COLLIDE | SolidFlag.OCCLUDE)).toBe(SolidFlag.COLLIDE | SolidFlag.OCCLUDE);
          if (!Object.is(p.yaw, 0)) expect(p.yaw).toBe(0);
        }
        if ((p.kind === PropKind.CRATE || p.kind === PropKind.CARDBOARD_BOX) && p.y > 1 && Math.abs(p.y - 3.0) > 1e-6) { // (3.0: mezzanine stock)
          // shelf stock sits on a deck of a sparse rack (WP6 decks at 1.2 / 2.4 / 3.6 m), in its free +x slot
          stock++;
          const onDeck = warehouseRoof.SHELF_Y.some((y) => Math.abs(p.y - y) < 1e-6 || Math.abs(p.y - y - 0.4) < 1e-6);
          expect(onDeck).toBe(true);
          expect(sparse.some((r) => Math.abs(p.x - r.x - 0.72) < 0.1 && Math.abs(p.z - r.z) < 0.1)).toBe(true);
          const halfX = PROP_DEFS[p.kind].size[0] * p.scale / 2;
          expect(p.x - halfX).toBeGreaterThan(sparse.find((r) => Math.abs(p.x - r.x - 0.72) < 0.1 && Math.abs(p.z - r.z) < 0.1)!.x + 0.38);
        }
      }
      // mezzanine: WALKABLE_TOP slab 0.2 m thick at 3.0 m, 16-step stair, rails
      const slab = l.solids.find((s) => s.kind === 'box' && Math.abs(s.max[1] - 3.0) < 1e-9 && (s.flags & SolidFlag.WALKABLE_TOP));
      if (slab && slab.kind === 'box') {
        mezz++;
        expect(slab.max[1] - slab.min[1]).toBeCloseTo(0.2, 6);
        const area = Math.round((slab.max[0] - slab.min[0]) / CELL) * Math.round((slab.max[2] - slab.min[2]) / CELL);
        expect(area).toBe(24);
        expect(l.solids.some((s) => s.kind === 'ramp' && s.steps === 16 && Math.abs(s.y1 - 3.0) < 1e-9)).toBe(true);
        expect(l.solids.some((s) => s.kind === 'box' && Math.abs(s.min[1] - 3.0) < 1e-9 && !(s.flags & SolidFlag.OCCLUDE))).toBe(true);
      }
    }
    console.log(`[zones-deep] WAREHOUSE 100 chunks: highbays ${highbays}, racks ${racks}, shelf stock ${stock}, mezzanines ${mezz}`);
    expect(highbays).toBeGreaterThan(100 * 6);
    expect(racks).toBeGreaterThan(100 * 20);
    expect(mezz).toBeGreaterThan(10);
    expect(mezz).toBeLessThan(55);
  });
});

// ---------------------------------------------------------------- CONCRETE

describe('WP3 CONCRETE', () => {
  const gen = concreteGenerator;
  it('seam pattern: corridor-width ports, no wall run > 12', () => {
    for (let k = 0; k < 500; k++) {
      const e = gen.seamPattern!(new Rng(k), makeWorld({ seed: k, s: 1, gen }).district(0, 0));
      let run = 0, maxRun = 0, ports = 0, prev = EdgeKind.WALL as number;
      for (let c = 0; c < N; c++) {
        if (e.kind[c] === EdgeKind.OPEN) { if (prev !== EdgeKind.OPEN) ports++; run = 0; } else { run++; maxRun = Math.max(maxRun, run); }
        prev = e.kind[c];
      }
      expect(ports).toBeGreaterThanOrEqual(2);
      expect(maxRun).toBeLessThanOrEqual(12);
    }
  });
  it('corridors + utility rooms with openings, loading drops with a HALF rail and a stair, two-tone CMU walls', () => {
    let drops = 0, doorways = 0, walls = 0, wainscot = 0, tubes = 0, bulbs = 0, chunks = 0, clusters = 0;
    const DROP_EDGES: number[] = [EdgeKind.HALF, EdgeKind.WALL, EdgeKind.OPEN];
    for (let k = 0; k < 150; k++) {
      const r = new Rng(71000 + k);
      const w = makeWorld({ seed: r.next(), s: 1, gen });
      const { l } = genChunk(w, r.int(-40, 40), r.int(-40, 40));
      chunks++;
      for (let a = 0; a < N; a++) for (let line = 1; line < N; line++) { // interior lines (seams belong to WP1)
        for (const [e, i] of [[l.ex, exIdx(line, a)], [l.ez, ezIdx(a, line)]] as [typeof l.ex, number][]) {
          if (e.kind[i] === EdgeKind.DOORWAY) doorways++;
          if (e.kind[i] === EdgeKind.WALL) { walls++; if (e.trim[i] & EdgeTrim.WAINSCOT) wainscot++; }
        }
      }
      // loading drops: cells at -100 separated from floor-level cells by HALF edges or linked by a stair ramp
      const low: number[] = [];
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (!(l.flags[c] & (CellFlag.SOLID | CellFlag.RESERVED)) && l.floorCm[c] === -100) low.push(c);
      if (low.length) {
        drops++;
        const stair = l.solids.find((s) => s.kind === 'ramp' && Math.abs(s.y0 + 1) < 1e-9 && s.y1 === 0);
        expect(stair).toBeDefined();
        let half = 0;
        for (const c of low) {
          const li = c & 31, lj = c >> 5;
          for (const [axis, i, j, ni, nj] of [['x', li, lj, li - 1, lj], ['x', li + 1, lj, li + 1, lj], ['z', li, lj, li, lj - 1], ['z', li, lj + 1, li, lj + 1]] as ['x' | 'z', number, number, number, number][]) {
            if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
            const n = cellIdx(ni, nj);
            if (l.flags[n] & CellFlag.SOLID || l.floorCm[n] !== 0) continue;
            const kind = axis === 'x' ? l.ex.kind[exIdx(i, j)] : l.ez.kind[ezIdx(i, j)];
            // a drop edge is a HALF rail, a wall, or the OPEN top of the stair
            if (DROP_EDGES.indexOf(kind) === -1) expect(DROP_EDGES).toContain(kind);
            if (kind === EdgeKind.HALF) half++;
          }
        }
        expect(half).toBeGreaterThan(0);
      }
      for (const f of l.fixtures) {
        if (f.kind === FixtureKind.TUBE_STRIP) tubes++;
        if (f.kind === FixtureKind.CAGE_BULB) bulbs++;
      }
      if (l.props.some((p) => p.kind === PropKind.PALLET || p.kind === PropKind.CRATE)) clusters++;
    }
    console.log(`[zones-deep] CONCRETE ${chunks} chunks: loading drops ${drops}, doorways ${doorways}, walls ${walls} (wainscot ${wainscot}), tubes ${tubes}, bulbs ${bulbs}, chunks with crates/pallets ${clusters}`);
    expect(drops).toBeGreaterThan(chunks * 0.15);
    expect(doorways).toBeGreaterThan(chunks * 3);
    expect(wainscot / walls).toBeGreaterThan(0.9);
    expect(tubes / chunks).toBeGreaterThan(10);
    expect(bulbs / chunks).toBeGreaterThan(3);
    expect(clusters).toBeGreaterThan(chunks * 0.5);
  });
});

// ---------------------------------------------------------------- GLOBAL seams (500 pairs)

describe('WP3 GLOBAL seams agree across 500 chunk pairs per zone', { tags: ['sweep'] }, () => {
  const pairs = (name: string, gen: ZoneGenerator, s: StoreyId, check: (A: ChunkLayout, B: ChunkLayout, axis: 'x' | 'z') => void): void => {
    it(`${name}: shared line, water, floors and straddling solids agree`, () => {
      const rng = new Rng(8100 + gen.id);
      for (let k = 0; k < 500; k++) {
        const seed = rng.int(0, 1 << 30);
        const cx = rng.int(-300, 300), cz = rng.int(-300, 300);
        const axis: 'x' | 'z' = rng.chance(0.5) ? 'x' : 'z';
        const w = makeWorld({ seed, s, gen });
        const d = w.district(cx, cz);
        // the seam computed for either side (fresh caches, different call order) is identical
        const q = { seed, s, district: d, axis, line: axis === 'x' ? cx * N : cz * N, g0: axis === 'x' ? cz * N : cx * N };
        const q1 = gen.globalSeam!(q);
        gen.globalSeam!({ ...q, line: q.line + N }); // warm any cache with another line first
        const q2 = gen.globalSeam!({ ...q });
        if (!sameValues(q1.kind, q2.kind)) expect(Array.from(q1.kind)).toEqual(Array.from(q2.kind));
        if (!sameValues(q1.hA, q2.hA)) expect(Array.from(q1.hA)).toEqual(Array.from(q2.hA));
        // both chunks of the pair, generated independently, write the same line and agree across it
        const A = genChunk(w, axis === 'x' ? cx - 1 : cx, axis === 'x' ? cz : cz - 1).l;
        const B = genChunk(w, cx, cz).l;
        for (let c = 0; c < N; c++) {
          const ia = axis === 'x' ? exIdx(N, c) : ezIdx(c, N), ib = axis === 'x' ? exIdx(0, c) : ezIdx(c, 0);
          const ea = axis === 'x' ? A.ex : A.ez, eb = axis === 'x' ? B.ex : B.ez;
          if (!Object.is(ea.kind[ia], q1.kind[c])) expect(ea.kind[ia]).toBe(q1.kind[c]);
          if (!Object.is(eb.kind[ib], q1.kind[c])) expect(eb.kind[ib]).toBe(q1.kind[c]);
          if (!Object.is(ea.hA[ia], eb.hA[ib])) expect(ea.hA[ia]).toBe(eb.hA[ib]);
        }
        check(A, B, axis);
      }
    });
  };
  /** The cell pair (a in A, b in B) facing each other across the shared line at index c. */
  const across = (axis: 'x' | 'z', c: number): [number, number] => (axis === 'x' ? [cellIdx(N - 1, c), cellIdx(0, c)] : [cellIdx(c, N - 1), cellIdx(c, 0)]);
  /** Solids of a layout that cross the shared line, in B-local coordinates. */
  const straddlers = (l: ChunkLayout, axis: 'x' | 'z', shift: number): string[] => {
    const out: string[] = [];
    const ax = axis === 'x' ? 0 : 2;
    const line = shift === 0 ? 0 : N * CELL;
    for (const s of l.solids) {
      if (s.kind !== 'box') continue;
      if (s.min[ax] < line - 1e-6 && s.max[ax] > line + 1e-6) {
        const mn = [...s.min], mx = [...s.max];
        mn[ax] -= shift; mx[ax] -= shift;
        // clipped pieces: compare the cross-section only (y and the other horizontal axis)
        const o = ax === 0 ? 2 : 0;
        out.push([mn[1], mx[1], mn[o], mx[o]].map((v) => v.toFixed(3)).join(','));
      }
    }
    return out.sort();
  };
  const boxesAtLine = (l: ChunkLayout, axis: 'x' | 'z', line: number): string[] => {
    const ax = axis === 'x' ? 0 : 2, o = ax === 0 ? 2 : 0;
    return l.solids.filter((s) => s.kind === 'box' && (Math.abs(s.min[ax] - line) < 1e-6 || Math.abs(s.max[ax] - line) < 1e-6 || (s.min[ax] < line && s.max[ax] > line)))
      .map((s) => (s.kind === 'box' ? [s.min[1], s.max[1], s.min[o], s.max[o]].map((v) => v.toFixed(3)).join(',') : '')).sort();
  };

  let seamChannels = 0;
  pairs('POOLROOMS', poolroomsGenerator, 2, (A, B, axis) => {
    for (let c = 0; c < N; c++) {
      const e = axis === 'x' ? A.ex : A.ez, i = axis === 'x' ? exIdx(N, c) : ezIdx(c, N);
      if (!EDGE_WALKABLE[e.kind[i]]) continue;
      const [a, b] = across(axis, c);
      if ((A.flags[a] | B.flags[b]) & CellFlag.RESERVED) continue;
      // water never spills through an opening: equal surfaces, or the dry side's floor holds it back
      const wa = A.waterCm[a], wb = B.waterCm[b];
      if (wa !== NO_WATER && wa > A.floorCm[a] && !(wb === wa || B.floorCm[b] >= wa)) expect(wb === wa || B.floorCm[b] >= wa).toBe(true);
      if (wb !== NO_WATER && wb > B.floorCm[b] && !(wa === wb || A.floorCm[a] >= wb)) expect(wa === wb || A.floorCm[a] >= wb).toBe(true);
      // a channel through a seam arch: both sides sunken and wet at the same level
      if (A.floorCm[a] < 0 && B.floorCm[b] < 0 && wa !== NO_WATER && wa === wb) seamChannels++;
    }
  });
  it('POOLROOMS: some channels run through seam arches', () => {
    console.log(`[zones-deep] POOLROOMS: ${seamChannels} wet channel edges across seams in 500 pairs`);
    expect(seamChannels).toBeGreaterThan(0);
  });
  pairs('PARKING', parkingGenerator, 1, (A, B, axis) => {
    // columns straddling the line are added (whole) by both chunks; beams continue across it
    expect(straddlers(A, axis, N * CELL)).toEqual(straddlers(B, axis, 0));
    const beamsA = boxesAtLine(A, axis, N * CELL).filter((s) => !s.startsWith('0.000')), beamsB = boxesAtLine(B, axis, 0).filter((s) => !s.startsWith('0.000'));
    if (axis === 'x') expect(beamsA).toEqual(beamsB);
  });
  pairs('WAREHOUSE', warehouseGenerator, 1, (A, B, axis) => {
    // roof members meeting the line from both sides have the same cross-sections (continuous girders / joists)
    expect(boxesAtLine(A, axis, N * CELL).filter((s) => s.startsWith('7.400'))).toEqual(boxesAtLine(B, axis, 0).filter((s) => s.startsWith('7.400')));
  });
});

// ---------------------------------------------------------------- merged halls, tees, full-pipeline seams

type PipeS = Extract<Solid, { kind: 'pipe' }>;
const isPipe = (s: Solid): s is PipeS => s.kind === 'pipe';
const vertical = (p: PipeS): boolean => Math.abs(p.a[0] - p.b[0]) < 1e-9 && Math.abs(p.a[2] - p.b[2]) < 1e-9;
const horizontal = (p: PipeS): boolean => Math.abs(p.a[1] - p.b[1]) < 1e-9;

describe('WP3 POOLROOMS merged halls', () => {
  it('a merged room is the whole component of removed walls, on any lattice line (seams included)', () => {
    let big = 0, removedOn3 = 0, removedOnSeam = 0;
    for (let k = 0; k < 120; k++) {
      const r = new Rng(88000 + k);
      const seed = r.next(), rx0 = r.int(-200, 200), rz0 = r.int(-200, 200);
      const removed = (axisBit: 0 | 1, L: number, idx: number): boolean => {
        const v = poolroomsWallRemoved(seed, 2, axisBit, L, idx);
        if (v && ((L % 3) + 3) % 3 === 0) removedOn3++;
        if (v && ((L % 4) + 4) % 4 === 0) removedOnSeam++;
        return v;
      };
      // BFS the component with the public wall rule
      const seen = new Set<string>([`${rx0},${rz0}`]);
      const q: [number, number][] = [[rx0, rz0]];
      const outside: [number, number][] = [];
      for (let i = 0; i < q.length && q.length < 2000; i++) {
        const [x, z] = q[i];
        const nb: [number, number, boolean][] = [
          [x + 1, z, removed(0, x + 1, z)], [x - 1, z, removed(0, x, z)], [x, z + 1, removed(1, z + 1, x)], [x, z - 1, removed(1, z, x)],
        ];
        for (const [nx, nz, open] of nb) {
          if (seen.has(`${nx},${nz}`)) continue;
          if (!open) { outside.push([nx, nz]); continue; }
          seen.add(`${nx},${nz}`);
          q.push([nx, nz]);
        }
      }
      expect(q.length).toBeLessThan(2000);
      if (q.length > 9) big++;
      const a = poolroomsRoomInfo(seed, 2, false, rx0, rz0);
      // R: a rectangle of whole rooms inside one chunk
      expect(Math.floor(a.R.i0 / N)).toBe(Math.floor((a.R.i1 - 1) / N));
      expect(Math.floor(a.R.j0 / N)).toBe(Math.floor((a.R.j1 - 1) / N));
      for (const [x, z] of q.slice(0, 40)) expect(poolroomsRoomInfo(seed, 2, false, x, z)).toEqual(a);
      // rooms behind a standing wall that are not in the component have their own anchor
      for (const [x, z] of outside.slice(0, 12)) {
        if (!seen.has(`${x},${z}`)) expect(poolroomsRoomInfo(seed, 2, false, x, z).anchor).not.toBe(a.anchor);
      }
    }
    expect(big).toBeGreaterThan(10); // halls larger than the old 3x3 super-block
    expect(removedOn3).toBeGreaterThan(0);
    expect(removedOnSeam).toBeGreaterThan(0);
  });
});

describe('WP3 PIPEWORKS tees and district boundaries', () => {
  it('risers meet horizontal pipes only at pipe ends (tees split: WP6 junction fittings); no pipe ends on a boundary seam', () => {
    let tees = 0, risers = 0, boundaryRuns = 0;
    for (let k = 0; k < 80; k++) {
      const r = new Rng(53000 + k);
      const cx = r.int(-40, 40), cz = r.int(-40, 40);
      const w = makeWorld({ seed: r.next(), s: 1, gen: pipeworksGenerator, districtOf: (x) => (x === cx + 1 ? 7 : 4242) });
      const { l } = genChunk(w, cx, cz);
      const pipes = l.solids.filter(isPipe);
      const horiz = pipes.filter(horizontal);
      for (const v of pipes.filter(vertical)) {
        risers++;
        for (const E of [v.a, v.b]) {
          let ends = 0;
          for (const p of horiz) {
            const alongX = Math.abs(p.a[2] - p.b[2]) < 1e-9;
            const ax = alongX ? 0 : 2, lat = alongX ? 2 : 0;
            if (Math.abs(E[1] - p.a[1]) > 1e-6 || Math.abs(E[lat] - p.a[lat]) > 1e-6) continue;
            const lo = Math.min(p.a[ax], p.b[ax]), hi = Math.max(p.a[ax], p.b[ax]);
            const inside = E[ax] > lo + 1e-3 && E[ax] < hi - 1e-3;
            if (!Object.is(inside, false)) expect(inside, `riser end inside a pipe span in ${cx},${cz}`).toBe(false);
            if (Math.abs(E[ax] - lo) < 1e-6 || Math.abs(E[ax] - hi) < 1e-6) ends++;
          }
          if (ends >= 2) tees++;
        }
      }
      // the east neighbour is another district: an x-pipe never reaches an open boundary edge (it stops short and
      // rises); into a boundary WALL it may run (its end is hidden in the wall)
      for (const p of horiz) {
        if (Math.abs(p.a[2] - p.b[2]) > 1e-9) continue;
        const row = Math.floor(p.a[2] / CELL);
        if (!EDGE_WALKABLE[l.ex.kind[exIdx(N, row)]]) continue;
        const xe = Math.max(p.a[0], p.b[0]);
        if (!(xe < CHUNK_SIZE - 1e-3)) expect(xe).toBeLessThan(CHUNK_SIZE - 1e-3); // (a turn in the last cell may end up to 0.57 m past its centre)
        if (Math.abs(xe - (CHUNK_SIZE - 0.25)) < 1e-6) boundaryRuns++; // stopped 0.25 m short, then rises
      }
    }
    console.log(`[zones-deep] PIPEWORKS tees: ${tees} split tees, ${risers} risers, ${boundaryRuns} runs stopped at a district boundary`);
    expect(tees).toBeGreaterThan(20);
    expect(boundaryRuns).toBeGreaterThan(0);
  });
});

describe('WP3 deep zones: seams through the full pipeline (stamps, landmarks, district boundaries)', { tags: ['sweep'] }, () => {
  const block = (zone: ZoneId, lm: LandmarkKindId, seed: number, forced: boolean): Map<string, ChunkLayout> => {
    const wg = createWorldGen({ seed, seedText: String(seed), forceZone: zone, forceMood: null, forceLandmark: forced ? lm : null, testScene: null, lights: 'default' });
    const s: StoreyId = zone === Zone.POOLROOMS ? 2 : 1;
    const c0 = forced ? -1 : (seed % 50) - 25, d0 = forced ? -1 : ((seed * 7) % 50) - 25;
    const out = new Map<string, ChunkLayout>();
    for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) out.set(`${dx},${dz}`, wg.generateChunk({ s, cx: c0 + dx, cz: d0 + dz }));
    return out;
  };
  it('POOLROOMS: every sunken water body away from the block edge holds a pool (no channel stubs)', () => {
    let channelCells = 0, blocks = 0, channels = 0;
    for (let k = 0; k < 24; k++) {
      const ls = block(Zone.POOLROOMS, LandmarkKind.DEEP_END, 7000 + k, k % 2 === 0);
      blocks++;
      const M = 3 * N;
      const floor = new Int16Array(M * M), wet = new Uint8Array(M * M);
      for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
        const l = ls.get(`${dx},${dz}`)!;
        for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
          const g = (dz * N + (c >> 5)) * M + dx * N + (c & 31);
          floor[g] = l.floorCm[c];
          wet[g] = l.waterCm[c] !== NO_WATER && l.floorCm[c] < 0 && l.floorCm[c] > -250 && !(l.flags[c] & CellFlag.LANDMARK) ? 1 : 0;
          if (wet[g] && l.floorCm[c] === -30) channels++;
        }
      }
      const seen = new Uint8Array(M * M);
      for (let g0 = 0; g0 < M * M; g0++) {
        if (!wet[g0] || seen[g0]) continue;
        const st = [g0];
        seen[g0] = 1;
        let edge = false, pool = false, n = 0;
        while (st.length) {
          const g = st.pop()!;
          n++;
          const x = g % M, z = (g - x) / M;
          if (x === 0 || z === 0 || x === M - 1 || z === M - 1) edge = true;
          if (floor[g] <= -40) pool = true;
          for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
            if (nx < 0 || nz < 0 || nx >= M || nz >= M) continue;
            const m = nz * M + nx;
            if (wet[m] && !seen[m]) { seen[m] = 1; st.push(m); }
          }
        }
        if (!pool) channelCells += n;
        expect(pool || edge, `channel stub (${n} cells) at block cell ${g0 % M},${Math.floor(g0 / M)} seed ${7000 + k}`).toBe(true);
      }
    }
    console.log(`[zones-deep] POOLROOMS full pipeline: ${blocks} 3x3 blocks, ${channels} channel cells, ${channelCells} of them in pool-less bodies at block edges`);
    expect(channels).toBeGreaterThan(0);
  });
  it('PIPEWORKS: pipes continue across same-district seams and stop short of district boundaries', () => {
    let matched = 0, boundaries = 0;
    for (let k = 0; k < 24; k++) {
      const ls = block(Zone.PIPEWORKS, LandmarkKind.BOILER_HALL, 7100 + k, k % 2 === 0);
      for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) {
        const A = ls.get(`${dx},${dz}`)!;
        for (const [axis, B] of [['x', ls.get(`${dx + 1},${dz}`)], ['z', ls.get(`${dx},${dz + 1}`)]] as ['x' | 'z', ChunkLayout | undefined][]) {
          if (!B) continue;
          const ax = axis === 'x' ? 0 : 2, lat = axis === 'x' ? 2 : 0;
          // pipes ending on the shared line through an open (walkable) seam edge
          const openAt = (c: number): boolean => EDGE_WALKABLE[axis === 'x' ? A.ex.kind[exIdx(N, c)] : A.ez.kind[ezIdx(c, N)]];
          const atLine = (l: ChunkLayout, v: number): string[] => l.solids.filter(isPipe).filter(horizontal)
            .filter((p) => Math.abs(p.a[lat] - p.b[lat]) < 1e-9 && (Math.abs(p.a[ax] - v) < 1e-6 || Math.abs(p.b[ax] - v) < 1e-6))
            .filter((p) => openAt(Math.floor(p.a[lat] / CELL)))
            .map((p) => `${p.a[1].toFixed(3)},${p.a[lat].toFixed(3)},${p.r.toFixed(3)}`).sort();
          const ea = atLine(A, CHUNK_SIZE), eb = atLine(B, 0);
          if (A.districtId === B.districtId) { expect(ea).toEqual(eb); matched += ea.length; }
          else { boundaries++; expect(ea).toEqual([]); expect(eb).toEqual([]); }
        }
      }
    }
    console.log(`[zones-deep] PIPEWORKS full pipeline: ${matched} pipes continue across seams, ${boundaries} district-boundary seams clean`);
    expect(matched).toBeGreaterThan(50);
  });
});
