// src/world/content/decals.ts — field-driven decal placement (WP4).
//
// rng = rngFor(seed, SALT.DECAL, s, cx, cz); at most 60 decals per chunk, in priority order:
//   leaks (WATER_STAIN + a smaller darker splash stain under them; damp stains under other DRIP emitters) > BURN near SPARKING sites > RUST_STREAK (below pipes, on METAL_PAINTED
//   walls) > OIL / DRAIN (PARKING, WAREHOUSE) > POSTER / PAPER (OFFICE) > WATER_STAIN / MOLD at wall bases (humidity)
//   > SCUFF (decay; plus low scuffs beside door jambs) > CRACK (concrete, decay) > HANDPRINT (rare, decay > 0.6).
// Nothing is placed on seam edges (both chunks store them), TOWER or ELEVATOR cells. Wall decals sit on the face
// (edge line +- thickness/2) with +v = +Y (rot 0). Runs last in the pipeline so it can react to leaks, pipes, props.
// A REPEATED_ROOM pairing (anomalies.ts) finally makes room B's decals identical to room A's.

import { CELL, CHUNK_SIZE, PARTITION_T, WALL_T } from '../../core/constants.ts';
import { AnomalyKind, CellFlag, DecalKind, EdgeKind, EmitterKind, LandmarkKind, Mat, PropKind, SALT, Zone, cellIdx, exIdx, ezIdx, rngFor, worldToCell } from '../../core/index.ts';
import type { ChunkLayout, DecalPlacement, Rng, ZoneGenContext } from '../../core/index.ts';
import { repeatedRoomOf } from './anomalies.ts';
import { DX, DZ, edgeKindPassable, inChunk, isOpenFloor, isSeamSide, N, sideEdge, sideHA, sideKind } from './util.ts';

export const DECAL_MAX = 60;

interface Face { li: number; lj: number; d: number; kind: number; mat: number; x: number; z: number; nx: number; nz: number; floor: number; top: number }

/** Wall faces looking into open floor cells (not seams, not TOWER/ELEVATOR cells). */
export function wallFaces(l: ChunkLayout): Face[] {
  const out: Face[] = [];
  for (let c = 0; c < N * N; c++) {
    if (!isOpenFloor(l, c)) continue;
    const li = c & 31, lj = c >> 5;
    for (let d = 0; d < 4; d++) {
      if (isSeamSide(li, lj, d)) continue;
      const e = sideEdge(li, lj, d);
      const eg = e.axis === 'x' ? l.ex : l.ez;
      const kind = eg.kind[e.k];
      if (kind !== EdgeKind.WALL && kind !== EdgeKind.PARTITION && kind !== EdgeKind.HALF) continue;
      const other = cellIdx(li + DX[d], lj + DZ[d]);
      if (inChunk(li + DX[d], lj + DZ[d]) && (l.flags[other] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) continue;
      const mat = d === 0 || d === 2 ? eg.matNeg[e.k] : eg.matPos[e.k];
      const off = (kind === EdgeKind.PARTITION ? PARTITION_T : WALL_T) / 2;
      const x = (li + 0.5) * CELL + DX[d] * (CELL / 2 - off), z = (lj + 0.5) * CELL + DZ[d] * (CELL / 2 - off);
      const floor = l.floorCm[c] / 100;
      const top = kind === EdgeKind.WALL ? l.ceilCm[c] / 100 : eg.hA[e.k] / 100;
      out.push({ li, lj, d, kind, mat, x, z, nx: -DX[d], nz: -DZ[d], floor, top });
    }
  }
  return out;
}

class Budget {
  n = 0;
  readonly g: ZoneGenContext['grid'];
  constructor(g: ZoneGenContext['grid']) { this.g = g; }
  get full(): boolean { return this.n >= DECAL_MAX; }
  add(d: DecalPlacement, cat: { left: number }): boolean {
    if (this.full || cat.left <= 0) return false;
    this.g.addDecal(d); this.n++; cat.left--;
    return true;
  }
}

function floorDecal(kind: number, x: number, y: number, z: number, w: number, h: number, rot: number, alpha: number): DecalPlacement {
  return { kind, sign: false, px: x, py: y, pz: z, nx: 0, ny: 1, nz: 0, rot, w, h, alpha };
}
function wallDecal(kind: number, f: Face, t: number, y: number, w: number, h: number, alpha: number, rot = 0): DecalPlacement {
  // t in [-0.5, 0.5]: position along the face
  const along = t * (CELL - w - 0.1);
  const x = f.x + (f.d >= 2 ? along : 0), z = f.z + (f.d < 2 ? along : 0);
  return { kind, sign: false, px: x, py: y, pz: z, nx: f.nx, ny: 0, nz: f.nz, rot, w, h, alpha };
}
const fits = (f: Face, y: number, h: number): boolean => y - h / 2 >= f.floor - 0.001 && y + h / 2 <= f.top - 0.02;

/** A floor decal of size w x h (any rot) stays inside the chunk and on open floor. */
function floorOk(l: ChunkLayout, x: number, z: number, r: number): boolean {
  if (x - r < 0.01 || z - r < 0.01 || x + r > CHUNK_SIZE - 0.01 || z + r > CHUNK_SIZE - 0.01) return false;
  const c = cellIdx(worldToCell(x), worldToCell(z));
  return isOpenFloor(l, c);
}

export function placeDecals(ctx: ZoneGenContext): void {
  const g = ctx.grid, l = g.layout, { s, cx, cz } = ctx.key;
  const rng: Rng = rngFor(ctx.seed, SALT.DECAL, s, cx, cz);
  const B = new Budget(g);
  const faces = wallFaces(l);
  const zoneOf = (c: number): number => l.cellZone[c];

  // 1. under leaks
  const catLeak = { left: 12 };
  for (const lk of l.leaks) {
    const li = worldToCell(lk.x), lj = worldToCell(lk.z);
    if (!inChunk(li, lj)) continue;
    const c = cellIdx(li, lj);
    if (!isOpenFloor(l, c)) continue;
    const y = l.floorCm[c] / 100;
    const sz = 0.6 + 0.8 * lk.strength;
    if (floorOk(l, lk.x, lk.z, sz * 0.72)) B.add(floorDecal(DecalKind.WATER_STAIN, lk.x, y, lk.z, sz, sz, rng.range(0, 6.28), 0.45 + 0.35 * lk.strength), catLeak);
    // splash ring right under the drip (a DRIP decal is a wall drip-run: never on floors)
    if (floorOk(l, lk.x, lk.z, 0.3)) B.add(floorDecal(DecalKind.WATER_STAIN, lk.x, y, lk.z, 0.4, 0.36, rng.range(0, 6.28), 0.85), catLeak);
  }
  // damp stains under the other drip emitters (vignettes, programs, landmarks) that have no leak above them
  for (const em of l.emitters) {
    if (em.kind !== EmitterKind.DRIP) continue;
    if (l.leaks.some((lk) => Math.abs(lk.x - em.x) < 0.6 && Math.abs(lk.z - em.z) < 0.6)) continue;
    const li = worldToCell(em.x), lj = worldToCell(em.z);
    if (!inChunk(li, lj)) continue;
    const c = cellIdx(li, lj);
    if (!isOpenFloor(l, c)) continue;
    const sz = rng.range(0.5, 0.85);
    if (floorOk(l, em.x, em.z, sz * 0.72)) B.add(floorDecal(DecalKind.WATER_STAIN, em.x, l.floorCm[c] / 100, em.z, sz, sz * rng.range(0.8, 1.0), rng.range(0, 6.28), 0.6), catLeak);
  }

  // 1b. FLOODED_HALL: puddles spreading out of every opening onto the dry floor outside (the landmark cannot place
  // them: it is stamped before the zone builds the outside floor)
  const catSpill = { left: 6 };
  for (const lmk of l.landmarks) {
    if (lmk.kind !== LandmarkKind.FLOODED_HALL) continue;
    for (let lj = lmk.j0; lj < lmk.j1; lj++) {
      for (let li = lmk.i0; li < lmk.i1; li++) {
        for (let d = 0; d < 4; d++) {
          const oi = li + DX[d], oj = lj + DZ[d];
          if (!inChunk(oi, oj) || (oi >= lmk.i0 && oi < lmk.i1 && oj >= lmk.j0 && oj < lmk.j1)) continue;
          if (!edgeKindPassable(sideKind(l, li, lj, d), sideHA(l, li, lj, d))) continue;
          const oc = cellIdx(oi, oj);
          if (!isOpenFloor(l, oc)) continue;
          const x = (li + 0.5) * CELL + DX[d] * (CELL / 2 + 0.5), z = (lj + 0.5) * CELL + DZ[d] * (CELL / 2 + 0.5);
          if (!floorOk(l, x, z, 0.5)) continue;
          if (B.add(floorDecal(DecalKind.WATER_STAIN, x, l.floorCm[oc] / 100, z, 1.0, 0.8, rng.range(0, 6.28), 0.55), catSpill)) {
            g.setCells(oi, oj, oi + 1, oj + 1, { flagsSet: CellFlag.WET });
          }
        }
      }
    }
  }

  // 2. BURN near SPARKING sites
  const catBurn = { left: 4 };
  for (const a of l.anomalies) {
    if (a.kind !== AnomalyKind.SPARKING) continue;
    const li = worldToCell(a.x), lj = worldToCell(a.z);
    if (!inChunk(li, lj)) continue;
    const c = cellIdx(li, lj);
    if (!isOpenFloor(l, c)) continue;
    const x = a.x + rng.range(-0.2, 0.2), z = a.z + rng.range(-0.2, 0.2);
    if (floorOk(l, x, z, 0.5)) B.add(floorDecal(DecalKind.BURN, x, l.floorCm[c] / 100, z, 0.7, 0.7, rng.range(0, 6.28), 0.7), catBurn);
  }

  // 3. RUST_STREAK below pipes and on METAL_PAINTED walls
  const catRust = { left: 8 };
  for (const sd of l.solids) {
    if (sd.kind !== 'pipe' || B.full) continue;
    const ax = sd.b[0] - sd.a[0], az = sd.b[2] - sd.a[2];
    const len = Math.sqrt(ax * ax + az * az);
    if (len < 0.5) continue;
    for (let t = 1.2; t < len; t += 2.4) {
      if (!rng.chance(0.35)) continue;
      const px = sd.a[0] + (ax * t) / len, pz = sd.a[2] + (az * t) / len, py = sd.a[1] + ((sd.b[1] - sd.a[1]) * t) / len;
      let best: Face | null = null, bd = 0.45 * 0.45;
      for (const f of faces) {
        const d2 = (f.x - px) * (f.x - px) + (f.z - pz) * (f.z - pz);
        if (d2 < bd) { bd = d2; best = f; }
      }
      if (!best) continue;
      const h = Math.min(1.2, py - sd.r - best.floor - 0.1);
      const y = py - sd.r - h / 2;
      const ax0 = (best.d >= 2 ? best.li : best.lj) * CELL + 0.25, ax1 = ax0 + CELL - 0.5;
      const along = Math.min(ax1, Math.max(ax0, best.d >= 2 ? px : pz));
      if (h > 0.3 && fits(best, y, h)) B.add({ ...wallDecal(DecalKind.RUST_STREAK, best, 0, y, 0.35, h, 0.75), px: best.d >= 2 ? along : best.x, pz: best.d < 2 ? along : best.z }, catRust);
    }
  }
  for (const f of faces) {
    if (f.mat !== Mat.METAL_PAINTED || B.full || !rng.chance(0.15)) continue;
    const h = Math.min(1.4, f.top - f.floor - 0.4);
    const y = f.top - 0.15 - h / 2;
    if (h > 0.4 && fits(f, y, h)) B.add(wallDecal(DecalKind.RUST_STREAK, f, rng.range(-0.5, 0.5), y, 0.3, h, 0.65), catRust);
  }

  // 4. PARKING / WAREHOUSE: OIL under stalls and rack aisles, DRAIN every ~12 m on concrete floors
  const catOil = { left: 10 };
  const industrial = (z: number): boolean => z === Zone.PARKING || z === Zone.WAREHOUSE;
  if (industrial(ctx.district.zone)) {
    for (const p of l.props) {
      if (B.full) break;
      const stall = p.kind === PropKind.WHEEL_STOP, rack = p.kind === PropKind.SHELF_RACK;
      if (!stall && !rack) continue;
      if (!rng.chance(stall ? 0.7 : 0.15)) continue;
      // in front of the wheel stop (where the engine sits) / in the aisle in front of the rack
      const fwd = stall ? 1.5 : 1.15;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const x = p.x + fx * fwd + rng.range(-0.3, 0.3), z = p.z + fz * fwd + rng.range(-0.3, 0.3);
      const li = worldToCell(x), lj = worldToCell(z);
      if (!inChunk(li, lj) || !industrial(zoneOf(cellIdx(li, lj)))) continue;
      if (floorOk(l, x, z, 0.6)) B.add(floorDecal(DecalKind.OIL, x, l.floorCm[cellIdx(li, lj)] / 100, z, rng.range(0.6, 1.1), rng.range(0.5, 0.9), rng.range(0, 6.28), 0.75), catOil);
    }
    // global ~12 m drain lattice (10 cells), hashed offset per lattice cell
    for (let gz = Math.floor(g.gj0 / 10); gz <= Math.floor((g.gj0 + N - 1) / 10); gz++) {
      for (let gx = Math.floor(g.gi0 / 10); gx <= Math.floor((g.gi0 + N - 1) / 10); gx++) {
        const r = rngFor(ctx.seed, SALT.DECAL, s, gx, gz, 77);
        const li = gx * 10 + r.int(2, 7) - g.gi0, lj = gz * 10 + r.int(2, 7) - g.gj0;
        if (!inChunk(li, lj)) continue;
        const c = cellIdx(li, lj);
        if (l.floorMat[c] !== Mat.CONCRETE_FLOOR || !isOpenFloor(l, c)) continue;
        const [x, z] = g.cellCenter(li, lj);
        B.add(floorDecal(DecalKind.DRAIN, x, l.floorCm[c] / 100, z, 0.45, 0.45, 0, 0.95), catOil);
      }
    }
  }

  // 5. OFFICE: POSTER on DRYWALL wall runs (p 0.1 per run), PAPER near desks
  const catOffice = { left: 8 };
  if (ctx.district.zone === Zone.OFFICE) {
    // runs: consecutive faces on the same line/side with DRYWALL
    const sorted = faces.filter((f) => f.kind === EdgeKind.WALL && f.mat === Mat.DRYWALL)
      .sort((a, b) => a.d - b.d || (a.d < 2 ? a.li - b.li || a.lj - b.lj : a.lj - b.lj || a.li - b.li));
    let run: Face[] = [];
    const flush = (): void => {
      if (run.length >= 2 && rng.chance(0.1)) {
        const f = run[rng.int(0, run.length - 1)];
        const y = f.floor + 1.5;
        if (fits(f, y, 0.8)) B.add(wallDecal(DecalKind.POSTER, f, rng.range(-0.3, 0.3), y, 0.55, 0.78, 0.95, rng.range(-0.04, 0.04)), catOffice);
      }
      run = [];
    };
    for (const f of sorted) {
      const prev = run[run.length - 1];
      const cont = prev && prev.d === f.d && (f.d < 2 ? prev.li === f.li && prev.lj + 1 === f.lj : prev.lj === f.lj && prev.li + 1 === f.li);
      if (!cont) flush();
      run.push(f);
    }
    flush();
    for (const p of l.props) {
      if (p.kind !== PropKind.DESK || B.full || !rng.chance(0.35)) continue;
      const n = rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const x = p.x + rng.range(-1.1, 1.1), z = p.z + rng.range(-1.1, 1.1);
        if (floorOk(l, x, z, 0.25)) B.add(floorDecal(DecalKind.PAPER, x, l.floorCm[cellIdx(worldToCell(x), worldToCell(z))] / 100, z, 0.3, 0.4, rng.range(0, 6.28), 0.9), catOffice);
      }
    }
  }

  // 6. humidity: WATER_STAIN bands standing on the floor at wall bases (> 0.5; the mesher crops the stain to a
  // flat-bottomed band), MOLD (> 0.75)
  const catDamp = { left: 12 };
  for (const f of faces) {
    if (B.full) break;
    const hum = l.humidity[cellIdx(f.li, f.lj)] / 256;
    if (hum > 0.5 && rng.chance((hum - 0.5) * 0.6)) {
      const h = rng.range(0.25, 0.6);
      if (fits(f, f.floor + h / 2, h)) B.add(wallDecal(DecalKind.WATER_STAIN, f, rng.range(-0.5, 0.5), f.floor + h / 2, rng.range(0.85, 1.1), h, rng.range(0.55, 0.8)), catDamp);
    }
    if (hum > 0.75 && rng.chance((hum - 0.75) * 0.8)) {
      const h = rng.range(0.4, 0.8);
      if (fits(f, f.floor + h / 2 + 0.05, h)) B.add(wallDecal(DecalKind.MOLD, f, rng.range(-0.5, 0.5), f.floor + h / 2 + 0.05, rng.range(0.5, 0.9), h, 0.7), catDamp);
    }
  }

  // 7. decay: SCUFF on walls at 0.1-0.9 m, and low scuffs beside door jambs (carts, shoes, door swings)
  const catScuff = { left: 14 };
  for (const f of faces) {
    if (B.full) break;
    const dec = l.decay[cellIdx(f.li, f.lj)] / 256;
    // jambs: the along-line neighbour of this face is a doorway
    const ai = f.d < 2 ? 0 : 1, aj = f.d < 2 ? 1 : 0;
    for (const sgn of [-1, 1]) {
      const ni = f.li + sgn * ai, nj = f.lj + sgn * aj;
      if (!inChunk(ni, nj) || sideKind(l, ni, nj, f.d) !== EdgeKind.DOORWAY || !rng.chance(0.2 + 0.4 * dec)) continue;
      const w = rng.range(0.3, 0.45), h = rng.range(0.15, 0.3), y = f.floor + rng.range(0.1, 0.4) + h / 2;
      if (fits(f, y, h)) B.add(wallDecal(DecalKind.SCUFF, f, sgn * 0.5, y, w, h, rng.range(0.45, 0.7)), catScuff);
    }
    if (!rng.chance(0.2 * dec)) continue;
    const h = 0.3, y = f.floor + rng.range(0.1 + h / 2, 0.9 - h / 2);
    if (fits(f, y, h)) B.add(wallDecal(DecalKind.SCUFF, f, rng.range(-0.5, 0.5), y, rng.range(0.4, 0.9), h, 0.55), catScuff);
  }

  // 8. CRACK on concrete floors and walls
  const catCrack = { left: 8 };
  for (let c = 0; c < N * N && !B.full; c++) {
    if (!isOpenFloor(l, c) || l.floorMat[c] !== Mat.CONCRETE_FLOOR) continue;
    if (!rng.chance(0.04 * (l.decay[c] / 256))) continue;
    const [x, z] = g.cellCenter(c & 31, c >> 5);
    if (floorOk(l, x, z, 0.6)) B.add(floorDecal(DecalKind.CRACK, x + rng.range(-0.2, 0.2), l.floorCm[c] / 100, z + rng.range(-0.2, 0.2), 1.0, 1.0, rng.range(0, 6.28), 0.7), catCrack);
  }
  for (const f of faces) {
    if (B.full) break;
    if (f.mat !== Mat.CONCRETE_WALL && f.mat !== Mat.CMU_PAINTED) continue;
    if (!rng.chance(0.05 * (l.decay[cellIdx(f.li, f.lj)] / 256))) continue;
    const h = rng.range(0.8, 1.3), y = f.floor + rng.range(0.4, 1.4) + h / 2;
    if (fits(f, y, h)) B.add(wallDecal(DecalKind.CRACK, f, rng.range(-0.5, 0.5), y, 0.7, h, 0.65, rng.range(-0.3, 0.3)), catCrack);
  }

  // 9. HANDPRINT: rare, per 8x8 window with mean decay > 0.6
  const catHand = { left: 2 };
  for (let wj = 0; wj < 4; wj++) for (let wi = 0; wi < 4; wi++) {
    let sum = 0, n = 0;
    for (let lj = wj * 8; lj < wj * 8 + 8; lj++) for (let li = wi * 8; li < wi * 8 + 8; li++) { sum += l.decay[cellIdx(li, lj)]; n++; }
    if (sum / n / 256 <= 0.6 || !rng.chance(0.02)) continue;
    const inWin = faces.filter((f) => f.li >> 3 === wi && f.lj >> 3 === wj && f.kind === EdgeKind.WALL);
    if (inWin.length === 0) continue;
    const f = inWin[rng.int(0, inWin.length - 1)];
    const y = f.floor + rng.range(1.1, 1.5);
    if (fits(f, y, 0.3)) B.add(wallDecal(DecalKind.HANDPRINT, f, rng.range(-0.4, 0.4), y, 0.25, 0.3, 0.8, rng.range(-0.4, 0.4)), catHand);
  }

  // REPEATED_ROOM: room B's decals become room A's (translated)
  const pair = repeatedRoomOf(l);
  if (pair) {
    const { a, b } = pair;
    const inR = (r: typeof a, x: number, z: number): boolean => x >= r.i0 * CELL && x < r.i1 * CELL && z >= r.j0 * CELL && z < r.j1 * CELL;
    const dx = (b.i0 - a.i0) * CELL, dz = (b.j0 - a.j0) * CELL;
    const src = l.decals.filter((d) => inR(a, d.px, d.pz));
    const keep = l.decals.filter((d) => !inR(b, d.px, d.pz));
    // the copies replace B's decals; never exceed this pass's DECAL_MAX in total
    let room = DECAL_MAX - B.n + (l.decals.length - keep.length);
    l.decals.length = 0;
    for (const d of keep) l.decals.push(d);
    for (const d of src) {
      if (room <= 0) break;
      // wall decals only where B has the same wall
      if (Math.abs(d.ny) < 0.5) {
        const li = worldToCell(d.px + dx - d.nx * 0.2), lj = worldToCell(d.pz + dz - d.nz * 0.2);
        const dir = d.nx < -0.5 ? 0 : d.nx > 0.5 ? 1 : d.nz < -0.5 ? 2 : 3;
        if (!inChunk(li, lj)) continue;
        const e = sideEdge(li, lj, dir);
        const k = e.axis === 'x' ? l.ex.kind[exIdx(e.i, e.j)] : l.ez.kind[ezIdx(e.i, e.j)];
        if (k !== EdgeKind.WALL && k !== EdgeKind.PARTITION && k !== EdgeKind.HALF) continue;
      }
      g.addDecal({ ...d, px: d.px + dx, pz: d.pz + dz });
      room--;
    }
  }
}
