// src/bake/cache.ts — per-worker bake cache (WP7). Re-exported from bake/index.ts and bake/context.ts.
//
// Holds, per WORLD chunk (LRU of 16 chunks), the two expensive quantities that are pure functions of world
// position and light identity:
//   - visibility bitsets: for every (cell of the chunk, light) the visibility of the light centre from the cell
//     centre at 5 heights (bits 0..4, see job.ts VIS_*; bit 7 = computed);
//   - patch irradiance: direct irradiance (RGB, lux) of world-anchored floor / ceiling / wall patches.
// Because both are computed in exact halo arithmetic (see util.ts), bakeTile output is byte-identical with or
// without the cache (tested). The cache is never transferred between threads.

/** Opaque per-worker cache (visibility bitsets + patch radiance per chunk, LRU 16 chunks). Never transferred.
 * bakeTile output is byte-identical with or without it (tested). */
export interface BakeCache { readonly chunks: number; clear(): void }

export const CACHE_CHUNKS = 16;

/** Patch irradiance table of one chunk: key -> offset into `e` (records of patches.ts PATCH_STRIDE floats). */
export interface PatchTable {
  map: Map<number, number>;
  e: Float32Array<ArrayBuffer>;
  n: number; // used floats
}

export function createPatchTable(): PatchTable {
  return { map: new Map(), e: new Float32Array(7 * 256), n: 0 };
}

export interface ChunkCacheEntry {
  /** light key -> Uint8Array(1024) of visibility bits for the chunk's cells */
  vis: Map<string, Uint8Array>;
  patches: PatchTable;
}

export interface BakeCacheImpl extends BakeCache {
  /** Get (creating) the entry of a world chunk and mark it most recently used. */
  entry(chunkKey: string): ChunkCacheEntry;
}

export function createBakeCache(): BakeCache {
  const map = new Map<string, ChunkCacheEntry>();
  const impl: BakeCacheImpl = {
    get chunks(): number { return map.size; },
    clear(): void { map.clear(); },
    entry(chunkKey: string): ChunkCacheEntry {
      let e = map.get(chunkKey);
      if (e) {
        map.delete(chunkKey); // re-insert = most recently used (Map keeps insertion order)
      } else {
        e = { vis: new Map(), patches: createPatchTable() };
        while (map.size >= CACHE_CHUNKS) map.delete(map.keys().next().value as string);
      }
      map.set(chunkKey, e);
      return e;
    },
  };
  return impl;
}

/** Internal accessor (the public type is opaque). Returns null for foreign objects. */
export function cacheImpl(c: BakeCache | undefined | null): BakeCacheImpl | null {
  if (!c) return null;
  const x = c as Partial<BakeCacheImpl>;
  return typeof x.entry === 'function' ? (c as BakeCacheImpl) : null;
}
