// src/world/structures/frame.ts — rotated local frames for stamps (towers, elevators, landmarks) (WP4, private).
//
// A Frame is a W x L cell rectangle in a local (u across, v along) frame, placed in the chunk with the core
// footprint convention (core/grid.ts footprintCell / footprintPoint): (i0, j0) is the MIN corner of the rotated
// footprint. All stamps author in (u, v) cells or (um, vm) metres and never re-derive the rotation.

import { CELL, WALL_T } from '../../core/constants.ts';
import { footprintCell, footprintPoint, footprintRect } from '../../core/grid.ts';
import type { Vec3 } from '../../core/grid.ts';
import type { MatId } from '../../core/ids.ts';
import type { ChunkGrid, EdgeOpts } from '../../core/world.ts';

export type Rot = 0 | 1 | 2 | 3;

/** World (chunk-local) direction of the frame's +u and +v axes per rot (core/grid.ts footprint rotations). */
const U_DIR: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const V_DIR: readonly (readonly [number, number])[] = [[0, 1], [-1, 0], [0, -1], [1, 0]];

export interface EdgeRef { axis: 'x' | 'z'; i: number; j: number; aIsNeg: boolean }

export class Frame {
  readonly i0: number;
  readonly j0: number;
  readonly W: number;
  readonly L: number;
  readonly rot: Rot;
  constructor(i0: number, j0: number, W: number, L: number, rot: Rot) {
    this.i0 = i0; this.j0 = j0; this.W = W; this.L = L; this.rot = rot;
  }
  /** Local cell (li, lj) of frame cell (u, v). Works outside [0,W)x[0,L) too (linear map). */
  cell(u: number, v: number): [number, number] {
    return footprintCell(this.i0, this.j0, this.W, this.L, this.rot, u, v);
  }
  /** Chunk-local metres [x, z] of frame metres (um, vm). */
  point(um: number, vm: number): [number, number] {
    return footprintPoint(this.i0, this.j0, this.W, this.L, this.rot, um, vm);
  }
  /** Half-open local cell rect [li0, lj0, li1, lj1) of the whole frame. */
  rect(): [number, number, number, number] {
    return footprintRect(this.i0, this.j0, this.W, this.L, this.rot);
  }
  /** Half-open local cell rect of frame cells [u0,u1) x [v0,v1). */
  cellRect(u0: number, v0: number, u1: number, v1: number): [number, number, number, number] {
    const [a0, b0] = this.cell(u0, v0);
    const [a1, b1] = this.cell(u1 - 1, v1 - 1);
    return [Math.min(a0, a1), Math.min(b0, b1), Math.max(a0, a1) + 1, Math.max(b0, b1) + 1];
  }
  /** World direction (dx, dz) of a frame direction (du, dv). */
  dir(du: number, dv: number): [number, number] {
    const a = U_DIR[this.rot], b = V_DIR[this.rot];
    return [a[0] * du + b[0] * dv, a[1] * du + b[1] * dv];
  }
  /** Camera/prop yaw whose forward vector points along frame direction (du, dv). */
  yaw(du: number, dv: number): number {
    const [dx, dz] = this.dir(du, dv);
    return yawOf(dx, dz);
  }
  /** Axis-aligned chunk-local box of frame metres [um0,um1] x [vm0,vm1] x [y0,y1]. */
  box(um0: number, vm0: number, um1: number, vm1: number, y0: number, y1: number): { min: Vec3; max: Vec3 } {
    const [xa, za] = this.point(um0, vm0);
    const [xb, zb] = this.point(um1, vm1);
    return { min: [Math.min(xa, xb), y0, Math.min(za, zb)], max: [Math.max(xa, xb), y1, Math.max(za, zb)] };
  }
  /** The edge between frame cells (uA, vA) and (uB, vB) (4-adjacent). aIsNeg: cell A is on the edge's -axis side. */
  edge(uA: number, vA: number, uB: number, vB: number): EdgeRef {
    const [ai, aj] = this.cell(uA, vA);
    const [bi, bj] = this.cell(uB, vB);
    if (ai !== bi) return { axis: 'x', i: Math.max(ai, bi), j: aj, aIsNeg: ai < bi };
    return { axis: 'z', i: ai, j: Math.max(aj, bj), aIsNeg: aj < bj };
  }
  /** Set the edge between frame cells A and B. matA = face material looking into A, matB into B. */
  setEdge(g: ChunkGrid, uA: number, vA: number, uB: number, vB: number, kind: number, matA: MatId, matB: MatId, o?: EdgeOpts): boolean {
    const e = this.edge(uA, vA, uB, vB);
    if (g.isFrozenEdge(e.axis, e.i, e.j)) return false;
    const opts: EdgeOpts = { ...o, matNeg: e.aIsNeg ? matA : matB, matPos: e.aIsNeg ? matB : matA };
    return g.setEdge(e.axis, e.i, e.j, kind, opts, true);
  }
  /** Chunk-local point on the face of the edge between A and B that looks into A, at fraction t (0..1) along
   * the edge measured in +u or +v, plus the face normal (pointing into A). */
  facePoint(uA: number, vA: number, uB: number, vB: number, t: number, off = WALL_T / 2): { x: number; z: number; nx: number; nz: number } {
    const du = uB - uA, dv = vB - vA; // direction A -> B
    // edge line in frame metres: between the two cells
    const umLine = du !== 0 ? Math.max(uA, uB) * CELL : (uA + t) * CELL;
    const vmLine = dv !== 0 ? Math.max(vA, vB) * CELL : (vA + t) * CELL;
    const um = umLine - du * off, vm = vmLine - dv * off;
    const [x, z] = this.point(um, vm);
    const [nx, nz] = this.dir(-du, -dv);
    return { x, z, nx, nz };
  }
}

/** yaw such that forwardXZ(yaw) = (dx, dz) normalised (camera convention: yaw 0 looks along -Z). */
export const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/** Rotated extent (cells along x, z) of a W x L frame. */
export const frameExtent = (W: number, L: number, rot: Rot): [number, number] => ((rot & 1) === 0 ? [W, L] : [L, W]);
