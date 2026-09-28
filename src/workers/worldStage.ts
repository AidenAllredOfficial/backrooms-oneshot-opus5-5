// src/workers/worldStage.ts — the WORLD stage of the worker: everything the handler's init / layout / spawn / find
// branches compute with. PURE.
//
// tools/viteTileCache.ts bundles this entry on its own (tree-shaken, minified) and hashes the result into the world
// cache hash (__BR_TILE_CACHE_WORLD__), which keys the layout / spawn / find entries of the tool-run result cache
// (tileCache.ts). A baker-only edit therefore keeps those entries warm, while any edit that can change a layout, the
// collision or a spawn / find answer changes this bundle. handler.ts must import these symbols from here and nowhere
// else (tests/workers/worldStage.test.ts checks it): a world symbol imported around this module would be missing from
// the world hash, and a stale layout could be served. The handler's own code around these calls (the response
// assembly of its layout / spawn / find branches) is hashed verbatim into the world hash (tools/viteTileCache.ts
// WORLD_VERBATIM_FILES).

export { createWorldGen } from '../world/worldgen.ts';
export { getLayout } from './layoutCache.ts';
export { buildChunkCollision } from '../player/collisionBuild.ts';
export { cloneLayout, layoutTransferables } from '../core/layout.ts';
