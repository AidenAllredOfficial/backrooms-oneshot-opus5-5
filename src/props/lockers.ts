// src/props/lockers.ts — locker banks dressed onto tall METAL_PAINTED PARTITION edges (LOCKER_ROOM, WP4 stamps its
// banks as PARTITION edges 2 m high). The shell (WP5) draws the thin partition slab; this adds, per edge and per
// open side, a row of three steel lockers in front of it: recessed kick base, painted doors (one or two tiers per
// bank) with pressed louvres, lift handles, numbered plates, 8 mm door gaps, a few dented doors, a few doors ajar
// (dark interior with a shelf), bank-end panels and a top cap that covers the slab. Emitted into the tile props
// mesh by tileProps.ts. Pure module (no three/DOM).
//
// Edge frame: X along the edge (0..CELL), Y up (storey-relative metres), Z across it (the partition centre plane is
// z = 0; each side is built for +Z and mirrored for -Z).

import { CELL, PARTITION_T, WALL_T } from '../core/constants.ts';
import { CellFlag, EdgeKind, LandmarkKind, Mat } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { hash4, hash5 } from '../core/rng.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import type { GeometryWriter } from '../core/writer.ts';
import { PartBuilder, rnd } from './builder.ts';
import { bevelBox, box, heightGrid, rect, SKIP } from './primitives.ts';

type RGB = readonly [number, number, number];

/** Minimum partition height above the floor that reads as a locker bank (restroom stalls are 150 cm). */
export const LOCKER_MIN_CM = 180;
const T0 = PARTITION_T / 2; // partition face
const D = 0.2; // carcass front (door back plane)
const DT = 0.015; // door thickness
const FRONT = D + DT; // door front plane
const KICK = 0.1; // kick base height
const COLS = 3; // lockers per 1.2 m edge
const GAP = 0.004; // half door gap
const CAP = 0.012; // top cap thickness
// WP5 stands a WALL_T x WALL_T post on a partition's free end (up to its top): the bank-end panel encloses it
const END = WALL_T / 2 + 0.01;

// institutional paints (linear albedo): green, grey-blue, olive grey, teal, faded blue
const PAINTS: readonly RGB[] = [[0.1, 0.19, 0.12], [0.11, 0.15, 0.21], [0.15, 0.17, 0.11], [0.07, 0.17, 0.17], [0.08, 0.13, 0.26]];
const DARK: RGB = [0.018, 0.018, 0.02];
const INSIDE: RGB = [0.05, 0.05, 0.05];

// seven-segment masks (a b c d e f g = bits 0..6)
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

const B = new PartBuilder();

/** True if (kind, hA, mats) above floor `floorCm` is a locker-bank partition. */
export const isLockerEdge = (kind: number, hA: number, matNeg: number, matPos: number, floorCm: number): boolean =>
  kind === EdgeKind.PARTITION && matNeg === Mat.METAL_PAINTED && matPos === Mat.METAL_PAINTED && hA - floorCm >= LOCKER_MIN_CM;

interface Style { paint: RGB; tiers: number; numBase: number }

/** Room paint + tier count: from the LOCKER_ROOM landmark containing the cell (global rect => identical in every
 * chunk the room spans), else from the bank line. */
function styleOf(l: ChunkLayout, s: number, cx: number, cz: number, li: number, lj: number, line: number): Style {
  let h = hash4(s, 0x10c4e5, line, 77);
  for (const m of l.landmarks) {
    if (m.kind !== LandmarkKind.LOCKER_ROOM || li < m.i0 - 1 || li > m.i1 || lj < m.j0 - 1 || lj > m.j1) continue;
    h = hash4(s, 0x10c4e5, cx * 32 + m.i0, cz * 32 + m.j0);
    break;
  }
  const paint = PAINTS[(h >>> 3) % PAINTS.length];
  const tiers = (hash4(h, line, 3, 9) >>> 5) % 3 === 0 ? 1 : 2; // most banks two-tier
  return { paint, tiers, numBase: 100 * (1 + ((hash4(h, line, 5, 1) >>> 7) % 8)) };
}

const paintMat = (c: RGB, k: number, rough = 0.38): void => B.mat(Mat.METAL_PAINTED, c[0] * k, c[1] * k, c[2] * k, 0, rough);

/** 1..3 seven-segment digits centred at (cx, cy) on the plane z (facing +Z). */
function digits(n: number, cx: number, cy: number, z: number): void {
  const str = String(n);
  const dw = 0.0085, dh = 0.015, t = 0.0021, pitch = 0.0125;
  let x0 = cx - ((str.length - 1) * pitch) / 2;
  for (const ch of str) {
    const m = SEG[ch.charCodeAt(0) - 48] ?? 0;
    const hx = dw / 2, hy = dh / 2;
    const H = (y: number): void => rect(B, x0, cy + y, z, hx - t / 2, 0, 0, 0, t / 2, 0, 0, 0, 1);
    const V = (x: number, y: number): void => rect(B, x0 + x, cy + y, z, t / 2, 0, 0, 0, hy / 2, 0, 0, 0, 1);
    if (m & 1) H(hy);
    if (m & 2) V(hx, hy / 2);
    if (m & 4) V(hx, -hy / 2);
    if (m & 8) H(-hy);
    if (m & 16) V(-hx, -hy / 2);
    if (m & 32) V(-hx, hy / 2);
    if (m & 64) H(0);
    x0 += pitch;
  }
}

/** One door (hinge on its -X edge) in the door-local frame: x 0..w, y 0..h, back at z = 0, front at z = DT. */
function door(w: number, h: number, paint: RGB, tone: number, dent: number, seed: number, louvres: number, lowLouvres: number, num: number, lock: boolean): void {
  paintMat(paint, tone);
  // UVs are part-local metres: shift each door's sheet by a random texture offset (geometry unchanged) so the
  // paint's scratches / rust spots do not repeat at the same place on every door
  const ou = 1.2 * rnd(seed, 11), ov = 1.2 * rnd(seed, 12);
  B.push();
  B.translate(-ou, -ov, 0);
  if (dent > 0) {
    // front face as a sheet with a shallow dent (the shading carries it); bevelled rim on the other faces
    bevelBox(B, ou, ov, 0, ou + w, ov + h, DT, 0.004, SKIP.NZ | SKIP.PZ);
    const dx = 0.1 + (w - 0.2) * rnd(seed, 1), dy = 0.2 + (h - 0.4) * rnd(seed, 2), r = 0.07 + 0.05 * rnd(seed, 3);
    const nx = 4, ny = 8;
    B.translate(ou, ov + h, DT);
    B.rotX(Math.PI / 2); // grid (x, height, z) -> (x, -z, +height): height is the outward offset
    B.translate(-ou, 0, -ov);
    heightGrid(B, nx, ny, (i) => ou + (w * i) / nx, (i, j) => {
      if (i === 0 || j === 0 || i === nx || j === ny) return 0;
      const px = (w * i) / nx - dx, py = h - (h * j) / ny - dy;
      return -dent * Math.exp(-(px * px + py * py) / (r * r));
    }, (_i, j) => ov + (h * j) / ny, null);
  } else {
    bevelBox(B, ou, ov, 0, ou + w, ov + h, DT, 0.004, SKIP.NZ);
  }
  B.pop();
  // pressed louvres: a dark slot under a proud lip
  const lv = (y: number): void => {
    B.mat(Mat.METAL_PAINTED, DARK[0], DARK[1], DARK[2], 0, 0.6);
    rect(B, w / 2, y, DT + 0.0008, 0.09, 0, 0, 0, 0.0045, 0, 0, 0, 1);
    paintMat(paint, tone * 1.06);
    box(B, w / 2 - 0.095, y + 0.0045, DT, w / 2 + 0.095, y + 0.011, DT + 0.005, SKIP.NZ | SKIP.NX | SKIP.PX);
  };
  for (let k = 0; k < louvres; k++) lv(h - 0.07 - k * 0.028);
  for (let k = 0; k < lowLouvres; k++) lv(0.06 + k * 0.028);
  // number plate (aluminium, dark digits) above the louvres
  const py = h - 0.035;
  B.mat(Mat.METAL_PAINTED, 0.45, 0.45, 0.43, 0, 0.3);
  box(B, w / 2 - 0.028, py - 0.012, DT, w / 2 + 0.028, py + 0.012, DT + 0.002, SKIP.NZ);
  B.mat(Mat.METAL_PAINTED, DARK[0], DARK[1], DARK[2], 0, 0.5);
  digits(num, w / 2, py, DT + 0.0026);
  // lift handle on the latch side (+X) with a recess plate
  const hy = h > 1.2 ? 0.9 : h * 0.5;
  B.mat(Mat.METAL_PAINTED, 0.03, 0.03, 0.03, 0, 0.5);
  box(B, w - 0.062, hy - 0.06, DT, w - 0.03, hy + 0.06, DT + 0.002, SKIP.NZ);
  B.mat(Mat.METAL_PAINTED, 0.55, 0.55, 0.53, 0, 0.18);
  box(B, w - 0.054, hy - 0.045, DT + 0.002, w - 0.038, hy + 0.045, DT + 0.018, SKIP.NZ);
  if (lock) {
    // padlock hanging from the hasp
    B.mat(Mat.METAL_PAINTED, 0.4, 0.3, 0.1, 0, 0.25);
    box(B, w - 0.066, hy - 0.11, DT + 0.004, w - 0.026, hy - 0.07, DT + 0.02, 0);
    B.mat(Mat.METAL_PAINTED, 0.55, 0.55, 0.53, 0, 0.18);
    box(B, w - 0.058, hy - 0.07, DT + 0.009, w - 0.052, hy - 0.045, DT + 0.015, 0);
    box(B, w - 0.04, hy - 0.07, DT + 0.009, w - 0.034, hy - 0.045, DT + 0.015, 0);
  }
}

/** Dark locker interior (faces pointing inward) with a hat shelf, x 0..w, y 0..h, z T0..D. */
function interior(w: number, h: number): void {
  B.mat(Mat.METAL_PAINTED, INSIDE[0], INSIDE[1], INSIDE[2], 0, 0.6);
  const z0 = T0 + 0.005, z1 = D;
  rect(B, w / 2, h / 2, z0, w / 2, 0, 0, 0, h / 2, 0, 0, 0, 1); // back
  rect(B, 0.001, h / 2, (z0 + z1) / 2, 0, 0, (z1 - z0) / 2, 0, h / 2, 0, 1, 0, 0); // left wall
  rect(B, w - 0.001, h / 2, (z0 + z1) / 2, 0, 0, (z1 - z0) / 2, 0, h / 2, 0, -1, 0, 0); // right wall
  rect(B, w / 2, 0.001, (z0 + z1) / 2, w / 2, 0, 0, 0, 0, (z1 - z0) / 2, 0, 1, 0); // floor
  rect(B, w / 2, h - 0.001, (z0 + z1) / 2, w / 2, 0, 0, 0, 0, (z1 - z0) / 2, 0, -1, 0); // roof
  if (h > 1) {
    B.mat(Mat.METAL_PAINTED, 0.09, 0.09, 0.09, 0, 0.5);
    box(B, 0.002, h - 0.3, z0, w - 0.002, h - 0.29, z1 - 0.01, 0);
  }
}

/** One side (+Z) of a locker edge: 3 columns x tiers doors, kick base. `sideSeed` varies doors per side. */
function side(y0: number, top: number, st: Style, sideSeed: number, along: number, sideNo: number): void {
  const hDoors = top - 0.004 - (y0 + KICK); // up to the cap's underside
  // kick base, recessed
  B.mat(Mat.METAL_PAINTED, 0.03, 0.03, 0.03, 0, 0.6);
  box(B, 0, y0, T0, CELL, y0 + KICK, D - 0.035, SKIP.NY | SKIP.PY | SKIP.NZ | SKIP.NX | SKIP.PX);
  // carcass face frame under the doors (the gaps show it)
  paintMat(st.paint, 0.55);
  box(B, 0, y0 + KICK - 0.004, D - 0.035, CELL, y0 + KICK, D, SKIP.NY | SKIP.NZ | SKIP.NX | SKIP.PX);
  const w = CELL / COLS;
  const hT = hDoors / st.tiers;
  for (let c = 0; c < COLS; c++) {
    for (let t = 0; t < st.tiers; t++) {
      const k = c * 2 + t;
      const r = (i: number): number => rnd(sideSeed, k * 16 + i);
      const x0 = c * w, yb = y0 + KICK + t * hT;
      const ajar = r(0) < 0.07;
      const open = ajar ? 0.18 + 0.5 * r(1) : 0;
      const dent = !ajar && r(2) < 0.14 ? 0.004 + 0.006 * r(3) : 0;
      const replaced = r(4) < 0.05;
      const tone = (replaced ? 0.75 : 1) * (0.92 + 0.16 * r(5));
      const paint: RGB = replaced ? PAINTS[(Math.floor(r(6) * PAINTS.length) + 1) % PAINTS.length] : st.paint;
      const tiers2 = st.tiers === 2;
      const num = st.numBase + (((along * COLS + c) * st.tiers + t + sideNo * 50) % 100);
      if (ajar) {
        B.push();
        B.translate(x0, yb, 0);
        interior(w, hT);
        B.pop();
      } else {
        // dark door-gap backing
        B.mat(Mat.METAL_PAINTED, DARK[0], DARK[1], DARK[2], 0, 0.7);
        rect(B, x0 + w / 2, yb + hT / 2, D, w / 2, 0, 0, 0, hT / 2, 0, 0, 0, 1);
      }
      B.push();
      B.translate(x0 + GAP, yb + GAP, D);
      if (open > 0) B.rotY(-open); // swings out about the hinge (-X) edge
      // micro misalignment of closed doors (catches the light differently)
      else if (r(7) < 0.2) B.rotY(-0.012 * r(8));
      door(w - 2 * GAP, hT - 2 * GAP, paint, tone, dent, hash4(sideSeed, k, 3, 5), tiers2 ? 3 : 4, tiers2 ? 0 : 3, num, !ajar && r(9) < 0.12);
      B.pop();
    }
  }
}

/** Build one locker edge in the edge frame. `sides` bit 0: +Z side open, bit 1: -Z side open. `ends` bit 0: bank
 * starts at x = 0, bit 1: bank ends at x = CELL. */
function lockerEdge(y0: number, top: number, st: Style, seed: number, along: number, sides: number, ends: number): void {
  for (let sd = 0; sd < 2; sd++) {
    if (!(sides & (1 << sd))) continue;
    B.push();
    if (sd === 1) { B.translate(CELL, 0, 0); B.rotY(Math.PI); }
    side(y0, top, st, hash4(seed, sd, 11, 13), sd === 0 ? along : 30 - along, sd);
    B.pop();
  }
  // top cap over both sides and the slab
  paintMat(st.paint, 0.9);
  const zn = sides & 2 ? -FRONT - 0.004 : -T0 - 0.004, zp = sides & 1 ? FRONT + 0.004 : T0 + 0.004;
  const xa = ends & 1 ? -END - 0.002 : 0, xb = ends & 2 ? CELL + END + 0.002 : CELL;
  bevelBox(B, xa, top - 0.004, zn, xb, top + CAP, zp, 0.003, (ends & 1 ? 0 : SKIP.NX) | (ends & 2 ? 0 : SKIP.PX));
  // bank-end side panels (enclose the slab's end post and close the carcass)
  for (const e of [0, 1]) {
    if (!(ends & (1 << e))) continue;
    const x0 = e ? CELL - 0.004 : -END, x1 = e ? CELL + END : 0.004;
    paintMat(st.paint, 0.85);
    box(B, x0, y0, zn, x1, top - 0.004, zp, SKIP.NY);
  }
}

/** Emit the locker banks of tile q (chunk-local edges whose midpoint lies in the tile; the chunk's far border
 * lines x = 32, z = 32 belong to the neighbour chunk). Returns triangles written. */
export function emitLockerBanks(
  w: GeometryWriter, nb: LayoutNeighborhood, s: number, cx: number, cz: number,
  inTile: (x: number, z: number) => boolean, ox: number, oz: number, auxBits: (li: number, lj: number) => number,
  ceilByte: (li: number, lj: number) => number,
): number {
  const l = nb.center;
  let tris = 0;
  const floorAt = (li: number, lj: number): number => nb.floorCm(li, lj);
  const solid = (li: number, lj: number): boolean => (nb.flags(li, lj) & CellFlag.SOLID) !== 0;
  for (let axis = 0; axis < 2; axis++) {
    const eg = axis === 0 ? l.ex : l.ez;
    for (let line = 0; line < 32; line++) {
      for (let c = 0; c < 32; c++) {
        const e = axis === 0 ? c * 33 + line : line * 32 + c;
        // cells on the two sides: A (-axis side), B (+axis side)
        const ai = axis === 0 ? line - 1 : c, aj = axis === 0 ? c : line - 1;
        const bi = axis === 0 ? line : c, bj = axis === 0 ? c : line;
        const fl = Math.max(floorAt(ai, aj), floorAt(bi, bj));
        if (!isLockerEdge(eg.kind[e], eg.hA[e], eg.matNeg[e], eg.matPos[e], fl)) continue;
        const mx = axis === 0 ? line * CELL : (c + 0.5) * CELL, mz = axis === 0 ? (c + 0.5) * CELL : line * CELL;
        if (!inTile(mx, mz)) continue;
        // neighbours along the line (bank ends)
        const isL = (cc: number): boolean => {
          if (cc >= 0 && cc < 32) {
            const e2 = axis === 0 ? cc * 33 + line : line * 32 + cc;
            const ia = axis === 0 ? line - 1 : cc, ja = axis === 0 ? cc : line - 1, ib = axis === 0 ? line : cc, jb = axis === 0 ? cc : line;
            return isLockerEdge(eg.kind[e2], eg.hA[e2], eg.matNeg[e2], eg.matPos[e2], Math.max(floorAt(ia, ja), floorAt(ib, jb)));
          }
          const k = axis === 0 ? nb.exKind(line, cc) : nb.ezKind(cc, line);
          const h = axis === 0 ? nb.exH(line, cc) : nb.ezH(cc, line);
          return k === EdgeKind.PARTITION && h[0] - fl >= LOCKER_MIN_CM;
        };
        const ends = (isL(c - 1) ? 0 : 1) | (isL(c + 1) ? 0 : 2);
        // edge frame: origin at the edge start, X along the edge. ez (axis 1): X = world +x, +Z = world +z (cell B).
        // ex (axis 0): yaw -pi/2 maps X -> world +z and +Z -> world -x (cell A).
        const yaw = axis === 0 ? -Math.PI / 2 : 0;
        const px = axis === 0 ? line * CELL : c * CELL, pz = axis === 0 ? c * CELL : line * CELL;
        const plusCell = axis === 0 ? [ai, aj] : [bi, bj], minusCell = axis === 0 ? [bi, bj] : [ai, aj];
        const sides = (solid(plusCell[0], plusCell[1]) ? 0 : 1) | (solid(minusCell[0], minusCell[1]) ? 0 : 2);
        if (!sides) continue;
        const gLine = (axis === 0 ? cx : cz) * 32 + line, gAlong = (axis === 0 ? cz : cx) * 32 + c;
        const st = styleOf(l, s, cx, cz, axis === 0 ? line : c, axis === 0 ? c : line, gLine * 2 + axis);
        const seed = hash5(s, axis, gLine, gAlong, 0x70c8);
        const ki = Math.min(31, Math.max(0, bi)), kj = Math.min(31, Math.max(0, bj));
        w.setTransform(yaw, 1, px - ox, 0, pz - oz);
        B.begin(w, false, auxBits(ki, kj), ceilByte(ki, kj), seed);
        lockerEdge(fl / 100, eg.hA[e] / 100, st, seed, ((gAlong % 10) + 10) % 10, sides, ends);
        w.resetTransform();
        tris += B.tris;
      }
    }
  }
  return tris;
}
