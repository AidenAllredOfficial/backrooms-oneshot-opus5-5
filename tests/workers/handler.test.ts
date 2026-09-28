// tests/workers/handler.test.ts (WP10) — handler dispatch, LRU, transfer rules, validation errors.

import { describe, expect, it } from 'vitest';
import { bakeQualityOf, QUALITY } from '../../src/core/quality.ts';
import type { WorkerInit } from '../../src/core/worker.ts';
import { createHandlerState, handleRequest } from '../../src/workers/handler.ts';
import { getLayout, LAYOUT_LRU_SIZE } from '../../src/workers/layoutCache.ts';

const init = (validate = true): WorkerInit => ({
  opts: { seed: 3, seedText: '3', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
  bake: bakeQualityOf(QUALITY.medium), bakeTerm: 'all', validate,
});

describe('handleRequest', () => {
  it('init answers ready and clears the caches', () => {
    const st = createHandlerState();
    expect(handleRequest({ t: 'init', job: 1, init: init() }, st).res).toEqual({ t: 'ready', job: 1 });
    handleRequest({ t: 'layout', job: 2, key: { s: 0, cx: 0, cz: 0 } }, st);
    expect(st.layouts.size).toBe(1);
    handleRequest({ t: 'init', job: 3, init: init() }, st);
    expect(st.layouts.size).toBe(0);
    expect(st.gen).not.toBe(null);
  });

  it('layout responds with a clone of the LRU entry and never transfers LRU buffers', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const { res, transfer } = handleRequest({ t: 'layout', job: 2, key: { s: 0, cx: 4, cz: -3 } }, st);
    expect(res.t).toBe('layout');
    if (res.t !== 'layout') return;
    const lru = st.layouts.get('0:4:-3');
    expect(lru).toBeDefined();
    expect(res.layout).not.toBe(lru);
    expect(res.layout.flags).not.toBe(lru?.flags);
    expect(Array.from(res.layout.floorCm)).toEqual(Array.from(lru?.floorCm ?? []));
    const lruBufs = new Set([lru?.flags.buffer, lru?.floorCm.buffer, lru?.ex.kind.buffer, lru?.wallMat.buffer, lru?.trimMat.buffer]);
    for (const b of transfer) expect(lruBufs.has(b)).toBe(false);
    // wallMat / trimMat (accepted contract change) travel with the layout
    expect(transfer).toContain(res.layout.wallMat.buffer);
    expect(transfer).toContain(res.layout.trimMat.buffer);
    expect(transfer).toContain(res.collision.cellStart.buffer);
    expect(new Set(transfer).size).toBe(transfer.length);
    structuredClone(res, { transfer }); // detaches the clone only
    expect(lru?.flags.byteLength).toBe(1024 * 2);
  });

  it('build and bake answer with the job id and matching atlases', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const b = handleRequest({ t: 'build', job: 7, key: { s: 0, cx: 0, cz: 0, q: 1 } }, st).res;
    const f = handleRequest({ t: 'bake', job: 8, key: { s: 0, cx: 0, cz: 0, q: 1 } }, st).res;
    expect(b.job).toBe(7);
    expect(f.job).toBe(8);
    if (b.t !== 'build' || f.t !== 'bake') throw new Error(`unexpected ${b.t} / ${f.t}: ${JSON.stringify(b).slice(0, 300)}`);
    expect(b.lightmap.variant).toBe('preview');
    expect(f.lightmap.variant).toBe('full');
    expect(f.lightmap.chartHash).toBe(b.mesh.atlas.chartHash);
    expect(st.layouts.size).toBe(9); // the 3x3 neighbourhood went through the LRU
  });

  it("a build with lighting 'full' returns exactly the bake job's full lightmap (the automation gate's ring)", () => {
    const key = { s: 0 as const, cx: 0, cz: 0, q: 2 as const };
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const b = handleRequest({ t: 'build', job: 2, key, lighting: 'full' }, st).res;
    // a fresh worker state: the bake cache must not be what makes the two agree
    const st2 = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st2);
    handleRequest({ t: 'build', job: 2, key }, st2);
    const f = handleRequest({ t: 'bake', job: 3, key }, st2).res;
    if (b.t !== 'build' || f.t !== 'bake') throw new Error(`unexpected ${b.t} / ${f.t}`);
    expect(b.lightmap.variant).toBe('full');
    // every field the streamer uploads: the tool cache answers a 'bake' miss with the 'build lighting:full' entry
    // (src/workers/tileCache.ts cacheLookup), so the two must be the same bytes
    for (const k of ['variant', 'width', 'height', 'chartHash', 'tileKey'] as const) expect(b.lightmap[k], k).toBe(f.lightmap[k]);
    const same = (x: ArrayLike<number> | null, y: ArrayLike<number> | null, k: string): void => {
      expect(x === null, `${k} null`).toBe(y === null);
      if (x === null || y === null) return;
      expect(x.constructor, k).toBe(y.constructor);
      expect(x.length, k).toBe(y.length);
      let diff = -1;
      for (let i = 0; i < x.length && diff < 0; i++) if (x[i] !== y[i] && !(Number.isNaN(x[i]) && Number.isNaN(y[i]))) diff = i;
      expect(diff, `${k}: first differing element`).toBe(-1);
    };
    for (const k of ['irr', 'dir', 'mask', 'flick', 'emission'] as const) same(b.lightmap[k], f.lightmap[k], k);
    for (const k of ['a', 'b', 'c', 'wallMask'] as const) same(b.lightmap.volume[k], f.lightmap.volume[k], `volume.${k}`);
  });

  it('the layout LRU is bounded (96) and refreshes recency on hits', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const gen = st.gen;
    if (!gen) throw new Error('no gen');
    const first = getLayout(st.layouts, gen, { s: 0, cx: 0, cz: 0 });
    for (let i = 1; i < LAYOUT_LRU_SIZE; i++) getLayout(st.layouts, gen, { s: 0, cx: i, cz: 0 });
    expect(getLayout(st.layouts, gen, { s: 0, cx: 0, cz: 0 })).toBe(first); // hit: now most recent
    getLayout(st.layouts, gen, { s: 0, cx: 500, cz: 0 }); // evicts (1, 0), not (0, 0)
    expect(st.layouts.size).toBe(LAYOUT_LRU_SIZE);
    expect(st.layouts.has('0:0:0')).toBe(true);
    expect(st.layouts.has('0:1:0')).toBe(false);
  });

  it('errors (bad requests, validation failures) become error responses with the job id', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: init() }, st);
    const r = handleRequest({ t: 'bogus', job: 9 } as never, st);
    expect(r.res.t).toBe('error');
    expect(r.res.job).toBe(9);
    if (r.res.t === 'error') expect(r.res.message).toMatch(/unknown request type/);
  });
});
