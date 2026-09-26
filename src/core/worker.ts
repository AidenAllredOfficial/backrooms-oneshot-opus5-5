// src/core/worker.ts — worker protocol. The worker entry (WP10 workers/chunk.worker.ts) is a thin shell around
// the PURE handler `handleRequest(req, state)` (WP10 workers/handler.ts) which also runs in Node tests.

import type { ChunkKey, TileKey } from './grid.ts';
import type { ChunkLayout } from './layout.ts';
import type { ChunkCollision, LightmapData, TileMesh } from './mesh.ts';
import type { BakeQuality } from './quality.ts';
import type { SpawnPoint, WorldGenOptions } from './world.ts';
import type { StoreyId } from './ids.ts';

export type BakeTerm = 'all' | 'direct' | 'indirect'; // debug: bake only one term (leak / cornell QA)

export interface WorkerInit {
  opts: WorldGenOptions;
  bake: BakeQuality;
  bakeTerm: BakeTerm;
  validate: boolean; // dev: run validatePayload before posting
}

export type WorkerRequest =
  | { t: 'init'; job: number; init: WorkerInit }
  | { t: 'layout'; job: number; key: ChunkKey } // -> layout + collision
  | { t: 'build'; job: number; key: TileKey } // -> tile meshes + PREVIEW lightmap (inline, so no tile is ever unlit)
  | { t: 'bake'; job: number; key: TileKey } // -> FULL lightmap (same atlas as build; chartHash must match)
  | { t: 'find'; job: number; query: string; from: { s: StoreyId; x: number; z: number }; maxChunks: number }
  | { t: 'spawn'; job: number; s: StoreyId }
  | { t: 'ascii'; job: number; s: StoreyId; cx0: number; cz0: number; cx1: number; cz1: number };

export type WorkerResponse =
  | { t: 'ready'; job: number }
  | { t: 'layout'; job: number; layout: ChunkLayout /* cloneLayout() of the LRU entry */; collision: ChunkCollision; ms: number }
  | { t: 'build'; job: number; mesh: TileMesh; lightmap: LightmapData; ms: { gen: number; mesh: number; bake: number } }
  | { t: 'bake'; job: number; lightmap: LightmapData; ms: number }
  | { t: 'find'; job: number; result: SpawnPoint | null }
  | { t: 'spawn'; job: number; result: SpawnPoint }
  | { t: 'ascii'; job: number; text: string }
  | { t: 'error'; job: number; message: string; stack: string };

/** `transfer` MUST NOT contain any buffer still referenced by HandlerState (LRU layouts, caches): transfer
 * detaches it. Only freshly built payloads (meshes, lightmaps, collision, cloneLayout copies) are transferred.
 * tests/integration/pipeline.test.ts passes every response through structuredClone(res, { transfer }). */
export interface HandlerResult { res: WorkerResponse; transfer: ArrayBuffer[] }
