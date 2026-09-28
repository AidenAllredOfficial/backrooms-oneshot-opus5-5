#!/usr/bin/env node
// Headless QA runner (WP14, §7.4 presets + §8.2 thresholds).
//
// Usage:
//   node tools/qa.mjs [--preset name[,name...]] [--out shots] [--wait ms] [--size 1600x900] [--baseline dir]
//                     [--only regex] [--list] [--memo] [--draft] [--direct] [--url http://localhost:5173]
//   npm run qa [-- --preset spawn,leak,zones]
//
// Runs preset shots through the same capture code as tools/shoot.mjs (tools/lib/capture.mjs; by default in the
// capture daemon, tools/rsd). After each shot it evaluates __backrooms.imageStats() and stats(), applies the §8.2
// thresholds (plus per-shot `expect`, `captures` + `diff`, `diffWith` and eval-returned {fail, warn} lists), writes
// <out>/qa-report.json and exits non-zero on any failure. `--baseline dir` compares every screenshot with the same
// file name in `dir`: full-resolution changed pixels, pixels > 8 levels off, the largest difference, and the 64x36
// MAD (reported only, never fails). `--only regex` keeps only the shots whose name matches (e.g. to split the
// 36-shot `zones` preset into shorter runs). `--memo` serves unchanged shots from the capture memo (off by default:
// QA re-renders; readiness-time checks never apply to memo hits). `--draft` renders with preview lighting (fast,
// approximate; refuses --baseline). `--direct` / `--url` capture in this process instead of the daemon.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePNG, downsample, mad, pixelDiff } from './lib/png.mjs';
import { PRESETS_FILE, loadPresets, parseArgs, runDirect, progressLine, REPO } from './shoot.mjs';

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
  // (halation + lifted blacks: LOBBY p5 0.32, MANILA 0.38) cannot creep back. One limit for every Level 0 zone since
  // the C.7b retune (toe, contrast 1.3-1.46, thinner froxel haze): the zone= spawns measure 0.24-0.27 at high; the
  // highest are the evenly lit open views (forceZone MANILA / LOW_EXPANSE spawns, ~0.28), whose darkest pixels are
  // lamp-lit carpet and pale walls rather than deep reveals.
  level0: {
    zones: ['LOBBY', 'MANILA', 'MAZE', 'LOW_EXPANSE'], hueDeg: [38, 65], sat: [0.15, 0.6], p5Max: 0.3,
  },
};

// PNG codec and image metrics live in tools/lib/png.mjs (re-exported for older scripts)
export { decodePNG, downsample, mad } from './lib/png.mjs';

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
  // timing checks apply to fresh renders only, never to capture-memo hits
  else if (!entry.memo && entry.readyMs > (shot.expect?.readyMs ?? THRESHOLDS.readyMs)) fails.push(`readyMs ${entry.readyMs} > ${shot.expect?.readyMs ?? THRESHOLDS.readyMs}`);
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

/** For each shot index, whether its PNG must be decoded (diffWith target or --baseline), and after which shot index
 * a decoded image can be dropped. */
export function decodePlan(shots, baseline) {
  const lastRef = new Map(); // shot name -> last index whose diffWith references it
  shots.forEach((s, i) => { if (s.diffWith?.shot) lastRef.set(s.diffWith.shot, i); });
  const need = shots.map((s) => !!baseline || (!!s.name && lastRef.has(s.name)) || !!s.diffWith);
  return { need, lastRef };
}

export async function main(argv) {
  const opt = parseArgs(argv);
  const baseline = opt.extra.baseline ?? null;
  if (opt.help || opt.flags.has('list')) {
    const all = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(all)) if (Array.isArray(v)) console.log(`${k.padEnd(10)} ${v.length} shot(s): ${v.map((s) => s.name).join(', ')}`);
    return 0;
  }
  const draft = opt.flags.has('draft');
  if (draft && baseline) { console.error('qa: --draft renders approximate lighting; it cannot be compared with --baseline'); return 2; }
  const names = opt.presets.length ? opt.presets : ['all'];
  let shots = loadPresets(names);
  if (opt.extra.only) {
    const re = new RegExp(opt.extra.only);
    shots = shots.filter((s) => re.test(s.name ?? ''));
    if (!shots.length) { console.error(`qa: --only ${opt.extra.only} matches no shot`); return 2; }
  }
  mkdirSync(opt.out, { recursive: true });
  const results = [];
  const decoded = new Map(); // shot name -> decoded image, while a later diffWith needs it
  const plan = decodePlan(shots, baseline);
  const t0 = Date.now();
  const arrived = new Map();
  let next = 0;
  let done = 0;

  // results arrive in execution order (grouped by boot key, possibly two lanes); they are checked in list order
  const check = (i, { entry, qa }) => {
    const shot = shots[i];
    qa ??= { imageStats: null, rects: [], steps: [], diffs: [] };
    let img = null;
    if (plan.need[i] && entry.file && existsSync(entry.file)) { try { img = decodePNG(readFileSync(entry.file)); } catch { img = null; } }
    if (img && shot.name && plan.lastRef.get(shot.name) > i) decoded.set(shot.name, img);
    if (shot.diffWith) {
      const other = decoded.get(shot.diffWith.shot);
      qa.diffs.push({ label: `vs ${shot.diffWith.shot}`, mad: other && img ? mad(other, img) : 1, max: shot.diffWith.maxMAD, warnOnly: !!shot.diffWith.warnOnly });
    }
    let baselineMAD = null;
    let baselineDiff = null;
    if (baseline && img && entry.file) {
      const bf = path.join(baseline, path.basename(entry.file));
      if (existsSync(bf)) {
        try {
          const b = decodePNG(readFileSync(bf));
          baselineMAD = mad(downsample(b), downsample(img));
          baselineDiff = pixelDiff(b, img);
        } catch { baselineMAD = null; }
      }
    }
    for (const [name, last] of plan.lastRef) if (last <= i) decoded.delete(name);
    const verdict = checkShot(shot, entry, qa);
    const r = {
      name: shot.name ?? entry.params, preset: shot.preset, ok: verdict.ok, class: verdict.class, fails: verdict.fails, notes: verdict.notes,
      file: entry.file, params: entry.params, page: shot.page ?? null, readyMs: entry.readyMs, imageStats: qa.imageStats,
      rects: qa.rects.map((x) => ({ label: x.label, stats: x.stats })), diffs: qa.diffs, steps: qa.steps, baselineMAD, baselineDiff,
      evalResults: entry.evalResults, stats: entry.stats, errors: entry.errors, consoleWarnings: entry.warnings,
      ...(entry.memo ? { memo: true } : {}), ...(entry.inPlace ? { inPlace: true } : {}), ...(entry.draft ? { draft: true } : {}), t: entry.t,
    };
    results.push(r);
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`${tag} ${String(i).padStart(3)} ${r.preset}/${r.name}  ready ${r.readyMs ?? '-'} ms${entry.memo ? ' (memo)' : ''}` +
      `${qa.imageStats && typeof qa.imageStats === 'object' ? `  lum ${qa.imageStats.meanLum.toFixed(3)} hue ${qa.imageStats.hueDeg.toFixed(0)} sat ${qa.imageStats.sat.toFixed(2)}` : ''}` +
      `${baselineDiff ? `  baseline ${(baselineMAD * 100).toFixed(2)}% (${baselineDiff.px} px, ${baselineDiff.px8} > 8, max ${baselineDiff.max})` : baselineMAD !== null ? `  baseline ${(baselineMAD * 100).toFixed(2)}%` : ''}`);
    for (const f of r.fails) console.log(`       - ${f}`);
    for (const n of r.notes) console.log(`       ~ ${n}`);
  };
  const onResult = (i, r) => {
    arrived.set(i, r);
    if (opt.flags.has('progress')) console.error(progressLine('qa', ++done, shots.length, r.entry));
    while (arrived.has(next)) { const x = arrived.get(next); arrived.delete(next); check(next, x); next++; }
  };

  const common = { out: opt.out, wait: Number.isFinite(opt.wait) ? opt.wait : null, size: opt.size, evals: opt.evals, draft, streamCapture: false, qa: true };
  const direct = opt.flags.has('direct') || !!opt.url || process.env.BACKROOMS_RSD === '0';
  if (direct) {
    await runDirect(shots, { ...common, url: opt.url, tool: 'qa', onResult });
  } else {
    const { render } = await import('./rsd/client.mjs');
    const res = await render({
      tool: 'qa', tree: REPO, shots, ...common, out: path.resolve(opt.out), memo: opt.flags.has('memo'), fresh: false,
      onResult: (i, r) => {
        r.entry.file &&= path.join(opt.out, path.basename(r.entry.file));
        for (const s of r.qa?.steps ?? []) s.file &&= path.join(opt.out, path.basename(s.file));
        onResult(i, r);
      },
    });
    if (res.build) console.error(`[qa] build ${res.build.distHash.slice(0, 12)} (${res.build.cached ? 'cached' : `built in ${(res.build.ms / 1000).toFixed(2)} s`})`);
  }
  // shots that never reported (daemon connection lost) are failures, not silently missing
  for (let i = next; i < shots.length; i++) {
    check(i, arrived.get(i) ?? { entry: { file: '', params: shots[i].params, readyMs: null, stats: null, evalResults: [], errors: ['no result from the capture service'], warnings: [] }, qa: null });
  }
  const failed = results.filter((r) => !r.ok);
  const report = {
    date: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), presets: names, baseline, draft,
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
