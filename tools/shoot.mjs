#!/usr/bin/env node
// Headless GPU screenshot + smoke-test harness (WP14).
//
// Usage:
//   node tools/shoot.mjs [--params "seed=1&x=4&z=4&yaw=0.5"]... [--out dir] [--wait ms]
//                        [--size 1600x900] [--eval "js expr"]... [--page harness/chunk.html] [--preset name[,name...]]...
//                        [--draft] [--fresh] [--no-memo] [--stream full] [--direct] [--url http://localhost:5173]
//
// Each --params produces one screenshot (<out>/<index>-<slug>.png). The page is loaded with `autostart=1` appended
// so the game skips the title screen. Prints a JSON report: console errors, page errors, window.__backrooms.stats()
// per shot, and a timing breakdown (`t`).
//
// By default the shots go to the capture daemon (tools/rsd/server.mjs, started on demand): one warm headless
// Chromium per machine that renders a content-addressed build of this tree. An unchanged tree + shot is served
// from the capture memo in milliseconds. --direct starts a Vite dev server and a browser in this process instead
// (same capture code, same memory budget); --url <server> implies --direct.
//
// --page <path>    path relative to the server root (e.g. harness/materials.html) for every --params shot.
// --preset <name>  loads tools/qa-presets.json -> a list of {name, page?, params, size?, wait?, eval?[]} shots
//                  (run after the --params shots; `--params` defaults to seed=1 only when no preset is given).
// --wait <ms>      wait after ready (default: 0 when the page reports capture contract v2, else 250).
// --draft          bake=preview: fast approximate lighting (report entries get draft:true; not for baselines).
// --fresh          render even if the memo has the shot; --no-memo also stores nothing.
// --stream full    do not add stream=capture (default for game shots without --eval when the tree supports it).
//
// The helpers are exported for tools/qa.mjs and tools/showcase.mjs; the CLI runs only when this file is executed.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquire, WEIGHTS, pageWeight } from './lib/budget.mjs';
import { createGovernor } from './lib/procmem.mjs';
import {
  REPO, PRESETS_FILE, READY_TIMEOUT_MS, EVAL_TIMEOUT_MS, PAGE_HC, Lane, withTimeout, parseSize, slugOf, loadPresets,
  baseUrl, gameSearch, launchBrowser as launchChromium, warmGpu as warmChromium, treeFeatures, planOrder, isGameShot,
} from './lib/capture.mjs';

export { REPO, PRESETS_FILE, READY_TIMEOUT_MS, EVAL_TIMEOUT_MS, PAGE_HC, withTimeout, parseSize, slugOf, loadPresets, baseUrl };

// ---------------------------------------------------------------- machine-wide resource guard
// Every process that starts Vite or a browser in-process takes a lease from the machine-wide memory budget
// (tools/lib/budget.mjs): a browser slot (BACKROOMS_BROWSER_SLOTS, default 1) plus its weight, admitted only while
// the budget and MemAvailable >= BACKROOMS_MIN_FREE_MB (default 4500) allow. Pages see navigator.hardwareConcurrency
// = BACKROOMS_HC (default 8), so the game's bake-worker pool stays at 4.
let heldLease = null;
let leaseP = null;

/** Takes this process's browser lease (held until exit). Kept for tools/showcase.mjs and older scripts. */
export function acquireSlot({ weightMb = WEIGHTS.browser + WEIGHTS.pageHeavy + WEIGHTS.vite, label } = {}) {
  if (heldLease) return Promise.resolve(heldLease);
  leaseP ??= acquire({ weightMb, kind: 'browser', label: label ?? `${path.basename(process.argv[1] ?? 'tool')} (pid ${process.pid}, ${process.cwd()})` })
    .then((l) => {
      heldLease = l;
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { try { l.release(); } catch { /* ignore */ } process.exit(130); });
      return l;
    });
  return leaseP;
}

export function releaseSlot() {
  if (heldLease) { try { heldLease.release(); } catch { /* ignore */ } heldLease = null; leaseP = null; }
}

export function parseArgs(argv) {
  const opt = { params: [], out: 'shots', wait: null, size: '1600x900', url: null, evals: [], page: '', presets: [], extra: {}, flags: new Set() };
  const FLAGS = new Set(['direct', 'draft', 'fresh', 'no-memo', 'memo', 'list', 'json', 'progress']);
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
    else if (a.startsWith('--') && FLAGS.has(a.slice(2))) { opt.flags.add(a.slice(2)); }
    else if (a.startsWith('--')) { opt.extra[a.slice(2)] = v; i++; } // tool-specific flags (qa.mjs)
  }
  return opt;
}

export function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** Starts a Vite dev server for this tree (no npx: node runs vite's bin directly). */
export async function startVite({ lease = true, tree = REPO } = {}) {
  if (lease) await acquireSlot();
  const port = await freePort();
  const vite = path.join(tree, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [vite, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: tree,
    env: { ...process.env, BACKROOMS_TOOL: '1' }, // vite.config.ts: no HMR / file watching during captures
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}/`;
  // the server runs in its own process group (detached): stop it on every exit path, including SIGTERM/SIGINT
  process.once('exit', () => stopVite({ proc }));
  let exited = false;
  proc.once('exit', () => { exited = true; });
  for (let i = 0; i < 400 && !exited; i++) {
    try { const r = await fetch(url); if (r.ok) return { url, proc }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  stopVite({ proc });
  throw new Error('vite did not start:\n' + log);
}

export function stopVite(v) {
  if (!v || v.proc.stopped) return;
  v.proc.stopped = true;
  try { process.kill(-v.proc.pid, 'SIGTERM'); } catch { /* gone */ }
}

/** Launches the tool browser (takes this process's browser lease first). */
export async function launchBrowser() {
  await acquireSlot();
  return launchChromium();
}

/** GPU warm-up (see tools/lib/capture.mjs warmGpu); marks the browser so its game pages may skip priming. */
export async function warmGpu(browser) {
  return warmChromium(browser);
}

/** Full URL of a shot as the tools load it (params + autostart=1 last), for a browser without the GPU warm-up. */
export function shotUrl(root, page, params) {
  const base = baseUrl(root, page);
  return `${base}${base.includes('?') ? '&' : '?'}${gameSearch({ params, page }, {})}`;
}

/**
 * One shot on a fresh page (compatibility wrapper around the capture core; tools use runShots / the daemon).
 * `after(page, entry)` is no longer supported: pass { qa: true } to get the QA extras.
 */
export async function runShot(browser, root, shot, { index, out, wait = null, size, evals = [], qa = false } = {}) {
  const lane = new Lane({ browser, root, keepPages: false, features: treeFeatures(REPO) });
  const r = await lane.run(shot, { index, out, wait, size, evals, qa });
  return { entry: r.entry, png: r.png, qa: r.qa };
}

/** Page weight of a shot list (one page at a time). */
export function listPageWeight(shots, size) {
  return Math.max(...shots.map((s) => {
    const { width, height } = parseSize(s.size ?? size);
    return pageWeight({ quality: new URLSearchParams(String(s.params ?? '')).get('quality') ?? 'high', width, height });
  }), WEIGHTS.page);
}

/**
 * In-process capture of a shot list (the --direct path): a Vite dev server (unless `url`) and one browser, started
 * in parallel under one budget lease, one Lane, the memory governor on this process tree. Shots run grouped by boot
 * key; `onResult(index, result)` fires as each finishes. Returns { results (original order), peak, setupMs }.
 */
export async function runDirect(shots, o = {}) {
  const log = o.log ?? ((m) => console.error(`[${o.tool ?? 'shoot'}] ${m}`));
  const T0 = performance.now();
  const lease = await acquireSlot({
    weightMb: WEIGHTS.browser + listPageWeight(shots, o.size) + (o.url ? 0 : WEIGHTS.vite),
    label: `${o.tool ?? 'shoot'}.mjs --direct (pid ${process.pid}, ${shots.length} shots, ${process.cwd()})`,
  });
  let browser = null;
  let vite = null;
  let closedByGuard = false;
  const startBrowser = async () => {
    const b = await launchChromium();
    const w = await warmChromium(b);
    if (!w.lost) log(`GPU warm-up saw no first-context loss in ${w.ms} ms: pages prime themselves`);
    return b;
  };
  let lane = null;
  const gov = createGovernor({
    rootPid: process.pid,
    onShed: (a) => { log(`MemAvailable ${Math.round(a)} MB: shedding (no warm page)`); },
    onClose: (a) => {
      log(`MemAvailable ${Math.round(a)} MB < 2500: closing the browser (memory guard)`);
      closedByGuard = true;
      const b = browser;
      browser = null;
      if (b) b.close().catch(() => {});
    },
  });
  const results = new Array(shots.length);
  try {
    [vite, browser] = await Promise.all([o.url ? null : startVite({ lease: false }), startBrowser()]);
    const root = o.url ?? vite.url;
    const features = o.url ? { bootKeys: null, streamCapture: false } : treeFeatures(REPO);
    const setupMs = Math.round(performance.now() - T0);
    lane = new Lane({ browser, root, features, log });
    const order = planOrder(shots, (s) => lane.searchOf(s, o), { size: o.size, hc: PAGE_HC, bootKeys: features.bootKeys });
    for (const i of order) {
      if (gov.state === 'shed') await lane.closePage();
      if (gov.state !== 'ok') {
        try { await gov.whenOk(); } catch (e) { results[i] = guardFail(shots[i], e.message); o.onResult?.(i, results[i]); continue; }
      }
      if (!browser) {
        browser = await startBrowser();
        lane = new Lane({ browser, root, features, log });
      }
      const r = await lane.run(shots[i], { ...o, index: i, fresh: o.freshPages || undefined });
      if (closedByGuard && !browser) { r.entry.errors.push('memory guard: the browser was closed at MemAvailable < 2500 MB'); closedByGuard = false; }
      if (gov.takeRecycle()) await lane.closePage();
      results[i] = r;
      o.onResult?.(i, r);
    }
    return { results, peak: gov.peak, setupMs };
  } finally {
    gov.stop();
    if (lane) await lane.closePage().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    stopVite(vite);
    releaseSlot();
    void lease;
  }
}

function guardFail(shot, msg) {
  const entry = { file: '', params: shot.params ?? '', readyMs: null, stats: null, evalResults: [], errors: [msg], warnings: [] };
  if (shot.name) entry.name = shot.name;
  if (shot.preset) entry.preset = shot.preset;
  return { entry, png: null, qa: null };
}

/** One progress line per finished shot (stderr). */
export function progressLine(tool, done, total, entry) {
  const t = entry.t ?? {};
  const secs = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(2));
  const how = entry.memo ? `memo; rendered in ${secs(t.total)} s` : `${secs(t.total)} s, ready ${secs(entry.readyMs)}, ${entry.inPlace ? 'in place' : 'fresh page'}`;
  const err = entry.errors?.length ? `  ${entry.errors.length} error(s): ${String(entry.errors[0]).slice(0, 120)}` : '';
  return `[${tool}] ${String(done).padStart(String(total).length)}/${total} (${how})  ${(entry.name ?? entry.params).slice(0, 90)}${err}`;
}

function shotsFromOptions(opt) {
  const shots = opt.params.map((p) => ({ params: p, page: opt.page || undefined }));
  if (opt.presets.length) shots.push(...loadPresets(opt.presets));
  if (shots.length === 0) shots.push({ params: 'seed=1', page: opt.page || undefined });
  return shots;
}

export async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  const shots = shotsFromOptions(opt);
  mkdirSync(opt.out, { recursive: true });
  const T0 = performance.now();
  const direct = opt.flags.has('direct') || !!opt.url || process.env.BACKROOMS_RSD === '0';
  const common = {
    out: opt.out, wait: Number.isFinite(opt.wait) ? opt.wait : null, size: opt.size, evals: opt.evals,
    draft: opt.flags.has('draft'), streamCapture: opt.extra.stream !== 'full',
  };
  const report = new Array(shots.length);
  let done = 0;
  const onResult = (i, r) => { report[i] = r.entry; console.error(progressLine('shoot', ++done, shots.length, r.entry)); };
  if (direct) {
    await runDirect(shots, { ...common, url: opt.url, tool: 'shoot', onResult });
  } else {
    const { render } = await import('./rsd/client.mjs');
    const res = await render({
      tool: 'shoot', tree: REPO, shots, ...common, out: path.resolve(opt.out),
      memo: !opt.flags.has('no-memo'), fresh: opt.flags.has('fresh') || opt.flags.has('no-memo'),
      onResult: (i, r) => { r.entry.file &&= path.join(opt.out, path.basename(r.entry.file)); onResult(i, r); },
    });
    if (res.build) console.error(`[shoot] build ${res.build.distHash.slice(0, 12)} (${res.build.cached ? 'cached' : `built in ${(res.build.ms / 1000).toFixed(2)} s`})`);
  }
  const memo = report.filter((e) => e?.memo).length;
  console.error(`[shoot] ${shots.length} shot(s) in ${((performance.now() - T0) / 1000).toFixed(2)} s${memo ? ` (${memo} from the memo)` : ''}${direct ? ' (direct)' : ''}`);
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

export { isGameShot };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e); process.exitCode = 1; });
}
