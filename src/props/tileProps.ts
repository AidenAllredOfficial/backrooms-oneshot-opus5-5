// src/props/tileProps.ts — per-tile merged props mesh (props, non-recessed fixtures, pipes) (§5 WP6).
// Pure module (no three/DOM).
//
// Contents of tile q of nb.center (all emitted in tile-local metres):
// - props (after expandPeriodicProps) whose origin lies in the tile;
// - non-recessed fixtures (after expandPeriodicFixtures) with tileOfPoint(px, pz) = q;
// - pipe solids of nb.center whose midpoint lies in the tile (elbows resolved against every pipe of the 3x3
//   neighbourhood, hangers reach the neighbourhood ceiling);
// - locker banks on tall METAL_PAINTED PARTITION edges whose midpoint lies in the tile (lockers.ts).
// PROP_AUX per part: aux = (roughness override, 0, bits, ceilByte) with bits & 1 = anchor cell is a TOWER cell
// (the shader wraps y for its light-volume lookup), bits 2-7 = dust level 0..63 from the anchor cell's decay (the
// surface shader's prop dust; emissive parts drop them in PartBuilder) and ceilByte = clamp(ceilCm / 5) of the anchor
// cell. Bit 1 is the clearcoat bit (PartBuilder.mat).

import { CHUNK_CELLS, TILE_SIZE } from '../core/constants.ts';
import { cellIdx, tileOfPoint, worldToCell, type TileKey } from '../core/grid.ts';
import { CellFlag, EdgeKind, isRecessedFixture, Mat } from '../core/ids.ts';
import type { ChunkLayout, Solid } from '../core/layout.ts';
import type { MeshBuffers } from '../core/mesh.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { GeometryWriter } from '../core/writer.ts';
import { expandPeriodicFixtures, expandPeriodicProps } from '../mesh/periodic.ts';
import { emitFixtureInto } from './fixtures.ts';
import { emitPropInto, propGathersDust } from './index.ts';
import { emitLockerBanks, LOCKER_MIN_CM } from './lockers.ts';
import { emitPipeInto, type PipeSolid } from './pipes.ts';

const clampCell = (c: number): number => (c < 0 ? 0 : c >= CHUNK_CELLS ? CHUNK_CELLS - 1 : c);
/** Anchor cell of a chunk-local point: the containing cell, clamped into the chunk exactly like tileOfPoint (content
 * the chunk owns may sit on, or a hair beyond, its seam: a sign on the x = 38.4 wall, a prop snapped to a seam). */
const cellOf = (x: number, z: number): number => cellIdx(clampCell(worldToCell(x)), clampCell(worldToCell(z)));
const inTile = (x: number, z: number, q: number): boolean => Number.isFinite(x) && Number.isFinite(z) && tileOfPoint(x, z) === q;
/** Pipes: every chunk a pipe crosses holds a copy, so ownership needs the midpoint strictly inside [0, CHUNK) (no
 * clamping, or two chunks would both draw a seam-crossing pipe). */
const inChunk = (x: number, z: number): boolean => {
  const li = worldToCell(x), lj = worldToCell(z);
  return li >= 0 && lj >= 0 && li < CHUNK_CELLS && lj < CHUNK_CELLS;
};
const ceilByteOf = (l: ChunkLayout, k: number): number => Math.max(0, Math.min(255, Math.round(l.ceilCm[k] / 5)));
/** Dust level 0..63 of content anchored in a cell with decay byte `decay`: a light film (10 %) even in fresh cells,
 * full in the most decayed (DYING / DARK) ones. Monotonic in decay. */
export const dustLevelOf = (decay: number): number => Math.round(63 * Math.min(1, 0.1 + 0.9 * Math.pow(Math.max(0, decay) / 255, 0.8)));
/** aux.z bits of content anchored in cell k: bit 0 = TOWER cell, bits 2-7 = dust level (0 when `dust` is false). */
const auxBitsOf = (l: ChunkLayout, k: number, dust = true): number =>
  (l.flags[k] & CellFlag.TOWER ? 1 : 0) | (dust ? dustLevelOf(l.decay[k]) << 2 : 0);
/** Cheap pre-check: any tall METAL_PAINTED partition edge in the chunk. */
const hasLockerEdges = (l: ChunkLayout): boolean => {
  for (const eg of [l.ex, l.ez]) {
    for (let e = 0; e < eg.kind.length; e++) if (eg.kind[e] === EdgeKind.PARTITION && eg.matPos[e] === Mat.METAL_PAINTED && eg.hA[e] >= LOCKER_MIN_CM) return true;
  }
  return false;
};

/** Statistics of the most recent buildTileProps call (triangle budget reporting; not part of the contract). */
export const lastTilePropsStats = { props: 0, fixtures: 0, pipes: 0, tris: 0, propTris: 0, fixtureTris: 0, pipeTris: 0, lockerTris: 0 };

/** Props mesh of one render tile (tile-local metres), or null if the tile has no props/fixtures/pipes. */
export function buildTileProps(nb: LayoutNeighborhood, tile: TileKey): MeshBuffers | null {
  const c = nb.center;
  const q = tile.q;
  const ox = (q & 1) * TILE_SIZE, oz = (q >> 1) * TILE_SIZE;
  const st = lastTilePropsStats;
  st.props = 0; st.fixtures = 0; st.pipes = 0; st.tris = 0; st.propTris = 0; st.fixtureTris = 0; st.pipeTris = 0; st.lockerTris = 0;
  let w: GeometryWriter | null = null;
  const writer = (): GeometryWriter => (w ??= new GeometryWriter(8192));

  // ---- props
  for (const p of expandPeriodicProps(c)) {
    if (!inTile(p.x, p.z, q)) continue;
    const k = cellOf(p.x, p.z);
    st.propTris += emitPropInto(writer(), p, ox, oz, auxBitsOf(c, k, propGathersDust(p.kind)), ceilByteOf(c, k));
    st.props++;
  }

  // ---- surface fixtures
  for (const f of expandPeriodicFixtures(c)) {
    if (isRecessedFixture(f.kind) || !inTile(f.px, f.pz, q)) continue;
    const k = cellOf(f.px, f.pz);
    const ceilY = c.flags[k] & CellFlag.NO_CEIL ? Number.NaN : c.ceilCm[k] / 100;
    st.fixtureTris += emitFixtureInto(writer(), f, ox, oz, ceilY, auxBitsOf(c, k), ceilByteOf(c, k));
    st.fixtures++;
  }

  // ---- pipes (owned by midpoint)
  const owned: PipeSolid[] = [];
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const s of c.solids) {
    if (s.kind !== 'pipe') continue;
    const mx = (s.a[0] + s.b[0]) / 2, mz = (s.a[2] + s.b[2]) / 2;
    if (!inChunk(mx, mz) || !inTile(mx, mz, q)) continue;
    owned.push(s);
    bx0 = Math.min(bx0, s.a[0], s.b[0]); bx1 = Math.max(bx1, s.a[0], s.b[0]);
    bz0 = Math.min(bz0, s.a[2], s.b[2]); bz1 = Math.max(bz1, s.a[2], s.b[2]);
  }
  if (owned.length > 0) {
    // neighbours that can share an endpoint with an owned pipe: those touching the owned pipes' extent
    const m = 0.01;
    const all = nb.solids().filter((o: Solid): o is PipeSolid => o.kind === 'pipe' &&
      Math.max(o.a[0], o.b[0]) >= bx0 - m && Math.min(o.a[0], o.b[0]) <= bx1 + m &&
      Math.max(o.a[2], o.b[2]) >= bz0 - m && Math.min(o.a[2], o.b[2]) <= bz1 + m);
    const ceilAt = (x: number, z: number): number => {
      const li = worldToCell(x), lj = worldToCell(z);
      if (li < -CHUNK_CELLS || lj < -CHUNK_CELLS || li >= 2 * CHUNK_CELLS || lj >= 2 * CHUNK_CELLS) return Number.NaN;
      if (nb.flags(li, lj) & (CellFlag.NO_CEIL | CellFlag.SOLID)) return Number.NaN;
      return nb.ceilCm(li, lj) / 100;
    };
    for (const s of owned) {
      const k = cellOf((s.a[0] + s.b[0]) / 2, (s.a[2] + s.b[2]) / 2);
      st.pipeTris += emitPipeInto(writer(), s, all, ox, oz, ceilAt, c.decay[k], auxBitsOf(c, k), ceilByteOf(c, k));
      st.pipes++;
    }
  }

  // ---- locker banks dressed onto tall METAL_PAINTED partitions (edges owned by midpoint; lines 0..31 only)
  if (hasLockerEdges(c)) {
    st.lockerTris = emitLockerBanks(writer(), nb, tile.s, tile.cx, tile.cz, (x, z) => inTile(x, z, q), ox, oz,
      (li, lj) => auxBitsOf(c, cellIdx(li, lj)), (li, lj) => ceilByteOf(c, cellIdx(li, lj)));
  }

  st.tris = st.propTris + st.fixtureTris + st.pipeTris + st.lockerTris;
  if (!w || (w as GeometryWriter).indexCount === 0) return null;
  return (w as GeometryWriter).finish();
}
