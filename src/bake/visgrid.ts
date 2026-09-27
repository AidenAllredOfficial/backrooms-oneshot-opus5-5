// src/bake/visgrid.ts — VisGrid: the tile's 64x64-cell visibility halo (tile rect +- LIGHT.HALO_CELLS), flattened
// from the 3x3-chunk neighbourhood into typed arrays (WP7 §Algorithms 1). Pure module.
//
// Coordinates: halo units (x/z in cells from the halo origin, y in metres); see util.ts.
// Contents:
//   - per cell: flags, bake group, real floor/ceiling (m), DDA floor/ceiling (towers are unbounded in y for their
//     own group), blocker top, materials, room/region labels, fields;
//   - per edge line: kind, hA, hB, ySill (max adjacent floor), face materials;
//   - occluder boxes bucketed per cell: OCCLUDE solids (boxes, ramps), the PROP_OCCLUDERS part boxes of props that
//     have a part list (which takes precedence over `occlude`; chair backs only near a quarter-turn yaw) and the
//     whole footprint of the other OCCLUDE props (yaw snapped to 90 degrees); prop boxes that abut exactly with the
//     same cross-section (neighbouring racks' uprights) are merged into one;
//   - COLLIDE prop footprints (contact AO; `contactBox` marks those whose prop added an occluder box standing on
//     the floor, which the near-field gather traces instead; props whose part boxes all float above it -- chair
//     seats over their star bases, the lounge chair frame, the pallet deck -- keep the analytic contact AO for the
//     untraced legs and bases) and ceiling leaks (surface mask).

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { cellIdx, exIdx, ezIdx, type TileKey } from '../core/grid.ts';
import { EDGE_OCCLUDES } from '../core/edges.ts';
import { hash4 } from '../core/rng.ts';
import { CellFlag, EdgeKind, PropFlag, SolidFlag, StructureKind } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { PROP_DEFS, PROP_OCCLUDERS_ALIGNED, propOccluders, quarterAligned, type Box6 } from '../core/props.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { expandPeriodicProps, expandPeriodicSolids } from '../mesh/periodic.ts';
import { HALO, HALO_OFF, INV_CELL, growF64, growI32, quant } from './util.ts';

/** Extra periods of tower replication requested from WP5 (|3k| <= TOWER_SPAN + window R needs +2). */
export const PERIODIC_EXTRA_K = 2;
/** Generic albedo layer marker for prop boxes (no material data in the layout). */
export const MAT_PROP = 255;
/** A prop part box whose bottom is at most this far (m) above the prop base stands on the floor (`contactBox`). */
export const CONTACT_GROUND = 0.05;
/** DDA floor/ceiling of tower cells for their own group: periodic geometry is unbounded in y. */
const Y_INF = 1e9;
/** The DDA's floor / ceiling tolerance (m). */
export const DDA_EPS_Y = 1e-3;
/** Pit depth used for VOID cells (the mesher's pit bottom). */
export const VOID_FLOOR = -6;

export interface VisGrid {
  readonly n: number; // HALO
  readonly hl0: number; readonly hm0: number; // halo origin in neighbourhood (centre-chunk-local) cells
  readonly gi0: number; readonly gj0: number; // halo origin in global cells
  readonly s: number; readonly cx: number; readonly cz: number;
  // ---- cells (index hj * n + hi)
  flags: Uint16Array;
  group: Int32Array;
  floor: Float64Array; // real floor (m); VOID: VOID_FLOOR
  ceil: Float64Array; // real ceiling (m)
  dFloor: Float64Array; // DDA floor (tower: -inf)
  dCeil: Float64Array; // DDA ceiling (tower: +inf)
  blockTop: Float64Array; // top of a cell-filling blocker (m) or -1e9
  dLo: Float64Array; // DDA lower bound: max(dFloor, blockTop)
  floorMat: Uint8Array; ceilMat: Uint8Array; wallMat: Uint8Array; ceilKind: Uint8Array;
  room: Int32Array; region: Int32Array;
  decay: Uint8Array; humidity: Uint8Array;
  /** layout slot (0..8, (dcz+1)*3+(dcx+1)) and local cell index of each halo cell */
  slot: Uint8Array; local: Int16Array;
  // ---- edges. ex: line x = i (0..n), row hj: idx hj*(n+1)+i. ez: line z = j (0..n), column hi: idx j*n+hi.
  exKind: Uint8Array; exA: Int16Array; exB: Int16Array; exSill: Float64Array; exMatN: Uint8Array; exMatP: Uint8Array;
  ezKind: Uint8Array; ezA: Int16Array; ezB: Int16Array; ezSill: Float64Array; ezMatN: Uint8Array; ezMatP: Uint8Array;
  /** Light occlusion of each edge as a height interval (edgeOccludesAt, precomputed for the DDA): the edge blocks
   * where y < lo or y >= hi; mode 1 also blocks outside the DOORWAY hole (|t - CELL/2| >= DOOR_W/2), mode 2 (ARCH)
   * needs the exact edgeOccludesAt test inside [lo, hi). */
  exLo: Float64Array; exHi: Float64Array; exMode: Uint8Array;
  ezLo: Float64Array; ezHi: Float64Array; ezMode: Uint8Array;
  /** Corner posts: vertex (X, Z) (index Z * (n + 1) + X) blocks where y < vLo or y >= vHi, the union over the
   * (up to 4) edges meeting there, evaluated at their ends (DOORWAY / ARCH ends are jambs: solid at every y). */
  vLo: Float64Array; vHi: Float64Array;
  // ---- occluder boxes (x/z in halo cells, y in m)
  nBox: number;
  box: Float64Array; // 6 per box: x0 y0 z0 x1 y1 z1
  boxGroup: Int32Array;
  boxMat: Uint8Array;
  boxRamp: Int8Array; // -1 = box, else ramp ascent dir 0 +x, 1 -x, 2 +z, 3 -z
  rampY: Float64Array; // 3 per box: y at low end, y at high end, slab thickness
  boxStart: Int32Array; // n*n + 1
  boxList: Int32Array;
  /** per cell: lowest bottom / highest top (m) of the boxes bucketed there (+Inf / -Inf if none): a segment whose
   * height range in the cell is outside [cBoxLo, cBoxHi] skips the cell's box list */
  cBoxLo: Float64Array; cBoxHi: Float64Array;
  /** DDA cell record, 4 per cell (one cache line for the per-cell tests): dLo - 1e-3, dCeil + 1e-3, cBoxLo,
   * cBoxHi; and the cell's group, or -1 for SOLID cells (`ddaGroup[c] !== group` = blocked). */
  ddaCell: Float64Array; ddaGroup: Int32Array;
  boxStamp: Int32Array;
  stamp: number;
  // ---- contact AO footprints of COLLIDE props (x0 z0 x1 z1 in halo cells, base y)
  nContact: number;
  contact: Float64Array;
  contactY: Float64Array;
  contactGroup: Int32Array;
  /** per contact footprint: 1 when its prop added at least one occluder box standing on the floor (bottom within
   * CONTACT_GROUND of the base: the near-field gather traces it, so it skips the footprint's analytic contact AO) */
  contactBox: Uint8Array;
  contactStart: Int32Array; // per cell (footprint + 0.3 m margin)
  contactList: Int32Array;
  // ---- leaks (x y z strength) and their world-stable ids (hash of chunk + position: tile-independent patterns)
  nLeak: number;
  leak: Float64Array;
  leakId: Int32Array;
}

/** Layout slot and offsets of the 9 neighbourhood layouts. */
export const slotDcx = (slot: number): number => (slot % 3) - 1;
export const slotDcz = (slot: number): number => ((slot / 3) | 0) - 1;

const pushBox = (st: BoxBuild, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, group: number, mat: number, ramp: number, ry0: number, ry1: number, thick: number): void => {
  const i = st.n;
  st.box = growF64(st.box, (i + 1) * 6);
  st.rampY = growF64(st.rampY, (i + 1) * 3);
  st.group = growI32(st.group, i + 1);
  st.mat = growI32(st.mat, i + 1);
  st.ramp = growI32(st.ramp, i + 1);
  st.box[i * 6] = x0; st.box[i * 6 + 1] = y0; st.box[i * 6 + 2] = z0;
  st.box[i * 6 + 3] = x1; st.box[i * 6 + 4] = y1; st.box[i * 6 + 5] = z1;
  st.rampY[i * 3] = ry0; st.rampY[i * 3 + 1] = ry1; st.rampY[i * 3 + 2] = thick;
  st.group[i] = group; st.mat[i] = mat; st.ramp[i] = ramp;
  st.n = i + 1;
};

interface BoxBuild { n: number; box: Float64Array<ArrayBuffer>; rampY: Float64Array<ArrayBuffer>; group: Int32Array<ArrayBuffer>; mat: Int32Array<ArrayBuffer>; ramp: Int32Array<ArrayBuffer> }

/** Rotate a prop-local box by k quarter turns (three.js yaw convention) and scale; returns the local AABB in out. */
export function rotBox(b: Box6, k: number, s: number, out: Float64Array): void {
  const x0 = b[0] * s, y0 = b[1] * s, z0 = b[2] * s, x1 = b[3] * s, y1 = b[4] * s, z1 = b[5] * s;
  out[1] = y0; out[4] = y1;
  switch (k) {
    case 1: out[0] = z0; out[3] = z1; out[2] = -x1; out[5] = -x0; break;
    case 2: out[0] = -x1; out[3] = -x0; out[2] = -z1; out[5] = -z0; break;
    case 3: out[0] = -z1; out[3] = -z0; out[2] = x0; out[5] = x1; break;
    default: out[0] = x0; out[3] = x1; out[2] = z0; out[5] = z1; break;
  }
}

/** Quarter-turn index of a yaw (radians). */
export const yawQuarter = (yaw: number): number => (((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4);

/** Bake group of the TOWER/ELEVATOR structure covering a local cell of a layout (0 if none). */
function structureGroupAt(l: ChunkLayout, li: number, lj: number): number {
  for (const st of l.structures) {
    if ((st.kind === StructureKind.TOWER || st.kind === StructureKind.ELEVATOR) && st.bakeGroup !== 0 &&
      li >= st.i0 && li < st.i1 && lj >= st.j0 && lj < st.j1) return st.bakeGroup;
  }
  return 0;
}

export function buildVisGrid(nb: LayoutNeighborhood, tile: TileKey): VisGrid {
  const n = HALO;
  const nn = n * n;
  const li0 = (tile.q & 1) * 16, lj0 = (tile.q >> 1) * 16;
  const hl0 = li0 - HALO_OFF, hm0 = lj0 - HALO_OFF;
  const layouts: ChunkLayout[] = [];
  for (let slot = 0; slot < 9; slot++) layouts.push(nb.get(slotDcx(slot) as -1 | 0 | 1, slotDcz(slot) as -1 | 0 | 1));

  const flags = new Uint16Array(nn), group = new Int32Array(nn);
  const floor = new Float64Array(nn), ceil = new Float64Array(nn), dFloor = new Float64Array(nn), dCeil = new Float64Array(nn);
  const blockTop = new Float64Array(nn);
  const floorMat = new Uint8Array(nn), ceilMat = new Uint8Array(nn), wallMat = new Uint8Array(nn), ceilKind = new Uint8Array(nn);
  const room = new Int32Array(nn), region = new Int32Array(nn), decay = new Uint8Array(nn), humidity = new Uint8Array(nn);
  const slotArr = new Uint8Array(nn), localArr = new Int16Array(nn);

  for (let hj = 0; hj < n; hj++) {
    const lj = hm0 + hj;
    for (let hi = 0; hi < n; hi++) {
      const li = hl0 + hi;
      const c = hj * n + hi;
      const slot = ((lj >> 5) + 1) * 3 + (li >> 5) + 1;
      const l = layouts[slot];
      const lc = cellIdx(li & 31, lj & 31);
      slotArr[c] = slot; localArr[c] = lc;
      const f = nb.flags(li, lj);
      flags[c] = f;
      const fl = nb.floorCm(li, lj) / 100, ce = nb.ceilCm(li, lj) / 100;
      floor[c] = (f & CellFlag.VOID) !== 0 ? VOID_FLOOR : fl;
      ceil[c] = ce;
      dFloor[c] = floor[c]; dCeil[c] = ce;
      const bc = nb.blockCm(li, lj);
      blockTop[c] = bc > 0 ? fl + bc / 100 : -Y_INF;
      floorMat[c] = l.floorMat[lc]; ceilMat[c] = l.ceilMat[lc]; wallMat[c] = l.wallMat[lc]; ceilKind[c] = l.ceilKind[lc];
      decay[c] = l.decay[lc]; humidity[c] = l.humidity[lc];
      room[c] = nb.room(li, lj);
      region[c] = nb.region(li, lj);
      if ((f & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) {
        const g = structureGroupAt(l, li & 31, lj & 31);
        group[c] = g;
        if (g !== 0 && (f & CellFlag.TOWER) !== 0) { dFloor[c] = -Y_INF; dCeil[c] = Y_INF; }
      }
    }
  }

  const dLo = new Float64Array(nn);
  for (let c = 0; c < nn; c++) dLo[c] = blockTop[c] > dFloor[c] ? blockTop[c] : dFloor[c];

  // ---- edges
  const nex = n * (n + 1);
  const exKind = new Uint8Array(nex), exA = new Int16Array(nex), exB = new Int16Array(nex), exSill = new Float64Array(nex);
  const exMatN = new Uint8Array(nex), exMatP = new Uint8Array(nex);
  const ezKind = new Uint8Array(nex), ezA = new Int16Array(nex), ezB = new Int16Array(nex), ezSill = new Float64Array(nex);
  const ezMatN = new Uint8Array(nex), ezMatP = new Uint8Array(nex);
  for (let hj = 0; hj < n; hj++) {
    const lj = hm0 + hj;
    for (let i = 0; i <= n; i++) {
      const I = hl0 + i;
      const e = hj * (n + 1) + i;
      const k = nb.exKind(I, lj);
      exKind[e] = k;
      if (k !== 0) { const h = nb.exH(I, lj); exA[e] = h[0]; exB[e] = h[1]; }
      exSill[e] = Math.max(nb.floorCm(I - 1, lj), nb.floorCm(I, lj)) / 100;
      const dcx = I < 0 ? -1 : I > CHUNK_CELLS ? 1 : 0;
      const l = layouts[((lj >> 5) + 1) * 3 + dcx + 1];
      const ei = exIdx(I - dcx * CHUNK_CELLS, lj & 31);
      exMatN[e] = l.ex.matNeg[ei]; exMatP[e] = l.ex.matPos[ei];
    }
  }
  for (let j = 0; j <= n; j++) {
    const J = hm0 + j;
    for (let hi = 0; hi < n; hi++) {
      const li = hl0 + hi;
      const e = j * n + hi;
      const k = nb.ezKind(li, J);
      ezKind[e] = k;
      if (k !== 0) { const h = nb.ezH(li, J); ezA[e] = h[0]; ezB[e] = h[1]; }
      ezSill[e] = Math.max(nb.floorCm(li, J - 1), nb.floorCm(li, J)) / 100;
      const dcz = J < 0 ? -1 : J > CHUNK_CELLS ? 1 : 0;
      const l = layouts[(dcz + 1) * 3 + (li >> 5) + 1];
      const ei = ezIdx(li & 31, J - dcz * CHUNK_CELLS);
      ezMatN[e] = l.ez.matNeg[ei]; ezMatP[e] = l.ez.matPos[ei];
    }
  }

  const exLo = new Float64Array(nex), exHi = new Float64Array(nex), exMode = new Uint8Array(nex);
  const ezLo = new Float64Array(nex), ezHi = new Float64Array(nex), ezMode = new Uint8Array(nex);
  for (let e = 0; e < nex; e++) {
    occInterval(exKind[e], exA[e], exB[e], exSill[e], e, exLo, exHi, exMode);
    occInterval(ezKind[e], ezA[e], ezB[e], ezSill[e], e, ezLo, ezHi, ezMode);
  }

  const nv = (n + 1) * (n + 1);
  const vLo = new Float64Array(nv).fill(-Infinity), vHi = new Float64Array(nv).fill(Infinity);
  const addPost = (v: number, lo: number, hi: number, mode: number): void => {
    const l = mode !== 0 ? Infinity : lo;
    if (l > vLo[v]) vLo[v] = l;
    if (hi < vHi[v]) vHi[v] = hi;
  };
  for (let hj = 0; hj < n; hj++) {
    for (let i = 0; i <= n; i++) { // ex edge on line x = i, row hj: vertices (i, hj) and (i, hj + 1)
      const e = hj * (n + 1) + i;
      if (exLo[e] === -Infinity && exHi[e] === Infinity && exMode[e] === 0) continue;
      addPost(hj * (n + 1) + i, exLo[e], exHi[e], exMode[e]);
      addPost((hj + 1) * (n + 1) + i, exLo[e], exHi[e], exMode[e]);
    }
  }
  for (let j = 0; j <= n; j++) {
    for (let hi = 0; hi < n; hi++) { // ez edge on line z = j, column hi: vertices (hi, j) and (hi + 1, j)
      const e = j * n + hi;
      if (ezLo[e] === -Infinity && ezHi[e] === Infinity && ezMode[e] === 0) continue;
      addPost(j * (n + 1) + hi, ezLo[e], ezHi[e], ezMode[e]);
      addPost(j * (n + 1) + hi + 1, ezLo[e], ezHi[e], ezMode[e]);
    }
  }

  // ---- occluders, contact footprints, leaks
  const bb: BoxBuild = { n: 0, box: new Float64Array(6 * 64), rampY: new Float64Array(3 * 64), group: new Int32Array(64), mat: new Int32Array(64), ramp: new Int32Array(64) };
  let contact = new Float64Array(4 * 32), contactY = new Float64Array(32), contactGroup = new Int32Array(32);
  let contactBox = new Int32Array(32);
  let nContact = 0;
  let leak = new Float64Array(4 * 8);
  let leakId = new Int32Array(8);
  let nLeak = 0;
  const lo = -0.5, hi = n + 0.5; // keep things overlapping the halo (small margin)
  const rb = new Float64Array(6);
  for (let slot = 0; slot < 9; slot++) {
    const l = layouts[slot];
    const offX = slotDcx(slot) * CHUNK_CELLS - hl0, offZ = slotDcz(slot) * CHUNK_CELLS - hm0;
    const hx = (x: number): number => offX + quant(x * INV_CELL);
    const hz = (z: number): number => offZ + quant(z * INV_CELL);
    for (const s of expandPeriodicSolids(l, PERIODIC_EXTRA_K)) {
      if ((s.flags & SolidFlag.OCCLUDE) === 0) continue;
      if (s.kind === 'box') {
        const x0 = hx(Math.min(s.min[0], s.max[0])), x1 = hx(Math.max(s.min[0], s.max[0]));
        const z0 = hz(Math.min(s.min[2], s.max[2])), z1 = hz(Math.max(s.min[2], s.max[2]));
        if (x1 < lo || x0 > hi || z1 < lo || z0 > hi || x1 <= x0 || z1 <= z0) continue;
        pushBox(bb, x0, Math.min(s.min[1], s.max[1]), z0, x1, Math.max(s.min[1], s.max[1]), z1, s.bakeGroup, s.mat, -1, 0, 0, 0);
      } else if (s.kind === 'ramp') {
        const x0 = hx(Math.min(s.x0, s.x1)), x1 = hx(Math.max(s.x0, s.x1));
        const z0 = hz(Math.min(s.z0, s.z1)), z1 = hz(Math.max(s.z0, s.z1));
        if (x1 < lo || x0 > hi || z1 < lo || z0 > hi || x1 <= x0 || z1 <= z0) continue;
        const thick = rampSlabThickness(s.y0, s.y1, s.steps);
        const ylo = Math.min(s.y0, s.y1) - thick, yhi = Math.max(s.y0, s.y1);
        pushBox(bb, x0, ylo, z0, x1, yhi, z1, s.bakeGroup, s.mat, s.dir, s.y0, s.y1, thick);
      }
    }
    for (const p of expandPeriodicProps(l)) {
      const def = PROP_DEFS[p.kind];
      if (!def) continue;
      if ((p.flags & PropFlag.CEILING) !== 0) continue; // mirrored ceiling furniture: no occluders, no contact
      const k = yawQuarter(p.yaw);
      const sc = p.scale > 0 ? p.scale : 1;
      const px = hx(p.x), pz = hz(p.z);
      const acx = Math.floor(px), acz = Math.floor(pz);
      const g = acx >= 0 && acz >= 0 && acx < n && acz < n ? group[acz * n + acx] : 0;
      const occ = def.occlude || (p.flags & SolidFlag.OCCLUDE) !== 0;
      const full: Box6 = [-def.size[0] / 2, 0, -def.size[2] / 2, def.size[0] / 2, def.size[1], def.size[2] / 2];
      let added = 0;
      const addPart = (b: Box6): void => {
        rotBox(b, k, sc, rb);
        const x0 = px + quant(rb[0] * INV_CELL), x1 = px + quant(rb[3] * INV_CELL);
        const z0 = pz + quant(rb[2] * INV_CELL), z1 = pz + quant(rb[5] * INV_CELL);
        if (x1 <= x0 || z1 <= z0) return;
        if (rb[1] <= CONTACT_GROUND) added = 1; // (also when outside the halo: contactBox must not depend on the halo frame)
        if (x1 < lo || x0 > hi || z1 < lo || z0 > hi) return;
        pushBox(bb, x0, p.y + rb[1], z0, x1, p.y + rb[4], z1, g, MAT_PROP, -1, 0, 0, 0);
      };
      const parts = propOccluders(p.kind, p.variant);
      if (parts) {
        for (const b of parts) addPart(b);
        const aligned = PROP_OCCLUDERS_ALIGNED[p.kind];
        if (aligned && quarterAligned(p.yaw)) for (const b of aligned) addPart(b);
      } else if (occ) addPart(full);
      if (def.collide || (p.flags & SolidFlag.COLLIDE) !== 0) {
        rotBox(full, k, sc, rb);
        const x0 = px + quant(rb[0] * INV_CELL), x1 = px + quant(rb[3] * INV_CELL);
        const z0 = pz + quant(rb[2] * INV_CELL), z1 = pz + quant(rb[5] * INV_CELL);
        if (x1 < lo || x0 > hi || z1 < lo || z0 > hi) continue;
        contact = growF64(contact, (nContact + 1) * 4);
        contactY = growF64(contactY, nContact + 1);
        contactGroup = growI32(contactGroup, nContact + 1);
        contactBox = growI32(contactBox, nContact + 1);
        contact[nContact * 4] = x0; contact[nContact * 4 + 1] = z0; contact[nContact * 4 + 2] = x1; contact[nContact * 4 + 3] = z1;
        contactY[nContact] = p.y; contactGroup[nContact] = g; contactBox[nContact] = added;
        nContact++;
      }
    }
    for (const lk of l.leaks) {
      const x = hx(lk.x), z = hz(lk.z);
      if (x < -2 || z < -2 || x > n + 2 || z > n + 2) continue;
      leak = growF64(leak, (nLeak + 1) * 4);
      leakId = growI32(leakId, nLeak + 1);
      leak[nLeak * 4] = x; leak[nLeak * 4 + 1] = lk.y; leak[nLeak * 4 + 2] = z; leak[nLeak * 4 + 3] = lk.strength;
      leakId[nLeak] = hash4(tile.cx + slotDcx(slot), tile.cz + slotDcz(slot), Math.round(lk.x * 1000), Math.round(lk.z * 1000)) | 0;
      nLeak++;
    }
  }

  mergeAbutting(bb);

  // ---- bucket boxes per cell (CSR)
  const nBox = bb.n;
  const boxStart = new Int32Array(nn + 1);
  const cellRange = (a: number, b: number): [number, number] => {
    const i0 = Math.max(0, Math.floor(a)), i1 = Math.min(n - 1, Math.ceil(b) - 1);
    return [i0, i1];
  };
  for (let b = 0; b < nBox; b++) {
    const [i0, i1] = cellRange(bb.box[b * 6], bb.box[b * 6 + 3]);
    const [j0, j1] = cellRange(bb.box[b * 6 + 2], bb.box[b * 6 + 5]);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) boxStart[j * n + i + 1]++;
  }
  for (let c = 0; c < nn; c++) boxStart[c + 1] += boxStart[c];
  const boxList = new Int32Array(boxStart[nn]);
  const fill = boxStart.slice(0, nn);
  for (let b = 0; b < nBox; b++) {
    const [i0, i1] = cellRange(bb.box[b * 6], bb.box[b * 6 + 3]);
    const [j0, j1] = cellRange(bb.box[b * 6 + 2], bb.box[b * 6 + 5]);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) boxList[fill[j * n + i]++] = b;
  }
  const cBoxLo = new Float64Array(nn).fill(Infinity), cBoxHi = new Float64Array(nn).fill(-Infinity);
  const ddaCell = new Float64Array(nn * 4), ddaGroup = new Int32Array(nn);
  for (let c = 0; c < nn; c++) {
    for (let k = boxStart[c]; k < boxStart[c + 1]; k++) {
      const b = boxList[k];
      if (bb.box[b * 6 + 1] < cBoxLo[c]) cBoxLo[c] = bb.box[b * 6 + 1];
      if (bb.box[b * 6 + 4] > cBoxHi[c]) cBoxHi[c] = bb.box[b * 6 + 4];
    }
    ddaCell[c * 4] = dLo[c] - DDA_EPS_Y; ddaCell[c * 4 + 1] = dCeil[c] + DDA_EPS_Y;
    ddaCell[c * 4 + 2] = cBoxLo[c]; ddaCell[c * 4 + 3] = cBoxHi[c];
    ddaGroup[c] = (flags[c] & CellFlag.SOLID) !== 0 ? -1 : group[c];
  }
  // contact footprints bucketed with a 0.3 m margin
  const cm = 0.3 * INV_CELL;
  const contactStart = new Int32Array(nn + 1);
  for (let b = 0; b < nContact; b++) {
    const [i0, i1] = cellRange(contact[b * 4] - cm, contact[b * 4 + 2] + cm);
    const [j0, j1] = cellRange(contact[b * 4 + 1] - cm, contact[b * 4 + 3] + cm);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) contactStart[j * n + i + 1]++;
  }
  for (let c = 0; c < nn; c++) contactStart[c + 1] += contactStart[c];
  const contactList = new Int32Array(contactStart[nn]);
  const cfill = contactStart.slice(0, nn);
  for (let b = 0; b < nContact; b++) {
    const [i0, i1] = cellRange(contact[b * 4] - cm, contact[b * 4 + 2] + cm);
    const [j0, j1] = cellRange(contact[b * 4 + 1] - cm, contact[b * 4 + 3] + cm);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) contactList[cfill[j * n + i]++] = b;
  }

  const boxRamp = new Int8Array(nBox), boxMat = new Uint8Array(nBox);
  for (let b = 0; b < nBox; b++) { boxRamp[b] = bb.ramp[b]; boxMat[b] = bb.mat[b]; }

  return {
    n, hl0, hm0, gi0: tile.cx * CHUNK_CELLS + hl0, gj0: tile.cz * CHUNK_CELLS + hm0, s: tile.s, cx: tile.cx, cz: tile.cz,
    flags, group, floor, ceil, dFloor, dCeil, blockTop, dLo, floorMat, ceilMat, wallMat, ceilKind, room, region, decay, humidity,
    slot: slotArr, local: localArr,
    exKind, exA, exB, exSill, exMatN, exMatP, ezKind, ezA, ezB, ezSill, ezMatN, ezMatP,
    exLo, exHi, exMode, ezLo, ezHi, ezMode, vLo, vHi,
    nBox, box: bb.box.slice(0, nBox * 6), boxGroup: bb.group.slice(0, nBox), boxMat, boxRamp, rampY: bb.rampY.slice(0, nBox * 3),
    boxStart, boxList, cBoxLo, cBoxHi, ddaCell, ddaGroup, boxStamp: new Int32Array(nBox), stamp: 0,
    nContact, contact: contact.slice(0, nContact * 4), contactY: contactY.slice(0, nContact), contactGroup: contactGroup.slice(0, nContact),
    contactBox: Uint8Array.from(contactBox.subarray(0, nContact)), contactStart, contactList,
    nLeak, leak: leak.slice(0, nLeak * 4), leakId: leakId.slice(0, nLeak),
  };
}

/**
 * Merge prop part boxes that abut exactly along x or z and have identical extents on the other two axes, in place:
 * the uprights of neighbouring racks in a row (two 8 cm C-channels touching on the rack pair line) become one box.
 * The union is the same solid, so every ray, probe and gather sees the same geometry with fewer boxes to test (a
 * warehouse rack row had 4 upright boxes per rack, now 2 per rack line). Ramps and non-prop boxes are left alone;
 * the result depends only on the set of boxes (chains merge in coordinate order).
 */
function mergeAbutting(bb: BoxBuild): void {
  const n = bb.n, B = bb.box;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) if (bb.mat[i] === MAT_PROP && bb.ramp[i] < 0) cand.push(i);
  if (cand.length < 2) return;
  const alive = new Uint8Array(n).fill(1);
  let merged = 0;
  for (let axis = 0; axis < 2; axis++) {
    const a0 = axis === 0 ? 0 : 2, a1 = a0 + 3, o0 = axis === 0 ? 2 : 0, o1 = o0 + 3; // merge along a, same o and y
    // (group, y0, y1, o0, o1) runs sorted by a0: a box abutting the previous one of its run extends it; only boxes
    // with a possible partner (an end coordinate equal to some box's start, or the reverse) are sorted
    const starts = new Set<number>(), ends = new Set<number>();
    for (const i of cand) if (alive[i] !== 0) { starts.add(B[i * 6 + a0]); ends.add(B[i * 6 + a1]); }
    const list = cand.filter((i) => alive[i] !== 0 && (starts.has(B[i * 6 + a1]) || ends.has(B[i * 6 + a0])));
    list.sort((p, q) => bb.group[p] - bb.group[q] || B[p * 6 + 1] - B[q * 6 + 1] || B[p * 6 + 4] - B[q * 6 + 4] ||
      B[p * 6 + o0] - B[q * 6 + o0] || B[p * 6 + o1] - B[q * 6 + o1] || B[p * 6 + a0] - B[q * 6 + a0] || p - q);
    let run = -1;
    for (const i of list) {
      if (run >= 0 && bb.group[i] === bb.group[run] && B[i * 6 + 1] === B[run * 6 + 1] && B[i * 6 + 4] === B[run * 6 + 4] &&
        B[i * 6 + o0] === B[run * 6 + o0] && B[i * 6 + o1] === B[run * 6 + o1] && B[i * 6 + a0] === B[run * 6 + a1]) {
        B[run * 6 + a1] = B[i * 6 + a1];
        alive[i] = 0;
        merged++;
      } else run = i;
    }
  }
  if (merged === 0) return;
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (alive[i] === 0) continue;
    if (w !== i) {
      for (let k = 0; k < 6; k++) B[w * 6 + k] = B[i * 6 + k];
      for (let k = 0; k < 3; k++) bb.rampY[w * 3 + k] = bb.rampY[i * 3 + k];
      bb.group[w] = bb.group[i]; bb.mat[w] = bb.mat[i]; bb.ramp[w] = bb.ramp[i];
    }
    w++;
  }
  bb.n = w;
}

/** Occlusion interval of one edge (see VisGrid.exLo): equivalent to core/edges.ts edgeOccludesAt. */
function occInterval(kind: number, hA: number, hB: number, sill: number, e: number, lo: Float64Array, hi: Float64Array, mode: Uint8Array): void {
  const a = hA / 100, b = hB / 100;
  let l = -Infinity, h = Infinity, m = 0;
  if (EDGE_OCCLUDES[kind]) {
    switch (kind) {
      case EdgeKind.WALL: case EdgeKind.GLITCH: l = Infinity; break;
      case EdgeKind.DOORWAY: l = sill; h = a; m = 1; break;
      case EdgeKind.HEADER: l = sill; h = a; break;
      case EdgeKind.ARCH: l = sill; m = 2; break;
      case EdgeKind.PARTITION: case EdgeKind.HALF: case EdgeKind.RAIL: l = a; break;
      case EdgeKind.WINDOW: l = a > sill ? a : sill; h = b; break;
      default: m = 2; break; // unknown occluding kind: exact test
    }
  }
  lo[e] = l; hi[e] = h; mode[e] = m;
}

/**
 * Occluder slab below a ramp's walking line h(s) (y0 -> y1 linear). It must stay ABOVE the WP5 soffit
 * (src/mesh/stairs.ts: nose(s) - off with nose(s) - h(s) = rise * (1 - s / L), off = max(0.15, rise + 0.03) for
 * n > 1 risers, 0.15 otherwise): the former 0.3 m slab swallowed the soffit
 * samples (insideBox -> invalid texels -> pure black stair undersides). The slab only needs to be crossed by rays
 * (dda.ts tests a sign change of y - h), so a few centimetres suffice.
 */
export function rampSlabThickness(y0: number, y1: number, steps: number): number {
  const n = Math.max(0, Math.round(steps));
  const rise = n > 0 ? Math.abs(y1 - y0) / n : 0;
  const gap = n > 1 ? Math.max(0.15, rise + 0.03) - rise : 0.15; // min over s of h(s) - soffit(s)
  return Math.max(0.005, gap - 0.005); // the soffit samples sit a further SURF_OFF below the soffit
}

/** Effective floor of a cell for sample heights (blocker top if any). */
export const effFloor = (g: VisGrid, c: number): number => (g.blockTop[c] > g.floor[c] ? g.blockTop[c] : g.floor[c]);

/** Is (x, y, z) (halo units / m) strictly inside an occluder box of `group` bucketed in cell c? */
export function insideBox(g: VisGrid, c: number, x: number, y: number, z: number, group: number): boolean {
  for (let k = g.boxStart[c], e = g.boxStart[c + 1]; k < e; k++) {
    const b = g.boxList[k];
    if (g.boxGroup[b] !== group) continue;
    const o = b * 6;
    if (x <= g.box[o] || x >= g.box[o + 3] || z <= g.box[o + 2] || z >= g.box[o + 5]) continue;
    const r = g.boxRamp[b];
    if (r < 0) {
      if (y > g.box[o + 1] && y < g.box[o + 4]) return true;
    } else {
      const h = rampHeight(g, b, x, z);
      if (y < h && y > h - g.rampY[b * 3 + 2]) return true;
    }
  }
  return false;
}

/** Height of a ramp's walking surface at (x, z) (halo units). */
export function rampHeight(g: VisGrid, b: number, x: number, z: number): number {
  const o = b * 6;
  const r = g.boxRamp[b];
  const y0 = g.rampY[b * 3], y1 = g.rampY[b * 3 + 1];
  let s: number;
  if (r === 0) s = (x - g.box[o]) / (g.box[o + 3] - g.box[o]);
  else if (r === 1) s = (g.box[o + 3] - x) / (g.box[o + 3] - g.box[o]);
  else if (r === 2) s = (z - g.box[o + 2]) / (g.box[o + 5] - g.box[o + 2]);
  else s = (g.box[o + 5] - z) / (g.box[o + 5] - g.box[o + 2]);
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return y0 + (y1 - y0) * s;
}

export const CELL_M = CELL;
