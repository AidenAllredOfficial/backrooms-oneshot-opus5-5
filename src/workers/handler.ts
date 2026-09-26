// src/workers/handler.ts — the PURE worker request handler (WP10). Used by chunk.worker.ts and by Node tests.
// Transfer rule (core/worker.ts): never transfer a buffer still referenced by HandlerState (LRU layouts, caches).
//
//  init    store options, gen = createWorldGen(opts); clears the layout LRU, the neighbourhood cache and the bake cache
//  layout  LRU generateChunk + buildChunkCollision; responds with cloneLayout(l) (the LRU instance is never sent)
//  build   9 layouts (LRU) -> makeNeighborhood -> buildTile -> bakeTile(preview); everything transferred
//  bake    buildTileSurfaces -> bakeTile(full, st.bakeCache)
//  find / spawn / ascii   delegate to gen
// Exceptions become { t: 'error', message, stack }. With init.validate, validate* violations become an error too.

import type { TileKey } from '../core/grid.ts';
import { chunkKeyStr, tileKeyStr } from '../core/grid.ts';
import { cloneLayout, layoutTransferables, type ChunkLayout } from '../core/layout.ts';
import type { ChunkCollision, LightmapData, MeshBuffers, TileMesh } from '../core/mesh.ts';
import type { HandlerResult, WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';
import type { LayoutNeighborhood, WorldGen } from '../core/world.ts';
import { bakeTile, createBakeCache, type BakeCache } from '../bake/index.ts';
import { buildTile } from '../mesh/buildTile.ts';
import { buildTileSurfaces } from '../mesh/surfaces.ts';
import { buildChunkCollision } from '../player/collisionBuild.ts';
import { createWorldGen } from '../world/worldgen.ts';
import { getLayout, NeighborhoodCache } from './layoutCache.ts';
import { validateBake, validateBuild, validateLayoutPayload } from './validatePayload.ts';

export interface HandlerState { init: WorkerInit | null; gen: WorldGen | null; layouts: Map<string, ChunkLayout> /* LRU 96, never transferred */; bakeCache: BakeCache }

export function createHandlerState(): HandlerState {
  return { init: null, gen: null, layouts: new Map(), bakeCache: createBakeCache() };
}

/** Neighbourhood cache per state (kept outside HandlerState so its shape stays the frozen contract). */
const nbCaches = new WeakMap<HandlerState, NeighborhoodCache>();
function nbCache(st: HandlerState): NeighborhoodCache {
  let c = nbCaches.get(st);
  if (!c) nbCaches.set(st, (c = new NeighborhoodCache()));
  return c;
}

/** Test hook: worker-held caches outside the frozen HandlerState shape (tests assert no transferred buffer is
 * referenced by any of them). */
export function handlerCachesOf(st: HandlerState): readonly unknown[] {
  return [nbCaches.get(st) ?? null];
}

function neighborhoodOf(st: HandlerState, gen: WorldGen, t: TileKey): LayoutNeighborhood {
  return nbCache(st).get(st.layouts, gen, t);
}

const now = (): number => performance.now(); // timing stats only (allowed in src/workers, §3.3)

// ---------------------------------------------------------------- transfer lists

type Typed = Float32Array | Int8Array | Uint8Array | Uint16Array | Int16Array | Uint32Array;

class TransferList {
  readonly buffers: ArrayBuffer[] = [];
  private readonly seen = new Set<ArrayBuffer>();

  /** Returns an array that exclusively owns its ArrayBuffer (copying partial views, which may alias a producer's
   * scratch pool), and records that buffer for transfer. Zero-length buffers are cloned, not transferred. */
  own<T extends Typed>(a: T, what: string): T {
    const buf = a.buffer as ArrayBuffer;
    if ((buf as { detached?: boolean }).detached === true) {
      throw new Error(`transfer: ${what} references a detached ArrayBuffer (a producer returned an array it already handed out)`);
    }
    let out = a;
    if (a.byteOffset !== 0 || a.byteLength !== buf.byteLength || (typeof SharedArrayBuffer !== 'undefined' && (buf as unknown) instanceof SharedArrayBuffer)) {
      out = a.slice() as T;
    }
    const ob = out.buffer as ArrayBuffer;
    if (ob.byteLength > 0 && !this.seen.has(ob)) {
      this.seen.add(ob);
      this.buffers.push(ob);
    }
    return out;
  }

  add(b: ArrayBuffer): void {
    if (b.byteLength > 0 && !this.seen.has(b)) {
      this.seen.add(b);
      this.buffers.push(b);
    }
  }
}

function ownMesh(m: MeshBuffers, tl: TransferList, name: string): MeshBuffers {
  return {
    position: tl.own(m.position, `${name}.position`), normal: tl.own(m.normal, `${name}.normal`), uv: tl.own(m.uv, `${name}.uv`),
    lmUv: tl.own(m.lmUv, `${name}.lmUv`), layer: tl.own(m.layer, `${name}.layer`), flags: tl.own(m.flags, `${name}.flags`),
    tint: tl.own(m.tint, `${name}.tint`), emit: tl.own(m.emit, `${name}.emit`), aux: tl.own(m.aux, `${name}.aux`),
    index: tl.own(m.index, `${name}.index`),
    vertexCount: m.vertexCount, indexCount: m.indexCount,
    bounds: [m.bounds[0], m.bounds[1], m.bounds[2], m.bounds[3], m.bounds[4], m.bounds[5]],
  };
}

function ownTileMesh(m: TileMesh, tl: TransferList): TileMesh {
  return {
    tileKey: m.tileKey, zone: m.zone,
    shell: ownMesh(m.shell, tl, 'shell'),
    props: m.props ? ownMesh(m.props, tl, 'props') : null,
    water: m.water ? ownMesh(m.water, tl, 'water') : null,
    decals: m.decals ? ownMesh(m.decals, tl, 'decals') : null,
    atlas: { ...m.atlas },
    dynLights: m.dynLights.map((d) => (d === null ? null : { ...d, color: [d.color[0], d.color[1], d.color[2]] })),
    tris: m.tris,
  };
}

function ownLightmap(lm: LightmapData, tl: TransferList): LightmapData {
  const v = lm.volume;
  return {
    tileKey: lm.tileKey, variant: lm.variant, width: lm.width, height: lm.height, chartHash: lm.chartHash,
    irr: tl.own(lm.irr, 'irr'), dir: tl.own(lm.dir, 'dir'), flick: lm.flick ? tl.own(lm.flick, 'flick') : null,
    mask: tl.own(lm.mask, 'mask'), emission: tl.own(lm.emission, 'emission'),
    volume: {
      a: tl.own(v.a, 'volume.a'), b: tl.own(v.b, 'volume.b'), c: v.c ? tl.own(v.c, 'volume.c') : null,
      wallMask: tl.own(v.wallMask, 'volume.wallMask'),
    },
    stats: { ...lm.stats },
  };
}

function ownCollision(c: ChunkCollision, tl: TransferList): ChunkCollision {
  return {
    chunkKey: c.chunkKey,
    boxes: tl.own(c.boxes, 'collision.boxes'), boxFlags: tl.own(c.boxFlags, 'collision.boxFlags'),
    cellStart: tl.own(c.cellStart, 'collision.cellStart'), cellBoxes: tl.own(c.cellBoxes, 'collision.cellBoxes'),
    ramps: tl.own(c.ramps, 'collision.ramps'),
  };
}

function failIfInvalid(what: string, errs: string[]): void {
  if (errs.length > 0) throw new Error(`validatePayload(${what}): ${errs.join('; ')}`);
}

// ---------------------------------------------------------------- dispatch

export function handleRequest(req: WorkerRequest, st: HandlerState): HandlerResult {
  try {
    if (req.t === 'init') {
      st.init = req.init;
      st.gen = createWorldGen(req.init.opts);
      st.layouts.clear();
      st.bakeCache.clear();
      nbCache(st).clear();
      return { res: { t: 'ready', job: req.job }, transfer: [] };
    }
    const init = st.init, gen = st.gen;
    if (!init || !gen) throw new Error(`handleRequest(${req.t}): worker not initialised (no 'init' received)`);
    const tl = new TransferList();
    let res: WorkerResponse;
    switch (req.t) {
      case 'layout': {
        const t0 = now();
        const l = getLayout(st.layouts, gen, req.key);
        const collision = ownCollision(buildChunkCollision(l), tl);
        const layout = cloneLayout(l); // NEVER the LRU instance: transfer detaches its arrays
        const ms = now() - t0;
        if (init.validate) failIfInvalid(`layout ${chunkKeyStr(req.key)}`, validateLayoutPayload(layout, collision));
        for (const b of layoutTransferables(layout)) tl.add(b);
        res = { t: 'layout', job: req.job, layout, collision, ms };
        break;
      }
      case 'build': {
        const t0 = now();
        const nb = neighborhoodOf(st, gen, req.key);
        const t1 = now();
        const built = buildTile(nb, req.key, init.bake.tpc);
        const t2 = now();
        const preview = bakeTile(nb, req.key, built.surfaces, 'preview', init.bake, init.bakeTerm, st.bakeCache);
        const t3 = now();
        if (init.validate) failIfInvalid(`build ${tileKeyStr(req.key)}`, validateBuild(built.mesh, preview));
        const mesh = ownTileMesh(built.mesh, tl);
        const lightmap = ownLightmap(preview, tl);
        res = { t: 'build', job: req.job, mesh, lightmap, ms: { gen: t1 - t0, mesh: t2 - t1, bake: t3 - t2 } };
        break;
      }
      case 'bake': {
        const t0 = now();
        const nb = neighborhoodOf(st, gen, req.key);
        const surfaces = buildTileSurfaces(nb, req.key, init.bake.tpc);
        const full = bakeTile(nb, req.key, surfaces, 'full', init.bake, init.bakeTerm, st.bakeCache);
        const ms = now() - t0;
        if (init.validate) failIfInvalid(`bake ${tileKeyStr(req.key)}`, validateBake(full, surfaces.hash));
        res = { t: 'bake', job: req.job, lightmap: ownLightmap(full, tl), ms };
        break;
      }
      case 'find':
        res = { t: 'find', job: req.job, result: gen.findNearest(req.query, req.from, req.maxChunks) };
        break;
      case 'spawn':
        res = { t: 'spawn', job: req.job, result: gen.findSpawn(req.s) };
        break;
      case 'ascii':
        res = { t: 'ascii', job: req.job, text: gen.asciiMap(req.s, req.cx0, req.cz0, req.cx1, req.cz1) };
        break;
      default: {
        const bad: { t?: unknown } = req;
        throw new Error(`handleRequest: unknown request type '${String(bad.t)}'`);
      }
    }
    return { res, transfer: tl.buffers };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { res: { t: 'error', job: req.job, message: err.message, stack: err.stack ?? '' }, transfer: [] };
  }
}
