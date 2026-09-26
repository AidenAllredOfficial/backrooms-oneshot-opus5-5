// src/workers/layoutCache.ts — per-worker layout LRU and neighbourhood cache (WP10). PURE.
// The LRU instances are NEVER transferred: layout responses transfer cloneLayout() copies (core/worker.ts rule).

import type { ChunkKey, TileKey } from '../core/grid.ts';
import { chunkKeyStr } from '../core/grid.ts';
import type { ChunkLayout } from '../core/layout.ts';
import type { LayoutNeighborhood, WorldGen } from '../core/world.ts';
import { makeNeighborhood } from '../world/neighborhood.ts';

// 48 layouts (~1 MB each with their typed arrays) per worker: a bake needs its chunk's 3x3 neighbourhood, and the
// soft chunk affinity keeps each worker on a few neighbourhoods; 96 x 8-12 workers held ~1 GB of layouts (R2 B9).
export const LAYOUT_LRU_SIZE = 48;
const NB_CACHE_SIZE = 4; // a chunk's 4 tiles (soft affinity) share one neighbourhood; keep a few chunks

/** LRU lookup (Map insertion order = recency). Generates and inserts missing layouts. */
export function getLayout(layouts: Map<string, ChunkLayout>, gen: WorldGen, k: ChunkKey): ChunkLayout {
  const ks = chunkKeyStr(k);
  let l = layouts.get(ks);
  if (l !== undefined) {
    layouts.delete(ks); // refresh recency
  } else {
    l = gen.generateChunk(k);
    while (layouts.size >= LAYOUT_LRU_SIZE) {
      const oldest = layouts.keys().next().value as string;
      layouts.delete(oldest);
    }
  }
  layouts.set(ks, l);
  return l;
}

interface NbEntry { key: string; layouts: ChunkLayout[]; nb: LayoutNeighborhood }

/** Small cache of 3x3 neighbourhoods keyed by centre chunk. An entry is valid only while all 9 layouts are the
 * very same LRU instances (a layout evicted and regenerated invalidates it), so results never depend on it. */
export class NeighborhoodCache {
  private entries: NbEntry[] = [];

  clear(): void { this.entries.length = 0; }

  /** The 9 layouts in makeNeighborhood order (index (dcz+1)*3 + (dcx+1)), fetched/generated via the LRU. */
  static gather(layouts: Map<string, ChunkLayout>, gen: WorldGen, t: ChunkKey | TileKey): ChunkLayout[] {
    const out: ChunkLayout[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push(getLayout(layouts, gen, { s: t.s, cx: t.cx + dx, cz: t.cz + dz }));
    return out;
  }

  get(layouts: Map<string, ChunkLayout>, gen: WorldGen, t: ChunkKey | TileKey): LayoutNeighborhood {
    const ls = NeighborhoodCache.gather(layouts, gen, t);
    const key = chunkKeyStr(t);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.key !== key) continue;
      let same = true;
      for (let k = 0; k < 9; k++) if (e.layouts[k] !== ls[k]) { same = false; break; }
      this.entries.splice(i, 1);
      if (same) {
        this.entries.push(e);
        return e.nb;
      }
      break;
    }
    const nb = makeNeighborhood(ls);
    this.entries.push({ key, layouts: ls, nb });
    while (this.entries.length > NB_CACHE_SIZE) this.entries.shift();
    return nb;
  }
}
