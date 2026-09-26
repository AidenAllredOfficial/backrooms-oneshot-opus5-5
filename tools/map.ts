// tools/map.ts — world map tool (WP1). Runs the pure generator in Node (type stripping):
//
//   node tools/map.ts --seed 1 --s 0 --cx0 -2 --cz0 -2 --cx1 2 --cz1 2 [--png out.png] [--zones] [--force ZONE]
//                     [--mood MOOD] [--landmark NAME] [--scene NAME] [--quiet]
//   node tools/map.ts --seed 1 --bench 100      (generateChunk timing over N random keys, JSON on stdout)
//
// Prints the ASCII map (ascii.ts format) of the chunk rectangle [cx0..cx1] x [cz0..cz1] (inclusive).
// --zones prints a per-cell zone map (one letter per cell) plus a district summary instead.
// --png writes 4 px per cell: zone colour tints, walls black (openings dark), lights yellow, towers red,
// elevators magenta, water blue, SOLID dark grey. Encoded with node:zlib and a hand-written PNG chunk writer.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { CHUNK_CELLS } from '../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../src/core/grid.ts';
import {
  CellFlag, EdgeKind, LANDMARK_NAMES, type LandmarkKindId, LightState, MOOD_NAMES, type MoodId, type StoreyId,
  ZONE_NAMES, type ZoneId,
} from '../src/core/ids.ts';
import type { ChunkLayout } from '../src/core/layout.ts';
import { hashString } from '../src/core/rng.ts';
import { TEST_SCENES, type TestSceneId } from '../src/core/world.ts';
import { asciiMapFromLayouts } from '../src/world/ascii.ts';
import { createWorldGen } from '../src/world/worldgen.ts';

const N = CHUNK_CELLS;
const PX = 4; // pixels per cell

// ------------------------------------------------------------------ args
function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    m.set(k, v);
  }
  return m;
}
const args = parseArgs(process.argv.slice(2));
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const seedText = args.get('seed') ?? '1';
const s = Math.max(0, Math.min(2, num('s', 0))) as StoreyId;
const cx0 = num('cx0', -2), cz0 = num('cz0', -2), cx1 = num('cx1', 2), cz1 = num('cz1', 2);
const force = args.get('force')?.toUpperCase() ?? null;
const forceZone = force !== null ? ZONE_NAMES.indexOf(force) : -1;
if (force !== null && forceZone < 0) { console.error(`unknown zone ${force}; one of ${ZONE_NAMES.join(', ')}`); process.exit(2); }
const moodArg = args.get('mood')?.toUpperCase() ?? null;
const forceMood = moodArg !== null ? MOOD_NAMES.indexOf(moodArg) : -1;
const lmArg = args.get('landmark')?.toUpperCase() ?? null;
const forceLandmark = lmArg !== null ? LANDMARK_NAMES.indexOf(lmArg) : -1;
const sceneArg = (args.get('scene') ?? null) as TestSceneId | null;
if (sceneArg !== null && !TEST_SCENES.includes(sceneArg)) { console.error(`unknown scene ${sceneArg}`); process.exit(2); }

if (args.has('bench')) {
  const n = Math.max(1, num('bench', 100));
  const bgen = createWorldGen({
    seed: hashString(seedText), seedText, forceZone: forceZone >= 0 ? (forceZone as ZoneId) : null, forceMood: null,
    forceLandmark: null, testScene: null, lights: 'default',
  });
  let r = hashString(`bench:${seedText}`) >>> 0;
  const rnd = (lo: number, hi: number): number => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return lo + (r % (hi - lo + 1)); };
  for (let i = 0; i < 12; i++) bgen.generateChunk({ s: (i % 3) as StoreyId, cx: 5000 + i, cz: 5000 }); // JIT warm-up
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = { s: rnd(0, 2) as StoreyId, cx: rnd(-1000, 1000), cz: rnd(-1000, 1000) };
    const b0 = performance.now();
    bgen.generateChunk(key);
    ts.push(performance.now() - b0);
  }
  ts.sort((a, b) => a - b);
  const mean = ts.reduce((a, b) => a + b, 0) / n;
  console.log(JSON.stringify({ n, mean, p50: ts[Math.floor(n * 0.5)], p95: ts[Math.min(n - 1, Math.floor(n * 0.95))], max: ts[n - 1] }));
  process.exit(0);
}

const t0 = performance.now();
const gen = createWorldGen({
  seed: hashString(seedText), seedText,
  forceZone: forceZone >= 0 ? (forceZone as ZoneId) : null,
  forceMood: forceMood >= 0 ? (forceMood as MoodId) : null,
  forceLandmark: forceLandmark >= 0 ? (forceLandmark as LandmarkKindId) : null,
  testScene: sceneArg, lights: 'default',
});
const X0 = Math.min(cx0, cx1), X1 = Math.max(cx0, cx1), Z0 = Math.min(cz0, cz1), Z1 = Math.max(cz0, cz1);
const nx = X1 - X0 + 1, nz = Z1 - Z0 + 1;
const layouts: ChunkLayout[] = [];
for (let cz = Z0; cz <= Z1; cz++) for (let cx = X0; cx <= X1; cx++) layouts.push(gen.generateChunk({ s, cx, cz }));
const genMs = performance.now() - t0;

// ------------------------------------------------------------------ text output
const ZONE_CH = 'LMDZXPOWKIHC'; // LOBBY MANILA DARK MAZE LOW_EXPANSE PILLAR_HALL OFFICE POOLROOMS PARKING PIPEWORKS WAREHOUSE CONCRETE
if (!args.has('quiet')) {
  if (args.has('zones')) {
    const lines: string[] = [];
    for (let gz = 0; gz < nz * N; gz++) {
      let row = '';
      for (let gx = 0; gx < nx * N; gx++) {
        const l = layouts[Math.floor(gz / N) * nx + Math.floor(gx / N)];
        const c = cellIdx(gx % N, gz % N);
        const f = l.flags[c];
        row += (f & CellFlag.TOWER) ? 'S' : (f & CellFlag.ELEVATOR) ? 'E' : (f & CellFlag.ARTERY) ? '=' : (f & CellFlag.SOLID) ? '#' : ZONE_CH[l.cellZone[c]] ?? '?';
      }
      lines.push(row);
    }
    console.log(lines.join('\n'));
    console.log(`\nlegend: ${ZONE_NAMES.map((z, i) => `${ZONE_CH[i]}=${z}`).join(' ')}  #=SOLID ==artery S=tower E=elevator`);
    const seen = new Map<number, string>();
    for (const l of layouts) {
      const d = gen.districtAt(s, l.key.cx, l.key.cz);
      if (!seen.has(d.id)) seen.set(d.id, `district ${d.id.toString(16).padStart(8, '0')}: ${ZONE_NAMES[d.zone]} / ${MOOD_NAMES[d.mood]} site (${d.siteX.toFixed(1)}, ${d.siteZ.toFixed(1)})`);
    }
    console.log([...seen.values()].join('\n'));
  } else {
    console.log(asciiMapFromLayouts(layouts, nx, nz));
  }
  const sites: string[] = [];
  for (const l of layouts) {
    const lm = gen.landmarkAt(s, l.key.cx, l.key.cz);
    if (lm) sites.push(`landmark ${LANDMARK_NAMES[lm.kind]} @ (${lm.cx},${lm.cz})`);
  }
  for (const l of layouts) {
    const { cx, cz } = l.key;
    const t = gen.towersNear(s, cx, cz).find((x) => x.cx === cx && x.cz === cz);
    if (t) sites.push(`tower @ (${cx},${cz})${t.endless ? ' ENDLESS' : ''}`);
    if (gen.elevatorsNear(s, cx, cz).some((x) => x.cx === cx && x.cz === cz)) sites.push(`elevator @ (${cx},${cz})`);
    for (const a of gen.arteriesNear(s, cx, cz)) {
      const inChunk = a.axis === 'x' ? Math.floor(a.row / N) === cz && a.g0 <= cx * N && a.g1 > cx * N : Math.floor(a.row / N) === cx && a.g0 <= cz * N && a.g1 > cz * N;
      if (inChunk) sites.push(`artery ${a.axis} row ${a.row} @ (${cx},${cz})`);
    }
  }
  if (sites.length) console.log(sites.join('\n'));
}

// ------------------------------------------------------------------ PNG
const ZONE_RGB: readonly [number, number, number][] = [
  [214, 190, 110], // LOBBY mustard
  [222, 200, 160], // MANILA
  [120, 104, 70], // DARK
  [200, 150, 90], // MAZE
  [190, 200, 120], // LOW_EXPANSE
  [230, 170, 150], // PILLAR_HALL
  [150, 160, 190], // OFFICE
  [120, 205, 215], // POOLROOMS
  [150, 150, 150], // PARKING
  [170, 120, 100], // PIPEWORKS
  [180, 170, 140], // WAREHOUSE
  [130, 140, 130], // CONCRETE
];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

const pngPath = args.get('png');
if (pngPath) {
  const W = nx * N * PX + 1, H = nz * N * PX + 1;
  const img = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    img[o] = r; img[o + 1] = g; img[o + 2] = b;
  };
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const l = layouts[z * nx + x];
      const ox = x * N * PX, oz = z * N * PX;
      // cells
      for (let lj = 0; lj < N; lj++) {
        for (let li = 0; li < N; li++) {
          const c = cellIdx(li, lj);
          const f = l.flags[c];
          let [r, g, b] = ZONE_RGB[l.cellZone[c]] ?? [255, 0, 255];
          // shade by power (dark sectors read darker)
          const p = 0.55 + 0.45 * (l.power[c] / 255);
          r *= p; g *= p; b *= p;
          if (f & CellFlag.ARTERY) { r = r * 0.8 + 40; g = g * 0.8 + 40; b = b * 0.8 + 40; }
          if (f & CellFlag.LANDMARK) { r = r * 0.6 + 100; g = g * 0.6 + 100; b = b * 0.6 + 100; }
          if (l.waterCm[c] !== -32768) { r = 40; g = 110; b = 190; }
          if (f & CellFlag.SOLID) { r = 38; g = 36; b = 34; }
          if (f & CellFlag.VOID) { r = 5; g = 5; b = 5; }
          if (f & CellFlag.TOWER) { r = 210; g = 30; b = 30; }
          if (f & CellFlag.ELEVATOR) { r = 200; g = 40; b = 200; }
          for (let py = 0; py < PX; py++) for (let px = 0; px < PX; px++) set(ox + li * PX + px, oz + lj * PX + py, r | 0, g | 0, b | 0);
        }
      }
      // edges
      const edgeRgb = (k: number): [number, number, number] | null => {
        switch (k) {
          case EdgeKind.OPEN: return null;
          case EdgeKind.WALL: case EdgeKind.GLITCH: return [0, 0, 0];
          case EdgeKind.DOORWAY: return [95, 60, 25];
          case EdgeKind.HEADER: case EdgeKind.ARCH: return [70, 70, 80];
          default: return [60, 60, 60]; // partitions, half walls, rails, windows
        }
      };
      for (let lj = 0; lj < N; lj++) {
        for (let i = 0; i <= N; i++) {
          const col = edgeRgb(l.ex.kind[exIdx(i, lj)]);
          if (!col) continue;
          for (let py = 0; py <= PX; py++) set(ox + i * PX, oz + lj * PX + py, col[0], col[1], col[2]);
        }
      }
      for (let j = 0; j <= N; j++) {
        for (let li = 0; li < N; li++) {
          const col = edgeRgb(l.ez.kind[ezIdx(li, j)]);
          if (!col) continue;
          for (let px = 0; px <= PX; px++) set(ox + li * PX + px, oz + j * PX, col[0], col[1], col[2]);
        }
      }
      // lights
      for (const f of l.fixtures) {
        const fx = ox + Math.floor(f.px / 1.2 * PX), fz = oz + Math.floor(f.pz / 1.2 * PX);
        const col: [number, number, number] = f.dynamic ? [255, 140, 0] : f.state === LightState.OFF ? [110, 100, 30]
          : f.state === LightState.DYING ? [200, 120, 150] : [255, 240, 60];
        for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) set(fx + dx, fz + dy, col[0], col[1], col[2]);
      }
    }
  }
  writeFileSync(pngPath, encodePng(W, H, img));
  if (!args.has('quiet')) console.log(`wrote ${pngPath} (${W}x${H})`);
}
console.error(`map: ${nx}x${nz} chunks, storey ${s}, seed ${seedText}: generation ${genMs.toFixed(0)} ms (${(genMs / (nx * nz)).toFixed(2)} ms/chunk), total ${(performance.now() - t0).toFixed(0)} ms`);
