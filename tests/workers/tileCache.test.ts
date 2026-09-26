// tests/workers/tileCache.test.ts — the worker result cache of tool runs: the entry codec and the code hash that
// keys it (src/workers/tileCache.ts, tools/viteTileCache.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bakeQualityOf, QUALITY } from '../../src/core/quality.ts';
import { createHandlerState, handleRequest } from '../../src/workers/handler.ts';
import { buffersOf, decodeEntry, encodeEntry } from '../../src/workers/tileCache.ts';
import { workerCodeHash } from '../../tools/viteTileCache.ts';

describe('cache entry codec', () => {
  it('round-trips a real build response exactly, typed arrays in their own buffers', () => {
    const st = createHandlerState();
    handleRequest({ t: 'init', job: 1, init: {
      opts: { seed: 3, seedText: '3', forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' },
      bake: bakeQualityOf(QUALITY.low), bakeTerm: 'all', validate: false,
    } }, st);
    const { res } = handleRequest({ t: 'build', job: 2, key: { s: 0, cx: 0, cz: 0, q: 0 } }, st);
    const back = decodeEntry(encodeEntry(res));
    expect(back).toEqual(res);
    if (res.t !== 'build') throw new Error(res.t);
    const b = back as typeof res;
    expect(b.lightmap.irr).toBeInstanceOf(Uint16Array);
    expect(b.mesh.shell?.position).toBeInstanceOf(Float32Array);
    const bufs = buffersOf(b);
    expect(new Set(bufs).size).toBe(bufs.length); // no shared buffers: every array transfers on its own
  });

  it('keeps non-finite numbers, nulls and nested arrays', () => {
    const v = { a: NaN, b: [Infinity, -Infinity, 0, -1.5], c: null, d: { e: new Int8Array([-1, 2]), f: 'x', g: true } };
    const back = decodeEntry(encodeEntry(v)) as typeof v;
    expect(Number.isNaN(back.a)).toBe(true);
    expect(back.b).toEqual([Infinity, -Infinity, 0, -1.5]);
    expect(back.c).toBeNull();
    expect(Array.from(back.d.e)).toEqual([-1, 2]);
    expect(back.d.f).toBe('x');
  });
});

describe('worker code hash', () => {
  it('covers the whole worker graph of this repository', () => {
    const h = workerCodeHash(path.resolve(import.meta.dirname, '../..'));
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it('follows value imports, ignores erased type-only imports, and changes with any reached file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'br-hash-'));
    try {
      mkdirSync(path.join(root, 'src/workers'), { recursive: true });
      const w = (f: string, s: string): void => writeFileSync(path.join(root, f), s);
      w('src/workers/chunk.worker.ts', "import { a } from './a.ts';\nimport type { T } from './types.ts';\nexport const x = a;\n");
      w('src/workers/a.ts', "import { b } from './b.ts';\nexport const a = b + 1;\n");
      w('src/workers/b.ts', 'export const b = 1;\n');
      w('src/workers/types.ts', 'export type T = number;\n');
      const h0 = workerCodeHash(root);
      w('src/workers/types.ts', 'export type T = string;\n');
      expect(workerCodeHash(root)).toBe(h0);
      w('src/workers/b.ts', 'export const b = 2;\n');
      expect(workerCodeHash(root)).not.toBe(h0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
