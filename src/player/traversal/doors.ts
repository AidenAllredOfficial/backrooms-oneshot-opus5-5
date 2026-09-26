// src/player/traversal/doors.ts (WP12) — the two elevator door leaves: dynamic meshes + virtual collision boxes.
//
// stampElevator (WP4) never adds ELEVATOR_DOOR props (they would be static geometry and static collision). WP12
// builds the leaves with WP6's emitProp(ELEVATOR_DOOR) into a GeometryWriter, shows them with
// host.attachDynamicMesh(tileKey, mesh) (the tile's props material) and animates them with setOffset.
// Their collision is two virtual boxes added to the collision query by PlayerSystem (never layout props).
//
// Door frame: the elevator footprint (core footprintCell, W = 2 across, L = 3 along; v = 0,1 cab, v = 2 lobby)
// is read from the layout's StructureInstance; the cab|lobby DOORWAY is the edge between cells (u,1) and (u,2)
// that is a DOORWAY (1 cell wide, hole DOOR_W = 0.9 m). Leaves: two-speed side-opening ("telescopic") panels on
// the cab side of the front wall, each half the ELEVATOR_DOOR width, sliding toward the other cab cell: closed
// they meet across the hole; open they stack in front of the wall next to the opening, inside the cab.

import { CELL, CHUNK_SIZE, DOOR_W, ELEVATOR, WALL_T } from '../../core/constants.ts';
import { exIdx, ezIdx, footprintCell, tileKeyAt, tileKeyStr, tileOriginX, tileOriginZ } from '../../core/grid.ts';
import { EdgeKind, Mat, PropKind, StructureKind, VFlag, type StoreyId } from '../../core/ids.ts';
import type { ChunkLayout, PropPlacement, StructureInstance } from '../../core/layout.ts';
import type { MeshBuffers } from '../../core/mesh.ts';
import { PROP_DEFS } from '../../core/props.ts';
import type { CollisionWorld, DynamicMeshHandle, PortalHit, WorldQuery } from '../../core/runtime.ts';
import { GeometryWriter, packRGBA } from '../../core/writer.ts';
import { emitProp } from '../../props/index.ts';
import type { TraversalHost } from '../PlayerSystem.ts';

export const DOOR_TIME = 1.5; // s to open / close
export const LEAF_SCALE_W = 0.5; // each leaf is half an ELEVATOR_DOOR wide
const LEAF_W = PROP_DEFS[PropKind.ELEVATOR_DOOR].size[0] * LEAF_SCALE_W; // 0.5
const LEAF_H = PROP_DEFS[PropKind.ELEVATOR_DOOR].size[1]; // 2.2
const LEAF_T = PROP_DEFS[PropKind.ELEVATOR_DOOR].size[2]; // 0.05
const HOLE = DOOR_W / 2; // 0.45
/** leaf 0 = fast (travels 2x), leaf 1 = slow; along-line centres (closed) and travel; depth into the cab */
const LEAF_CLOSED = [-(HOLE + 0.03) + LEAF_W / 2, HOLE + 0.03 - LEAF_W / 2] as const; // [-0.23, 0.23]
const LEAF_OPEN = HOLE + 0.02 + LEAF_W / 2; // 0.72: stacked beside the opening
const LEAF_DEPTH = [WALL_T / 2 + 0.005 + LEAF_T * 1.5 + 0.005, WALL_T / 2 + 0.005 + LEAF_T / 2] as const; // [0.16, 0.105]

/** World-space description of one elevator door (all metres, storey-relative y). */
export interface DoorFrame {
  cx: number; cz: number; // centre of the hole on the edge line
  sx: number; sz: number; // unit slide direction (toward the other cab cell)
  nx: number; nz: number; // unit direction lobby -> cab
  floorY: number;
  ceilCm: number;
  cab: [number, number, number, number]; // cab AABB x0, z0, x1, z1 (world)
  lobby: [number, number, number, number]; // lobby strip AABB (world)
  id: number;
  hasLeaves: boolean; // false when the door side is unknown (no layout access): ride without leaves
}

/** Finds the elevator structure of a portal hit in the raw world's layout (null if the world has no layouts). */
export function elevatorFrame(raw: CollisionWorld, hit: PortalHit): DoorFrame | null {
  const wq = raw as Partial<WorldQuery>;
  if (typeof wq.layoutAt !== 'function') return null;
  const ccx = Math.round(hit.ox / CHUNK_SIZE), ccz = Math.round(hit.oz / CHUNK_SIZE);
  const l = wq.layoutAt(ccx, ccz);
  if (!l) return null;
  let st: StructureInstance | null = null;
  for (const s of l.structures) {
    if (s.kind !== StructureKind.ELEVATOR || !s.portal) continue;
    if (s.portal === hit.spec || (s.portal.towerId === hit.spec.towerId && Math.abs(s.portal.min[0] - hit.spec.min[0]) < 1e-3 && Math.abs(s.portal.min[2] - hit.spec.min[2]) < 1e-3)) { st = s; break; }
  }
  if (!st) return null;
  return frameFromStructure(l, st, hit.ox, hit.oz);
}

export function frameFromStructure(l: ChunkLayout, st: StructureInstance, ox: number, oz: number): DoorFrame | null {
  const W = ELEVATOR.W_CELLS, L = ELEVATOR.L_CELLS;
  let door = -1;
  for (let u = 0; u < W && door < 0; u++) {
    const [ai, aj] = footprintCell(st.i0, st.j0, W, L, st.rot, u, 1);
    const [bi, bj] = footprintCell(st.i0, st.j0, W, L, st.rot, u, 2);
    const k = ai === bi ? l.ez.kind[ezIdx(ai, Math.max(aj, bj))] : l.ex.kind[exIdx(Math.max(ai, bi), aj)];
    if (k === EdgeKind.DOORWAY) door = u;
  }
  if (door < 0) {
    // no DOORWAY found (stub layouts): the first non-wall edge, else u = 0
    for (let u = 0; u < W && door < 0; u++) {
      const [ai, aj] = footprintCell(st.i0, st.j0, W, L, st.rot, u, 1);
      const [bi, bj] = footprintCell(st.i0, st.j0, W, L, st.rot, u, 2);
      const k = ai === bi ? l.ez.kind[ezIdx(ai, Math.max(aj, bj))] : l.ex.kind[exIdx(Math.max(ai, bi), aj)];
      if (k !== EdgeKind.WALL) door = u;
    }
    if (door < 0) door = 0;
  }
  const cc = (li: number, lj: number): [number, number] => [ox + (li + 0.5) * CELL, oz + (lj + 0.5) * CELL];
  const [ci, cj] = footprintCell(st.i0, st.j0, W, L, st.rot, door, 1);
  const [li, lj] = footprintCell(st.i0, st.j0, W, L, st.rot, door, 2);
  const [oi, oj] = footprintCell(st.i0, st.j0, W, L, st.rot, 1 - door, 1);
  const [cabX, cabZ] = cc(ci, cj), [lobX, lobZ] = cc(li, lj), [othX, othZ] = cc(oi, oj);
  let nx = cabX - lobX, nz = cabZ - lobZ;
  const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
  let sx = othX - cabX, sz = othZ - cabZ;
  const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
  const cx = (cabX + lobX) / 2, cz = (cabZ + lobZ) / 2;
  // cab (v = 0, 1) and lobby (v = 2) world rectangles
  const rect = (v0: number, v1: number): [number, number, number, number] => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let u = 0; u < W; u++) for (let v = v0; v <= v1; v++) {
      const [a, b] = footprintCell(st.i0, st.j0, W, L, st.rot, u, v);
      x0 = Math.min(x0, ox + a * CELL); z0 = Math.min(z0, oz + b * CELL);
      x1 = Math.max(x1, ox + (a + 1) * CELL); z1 = Math.max(z1, oz + (b + 1) * CELL);
    }
    return [x0, z0, x1, z1];
  };
  const cell = cj * 32 + ci;
  return {
    cx, cz, sx, sz, nx, nz, floorY: l.floorCm[cell] / 100, ceilCm: l.ceilCm[cell], cab: rect(0, 1), lobby: rect(2, 2),
    id: st.portal ? st.portal.towerId : st.id, hasLeaves: true,
  };
}

/** Frame from a portal alone (no layout access): the cab AABB is known, the door side is not -> no leaves. */
export function portalOnlyFrame(hit: PortalHit): DoorFrame {
  const x0 = hit.ox + hit.spec.min[0], x1 = hit.ox + hit.spec.max[0], z0 = hit.oz + hit.spec.min[2], z1 = hit.oz + hit.spec.max[2];
  return {
    cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, sx: 1, sz: 0, nx: 0, nz: 1, floorY: hit.spec.min[1] > -1 ? hit.spec.min[1] : 0, ceilCm: 270,
    cab: [x0, z0, x1, z1], lobby: [x0 - CELL, z0 - CELL, x1 + CELL, z1 + CELL], id: hit.spec.towerId, hasLeaves: false,
  };
}

/** Builds one leaf mesh (tile-local) in its CLOSED position. */
export function buildLeafMesh(f: DoorFrame, leaf: 0 | 1, tileOx: number, tileOz: number): MeshBuffers {
  const w = new GeometryWriter(256);
  const p: PropPlacement = { kind: PropKind.ELEVATOR_DOOR, variant: 0, x: 0, y: 0, z: 0, yaw: 0, scale: 1, flags: 0, seed: f.id + leaf };
  try { emitProp(w, p, 0, 0); } catch { /* fall back below */ }
  let m = w.finish();
  if (m.vertexCount === 0) m = fallbackLeaf();
  // local (x across, y up, z thickness) -> world by a proper rotation: local +x (the leaf's rubber leading edge in
  // WP6's ELEVATOR_DOOR) points along -slide (the closing direction); local z is then +-toCab.
  const ax = -f.sx, az = -f.sz; // local +x axis in world
  const zx = -az, zz = ax; // local +z axis = x_axis x up (right-handed)
  const along = LEAF_CLOSED[leaf], depth = LEAF_DEPTH[leaf];
  const ox = f.cx + f.sx * along + f.nx * depth - tileOx;
  const oz = f.cz + f.sz * along + f.nz * depth - tileOz;
  const pos = m.position, nor = m.normal;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.vertexCount; i++) {
    const lx = pos[i * 3] * LEAF_SCALE_W, ly = pos[i * 3 + 1], lz = pos[i * 3 + 2];
    const x = ox + ax * lx + zx * lz, y = f.floorY + ly, z = oz + az * lx + zz * lz;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    // normals: inverse-transpose of the x scale, then the same rotation
    const nxl = (nor[i * 4] / 127) / LEAF_SCALE_W, nyl = nor[i * 4 + 1] / 127, nzl = nor[i * 4 + 2] / 127;
    const wx = ax * nxl + zx * nzl, wz = az * nxl + zz * nzl;
    const len = Math.hypot(wx, nyl, wz) || 1;
    nor[i * 4] = Math.round((wx / len) * 127); nor[i * 4 + 1] = Math.round((nyl / len) * 127); nor[i * 4 + 2] = Math.round((wz / len) * 127);
    // props material: PROP_AUX with the anchor cell's ceiling byte
    if (m.flags[i] & VFlag.PROP_AUX) m.aux[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(f.ceilCm / 5)));
  }
  m.bounds = m.vertexCount > 0 ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0];
  return m;
}

/** Brushed-steel box leaf in the ELEVATOR_DOOR frame (used when WP6's emitProp yields no geometry). */
function fallbackLeaf(): MeshBuffers {
  const w = new GeometryWriter(64);
  const W = PROP_DEFS[PropKind.ELEVATOR_DOOR].size[0], H = LEAF_H, T = LEAF_T;
  w.setState(Mat.METAL_PAINTED, VFlag.PROP_AUX, packRGBA(196, 198, 200, 0), 0, 0);
  const x0 = -W / 2, x1 = W / 2, y0 = 0, y1 = H, z0 = -T / 2, z1 = T / 2;
  const face = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, uw: number, vh: number): void => {
    const a = w.vertex(ax, ay, az, nx, ny, nz, 0, 0);
    const b = w.vertex(bx, by, bz, nx, ny, nz, uw, 0);
    const c = w.vertex(cx, cy, cz, nx, ny, nz, uw, vh);
    const d = w.vertex(dx, dy, dz, nx, ny, nz, 0, vh);
    w.quad(a, b, c, d);
  };
  face(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, W, H); // front (-z)
  face(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, W, H); // back (+z)
  face(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, T, H); // -x
  face(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, T, H); // +x
  face(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, W, T); // top
  face(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, W, T); // bottom
  return w.finish();
}

/** Along-line centre offset of a leaf for an open amount 0 (closed) .. 1 (open). */
export const leafAlong = (leaf: 0 | 1, open: number): number => LEAF_CLOSED[leaf] + (LEAF_OPEN - LEAF_CLOSED[leaf]) * open;

export interface ElevatorDoors {
  readonly frame: DoorFrame | null;
  readonly open: number; // 0 closed .. 1 open (eased)
  /** track a frame (null = none); meshes are (re)attached lazily */
  setFrame(f: DoorFrame | null, s: StoreyId): void;
  /** storey changed with the player inside: drop the old meshes, rebuild in the new storey's tile */
  rebuild(s: StoreyId): void;
  setOpen(open: number): void;
  /** try to attach missing meshes (call at the proximity cadence) */
  tick(host: TraversalHost, s: StoreyId): void;
  /** append the leaves' collision boxes near (x, z, r) to out (6 floats each); returns the new count */
  appendBoxes(x: number, z: number, r: number, out: Float32Array, n: number): number;
  dispose(): void;
}

export function createElevatorDoors(): ElevatorDoors {
  let frame: DoorFrame | null = null;
  let open = 1;
  let storey: StoreyId = 0;
  const handles: (DynamicMeshHandle | null)[] = [null, null];

  const drop = (): void => {
    for (let i = 0; i < 2; i++) { try { handles[i]?.dispose(); } catch { /* already disposed on eviction */ } handles[i] = null; }
  };
  const apply = (): void => {
    if (!frame) return;
    for (let i = 0; i < 2; i++) {
      const h = handles[i];
      if (!h) continue;
      const d = leafAlong(i as 0 | 1, open) - LEAF_CLOSED[i];
      h.setOffset(frame.sx * d, 0, frame.sz * d);
    }
  };

  return {
    get frame() { return frame; },
    get open() { return open; },
    setFrame(f, s) {
      if (f && frame && Math.abs(f.cx - frame.cx) < 1e-3 && Math.abs(f.cz - frame.cz) < 1e-3 && s === storey) return;
      drop();
      frame = f; storey = s;
      if (!f) open = 1;
    },
    rebuild(s) { drop(); storey = s; },
    setOpen(o) {
      const v = o < 0 ? 0 : o > 1 ? 1 : o;
      if (v === open) return;
      open = v;
      apply();
    },
    tick(host, s) {
      if (!frame || !frame.hasLeaves) return;
      if (s !== storey) { drop(); storey = s; }
      if (handles[0] && handles[1]) return;
      const tk = tileKeyAt(storey, frame.cx + frame.nx * 0.3, frame.cz + frame.nz * 0.3);
      const key = tileKeyStr(tk);
      const ox = tileOriginX(tk), oz = tileOriginZ(tk);
      for (let i = 0; i < 2; i++) {
        if (handles[i]) continue;
        let h: DynamicMeshHandle | null = null;
        try { h = host.attachDynamicMesh(key, buildLeafMesh(frame, i as 0 | 1, ox, oz)); } catch { h = null; }
        handles[i] = h; // null: tile not resident yet, retried next tick
      }
      apply();
    },
    appendBoxes(x, z, r, out, n) {
      if (!frame || !frame.hasLeaves) return n;
      const cap = (out.length / 6) | 0;
      for (let i = 0; i < 2 && n < cap; i++) {
        const along = leafAlong(i as 0 | 1, open), depth = LEAF_DEPTH[i as 0 | 1];
        const px = frame.cx + frame.sx * along + frame.nx * depth, pz = frame.cz + frame.sz * along + frame.nz * depth;
        const hx = Math.abs(frame.sx) * (LEAF_W / 2) + Math.abs(frame.nx) * (LEAF_T / 2);
        const hz = Math.abs(frame.sz) * (LEAF_W / 2) + Math.abs(frame.nz) * (LEAF_T / 2);
        if (Math.abs(px - x) > hx + r || Math.abs(pz - z) > hz + r) continue;
        const o = n * 6;
        out[o] = px - hx; out[o + 1] = frame.floorY; out[o + 2] = pz - hz;
        out[o + 3] = px + hx; out[o + 4] = frame.floorY + LEAF_H; out[o + 5] = pz + hz;
        n++;
      }
      return n;
    },
    dispose() { drop(); frame = null; },
  };
}
