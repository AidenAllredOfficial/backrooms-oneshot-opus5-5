// tools/viteTileCache.ts — Vite plugin behind the worker result cache of tool runs (src/workers/tileCache.ts).
//
// Keys (defines injected by config()):
//  - __BR_TILE_CACHE__        SHA-1 of a tree-shaken, minified rolldown bundle of src/workers/chunk.worker.ts (what a
//                             build / bake runs), plus the entry codec source, the imported package versions, the
//                             rolldown / vite versions and CACHE_SALT. Comments, types and render-only code that
//                             only reaches the worker graph through a barrel (core/quality.ts presets) never change
//                             it; an edit to any code the worker runs does.
//  - __BR_TILE_CACHE_WORLD__  the same for src/workers/worldStage.ts (what layout / spawn / find run), plus the verbatim
//                             source of handler.ts and validatePayload.ts (the branches around the world-stage calls
//                             are not in that bundle): a baker-only edit keeps those entries warm.
//  - __BR_TILE_CACHE_FEATURES__ '{"raw":1,"ns":1}': the worker PUTs raw entries and uses namespaced URLs.
// Both hashes are memoised on a stamp of the worker graph (sorted paths + mtime + size + package versions) in memory
// and in <dir>/.hashmemo.json, so an unchanged tree costs one import walk (~20 ms) instead of two bundles (~0.2-0.4 s).
//
// Store (configureServer registers only server.middlewares.use('/__tilecache/', fn), so a plain http server can
// mount it too): GET / PUT /__tilecache/<ns>/<key> (ns = first 12 hex of the code hash the key uses) under
// <dir>/<ns>/<key>; legacy flat /__tilecache/<key> files are still served. BACKROOMS_TILE_CACHE_DIR (default
// ~/.cache/backrooms-tilecache), capped at BACKROOMS_TILE_CACHE_MB (default 8192).
//  - PUT with X-BR-Raw: 1 carries the raw entry; the server gzips it (zlib level 1, libuv pool) and writes it
//    asynchronously. At most PUT_INFLIGHT entries are in flight (~60 MB); more are refused with 503 (the worker only
//    loses a later hit). The reply is sent as soon as the body is in: nobody waits for the write.
//  - All file I/O is asynchronous. GET refreshes the entry's recency in memory; the mtime updates (the persistent
//    recency) are batched every TOUCH_FLUSH_MS.
//  - Eviction runs in batches once the total exceeds cap x 1.05, down to cap x 0.9: first legacy flat files, then
//    whole namespaces unused for 24 h beyond the 3 most recently used, then least recently used entries. Directories
//    are renamed before they are deleted (a concurrent reader never sees a half-deleted namespace).
// Enabled for tool runs (BACKROOMS_TOOL=1: tools/shoot.mjs, tools/qa.mjs) unless BACKROOMS_TILE_CACHE=0; never in
// `npm run dev` / builds, so the game never depends on it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const gzipAsync = promisify(gzip);

/** Bump when the key semantics or the entry format change in a way the bundles do not show. */
export const CACHE_SALT = 'br-tilecache-v2';
export const TILE_ENTRY = 'src/workers/chunk.worker.ts';
export const WORLD_ENTRY = 'src/workers/worldStage.ts';
/** Source files hashed verbatim into both hashes (the entry codec: tree-shaking drops it from the bundles). */
const CODEC_FILES = ['src/workers/tileCache.ts'];
/** Source files hashed verbatim into the WORLD hash only: the handler's own init / layout / spawn / find branches
 * (the response assembly around the world-stage calls: collision copy, find / spawn arguments) and the payload
 * validator they run are not part of the worldStage.ts bundle. Any edit to them invalidates the world entries (a
 * baker-only edit still does not). */
export const WORLD_VERBATIM_FILES = ['src/workers/handler.ts', 'src/workers/validatePayload.ts'];
export const CACHE_FEATURES = { raw: 1, ns: 1 } as const;

export const PUT_INFLIGHT = 8;
export const PUT_MAX_BYTES = 64 * 2 ** 20;
export const TOUCH_FLUSH_MS = 5000;
export const EVICT_TRIGGER = 1.05;
export const EVICT_TARGET = 0.9;
export const NS_KEEP_RECENT = 3;
export const NS_STALE_MS = 24 * 3600 * 1000;

const KEY_RE = /^[0-9a-f]{40}$/;
const NS_RE = /^[0-9a-f]{12}$/;
const ENTRY_RE = /^\/(?:([0-9a-f]{12})\/)?([0-9a-f]{40})$/;

// group 1: `type` of an erased type-only import/export; group 2: specifier; group 3: dynamic import specifier
const IMPORT_RE = /(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module reachable from `entry` (relative imports; `import type` / `export type` statements are erased at
 * compile time and not followed) and the packages it imports. */
export function workerGraph(root: string, entry = TILE_ENTRY): { files: string[]; pkgs: string[] } {
  const seen = new Set<string>();
  const pkgs = new Set<string>();
  const stack = [path.resolve(root, entry)];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f) || !existsSync(f)) continue; // a match inside a comment may name no file
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      if (m[1]) continue;
      const spec = m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(f), spec));
      else pkgs.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  return { files: [...seen].sort(), pkgs: [...pkgs].sort() };
}

const pkgVersion = (root: string, p: string): string => {
  const pj = path.join(root, 'node_modules', p, 'package.json');
  try { return existsSync(pj) ? String((JSON.parse(readFileSync(pj, 'utf8')) as { version?: unknown }).version) : '?'; } catch { return '?'; }
};

/** SHA-1 over the raw contents of every module reachable from `entry` and its package versions (the pre-bundle
 * key; kept for diagnostics and tests). */
export function workerCodeHash(root: string, entry = TILE_ENTRY): string {
  const h = createHash('sha1');
  const g = workerGraph(root, entry);
  for (const f of g.files) h.update(path.relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  for (const p of g.pkgs) h.update(p).update('@').update(pkgVersion(root, p));
  return h.digest('hex');
}

/** Cheap identity of the source tree the bundles would be built from: the graphs' paths, mtimes and sizes, the
 * package versions and the salt. Equal stamps give equal bundle hashes. */
export function graphStamp(root: string): string {
  const h = createHash('sha1').update(CACHE_SALT);
  const files = new Set<string>();
  const pkgs = new Set<string>(['rolldown', 'vite']);
  for (const e of [TILE_ENTRY, WORLD_ENTRY]) {
    const g = workerGraph(root, e);
    for (const f of g.files) files.add(f);
    for (const p of g.pkgs) pkgs.add(p);
  }
  for (const f of [...CODEC_FILES, ...WORLD_VERBATIM_FILES]) files.add(path.resolve(root, f));
  for (const f of [...files].sort()) {
    let st: { mtimeMs: number; size: number } | null = null;
    try { st = statSync(f); } catch { /* missing: part of the stamp as such */ }
    h.update(path.relative(root, f)).update(`\0${st ? `${st.mtimeMs}:${st.size}` : '-'}\0`);
  }
  for (const p of [...pkgs].sort()) h.update(`${p}@${pkgVersion(root, p)}\0`);
  return h.digest('hex');
}

/** SHA-1 of the tree-shaken, minified bundle of `entry` (every define the worker reads set to its disabled value),
 * the entry codec source, its package versions, the rolldown / vite versions and the salt. */
export async function bundleHash(root: string, entry: string): Promise<string> {
  const { rolldown } = await import('rolldown');
  const b = await rolldown({
    input: path.resolve(root, entry), cwd: root, logLevel: 'silent', treeshake: true,
    external: (id: string) => !id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('\0'),
    transform: {
      define: { __BR_TILE_CACHE__: '""', __BR_TILE_CACHE_WORLD__: '""', __BR_TILE_CACHE_FEATURES__: '""', 'import.meta.env.DEV': 'false' },
    },
  });
  try {
    const { output } = await b.generate({ format: 'es', minify: true });
    const h = createHash('sha1').update(CACHE_SALT).update('\0');
    for (const o of output) if ('code' in o) h.update(o.fileName).update('\0').update(o.code).update('\0');
    for (const f of entry === WORLD_ENTRY ? [...CODEC_FILES, ...WORLD_VERBATIM_FILES] : CODEC_FILES) {
      const p = path.resolve(root, f);
      h.update(f).update('\0').update(existsSync(p) ? readFileSync(p) : '-').update('\0');
    }
    const g = workerGraph(root, entry);
    for (const p of ['rolldown', 'vite', ...g.pkgs]) h.update(`${p}@${pkgVersion(root, p)}\0`);
    return h.digest('hex');
  } finally {
    await b.close();
  }
}

export interface CacheHashes { tile: string; world: string; stamp: string; ms: number; memo: 'memory' | 'disk' | 'none' }
const memo = new Map<string, { tile: string; world: string }>();
const MEMO_MAX = 32;

/** The tile and world hashes of the tree at `root`, memoised on graphStamp() (in memory, and in `memoFile` when
 * given: every tool run starts a new server). */
export async function cacheHashes(root: string, memoFile?: string): Promise<CacheHashes> {
  const t0 = performance.now();
  const stamp = graphStamp(root);
  const hit = memo.get(stamp);
  if (hit) return { ...hit, stamp, ms: performance.now() - t0, memo: 'memory' };
  let disk: Record<string, { tile: string; world: string; t: number }> = {};
  if (memoFile) {
    try { disk = JSON.parse(await readFile(memoFile, 'utf8')) as typeof disk; } catch { disk = {}; }
    const d = disk[stamp];
    if (d && KEY_RE.test(d.tile) && KEY_RE.test(d.world)) {
      memo.set(stamp, { tile: d.tile, world: d.world });
      return { tile: d.tile, world: d.world, stamp, ms: performance.now() - t0, memo: 'disk' };
    }
  }
  const [tile, world] = await Promise.all([bundleHash(root, TILE_ENTRY), bundleHash(root, WORLD_ENTRY)]);
  memo.set(stamp, { tile, world });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  if (memoFile) {
    disk[stamp] = { tile, world, t: Date.now() };
    const keep = Object.entries(disk).sort((a, b) => b[1].t - a[1].t).slice(0, MEMO_MAX);
    try {
      await mkdir(path.dirname(memoFile), { recursive: true });
      const tmp = `${memoFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(keep)));
      await rename(tmp, memoFile);
    } catch { /* the memo is an optimisation */ }
  }
  return { tile, world, stamp, ms: performance.now() - t0, memo: 'none' };
}

// ---------------------------------------------------------------- store

interface Entry { size: number; t: number; ns: string }

export interface TileStoreOptions { dir: string; capBytes: number; now?: () => number; touchFlushMs?: number }

export interface TileStore {
  readonly dir: string;
  /** bytes and entries in the size index */
  readonly total: number;
  readonly count: number;
  /** PUTs being received / compressed / written */
  readonly inflight: number;
  /** the stored (gzip) bytes of an entry, or null */
  get(ns: string, key: string): Promise<Buffer | null>;
  /** reserve a PUT slot (false: PUT_INFLIGHT are in flight, refuse the PUT); release() gives it back */
  reserve(): boolean;
  release(): void;
  /** store `body` (raw: gzip it first), then evict when over the cap */
  put(ns: string, key: string, body: Buffer, raw: boolean): Promise<void>;
  /** index the directory (entries already indexed by a PUT win) */
  scan(): Promise<void>;
  /** one eviction batch if the total exceeds cap x EVICT_TRIGGER */
  evict(): Promise<void>;
  /** write the batched mtime updates now */
  flushTouches(): Promise<void>;
  close(): Promise<void>;
}

const idOf = (ns: string, key: string): string => (ns ? `${ns}/${key}` : key);

export function createTileStore(o: TileStoreOptions): TileStore {
  const { dir, capBytes } = o;
  const now = o.now ?? ((): number => Date.now());
  const index = new Map<string, Entry>();
  let total = 0;
  let inflight = 0;
  let scanned: Promise<void> | null = null;
  let evicting: Promise<void> | null = null;
  const touched = new Map<string, number>();
  const madeNs = new Set<string>();
  let trashN = 0;
  let tmpN = 0;
  const fileOf = (ns: string, key: string): string => (ns ? path.join(dir, ns, key) : path.join(dir, key));

  const setEntry = (id: string, e: Entry): void => {
    const prev = index.get(id);
    if (prev) total -= prev.size;
    index.set(id, e);
    total += e.size;
  };
  const dropEntry = (id: string): void => {
    const prev = index.get(id);
    if (!prev) return;
    total -= prev.size;
    index.delete(id);
    touched.delete(id);
  };

  const timer = setInterval(() => { void store.flushTouches(); }, o.touchFlushMs ?? TOUCH_FLUSH_MS);
  timer.unref?.();

  async function doScan(): Promise<void> {
    await mkdir(dir, { recursive: true });
    const found: [string, string, string][] = []; // id, ns, file
    for (const n of await readdir(dir, { withFileTypes: true })) {
      if (n.isFile() && KEY_RE.test(n.name)) found.push([n.name, '', path.join(dir, n.name)]);
      else if (n.isDirectory() && NS_RE.test(n.name)) {
        let keys: string[] = [];
        try { keys = await readdir(path.join(dir, n.name)); } catch { continue; }
        for (const k of keys) if (KEY_RE.test(k)) found.push([`${n.name}/${k}`, n.name, path.join(dir, n.name, k)]);
      } else if (n.isDirectory() && n.name.startsWith('.trash-')) {
        void rm(path.join(dir, n.name), { recursive: true, force: true }).catch(() => undefined);
      } else if (n.isFile() && n.name.endsWith('.tmp')) {
        void unlink(path.join(dir, n.name)).catch(() => undefined);
      }
    }
    const CONC = 64;
    for (let i = 0; i < found.length; i += CONC) {
      await Promise.all(found.slice(i, i + CONC).map(async ([id, ns, f]) => {
        if (index.has(id)) return;
        try {
          const s = await stat(f);
          if (!index.has(id)) setEntry(id, { size: s.size, t: s.mtimeMs, ns });
        } catch { /* gone meanwhile */ }
      }));
    }
  }

  async function removeFile(id: string): Promise<void> {
    const e = index.get(id);
    if (!e) return;
    dropEntry(id);
    const key = id.slice(id.lastIndexOf('/') + 1);
    try { await unlink(fileOf(e.ns, key)); } catch { /* already gone */ }
  }

  async function removeNamespace(ns: string): Promise<void> {
    for (const [id, e] of [...index]) if (e.ns === ns) dropEntry(id);
    madeNs.delete(ns);
    const trash = path.join(dir, `.trash-${ns}-${process.pid}-${trashN++}`);
    try {
      await rename(path.join(dir, ns), trash);
      await rm(trash, { recursive: true, force: true });
    } catch { /* already gone */ }
  }

  async function evictBatch(): Promise<void> {
    if (scanned) await scanned;
    if (total <= capBytes * EVICT_TRIGGER) return;
    const target = capBytes * EVICT_TARGET;
    // 1. legacy flat files, oldest first
    const legacy = [...index].filter(([, e]) => e.ns === '').sort((a, b) => a[1].t - b[1].t);
    for (const [id] of legacy) {
      if (total <= target) return;
      await removeFile(id);
    }
    // 2. whole namespaces unused for NS_STALE_MS, beyond the NS_KEEP_RECENT most recently used
    const last = new Map<string, number>();
    for (const e of index.values()) if (e.ns) last.set(e.ns, Math.max(last.get(e.ns) ?? -Infinity, e.t));
    const byRecency = [...last].sort((a, b) => b[1] - a[1]);
    const stale = byRecency.slice(NS_KEEP_RECENT).filter(([, t]) => t < now() - NS_STALE_MS).reverse(); // oldest first
    for (const [ns] of stale) {
      if (total <= target) return;
      await removeNamespace(ns);
    }
    // 3. least recently used entries
    const lru = [...index].sort((a, b) => a[1].t - b[1].t);
    for (const [id] of lru) {
      if (total <= target) return;
      await removeFile(id);
    }
  }

  const store: TileStore = {
    dir,
    get total() { return total; },
    get count() { return index.size; },
    get inflight() { return inflight; },
    async get(ns, key) {
      const id = idOf(ns, key);
      try {
        const body = await readFile(fileOf(ns, key));
        const t = now();
        const e = index.get(id);
        if (e) e.t = t;
        else setEntry(id, { size: body.length, t, ns });
        touched.set(id, t);
        return body;
      } catch {
        dropEntry(id); // evicted by another server sharing the directory
        return null;
      }
    },
    reserve() {
      if (inflight >= PUT_INFLIGHT) return false;
      inflight++;
      return true;
    },
    release() {
      inflight = Math.max(0, inflight - 1);
    },
    async put(ns, key, body, raw) {
      const data = raw ? await gzipAsync(body, { level: 1 }) : body;
      const file = fileOf(ns, key);
      const write = async (): Promise<void> => {
        if (ns && !madeNs.has(ns)) { await mkdir(path.join(dir, ns), { recursive: true }); madeNs.add(ns); }
        const tmp = `${file}.${process.pid}.${(tmpN++).toString(36)}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, file);
      };
      try {
        await write();
      } catch {
        // another server sharing the directory may have evicted the namespace: create it again, once
        madeNs.delete(ns);
        await write();
      }
      setEntry(idOf(ns, key), { size: data.length, t: now(), ns });
      await store.evict();
    },
    scan() {
      scanned ??= doScan().catch(() => undefined);
      return scanned;
    },
    evict() {
      if (total <= capBytes * EVICT_TRIGGER) return Promise.resolve();
      evicting ??= evictBatch().finally(() => { evicting = null; });
      return evicting;
    },
    async flushTouches() {
      if (touched.size === 0) return;
      const batch = [...touched];
      touched.clear();
      await Promise.all(batch.map(async ([id, t]) => {
        const e = index.get(id);
        if (!e) return;
        const d = new Date(t);
        try { await utimes(fileOf(e.ns, id.slice(id.lastIndexOf('/') + 1)), d, d); } catch { /* evicted meanwhile */ }
      }));
    },
    async close() {
      clearInterval(timer);
      await store.flushTouches();
    },
  };
  return store;
}

// ---------------------------------------------------------------- middleware + plugin

/** The connect-style handler of /__tilecache/ (req.url relative to the mount point). */
export function tileCacheHandler(store: TileStore, info: () => object = () => ({})): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const u = (req.url ?? '').split('?')[0];
      if (u === '/status' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...info(), dir: store.dir, entries: store.count, bytes: store.total, inflight: store.inflight }));
        return;
      }
      const m = ENTRY_RE.exec(u);
      if (!m) { res.statusCode = 400; res.end(); req.resume(); return; }
      const ns = m[1] ?? '', key = m[2];
      if (req.method === 'GET') {
        const body = await store.get(ns, key);
        if (!body) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(body);
        return;
      }
      if (req.method === 'PUT') {
        if (!store.reserve()) { res.statusCode = 503; res.end(); req.resume(); return; }
        try {
          const parts: Buffer[] = [];
          let n = 0;
          for await (const c of req) {
            const b = c as Buffer;
            n += b.length;
            if (n > PUT_MAX_BYTES) throw new Error('entry too large');
            parts.push(b);
          }
          // reply at once: the worker never waits for the compression or the write
          res.statusCode = 202;
          res.end();
          await store.put(ns, key, Buffer.concat(parts), req.headers['x-br-raw'] === '1');
        } catch {
          if (!res.writableEnded) { res.statusCode = 413; res.end(); }
        } finally {
          store.release();
        }
        return;
      }
      res.statusCode = 405;
      res.end();
    })().catch(() => {
      if (!res.writableEnded) { res.statusCode = 500; res.end(); }
    });
  };
}

export function tileCachePlugin(enabled: boolean): Plugin {
  const dir = process.env.BACKROOMS_TILE_CACHE_DIR ?? path.join(homedir(), '.cache', 'backrooms-tilecache');
  const capBytes = Number(process.env.BACKROOMS_TILE_CACHE_MB ?? 8192) * 1048576;
  let hashes: CacheHashes | null = null;
  return {
    name: 'backrooms-tile-cache',
    async config(cfg) {
      if (!enabled) return { define: { __BR_TILE_CACHE__: '""', __BR_TILE_CACHE_WORLD__: '""', __BR_TILE_CACHE_FEATURES__: '""' } };
      const root = cfg.root ? path.resolve(cfg.root) : process.cwd();
      hashes = await cacheHashes(root, path.join(dir, '.hashmemo.json'));
      return {
        define: {
          __BR_TILE_CACHE__: JSON.stringify(hashes.tile),
          __BR_TILE_CACHE_WORLD__: JSON.stringify(hashes.world),
          __BR_TILE_CACHE_FEATURES__: JSON.stringify(JSON.stringify(CACHE_FEATURES)),
        },
      };
    },
    configureServer(server) {
      if (!enabled) return;
      const store = createTileStore({ dir, capBytes });
      void store.scan().then(() => store.evict());
      server.middlewares.use('/__tilecache/', tileCacheHandler(store, () => ({ hashes })));
    },
  };
}
