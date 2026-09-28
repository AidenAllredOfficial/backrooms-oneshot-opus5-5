// tools/lib/capture.mjs + png.mjs + qa.mjs helpers: launch params the tools add, boot-key grouping, execution order,
// PNG codec, decode planning. No browser.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// the tools are untyped .mjs: imported through a non-literal specifier (typed any)
const TOOLS = path.resolve(import.meta.dirname, '../../tools');
const load = (rel: string): Promise<any> => import(path.join(TOOLS, rel)); // eslint-disable-line @typescript-eslint/no-explicit-any
const { gameSearch, bootKey, planOrder, needsFreshPage, isGameShot, treeFeatures, shotFileName, BOOT_PARAM_KEYS, pageUrl, Lane } = await load('lib/capture.mjs');
const { decodePNG, encodePNG, pixelDiff, mad } = await load('lib/png.mjs');
const { decodePlan, checkShot } = await load('qa.mjs');

describe('gameSearch: the launch params a tool adds', () => {
  it('keeps the players\' boot (priming) for shots with evals', () => {
    expect(gameSearch({ params: 'seed=1', eval: ['1'] }, { warmed: true })).toBe('seed=1&autostart=1');
    expect(gameSearch({ params: 'seed=1' }, { warmed: true, evals: true })).toBe('seed=1&autostart=1');
  });

  it('adds noprime=1 only to game pages of a warmed browser, and autostart=1 last', () => {
    expect(gameSearch({ params: 'seed=1' }, { warmed: true })).toBe('seed=1&noprime=1&autostart=1');
    expect(gameSearch({ params: 'seed=1' }, { warmed: false })).toBe('seed=1&autostart=1');
    // harness pages and the title screen never skip priming
    expect(gameSearch({ params: 'view=albedo', page: 'harness/materials.html' }, { warmed: true })).toBe('view=albedo&autostart=1');
    expect(gameSearch({ params: 'seed=4&autostart=0' }, { warmed: true })).toBe('seed=4&autostart=0&autostart=1');
    expect(gameSearch({ params: '' }, { warmed: true })).toBe('noprime=1&autostart=1');
  });

  it('adds bake=preview for drafts and stream=capture when asked, never overriding the shot', () => {
    expect(gameSearch({ params: 'seed=1' }, { draft: true, streamCapture: true, warmed: true })).toBe('seed=1&bake=preview&stream=capture&noprime=1&autostart=1');
    expect(gameSearch({ params: 'seed=1&bake=full&noprime=1&stream=full' }, { draft: true, streamCapture: true, warmed: true })).toBe('seed=1&bake=full&noprime=1&stream=full&autostart=1');
    expect(gameSearch({ params: 'x=1', page: 'harness/chunk.html' }, { draft: true, streamCapture: true })).toBe('x=1&autostart=1');
  });

  it('builds page URLs under a sub-path root', () => {
    expect(pageUrl('http://h:1/b/abc/', { page: 'harness/post.html' }, 'a=1')).toBe('http://h:1/b/abc/harness/post.html?a=1');
    expect(pageUrl('http://h:1/b/abc/', {}, 'a=1')).toBe('http://h:1/b/abc/?a=1');
  });
});

describe('boot keys and execution order', () => {
  const s = (params: string, extra: Record<string, unknown> = {}) => ({ params, ...extra });

  it('keys shots by the boot params, page, size and HC only', () => {
    const k = (sh: { params: string; page?: string; size?: string }, size = '1600x900', hc = 8) => bootKey(sh, gameSearch(sh, { warmed: true }), { size, hc });
    expect(k(s('seed=7&zone=LOBBY&quality=high'))).toBe(k(s('seed=9&x=4&z=5&quality=high&time=10')));
    expect(k(s('seed=7&quality=high'))).not.toBe(k(s('seed=7&quality=ultra')));
    expect(k(s('seed=7'))).not.toBe(k(s('seed=7'), '1920x1080'));
    expect(k(s('seed=7'))).not.toBe(k(s('seed=7'), '1600x900', 6));
    expect(k(s('seed=7&noaudio=1'))).not.toBe(k(s('seed=7')));
    expect(k(s('seed=7&stream=capture'))).not.toBe(k(s('seed=7')));
  });

  it('marks shots that need their own boot', () => {
    expect(needsFreshPage(s('seed=1'))).toBe(false);
    expect(needsFreshPage(s('seed=1', { fresh: true }))).toBe(true);
    expect(needsFreshPage(s('seed=1', { preset: 'perf' }))).toBe(true);
    expect(needsFreshPage(s('seed=1', { preset: 'ui' }))).toBe(true);
    expect(needsFreshPage(s('seed=1&autostart=0'))).toBe(true);
    expect(needsFreshPage(s('a=1', { page: 'harness/post.html' }))).toBe(true);
    expect(isGameShot(s('seed=1'))).toBe(true);
  });

  it('groups by boot key in first-appearance order and sorts groups by seed, s, x, z', () => {
    const shots = [
      s('seed=7&quality=high&x=10&z=1'), // 0 high
      s('seed=7&quality=ultra'), // 1 ultra
      s('seed=7&quality=high&x=-5&z=0'), // 2 high
      s('seed=1&quality=high'), // 3 high (seed 1 sorts first)
      s('seed=7&quality=high', { fresh: true }), // 4 own group
      s('seed=7&quality=ultra&s=1'), // 5 ultra
    ];
    const order = planOrder(shots, (x: { params: string }) => gameSearch(x, { warmed: true }), { size: '1600x900', hc: 8 });
    expect(order).toEqual([3, 2, 0, 1, 5, 4]);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps file names by original index', () => {
    expect(shotFileName(3, { params: 'seed=7&zone=LOBBY' })).toBe('03-seed_7_zone_LOBBY.png');
    expect(shotFileName(12, { name: 'zone-LOBBY', params: 'x' })).toBe('12-zone_LOBBY.png');
  });
});

describe('treeFeatures', () => {
  it('reads LAUNCH_PARAM_KEYS / BOOT_PARAM_KEYS from a tree', () => {
    const t = mkdtempSync(path.join(os.tmpdir(), 'features-'));
    try {
      mkdirSync(path.join(t, 'src', 'app'), { recursive: true });
      writeFileSync(path.join(t, 'src', 'app', 'urlParams.ts'), "export const LAUNCH_PARAM_KEYS: readonly string[] = [\n  'seed', 'stream',\n];\nexport const BOOT_PARAM_KEYS = ['quality', 'noprime'] as const;\n");
      expect(treeFeatures(t)).toEqual({ bootKeys: ['quality', 'noprime'], streamCapture: true });
      writeFileSync(path.join(t, 'src', 'app', 'urlParams.ts'), "export const LAUNCH_PARAM_KEYS: readonly string[] = ['seed'];\n");
      expect(treeFeatures(t)).toEqual({ bootKeys: null, streamCapture: false });
      expect(treeFeatures(path.join(t, 'nope'))).toEqual({ bootKeys: null, streamCapture: false });
    } finally { rmSync(t, { recursive: true, force: true }); }
  });

  it('matches this repository', () => {
    const f = treeFeatures(path.resolve(import.meta.dirname, '../..'));
    if (f.bootKeys) for (const k of f.bootKeys) expect(BOOT_PARAM_KEYS).toContain(k);
    expect(typeof f.streamCapture).toBe('boolean');
  });
});

describe('png codec', () => {
  it('round-trips RGB and RGBA and measures differences', () => {
    const w = 7, h = 5;
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37) & 255);
    const a = decodePNG(encodePNG(w, h, rgb, { channels: 3 }));
    expect([a.w, a.h]).toEqual([w, h]);
    for (let p = 0; p < w * h; p++) expect([a.rgba[p * 4], a.rgba[p * 4 + 1], a.rgba[p * 4 + 2], a.rgba[p * 4 + 3]]).toEqual([rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255]);
    const rgba = new Uint8Array(a.rgba);
    rgba[4 * 3] = (rgba[4 * 3] + 20) & 255; // one pixel, 20 levels
    rgba[4 * 6 + 1] = (rgba[4 * 6 + 1] + 3) & 255; // one pixel, 3 levels
    const b = decodePNG(encodePNG(w, h, rgba, { channels: 4, level: 1 }));
    const d = pixelDiff(a, b);
    expect(d.px).toBe(2);
    expect(d.px8).toBe(1);
    expect(d.max).toBe(20);
    expect(d.madPct).toBeCloseTo(mad(a, b) * 100, 3);
    expect(pixelDiff(a, a)).toEqual({ px: 0, px8: 0, max: 0, madPct: 0 });
  });
});

describe('qa decode planning and memo hits', () => {
  it('decodes only diffWith targets and referrers (or everything with a baseline)', () => {
    const shots = [{ name: 'a' }, { name: 'spawn' }, { name: 'b' }, { name: 'spawn-determinism', diffWith: { shot: 'spawn' } }];
    const p = decodePlan(shots, null);
    expect(p.need).toEqual([false, true, false, true]);
    expect(p.lastRef.get('spawn')).toBe(3);
    expect(decodePlan(shots, '/tmp/base').need).toEqual([true, true, true, true]);
  });

  it('never applies the readiness-time check to a memo hit', () => {
    const entry = { readyMs: 30000, errors: [], evalResults: [], stats: null, file: 'x.png', params: 'seed=1' };
    const qa = { imageStats: null, rects: [], steps: [], diffs: [] };
    const shot = { params: 'seed=1', expect: { class: 'none' } };
    expect(checkShot(shot, entry, qa).fails).toEqual(['readyMs 30000 > 20000']);
    expect(checkShot(shot, { ...entry, memo: true }, qa).fails).toEqual([]);
  });
});

describe('Lane.abort (a daemon job timeout)', () => {
  /** A fake browser whose pages hang in every evaluate() until closed, then reject like Playwright does. */
  function hangingBrowser() {
    const pages: Array<{ closed: boolean }> = [];
    const browser = {
      async newPage() {
        const waiters: Array<(e: Error) => void> = [];
        const page = {
          closed: false,
          async addInitScript() {},
          on() {},
          async goto() {},
          async waitForTimeout() {},
          async waitForLoadState() {},
          evaluate() {
            return new Promise((_, rej) => { if (page.closed) rej(new Error('Target page, context or browser has been closed')); else waiters.push(rej); });
          },
          async close() { page.closed = true; for (const r of waiters.splice(0)) r(new Error('Target page, context or browser has been closed')); },
        };
        pages.push(page);
        return page;
      },
    };
    return { browser, pages };
  }

  it('closes the page of the run in progress, which then neither retries nor becomes the warm page', async () => {
    const { browser, pages } = hangingBrowser();
    const lane = new Lane({ browser, root: 'http://x/', warmed: true, features: { bootKeys: null, streamCapture: false } });
    const run = lane.run({ params: 'seed=1' }, { index: 0, noPng: true, wait: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(pages).toHaveLength(1);
    expect(pages[0].closed).toBe(false);
    expect(await lane.abort()).toBe(true);
    expect(pages[0].closed).toBe(true);
    const r = await run;
    expect(r.entry.errors.length).toBeGreaterThan(0);
    expect(r.entry.retried).toBeUndefined(); // an abandoned run is not retried on a new page
    expect(pages).toHaveLength(1);
    expect(lane.page).toBeNull();
    expect(lane.inflight.size).toBe(0);
  });
});
