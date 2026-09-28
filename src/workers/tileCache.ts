// src/workers/tileCache.ts — persistent cache of worker results for tool runs (tools/shoot.mjs, tools/qa.mjs).
// Layouts, tile builds, full bakes and spawn / find queries are pure functions of (worker code, WorkerInit world and
// bake settings, request), so a result computed by an earlier shot or QA run can be served again. The dev server
// stores the entries (tools/viteTileCache.ts: GET / PUT /__tilecache/<ns>/<key>). Disabled (empty hash) outside tool
// runs: the game never talks to the cache.
//
// Keys: SHA-1 over a code hash, the init and the request without its job id (canonical JSON: sorted keys).
//  - world requests (layout, spawn, find): __BR_TILE_CACHE_WORLD__, the hash of the bundled world stage
//    (worldStage.ts), and the world options only: a baker edit or a quality change keeps them warm.
//  - tile requests (build, bake): __BR_TILE_CACHE__, the hash of the whole bundled worker, and the world options, bake
//    quality and bake term.
// Both hashes come from tree-shaken, minified bundles, so comments, types and render-only code reached through a
// barrel never change them; any edit to code the worker runs does.
// URLs are namespaced by the first 12 hex digits of the code hash the key uses (the server evicts stale namespaces
// first). A 'bake' miss falls back to the 'build lighting:full' entry of the same tile (the same lightmap bytes:
// tests/workers/handler.test.ts); the streamer's chartHash check still guards the pair.
// PUTs send the raw entry (X-BR-Raw: 1): the server gzips it off every browser thread (zlib level 1). Without the
// server features define (__BR_TILE_CACHE_FEATURES__), the worker gzips itself and uses flat URLs, as before.
//
// Entry format: [u32 header length][header JSON][pad to 8][typed-array bytes, each 8-aligned]. The header is the
// response with every typed array replaced by { $ta: constructor, o: offset, n: byte length } and non-finite
// numbers by { $n: 'NaN' | 'Infinity' | '-Infinity' }. Decoded arrays get their own ArrayBuffers (consumers may use
// `.buffer`), so a hit transfers exactly like a computed result.

import type { WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';

declare const __BR_TILE_CACHE__: string;
declare const __BR_TILE_CACHE_WORLD__: string;
declare const __BR_TILE_CACHE_FEATURES__: string;
/** hash of the bundled worker, '' = cache disabled */
export const CACHE_CODE: string = typeof __BR_TILE_CACHE__ === 'string' ? __BR_TILE_CACHE__ : '';
/** hash of the bundled world stage (layout / spawn / find keys); the worker hash when the server does not send it */
export const CACHE_WORLD: string = typeof __BR_TILE_CACHE_WORLD__ === 'string' && __BR_TILE_CACHE_WORLD__ !== '' ? __BR_TILE_CACHE_WORLD__ : CACHE_CODE;

/** What the server's middleware accepts: raw PUTs (it gzips) and namespaced URLs. */
export interface CacheFeatures { raw: boolean; ns: boolean }
export function parseFeatures(s: string | undefined): CacheFeatures {
  try {
    const f = JSON.parse(s ?? '{}') as { raw?: unknown; ns?: unknown };
    return { raw: f.raw === 1 || f.raw === true, ns: f.ns === 1 || f.ns === true };
  } catch {
    return { raw: false, ns: false };
  }
}
export const CACHE_FEATURES: CacheFeatures = parseFeatures(typeof __BR_TILE_CACHE_FEATURES__ === 'string' ? __BR_TILE_CACHE_FEATURES__ : undefined);

type Cacheable = Extract<WorkerRequest, { t: 'layout' | 'build' | 'bake' | 'spawn' | 'find' }>;
export const isCacheable = (r: WorkerRequest): r is Cacheable =>
  r.t === 'layout' || r.t === 'build' || r.t === 'bake' || r.t === 'spawn' || r.t === 'find';
/** Requests answered by the world stage alone (keyed by the world hash, independent of the bake settings). */
export const isWorldRequest = (r: WorkerRequest): boolean => r.t === 'layout' || r.t === 'spawn' || r.t === 'find';

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
};

export function encodeEntry(value: unknown): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let off = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const o = off;
      chunks.push(bytes);
      off += (bytes.byteLength + 7) & ~7;
      return { $ta: v.constructor.name, o, n: bytes.byteLength };
    }
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = walk(x);
    return out;
  };
  const header = new TextEncoder().encode(JSON.stringify(walk(value)));
  const base = (4 + header.byteLength + 7) & ~7;
  const out = new Uint8Array(base + off);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let o = base;
  for (const c of chunks) { out.set(c, o); o += (c.byteLength + 7) & ~7; }
  return out;
}

export function decodeEntry(bytes: Uint8Array): unknown {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen))) as unknown;
  const base = (4 + hlen + 7) & ~7;
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const r = v as Record<string, unknown>;
    if (typeof r.$n === 'string') return Number(r.$n);
    if (typeof r.$ta === 'string') {
      const C = TYPED[r.$ta];
      if (!C) throw new Error(`tileCache: unknown typed array ${r.$ta}`);
      const start = bytes.byteOffset + base + (r.o as number);
      return new C(bytes.buffer.slice(start, start + (r.n as number)) as ArrayBuffer);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(r)) out[k] = walk(x);
    return out;
  };
  return walk(header);
}

/** Every ArrayBuffer under `v` (the transfer list of a decoded entry). */
export function buffersOf(v: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (v === null || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) { out.push(v.buffer as ArrayBuffer); return out; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) buffersOf(x, out);
  return out;
}

/** JSON with object keys sorted at every level (key order of a request object never changes its key). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return x;
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
  });
}

/** Code hashes a key is built from (the defines by default; tests pass their own). */
export interface CacheCodes { tile: string; world: string }
const DEFAULT_CODES: CacheCodes = { tile: CACHE_CODE, world: CACHE_WORLD };

/** The code hash a request's key uses: the world hash for layout / spawn / find, the worker hash for build / bake. */
export const codeOf = (req: WorkerRequest, codes: CacheCodes = DEFAULT_CODES): string => (isWorldRequest(req) ? codes.world : codes.tile);

/** The text a request's key hashes (exported for tests: which inputs a key depends on). */
export function keyText(init: WorkerInit, req: Cacheable, codes: CacheCodes = DEFAULT_CODES): string {
  const { job: _job, ...r } = req;
  void _job;
  return isWorldRequest(req)
    ? canonicalJson([codes.world, init.opts, r])
    : canonicalJson([codes.tile, init.opts, init.bake, init.bakeTerm, r]);
}

export async function cacheKey(init: WorkerInit, req: Cacheable, codes: CacheCodes = DEFAULT_CODES): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(keyText(init, req, codes)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Namespace of a key: the first 12 hex digits of the code hash it was built from. */
export const nsOf = (code: string): string => code.slice(0, 12);

/** URL path of an entry ('' namespace: the legacy flat layout). */
export const entryPath = (ns: string, key: string): string => (ns ? `/__tilecache/${ns}/${key}` : `/__tilecache/${key}`);

const url = (ns: string, key: string): string => new URL(entryPath(ns, key), self.location.origin).href;
/** Absolute URL of an entry (the writer worker PUTs to it). */
export const entryUrl = (a: CacheAddr): string => url(a.ns, a.key);

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** A cache address: the key and its namespace ('' without the ns feature). */
export interface CacheAddr { ns: string; key: string }

export async function cacheAddr(init: WorkerInit, req: Cacheable): Promise<CacheAddr> {
  return { ns: CACHE_FEATURES.ns ? nsOf(codeOf(req)) : '', key: await cacheKey(init, req) };
}

/** The cached response at `a` (its job id replaced), or null on a miss / any error. */
export async function cacheGet(a: CacheAddr, job: number): Promise<WorkerResponse | null> {
  try {
    const r = await fetch(url(a.ns, a.key));
    if (!r.ok) return null;
    const v = decodeEntry(await pipe(new Uint8Array(await r.arrayBuffer()), new DecompressionStream('gzip'))) as WorkerResponse;
    v.job = job;
    return v;
  } catch {
    return null;
  }
}

/** A 'bake' answered from a cached 'build lighting:full' of the same tile (the same full lightmap). */
export function bakeFromBuild(hit: WorkerResponse, job: number): WorkerResponse | null {
  if (hit.t !== 'build' || hit.lightmap.variant !== 'full') return null;
  return { t: 'bake', job, lightmap: hit.lightmap, ms: hit.ms.bake };
}

/** Lookup with the 'bake' -> 'build lighting:full' fallback. */
export async function cacheLookup(init: WorkerInit, req: Cacheable, a: CacheAddr): Promise<WorkerResponse | null> {
  const hit = await cacheGet(a, req.job);
  if (hit && hit.t === req.t) return hit;
  if (req.t !== 'bake') return null;
  const alt = await cacheGet(await cacheAddr(init, { t: 'build', job: 0, key: req.key, lighting: 'full' }), req.job);
  return alt ? bakeFromBuild(alt, req.job) : null;
}

/** Whether the writer PUTs raw entries (the server gzips them, zlib level 1) instead of gzipping them itself.
 * Measured on the cold set (docs/PERFORMANCE_AUDIT.md): the 4-7 MB raw uploads cost more than the gzip they save. */
export const WRITER_RAW = false;
/** Entries handed to a writer and not yet acknowledged; beyond this a result is not stored (a later miss). */
export const WRITER_MAX_PENDING = 8;

/** Store an encoded entry from this thread (fire and forget: a failed or refused PUT only costs a later miss). The
 * fallback when no writer worker can be started: the gzip then runs on the bake thread, as before. */
export async function cachePut(a: CacheAddr, encoded: Uint8Array<ArrayBuffer>): Promise<void> {
  try {
    await fetch(url(a.ns, a.key), { method: 'PUT', body: (await pipe(encoded, new CompressionStream('gzip'))) as BodyInit });
  } catch { /* the cache is an optimisation */ }
}

/** The bake worker's handle on its writer (cacheWriter.worker.ts). */
export interface CacheWriter { store(a: CacheAddr, encoded: Uint8Array<ArrayBuffer>): void; readonly pending: number }

/** A writer fed by `spawn()` (a Worker; null when workers cannot be nested here): store() transfers the entry to it
 * (zero-copy) and returns at once. Falls back to cachePut() on this thread. */
export function createCacheWriter(spawn: () => Worker | null): CacheWriter {
  let w: Worker | null | undefined;
  let pending = 0;
  const writer = (): Worker | null => {
    if (w !== undefined) return w;
    try { w = spawn(); } catch { w = null; }
    if (w) {
      w.onmessage = () => { pending = Math.max(0, pending - 1); };
      w.onerror = () => { w = null; pending = 0; };
    }
    return w;
  };
  return {
    get pending() { return pending; },
    store(a, encoded) {
      const ww = writer();
      if (!ww) { void cachePut(a, encoded); return; }
      if (pending >= WRITER_MAX_PENDING) return;
      pending++;
      const raw = WRITER_RAW && CACHE_FEATURES.raw;
      ww.postMessage({ url: entryUrl(a), bytes: encoded, raw }, [encoded.buffer]);
    },
  };
}
