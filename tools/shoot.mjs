#!/usr/bin/env node
// Headless GPU screenshot + smoke-test harness (WP14).
//
// Usage:
//   node tools/shoot.mjs [--params "seed=1&x=4&z=4&yaw=0.5"]... [--out dir] [--wait ms]
//                        [--size 1600x900] [--url http://localhost:5173] [--eval "js expr"]...
//                        [--page harness/chunk.html] [--preset name[,name...]]...
//
// Each --params produces one screenshot (<out>/<index>-<slug>.png). The page is loaded with `autostart=1`
// appended so the game skips the title screen. If --url is omitted, a Vite dev server is started on a free port
// and stopped at the end. Prints a JSON report: console errors, page errors, window.__backrooms.stats() per shot.
//
// --page <path>    path relative to the server root (e.g. harness/materials.html) for every --params shot.
// --preset <name>  loads tools/qa-presets.json -> a list of {name, page?, params, size?, wait?, eval?[]} shots
//                  (run after the --params shots; `--params` defaults to seed=1 only when no preset is given).
//
// The helpers are exported for tools/qa.mjs (same browser code); the CLI runs only when this file is executed.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = path.resolve(import.meta.dirname, '..');
export const PRESETS_FILE = path.join(REPO, 'tools', 'qa-presets.json');
export const READY_TIMEOUT_MS = 60000;
export const EVAL_TIMEOUT_MS = Number(process.env.BACKROOMS_EVAL_TIMEOUT_MS ?? 900000); // soak evals run minutes

/** Rejects after `ms` (a page.evaluate on a destroyed context can otherwise hang for ~10 minutes). */
export function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- machine-wide resource guard
// Many agents may run this tool concurrently on a 14 GB machine. Every process that starts Vite or a browser first
// takes one of BACKROOMS_BROWSER_SLOTS (default 1) machine-wide slots and waits until MemAvailable >=
// BACKROOMS_MIN_FREE_MB (default 3000). The slot is held until the process exits. Pages see
// navigator.hardwareConcurrency = BACKROOMS_HC (default 8) so the game's bake-worker pool stays small (8 - 4 = 4).
const SLOT_DIR = '/tmp/backrooms-browser-slots';
const SLOTS = Math.max(1, Number(process.env.BACKROOMS_BROWSER_SLOTS ?? 1));
const MIN_FREE_MB = Number(process.env.BACKROOMS_MIN_FREE_MB ?? 3000);
export const PAGE_HC = Math.max(2, Number(process.env.BACKROOMS_HC ?? 8));
let heldSlot = null;

function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function releaseSlot() {
  if (heldSlot) { try { rmSync(heldSlot, { recursive: true, force: true }); } catch {} heldSlot = null; }
}
export async function acquireSlot() {
  if (heldSlot) return;
  mkdirSync(SLOT_DIR, { recursive: true });
  let waitedMs = 0;
  let announced = false;
  for (;;) {
    for (let i = 0; i < SLOTS && !heldSlot; i++) {
      const dir = path.join(SLOT_DIR, `slot-${i}`);
      try {
        mkdirSync(dir); // atomic: fails if the slot is taken
        writeFileSync(path.join(dir, 'pid'), String(process.pid));
        heldSlot = dir;
      } catch {
        // reclaim a slot whose owner died without cleaning up
        try {
          const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8'));
          if (pid && !pidAlive(pid)) rmSync(dir, { recursive: true, force: true });
        } catch {
          try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      }
    }
    if (heldSlot) {
      if (memAvailableMb() >= MIN_FREE_MB) break;
      releaseSlot(); // do not hog the slot while the machine is short on memory
    }
    if (!announced && waitedMs > 1000) { console.error(`[shoot] waiting for a browser slot / free memory (need ${MIN_FREE_MB} MB)...`); announced = true; }
    await new Promise((r) => setTimeout(r, 500));
    waitedMs += 500;
  }
  process.once('exit', releaseSlot);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { releaseSlot(); process.exit(130); });
}

export function parseArgs(argv) {
  const opt = { params: [], out: 'shots', wait: 4000, size: '1600x900', url: null, evals: [], page: '', presets: [], extra: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--params') { opt.params.push(v ?? ''); i++; }
    else if (a === '--out') { opt.out = v; i++; }
    else if (a === '--wait') { opt.wait = Number(v); i++; }
    else if (a === '--size') { opt.size = v; i++; }
    else if (a === '--url') { opt.url = v; i++; }
    else if (a === '--eval') { opt.evals.push(v); i++; }
    else if (a === '--page') { opt.page = String(v ?? '').replace(/^\/+/, ''); i++; }
    else if (a === '--preset') { opt.presets.push(...String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)); i++; }
    else if (a === '-h' || a === '--help') { opt.help = true; }
    else if (a.startsWith('--')) { opt.extra[a.slice(2)] = v; i++; } // tool-specific flags (qa.mjs)
  }
  return opt;
}

export function parseSize(size) {
  const [w, h] = String(size || '1600x900').split('x').map(Number);
  return { width: Number.isFinite(w) && w > 0 ? w : 1600, height: Number.isFinite(h) && h > 0 ? h : 900 };
}

export function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

export async function startVite() {
  await acquireSlot();
  const port = await freePort();
  const proc = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: REPO,
    env: { ...process.env, BACKROOMS_TOOL: '1' }, // vite.config.ts: no HMR / file watching during captures
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  // the server runs in its own process group (detached): stop it on every exit path, including SIGTERM/SIGINT
  // (the signal handlers in acquireSlot call process.exit, which runs 'exit' listeners)
  process.once('exit', () => stopVite({ proc }));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.ok) return { url, proc }; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  stopVite({ proc });
  throw new Error('vite did not start:\n' + log);
}

export function stopVite(v) {
  if (!v || v.proc.stopped) return;
  v.proc.stopped = true;
  try { process.kill(-v.proc.pid, 'SIGTERM'); } catch {}
}

/** BACKROOMS_GPU=amd: expose only the Mesa RADV Vulkan driver, so ANGLE renders on the AMD iGPU (profiling for weak
 * GPUs on this hybrid laptop). Default: all drivers; ANGLE/Vulkan picks the discrete NVIDIA GPU. */
const GPU_ENV = process.env.BACKROOMS_GPU === 'amd' ? { VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/radeon_icd.json' } : {};

export async function launchBrowser() {
  await acquireSlot();
  return chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    env: { ...process.env, ...GPU_ENV },
    args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required', '--renderer-process-limit=2', '--js-flags=--max-old-space-size=2048'],
  });
}

// GPU warm-up: in a fresh headless Chromium (ANGLE/Vulkan) the first WebGL context is lost ~0.5 s after
// creation while the GPU process re-initialises, which would drop the app's renderer mid-boot. Absorb that
// on a throwaway page first (resolves on 'webglcontextlost' or after 2 s if the platform never does it).
export async function warmGpu(browser) {
  const w = await browser.newPage();
  try {
    await w.evaluate(() => new Promise((res) => {
      const c = document.createElement('canvas');
      if (!c.getContext('webgl2')) { res(); return; }
      c.addEventListener('webglcontextlost', () => setTimeout(res, 100));
      setTimeout(res, 2000);
    }));
  } catch {}
  await w.close();
}

/** Base URL of a page (relative to the server root). */
export function baseUrl(root, page) {
  return page ? new URL(String(page).replace(/^\/+/, ''), root.endsWith('/') ? root : root + '/').href : root;
}

/** Full URL of a shot: base + params + autostart=1 (always last, as before). */
export function shotUrl(root, page, params) {
  const base = baseUrl(root, page);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params}${params ? '&' : ''}autostart=1`;
}

export function slugOf(params) {
  return String(params ?? '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'default';
}

/** Preset shots from tools/qa-presets.json ({ "<preset>": [shot...] }). Throws on an unknown preset name. */
export function loadPresets(names, file = PRESETS_FILE) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const list = names.length === 1 && names[0] === 'all' ? Object.keys(all).filter((k) => !k.startsWith('$')) : names;
  const shots = [];
  for (const n of list) {
    const p = all[n];
    if (!Array.isArray(p)) throw new Error(`unknown preset '${n}' (have: ${Object.keys(all).filter((k) => !k.startsWith('$')).join(', ')})`);
    for (const s of p) shots.push({ ...s, preset: n, params: s.params ?? '' });
  }
  return shots;
}

/**
 * Opens one shot, waits for ready + `wait`, runs evals, takes the screenshot and collects stats().
 * `after(page, entry)` (optional, used by qa.mjs) runs while the page is still open.
 * Returns the report entry (JSON-safe) and the PNG buffer.
 */
export async function runShot(browser, root, shot, { index, out, wait, size, evals = [] }, after) {
  const { width, height } = parseSize(shot.size ?? size);
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((hc) => { try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => hc }); } catch {} }, PAGE_HC);
  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack ?? e.message)));
  const params = shot.params ?? '';
  const full = shotUrl(root, shot.page ?? '', params);
  const t0 = Date.now();
  let readyMs = null;
  // main-frame navigations after the initial load (a dev-server reload would reset the page mid-capture)
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  const entry = { file: '', params, readyMs, stats: null, evalResults: [], errors, warnings: [] };
  if (shot.name) entry.name = shot.name;
  if (shot.preset) entry.preset = shot.preset;
  if (shot.page) entry.page = shot.page;
  let png = null;
  try {
    await page.goto(full, { waitUntil: 'load' });
    const waitReady = async () => {
      await page.waitForFunction(() => {
        const b = window.__backrooms;
        return b && (b.ready === true || (typeof b.isReady === 'function' && b.isReady()));
      }, null, { timeout: READY_TIMEOUT_MS, polling: 100 });
    };
    try {
      await waitReady();
      readyMs = Date.now() - t0;
    } catch { errors.push('TIMEOUT waiting for window.__backrooms.ready'); }
    let navsAtReady = navs;
    entry.readyMs = readyMs;
    await page.waitForTimeout(shot.wait ?? wait);
    // the page reloaded after ready (e.g. a dev-server reload): wait for the new page's ready gate once more, so the
    // capture never shows the loading screen
    if (readyMs !== null && navs !== navsAtReady) {
      warnings.push('shoot: the page navigated after ready; waiting for ready again');
      try { await waitReady(); await page.waitForTimeout(shot.wait ?? wait); } catch { errors.push('TIMEOUT waiting for ready after a reload'); }
      navsAtReady = navs;
    }
    for (const e of [...evals, ...(shot.eval ?? [])]) {
      try { entry.evalResults.push(await withTimeout(page.evaluate(e), EVAL_TIMEOUT_MS, 'eval')); } catch (err) { entry.evalResults.push('EVAL ERROR: ' + err.message); }
    }
    entry.stats = await withTimeout(page.evaluate(() => {
      try { return window.__backrooms?.stats?.() ?? null; } catch (e) { return 'stats() threw: ' + e.message; }
    }), 30000, 'stats()');
    // one rAF so the screenshot never races the first frames after a late evaluate
    await withTimeout(page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))), 10000, 'rAF').catch(() => {});
    const slug = shot.name ? slugOf(shot.name) : slugOf(params);
    entry.file = path.join(out, `${String(index).padStart(2, '0')}-${slug}.png`);
    png = await page.screenshot({ path: entry.file });
    if (after) await after(page, entry);
  } catch (err) {
    errors.push('SHOT ERROR: ' + (err?.message ?? String(err)));
  } finally {
    entry.warnings = warnings.slice(0, 20);
    await page.close().catch(() => {});
  }
  return { entry, png };
}

export async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  const shots = opt.params.map((p) => ({ params: p, page: opt.page || undefined }));
  if (opt.presets.length) shots.push(...loadPresets(opt.presets));
  if (shots.length === 0) shots.push({ params: 'seed=1', page: opt.page || undefined });
  let vite = null;
  const root = opt.url ?? (vite = await startVite()).url;
  mkdirSync(opt.out, { recursive: true });
  const browser = await launchBrowser();
  const report = [];
  try {
    await warmGpu(browser);
    for (let i = 0; i < shots.length; i++) {
      const { entry } = await runShot(browser, root, shots[i], { index: i, out: opt.out, wait: opt.wait, size: opt.size, evals: opt.evals });
      report.push(entry);
    }
  } finally {
    await browser.close();
    stopVite(vite);
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e); process.exitCode = 1; });
}
