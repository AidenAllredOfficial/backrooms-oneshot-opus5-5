// tests/materials/waterVisibility.test.ts — the perf pass's water occlusion tracker (materials/water/waterVisibility.ts)
// and the planar reflection's gate on it (materials/PlanarReflection.ts mirrorWaterOnly), with a fake GL whose
// queries resolve when the test says so.

import { describe, expect, it } from 'vitest';
import { QUALITY } from '../../src/core/quality.ts';
import { mirrorWaterOnly } from '../../src/materials/PlanarReflection.ts';
import { createWaterVisibility, WATER_VIS_TUNE, type QueryGl } from '../../src/materials/water/waterVisibility.ts';

interface FakeQuery { samples: boolean; ready: boolean }

function fakeGl(): QueryGl & { queries: FakeQuery[]; active: FakeQuery | null; drawVisible: boolean; resolveAll(): void } {
  const gl = {
    ANY_SAMPLES_PASSED_CONSERVATIVE: 1, QUERY_RESULT_AVAILABLE: 2, QUERY_RESULT: 3,
    queries: [] as FakeQuery[], active: null as FakeQuery | null, drawVisible: false,
    createQuery() { const q = { samples: false, ready: false }; gl.queries.push(q); return q as unknown as WebGLQuery; },
    beginQuery(_t: number, q: WebGLQuery) { gl.active = q as unknown as FakeQuery; gl.active.ready = false; gl.active.samples = false; },
    endQuery() { if (gl.active) gl.active.samples = gl.drawVisible; gl.active = null; },
    getQueryParameter(q: WebGLQuery, p: number) { const f = q as unknown as FakeQuery; return p === 2 ? f.ready : f.samples; },
    resolveAll() { for (const q of gl.queries) q.ready = true; },
  };
  return gl;
}

describe('water visibility', () => {
  it('reports water only after a query with samples resolves, and holds it for HOLD_MS', () => {
    let t = 1000;
    const v = createWaterVisibility(() => t);
    const gl = fakeGl();
    v.enabled = true;
    expect(v.poll(gl)).toBe(false); // nothing seen yet
    gl.drawVisible = true;
    v.before(gl);
    v.after(gl);
    expect(v.pending).toBe(1);
    t += 5;
    expect(v.poll(gl)).toBe(false); // not resolved yet: the last known state
    gl.resolveAll();
    t += 5;
    expect(v.poll(gl)).toBe(true);
    expect(v.pending).toBe(0);
    t += WATER_VIS_TUNE.HOLD_MS - 20;
    expect(v.poll(gl)).toBe(true);
    t += 40;
    expect(v.poll(gl)).toBe(false);
  });

  it('occluded draws never count; the query objects are reused', () => {
    let t = 0;
    const v = createWaterVisibility(() => t);
    const gl = fakeGl();
    v.enabled = true;
    for (let i = 0; i < 10; i++) {
      v.before(gl);
      v.after(gl);
      gl.resolveAll();
      t += 16;
      expect(v.poll(gl)).toBe(false);
    }
    expect(gl.queries.length).toBe(1);
  });

  it('an overdue result counts as visible; disabled trackers issue nothing; the pending list is capped', () => {
    let t = 0;
    const v = createWaterVisibility(() => t);
    const gl = fakeGl();
    v.before(gl);
    v.after(gl);
    expect(v.pending).toBe(0); // disabled
    v.enabled = true;
    for (let i = 0; i < WATER_VIS_TUNE.MAX_PENDING + 10; i++) { v.before(gl); v.after(gl); }
    expect(v.pending).toBe(WATER_VIS_TUNE.MAX_PENDING);
    t += WATER_VIS_TUNE.OVERDUE_MS + 1;
    expect(v.poll(gl)).toBe(true);
    v.reset();
    gl.resolveAll();
    expect(v.poll(gl)).toBe(false); // resolved without samples, after the reset
  });

  it('gates the mirror only where the floors cannot read it', () => {
    expect(mirrorWaterOnly(QUALITY.low)).toBe(false);
    expect(mirrorWaterOnly(QUALITY.medium)).toBe(false);
    expect(mirrorWaterOnly(QUALITY.high)).toBe(true);
    expect(mirrorWaterOnly(QUALITY.ultra)).toBe(true);
  });
});
