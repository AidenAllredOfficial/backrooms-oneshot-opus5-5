// tools/bakebench.ts — light-baker benchmark and gate (WP7). Runs the pure baker in Node (type stripping):
//
//   node tools/bakebench.ts [--zones LOBBY,LOW_EXPANSE,PILLAR_HALL,POOLROOMS,WAREHOUSE,ATRIUM] [--seed 1]
//                           [--quality high] [--workers 12] [--no-ttr | --ttr-only] [--ttr-policy pool|static]
//                           [--json out.json] [--quiet]
//
// For every bench zone (ATRIUM = forceLandmark=ATRIUM) and every chunk of the radius-1 neighbourhood (9 chunks):
//   - preview + full bake of the chunk's 4 tiles on one thread, with one BakeCache per chunk: the chunk's first
//     tile is "cold", the other three "warm" (the worker-affinity case);
//   - per tile: ms, texels, rays, lights (static / dynamic), K_MAX tail (mean / max estimate fraction handled by the
//     tail approximation instead of exact evaluation), patches and visibility bitsets computed.
// Then the time-to-ready: the 36 tiles full-baked on `--workers` worker_threads with chunk affinity (default: the
// tiles in chunk-major order split into contiguous runs, one per worker; `--ttr-policy pool`: dispatched like the
// game's WorkerPool, i.e. a job goes to its chunk's home worker when that one is idle, else to any idle worker);
// layouts and surfaces are built before the clock starts.
// Gate (§5 WP7): full p95 <= 600 ms warm, max <= 900 ms cold, preview p95 <= 60 ms, time-to-ready <= 2.5 s.
// Exit code 1 when a gate fails (the numbers are printed either way). Memory: workers are only spawned while
// MemAvailable leaves >= 2 GB after ~300 MB per worker (the count is reduced otherwise).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { chunkKeyStr, type TileKey } from '../src/core/grid.ts';
import { LandmarkKind, type StoreyId, Zone, type ZoneId } from '../src/core/ids.ts';
import type { ChunkLayout } from '../src/core/layout.ts';
import type { SurfaceSet } from '../src/core/mesh.ts';
import { bakeQualityOf, QUALITY, type BakeQuality, type QualityName } from '../src/core/quality.ts';
import { hashString } from '../src/core/rng.ts';
import type { LayoutNeighborhood, WorldGenOptions } from '../src/core/world.ts';
import { bakeTile, createBakeCache, lastBake } from '../src/bake/index.ts';
import { buildTileSurfaces } from '../src/mesh/surfaces.ts';
import { makeNeighborhood } from '../src/world/neighborhood.ts';
import { createWorldGen } from '../src/world/worldgen.ts';

export interface BenchZone { name: string; opts: WorldGenOptions; s: StoreyId; cx: number; cz: number }
export interface TileRow {
  key: string; variant: 'preview' | 'full'; warm: boolean; ms: number; texels: number; rays: number;
  lights: number; dynLights: number; tailMean: number; tailMax: number; patches: number; visBits: number; nonDynFlicker: number;
}
export interface ZoneResult {
  zone: string; rows: TileRow[];
  fullWarmP95: number; fullColdMax: number; previewP95: number; ttrMs: number | null; workers: number;
  tailMean: number; tailMax: number; nonDynFlicker: number;
}
export interface BenchOptions {
  zones: string[]; seed: number; quality: QualityName; workers: number; ttr: boolean; quiet: boolean;
  /** skip the single-thread per-tile runs */
  ttrOnly?: boolean;
  /** time-to-ready dispatch: 'static' (default, the §5 WP7 "chunk affinity" model) = the tiles in chunk-major order
   * split into contiguous runs, one per worker (a chunk's tiles stay together where the count allows); 'pool' = the
   * game's WorkerPool soft affinity (a job goes to any idle worker when its home worker is busy) */
  ttrPolicy?: 'pool' | 'static';
}

export const BENCH_ZONES = ['LOBBY', 'LOW_EXPANSE', 'PILLAR_HALL', 'POOLROOMS', 'WAREHOUSE', 'ATRIUM'];
export const GATE = { fullWarmP95: 600, fullColdMax: 900, previewP95: 60, ttrMs: 2500 } as const;

const baseOpts = (seed: number): WorldGenOptions =>
  ({ seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });

/** The 3x3 layouts around a chunk; `memo` (optional) shares layouts between neighbourhoods (like the workers' LRU). */
function layouts3x3(opts: WorldGenOptions, s: StoreyId, cx: number, cz: number, memo?: Map<string, ChunkLayout>): ChunkLayout[] {
  const gen = createWorldGen(opts);
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = `${cx + dx},${cz + dz}`;
      let l = memo?.get(key);
      if (!l) { l = gen.generateChunk({ s, cx: cx + dx, cz: cz + dz }); memo?.set(key, l); }
      ls.push(l);
    }
  }
  return ls;
}

/** Bench zone configuration. POOLROOMS: the first chunk (scanning east) whose district has vaulted ceilings. */
export function benchZone(name: string, seed: number): BenchZone {
  const opts = baseOpts(seed);
  if (name === 'ATRIUM') return { name, opts: { ...opts, forceLandmark: LandmarkKind.ATRIUM }, s: 0, cx: 0, cz: 0 };
  const zone = (Zone as Record<string, number>)[name];
  if (zone === undefined) throw new Error(`bakebench: unknown zone ${name}`);
  const o = { ...opts, forceZone: zone as ZoneId };
  if (zone === Zone.POOLROOMS) {
    const gen = createWorldGen(o);
    for (let cx = 0; cx < 16; cx++) {
      const l = gen.generateChunk({ s: 2, cx, cz: 0 });
      let maxCeil = 0;
      for (let c = 0; c < l.ceilCm.length; c++) if (l.ceilCm[c] > maxCeil) maxCeil = l.ceilCm[c];
      if (maxCeil >= 500) return { name: `${name}(vaulted @${cx},0)`, opts: o, s: 2, cx, cz: 0 };
    }
    return { name: `${name}(no vault found)`, opts: o, s: 2, cx: 0, cz: 0 };
  }
  return { name, opts: o, s: 0, cx: 0, cz: 0 };
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
};

interface ChunkJob { opts: WorldGenOptions; s: StoreyId; cx: number; cz: number; q: BakeQuality }

/** Build the neighbourhood of one chunk and the surfaces of its 4 tiles (not timed). */
function prepareChunk(j: ChunkJob, memo?: Map<string, ChunkLayout>): { nb: LayoutNeighborhood; tiles: TileKey[]; surfaces: SurfaceSet[] } {
  const nb = makeNeighborhood(layouts3x3(j.opts, j.s, j.cx, j.cz, memo));
  const tiles: TileKey[] = [0, 1, 2, 3].map((q) => ({ s: j.s, cx: j.cx, cz: j.cz, q: q as 0 | 1 | 2 | 3 }));
  return { nb, tiles, surfaces: tiles.map((t) => buildTileSurfaces(nb, t, j.q.tpc)) };
}

function row(key: string, variant: 'preview' | 'full', warm: boolean): TileRow {
  const r = lastBake;
  return {
    key, variant, warm, ms: r.ms.total, texels: r.texels, rays: r.rays, lights: r.staticLights, dynLights: r.dynamicLights,
    tailMean: r.receivers > 0 ? r.dropSum / r.receivers : 0, tailMax: r.dropMax, patches: r.patches, visBits: r.visBits,
    nonDynFlicker: r.nonDynamicFlicker,
  };
}

/** Single-thread per-tile measurements of one zone (9 chunks x 4 tiles, preview + full). */
export function benchZoneTiles(z: BenchZone, q: BakeQuality, log: (s: string) => void): TileRow[] {
  const rows: TileRow[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const job: ChunkJob = { opts: z.opts, s: z.s, cx: z.cx + dx, cz: z.cz + dz, q };
      const { nb, tiles, surfaces } = prepareChunk(job);
      const pcache = createBakeCache();
      const pms: number[] = [];
      for (let k = 0; k < 4; k++) {
        bakeTile(nb, tiles[k], surfaces[k], 'preview', q, 'all', pcache);
        rows.push(row(`${job.s}:${job.cx}:${job.cz}:${k}`, 'preview', k > 0));
        pms.push(lastBake.ms.total);
      }
      const cache = createBakeCache();
      for (let k = 0; k < 4; k++) {
        bakeTile(nb, tiles[k], surfaces[k], 'full', q, 'all', cache);
        const r = row(`${job.s}:${job.cx}:${job.cz}:${k}`, 'full', k > 0);
        rows.push(r);
        log(`  ${r.key.padEnd(12)} full ${r.warm ? 'warm' : 'cold'} ${r.ms.toFixed(0).padStart(5)} ms  texels ${String(r.texels).padStart(6)}  rays ${String(r.rays).padStart(8)}  lights ${r.lights}+${r.dynLights}dyn  K_MAX tail mean ${(100 * r.tailMean).toFixed(2)}% max ${(100 * r.tailMax).toFixed(1)}%  patches ${r.patches}  vis ${r.visBits}  | preview ${pms[k].toFixed(0)} ms`);
      }
    }
  }
  return rows;
}

function memAvailableMb(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : 1e9;
  } catch { return 1e9; }
}

/** Home worker of a chunk: the WorkerPool's soft-affinity routing (src/stream/WorkerPool.ts `affinityWorker`, keyed
 * by the chunk key string). */
const homeWorker = (s: StoreyId, cx: number, cz: number, size: number): number => (hashString(chunkKeyStr({ s, cx, cz })) >>> 0) % size;

/** Estimated resident memory per bench worker (MB): isolate + JIT + the 9 prepared chunks + bake scratch. */
const WORKER_MB = 300;

/**
 * Time-to-ready: the 36 full bakes of the radius-1 neighbourhood on `maxWorkers` worker_threads.
 *   - `static` (default): the tiles in chunk-major order are split into contiguous runs, one per worker, so a
 *     chunk's tiles share a worker (and its BakeCache) wherever the worker count allows;
 *   - `pool`: dispatched like the game's WorkerPool (src/stream/WorkerPool.ts): one queue (centre chunk first, then
 *     chunk-major); whenever a worker is idle, the next job goes to its chunk's home worker if that one is idle,
 *     else to the idle worker (soft affinity, work-conserving: most jobs of a deep queue land on cold caches).
 * Before the clock starts every worker has generated the 9
 * neighbourhoods and tile surfaces (the game's layout LRU / build jobs) and preview-baked, with its BakeCache, the
 * tiles of its home chunks (static: its own tiles); a worker without any previews one tile with a throwaway cache,
 * for a warm JIT. Returns wall ms and the worker count (reduced when MemAvailable would drop below 2 GB).
 */
export async function timeToReady(z: BenchZone, q: BakeQuality, maxWorkers: number, policy: 'pool' | 'static' = 'static'): Promise<{ ms: number; workers: number }> {
  const chunks: { cx: number; cz: number }[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) chunks.push({ cx: z.cx + dx, cz: z.cz + dz });
  let workers = Math.min(maxWorkers, 36);
  const affordable = Math.floor((memAvailableMb() - 2000) / WORKER_MB);
  if (affordable < workers) workers = Math.max(1, affordable);
  const home = chunks.map((c) => homeWorker(z.s, c.cx, c.cz, workers));
  const queue: { ci: number; k: number; w: number }[] = [];
  for (const ci of [4, 0, 1, 2, 3, 5, 6, 7, 8]) for (let k = 0; k < 4; k++) queue.push({ ci, k, w: -1 });
  if (policy === 'static') {
    // contiguous runs in chunk-major order; a worker's "home" chunks are those it bakes tiles of
    queue.sort((a, b) => a.ci - b.ci || a.k - b.k);
    queue.forEach((j, i) => { j.w = Math.floor((i * workers) / queue.length); });
  }
  // tiles each worker preview-baked before the clock (pool: its home chunks; static: its own tiles)
  const pre = (w: number): { ci: number; k: number }[] => policy === 'static'
    ? queue.filter((j) => j.w === w).map((j) => ({ ci: j.ci, k: j.k }))
    : home.flatMap((h, ci) => (h === w ? [0, 1, 2, 3].map((k) => ({ ci, k })) : []));
  const url = new URL(import.meta.url);
  const ws = Array.from({ length: workers }, (_, w) => new Worker(url, {
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    workerData: { opts: z.opts, s: z.s, chunks, q, pre: pre(w), warm: w % 9 },
  }));
  try {
    await Promise.all(ws.map((w) => new Promise<void>((res, rej) => {
      w.once('error', rej);
      w.once('message', (m: { t: string }) => (m.t === 'ready' ? res() : rej(new Error(`unexpected ${m.t}`))));
    })));
    const busy = new Array<boolean>(workers).fill(false);
    let rr = 0, left = queue.length;
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const pump = (): void => {
        while (queue.length > 0) {
          let idle = -1;
          for (let k = 0; k < workers; k++) { const i = (rr + k) % workers; if (!busy[i]) { idle = i; break; } }
          if (idle < 0) return;
          let qi = 0;
          if (policy === 'static') { qi = queue.findIndex((x) => !busy[x.w]); if (qi < 0) return; }
          const j = queue.splice(qi, 1)[0];
          const target = policy === 'static' ? j.w : !busy[home[j.ci]] ? home[j.ci] : idle;
          if (target === idle) rr = (idle + 1) % workers;
          busy[target] = true;
          ws[target].postMessage(j);
        }
      };
      ws.forEach((w, i) => {
        w.on('error', reject);
        w.on('message', (m: { t: string }) => {
          if (m.t !== 'done') { reject(new Error(`unexpected ${m.t}`)); return; }
          busy[i] = false;
          if (--left === 0) resolve(); else pump();
        });
      });
      pump();
    });
    return { ms: performance.now() - t0, workers };
  } finally {
    await Promise.all(ws.map((w) => w.terminate()));
  }
}

function workerMain(): void {
  const d = workerData as { opts: WorldGenOptions; s: StoreyId; chunks: { cx: number; cz: number }[]; q: BakeQuality; pre: { ci: number; k: number }[]; warm: number };
  const memo = new Map<string, ChunkLayout>();
  const prepared = d.chunks.map((c) => prepareChunk({ opts: d.opts, s: d.s, cx: c.cx, cz: c.cz, q: d.q }, memo));
  const cache = createBakeCache(); // one per worker, as in workers/handler.ts
  // the game's build jobs (preview bakes) ran here first: warm JIT and BakeCache
  for (const { ci, k } of d.pre) bakeTile(prepared[ci].nb, prepared[ci].tiles[k], prepared[ci].surfaces[k], 'preview', d.q, 'all', cache);
  if (d.pre.length === 0) { const p = prepared[d.warm]; bakeTile(p.nb, p.tiles[0], p.surfaces[0], 'preview', d.q, 'all', createBakeCache()); }
  parentPort?.on('message', (j: { ci: number; k: number }) => {
    const p = prepared[j.ci];
    bakeTile(p.nb, p.tiles[j.k], p.surfaces[j.k], 'full', d.q, 'all', cache);
    parentPort?.postMessage({ t: 'done' });
  });
  parentPort?.postMessage({ t: 'ready' });
}

export async function runBench(o: BenchOptions): Promise<ZoneResult[]> {
  const q = bakeQualityOf(QUALITY[o.quality]);
  const log = (s: string): void => { if (!o.quiet) console.log(s); };
  const out: ZoneResult[] = [];
  for (const name of o.zones) {
    const z = benchZone(name, o.seed);
    log(`== ${z.name} (s ${z.s}, centre chunk ${z.cx},${z.cz}, quality ${o.quality}: tpc ${q.tpc}, ${q.shadowSamples} samples, ${q.probeRays} rays)`);
    const rows = o.ttrOnly ? [] : benchZoneTiles(z, q, log);
    const full = rows.filter((r) => r.variant === 'full'), prev = rows.filter((r) => r.variant === 'preview');
    let ttr: { ms: number; workers: number } | null = null;
    if (o.ttr) ttr = await timeToReady(z, q, o.workers, o.ttrPolicy ?? 'static');
    const res: ZoneResult = {
      zone: z.name, rows,
      fullWarmP95: pct(full.filter((r) => r.warm).map((r) => r.ms), 0.95),
      fullColdMax: Math.max(...full.filter((r) => !r.warm).map((r) => r.ms)),
      previewP95: pct(prev.map((r) => r.ms), 0.95),
      ttrMs: ttr ? ttr.ms : null, workers: ttr ? ttr.workers : 0,
      tailMean: full.reduce((a, r) => a + r.tailMean, 0) / Math.max(1, full.length),
      tailMax: Math.max(...full.map((r) => r.tailMax)),
      nonDynFlicker: Math.max(...rows.map((r) => r.nonDynFlicker)),
    };
    log(`   full warm p95 ${res.fullWarmP95.toFixed(0)} ms (gate ${GATE.fullWarmP95})  cold max ${res.fullColdMax.toFixed(0)} ms (gate ${GATE.fullColdMax})  ` +
      `preview p95 ${res.previewP95.toFixed(0)} ms (gate ${GATE.previewP95})  time-to-ready ${res.ttrMs === null ? '-' : res.ttrMs.toFixed(0) + ' ms on ' + res.workers + ' workers'} (gate ${GATE.ttrMs})  ` +
      `K_MAX tail mean ${(100 * res.tailMean).toFixed(2)}% max ${(100 * res.tailMax).toFixed(1)}%`);
    out.push(res);
  }
  return out;
}

export function gateFailures(rs: ZoneResult[]): string[] {
  const f: string[] = [];
  for (const r of rs) {
    if (r.fullWarmP95 > GATE.fullWarmP95) f.push(`${r.zone}: full warm p95 ${r.fullWarmP95.toFixed(0)} > ${GATE.fullWarmP95} ms`);
    if (r.fullColdMax > GATE.fullColdMax) f.push(`${r.zone}: full cold ${r.fullColdMax.toFixed(0)} > ${GATE.fullColdMax} ms`);
    if (r.previewP95 > GATE.previewP95) f.push(`${r.zone}: preview p95 ${r.previewP95.toFixed(0)} > ${GATE.previewP95} ms`);
    if (r.ttrMs !== null && r.ttrMs > GATE.ttrMs) f.push(`${r.zone}: time-to-ready ${r.ttrMs.toFixed(0)} > ${GATE.ttrMs} ms`);
    if (r.nonDynFlicker > 0) f.push(`${r.zone}: ${r.nonDynFlicker} FLICKER/ANOMALY lights are not dynamic`);
  }
  return f;
}

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    m.set(a.slice(2), v);
  }
  return m;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const o: BenchOptions = {
    zones: (a.get('zones') ?? BENCH_ZONES.join(',')).split(',').filter((s) => s.length > 0),
    seed: Number(a.get('seed') ?? 1),
    quality: (a.get('quality') ?? 'high') as QualityName,
    workers: Number(a.get('workers') ?? 12),
    ttr: !a.has('no-ttr'),
    quiet: a.has('quiet'),
    ttrOnly: a.has('ttr-only'),
    ttrPolicy: a.get('ttr-policy') === 'pool' ? 'pool' : 'static',
  };
  const rs = await runBench(o);
  const json = a.get('json');
  if (json) writeFileSync(json, JSON.stringify(rs, null, 1));
  const fails = gateFailures(rs);
  console.log(fails.length === 0 ? 'bakebench: all gates pass' : `bakebench: ${fails.length} gate failure(s):\n  ${fails.join('\n  ')}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

if (!isMainThread) workerMain();
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
