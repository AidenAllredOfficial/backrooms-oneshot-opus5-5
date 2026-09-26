// tests/integration/pipeline.test.ts (WP10) — the first-try integration gate (DESIGN §5 WP10, §8.1 P2a).
//
// In Node, handleRequest runs init -> layout, build and bake for 50 tiles across all 12 zones (forceZone rotation),
// plus the tower and leak test scenes. The worker boundary is simulated: every response goes through
// structuredClone(res, { transfer }) before the next request; after each layout response a build of a tile of the
// SAME chunk runs on the SAME HandlerState and must equal a fresh-state build (catches transferred/detached LRU
// buffers); no transferred buffer may be referenced by HandlerState. Every payload passes validate*.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TileKey } from '../../src/core/grid.ts';
import { tileKeyStr } from '../../src/core/grid.ts';
import { ZONE_COUNT, ZONE_NAMES, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { bakeQualityOf, QUALITY } from '../../src/core/quality.ts';
import type { HandlerResult, WorkerInit, WorkerRequest, WorkerResponse } from '../../src/core/worker.ts';
import type { TestSceneId } from '../../src/core/world.ts';
import { createHandlerState, handleRequest, handlerCachesOf, type HandlerState } from '../../src/workers/handler.ts';
import { validateBake, validateBuild, validateLayoutPayload } from '../../src/workers/validatePayload.ts';

// ---------------------------------------------------------------- helpers

function makeInit(o: { forceZone?: ZoneId | null; testScene?: TestSceneId | null; quality: 'medium' | 'high'; seed?: number }): WorkerInit {
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
function send(run: Run, req: WorkerRequest): WorkerResponse {
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

function newRun(init: WorkerInit): Run {
  const run: Run = { st: createHandlerState(), bakeMs: [], buildMs: [], tiles: 0, chartHash: new Map() };
  const res = send(run, { t: 'init', job: 1, init });
  expect(res.t).toBe('ready');
  return run;
}

let jobId = 100;

function layoutStep(run: Run, init: WorkerInit, s: StoreyId, cx: number, cz: number): void {
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

function tileStep(run: Run, key: TileKey): void {
  const b = send(run, { t: 'build', job: ++jobId, key });
  expect(b.t).toBe('build');
  if (b.t !== 'build') return;
  expect(validateBuild(b.mesh, b.lightmap), `build ${tileKeyStr(key)}`).toEqual([]);
  expect(b.mesh.tileKey).toBe(tileKeyStr(key));
  run.buildMs.push(b.ms.gen + b.ms.mesh + b.ms.bake);
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

const stats = { tiles: 0, bakeMs: [] as number[], buildMs: [] as number[] };
function collect(run: Run): void {
  stats.tiles += run.tiles;
  stats.bakeMs.push(...run.bakeMs);
  stats.buildMs.push(...run.buildMs);
}

// ---------------------------------------------------------------- the gate

const TIMEOUT = 30 * 60 * 1000; // real full bakes: ~0.5 s per tile per core

describe('worker pipeline (Node, handleRequest)', () => {
  it('rejects work before init and reports errors as responses', () => {
    const st = createHandlerState();
    const r = handleRequest({ t: 'layout', job: 5, key: { s: 0, cx: 0, cz: 0 } }, st);
    expect(r.res.t).toBe('error');
    expect(r.res.job).toBe(5);
    expect(r.transfer).toEqual([]);
  });

  it('50 tiles across all 12 zones: layout, build, bake through structuredClone(res, { transfer })', () => {
    let extra = 2; // 12 zones x 4 tiles + 2 = 50
    for (let z = 0; z < ZONE_COUNT; z++) {
      const zone = z as ZoneId;
      const init = makeInit({ forceZone: zone, quality: z % 2 === 0 ? 'high' : 'medium' });
      const run = newRun(init);
      const s: StoreyId = zone === 7 ? 2 : zone >= 8 ? 1 : 0;
      const cx = z - 6, cz = ((z * 7) % 5) - 2;
      layoutStep(run, init, s, cx, cz);
      for (let q = 0; q < 4; q++) tileStep(run, { s, cx, cz, q: q as 0 | 1 | 2 | 3 });
      if (extra > 0 && (z === 0 || z === 7)) {
        // a tile of the neighbouring chunk (warm LRU / bake cache on the same state)
        tileStep(run, { s, cx: cx + 1, cz, q: 0 });
        extra--;
      }
      expect(run.tiles, `zone ${ZONE_NAMES[z]}`).toBeGreaterThanOrEqual(4);
      collect(run);
    }
    expect(stats.tiles).toBe(50);
  }, TIMEOUT);

  it('test scenes: tower and leak', () => {
    for (const scene of ['tower', 'leak'] as TestSceneId[]) {
      const init = makeInit({ testScene: scene, quality: 'high' });
      const run = newRun(init);
      layoutStep(run, init, 0, 0, 0);
      for (let q = 0; q < 4; q++) tileStep(run, { s: 0, cx: 0, cz: 0, q: q as 0 | 1 | 2 | 3 });
      if (scene === 'tower') {
        // the storey below sees the same periodic tower
        layoutStep(run, init, 1, 0, 0);
        tileStep(run, { s: 1, cx: 0, cz: 0, q: 0 });
      }
      collect(run);
    }
  }, TIMEOUT);

  it('find / spawn / ascii round-trip the boundary', () => {
    const run = newRun(makeInit({ quality: 'medium' }));
    const sp = send(run, { t: 'spawn', job: ++jobId, s: 0 });
    expect(sp.t).toBe('spawn');
    if (sp.t === 'spawn') expect(Number.isFinite(sp.result.x) && Number.isFinite(sp.result.z)).toBe(true);
    const f = send(run, { t: 'find', job: ++jobId, query: 'spawn', from: { s: 0, x: 0, z: 0 }, maxChunks: 4 });
    expect(f.t).toBe('find');
    const a = send(run, { t: 'ascii', job: ++jobId, s: 0, cx0: -1, cz0: -1, cx1: 0, cz1: 0 });
    expect(a.t).toBe('ascii');
    if (a.t === 'ascii') expect(typeof a.text).toBe('string');
  });

  it('logs bench numbers', () => {
    const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const p95 = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : 0);
    console.log(`[pipeline] tiles ${stats.tiles}; full bake mean ${mean(stats.bakeMs).toFixed(1)} ms, p95 ${p95(stats.bakeMs).toFixed(1)} ms; ` +
      `build (gen+mesh+preview) mean ${mean(stats.buildMs).toFixed(1)} ms, p95 ${p95(stats.buildMs).toFixed(1)} ms`);
    expect(stats.tiles).toBeGreaterThanOrEqual(50);
  });
});
