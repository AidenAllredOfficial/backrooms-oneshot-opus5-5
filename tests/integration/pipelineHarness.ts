// tests/integration/pipelineHarness.ts — the WP10 worker-pipeline gate (DESIGN §5 WP10, §8.1 P2a), shared by its shards.
//
// In Node, handleRequest runs init -> layout, build and bake for 50 tiles across all 12 zones (forceZone rotation),
// plus the tower and leak test scenes. The worker boundary is simulated: every response goes through
// structuredClone(res, { transfer }) before the next request; after each layout response a build of a tile of the
// SAME chunk runs on the SAME HandlerState and must equal a fresh-state build (catches transferred/detached LRU
// buffers); no transferred buffer may be referenced by HandlerState. Every payload passes validate*.
//
// The 50 real full-bake tiles are split by zone index mod 3 into pipeline-a/b/c.test.ts (17 + 17 + 16 tiles), so the
// gate runs on three forks at once; PIPELINE_SHARD_TILES sums to the 50-tile guarantee. The gate is a 'sweep' (npm test
// only); each shard also has an untagged smoke test (runSmokeShard: its zones at low bake quality, ~1.5 s) that keeps
// the boundary checks in the quick tier.

import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { tileKeyStr } from '../../src/core/grid.ts';
import { Zone, ZONE_COUNT, ZONE_NAMES, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { bakeQualityOf, QUALITY, type QualityName } from '../../src/core/quality.ts';
import type { HandlerResult, WorkerInit, WorkerRequest, WorkerResponse } from '../../src/core/worker.ts';
import type { TestSceneId } from '../../src/core/world.ts';
import { createHandlerState, handleRequest, handlerCachesOf, type HandlerState } from '../../src/workers/handler.ts';
import { validateBake, validateBuild, validateLayoutPayload } from '../../src/workers/validatePayload.ts';

export function makeInit(o: { forceZone?: ZoneId | null; testScene?: TestSceneId | null; quality: QualityName; seed?: number }): WorkerInit {
  const seed = o.seed ?? 7;
  return {
    opts: {
      seed, seedText: String(seed), forceZone: o.forceZone ?? null, forceMood: null, forceLandmark: null,
      testScene: o.testScene ?? null, lights: 'default',
    },
    bake: bakeQualityOf(QUALITY[o.quality]),
    bakeTerm: 'all',
    validate: true,
  };
}

/** Every ArrayBuffer reachable from `root` through own enumerable properties, arrays, Maps and Sets. */
function reachableBuffers(root: unknown): Set<ArrayBuffer> {
  const out = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { out.add(v.buffer as ArrayBuffer); continue; }
    if (v instanceof ArrayBuffer) { out.add(v); continue; }
    if (v instanceof Map) { for (const [k, x] of v) stack.push(k, x); continue; }
    if (v instanceof Set) { for (const x of v) stack.push(x); continue; }
    for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
  }
  return out;
}

/** Content digest of a payload, ignoring timing fields (`ms`, `stats.ms`). */
function digest(v: unknown): string {
  const h = createHash('sha1');
  const walk = (x: unknown, key: string): void => {
    if (key === 'ms') return;
    if (x === null || x === undefined) { h.update(`${key}:${String(x)};`); return; }
    if (ArrayBuffer.isView(x)) {
      h.update(`${key}:${x.constructor.name}[${x.byteLength}]`);
      h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
      return;
    }
    if (Array.isArray(x)) { h.update(`${key}:[`); x.forEach((e, i) => walk(e, String(i))); h.update(']'); return; }
    if (typeof x === 'object') {
      h.update(`${key}:{`);
      for (const k of Object.keys(x as object).sort()) walk((x as Record<string, unknown>)[k], k);
      h.update('}');
      return;
    }
    h.update(`${key}:${typeof x}:${String(x)};`);
  };
  walk(v, '');
  return h.digest('hex');
}

interface Run { st: HandlerState; bakeMs: number[]; buildMs: number[]; tiles: number; chartHash: Map<string, number> }

/** handleRequest + the simulated worker boundary. Returns the structured-cloned (received) response. */
export function send(run: Run, req: WorkerRequest): WorkerResponse {
  const r: HandlerResult = handleRequest(req, run.st);
  if (r.res.t === 'error') throw new Error(`${req.t} failed in the handler: ${r.res.message}\n${r.res.stack}`);
  // no duplicate or LRU/cache-referenced buffer in the transfer list
  expect(new Set(r.transfer).size).toBe(r.transfer.length);
  const held = reachableBuffers([run.st, handlerCachesOf(run.st)]);
  for (const b of r.transfer) expect(held.has(b), `${req.t}: transfer list contains a buffer referenced by HandlerState`).toBe(false);
  const received = structuredClone(r.res, { transfer: r.transfer });
  // transferred buffers are now detached on the "worker" side; the LRU must be untouched
  for (const l of run.st.layouts.values()) {
    expect(l.flags.byteLength, `LRU layout ${l.key.cx}:${l.key.cz} detached`).toBe(l.flags.length * 2);
    expect(l.ex.kind.byteLength).toBe(l.ex.kind.length);
  }
  return received;
}

export function newRun(init: WorkerInit): Run {
  const run: Run = { st: createHandlerState(), bakeMs: [], buildMs: [], tiles: 0, chartHash: new Map() };
  const res = send(run, { t: 'init', job: 1, init });
  expect(res.t).toBe('ready');
  return run;
}

let jobId = 100;
export const nextJob = (): number => ++jobId;

export function layoutStep(run: Run, init: WorkerInit, s: StoreyId, cx: number, cz: number): void {
  const res = send(run, { t: 'layout', job: ++jobId, key: { s, cx, cz } });
  expect(res.t).toBe('layout');
  if (res.t !== 'layout') return;
  expect(validateLayoutPayload(res.layout, res.collision)).toEqual([]);
  expect(res.layout.key).toEqual({ s, cx, cz });
  // same-state build right after the layout response must equal a fresh-state build
  const tile: TileKey = { s, cx, cz, q: 3 };
  const same = send(run, { t: 'build', job: ++jobId, key: tile });
  const freshRun = newRun(init);
  const fresh = send(freshRun, { t: 'build', job: jobId, key: tile });
  expect(same.t).toBe('build');
  expect(digest(same), `same-state build of ${tileKeyStr(tile)} differs from a fresh-state build`).toBe(digest(fresh));
  // and the layout itself is deterministic across states
  const fl = send(freshRun, { t: 'layout', job: ++jobId, key: { s, cx, cz } });
  expect(digest(fl)).toBe(digest({ ...res, job: fl.job }));
}

/** A layout request through the boundary: payload valid, key echoed (layoutStep adds the determinism checks). */
export function layoutOnlyStep(run: Run, s: StoreyId, cx: number, cz: number): void {
  const res = send(run, { t: 'layout', job: ++jobId, key: { s, cx, cz } });
  expect(res.t).toBe('layout');
  if (res.t !== 'layout') return;
  expect(validateLayoutPayload(res.layout, res.collision)).toEqual([]);
  expect(res.layout.key).toEqual({ s, cx, cz });
}

/** A build request through the boundary (mesh + preview lightmap): payload valid, tile key echoed. */
export function buildStep(run: Run, key: TileKey): Extract<WorkerResponse, { t: 'build' }> | null {
  const b = send(run, { t: 'build', job: ++jobId, key });
  expect(b.t).toBe('build');
  if (b.t !== 'build') return null;
  expect(validateBuild(b.mesh, b.lightmap), `build ${tileKeyStr(key)}`).toEqual([]);
  expect(b.mesh.tileKey).toBe(tileKeyStr(key));
  run.buildMs.push(b.ms.gen + b.ms.mesh + b.ms.bake);
  return b;
}

/** buildStep, then the full bake of the same tile: valid, same atlas (chartHash) and lightmap size as the build. */
export function tileStep(run: Run, key: TileKey): void {
  const b = buildStep(run, key);
  if (!b) return;
  const f = send(run, { t: 'bake', job: ++jobId, key });
  expect(f.t).toBe('bake');
  if (f.t !== 'bake') return;
  // build chartHash == bake chartHash (same atlas, instant swap)
  expect(validateBake(f.lightmap, b.mesh.atlas.chartHash), `bake ${tileKeyStr(key)}`).toEqual([]);
  expect(f.lightmap.width).toBe(b.lightmap.width);
  expect(f.lightmap.height).toBe(b.lightmap.height);
  run.bakeMs.push(f.ms);
  run.chartHash.set(tileKeyStr(key), b.mesh.atlas.chartHash);
  run.tiles++;
}

export interface PipelineStats { tiles: number; bakeMs: number[]; buildMs: number[] }
export const createStats = (): PipelineStats => ({ tiles: 0, bakeMs: [], buildMs: [] });
export function collect(stats: PipelineStats, run: Run): void {
  stats.tiles += run.tiles;
  stats.bakeMs.push(...run.bakeMs);
  stats.buildMs.push(...run.buildMs);
}

/** The storey and chunk of zone z in the 50-tile gate. */
export function zonePlacement(z: number): { s: StoreyId; cx: number; cz: number } {
  const zone = z as ZoneId;
  return { s: (zone === 7 ? 2 : zone >= 8 ? 1 : 0) as StoreyId, cx: z - 6, cz: ((z * 7) % 5) - 2 };
}

/** Zones that get a tile of the neighbouring chunk (warm LRU / bake cache on the same state): 12 x 4 + 2 = 50. */
const EXTRA_TILE_ZONES = [0, 7];
export const PIPELINE_SHARDS = 3;
/** Tiles per shard (zones z % 3 === shard): the three sum to the 50-tile gate. */
export const PIPELINE_SHARD_TILES: readonly number[] = Array.from({ length: PIPELINE_SHARDS }, (_, k) => {
  let n = 0;
  for (let z = k; z < ZONE_COUNT; z += PIPELINE_SHARDS) n += 4 + (EXTRA_TILE_ZONES.includes(z) ? 1 : 0);
  return n;
});

/** One shard of the 50-tile gate: zones z % 3 === shard, all four tiles of one chunk each (high / medium quality
 * alternating), full bakes, plus a neighbouring-chunk tile for zones 0 and 7. */
export function runGateShard(shard: number, stats: PipelineStats): void {
  for (let z = shard; z < ZONE_COUNT; z += PIPELINE_SHARDS) {
    const zone = z as ZoneId;
    const init = makeInit({ forceZone: zone, quality: z % 2 === 0 ? 'high' : 'medium' });
    const run = newRun(init);
    const { s, cx, cz } = zonePlacement(z);
    layoutStep(run, init, s, cx, cz);
    for (let q = 0; q < 4; q++) tileStep(run, { s, cx, cz, q: q as 0 | 1 | 2 | 3 });
    if (EXTRA_TILE_ZONES.includes(z)) tileStep(run, { s, cx: cx + 1, cz, q: 0 });
    expect(run.tiles, `zone ${ZONE_NAMES[z]}`).toBeGreaterThanOrEqual(4);
    collect(stats, run);
  }
  expect(stats.tiles).toBe(PIPELINE_SHARD_TILES[shard]);
}

/** Smoke: full bake + same-state == fresh-state determinism on one zone per shard (LOBBY, storey 2 POOLROOMS with its
 * water meshes, storey 1 PARKING); layout + build through the boundary for the others. */
const SMOKE_FULL_CHECK_ZONES: readonly number[] = [Zone.LOBBY, Zone.POOLROOMS, Zone.PARKING];

/** The quick-tier slice of one shard: its zones at low bake quality, one tile each, through the simulated boundary
 * (transfer list, detached LRU, payload validation on every response). */
export function runSmokeShard(shard: number): void {
  let tiles = 0, full = 0;
  for (let z = shard; z < ZONE_COUNT; z += PIPELINE_SHARDS) {
    const init = makeInit({ forceZone: z as ZoneId, quality: 'low' });
    const run = newRun(init);
    const { s, cx, cz } = zonePlacement(z);
    const key: TileKey = { s, cx, cz, q: (z % 4) as 0 | 1 | 2 | 3 };
    if (SMOKE_FULL_CHECK_ZONES.includes(z)) {
      layoutStep(run, init, s, cx, cz);
      tileStep(run, key);
      full += run.tiles;
    } else {
      layoutOnlyStep(run, s, cx, cz);
      if (buildStep(run, key)) tiles++;
    }
  }
  expect(full, 'zones with the full bake + determinism checks').toBe(1);
  expect(tiles + full).toBe(Math.ceil((ZONE_COUNT - shard) / PIPELINE_SHARDS));
}

export function logBench(label: string, stats: PipelineStats): void {
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const p95 = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : 0);
  console.log(`[pipeline ${label}] tiles ${stats.tiles}; full bake mean ${mean(stats.bakeMs).toFixed(1)} ms, p95 ${p95(stats.bakeMs).toFixed(1)} ms; ` +
    `build (gen+mesh+preview) mean ${mean(stats.buildMs).toFixed(1)} ms, p95 ${p95(stats.buildMs).toFixed(1)} ms`);
}
