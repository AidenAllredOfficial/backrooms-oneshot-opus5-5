// tests/workers/tileCache.test.ts — the worker result cache of tool runs: the entry codec, the keys and their code
// hashes (src/workers/tileCache.ts), and the server side (tools/viteTileCache.ts: bundle hashes, the raw-PUT gzip
// queue, namespaces and eviction order).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bakeQualityOf, QUALITY } from '../../src/core/quality.ts';
import type { WorkerInit, WorkerRequest } from '../../src/core/worker.ts';
import { createHandlerState, handleRequest } from '../../src/workers/handler.ts';
import {
  bakeFromBuild, buffersOf, canonicalJson, codeOf, decodeEntry, encodeEntry, entryPath, keyText, nsOf, parseFeatures,
} from '../../src/workers/tileCache.ts';
import {
  bundleHash, cacheHashes, createTileStore, PUT_INFLIGHT, TILE_ENTRY, tileCacheHandler, WORLD_ENTRY, workerCodeHash,
} from '../../tools/viteTileCache.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const init = (q: keyof typeof QUALITY = 'low'): WorkerInit => ({
  opts: { seed: 3, seedText: '3', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
  bake: bakeQualityOf(QUALITY[q]), bakeTerm: 'all', validate: false,
});

describe('cache entry codec', () => {
  it('round-trips a real build response exactly, typed arrays in their own buffers', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const { res } = handleRequest({ t: 'build', job: 2, key: { s: 0, cx: 0, cz: 0, q: 0 } }, st);
    const back = decodeEntry(encodeEntry(res));
    // isDeepStrictEqual first (fast, ~50 MB less heap than toEqual's diff machinery); toEqual only to report a failure
    if (!isDeepStrictEqual(back, res)) expect(back).toEqual(res);
    if (res.t !== 'build') throw new Error(res.t);
    const b = back as typeof res;
    expect(b.lightmap.irr).toBeInstanceOf(Uint16Array);
    expect(b.mesh.shell?.position).toBeInstanceOf(Float32Array);
    const bufs = buffersOf(b);
    expect(new Set(bufs).size).toBe(bufs.length); // no shared buffers: every array transfers on its own
  });

  it('keeps non-finite numbers, nulls and nested arrays', () => {
    const v = { a: NaN, b: [Infinity, -Infinity, 0, -1.5], c: null, d: { e: new Int8Array([-1, 2]), f: 'x', g: true } };
    const back = decodeEntry(encodeEntry(v)) as typeof v;
    expect(Number.isNaN(back.a)).toBe(true);
    expect(back.b).toEqual([Infinity, -Infinity, 0, -1.5]);
    expect(back.c).toBeNull();
    expect(Array.from(back.d.e)).toEqual([-1, 2]);
    expect(back.d.f).toBe('x');
  });
});

describe('cache keys', () => {
  const codes = { tile: 'a'.repeat(40), world: 'b'.repeat(40) };
  const layout: Extract<WorkerRequest, { t: 'layout' }> = { t: 'layout', job: 4, key: { s: 0, cx: 1, cz: 2 } };
  const build: Extract<WorkerRequest, { t: 'build' }> = { t: 'build', job: 5, key: { s: 0, cx: 1, cz: 2, q: 3 }, lighting: 'full' };

  it('world requests use the world hash and ignore the bake settings; tile requests use the worker hash and the bake', () => {
    expect(codeOf(layout, codes)).toBe(codes.world);
    expect(codeOf({ t: 'spawn', job: 1, s: 0 }, codes)).toBe(codes.world);
    expect(codeOf({ t: 'find', job: 1, query: 'water', from: { s: 0, x: 0, z: 0 }, maxChunks: 4 }, codes)).toBe(codes.world);
    expect(codeOf(build, codes)).toBe(codes.tile);
    expect(codeOf({ t: 'bake', job: 1, key: build.key }, codes)).toBe(codes.tile);
    expect(keyText(init('low'), layout, codes)).toBe(keyText(init('ultra'), layout, codes));
    expect(keyText(init('low'), build, codes)).not.toBe(keyText(init('ultra'), build, codes));
    expect(keyText(init('low'), layout, codes)).toContain(codes.world);
    expect(keyText(init('low'), build, codes)).toContain(codes.tile);
  });

  it('never depend on the job id or on key order', () => {
    const shuffled = { lighting: 'full', key: { q: 3, cz: 2, cx: 1, s: 0 }, job: 99, t: 'build' } as Extract<WorkerRequest, { t: 'build' }>;
    expect(keyText(init(), shuffled, codes)).toBe(keyText(init(), build, codes));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('namespaces by the first 12 hex digits of the code hash; flat URLs without the feature', () => {
    expect(nsOf(codes.tile)).toBe('aaaaaaaaaaaa');
    expect(entryPath('aaaaaaaaaaaa', 'f'.repeat(40))).toBe(`/__tilecache/aaaaaaaaaaaa/${'f'.repeat(40)}`);
    expect(entryPath('', 'f'.repeat(40))).toBe(`/__tilecache/${'f'.repeat(40)}`);
    expect(parseFeatures('{"raw":1,"ns":1}')).toEqual({ raw: true, ns: true });
    expect(parseFeatures(undefined)).toEqual({ raw: false, ns: false });
    expect(parseFeatures('garbage')).toEqual({ raw: false, ns: false });
  });

  it("a 'bake' miss is answered from the 'build lighting:full' entry of the same tile, byte for byte", () => {
    const key = { s: 0 as const, cx: 0, cz: 0, q: 1 as const };
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const built = handleRequest({ t: 'build', job: 2, key, lighting: 'full' }, st).res;
    const cached = decodeEntry(encodeEntry(built)) as typeof built; // what the cache holds
    const alt = bakeFromBuild(cached, 7);
    const st2 = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st2);
    handleRequest({ t: 'build', job: 2, key }, st2);
    const baked = handleRequest({ t: 'bake', job: 3, key }, st2).res;
    if (!alt || alt.t !== 'bake' || baked.t !== 'bake') throw new Error('expected bake responses');
    expect(alt.job).toBe(7);
    const { stats: _s1, ...a } = alt.lightmap;
    const { stats: _s2, ...b } = baked.lightmap;
    expect(isDeepStrictEqual(a, b)).toBe(true);
    // a preview build never stands in for a full bake
    const preview = handleRequest({ t: 'build', job: 4, key }, st2).res;
    expect(bakeFromBuild(preview, 8)).toBeNull();
  });
});

describe('code hashes', () => {
  it('the raw graph hash covers the whole worker graph of this repository', () => {
    expect(workerCodeHash(REPO)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the raw graph hash follows value imports, ignores erased type-only imports, and changes with any reached file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'br-hash-'));
    try {
      mkdirSync(path.join(root, 'src/workers'), { recursive: true });
      const w = (f: string, s: string): void => writeFileSync(path.join(root, f), s);
      w('src/workers/chunk.worker.ts', "import { a } from './a.ts';\nimport type { T } from './types.ts';\nexport const x = a;\n");
      w('src/workers/a.ts', "import { b } from './b.ts';\nexport const a = b + 1;\n");
      w('src/workers/b.ts', 'export const b = 1;\n');
      w('src/workers/types.ts', 'export type T = number;\n');
      const h0 = workerCodeHash(root);
      w('src/workers/types.ts', 'export type T = string;\n');
      expect(workerCodeHash(root)).toBe(h0);
      w('src/workers/b.ts', 'export const b = 2;\n');
      expect(workerCodeHash(root)).not.toBe(h0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bundle hashes: stable; blind to render presets and comments; the world hash is blind to baker edits', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'br-bundle-'));
    try {
      cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
      const hashes = async (): Promise<{ tile: string; world: string }> =>
        ({ tile: await bundleHash(root, TILE_ENTRY), world: await bundleHash(root, WORLD_ENTRY) });
      const edit = (f: string, from: string | RegExp, to: string): void => {
        const p = path.join(root, f);
        const s = readFileSync(p, 'utf8');
        const n = s.replace(from, to);
        if (n === s) throw new Error(`edit of ${f} did not apply`);
        writeFileSync(p, n);
      };
      const h0 = await hashes();
      expect(h0.tile).toMatch(/^[0-9a-f]{40}$/);
      expect(h0.world).not.toBe(h0.tile);
      expect(await hashes()).toEqual(h0); // deterministic output
      // a render-only preset (reaches the worker graph through the core barrel, never runs there)
      edit('src/core/quality.ts', /ssrSteps: 0,/, 'ssrSteps: 1,');
      // comments and blank lines in the baker
      edit('src/bake/direct.ts', '// src/bake/direct.ts', '// src/bake/direct.ts (a comment edit)\n\n//');
      expect(await hashes()).toEqual(h0);
      // a real baker constant: the tile hash changes, the world hash (layouts, spawn, find) does not
      edit('src/bake/direct.ts', 'const REUSE_SPREAD = 0.5;', 'const REUSE_SPREAD = 0.59;');
      const h1 = await hashes();
      expect(h1.tile).not.toBe(h0.tile);
      expect(h1.world).toBe(h0.world);
      // a world generation constant changes both
      edit('src/world/zones/concrete.ts', 'const EXTRA_P = 0.25;', 'const EXTRA_P = 0.26;');
      const h2 = await hashes();
      expect(h2.tile).not.toBe(h1.tile);
      expect(h2.world).not.toBe(h1.world);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memoises both hashes on the graph stamp (memory, then the memo file after a restart)', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-memo-'));
    try {
      const memo = path.join(dir, '.hashmemo.json');
      const a = await cacheHashes(REPO, memo);
      const b = await cacheHashes(REPO, memo);
      expect(b.memo).toBe('memory');
      expect([b.tile, b.world]).toEqual([a.tile, a.world]);
      expect(existsSync(memo)).toBe(true);
      const disk = JSON.parse(readFileSync(memo, 'utf8')) as Record<string, { tile: string; world: string }>;
      expect(disk[a.stamp]).toMatchObject({ tile: a.tile, world: a.world });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- server side

const KB = 1024;
const key = (c: string, i: number): string => c.repeat(36) + i.toString(16).padStart(4, '0');

function seed(dir: string, ns: string, keys: string[], ageMs: number, now: number, size = KB): void {
  const d = ns ? path.join(dir, ns) : dir;
  mkdirSync(d, { recursive: true });
  const t = new Date(now - ageMs);
  for (const k of keys) {
    writeFileSync(path.join(d, k), Buffer.alloc(size, 1));
    utimesSync(path.join(d, k), t, t);
  }
}

describe('tile store', () => {
  const H = 3600 * 1000, D = 24 * H;

  it('evicts legacy flat files, then stale namespaces beyond the 3 most recent (oldest first), then LRU', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-store-'));
    const now = Date.now();
    try {
      seed(dir, '', [key('1', 1), key('1', 2)], 10 * D, now);
      seed(dir, 'aaaaaaaaaaaa', [key('a', 1), key('a', 2), key('a', 3)], 1 * H, now);
      seed(dir, 'bbbbbbbbbbbb', [key('b', 1), key('b', 2), key('b', 3)], 2 * D, now);
      seed(dir, 'cccccccccccc', [key('c', 1), key('c', 2), key('c', 3)], 3 * D, now);
      seed(dir, 'eeeeeeeeeeee', [key('e', 1), key('e', 2), key('e', 3)], 4 * D, now);
      seed(dir, 'dddddddddddd', [key('d', 1), key('d', 2), key('d', 3)], 5 * D, now);
      // 17 KB against a 10 KB cap: evict down to 9 KB
      const store = createTileStore({ dir, capBytes: 10 * KB, now: () => now });
      await store.scan();
      expect(store.total).toBe(17 * KB);
      await store.evict();
      expect(store.total).toBe(9 * KB);
      expect(existsSync(path.join(dir, key('1', 1)))).toBe(false);
      expect(existsSync(path.join(dir, key('1', 2)))).toBe(false);
      expect(existsSync(path.join(dir, 'dddddddddddd'))).toBe(false); // oldest stale namespace, whole
      expect(existsSync(path.join(dir, 'eeeeeeeeeeee'))).toBe(false);
      for (const ns of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) expect(existsSync(path.join(dir, ns, key(ns[0], 1))), ns).toBe(true);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps namespaces used within 24 h and falls back to least recently used entries', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-store-'));
    const now = Date.now();
    try {
      seed(dir, 'aaaaaaaaaaaa', [key('a', 1), key('a', 2), key('a', 3), key('a', 4)], 1 * H, now);
      seed(dir, 'bbbbbbbbbbbb', [key('b', 1), key('b', 2), key('b', 3), key('b', 4)], 2 * H, now);
      seed(dir, 'cccccccccccc', [key('c', 1), key('c', 2)], 3 * H, now);
      seed(dir, 'dddddddddddd', [key('d', 1), key('d', 2)], 4 * H, now); // beyond the 3 most recent, but not stale
      const store = createTileStore({ dir, capBytes: 10 * KB, now: () => now });
      await store.scan();
      // a GET refreshes recency in memory at once (the mtime follows in a batch)
      expect(await store.get('dddddddddddd', key('d', 1))).not.toBeNull();
      await store.evict();
      expect(store.total).toBe(9 * KB);
      expect(existsSync(path.join(dir, 'dddddddddddd', key('d', 1)))).toBe(true); // just used
      expect(existsSync(path.join(dir, 'dddddddddddd', key('d', 2)))).toBe(false); // the oldest entries went first
      expect(existsSync(path.join(dir, 'cccccccccccc', key('c', 1)))).toBe(false);
      expect(existsSync(path.join(dir, 'cccccccccccc', key('c', 2)))).toBe(false);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not evict between the cap and cap x 1.05 (batches)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-store-'));
    try {
      seed(dir, 'aaaaaaaaaaaa', Array.from({ length: 41 }, (_, i) => key('a', i)), 1000, Date.now(), 256);
      const store = createTileStore({ dir, capBytes: 10 * KB });
      await store.scan();
      await store.evict();
      expect(store.total).toBe(41 * 256); // 10.25 KB: over the cap, under cap x 1.05: no batch yet
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tile cache middleware', () => {
  async function serve(dir: string): Promise<{ url: string; server: Server; store: ReturnType<typeof createTileStore> }> {
    const store = createTileStore({ dir, capBytes: 2 ** 30 });
    await store.scan();
    const h = tileCacheHandler(store);
    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/__tilecache/')) { res.statusCode = 404; res.end(); return; }
      req.url = req.url.slice('/__tilecache'.length);
      h(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}`, server, store };
  }

  it('gzips a raw PUT on the server (GET returns gzip of the same bytes), serves flat legacy keys, refuses when full', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-mw-'));
    const { url, server, store } = await serve(dir);
    try {
      const body = encodeEntry({ t: 'layout', a: new Float32Array([1, 2, 3]), n: NaN });
      const k = key('f', 1);
      const put = await fetch(`${url}${entryPath('abcdefabcdef', k)}`, { method: 'PUT', body, headers: { 'X-BR-Raw': '1' } });
      expect(put.status).toBe(202);
      // the reply precedes the write: wait for it to land
      for (let i = 0; i < 100 && !existsSync(path.join(dir, 'abcdefabcdef', k)); i++) await new Promise((r) => setTimeout(r, 10));
      const got = await fetch(`${url}${entryPath('abcdefabcdef', k)}`);
      expect(got.status).toBe(200);
      const gz = Buffer.from(await got.arrayBuffer());
      expect(Buffer.compare(gunzipSync(gz), Buffer.from(body))).toBe(0);
      expect((await fetch(`${url}${entryPath('abcdefabcdef', key('f', 2))}`)).status).toBe(404);
      // legacy: flat file, stored as sent (already gzip)
      writeFileSync(path.join(dir, key('9', 1)), gz);
      expect(Buffer.from(await (await fetch(`${url}${entryPath('', key('9', 1))}`)).arrayBuffer()).equals(gz)).toBe(true);
      expect((await fetch(`${url}/__tilecache/not-a-key`)).status).toBe(400);
      // a full queue refuses at once (the worker only loses a later hit)
      for (let i = 0; i < PUT_INFLIGHT; i++) expect(store.reserve()).toBe(true);
      const busy = await fetch(`${url}${entryPath('abcdefabcdef', key('f', 3))}`, { method: 'PUT', body, headers: { 'X-BR-Raw': '1' } });
      expect(busy.status).toBe(503);
      for (let i = 0; i < PUT_INFLIGHT; i++) store.release();
      expect(store.inflight).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
