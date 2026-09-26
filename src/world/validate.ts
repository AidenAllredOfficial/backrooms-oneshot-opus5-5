// src/world/validate.ts — layout validation and the golden layout hash (WP1).

import { CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE, EDGE_COUNT, GEN_VERSION, LIGHT, TILE_SIZE } from '../core/constants.ts';
import { cellIdx, exIdx, ezIdx, tileOfPoint, worldToCell } from '../core/grid.ts';
import { CellFlag, CeilKind, EdgeKind, isRecessedFixture, LightState, MAT_COUNT, TileState, ZONE_COUNT } from '../core/ids.ts';
import { NO_WATER, type ChunkLayout, type EdgeGrid } from '../core/layout.ts';
import { mix32 } from '../core/rng.ts';
import type { SeamSpec, WorldGen } from '../core/world.ts';
import { STRUCTURE_ZONE } from '../core/zones.ts';
import { cellWalkable, computePorts, edgePassable, portCells } from './connectivity.ts';

const N = CHUNK_CELLS;
const MAX_ERRORS = 64;
const EPS = 1e-6;

/** [] when valid. With `gen`, the border lines are also checked against gen.seam() and the district. */
export function validateLayout(l: ChunkLayout, gen?: WorldGen): string[] {
  const errs: string[] = [];
  const err = (m: string): void => { if (errs.length < MAX_ERRORS) errs.push(m); };
  const k = l.key;

  // ---- array sizes / version
  const cellArrs: [string, ArrayLike<number>][] = [
    ['flags', l.flags], ['floorCm', l.floorCm], ['ceilCm', l.ceilCm], ['waterCm', l.waterCm], ['blockCm', l.blockCm],
    ['floorMat', l.floorMat], ['ceilMat', l.ceilMat], ['ceilKind', l.ceilKind], ['tiles', l.tiles], ['cellZone', l.cellZone],
    ['wallMat', l.wallMat], ['trimMat', l.trimMat], ['room', l.room], ['power', l.power], ['decay', l.decay],
    ['humidity', l.humidity], ['warmth', l.warmth],
  ];
  for (const [n, a] of cellArrs) if (!a || a.length !== CHUNK_CELL_COUNT) err(`${n}: length ${a?.length} != ${CHUNK_CELL_COUNT}`);
  for (const [n, e] of [['ex', l.ex], ['ez', l.ez]] as [string, EdgeGrid][]) {
    for (const f of ['kind', 'hA', 'hB', 'matNeg', 'matPos', 'trim'] as const) {
      if (!e?.[f] || e[f].length !== EDGE_COUNT) err(`${n}.${f}: bad length`);
    }
  }
  if (errs.length) return errs;
  if (l.genVersion !== GEN_VERSION) err(`genVersion ${l.genVersion} != ${GEN_VERSION}`);
  if (l.zone < 0 || l.zone >= ZONE_COUNT) err(`zone ${l.zone} out of range`);

  // ---- cells
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    const at = `cell (${c & 31},${c >> 5})`;
    if (l.floorMat[c] >= MAT_COUNT || l.ceilMat[c] >= MAT_COUNT || l.wallMat[c] >= MAT_COUNT || l.trimMat[c] >= MAT_COUNT) err(`${at}: material out of range`);
    if (l.cellZone[c] >= ZONE_COUNT) err(`${at}: cellZone ${l.cellZone[c]} out of range`);
    if (l.ceilKind[c] > CeilKind.TRUSS) err(`${at}: ceilKind ${l.ceilKind[c]} out of range`);
    for (let t = 0; t < 4; t++) if (((l.tiles[c] >> (t * 4)) & 15) > TileState.DIRTY) err(`${at}: tile state out of range`);
    const f = l.flags[c];
    if ((f & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0 && l.cellZone[c] !== STRUCTURE_ZONE) err(`${at}: TOWER/ELEVATOR cellZone ${l.cellZone[c]} != STRUCTURE_ZONE`);
    if ((f & (CellFlag.SOLID | CellFlag.TOWER | CellFlag.VOID)) === 0 && l.ceilCm[c] <= l.floorCm[c]) err(`${at}: ceilCm ${l.ceilCm[c]} <= floorCm ${l.floorCm[c]}`);
    if (l.blockCm[c] < 0) err(`${at}: negative blockCm`);
    if (l.waterCm[c] !== NO_WATER && l.waterCm[c] < l.floorCm[c] - 1 && (f & CellFlag.VOID) === 0) err(`${at}: water below floor`);
    if ((f & CellFlag.SOLID) === 0 && l.room[c] === 0 && hasRooms(l)) err(`${at}: non-SOLID cell without a room label`);
    if ((f & CellFlag.SPAWN_OK) !== 0 && !cellWalkable(l, c)) err(`${at}: SPAWN_OK but not walkable`);
  }

  // ---- edges
  for (const [n, e] of [['ex', l.ex], ['ez', l.ez]] as [string, EdgeGrid][]) {
    for (let i = 0; i < EDGE_COUNT; i++) {
      if (e.kind[i] > EdgeKind.GLITCH) err(`${n}[${i}]: kind ${e.kind[i]} out of range`);
      if (e.matNeg[i] >= MAT_COUNT || e.matPos[i] >= MAT_COUNT) err(`${n}[${i}]: material out of range`);
    }
  }

  // ---- fixtures
  const ids = new Set<number>();
  const dynPerTile = [0, 0, 0, 0];
  for (const fx of l.fixtures) {
    const at = `fixture ${fx.id} (kind ${fx.kind})`;
    if (ids.has(fx.id)) err(`${at}: duplicate id`);
    ids.add(fx.id);
    const nums = [fx.px, fx.py, fx.pz, fx.nx, fx.ny, fx.nz, fx.tx, fx.ty, fx.tz, fx.w, fx.h, fx.luminance, fx.color[0], fx.color[1], fx.color[2]];
    if (nums.some((v) => !Number.isFinite(v))) { err(`${at}: non-finite value`); continue; }
    if (fx.px < -EPS || fx.pz < -EPS || fx.px > CHUNK_SIZE + EPS || fx.pz > CHUNK_SIZE + EPS) err(`${at}: centre outside the chunk`);
    if (isRecessedFixture(fx.kind) && fx.shape === 0) {
      const [x0, x1, z0, z1] = rectExtent(fx);
      if (straddles(x0, x1) || straddles(z0, z1)) err(`${at}: recessed rect straddles a render-tile line`);
    }
    if (fx.dynamic) {
      if (fx.state !== LightState.FLICKER && fx.state !== LightState.ANOMALY) err(`${at}: dynamic but state ${fx.state}`);
      const li = Math.min(N - 1, Math.max(0, worldToCell(fx.px))), lj = Math.min(N - 1, Math.max(0, worldToCell(fx.pz)));
      if (fx.py - l.floorCm[cellIdx(li, lj)] / 100 > LIGHT.DYN_MAX_MOUNT + EPS) err(`${at}: dynamic light mounted > ${LIGHT.DYN_MAX_MOUNT} m above its floor`);
      dynPerTile[tileOfPoint(fx.px, fx.pz)]++;
    }
  }
  for (let q = 0; q < 4; q++) if (dynPerTile[q] > LIGHT.MAX_DYN_PER_TILE) err(`tile ${q}: ${dynPerTile[q]} dynamic lights`);

  // ---- structures / landmarks
  for (const s of l.structures) {
    if (s.i0 < 0 || s.j0 < 0 || s.i1 > N || s.j1 > N || s.i1 <= s.i0 || s.j1 <= s.j0) err(`structure ${s.id}: bad rect`);
  }
  for (const m of l.landmarks) {
    if (m.i0 < 0 || m.j0 < 0 || m.i1 > N || m.j1 > N || m.i1 <= m.i0 || m.j1 <= m.j0) err(`landmark ${m.kind}: bad rect`);
  }
  for (const s of l.solids) {
    const v = s.kind === 'box' ? [...s.min, ...s.max] : s.kind === 'ramp' ? [s.x0, s.z0, s.x1, s.z1, s.y0, s.y1] : [...s.a, ...s.b, s.r];
    if (v.some((x) => !Number.isFinite(x))) err(`solid ${s.id}: non-finite value`);
  }
  for (const p of l.props) if (![p.x, p.y, p.z, p.yaw, p.scale].every(Number.isFinite)) err(`prop kind ${p.kind}: non-finite value`);

  // ---- ports and in-chunk connectivity
  const expect = computePorts(l);
  if (JSON.stringify(expect) !== JSON.stringify(l.ports)) err('ports do not match the border lines');
  const pc = portCells(l);
  const scene = gen?.opts.testScene ?? null;
  if (gen && scene === null && pc.length === 0) err('no walkable seam edge');
  if (scene === null && pc.length > 0) {
    const seen = new Uint8Array(CHUNK_CELL_COUNT);
    const stack: number[] = [];
    for (const c of pc) {
      if (!cellWalkable(l, c)) { err(`port cell (${c & 31},${c >> 5}) not walkable`); continue; }
      if (!seen[c]) { seen[c] = 1; stack.push(c); }
    }
    while (stack.length) {
      const c = stack.pop() as number;
      const li = c & 31, lj = c >> 5;
      if (li > 0 && !seen[c - 1] && cellWalkable(l, c - 1) && edgePassable(l, 'x', li, lj)) { seen[c - 1] = 1; stack.push(c - 1); }
      if (li < N - 1 && !seen[c + 1] && cellWalkable(l, c + 1) && edgePassable(l, 'x', li + 1, lj)) { seen[c + 1] = 1; stack.push(c + 1); }
      if (lj > 0 && !seen[c - N] && cellWalkable(l, c - N) && edgePassable(l, 'z', li, lj)) { seen[c - N] = 1; stack.push(c - N); }
      if (lj < N - 1 && !seen[c + N] && cellWalkable(l, c + N) && edgePassable(l, 'z', li, lj + 1)) { seen[c + N] = 1; stack.push(c + N); }
    }
    let lost = 0, first = -1;
    for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
      if (seen[c] || !cellWalkable(l, c) || (l.flags[c] & CellFlag.SEALED) !== 0) continue;
      if (first < 0) first = c;
      lost++;
    }
    if (lost > 0) err(`${lost} walkable cells unreachable from the ports (first (${first & 31},${first >> 5}))`);
  }

  // ---- hash
  if (l.hash !== 0 && l.hash !== layoutHash(l)) err('hash does not match layoutHash');

  // ---- against the world
  if (gen && scene === null) {
    const d = gen.districtAt(k.s, k.cx, k.cz);
    if (d.zone !== l.zone || d.id !== l.districtId) err('zone / district differ from districtAt');
    const cmp = (side: string, e: EdgeGrid, idx: (c: number) => number, s: SeamSpec): void => {
      for (let c = 0; c < N; c++) {
        const i = idx(c);
        if (e.kind[i] !== s.kind[c] || e.hA[i] !== s.hA[c] || e.hB[i] !== s.hB[c] || e.matNeg[i] !== s.matNeg[c] || e.matPos[i] !== s.matPos[c] || e.trim[i] !== s.trim[c]) {
          err(`${side} seam differs from gen.seam() at ${c}`);
          return;
        }
      }
    };
    cmp('W', l.ex, (c) => exIdx(0, c), gen.seam(k.s, 'x', k.cx, k.cz));
    cmp('E', l.ex, (c) => exIdx(N, c), gen.seam(k.s, 'x', k.cx + 1, k.cz));
    cmp('N', l.ez, (c) => ezIdx(c, 0), gen.seam(k.s, 'z', k.cx, k.cz));
    cmp('S', l.ez, (c) => ezIdx(c, N), gen.seam(k.s, 'z', k.cx, k.cz + 1));
  }
  return errs;
}

function hasRooms(l: ChunkLayout): boolean {
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if (l.room[c] !== 0) return true;
  return false;
}

/** [x0, x1, z0, z1] (chunk-local) of a RECT fixture's emitting rectangle. */
function rectExtent(f: { px: number; pz: number; nx: number; ny: number; nz: number; tx: number; ty: number; tz: number; w: number; h: number }): [number, number, number, number] {
  // b = n x t
  const bx = f.ny * f.tz - f.nz * f.ty, bz = f.nx * f.ty - f.ny * f.tx;
  const hx = Math.abs(f.tx) * f.w / 2 + Math.abs(bx) * f.h / 2;
  const hz = Math.abs(f.tz) * f.w / 2 + Math.abs(bz) * f.h / 2;
  return [f.px - hx, f.px + hx, f.pz - hz, f.pz + hz];
}
/** Chunk origins are multiples of 2·TILE_SIZE, so the render-tile lines in local coordinates are 0, 19.2, 38.4. */
const straddles = (a: number, b: number): boolean => {
  for (let t = 0; t <= 2; t++) {
    const line = t * TILE_SIZE;
    if (a < line - 1e-4 && b > line + 1e-4) return true;
  }
  return false;
};

// ------------------------------------------------------------------ hash
// FNV-1a style: h = (h ^ word) * 16777619 per 32-bit word. Every step is a bijection of h, so changing any single
// word always changes the result. Typed arrays are hashed as 32-bit words (all layout arrays have byte lengths
// divisible by 4); content is hashed field by field in a fixed order (no allocation, no key sorting).
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const PRIME = 0x01000193;

function hashArray(h: number, a: ArrayBufferView): number {
  if ((a.byteOffset & 3) === 0 && (a.byteLength & 3) === 0) {
    const w = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], PRIME);
  } else {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], PRIME);
  }
  return Math.imul(h ^ a.byteLength, PRIME);
}
function hn(h: number, v: number): number {
  if ((v | 0) === v) return Math.imul(h ^ v, PRIME);
  f64[0] = v;
  h = Math.imul(h ^ u32[0], PRIME);
  return Math.imul(h ^ u32[1], PRIME);
}
const hb = (h: number, v: boolean | undefined): number => Math.imul(h ^ (v === undefined ? 3 : v ? 1 : 2), PRIME);
const hs = (h: number, v: string): number => {
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), PRIME);
  return Math.imul(h ^ 0xff, PRIME);
};
const h3 = (h: number, v: readonly number[]): number => hn(hn(hn(h, v[0]), v[1]), v[2]);

/** FNV-1a over every per-cell and edge array plus all content (golden-hash tested). */
export function layoutHash(l: ChunkLayout): number {
  let h = 0x811c9dc5;
  const arrs: ArrayBufferView[] = [
    l.flags, l.floorCm, l.ceilCm, l.waterCm, l.blockCm, l.floorMat, l.ceilMat, l.ceilKind, l.tiles, l.cellZone,
    l.wallMat, l.trimMat, l.room, l.power, l.decay, l.humidity, l.warmth,
    l.ex.kind, l.ex.hA, l.ex.hB, l.ex.matNeg, l.ex.matPos, l.ex.trim,
    l.ez.kind, l.ez.hA, l.ez.hB, l.ez.matNeg, l.ez.matPos, l.ez.trim,
  ];
  for (const a of arrs) h = hashArray(h, a);
  for (const v of [l.genVersion, l.key.s, l.key.cx, l.key.cz, l.zone, l.districtId, l.mood]) h = hn(h, v);

  h = hn(h, l.fixtures.length);
  for (const f of l.fixtures) {
    h = hn(hn(hn(hn(h, f.id), f.kind), f.state), f.shape);
    h = hn(hn(hn(h, f.px), f.py), f.pz);
    h = hn(hn(hn(h, f.nx), f.ny), f.nz);
    h = hn(hn(hn(h, f.tx), f.ty), f.tz);
    h = hn(hn(h, f.w), f.h);
    h = h3(h, f.color);
    h = hn(hn(hn(hn(h, f.luminance), f.seed), f.hum), f.bakeGroup);
    h = hb(h, f.dynamic);
  }
  h = hn(h, l.solids.length);
  for (const s of l.solids) {
    h = hn(hn(hn(h, s.id), s.mat), s.flags);
    if (s.kind === 'box') h = h3(h3(hn(hn(h, 1), s.bakeGroup), s.min), s.max);
    else if (s.kind === 'ramp') {
      h = hn(hn(hn(hn(hn(h, 2), s.x0), s.z0), s.x1), s.z1);
      h = hn(hn(hn(hn(hn(h, s.y0), s.y1), s.dir), s.steps), s.bakeGroup);
    } else h = hn(h3(h3(hn(h, 3), s.a), s.b), s.r);
  }
  h = hn(h, l.props.length);
  for (const p of l.props) {
    h = hn(hn(hn(hn(h, p.kind), p.variant), p.flags), p.seed);
    h = hn(hn(hn(hn(hn(h, p.x), p.y), p.z), p.yaw), p.scale);
  }
  h = hn(h, l.decals.length);
  for (const d of l.decals) {
    h = hb(hn(h, d.kind), d.sign);
    h = hn(hn(hn(hn(hn(hn(h, d.px), d.py), d.pz), d.nx), d.ny), d.nz);
    h = hn(hn(hn(hn(h, d.rot), d.w), d.h), d.alpha);
    h = hn(h, d.emit ?? -1);
    h = d.color ? h3(h, d.color) : hn(h, -2);
  }
  h = hn(h, l.water.length);
  for (const w of l.water) h = hn(hn(hn(hn(hn(hn(hn(h, w.x0), w.z0), w.x1), w.z1), w.y), w.floorY), w.kind);
  h = hn(h, l.structures.length);
  for (const s of l.structures) {
    h = hn(hn(hn(hn(h, s.id), s.kind), s.bakeGroup), s.rot);
    h = hn(hn(hn(hn(h, s.i0), s.j0), s.i1), s.j1);
    const p = s.portal;
    if (!p) h = hn(h, -3);
    else {
      h = hs(h, p.kind);
      h = h3(h3(h, p.min), p.max);
      h = hb(hb(hn(h, p.towerId), p.endless), p.wrong);
    }
  }
  h = hn(h, l.ports.length);
  for (const p of l.ports) h = hn(hn(hs(h, p.side), p.from), p.to);
  h = hn(h, l.leaks.length);
  for (const k of l.leaks) h = hn(hn(hn(hn(h, k.x), k.y), k.z), k.strength);
  h = hn(h, l.emitters.length);
  for (const e of l.emitters) h = hn(hn(hn(hn(hn(hn(h, e.kind), e.x), e.y), e.z), e.gain), e.seed);
  h = hn(h, l.vignettes.length);
  for (const v of l.vignettes) h = hn(hn(hn(hn(hn(h, v.kind), v.x), v.z), v.yaw), v.seed);
  h = hn(h, l.landmarks.length);
  for (const m of l.landmarks) h = hn(hn(hn(hn(hn(h, m.kind), m.i0), m.j0), m.i1), m.j1);
  h = hn(h, l.anomalies.length);
  for (const a of l.anomalies) h = hn(hn(hn(hn(hn(h, a.kind), a.x), a.z), a.r), a.seed);
  return mix32(h);
}
