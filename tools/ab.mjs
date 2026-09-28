#!/usr/bin/env node
// A/B captures: the same framings rendered from two source trees, pixel diffs, and contact sheets.
//
// Usage:
//   node tools/ab.mjs --base <git rev | tree path | baseline name> [--test <tree, default: this tree>]
//                     (--shots <preset[,preset...] | file.json> | --params "..."...) [--size 1600x900] [--out dir]
//                     [--scale 5] [--crop x,y,w,h] [--noise N] [--expect same] [--fresh] [--draft]
//   node tools/ab.mjs baseline set <name> [--tree <path>]     pin a tree's build as a named base
//   node tools/ab.mjs baseline list
//   node tools/ab.mjs baseline rm <name>
//
// Both trees go to the capture daemon as ONE job: it builds each tree (content-addressed, so an unchanged base costs
// nothing and its shots usually come from the capture memo) and renders base and test of each framing on paired
// lanes. For every pair it reports changed pixels, pixels more than 8 levels off, the largest difference and the
// MAD, and a verdict: same (0 px), noise (within the base's own repeat noise with --noise N, else <= 0.01 % of the
// pixels and <= 2 levels), or changed. Contact sheets (<out>/contact-N.png, <= 2000 px tall) show rows of
// base | test | diff x4 at 1/scale, red where a pixel is more than 8 levels off; --crop writes full-resolution crops.
// A git revision is materialised with `git archive` under /var/tmp/backrooms-render/trees (no worktree).
// --expect same exits 1 when any pair changed.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPresets, parseSize, REPO } from './lib/capture.mjs';
import { decodePNG, encodePNG, pixelDiff } from './lib/png.mjs';
import { BASELINES_DIR, ensureBuild, materializeRev } from './rsd/build.mjs';

function parse(argv) {
  const o = { params: [], size: '1600x900', scale: 5, noise: 0, test: REPO, out: null, flags: new Set(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--base') { o.base = v; i++; }
    else if (a === '--test') { o.test = path.resolve(v); i++; }
    else if (a === '--tree') { o.tree = path.resolve(v); i++; }
    else if (a === '--shots') { o.shots = v; i++; }
    else if (a === '--params') { o.params.push(v); i++; }
    else if (a === '--size') { o.size = v; i++; }
    else if (a === '--out') { o.out = v; i++; }
    else if (a === '--scale') { o.scale = Math.max(1, Number(v) || 5); i++; }
    else if (a === '--crop') { o.crop = String(v).split(',').map(Number); i++; }
    else if (a === '--noise') { o.noise = Math.max(0, Number(v) || 0); i++; }
    else if (a === '--expect') { o.expect = v; i++; }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) o.flags.add(a.slice(2));
    else o.rest.push(a);
  }
  return o;
}

// ---------------------------------------------------------------- named baselines

function baselineFile(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad baseline name '${name}' (letters, digits, . _ -)`);
  return path.join(BASELINES_DIR, `${name}.json`);
}

export function readBaseline(name) {
  try { return JSON.parse(readFileSync(baselineFile(name), 'utf8')); } catch { return null; }
}

async function baselineCmd(o) {
  const [, sub, name] = o.rest;
  mkdirSync(BASELINES_DIR, { recursive: true });
  if (sub === 'list') {
    for (const n of readdirSync(BASELINES_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const b = JSON.parse(readFileSync(path.join(BASELINES_DIR, n), 'utf8'));
      console.log(`${b.name.padEnd(20)} dist ${b.distHash.slice(0, 12)}  tree ${b.treeHash.slice(0, 12)}  ${b.created}  from ${b.from}`);
    }
    return 0;
  }
  if (!name) { console.error('usage: ab.mjs baseline set|rm <name> [--tree path]'); return 2; }
  if (sub === 'rm') { rmSync(baselineFile(name), { force: true }); console.log(`removed baseline ${name}`); return 0; }
  if (sub === 'set') {
    const tree = o.tree ?? o.test;
    const b = await ensureBuild(tree, { log: (m) => console.error(`[ab] ${m}`) });
    const rec = { name, treeHash: b.treeHash, distHash: b.distHash, tree: b.stagedTree, from: tree, created: new Date().toISOString() };
    writeFileSync(baselineFile(name), JSON.stringify(rec, null, 1));
    console.log(`baseline ${name} = build ${b.distHash.slice(0, 12)} of ${tree} (pinned: its build and memoized shots are never evicted)`);
    return 0;
  }
  console.error(`unknown baseline command '${sub}'`);
  return 2;
}

/** --base: a named baseline, a tree path, or a git revision of the test tree's repository. */
export function resolveBase(base, testTree) {
  const b = readBaselineSafe(base);
  if (b) return { tree: b.tree, label: `baseline ${base}` };
  const p = path.resolve(base);
  if (existsSync(path.join(p, 'src'))) return { tree: p, label: path.basename(p) };
  const { dir, sha } = materializeRev(testTree, base);
  return { tree: dir, label: `${base} (${sha.slice(0, 10)})` };
}

function readBaselineSafe(name) { try { return readBaseline(name); } catch { return null; } }

function shotsOf(o) {
  const shots = o.params.map((p) => ({ params: p }));
  if (o.shots) {
    if (o.shots.endsWith('.json') || existsSync(o.shots)) {
      const list = JSON.parse(readFileSync(o.shots, 'utf8'));
      shots.push(...list.map((s) => (typeof s === 'string' ? { params: s } : s)));
    } else shots.push(...loadPresets(o.shots.split(',').map((s) => s.trim()).filter(Boolean)));
  }
  return shots;
}

// ---------------------------------------------------------------- 5x7 label font

const FONT = {
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], '=': [0, 0, 31, 0, 31, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31], '/': [0, 1, 2, 4, 8, 16, 0], '%': [24, 25, 2, 4, 8, 19, 3], '>': [8, 4, 2, 1, 2, 4, 8],
  '<': [2, 4, 8, 16, 8, 4, 2], '+': [0, 4, 4, 31, 4, 4, 0], '&': [12, 18, 20, 8, 21, 18, 13], '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8], '[': [14, 8, 8, 8, 8, 8, 14], ']': [14, 2, 2, 2, 2, 2, 14], '|': [4, 4, 4, 4, 4, 4, 4],
  '#': [10, 10, 31, 10, 31, 10, 10], '?': [14, 17, 1, 2, 4, 0, 4], '*': [0, 4, 21, 14, 21, 4, 0],
};

/** Draws `text` into an RGB buffer (stride w*3) at (x, y), 6 px per character, clipped at maxX. */
function drawText(buf, w, x, y, text, rgb = [230, 230, 230], maxX = w) {
  for (const ch of String(text).toUpperCase()) {
    const g = FONT[ch] ?? FONT['?'];
    if (x + 5 > maxX) break;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (!(g[r] & (16 >> c))) continue;
      const o = ((y + r) * w + x + c) * 3;
      buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2];
    }
    x += 6;
  }
}

// ---------------------------------------------------------------- compare + sheets

const LABEL_H = 11;
const GUTTER = 2;
const SHEET_MAX_H = 2000;

/** Downscaled base | test | diff x4 row (RGB, width 3 * cw + 2 gutters). */
function rowPixels(a, b, dmax, S) {
  const cw = Math.floor(a.w / S), ch = Math.floor(a.h / S);
  const W = cw * 3 + GUTTER * 2;
  const px = new Uint8Array(W * ch * 3).fill(40);
  const q = S * S;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let ra = 0, ga = 0, ba = 0, rb = 0, gb = 0, bb = 0, dm = 0;
    for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
      const p = (y * S + yy) * a.w + x * S + xx, k = p * 4;
      ra += a.rgba[k]; ga += a.rgba[k + 1]; ba += a.rgba[k + 2];
      rb += b.rgba[k]; gb += b.rgba[k + 1]; bb += b.rgba[k + 2];
      if (dmax[p] > dm) dm = dmax[p];
    }
    const o0 = (y * W + x) * 3, o1 = (y * W + cw + GUTTER + x) * 3, o2 = (y * W + 2 * (cw + GUTTER) + x) * 3;
    px[o0] = ra / q; px[o0 + 1] = ga / q; px[o0 + 2] = ba / q;
    px[o1] = rb / q; px[o1 + 1] = gb / q; px[o1 + 2] = bb / q;
    const v = Math.min(255, dm * 4); // max-pooled difference x4, grey; > 8 levels in red
    if (dm > 8) { px[o2] = 255; px[o2 + 1] = v >> 2; px[o2 + 2] = v >> 2; } else { px[o2] = v; px[o2 + 1] = v; px[o2 + 2] = v; }
  }
  return { px, W, ch };
}

function writeSheets(out, rows, header) {
  if (!rows.length) return [];
  const W = rows[0].W;
  const perSheet = Math.max(1, Math.floor((SHEET_MAX_H - LABEL_H) / (rows[0].ch + LABEL_H)));
  const files = [];
  for (let s = 0; s * perSheet < rows.length; s++) {
    const part = rows.slice(s * perSheet, (s + 1) * perSheet);
    const H = LABEL_H + part.reduce((a, r) => a + r.ch + LABEL_H, 0);
    const buf = new Uint8Array(W * H * 3).fill(16);
    drawText(buf, W, 3, 2, header, [255, 220, 120]);
    let y = LABEL_H;
    for (const r of part) {
      drawText(buf, W, 3, y + 2, r.label, r.verdict === 'changed' ? [255, 120, 110] : r.verdict === 'noise' ? [240, 220, 120] : [150, 230, 150]);
      y += LABEL_H;
      buf.set(r.px, y * W * 3);
      y += r.ch;
    }
    const f = path.join(out, `contact-${s + 1}.png`);
    writeFileSync(f, encodePNG(W, H, buf, { channels: 3, level: 3 }));
    files.push(f);
  }
  return files;
}

function writeCrop(file, a, b, dmax, [cx, cy, cw, ch]) {
  cx = Math.max(0, Math.min(a.w - 1, cx | 0)); cy = Math.max(0, Math.min(a.h - 1, cy | 0));
  cw = Math.max(1, Math.min(a.w - cx, cw | 0)); ch = Math.max(1, Math.min(a.h - cy, ch | 0));
  const W = cw * 3 + GUTTER * 2;
  const px = new Uint8Array(W * ch * 3).fill(40);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const p = (cy + y) * a.w + cx + x, k = p * 4;
    const o0 = (y * W + x) * 3, o1 = (y * W + cw + GUTTER + x) * 3, o2 = (y * W + 2 * (cw + GUTTER) + x) * 3;
    px[o0] = a.rgba[k]; px[o0 + 1] = a.rgba[k + 1]; px[o0 + 2] = a.rgba[k + 2];
    px[o1] = b.rgba[k]; px[o1 + 1] = b.rgba[k + 1]; px[o1 + 2] = b.rgba[k + 2];
    const d = dmax[p], v = Math.min(255, d * 4);
    if (d > 8) { px[o2] = 255; px[o2 + 1] = v >> 2; px[o2 + 2] = v >> 2; } else { px[o2] = v; px[o2 + 1] = v; px[o2 + 2] = v; }
  }
  writeFileSync(file, encodePNG(W, ch, px, { channels: 3, level: 3 }));
}

/** same / noise / changed. `noise`: the largest base-vs-repeat difference ({ px, max }) or null. */
export function verdictOf(d, noise, pixels) {
  if (d.px === 0) return 'same';
  if (noise) return d.px <= noise.px * 1.5 + 10 && d.max <= Math.max(noise.max, 2) ? 'noise' : 'changed';
  return d.px <= pixels * 1e-4 && d.max <= 2 ? 'noise' : 'changed';
}

export async function main(argv) {
  const o = parse(argv);
  if (o.help || (!o.base && o.rest[0] !== 'baseline')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return o.help ? 0 : 2;
  }
  if (o.rest[0] === 'baseline') return baselineCmd(o);
  const shots = shotsOf(o);
  if (!shots.length) { console.error('ab: no shots (--shots or --params)'); return 2; }
  const T0 = performance.now();
  const base = resolveBase(o.base, o.test);
  const out = path.resolve(o.out ?? path.join('shots', 'ab'));
  const outs = [path.join(out, 'base'), path.join(out, 'test')];
  for (const d of outs) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
  const { render } = await import('./rsd/client.mjs');
  const entries = [[], []];
  let done = 0;
  const res = await render({
    tool: 'ab', trees: [base.tree, o.test], outs, shots, size: o.size, streamCapture: true, draft: o.flags.has('draft'),
    memo: true, fresh: o.flags.has('fresh'),
    onResult: (i, r) => {
      entries[r.side][i] = r.entry;
      done++;
      if (process.stderr.isTTY) process.stderr.write(`\r[ab] ${done}/${shots.length * 2} captures`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\n');
  const tRender = performance.now() - T0;
  // noise floor: re-render the base (memo bypassed) N times
  const repeats = [];
  for (let k = 0; k < o.noise; k++) {
    const d = path.join(out, `base-repeat-${k + 1}`);
    rmSync(d, { recursive: true, force: true });
    const rep = [];
    await render({ tool: 'ab', tree: base.tree, out: d, shots, size: o.size, streamCapture: true, draft: o.flags.has('draft'), memo: true, fresh: true, onResult: (i, r) => { rep[i] = r.entry; } });
    repeats.push(rep);
  }
  const { width, height } = parseSize(o.size);
  const rows = [];
  const summary = [];
  for (let i = 0; i < shots.length; i++) {
    const ea = entries[0][i], eb = entries[1][i];
    const errs = [...(ea?.errors ?? []).map((e) => `base: ${e}`), ...(eb?.errors ?? []).map((e) => `test: ${e}`)];
    if (!ea?.file || !eb?.file || !existsSync(ea.file) || !existsSync(eb.file)) { summary.push({ i, params: shots[i].params, verdict: 'error', errors: errs }); continue; }
    const a = decodePNG(readFileSync(ea.file)), b = decodePNG(readFileSync(eb.file));
    const dmax = new Uint8Array(a.w * a.h);
    const d = pixelDiff(a, b, dmax);
    let noise = null;
    for (const rep of repeats) {
      if (!rep[i]?.file || !existsSync(rep[i].file)) continue;
      const n = pixelDiff(a, decodePNG(readFileSync(rep[i].file)));
      noise = noise ? { px: Math.max(noise.px, n.px), px8: Math.max(noise.px8, n.px8), max: Math.max(noise.max, n.max) } : n;
    }
    const verdict = d.sizeMismatch ? 'changed' : verdictOf(d, noise, a.w * a.h);
    const s = { i, name: shots[i].name, params: shots[i].params, ...d, noise, verdict, base: ea.file, test: eb.file, memo: [!!ea.memo, !!eb.memo], errors: errs };
    summary.push(s);
    if (!d.sizeMismatch) {
      const row = rowPixels(a, b, dmax, o.scale);
      row.verdict = verdict;
      row.label = `#${i} ${verdict} px=${d.px} >8=${d.px8} max=${d.max} mad=${d.madPct}%${noise ? ` noise=${noise.px}/${noise.max}` : ''}  ${shots[i].name ?? shots[i].params}`;
      rows.push(row);
      if (o.crop) writeCrop(path.join(out, `crop-${String(i).padStart(2, '0')}.png`), a, b, dmax, o.crop);
    }
  }
  const header = `BASE ${base.label.slice(0, 40)} ${res.builds[0]?.distHash?.slice(0, 10) ?? ''} | TEST ${path.basename(o.test)} ${res.builds[1]?.distHash?.slice(0, 10) ?? ''} | DIFF X4, RED > 8 LEVELS`;
  const sheets = writeSheets(out, rows, header);
  const report = {
    date: new Date().toISOString(), base: { ...base, build: res.builds[0] }, test: { tree: o.test, build: res.builds[1] }, size: `${width}x${height}`,
    renderMs: Math.round(tRender), totalMs: Math.round(performance.now() - T0), sheets, shots: summary,
  };
  writeFileSync(path.join(out, 'ab.json'), JSON.stringify(report, null, 1));
  for (const s of summary) {
    console.log(`${String(s.i).padStart(3)} ${s.verdict.padEnd(7)} ${s.verdict === 'error' ? s.errors.join(' | ').slice(0, 200) : `px ${String(s.px).padStart(7)}  >8 ${String(s.px8).padStart(6)}  max ${String(s.max).padStart(3)}  mad ${s.madPct}%`}  ${(s.name ?? s.params).slice(0, 80)}`);
  }
  const changed = summary.filter((s) => s.verdict === 'changed' || s.verdict === 'error').length;
  console.log(`\n${summary.length} pair(s): ${summary.filter((s) => s.verdict === 'same').length} same, ${summary.filter((s) => s.verdict === 'noise').length} noise, ${changed} changed/error ` +
    `in ${(report.totalMs / 1000).toFixed(1)} s (base ${res.builds[0]?.cached ? 'build cached' : 'built'}, ${entries[0].filter((e) => e?.memo).length}/${shots.length} base shots from the memo)`);
  console.log(`sheets: ${sheets.join(' ')}\nreport: ${path.join(out, 'ab.json')}`);
  return o.expect === 'same' && changed ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
