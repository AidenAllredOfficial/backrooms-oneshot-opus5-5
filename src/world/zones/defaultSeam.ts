// src/world/zones/defaultSeam.ts — default PATTERN seam used when a generator has no seamPattern (WP1).
//
// Alternating WALL runs U(2,10) and OPEN runs U(1,4), starting with a random phase. With p 0.25 the seam is
// "mostly open" instead: WALL runs U(1,3), OPEN runs U(3,8). Soft district BOUNDARY seams use the mostly-open
// variant directly (patternRuns). Post-rules (artery lanes, > 12 wall runs, port guarantee) are applied by
// world/seams.ts, not here.

import { CHUNK_CELLS } from '../../core/constants.ts';
import { EdgeKind } from '../../core/ids.ts';
import type { Rng } from '../../core/rng.ts';
import type { SeamEdges } from '../../core/world.ts';

/** Fills `kind` (32 entries) with alternating WALL / OPEN runs; random phase (start kind and partial first run). */
export function patternRuns(rng: Rng, kind: Uint8Array, wallLo: number, wallHi: number, openLo: number, openHi: number): void {
  let wall = rng.chance(0.5);
  let len = wall ? rng.int(wallLo, wallHi) : rng.int(openLo, openHi);
  len -= rng.int(0, len - 1); // random phase inside the first run (>= 1 cell remains)
  let i = 0;
  while (i < CHUNK_CELLS) {
    const k = wall ? EdgeKind.WALL : EdgeKind.OPEN;
    for (let n = 0; n < len && i < CHUNK_CELLS; n++) kind[i++] = k;
    wall = !wall;
    len = wall ? rng.int(wallLo, wallHi) : rng.int(openLo, openHi);
  }
}

/** Mostly-open PATTERN: WALL runs U(1,3), OPEN runs U(3,8). */
export function mostlyOpenSeam(rng: Rng): SeamEdges {
  const kind = new Uint8Array(CHUNK_CELLS);
  patternRuns(rng, kind, 1, 3, 3, 8);
  return { kind, hA: new Int16Array(CHUNK_CELLS), hB: new Int16Array(CHUNK_CELLS) };
}

export function defaultPatternSeam(rng: Rng): SeamEdges {
  const kind = new Uint8Array(CHUNK_CELLS);
  if (rng.chance(0.25)) patternRuns(rng, kind, 1, 3, 3, 8);
  else patternRuns(rng, kind, 2, 10, 1, 4);
  return { kind, hA: new Int16Array(CHUNK_CELLS), hB: new Int16Array(CHUNK_CELLS) };
}
