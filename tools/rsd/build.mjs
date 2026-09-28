// tools/rsd/build.mjs — content-addressed builds of source trees for the capture daemon.
//
// treeHash(tree) = SHA-1 over the sorted (path, bytes) of everything a build reads (HASH_ROOTS; ~10-20 ms).
// ensureBuild(tree) copies those files to <RENDER_DIR>/trees/<treeHash> (never writing into the agent's worktree),
// symlinks node_modules, and runs `vite build` there in development mode with the harness pages:
//   NODE_ENV=development keeps import.meta.env.DEV, so validatePayload and the sampler-budget console.error that QA
//   relies on stay in (asserted: the output contains `validate:!0`); BACKROOMS_TOOL=1 enables the tile-cache define.
// Output: <RENDER_DIR>/builds/<buildKey>/ plus meta.json { treeHash, distHash, ... }. distHash (SHA-1 of the output
// files) is what the daemon serves (/b/<distHash>/) and what the capture memo is keyed by. One build runs at a time
// machine-wide (a 'build' lease of the memory budget); concurrent requests for the same tree share it. The 20 most
// recently used builds are kept (named A/B baselines are pinned).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { acquire, WEIGHTS } from '../lib/budget.mjs';

export const RENDER_DIR = process.env.BACKROOMS_RENDER_DIR ?? '/var/tmp/backrooms-render';
export const TREES_DIR = path.join(RENDER_DIR, 'trees');
export const BUILDS_DIR = path.join(RENDER_DIR, 'builds');
export const BASELINES_DIR = path.join(RENDER_DIR, 'baselines');
export const MAIN_REPO = path.resolve(import.meta.dirname, '..', '..');
/** Everything `vite build` of a tree reads (plus the tile-cache plugin, which the daemon also serves). */
export const HASH_ROOTS = ['src', 'harness', 'public', 'index.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tools/viteTileCache.ts'];
export const BUILD_VERSION = 1;
export const KEEP_BUILDS = 20;

/** Sorted relative paths of the files a build of `tree` reads. */
export function treeFiles(tree) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(tree, rel);
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) if (n !== 'node_modules' && !n.startsWith('.')) walk(path.join(rel, n)); }
    else if (st.isFile()) out.push(rel);
  };
  for (const r of HASH_ROOTS) walk(r);
  return out.sort();
}

/** { hash, files, ms } of a tree. */
export function treeHash(tree) {
  const t0 = performance.now();
  const files = treeFiles(tree);
  const h = createHash('sha1');
  for (const f of files) h.update(f).update('\0').update(readFileSync(path.join(tree, f))).update('\0');
  return { hash: h.digest('hex'), files, ms: Math.round(performance.now() - t0) };
}

export function buildKeyOf(th, { tileCache = true } = {}) {
  return createHash('sha1').update(`${th}\0tc=${tileCache ? 1 : 0}\0v${BUILD_VERSION}`).digest('hex');
}

/** node_modules for a staged tree: the source tree's own, else the main repository's. */
function nodeModulesOf(tree) {
  for (const t of [tree, MAIN_REPO]) {
    const nm = path.join(t, 'node_modules');
    if (existsSync(path.join(nm, 'vite', 'bin', 'vite.js'))) return realpathSync(nm);
  }
  throw new Error(`no node_modules with vite for ${tree}`);
}

/** Copies the build inputs of `tree` to <TREES_DIR>/<hash> (idempotent). */
export function stageTree(tree, th) {
  const dir = path.join(TREES_DIR, th.hash);
  if (existsSync(path.join(dir, '.staged'))) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const f of th.files) {
    const d = path.join(tmp, f);
    mkdirSync(path.dirname(d), { recursive: true });
    copyFileSync(path.join(tree, f), d);
  }
  symlinkSync(nodeModulesOf(tree), path.join(tmp, 'node_modules'));
  writeFileSync(path.join(tmp, '.staged'), JSON.stringify({ from: tree, at: new Date().toISOString() }));
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

/** SHA-1 over the sorted (path, bytes) of a build output directory (meta.json excluded). */
export function distHashOf(dir) {
  const files = [];
  const walk = (rel) => {
    for (const n of readdirSync(path.join(dir, rel)).sort()) {
      const r = path.join(rel, n);
      const st = statSync(path.join(dir, r));
      if (st.isDirectory()) walk(r); else if (r !== 'meta.json') files.push(r);
    }
  };
  walk('');
  const h = createHash('sha1');
  for (const f of files.sort()) h.update(f).update('\0').update(readFileSync(path.join(dir, f))).update('\0');
  return h.digest('hex');
}

function readMeta(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
}

/** distHash -> { dir, meta } of every complete build on disk. */
export function buildIndex() {
  const idx = new Map();
  let names = [];
  try { names = readdirSync(BUILDS_DIR); } catch { return idx; }
  for (const n of names) {
    if (!/^[0-9a-f]{40}$/.test(n)) continue;
    const dir = path.join(BUILDS_DIR, n);
    const meta = readMeta(dir);
    if (meta?.distHash) idx.set(meta.distHash, { dir, meta });
  }
  return idx;
}

export function pinnedDistHashes() {
  const pins = new Set();
  let names = [];
  try { names = readdirSync(BASELINES_DIR); } catch { return pins; }
  for (const n of names) {
    try { const b = JSON.parse(readFileSync(path.join(BASELINES_DIR, n), 'utf8')); if (b.distHash) pins.add(b.distHash); } catch { /* ignore */ }
  }
  return pins;
}

/** Deletes the least recently used builds (and their staged trees) beyond `keep`, except pinned and `inUse`. */
export function evictBuilds(keep = KEEP_BUILDS, inUse = new Set()) {
  const pins = pinnedDistHashes();
  const all = [...buildIndex().values()].sort((a, b) => (statSync(path.join(b.dir, 'meta.json')).mtimeMs - statSync(path.join(a.dir, 'meta.json')).mtimeMs));
  let kept = 0;
  for (const b of all) {
    if (kept < keep || pins.has(b.meta.distHash) || inUse.has(b.meta.distHash)) { kept++; continue; }
    const junk = `${b.dir}.del-${process.pid}`;
    try { renameSync(b.dir, junk); rmSync(junk, { recursive: true, force: true }); } catch { /* ignore */ }
    const stillUsed = [...buildIndex().values()].some((x) => x.meta.treeHash === b.meta.treeHash);
    if (!stillUsed && !b.meta.treeHash?.startsWith('rev-')) rmSync(path.join(TREES_DIR, b.meta.treeHash), { recursive: true, force: true });
  }
}

const inflight = new Map();

/**
 * Builds `tree` (or reuses the build of identical content). Returns
 * { treeHash, buildKey, distHash, dir, stagedTree, ms, hashMs, cached }.
 */
export function ensureBuild(tree, { tileCache = true, log = () => {}, keep = KEEP_BUILDS, inUse } = {}) {
  const th = treeHash(tree);
  const buildKey = buildKeyOf(th.hash, { tileCache });
  const dir = path.join(BUILDS_DIR, buildKey);
  const meta = readMeta(dir);
  if (meta?.distHash) {
    const now = new Date();
    try { utimesSync(path.join(dir, 'meta.json'), now, now); } catch { /* ignore */ }
    return Promise.resolve({ ...meta, dir, stagedTree: path.join(TREES_DIR, th.hash), ms: 0, hashMs: th.ms, cached: true });
  }
  if (inflight.has(buildKey)) return inflight.get(buildKey);
  const p = (async () => {
    const lease = await acquire({ weightMb: WEIGHTS.build, kind: 'build', label: `vite build ${th.hash.slice(0, 12)} (capture daemon, pid ${process.pid})` });
    try {
      const again = readMeta(dir); // another daemon version may have built it meanwhile
      if (again?.distHash) return { ...again, dir, stagedTree: path.join(TREES_DIR, th.hash), ms: 0, hashMs: th.ms, cached: true };
      const t0 = performance.now();
      const staged = stageTree(tree, th);
      const tmp = `${dir}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(BUILDS_DIR, { recursive: true });
      await runViteBuild(staged, tmp, { tileCache });
      const js = readdirSync(path.join(tmp, 'assets')).filter((n) => n.endsWith('.js'));
      if (!js.some((n) => readFileSync(path.join(tmp, 'assets', n), 'utf8').includes('validate:!0'))) {
        throw new Error('the development build lost the DEV payload validation (no `validate:!0` in assets/*.js)');
      }
      const distHash = distHashOf(tmp);
      const m = { treeHash: th.hash, buildKey, distHash, tileCache, files: th.files.length, buildMs: Math.round(performance.now() - t0), created: new Date().toISOString(), from: tree };
      writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(m, null, 1));
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
      log(`built ${th.hash.slice(0, 12)} -> ${distHash.slice(0, 12)} in ${m.buildMs} ms`);
      try { evictBuilds(keep, inUse ?? new Set([distHash])); } catch { /* ignore */ }
      return { ...m, dir, stagedTree: staged, ms: m.buildMs, hashMs: th.ms, cached: false };
    } finally {
      lease?.release();
    }
  })().finally(() => inflight.delete(buildKey));
  inflight.set(buildKey, p);
  return p;
}

function runViteBuild(staged, outDir, { tileCache }) {
  return new Promise((res, rej) => {
    const env = { ...process.env, BACKROOMS_TOOL: '1', BACKROOMS_HARNESS: '1', NODE_ENV: 'development' };
    if (!tileCache) env.BACKROOMS_TILE_CACHE = '0'; else delete env.BACKROOMS_TILE_CACHE;
    const b = spawn(process.execPath, [path.join(staged, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', '--sourcemap', 'false', '--logLevel', 'warn'],
      { cwd: staged, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    b.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    b.on('error', rej);
    b.on('exit', (code) => (code === 0 ? res() : rej(new Error(`vite build failed (exit ${code}):\n${err.slice(0, 4000)}`))));
  });
}

/**
 * Materialises a git revision of `repo` as a tree (git archive | tar -x; no worktree) with a node_modules symlink.
 * Returns the tree path (<TREES_DIR>/rev-<sha>).
 */
export function materializeRev(repo, rev) {
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' }).trim();
  const dir = path.join(TREES_DIR, `rev-${sha}`);
  if (existsSync(path.join(dir, '.staged'))) return { dir, sha };
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', sha, ...HASH_ROOTS.filter((r) => fileAtRev(repo, sha, r))], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', tmp], { input: tar });
  symlinkSync(nodeModulesOf(repo), path.join(tmp, 'node_modules'));
  writeFileSync(path.join(tmp, '.staged'), JSON.stringify({ from: repo, rev, sha, at: new Date().toISOString() }));
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return { dir, sha };
}

function fileAtRev(repo, sha, p) {
  try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}:${p}`], { stdio: 'ignore' }); return true; } catch { return false; }
}
