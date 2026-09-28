#!/usr/bin/env node
// tools/rsd/server.mjs — the capture daemon: one per machine, started on demand by tools/rsd/client.mjs.
//
// It owns the only tool Chromium (launched and GPU-warmed once, under a 'browser' lease of tools/lib/budget.mjs),
// serves content-addressed builds of any number of source trees (tools/rsd/build.mjs) at /b/<distHash>/ next to
// the tile-cache middleware of tools/viteTileCache.ts, and runs capture jobs from any number of clients:
//   - round-robin across clients; within a client, shots grouped by boot key so a warm page can take the next shot
//     in place (capture contract v2, feature-detected by tools/lib/capture.mjs);
//   - lane 0 always; lane 1 (a second page) only when the memory budget admits it and the tile cache is warm, for
//     shots at quality <= high and <= 1920x1080; shots with evals and the long presets (soak/stress/perf/edge) run
//     alone in the browser (policy.mjs isExclusive);
//   - a memo of finished captures keyed by (distHash, canonical shot, Chromium + GPU, capture code): an unchanged
//     re-shoot costs a file copy;
//   - the memory governor (tools/lib/procmem.mjs) on its own process tree: shed idle pages below 3.5 GB
//     MemAvailable, close its browser below 2.5 GB (running jobs fail with 'memory guard'), recycle a page or the
//     browser above 3.2 GB tree PSS, after 40 shots per page / 200 per browser, or at 1.2 GB GPU-process RSS;
//   - idle policy: warm pages close after 90 s, the browser after 3 min (at once when another tool waits for the
//     browser slot), the daemon exits after 10 min.
// Discovery: /tmp/backrooms-render/daemon.json { pid, port, version }. HTTP on 127.0.0.1 only:
//   POST /render (NDJSON results), GET /status, POST /retire (finish queued jobs, then exit), POST /stop.
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquire, status as budgetStatus, WEIGHTS, pageWeight } from '../lib/budget.mjs';
import { createGovernor, findInTree } from '../lib/procmem.mjs';
import {
  Lane, CAPTURE_CODE_HASH, READY_TIMEOUT_MS, launchBrowser, warmGpu, withTimeout,
  parseSize, planOrder, shotFileName, captureFileName, treeFeatures, isGameShot,
} from '../lib/capture.mjs';
import { ensureBuild, buildIndex, RENDER_DIR, pinnedDistHashes } from './build.mjs';
import { memoAllowed, memoKey, laneEligible, pickJob, qualityOf, isExclusive } from './policy.mjs';
import { RUN_DIR, DAEMON_JSON, daemonVersion } from './client.mjs';

const VERSION = daemonVersion();
const MEMO_DIR = path.join(RENDER_DIR, 'memo');
const MEMO_CAP = Number(process.env.BACKROOMS_MEMO_MB ?? 2048) * 1048576;
const MAX_LANES = Math.max(1, Math.min(2, Number(process.env.BACKROOMS_RSD_LANES ?? 2)));
const IDLE_PAGE_MS = Number(process.env.BACKROOMS_RSD_IDLE_PAGE_MS ?? 90000);
const IDLE_BROWSER_MS = Number(process.env.BACKROOMS_RSD_IDLE_BROWSER_MS ?? 180000);
const IDLE_EXIT_MS = Number(process.env.BACKROOMS_RSD_IDLE_EXIT_MS ?? 600000);
const BROWSER_MAX_SHOTS = 200;
const GPU_RSS_RECYCLE_MB = 1200;
const LOCK = path.join(RUN_DIR, 'daemon.lock');
const T_START = Date.now();

const log = (...a) => console.error(`[rsd ${new Date().toISOString().slice(11, 23)}]`, ...a);

// ---------------------------------------------------------------- single instance
mkdirSync(RUN_DIR, { recursive: true });
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeLock() {
  for (let i = 0; i < 3; i++) {
    try { mkdirSync(LOCK); writeFileSync(path.join(LOCK, 'pid'), String(process.pid)); return true; } catch {
      let p = 0;
      try { p = Number(readFileSync(path.join(LOCK, 'pid'), 'utf8')); } catch { /* being created */ }
      if (p && pidAlive(p)) return false;
      if (!p) { try { if (Date.now() - statSync(LOCK).mtimeMs < 3000) return false; } catch { /* gone */ } }
      rmSync(LOCK, { recursive: true, force: true });
    }
  }
  return false;
}
if (!takeLock()) { log('another capture daemon is running; exiting'); process.exit(0); }

// ---------------------------------------------------------------- state
let retiring = false;
let stopping = false;
let lastActivity = Date.now();
const requests = new Map(); // id -> request
let nextReq = 1;
const queue = []; // jobs
let lastClient = null; // round robin: the client served last
const lanes = []; // { id, lane, busy, lease, job }
let browser = null;
let browserP = null;
let browserLease = null;
let browserShots = 0;
let browserInfo = null; // { version, renderer, lost }
let exclusiveRunning = 0;
const memoStats = { hits: 0, misses: 0, entries: 0, bytes: 0 };

// ---------------------------------------------------------------- memory governor (own tree only)
const gov = createGovernor({
  rootPid: process.pid,
  onShed: (a) => { log(`MemAvailable ${Math.round(a)} MB: shedding (idle pages close, one lane)`); for (const l of lanes.filter(Boolean)) if (!l.busy) void closeLanePage(l); },
  onClose: (a) => { log(`MemAvailable ${Math.round(a)} MB < 2500: closing the browser now (memory guard)`); closeBrowser('memory guard'); },
  onRecover: (a) => log(`MemAvailable ${Math.round(a)} MB: back to normal`),
  onRecycle: (p) => log(`tree PSS ${Math.round(p)} MB > cap: recycling pages between jobs`),
});

// ---------------------------------------------------------------- builds, static files, tile cache
const builds = new Map(); // distHash -> { dir, meta, stagedTree }
for (const [h, b] of buildIndex()) builds.set(h, { dir: b.dir, meta: b.meta, stagedTree: path.join(RENDER_DIR, 'trees', b.meta.treeHash) });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain' };

async function serveBuild(req, res) {
  const u = new URL(req.url, 'http://x');
  const [, , hash, ...rest] = u.pathname.split('/');
  const b = builds.get(hash) ?? (() => { const idx = buildIndex().get(hash); if (idx) builds.set(hash, { dir: idx.dir, meta: idx.meta, stagedTree: path.join(RENDER_DIR, 'trees', idx.meta.treeHash) }); return builds.get(hash); })();
  if (!b) { res.statusCode = 404; res.end('unknown build'); return; }
  let f = path.resolve(b.dir, decodeURIComponent(rest.join('/')));
  if (!f.startsWith(b.dir + path.sep) && f !== b.dir) { res.statusCode = 403; res.end(); return; }
  try { if (statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch { res.statusCode = 404; res.end(); return; }
  try {
    const body = await readFile(f);
    res.setHeader('Content-Type', MIME[path.extname(f)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // content-addressed
    res.setHeader('Referrer-Policy', 'same-origin'); // the tile-cache middleware routes by the referring build
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
}

// tile-cache middleware instances: one per (viteTileCache.ts source, cache dir, cap), from the tree being served
const middlewares = new Map();
async function tileCacheMiddleware(stagedTree, cfg) {
  const file = path.join(stagedTree, 'tools', 'viteTileCache.ts');
  const src = existsSync(file) ? readFileSync(file) : null;
  if (!src) return null;
  const key = `${createHash('sha1').update(src).digest('hex')}\0${cfg.dir}\0${cfg.mb}`;
  if (middlewares.has(key)) return middlewares.get(key);
  const p = (async () => {
    const mod = await import(pathToFileURL(file).href);
    const saved = { dir: process.env.BACKROOMS_TILE_CACHE_DIR, mb: process.env.BACKROOMS_TILE_CACHE_MB };
    process.env.BACKROOMS_TILE_CACHE_DIR = cfg.dir;
    process.env.BACKROOMS_TILE_CACHE_MB = String(cfg.mb);
    const fns = [];
    try {
      const plugin = mod.tileCachePlugin(true);
      await plugin.configureServer({ middlewares: { use: (p, fn) => fns.push([p, fn]) } });
    } finally {
      if (saved.dir === undefined) delete process.env.BACKROOMS_TILE_CACHE_DIR; else process.env.BACKROOMS_TILE_CACHE_DIR = saved.dir;
      if (saved.mb === undefined) delete process.env.BACKROOMS_TILE_CACHE_MB; else process.env.BACKROOMS_TILE_CACHE_MB = saved.mb;
    }
    return fns;
  })();
  middlewares.set(key, p);
  p.catch((e) => { log(`tile-cache middleware of ${stagedTree} failed: ${e.message}`); middlewares.delete(key); });
  return p;
}

async function serveTileCache(req, res, cfg) {
  const ref = /\/b\/([0-9a-f]{40})\//.exec(String(req.headers.referer ?? ''));
  const b = ref ? builds.get(ref[1]) : null;
  const tree = b?.stagedTree ?? [...builds.values()].at(-1)?.stagedTree;
  const fns = tree ? await tileCacheMiddleware(tree, cfg).catch(() => null) : null;
  const hit = fns?.find(([p]) => req.url.startsWith(p) || req.url.startsWith(p.replace(/\/$/, '')));
  if (!hit) { res.statusCode = 404; res.end(); return; }
  const [p, fn] = hit;
  req.url = req.url.slice(p.replace(/\/$/, '').length) || '/'; // connect strips the mount path
  if (req.method === 'GET') res.once('finish', () => noteCacheGet(res.statusCode === 200));
  fn(req, res, () => { res.statusCode = 404; res.end(); });
}

// recent tile-cache GETs: a mostly-missing cache means cold locations, where a second page only splits the
// memory-bandwidth-bound bake between 8 workers instead of 4 (no gain, +0.6 GB), so lane 1 stays closed
const cacheWindow = [];
let warmPump = null;
function noteCacheGet(hit) {
  cacheWindow.push(hit ? 1 : 0);
  if (cacheWindow.length > 60) cacheWindow.shift();
  // the cache just proved warm while work is queued: let lane 1 start
  if (!coldCache() && queue.length && !warmPump) warmPump = setTimeout(() => { warmPump = null; pump(); }, 100);
}
/** Not known to be warm: fewer than 20 recent GETs, or under 75 % hits. */
function coldCache() { return cacheWindow.length < 20 || cacheWindow.reduce((a, x) => a + x, 0) / cacheWindow.length < 0.75; }

// one origin per tile-cache setting (the worker addresses /__tilecache/ on its own origin)
const origins = new Map(); // `${dir}\0${mb}` -> { url, server }
function originFor(cfg) {
  const key = `${cfg.dir}\0${cfg.mb}`;
  if (origins.has(key)) return origins.get(key);
  const p = new Promise((res, rej) => {
    const srv = http.createServer((req, rsp) => {
      if (req.url.startsWith('/b/')) return void serveBuild(req, rsp);
      if (req.url.startsWith('/__tilecache/')) return void serveTileCache(req, rsp, cfg);
      rsp.statusCode = 404; rsp.end();
    });
    srv.keepAliveTimeout = 30000;
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${srv.address().port}`, server: srv }));
  });
  origins.set(key, p);
  return p;
}

// ---------------------------------------------------------------- browser

function browserEnvKey(e = process.env) { return JSON.stringify([e.CHROMIUM ?? '', e.BACKROOMS_GPU ?? '', e.BACKROOMS_UNCAPPED ?? '']); }
const MY_BROWSER_ENV = browserEnvKey();

function ensureBrowser() {
  if (browser) return Promise.resolve(browser);
  if (browserP) return browserP; // single flight: concurrent lanes never launch a second browser
  browserP = (async () => {
    const t0 = Date.now();
    await gov.whenOk();
    browserLease = await acquire({ weightMb: WEIGHTS.browser, kind: 'browser', label: `capture daemon browser (pid ${process.pid})`, onWait: broadcastWait });
    try {
      const b = await launchBrowser();
      const w = await warmGpu(b);
      browserInfo = { version: b.version(), renderer: w.renderer, lost: w.lost, exe: exeStamp() };
      try { writeFileSync(path.join(RUN_DIR, 'browser.json'), JSON.stringify(browserInfo)); } catch { /* ignore */ }
      b.on('disconnected', () => { if (browser === b) { log('browser disconnected'); browser = null; browserP = null; releaseBrowserLease(); for (const l of lanes) l.lane.setBrowser(null); } });
      browser = b;
      closedBy = null;
      browserShots = 0;
      for (const l of lanes) l.lane.setBrowser(b);
      log(`browser up in ${Date.now() - t0} ms (${browserInfo.version}; first-context loss ${w.lost ? 'absorbed' : 'not seen'})`);
      return b;
    } catch (e) { releaseBrowserLease(); throw e; }
  })();
  browserP.catch(() => { browserP = null; });
  return browserP;
}

/** A budget wait of the daemon: log it and tell every waiting client (they would otherwise see nothing). */
function broadcastWait(msg) {
  log(msg);
  for (const r of requests.values()) send(r, { type: 'log', msg: `[rsd] ${msg.replace(/^\[budget\] /, '')}` });
}

function releaseBrowserLease() { if (browserLease) { try { browserLease.release(); } catch { /* ignore */ } browserLease = null; } }

let closedBy = null; // why the browser last closed
async function closeBrowser(why) {
  const b = browser;
  closedBy = why;
  browser = null;
  browserP = null;
  for (const l of lanes) { l.lane.setBrowser(null); releasePageLease(l); }
  if (b) {
    log(`closing the browser (${why})`);
    await withTimeout(b.close(), 15000, 'browser.close').catch(() => killBrowser());
  }
  releaseBrowserLease();
}

/** Watchdog: SIGKILL the Chromium this daemon launched (only its own child). */
function killBrowser() {
  for (const pid of findInTree(process.pid, 'browser')) { try { process.kill(pid, 'SIGKILL'); log(`killed wedged browser pid ${pid}`); } catch { /* gone */ } }
}

function exeStamp() {
  const exe = process.env.CHROMIUM ?? '/usr/bin/chromium';
  try { const st = statSync(exe); return `${exe}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return exe; }
}

/** Chromium version + GPU renderer for memo keys, without launching when a previous launch recorded them. */
async function browserKey() {
  if (!browserInfo) {
    try { const b = JSON.parse(readFileSync(path.join(RUN_DIR, 'browser.json'), 'utf8')); if (b.exe === exeStamp()) browserInfo = b; } catch { /* none */ }
  }
  if (!browserInfo) await ensureBrowser();
  return `${browserInfo.version}\0${browserInfo.renderer}`;
}

// ---------------------------------------------------------------- memo

function memoIndex() {
  const idx = new Map();
  let names = [];
  try { names = readdirSync(MEMO_DIR); } catch { return idx; }
  for (const n of names) {
    if (!/^[0-9a-f]{40}$/.test(n)) continue;
    const d = path.join(MEMO_DIR, n);
    let bytes = 0;
    let t = 0;
    let dist = '';
    try {
      for (const f of readdirSync(d)) { const st = statSync(path.join(d, f)); bytes += st.size; if (f === 'entry.json') { t = st.mtimeMs; } }
      dist = JSON.parse(readFileSync(path.join(d, 'entry.json'), 'utf8')).distHash ?? '';
    } catch { continue; }
    idx.set(n, { bytes, t, dist });
  }
  return idx;
}
const memo = memoIndex();
const refreshMemoStats = () => { memoStats.entries = memo.size; memoStats.bytes = [...memo.values()].reduce((a, e) => a + e.bytes, 0); };
refreshMemoStats();

function evictMemo() {
  if (memoStats.bytes <= MEMO_CAP) return;
  const pins = pinnedDistHashes();
  for (const [k, e] of [...memo].sort((a, b) => a[1].t - b[1].t)) {
    if (memoStats.bytes <= MEMO_CAP * 0.9) break;
    if (pins.has(e.dist)) continue;
    try { rmSync(path.join(MEMO_DIR, k), { recursive: true, force: true }); } catch { /* ignore */ }
    memo.delete(k);
    memoStats.bytes -= e.bytes;
  }
  memoStats.entries = memo.size;
}

/** Copies a memo entry's files into the job's out dir and returns the result message (null on a miss). */
function memoGet(key, job) {
  const e = memo.get(key);
  if (!e) return null;
  const d = path.join(MEMO_DIR, key);
  try {
    const m = JSON.parse(readFileSync(path.join(d, 'entry.json'), 'utf8'));
    const entry = { ...m.entry, memo: true };
    const out = job.out;
    mkdirSync(out, { recursive: true });
    if (m.entry.file) { entry.file = path.join(out, shotFileName(job.index, job.shot)); copyFileSync(path.join(d, 'shot.png'), entry.file); }
    const qa = m.qa ? { ...m.qa, steps: m.qa.steps.map((s, k) => {
      if (!s.file) return s;
      const f = path.join(out, captureFileName(job.index, job.shot, k, job.shot.captures?.[k] ?? {}));
      copyFileSync(path.join(d, `c${k}.png`), f);
      return { ...s, file: f };
    }) } : null;
    // report identity of this request's shot
    for (const k of ['name', 'preset', 'page']) { if (job.shot[k]) entry[k] = job.shot[k]; else delete entry[k]; }
    entry.params = job.shot.params ?? '';
    const now = new Date();
    try { utimesSync(path.join(d, 'entry.json'), now, now); } catch { /* ignore */ }
    e.t = now.getTime();
    return { entry, qa };
  } catch { return null; }
}

function memoPut(key, distHash, entry, qa) {
  if (entry.errors?.length || !entry.file) return;
  if (entry.evalResults?.some((r) => typeof r === 'string' && r.startsWith('EVAL ERROR'))) return;
  if (qa?.steps?.some((s) => typeof s.result === 'string' && s.result.startsWith('EVAL ERROR'))) return;
  const d = path.join(MEMO_DIR, key);
  const tmp = `${d}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    copyFileSync(entry.file, path.join(tmp, 'shot.png'));
    qa?.steps?.forEach((s, k) => { if (s.file) copyFileSync(s.file, path.join(tmp, `c${k}.png`)); });
    writeFileSync(path.join(tmp, 'entry.json'), JSON.stringify({ distHash, entry, qa, at: new Date().toISOString() }));
    rmSync(d, { recursive: true, force: true });
    renameSync(tmp, d);
    let bytes = 0;
    for (const f of readdirSync(d)) bytes += statSync(path.join(d, f)).size;
    const prev = memo.get(key);
    memo.set(key, { bytes, t: Date.now(), dist: distHash });
    memoStats.bytes += bytes - (prev?.bytes ?? 0);
    memoStats.entries = memo.size;
    evictMemo();
  } catch (e) { log(`memo write failed: ${e.message}`); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- scheduling

/** Next job for a lane (policy.mjs pickJob), removed from the queue. */
function takeJob(l) {
  if (!queue.length) return null;
  const r = pickJob(queue, l.id, { warmKey: l.lane.warmKey, exclusiveRunning: exclusiveRunning > 0, othersBusy: lanes.some((x) => x && x !== l && x.job), last: lastClient });
  lastClient = r.last;
  if (r.job) queue.splice(queue.indexOf(r.job), 1);
  return r.job;
}

function newLaneSlot(id) {
  const lane = new Lane({ browser, root: '', log: (m) => log(`lane ${id}: ${m}`) });
  const slot = { id, lane, busy: false, lease: null, job: null };
  lanes[id] = slot;
  return slot;
}

function releasePageLease(l) { if (l.lease) { try { l.lease.release(); } catch { /* ignore */ } l.lease = null; } }

async function closeLanePage(l) {
  await l.lane.closePage().catch(() => {});
  if (!l.busy) releasePageLease(l);
}

/** Starts lanes for queued work (lane 1 only if the budget admits a second page right now). */
function pump() {
  if (stopping) return;
  if (!lanes[0]) newLaneSlot(0);
  if (!lanes[0].busy && queue.length) void runLane(lanes[0]);
  if (MAX_LANES > 1 && gov.state === 'ok' && exclusiveRunning === 0 && !coldCache() && queue.some((j) => laneEligible(1, j))) {
    const l1 = lanes[1] ?? newLaneSlot(1);
    // a refused second page is retried at most every 2 s
    if (!l1.busy && (lanes[0].busy || queue.length > 1) && Date.now() - (l1.refusedAt ?? 0) > 2000) void runLane(l1);
  }
}

async function ensurePageLease(l, job) {
  const w = pageWeight({ quality: qualityOf(job.shot), ...parseSize(job.shot.size ?? job.req.size) });
  if (l.lease && l.lease.weightMb >= w) return true;
  const label = `capture daemon page lane ${l.id} (pid ${process.pid})`;
  if (l.id === 0) {
    if (l.lease) { if (await l.lease.resize(w, { wait: true, timeoutMs: 600000 })) return true; releasePageLease(l); }
    l.lease = await acquire({ weightMb: w, kind: 'page', label, timeoutMs: 600000, onWait: broadcastWait });
    return !!l.lease;
  }
  if (l.lease) return l.lease.resize(w);
  l.lease = await acquire({ weightMb: w, kind: 'page', label, wait: false });
  return !!l.lease;
}

async function runLane(l) {
  if (l.busy) return;
  l.busy = true;
  let ran = 0;
  try {
    for (;;) {
      if (stopping) break;
      if (l.id > 0 && (gov.state !== 'ok' || coldCache())) break;
      const job = takeJob(l);
      if (!job) break;
      if (job.req.cancelled) { finishJob(job, null); continue; }
      if (!(await ensurePageLease(l, job))) { queue.unshift(job); l.refusedAt = Date.now(); break; } // lane 1 not admitted: lane 0 takes it
      l.job = job;
      ran++;
      if (job.exclusive) exclusiveRunning++;
      try { await runJob(l, job); } finally { if (job.exclusive) exclusiveRunning--; l.job = null; }
      // between jobs: recycle on PSS / shot counts
      if (gov.takeRecycle()) { await closeLanePage(l); if (gov.last.pssMb > 3200 && lanes.every((x) => !x.job)) await closeBrowser('tree PSS over the cap'); }
      const gpu = gov.last.byClass?.gpu?.rss ?? 0;
      if (browser && (browserShots >= BROWSER_MAX_SHOTS || gpu > GPU_RSS_RECYCLE_MB) && lanes.every((x) => !x.job)) await closeBrowser(`recycle after ${browserShots} shots, GPU RSS ${gpu} MB`);
      if (gov.state === 'shed') await closeLanePage(l);
    }
  } catch (e) {
    log(`lane ${l.id} failed: ${e.stack ?? e.message}`);
  } finally {
    l.busy = false;
    if (!l.lane.page) releasePageLease(l);
    lastActivity = Date.now();
    // a lane that ran something may have unblocked the other (exclusive jobs, lane 1 refusals)
    if (ran && queue.length && !stopping) setTimeout(pump, 50);
  }
}

async function runJob(l, job) {
  const { req, shot } = job;
  let msg;
  try {
    await gov.whenOk();
    const b = await ensureBrowser();
    if (l.lane.browser !== b) l.lane.setBrowser(b);
    const nEvals = (req.evals?.length ?? 0) + (shot.eval?.length ?? 0) + (shot.captures?.length ?? 0);
    const timeout = 2 * READY_TIMEOUT_MS + 60000 + nEvals * (req.evalTimeoutMs ?? 900000);
    const r = await withTimeout(l.lane.run(shot, {
      index: job.index, out: job.out, wait: req.wait ?? null, size: req.size, evals: req.evals ?? [], qa: !!req.qa,
      streamCapture: !!req.streamCapture, draft: !!req.draft, root: job.root, features: job.features, hc: req.hc, evalTimeoutMs: req.evalTimeoutMs,
      fresh: req.freshPages || undefined,
    }), timeout, 'capture job').catch(async (e) => {
      log(`lane ${l.id}: ${e.message}; closing its page`);
      await withTimeout(l.lane.closePage(), 15000, 'page.close').catch(async () => { killBrowser(); await closeBrowser('wedged page'); });
      return { entry: failEntry(shot, `SHOT ERROR: ${e.message}`), qa: null };
    });
    if (gov.state === 'closed' || closedBy === 'memory guard') r.entry.errors.push('memory guard: the capture browser was closed at low MemAvailable');
    browserShots++;
    if (job.memoKey && !r.entry.errors.length) memoPut(job.memoKey, job.distHash, r.entry, r.qa);
    msg = { entry: r.entry, qa: r.qa };
  } catch (e) {
    msg = { entry: failEntry(shot, /memory guard/.test(e.message) ? e.message : `SHOT ERROR: ${e.message}`), qa: null };
  }
  finishJob(job, msg);
}

function failEntry(shot, err) {
  const entry = { file: '', params: shot.params ?? '', readyMs: null, stats: null, evalResults: [], errors: [err], warnings: [] };
  for (const k of ['name', 'preset', 'page']) if (shot[k]) entry[k] = shot[k];
  return entry;
}

function finishJob(job, msg) {
  const req = job.req;
  req.pending--;
  if (msg && !req.cancelled) send(req, { type: 'shot', index: job.index, side: job.side, ...msg });
  if (req.pending === 0) endRequest(req);
}

function send(req, obj) {
  if (req.ended) return;
  try { req.res.write(JSON.stringify(obj) + '\n'); } catch { /* client gone */ }
}

function endRequest(req, extra = {}) {
  if (req.ended) return;
  send(req, { type: 'done', ms: Math.round(performance.now() - req.t0), memoHits: req.memoHits, peak: { rssMb: gov.peak.rssMb, pssMb: gov.peak.pssMb }, ...extra });
  req.ended = true;
  clearInterval(req.hb);
  try { req.res.end(); } catch { /* gone */ }
  requests.delete(req.id);
  lastActivity = Date.now();
  if (retiring && requests.size === 0) void shutdown('retired');
}

// ---------------------------------------------------------------- /render

async function handleRender(body, res) {
  const req = {
    id: nextReq++, client: String(body.client ?? 'anon'), res, t0: performance.now(), pending: 0, ended: false, cancelled: false, memoHits: 0,
    size: body.size ?? '1600x900', wait: Number.isFinite(body.wait) ? body.wait : null, evals: body.evals ?? [], qa: !!body.qa,
    streamCapture: !!body.streamCapture, draft: !!body.draft, memo: body.memo !== false, fresh: !!body.fresh, hc: Number(body.hc ?? 8),
    evalTimeoutMs: Number(body.evalTimeoutMs ?? 900000), class: body.class ?? null, freshPages: !!body.freshPages,
  };
  requests.set(req.id, req);
  res.on('close', () => {
    if (req.ended) return;
    req.cancelled = true;
    clearInterval(req.hb);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].req === req) { queue.splice(i, 1); req.pending--; }
    requests.delete(req.id);
    log(`client ${req.client} went away; dropped its queued shots`);
    if (retiring && requests.size === 0) void shutdown('retired');
  });
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  res.flushHeaders?.();
  // heartbeat: a client's fetch gives up on a body that stays silent for 300 s (long evals, queueing)
  req.hb = setInterval(() => send(req, { type: 'hb' }), 20000);
  const trees = body.trees ?? [body.tree];
  const outs = body.outs ?? [body.out];
  const tc = body.tileCache ?? { enabled: true, dir: path.join(os.homedir(), '.cache', 'backrooms-tilecache'), mb: 8192 };
  const origin = await originFor(tc);
  const sides = [];
  for (let s = 0; s < trees.length; s++) {
    const t = trees[s];
    if (!t || !existsSync(path.join(t, 'src')) || !path.isAbsolute(outs[s] ?? '')) { send(req, { type: 'error', message: `bad tree or out: ${t} ${outs[s]}` }); return endRequest(req, { failed: true }); }
    let b;
    try { b = await ensureBuild(t, { tileCache: tc.enabled, log, inUse: new Set([...builds.keys()].slice(-2)) }); } catch (e) {
      send(req, { type: 'error', message: `build of ${t} failed: ${e.message}` });
      return endRequest(req, { failed: true });
    }
    builds.set(b.distHash, { dir: b.dir, meta: b, stagedTree: b.stagedTree });
    if (tc.enabled) await tileCacheMiddleware(b.stagedTree, tc).catch(() => null);
    send(req, { type: 'build', side: s, tree: t, distHash: b.distHash, treeHash: b.treeHash, cached: b.cached, ms: b.ms, hashMs: b.hashMs });
    sides.push({ tree: t, out: outs[s], build: b, root: `${origin.url}/b/${b.distHash}/`, features: treeFeatures(b.stagedTree) });
    mkdirSync(outs[s], { recursive: true });
  }
  if (req.cancelled) return;
  const shots = body.shots ?? [];
  const bkey = shots.some((s) => memoAllowed(s, req)) ? await browserKey().catch(() => null) : null;
  // the lane's searchOf decides noprime from the browser warm-up; mirror it for keys
  const warmed = browserInfo?.lost ?? true;
  const probe = new Lane({ browser: null, root: '', warmed, features: sides[0]?.features });
  const jobs = [];
  for (const side of sides) {
    const order = planOrder(shots, (s) => probe.searchOf(s, { ...req, features: side.features }), { size: req.size, hc: req.hc, bootKeys: side.features.bootKeys });
    order.forEach((i, rank) => {
      const shot = shots[i];
      const search = probe.searchOf(shot, { ...req, features: side.features });
      const job = {
        req, shot, index: i, side: sides.indexOf(side), out: side.out, root: side.root, features: side.features, distHash: side.build.distHash, rank,
        exclusive: isExclusive(shot, req),
        warmKey: isGameShot(shot) ? `${side.root}\n${probe.keyOf(shot, search, { size: req.size, hc: req.hc, features: side.features })}` : null,
        memoKey: null,
      };
      if (bkey && memoAllowed(shot, req)) job.memoKey = memoKey({ distHash: side.build.distHash, shot, search, r: req, browserKey: bkey, codeHash: CAPTURE_CODE_HASH });
      jobs.push(job);
    });
  }
  // A/B: interleave the sides (base i, test i, ...) so paired lanes render the same framing together
  if (sides.length > 1) jobs.sort((a, b) => a.rank - b.rank || a.side - b.side);
  req.pending = jobs.length;
  if (!jobs.length) return endRequest(req);
  for (const job of jobs) {
    if (job.memoKey && !req.fresh) {
      const hit = memoGet(job.memoKey, job);
      if (hit) { memoStats.hits++; req.memoHits++; finishJob(job, hit); continue; }
      memoStats.misses++;
    }
    queue.push(job);
  }
  pump();
}

// ---------------------------------------------------------------- control API

function statusObj(quick) {
  const s = {
    pid: process.pid, port: controlPort, version: VERSION, retiring, uptimeS: (Date.now() - T_START) / 1000, idleS: (Date.now() - lastActivity) / 1000,
    browser: { open: !!browser, shots: browserShots, version: browserInfo?.version, renderer: browserInfo?.renderer },
    lanes: lanes.filter(Boolean).map((l) => ({ id: l.id, busy: l.busy, warmPage: !!l.lane.page, pageShots: l.lane.pageShots, leaseMb: l.lease?.weightMb ?? 0 })),
    queue: { total: queue.length, byClient: queue.reduce((a, j) => ((a[j.req.client] = (a[j.req.client] ?? 0) + 1), a), {}) },
    requests: requests.size,
    mem: { ...gov.last, state: gov.state, peak: gov.peak },
    builds: builds.size,
    memo: { ...memoStats },
    tileCache: { recentGets: cacheWindow.length, recentHitRate: cacheWindow.length ? +(cacheWindow.reduce((a, x) => a + x, 0) / cacheWindow.length).toFixed(2) : null, cold: coldCache() },
  };
  if (!quick) s.budget = budgetStatus();
  return s;
}

let controlPort = 0;
const control = http.createServer(async (req, res) => {
  if (req.method === 'POST') lastActivity = Date.now(); // status polls do not keep the daemon alive
  const json = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  try {
    if (req.url.startsWith('/b/')) return void serveBuild(req, res);
    if (req.url.startsWith('/__tilecache/')) return void serveTileCache(req, res, { dir: path.resolve(process.env.BACKROOMS_TILE_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'backrooms-tilecache')), mb: Number(process.env.BACKROOMS_TILE_CACHE_MB ?? 8192) });
    if (req.method === 'GET' && req.url.startsWith('/status')) return json(200, statusObj(req.url.includes('quick')));
    if (req.method === 'POST' && req.url === '/retire') {
      if (!retiring) { retiring = true; log('retiring: a client runs other tool code'); }
      json(200, { ok: true });
      if (requests.size === 0) void shutdown('retired');
      return;
    }
    if (req.method === 'POST' && req.url === '/stop') { json(200, { ok: true }); void shutdown('stop requested'); return; }
    if (req.method === 'POST' && req.url === '/render') {
      if (retiring || stopping) return json(409, { error: 'retiring' });
      const body = JSON.parse(await new Promise((r, j) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => r(s)); req.on('error', j); }));
      if (body.browserEnv && browserEnvKey(body.browserEnv) !== MY_BROWSER_ENV) return json(409, { error: 'browser-env', mine: MY_BROWSER_ENV });
      return void handleRender(body, res).catch((e) => { log(`render failed: ${e.stack ?? e.message}`); try { res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n'); res.end(); } catch { /* gone */ } });
    }
    json(404, { error: 'unknown endpoint' });
  } catch (e) { json(500, { error: e.message }); }
});
control.keepAliveTimeout = 30000;
control.requestTimeout = 0; // /render streams for as long as its shots take

async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log(`shutting down: ${why}`);
  for (const r of requests.values()) { try { r.res.write(JSON.stringify({ type: 'error', message: `daemon ${why}` }) + '\n'); r.res.end(); } catch { /* gone */ } }
  await closeBrowser(why).catch(() => {});
  gov.stop();
  try { const i = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')); if (i.pid === process.pid) unlinkSync(DAEMON_JSON); } catch { /* ignore */ }
  rmSync(LOCK, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('exit', () => { try { const i = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')); if (i.pid === process.pid) unlinkSync(DAEMON_JSON); } catch { /* ignore */ } try { const p = Number(readFileSync(path.join(LOCK, 'pid'), 'utf8')); if (p === process.pid) rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ } });
process.on('uncaughtException', (e) => { log(`uncaught: ${e.stack ?? e.message}`); });
process.on('unhandledRejection', (e) => { log(`unhandled rejection: ${e?.stack ?? e}`); });

// ---------------------------------------------------------------- idle policy
setInterval(async () => {
  const now = Date.now();
  const busy = lanes.some((l) => l?.busy) || queue.length > 0;
  for (const l of lanes) if (l && !l.busy && l.lane.page && now - l.lane.lastUsed > IDLE_PAGE_MS) { log(`lane ${l.id}: closing its idle warm page`); await closeLanePage(l); }
  // at most one idle warm page
  const warm = lanes.filter((l) => l && !l.busy && l.lane.page);
  if (warm.length > 1) for (const l of warm.slice(1)) await closeLanePage(l);
  if (browser && !busy) {
    let foreignWaiter = false;
    try { foreignWaiter = budgetStatus().waiters.some((w) => w.kind === 'browser' && w.pid !== process.pid); } catch { /* ignore */ }
    const idle = Math.min(...lanes.filter(Boolean).map((l) => now - l.lane.lastUsed), now - lastActivity);
    if (foreignWaiter) await closeBrowser('another tool waits for the browser slot');
    else if (idle > IDLE_BROWSER_MS) await closeBrowser('idle');
  }
  if (!busy && requests.size === 0 && now - lastActivity > IDLE_EXIT_MS) await shutdown('idle');
}, 2000).unref();

control.listen(Number(process.env.BACKROOMS_RSD_PORT ?? 0), '127.0.0.1', () => {
  controlPort = control.address().port;
  writeFileSync(`${DAEMON_JSON}.tmp`, JSON.stringify({ pid: process.pid, port: controlPort, version: VERSION, started: new Date().toISOString(), code: import.meta.dirname }));
  renameSync(`${DAEMON_JSON}.tmp`, DAEMON_JSON);
  log(`capture daemon ${VERSION} (pid ${process.pid}) on http://127.0.0.1:${controlPort}; renders from ${RENDER_DIR}; lanes <= ${MAX_LANES}`);
});
