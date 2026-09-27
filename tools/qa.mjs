#!/usr/bin/env node
// Headless QA runner (WP14, §7.4 presets + §8.2 thresholds).
//
// Usage:
//   node tools/qa.mjs [--preset name[,name...]] [--out shots] [--url http://localhost:5173] [--wait ms]
//                     [--size 1600x900] [--baseline dir] [--only regex] [--list]
//   npm run qa [-- --preset spawn,leak,zones]
//
// Runs preset shots through the same browser code as tools/shoot.mjs (imported helpers). After each shot it
// evaluates __backrooms.imageStats() and stats(), applies the §8.2 thresholds (plus per-shot `expect`, `captures`
// + `diff`, `diffWith` and eval-returned {fail, warn} lists), writes <out>/qa-report.json and exits non-zero on
// any failure. `--baseline dir` compares a 64x36 downsample of every screenshot with the same file name in `dir`
// (reported only, never fails). `--only regex` keeps only the shots whose name matches (e.g. to split the 36-shot
// `zones` preset into shorter runs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  PRESETS_FILE, launchBrowser, loadPresets, parseArgs, runShot, startVite, stopVite, warmGpu,
} from './shoot.mjs';

// ---------------------------------------------------------------- thresholds (§8.2)
export const THRESHOLDS = {
  readyMs: 20000,
  drawCalls: 400,
  // R2-post: troffer panels / skylights now clip to pure white like a consumer camera (the grade no longer holds
  // highlights below white), so a ceiling-heavy lit view legitimately clips a few percent: lit limit 0.03 -> 0.08
  // (the post harness still checks < 3 % clipped OUTSIDE the emitters on its synthetic panels scene).
  lit: { meanLum: [0.12, 0.65], clippedMax: 0.08, blackMax: 0.25 },
  dark: { meanLum: [0.01, 0.25], clippedMax: 0.03 },
  darkFlash: { meanLumMin: 0.05, clippedMax: 0.03 },
  // p5Max (package C.7): the darkest 5 % of a lit Level 0 view must stay below this, so the old frame-wide warm veil
  // (halation + lifted blacks, LOBBY p5 0.32) cannot creep back
  level0: { zones: ['LOBBY', 'MANILA', 'MAZE', 'LOW_EXPANSE'], hueDeg: [38, 65], sat: [0.15, 0.6], p5Max: 0.26 },
};

// ---------------------------------------------------------------- PNG decode (8-bit RGB/RGBA/grey, non-interlaced)
export function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported PNG colour type ${ctype}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    if (ch >= 3) { rgba[i * 4] = px[s]; rgba[i * 4 + 1] = px[s + 1]; rgba[i * 4 + 2] = px[s + 2]; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s]; }
    rgba[i * 4 + 3] = ch === 4 ? px[s + 3] : ch === 2 ? px[s + 1] : 255;
  }
  return { w, h, rgba };
}

/** Box-filter downsample to W x H (RGB, float 0..1). */
export function downsample(img, W = 64, H = 36) {
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * img.h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * img.w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const k = (yy * img.w + xx) * 4;
        r += img.rgba[k]; g += img.rgba[k + 1]; b += img.rgba[k + 2]; n++;
      }
      const o = (y * W + x) * 3;
      out[o] = r / n / 255; out[o + 1] = g / n / 255; out[o + 2] = b / n / 255;
    }
  }
  return out;
}

/** Mean absolute RGB difference (0..1) of two decoded images of equal size (or of two downsamples). */
export function mad(a, b) {
  if (a.rgba && b.rgba) {
    if (a.w !== b.w || a.h !== b.h) return 1;
    let s = 0;
    const n = a.w * a.h;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      s += Math.abs(a.rgba[k] - b.rgba[k]) + Math.abs(a.rgba[k + 1] - b.rgba[k + 1]) + Math.abs(a.rgba[k + 2] - b.rgba[k + 2]);
    }
    return s / (n * 3 * 255);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// ---------------------------------------------------------------- checks

/** expect.class default: harness pages / debug views / test scenes -> none; forceMood=DARK -> dark(Flash); else lit
 * (checkShot turns an unforced 'lit' shot whose player stands in a naturally DARK district into 'mixed'). */
export function shotClass(shot) {
  if (shot.expect?.class) return shot.expect.class;
  if (shot.page) return 'none';
  const p = new URLSearchParams(shot.params ?? '');
  if ((p.get('view') ?? 'final') !== 'final' || p.get('testScene')) return 'none';
  if ((p.get('forceMood') ?? '').toUpperCase() === 'DARK') return p.get('flashlight') === '1' ? 'darkFlash' : 'dark';
  return 'lit';
}

function range(fails, label, v, [lo, hi]) {
  if (!(v >= lo && v <= hi)) fails.push(`${label} ${v?.toFixed?.(3) ?? v} outside [${lo}, ${hi}]`);
}

export function checkShot(shot, entry, qa) {
  const fails = [];
  const notes = [];
  const allow = (shot.allowWarnings ?? []).map((r) => new RegExp(r));
  if (entry.errors.length) fails.push(`${entry.errors.length} console/page error(s): ${entry.errors.slice(0, 3).join(' | ').slice(0, 400)}`);
  if (entry.readyMs === null) fails.push('never became ready');
  else if (entry.readyMs > (shot.expect?.readyMs ?? THRESHOLDS.readyMs)) fails.push(`readyMs ${entry.readyMs} > ${shot.expect?.readyMs ?? THRESHOLDS.readyMs}`);
  const st = entry.stats && typeof entry.stats === 'object' ? entry.stats : null;
  if (st && Array.isArray(st.warnings)) {
    const w = st.warnings.filter((x) => !allow.some((r) => r.test(x)));
    if (w.length) fails.push(`stats().warnings: ${w.slice(0, 4).join(' | ')}`);
  }
  if (st && Array.isArray(st.errors) && st.errors.length) fails.push(`stats().errors: ${st.errors.slice(0, 3).join(' | ')}`);
  if (st?.render && st.render.drawCalls > THRESHOLDS.drawCalls) fails.push(`drawCalls ${st.render.drawCalls} > ${THRESHOLDS.drawCalls}`);

  const img = qa.imageStats;
  let cls = shotClass(shot);
  // a shot that lands in a naturally DARK district (e.g. goto=landmark:X) may still look into a lit landmark or a
  // neighbouring lit district: judged 'mixed' (the union of the lit and dark luma bands, no black / Level 0 checks)
  if (cls === 'lit' && !shot.expect?.class && st?.player?.mood === 'DARK') {
    cls = new URLSearchParams(shot.params ?? '').get('flashlight') === '1' ? 'darkFlash' : 'mixed';
  }
  if (img && typeof img === 'object') {
    const T = THRESHOLDS;
    if (cls === 'lit') {
      range(fails, 'meanLum', img.meanLum, T.lit.meanLum);
      if (img.clipped >= T.lit.clippedMax) fails.push(`clipped ${img.clipped.toFixed(3)} >= ${T.lit.clippedMax}`);
      if (img.black >= T.lit.blackMax) fails.push(`black ${img.black.toFixed(3)} >= ${T.lit.blackMax}`);
      const zone = st?.player?.zone;
      const mood = st?.player?.mood;
      // §8.2: every Level 0 zone (a naturally DARK district is not a lit scene: its colour is not graded yellow)
      if (T.level0.zones.includes(zone) && mood !== 'DARK' && (shot.expect?.level0 ?? true)) {
        range(fails, `hueDeg (${zone})`, img.hueDeg, T.level0.hueDeg);
        range(fails, `sat (${zone})`, img.sat, T.level0.sat);
        if (!(img.p5 <= T.level0.p5Max)) fails.push(`p5 (${zone}) ${img.p5?.toFixed(3)} > ${T.level0.p5Max}`);
      }
    } else if (cls === 'dark') {
      range(fails, 'meanLum (dark)', img.meanLum, T.dark.meanLum);
      if (img.clipped >= T.dark.clippedMax) fails.push(`clipped ${img.clipped.toFixed(3)} >= ${T.dark.clippedMax}`);
    } else if (cls === 'mixed') {
      range(fails, 'meanLum (natural DARK district)', img.meanLum, [T.dark.meanLum[0], T.lit.meanLum[1]]);
      if (img.clipped >= T.lit.clippedMax) fails.push(`clipped ${img.clipped.toFixed(3)} >= ${T.lit.clippedMax}`);
    } else if (cls === 'darkFlash') {
      if (!(img.meanLum >= T.darkFlash.meanLumMin)) fails.push(`meanLum (dark + flashlight) ${img.meanLum?.toFixed(3)} < ${T.darkFlash.meanLumMin}`);
      if (img.clipped >= T.darkFlash.clippedMax) fails.push(`clipped ${img.clipped.toFixed(3)} >= ${T.darkFlash.clippedMax}`);
    }
  } else if (cls !== 'none' && !shot.page) {
    fails.push(`imageStats unavailable: ${String(img)}`);
  }
  for (const r of qa.rects ?? []) {
    const f = [];
    const s = r.stats;
    if (!s || typeof s !== 'object') f.push(`rect ${r.label}: imageStats(rect) failed: ${String(s)}`);
    else {
      if (r.maxMeanLum !== undefined && !(s.meanLum < r.maxMeanLum)) f.push(`rect ${r.label}: meanLum ${s.meanLum.toFixed(4)} >= ${r.maxMeanLum}`);
      if (r.minMeanLum !== undefined && !(s.meanLum >= r.minMeanLum)) f.push(`rect ${r.label}: meanLum ${s.meanLum.toFixed(4)} < ${r.minMeanLum}`);
      if (r.hue) range(f, `rect ${r.label}: hueDeg`, s.hueDeg, r.hue);
      if (r.minSat !== undefined && !(s.sat > r.minSat)) f.push(`rect ${r.label}: sat ${s.sat.toFixed(3)} <= ${r.minSat}`);
    }
    (r.warnOnly ? notes : fails).push(...f);
  }
  for (const d of qa.diffs ?? []) {
    const line = `diff ${d.label}: MAD ${(d.mad * 100).toFixed(3)}% (max ${(d.max * 100).toFixed(2)}%)`;
    if (d.mad > d.max) (d.warnOnly ? notes : fails).push(line);
  }
  const evalLists = [...entry.evalResults, ...(qa.steps ?? []).map((s) => s.result)];
  for (const r of evalLists) {
    if (typeof r === 'string' && r.startsWith('EVAL ERROR')) fails.push(r.slice(0, 400));
    if (r && typeof r === 'object') {
      if (Array.isArray(r.fail)) fails.push(...r.fail);
      if (Array.isArray(r.warn)) notes.push(...r.warn);
    }
  }
  return { ok: fails.length === 0, fails, notes, class: cls };
}

// ---------------------------------------------------------------- main

async function qaExtras(page, shot, entry, out, index) {
  const qa = { imageStats: null, rects: [], steps: [], diffs: [], captures: [] };
  const isGame = !shot.page;
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
  const shots = [];
  for (let k = 0; k < (shot.captures ?? []).length; k++) {
    const c = shot.captures[k];
    let result = null;
    if (c.eval) { try { result = await page.evaluate(c.eval); } catch (e) { result = 'EVAL ERROR: ' + e.message; } }
    if (c.wait) await page.waitForTimeout(c.wait);
    const file = path.join(out, `${String(index).padStart(2, '0')}-${(shot.name ?? 'shot').replace(/[^a-z0-9]+/gi, '_')}-c${k}-${(c.name ?? k).toString().replace(/[^a-z0-9]+/gi, '_')}.png`);
    const png = c.screenshot === false ? null : await page.screenshot({ path: file });
    qa.steps.push({ name: c.name ?? String(k), result, file: png ? file : null });
    shots.push(png ? decodePNG(png) : null);
  }
  for (const [a, b] of shot.diff?.pairs ?? []) {
    if (!shots[a] || !shots[b]) { qa.diffs.push({ label: `${a}-${b}`, mad: 1, max: shot.diff.maxMAD, warnOnly: shot.diff.warnOnly }); continue; }
    qa.diffs.push({ label: `${shot.captures[a].name}->${shot.captures[b].name}`, mad: mad(shots[a], shots[b]), max: shot.diff.maxMAD, warnOnly: !!shot.diff.warnOnly });
  }
  if (isGame) {
    entry.stats = await page.evaluate(() => { try { return window.__backrooms?.stats?.() ?? null; } catch (e) { return 'stats() threw: ' + e.message; } });
  }
  return qa;
}

export async function main(argv) {
  const opt = parseArgs(argv);
  const baseline = opt.extra.baseline ?? null;
  if (opt.help || argv.includes('--list')) {
    const all = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(all)) if (Array.isArray(v)) console.log(`${k.padEnd(10)} ${v.length} shot(s): ${v.map((s) => s.name).join(', ')}`);
    return 0;
  }
  const names = opt.presets.length ? opt.presets : ['all'];
  let shots = loadPresets(names);
  if (opt.extra.only) {
    const re = new RegExp(opt.extra.only);
    shots = shots.filter((s) => re.test(s.name ?? ''));
    if (!shots.length) { console.error(`qa: --only ${opt.extra.only} matches no shot`); return 2; }
  }
  mkdirSync(opt.out, { recursive: true });
  let vite = null;
  const root = opt.url ?? (vite = await startVite()).url;
  const browser = await launchBrowser();
  const results = [];
  const pngs = new Map();
  const t0 = Date.now();
  try {
    await warmGpu(browser);
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      let qa = null;
      const { entry, png } = await runShot(browser, root, shot, { index: i, out: opt.out, wait: opt.wait, size: opt.size, evals: opt.evals },
        async (page, e) => { qa = await qaExtras(page, shot, e, opt.out, i); });
      qa ??= { imageStats: null, rects: [], steps: [], diffs: [] };
      const decoded = png ? decodePNG(png) : null;
      if (decoded && shot.name) pngs.set(shot.name, decoded);
      if (shot.diffWith) {
        const other = pngs.get(shot.diffWith.shot);
        qa.diffs.push({ label: `vs ${shot.diffWith.shot}`, mad: other && decoded ? mad(other, decoded) : 1, max: shot.diffWith.maxMAD, warnOnly: !!shot.diffWith.warnOnly });
      }
      let baselineMAD = null;
      if (baseline && decoded && entry.file) {
        const bf = path.join(baseline, path.basename(entry.file));
        if (existsSync(bf)) {
          try { baselineMAD = mad(downsample(decodePNG(readFileSync(bf))), downsample(decoded)); } catch { baselineMAD = null; }
        }
      }
      const verdict = checkShot(shot, entry, qa);
      const r = {
        name: shot.name ?? entry.params, preset: shot.preset, ok: verdict.ok, class: verdict.class, fails: verdict.fails, notes: verdict.notes,
        file: entry.file, params: entry.params, page: shot.page ?? null, readyMs: entry.readyMs, imageStats: qa.imageStats,
        rects: qa.rects.map((x) => ({ label: x.label, stats: x.stats })), diffs: qa.diffs, steps: qa.steps, baselineMAD,
        evalResults: entry.evalResults, stats: entry.stats, errors: entry.errors, consoleWarnings: entry.warnings,
      };
      results.push(r);
      const tag = r.ok ? 'PASS' : 'FAIL';
      console.log(`${tag} ${String(i).padStart(3)} ${r.preset}/${r.name}  ready ${r.readyMs ?? '-'} ms` +
        `${qa.imageStats && typeof qa.imageStats === 'object' ? `  lum ${qa.imageStats.meanLum.toFixed(3)} hue ${qa.imageStats.hueDeg.toFixed(0)} sat ${qa.imageStats.sat.toFixed(2)}` : ''}` +
        `${baselineMAD !== null ? `  baseline ${(baselineMAD * 100).toFixed(2)}%` : ''}`);
      for (const f of r.fails) console.log(`       - ${f}`);
      for (const n of r.notes) console.log(`       ~ ${n}`);
    }
  } finally {
    await browser.close();
    stopVite(vite);
  }
  const failed = results.filter((r) => !r.ok);
  const report = {
    date: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), presets: names, baseline,
    thresholds: THRESHOLDS, total: results.length, passed: results.length - failed.length, failed: failed.length, results,
  };
  const file = path.join(opt.out, 'qa-report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed}/${report.total} passed, ${report.failed} failed -> ${file}`);
  return failed.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
