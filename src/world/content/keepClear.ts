// src/world/content/keepClear.ts — cells content placement must keep clear (WP4).
//
// keepClear = cells within Chebyshev 1 of: walkable seam edges (the ports), DOORWAY / HEADER / ARCH edges,
// artery lanes, and tower / elevator exit cells. Props, vignettes and pits never use these cells.

import { CHUNK_CELL_COUNT } from '../../core/index.ts';
import { CellFlag, EdgeKind, StructureKind, exIdx, ezIdx } from '../../core/index.ts';
import type { ChunkLayout } from '../../core/index.ts';
import { elevatorExitCell } from '../structures/elevator.ts';
import { towerExitCell } from '../structures/tower.ts';
import { edgeKindPassable, inChunk, N } from './util.ts';

const isOpening = (k: number): boolean => k === EdgeKind.DOORWAY || k === EdgeKind.HEADER || k === EdgeKind.ARCH;

/** CHUNK_CELL_COUNT entries, 1 = keep clear. */
export function computeKeepClear(l: ChunkLayout): Uint8Array {
  const out = new Uint8Array(CHUNK_CELL_COUNT);
  const mark = (li: number, lj: number): void => {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = li + di, b = lj + dj;
        if (inChunk(a, b)) out[b * N + a] = 1;
      }
    }
  };
  // x-edges (line x = i*CELL between (i-1, lj) and (i, lj))
  for (let lj = 0; lj < N; lj++) {
    for (let i = 0; i <= N; i++) {
      const k = exIdx(i, lj);
      const kind = l.ex.kind[k];
      const seam = i === 0 || i === N;
      if ((seam && edgeKindPassable(kind, l.ex.hA[k])) || isOpening(kind)) {
        mark(i - 1, lj);
        mark(i, lj);
      }
    }
  }
  // z-edges (line z = j*CELL between (li, j-1) and (li, j))
  for (let j = 0; j <= N; j++) {
    for (let li = 0; li < N; li++) {
      const k = ezIdx(li, j);
      const kind = l.ez.kind[k];
      const seam = j === 0 || j === N;
      if ((seam && edgeKindPassable(kind, l.ez.hA[k])) || isOpening(kind)) {
        mark(li, j - 1);
        mark(li, j);
      }
    }
  }
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) if ((l.flags[c] & CellFlag.ARTERY) !== 0) mark(c & 31, c >> 5);
  for (const s of l.structures) {
    if (s.kind === StructureKind.TOWER) {
      const e = towerExitCell({ id: s.id, cx: l.key.cx, cz: l.key.cz, i0: s.i0, j0: s.j0, rot: s.rot, endless: false });
      mark(e.li, e.lj);
    } else if (s.kind === StructureKind.ELEVATOR) {
      const e = elevatorExitCell({ id: s.id, cx: l.key.cx, cz: l.key.cz, i0: s.i0, j0: s.j0, rot: s.rot });
      mark(e.li, e.lj);
    }
  }
  return out;
}
