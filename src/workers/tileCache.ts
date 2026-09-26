// src/workers/tileCache.ts — persistent cache of worker results for tool runs (tools/shoot.mjs, tools/qa.mjs).
// Layouts, tile builds, full bakes and spawn / find queries are pure functions of (worker code, WorkerInit world and
// bake settings, request), so a result computed by an earlier shot or QA run can be served again. The dev server
// stores the entries (tools/viteTileCache.ts: GET / PUT /__tilecache/<key>, gzip files, size-capped LRU); the key is
// SHA-1 over the hash of the worker's source import graph (injected as __BR_TILE_CACHE__), the init and the request
// without its job id. An edit to any generator / mesher / baker file changes the hash, so stale entries are never
// served. Disabled (empty hash) outside tool runs: the game never talks to the cache.
//
// Entry format: [u32 header length][header JSON][pad to 8][typed-array bytes, each 8-aligned]. The header is the
// response with every typed array replaced by { $ta: constructor, o: offset, n: byte length } and non-finite
// numbers by { $n: 'NaN' | 'Infinity' | '-Infinity' }. Decoded arrays get their own ArrayBuffers (consumers may use
// `.buffer`), so a hit transfers exactly like a computed result.

import type { WorkerInit, WorkerRequest, WorkerResponse } from '../core/worker.ts';

declare const __BR_TILE_CACHE__: string;
/** hash of the worker source graph, '' = cache disabled */
export const CACHE_CODE: string = typeof __BR_TILE_CACHE__ === 'string' ? __BR_TILE_CACHE__ : '';

type Cacheable = Extract<WorkerRequest, { t: 'layout' | 'build' | 'bake' | 'spawn' | 'find' }>;
export const isCacheable = (r: WorkerRequest): r is Cacheable =>
  r.t === 'layout' || r.t === 'build' || r.t === 'bake' || r.t === 'spawn' || r.t === 'find';

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
};

export function encodeEntry(value: unknown): Uint8Array {
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

export async function cacheKey(init: WorkerInit, req: Cacheable): Promise<string> {
  const { job: _job, ...r } = req;
  void _job;
  const text = JSON.stringify([CACHE_CODE, init.opts, init.bake, init.bakeTerm, r]);
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const url = (key: string): string => new URL(`/__tilecache/${key}`, self.location.origin).href;

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The cached response for `key` (its job id replaced), or null on a miss / any error. */
export async function cacheGet(key: string, job: number): Promise<WorkerResponse | null> {
  try {
    const r = await fetch(url(key));
    if (!r.ok) return null;
    const v = decodeEntry(await pipe(new Uint8Array(await r.arrayBuffer()), new DecompressionStream('gzip'))) as WorkerResponse;
    v.job = job;
    return v;
  } catch {
    return null;
  }
}

/** Store an encoded entry (fire and forget: a failed PUT only costs a later miss). */
export async function cachePut(key: string, encoded: Uint8Array): Promise<void> {
  try {
    await fetch(url(key), { method: 'PUT', body: (await pipe(encoded, new CompressionStream('gzip'))) as BodyInit });
  } catch { /* the cache is an optimisation */ }
}
