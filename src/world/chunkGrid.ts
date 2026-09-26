// src/world/chunkGrid.ts — createChunkGrid: the mutable builder over a ChunkLayout (implements core ChunkGrid) (WP1).
//
// Zone generators (WP2/WP3) and stamps/content (WP4) write layouts ONLY through this API. Rules enforced here:
//  - seam lines (i = 0/32 on 'x', j = 0/32 on 'z') are frozen after freezeSeams(): setEdge refuses them (even with
//    `force`: a seam is a contract with the neighbouring chunk);
//  - edges touching a RESERVED cell and RESERVED cells themselves are skipped unless `force`;
//  - fixture ids come from core (fixtureId / fixtureSeed), with the WORLD seed (createChunkGrid's 2nd parameter);
//  - emitter / vignette / anomaly seeds are position-based (stable when upstream placement counts change).

import { CELL, CHUNK_CELLS, CHUNK_SIZE } from '../core/constants.ts';
import { edgeDefaults } from '../core/edges.ts';
import { cellIdx, exIdx, ezIdx } from '../core/grid.ts';
import { CellFlag, EdgeKind, StructureKind } from '../core/ids.ts';
import { fixtureId, fixtureSeed, type ChunkLayout, type Solid } from '../core/layout.ts';
import { hash6, SALT } from '../core/rng.ts';
import type { ChunkGrid, EdgeOpts, SeamSpec } from '../core/world.ts';

const N = CHUNK_CELLS;

export type BuildGrid = ChunkGrid & { freezeSeams(): void; setSeam(side: 'W' | 'N' | 'E' | 'S', s: SeamSpec): void };

export function createChunkGrid(layout: ChunkLayout, seed = 0): BuildGrid {
  const key = layout.key;
  let frozen = false;
  const inCells = (li: number, lj: number): boolean => li >= 0 && lj >= 0 && li < N && lj < N;
  const hasFlag = (li: number, lj: number, f: number): boolean => inCells(li, lj) && (layout.flags[cellIdx(li, lj)] & f) !== 0;
  const isReserved = (li: number, lj: number): boolean => hasFlag(li, lj, CellFlag.RESERVED);
  const inEdges = (axis: 'x' | 'z', i: number, j: number): boolean =>
    axis === 'x' ? i >= 0 && i <= N && j >= 0 && j < N : i >= 0 && i < N && j >= 0 && j <= N;
  const onSeam = (axis: 'x' | 'z', i: number, j: number): boolean => (axis === 'x' ? i === 0 || i === N : j === 0 || j === N);
  const isFrozenEdge = (axis: 'x' | 'z', i: number, j: number): boolean => frozen && onSeam(axis, i, j);
  /** World-space key (global centimetres) for position-based seeds. */
  const gcm = (m: number, c: number): number => Math.round((c * CHUNK_SIZE + m) * 100);

  const setEdge = (axis: 'x' | 'z', i: number, j: number, kind: number, o?: EdgeOpts, force?: boolean): boolean => {
    if (!inEdges(axis, i, j)) return false;
    if (isFrozenEdge(axis, i, j)) return false;
    if (!force && (axis === 'x' ? isReserved(i - 1, j) || isReserved(i, j) : isReserved(i, j - 1) || isReserved(i, j))) return false;
    const e = axis === 'x' ? layout.ex : layout.ez;
    const k = axis === 'x' ? exIdx(i, j) : ezIdx(i, j);
    const d = edgeDefaults(kind);
    e.kind[k] = kind;
    e.hA[k] = o?.hA ?? d[0];
    e.hB[k] = o?.hB ?? d[1];
    if (o?.matNeg !== undefined) e.matNeg[k] = o.matNeg;
    if (o?.matPos !== undefined) e.matPos[k] = o.matPos;
    if (o?.trim !== undefined) e.trim[k] = o.trim;
    return true;
  };
  const wallRun = (axis: 'x' | 'z', line: number, from: number, to: number, kind: number, o?: EdgeOpts): void => {
    for (let c = from; c < to; c++) {
      if (axis === 'x') setEdge('x', line, c, kind, o);
      else setEdge('z', c, line, kind, o);
    }
  };

  return {
    key,
    layout,
    gi0: key.cx * N,
    gj0: key.cz * N,
    isReserved,
    isFrozenEdge,
    setEdge,
    getEdge(axis, i, j) {
      if (!inEdges(axis, i, j)) return EdgeKind.OPEN;
      return axis === 'x' ? layout.ex.kind[exIdx(i, j)] : layout.ez.kind[ezIdx(i, j)];
    },
    wallRun,
    rectWalls(li0, lj0, li1, lj1, kind, o) {
      wallRun('x', li0, lj0, lj1, kind, o);
      wallRun('x', li1, lj0, lj1, kind, o);
      wallRun('z', lj0, li0, li1, kind, o);
      wallRun('z', lj1, li0, li1, kind, o);
    },
    setCells(li0, lj0, li1, lj1, p, force) {
      for (let lj = Math.max(0, lj0); lj < Math.min(N, lj1); lj++) {
        for (let li = Math.max(0, li0); li < Math.min(N, li1); li++) {
          const c = cellIdx(li, lj);
          if (!force && (layout.flags[c] & CellFlag.RESERVED) !== 0) continue;
          if (p.floorCm !== undefined) layout.floorCm[c] = p.floorCm;
          if (p.ceilCm !== undefined) layout.ceilCm[c] = p.ceilCm;
          if (p.waterCm !== undefined) layout.waterCm[c] = p.waterCm;
          if (p.blockCm !== undefined) layout.blockCm[c] = p.blockCm;
          if (p.floorMat !== undefined) layout.floorMat[c] = p.floorMat;
          if (p.ceilMat !== undefined) layout.ceilMat[c] = p.ceilMat;
          if (p.ceilKind !== undefined) layout.ceilKind[c] = p.ceilKind;
          if (p.cellZone !== undefined) layout.cellZone[c] = p.cellZone;
          if (p.flagsClear !== undefined) layout.flags[c] &= ~p.flagsClear;
          if (p.flagsSet !== undefined) layout.flags[c] |= p.flagsSet;
        }
      }
    },
    hasFlag,
    addSolid(s) {
      const id = layout.solids.length + 1; // chunk-assigned (no shared global ids, see core ChunkGrid.addSolid)
      layout.solids.push({ ...s, id } as Solid);
      return id;
    },
    addFixture(f, fk) {
      let id: number, fseed: number;
      if ('id' in fk) {
        id = fk.id >>> 0;
        fseed = fk.seed;
      } else {
        id = fixtureId(seed, key.s, fk.latticeI, fk.latticeJ, f.kind);
        fseed = fixtureSeed(id);
      }
      layout.fixtures.push({ ...f, id, seed: fseed, dynamic: false });
      return id;
    },
    addProp(p) { layout.props.push(p); },
    addDecal(d) { layout.decals.push(d); },
    addWater(w) { layout.water.push(w); },
    addLeak(l) { layout.leaks.push(l); },
    addEmitter(kind, x, y, z, gain) {
      const eseed = hash6(seed, SALT.EMITTER, key.s, gcm(x, key.cx), gcm(z, key.cz), kind * 1024 + Math.round(y * 100));
      layout.emitters.push({ kind, x, y, z, gain, seed: eseed });
    },
    addVignette(kind, x, z, yaw) {
      const vseed = hash6(seed, SALT.VIGNETTE, key.s, gcm(x, key.cx), gcm(z, key.cz), kind);
      layout.vignettes.push({ kind, x, z, yaw, seed: vseed });
    },
    addAnomaly(kind, x, z, r) {
      const aseed = hash6(seed, SALT.ANOMALY, key.s, gcm(x, key.cx), gcm(z, key.cz), kind);
      layout.anomalies.push({ kind, x, z, r, seed: aseed });
    },
    addStructure(kind, i0, j0, i1, j1, rot, portal) {
      // TOWER / ELEVATOR: bakeGroup = id = portal.towerId (storey-free; WP4 passes (site.id & 0x7fffffff) | 1).
      const isolated = (kind === StructureKind.TOWER || kind === StructureKind.ELEVATOR) && portal !== null && portal.towerId !== 0;
      const bakeGroup = isolated ? portal.towerId : 0;
      const id = isolated ? bakeGroup : hash6(seed, SALT.CHUNK, key.s, key.cx, key.cz, 4096 + layout.structures.length);
      layout.structures.push({ id, kind, bakeGroup, i0, j0, i1, j1, rot, portal });
      return id;
    },
    addLandmark(kind, i0, j0, i1, j1) {
      layout.landmarks.push({ kind, i0, j0, i1, j1 });
      for (let lj = Math.max(0, j0); lj < Math.min(N, j1); lj++) {
        for (let li = Math.max(0, i0); li < Math.min(N, i1); li++) layout.flags[cellIdx(li, lj)] |= CellFlag.LANDMARK;
      }
    },
    cellCenter(li, lj) {
      return [(li + 0.5) * CELL, (lj + 0.5) * CELL];
    },
    freezeSeams() {
      frozen = true;
    },
    setSeam(side, s) {
      if (frozen) throw new Error('ChunkGrid.setSeam: seams are frozen');
      const e = side === 'W' || side === 'E' ? layout.ex : layout.ez;
      const line = side === 'W' || side === 'N' ? 0 : N;
      for (let c = 0; c < N; c++) {
        const k = side === 'W' || side === 'E' ? exIdx(line, c) : ezIdx(c, line);
        e.kind[k] = s.kind[c]; e.hA[k] = s.hA[c]; e.hB[k] = s.hB[c];
        e.matNeg[k] = s.matNeg[c]; e.matPos[k] = s.matPos[c]; e.trim[k] = s.trim[c];
      }
    },
  };
}
