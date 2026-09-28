// tools/lib/capture.mjs — the capture core shared by tools/shoot.mjs, tools/qa.mjs, tools/ab.mjs and the capture
// daemon (tools/rsd/server.mjs). One Lane = one page slot in one browser: it boots a page per shot, or (when the page
// implements capture contract v2: __backrooms.captureGate >= 2 and load()) moves an already booted page to the next
// shot in place. Per shot it
//   - adds noprime=1 to game pages in a browser whose first-context loss warmGpu already absorbed (gameSearch),
//   - waits for ready with one in-page promise (whenReady() when present, else a 16 ms poll),
//   - waits `wait` ms (default 250; 0 when the page reports captureGate >= 2) plus two animation frames,
//   - runs evals, reads stats(), and captures a PNG with CDP Page.captureScreenshot {optimizeForSpeed} (same pixels as
//     page.screenshot, 4x faster); harness pages and autostart=0 pages keep page.screenshot (caret, fonts).
// The caller owns the browser and the memory budget (tools/lib/budget.mjs).
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePNG, mad } from './png.mjs';

/** Bump when a change here alters captured pixels or report contents (part of the capture memo key). */
export const CAPTURE_VERSION = 1;
export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const PRESETS_FILE = path.join(REPO, 'tools', 'qa-presets.json');
export const READY_TIMEOUT_MS = 60000;
export const EVAL_TIMEOUT_MS = Number(process.env.BACKROOMS_EVAL_TIMEOUT_MS ?? 900000); // soak evals run minutes
/** navigator.hardwareConcurrency seen by pages: 8 keeps the game's bake-worker pool at 4 (the measured optimum). */
export const PAGE_HC = Math.max(2, Number(process.env.BACKROOMS_HC ?? 8));
/** Wait after ready when the page does not implement capture contract v2 (its ready frame is not final). */
export const LEGACY_WAIT_MS = 250;
/** A warm page is recycled after this many shots. */
export const MAX_PAGE_SHOTS = 40;

/**
 * Launch params that need a page boot (mirror of BOOT_PARAM_KEYS in src/app/urlParams.ts once it exports them;
 * tests/tools/bootkeys.test.ts keeps the two in sync). `stream` is added: the streamer scope is chosen at boot.
 */
export const BOOT_PARAM_KEYS = ['quality', 'scale', 'radius', 'bake', 'camcorder', 'hud', 'debug', 'noaudio', 'autostart', 'noprime'];
const EXTRA_BOOT_KEYS = ['stream'];

/** Presets whose shots always get a fresh page (they measure boot, wall-clock time or UI flows). */
export const FRESH_PRESETS = new Set(['soak', 'stress', 'perf', 'edge', 'ui']);
/** Presets that run for minutes: at most one daemon lane runs them. */
export const LONG_PRESETS = new Set(['soak', 'stress', 'perf', 'edge']);
/** Presets never served from the capture memo. */
export const NO_MEMO_PRESETS = new Set(['perf', 'soak', 'stress', 'edge', 'ui']);

export function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function parseSize(size) {
  const [w, h] = String(size || '1600x900').split('x').map(Number);
  return { width: Number.isFinite(w) && w > 0 ? w : 1600, height: Number.isFinite(h) && h > 0 ? h : 900 };
}

export function slugOf(params) {
  return String(params ?? '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'default';
}

/** File name of shot `index` (as tools/shoot.mjs always named them). */
export function shotFileName(index, shot) {
  return `${String(index).padStart(2, '0')}-${shot.name ? slugOf(shot.name) : slugOf(shot.params)}.png`;
}

export function captureFileName(index, shot, k, c) {
  return `${String(index).padStart(2, '0')}-${(shot.name ?? 'shot').replace(/[^a-z0-9]+/gi, '_')}-c${k}-${(c.name ?? k).toString().replace(/[^a-z0-9]+/gi, '_')}.png`;
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

/** SHA-1 of this module and png.mjs: part of the memo key, so a capture-code change never serves old results. */
export const CAPTURE_CODE_HASH = createHash('sha1')
  .update(String(CAPTURE_VERSION))
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL('./png.mjs', import.meta.url)))
  .digest('hex').slice(0, 16);

// ---------------------------------------------------------------- what the rendered tree supports

function stringArray(src, name) {
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]`).exec(src);
  return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : null;
}

/**
 * Launch-param features of a source tree, read from its src/app/urlParams.ts: the boot keys it exports (null before
 * capture contract v2) and whether it accepts `stream=capture` (an unknown key would add a stats() warning).
 */
export function treeFeatures(tree) {
  let src = '';
  try { src = readFileSync(path.join(tree, 'src', 'app', 'urlParams.ts'), 'utf8'); } catch { /* not a game tree */ }
  const launch = stringArray(src, 'LAUNCH_PARAM_KEYS') ?? [];
  const boot = stringArray(src, 'BOOT_PARAM_KEYS');
  return { bootKeys: boot, streamCapture: launch.includes('stream') };
}

// ---------------------------------------------------------------- browser

/** BACKROOMS_GPU=amd: expose only the Mesa RADV Vulkan driver, so ANGLE renders on the AMD iGPU (profiling for weak
 * GPUs on this hybrid laptop). Default: all drivers; ANGLE/Vulkan picks the discrete NVIDIA GPU. */
const GPU_ENV = process.env.BACKROOMS_GPU === 'amd' ? { VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/radeon_icd.json' } : {};

export function browserArgs() {
  return ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required',
    '--renderer-process-limit=2', '--js-flags=--max-old-space-size=2048',
    // BACKROOMS_UNCAPPED=1: no vsync / frame-rate cap, so the GPU stays loaded and clocked up (stable GPU timings)
    ...(process.env.BACKROOMS_UNCAPPED === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])];
}

/** Launches headless Chromium (GPU through ANGLE/Vulkan). The caller holds the browser lease. */
export function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    env: { ...process.env, ...GPU_ENV },
    args: browserArgs(),
  });
}

const warmed = new WeakSet();

/**
 * GPU warm-up: in a fresh headless Chromium (ANGLE/Vulkan) the first WebGL context is lost ~0.5 s after creation
 * while the GPU process re-initialises. Absorb that on a throwaway page. Only when the loss was seen are game pages
 * of this browser given noprime=1 (gameSearch); otherwise each page primes itself as the game does for players.
 * Returns { lost, ms, renderer }.
 */
export async function warmGpu(browser, fallbackMs = 800) {
  const t0 = Date.now();
  const w = await browser.newPage();
  let r = { lost: false, renderer: '' };
  try {
    r = await w.evaluate((ms) => new Promise((res) => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) { res({ lost: false, renderer: '' }); return; }
      let renderer = '';
      try { const e = gl.getExtension('WEBGL_debug_renderer_info'); renderer = String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { /* none */ }
      c.addEventListener('webglcontextlost', () => setTimeout(() => res({ lost: true, renderer }), 100));
      setTimeout(() => res({ lost: false, renderer }), ms);
    }), fallbackMs);
  } catch { /* page died: treat as not warmed */ }
  await w.close().catch(() => {});
  if (r.lost) warmed.add(browser);
  return { ...r, ms: Date.now() - t0 };
}

export const isWarmed = (browser) => warmed.has(browser);

// ---------------------------------------------------------------- URLs and boot keys

/** Game page = no harness `page` and not the title screen (autostart=0). */
export function isGameShot(shot) {
  if (shot.page) return false;
  return new URLSearchParams(String(shot.params ?? '')).get('autostart') !== '0';
}

/**
 * The launch params a tool adds to a shot, in one place so they can never be decoupled:
 *   bake=preview (draft) and stream=capture (streamCapture) for game shots that do not set them;
 *   noprime=1 for game shots in a browser whose first-context loss warmGpu absorbed (warmed);
 *   autostart=1, always last (as tools/shoot.mjs always did).
 */
export function gameSearch(shot, { warmed: w = false, draft = false, streamCapture = false } = {}) {
  const params = String(shot.params ?? '');
  const p = new URLSearchParams(params);
  const extra = [];
  if (isGameShot(shot)) {
    if (draft && !p.has('bake')) extra.push('bake=preview');
    if (streamCapture && !p.has('stream')) extra.push('stream=capture');
    if (w && !p.has('noprime')) extra.push('noprime=1');
  }
  return [params, ...extra, 'autostart=1'].filter(Boolean).join('&');
}

export function baseUrl(root, page) {
  return page ? new URL(String(page).replace(/^\/+/, ''), root.endsWith('/') ? root : root + '/').href : root;
}

export function pageUrl(root, shot, search) {
  const base = baseUrl(root, shot.page ?? '');
  return `${base}${base.includes('?') ? '&' : '?'}${search}`;
}

/** Shots with equal boot keys can share one page (load() in place); everything else needs a boot. */
export function bootKey(shot, search, { size, hc = PAGE_HC, bootKeys = null } = {}) {
  const p = new URLSearchParams(search);
  const keys = [...new Set([...(bootKeys ?? BOOT_PARAM_KEYS), ...EXTRA_BOOT_KEYS])].sort();
  const { width, height } = parseSize(shot.size ?? size);
  return JSON.stringify([shot.page ?? '', `${width}x${height}`, hc, ...keys.map((k) => [k, p.getAll(k).join(',')])]);
}

/** Whether a shot must boot its own page even when a warm page with the same boot key exists. */
export function needsFreshPage(shot) {
  return !isGameShot(shot) || !!shot.fresh || FRESH_PRESETS.has(shot.preset);
}

/**
 * Execution order for a list of shots: grouped by boot key (first appearance order), and within a group by
 * (seed, s, x, z) so in-place moves are short. Returns indices into `shots`; results keep the original indices.
 */
export function planOrder(shots, searchOf, keyOpts) {
  const groups = new Map();
  shots.forEach((s, i) => {
    const k = needsFreshPage(s) ? `fresh:${i}` : bootKey(s, searchOf(s), keyOpts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const num = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? Infinity : Number(v));
  const cmp = (a, b) => {
    const pa = new URLSearchParams(String(shots[a].params ?? '')), pb = new URLSearchParams(String(shots[b].params ?? ''));
    const sa = pa.get('seed') ?? '', sb = pb.get('seed') ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    // storey defaults to 0; shots without x/z (spawn, zone=, goto=) sort after explicit poses
    for (const k of ['s', 'x', 'z']) {
      const va = num(pa.get(k) ?? (k === 's' ? '0' : null)), vb = num(pb.get(k) ?? (k === 's' ? '0' : null));
      if (va !== vb) return va < vb ? -1 : 1;
    }
    return a - b;
  };
  const out = [];
  for (const idx of groups.values()) out.push(...idx.sort(cmp));
  return out;
}

// ---------------------------------------------------------------- page operations

/**
 * Waits for the page's ready gate with ONE in-page promise: __backrooms.whenReady() when the page has it, else a
 * 16 ms poll of ready / isReady(). Resolves { captureGate, load } (what the page supports) or throws on timeout.
 */
export async function waitReady(page, timeoutMs = READY_TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    const left = timeoutMs - (Date.now() - t0);
    try {
      return await withTimeout(page.evaluate(readyPromise, Math.max(1, left)), left + 5000, 'ready');
    } catch (e) {
      // a navigation (dev-server reload) destroyed the context: wait again in the new document
      if (!/context was destroyed|navigat/i.test(String(e?.message)) || Date.now() - t0 >= timeoutMs) throw e;
      await page.waitForLoadState('load').catch(() => {});
    }
  }
}

function readyPromise(ms) {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const done = () => {
      const b = window.__backrooms;
      res({ captureGate: Number(b?.captureGate ?? 0) || 0, load: typeof b?.load === 'function' });
    };
    const deadline = setTimeout(() => rej(new Error(`not ready after ${ms} ms`)), ms);
    const ok = () => { const b = window.__backrooms; return !!b && (b.ready === true || (typeof b.isReady === 'function' && b.isReady())); };
    const tick = () => {
      const b = window.__backrooms;
      if (b && typeof b.whenReady === 'function') {
        Promise.resolve(b.whenReady()).then(() => { clearTimeout(deadline); done(); }, (e) => { clearTimeout(deadline); rej(e); });
        return;
      }
      if (ok()) { clearTimeout(deadline); done(); return; }
      if (performance.now() - t0 < ms) setTimeout(tick, 16);
    };
    tick();
  });
}

const cdpSessions = new WeakMap();

/** PNG of the viewport via CDP with optimizeForSpeed (fast zlib; decodes to the same pixels as page.screenshot). */
export async function fastScreenshot(page) {
  let s = cdpSessions.get(page);
  if (!s) { s = await page.context().newCDPSession(page); cdpSessions.set(page, s); }
  const { data } = await s.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
  return Buffer.from(data, 'base64');
}

/** Screenshot of a shot's page: the fast path for game pages, page.screenshot for harness / title pages. */
export async function screenshotOf(page, shot, file) {
  if (isGameShot(shot)) {
    const png = await fastScreenshot(page);
    if (file) writeFileSync(file, png);
    return png;
  }
  return page.screenshot(file ? { path: file } : {});
}

const rafs = (page, n = 2) => withTimeout(page.evaluate((k) => new Promise((r) => {
  let i = 0;
  const f = () => (++i >= k ? r(null) : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n), 10000, 'rAF').catch(() => {});

async function statsAndMarks(page, withMarks) {
  return withTimeout(page.evaluate((m) => {
    let st = null;
    try { st = window.__backrooms?.stats?.() ?? null; } catch (e) { st = 'stats() threw: ' + e.message; }
    const marks = {};
    if (m) for (const e of performance.getEntriesByType('mark')) if (e.name.startsWith('br:')) marks[e.name.slice(3)] = Math.round(e.startTime);
    return { st, marks };
  }, withMarks), 30000, 'stats()');
}

/**
 * QA extras on an open page (tools/qa.mjs): imageStats (whole frame and expect.rects), the `captures` steps (eval,
 * wait, screenshot) and the MADs of `diff.pairs` between capture screenshots, then a final stats() for game pages.
 * Decodes only the capture screenshots a diff pair uses.
 */
export async function qaExtras(page, shot, entry, out, index, { evalTimeoutMs = EVAL_TIMEOUT_MS } = {}) {
  const qa = { imageStats: null, rects: [], steps: [], diffs: [] };
  qa.imageStats = await page.evaluate(async () => {
    const b = window.__backrooms;
    if (!b || typeof b.imageStats !== 'function') return null;
    try { return await b.imageStats(); } catch (e) { return 'imageStats threw: ' + e.message; }
  });
  for (const r of shot.expect?.rects ?? []) {
    const stats = await page.evaluate(async (rect) => {
      try { return await window.__backrooms.imageStats(rect); } catch (e) { return 'imageStats threw: ' + e.message; }
    }, r.rect);
    qa.rects.push({ ...r, stats });
  }
  const pairs = shot.diff?.pairs ?? [];
  const needed = new Set(pairs.flat());
  const decoded = [];
  let tainted = false;
  for (let k = 0; k < (shot.captures ?? []).length; k++) {
    const c = shot.captures[k];
    let result = null;
    if (c.eval) {
      try { result = await withTimeout(page.evaluate(c.eval), evalTimeoutMs, 'capture eval'); } catch (e) { result = 'EVAL ERROR: ' + e.message; tainted = true; }
    }
    if (c.wait) await page.waitForTimeout(c.wait);
    const file = path.join(out, captureFileName(index, shot, k, c));
    const png = c.screenshot === false ? null : await screenshotOf(page, shot, file);
    qa.steps.push({ name: c.name ?? String(k), result, file: png ? file : null });
    decoded.push(png && needed.has(k) ? decodePNG(png) : null);
  }
  for (const [a, b] of pairs) {
    if (!decoded[a] || !decoded[b]) { qa.diffs.push({ label: `${a}-${b}`, mad: 1, max: shot.diff.maxMAD, warnOnly: shot.diff.warnOnly }); continue; }
    qa.diffs.push({ label: `${shot.captures[a].name}->${shot.captures[b].name}`, mad: mad(decoded[a], decoded[b]), max: shot.diff.maxMAD, warnOnly: !!shot.diff.warnOnly });
  }
  if (!shot.page) {
    entry.stats = await page.evaluate(() => { try { return window.__backrooms?.stats?.() ?? null; } catch (e) { return 'stats() threw: ' + e.message; } });
  }
  return { qa, tainted };
}

// ---------------------------------------------------------------- lane

const RETRYABLE = /Target (page, context or browser has been )?closed|Target crashed|Page crashed|WebGL context lost|browser has disconnected/i;

/**
 * One page slot in one browser. run() captures a shot, in place on the lane's warm page when the page supports it
 * and the boot keys match, else on a fresh page. A crashed page or a lost GPU context is retried once on a fresh page.
 */
export class Lane {
  /**
   * @param {object} o
   *   browser, root (server URL of the tree), hc, warmed (noprime allowed), features ({ bootKeys, streamCapture }),
   *   log(msg), maxPageShots, keepPages (keep a warm page between shots; default true)
   */
  constructor(o) {
    this.browser = o.browser;
    this.root = o.root;
    this.hc = o.hc ?? PAGE_HC;
    this.warmed = o.warmed ?? isWarmed(o.browser);
    this.features = o.features ?? { bootKeys: null, streamCapture: false };
    this.log = o.log ?? (() => {});
    this.maxPageShots = o.maxPageShots ?? MAX_PAGE_SHOTS;
    this.keepPages = o.keepPages ?? true;
    this.page = null; // warm page kept for in-place shots
    this.pageKey = null;
    this.pageShots = 0;
    this.pageRoot = null;
    this.lastUsed = Date.now();
    this.recycleWanted = false;
    this.sink = null;
  }

  searchOf(shot, o = {}) {
    const hasEval = (o.evals?.length ?? 0) > 0 || (shot.eval?.length ?? 0) > 0;
    const features = o.features ?? this.features;
    return gameSearch(shot, { warmed: this.warmed, draft: !!o.draft, streamCapture: !!o.streamCapture && features.streamCapture && !hasEval });
  }

  keyOf(shot, search, o = {}) {
    return bootKey(shot, search, { size: o.size, hc: o.hc ?? this.hc, bootKeys: (o.features ?? this.features).bootKeys });
  }

  /** The browser was replaced (recycled): forget the warm page, which died with the old browser. */
  setBrowser(browser) {
    this.browser = browser;
    this.warmed = isWarmed(browser);
    this.page = null;
    this.pageKey = null;
    this.pageShots = 0;
  }

  /** Boot key of the lane's warm page (null without one). */
  get warmKey() { return this.page ? `${this.pageRoot}\n${this.pageKey}` : null; }

  async closePage() {
    const p = this.page;
    this.page = null;
    this.pageKey = null;
    this.pageShots = 0;
    if (p) await withTimeout(p.close(), 15000, 'page.close').catch(() => {});
  }

  async #newPage(width, height, hc) {
    const page = await this.browser.newPage({ viewport: { width, height } });
    await page.addInitScript((n) => { try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }); } catch { /* ignore */ } }, hc);
    page.__navs = 0;
    page.on('console', (m) => {
      const s = this.sink;
      if (!s || s.page !== page) return;
      if (m.type() === 'error') s.errors.push(m.text());
      else if (m.type() === 'warning') s.warnings.push(m.text());
    });
    page.on('pageerror', (e) => { const s = this.sink; if (s && s.page === page) s.errors.push('PAGEERROR: ' + (e.stack ?? e.message)); });
    page.on('crash', () => { const s = this.sink; if (s && s.page === page) { s.crashed = true; s.errors.push('SHOT ERROR: Page crashed'); } });
    // document loads only: load() moves the page with history.replaceState, a same-document navigation that
    // Playwright also reports as 'framenavigated'
    page.on('load', () => { page.__navs++; });
    return page;
  }

  /**
   * Captures one shot. o: { index, out, wait (explicit ms or null), size, evals, qa (run qaExtras), streamCapture,
   * draft, fresh (force a fresh page), evalTimeoutMs, file (override the PNG path), noPng (no file written),
   * root / features / hc (override the lane's) }.
   * Returns { entry, png, qa, inPlace }.
   */
  async run(shot, o = {}) {
    let r = await this.#runOnce(shot, o);
    if (r.retry) {
      this.log(`retrying shot ${o.index} on a fresh page: ${r.entry.errors.slice(-1)[0] ?? ''}`.slice(0, 300));
      await this.closePage();
      r = await this.#runOnce(shot, { ...o, fresh: true });
      r.entry.retried = true;
    }
    return r;
  }

  async #runOnce(shot, o) {
    const T0 = performance.now();
    let lap = T0;
    const t = {};
    const mark = (k) => { const n = performance.now(); t[k] = Math.round(n - lap); lap = n; };
    const { width, height } = parseSize(shot.size ?? o.size);
    const root = o.root ?? this.root;
    const hc = o.hc ?? this.hc;
    const search = this.searchOf(shot, o);
    const key = this.keyOf(shot, search, o);
    const params = shot.params ?? '';
    const entry = { file: '', params, readyMs: null, stats: null, evalResults: [], errors: [], warnings: [] };
    if (shot.name) entry.name = shot.name;
    if (shot.preset) entry.preset = shot.preset;
    if (shot.page) entry.page = shot.page;
    if (o.draft && isGameShot(shot)) entry.draft = true;
    const warnings = [];
    let page = null;
    let inPlace = false;
    let png = null;
    let qaOut = null;
    let tainted = false;
    let keep = false;
    const sink = { page: null, errors: entry.errors, warnings, crashed: false };
    this.sink = sink;
    this.lastUsed = Date.now();
    try {
      // ---- in place: same boot key, the page implements load(), and the shot does not need a boot
      const canInPlace = this.page && this.pageKey === key && this.pageRoot === root && !o.fresh && !needsFreshPage(shot) && this.pageShots < this.maxPageShots && !this.recycleWanted;
      if (this.page && !canInPlace) await this.closePage();
      let info = null;
      if (canInPlace) {
        page = this.page;
        sink.page = page;
        const navs0 = page.__navs;
        const r = await withTimeout(page.evaluate((s) => window.__backrooms.load(s), '?' + search), READY_TIMEOUT_MS, 'load()').catch((e) => ({ ok: false, reason: e.message }));
        mark('load');
        if (r && r.ok && page.__navs === navs0) {
          inPlace = true;
          info = { captureGate: Number(await page.evaluate(() => window.__backrooms.captureGate ?? 0).catch(() => 0)), load: true };
          entry.readyMs = Math.round(performance.now() - T0);
        } else {
          const why = r?.ok ? 'the page reloaded' : `${r?.reason ?? 'no result'}${r?.keys?.length ? ': ' + r.keys.join(',') : ''}`;
          this.log(`load() did not take shot ${o.index} in place (${why}); booting a fresh page`);
          await this.closePage();
          page = null;
        }
      }
      if (!page) {
        page = await this.#newPage(width, height, hc);
        sink.page = page;
        mark('page');
        await page.goto(pageUrl(root, shot, search), { waitUntil: 'load' });
        mark('load');
        try {
          info = await waitReady(page);
          entry.readyMs = Math.round(performance.now() - T0);
        } catch { entry.errors.push('TIMEOUT waiting for window.__backrooms.ready'); tainted = true; }
      }
      mark('ready');
      entry.captureGate = info?.captureGate ?? 0;
      const waitMs = shot.wait ?? o.wait ?? (entry.captureGate >= 2 ? 0 : LEGACY_WAIT_MS);
      let navsAtReady = page.__navs;
      if (waitMs > 0) await page.waitForTimeout(waitMs);
      // the page navigated after ready (e.g. a dev-server reload): wait for the new page's ready gate once more, so the
      // capture never shows the loading screen
      if (entry.readyMs !== null && page.__navs !== navsAtReady) {
        warnings.push('shoot: the page navigated after ready; waiting for ready again');
        try { await waitReady(page); if (waitMs > 0) await page.waitForTimeout(waitMs); } catch { entry.errors.push('TIMEOUT waiting for ready after a reload'); tainted = true; }
        navsAtReady = page.__navs;
      }
      mark('wait');
      for (const e of [...(o.evals ?? []), ...(shot.eval ?? [])]) {
        try { entry.evalResults.push(await withTimeout(page.evaluate(e), o.evalTimeoutMs ?? EVAL_TIMEOUT_MS, 'eval')); } catch (err) { entry.evalResults.push('EVAL ERROR: ' + err.message); tainted = true; }
      }
      mark('evals');
      const sm = await statsAndMarks(page, !inPlace);
      entry.stats = sm.st;
      if (!inPlace && Object.keys(sm.marks).length) t.marks = sm.marks;
      mark('stats');
      // two frames so the screenshot never races the first frames after a late evaluate
      await rafs(page, 2);
      mark('raf');
      if (!o.noPng) entry.file = o.file ?? path.join(o.out ?? '.', shotFileName(o.index ?? 0, shot));
      png = await screenshotOf(page, shot, o.noPng ? null : entry.file);
      mark('shot');
      if (o.qa) {
        const r = await qaExtras(page, shot, entry, o.out ?? '.', o.index ?? 0, { evalTimeoutMs: o.evalTimeoutMs });
        qaOut = r.qa;
        tainted ||= r.tainted;
        mark('qa');
      }
      keep = this.keepPages && isGameShot(shot) && !needsFreshPage(shot) && !tainted && !sink.crashed && entry.errors.length === 0 &&
        entry.captureGate >= 2 && info?.load === true && !this.recycleWanted;
    } catch (err) {
      entry.errors.push('SHOT ERROR: ' + (err?.message ?? String(err)));
    } finally {
      this.sink = null;
      entry.warnings = warnings.slice(0, 20);
      if (page) {
        if (keep) {
          if (page !== this.page) { this.page = page; this.pageKey = key; this.pageShots = 0; this.pageRoot = root; }
          this.pageShots++;
        } else if (page === this.page) {
          await this.closePage();
        } else {
          await withTimeout(page.close(), 15000, 'page.close').catch(() => {});
        }
      }
      mark('close');
      this.lastUsed = Date.now();
    }
    t.total = Math.round(performance.now() - T0);
    entry.t = t;
    if (inPlace) entry.inPlace = true;
    const retry = !o.fresh && (sink.crashed || entry.errors.some((e) => RETRYABLE.test(e)));
    return { entry, png, qa: qaOut, inPlace, retry };
  }
}

/** Reads a JSON file or returns null. */
export function readJson(f) {
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; }
}
