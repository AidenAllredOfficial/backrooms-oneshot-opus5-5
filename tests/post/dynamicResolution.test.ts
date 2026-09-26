import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import type { PostStack } from '../../src/core/runtime.ts';
import { createDynamicResolution, createScaleController, DYNRES, maxScaleFor, MAX_PIXEL_RATIO } from '../../src/post/DynamicResolution.ts';

type Ctl = ReturnType<typeof createScaleController>;

/** Feed `seconds` of frames; `frame(i)` gives [interval, cpu, gpu|null]. Returns every scale change. */
function run(c: Ctl, seconds: number, frame: (i: number) => [number, number, number | null]): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; t < seconds * 1000; i++) {
    const [ms, cpu, gpu] = frame(i);
    t += ms;
    const r = c.push(ms, cpu, gpu);
    if (!Number.isNaN(r)) out.push(r);
  }
  return out;
}

describe('dynamic resolution: cost relative to the display refresh (R2 B9)', () => {
  it('a 50 Hz display (20 ms intervals) with a 1.5 ms GPU keeps scale 1.0', () => {
    const c = createScaleController(1);
    expect(run(c, 30, () => [20, 2, 1.5])).toEqual([]);
    expect(c.scale).toBe(1);
    expect(c.refreshMs).toBeGreaterThan(17);
  });

  it('a 30 fps throttle (33 ms intervals) with a 1.5 ms GPU keeps scale 1.0', () => {
    const c = createScaleController(1);
    expect(run(c, 30, () => [33.3, 2, 1.5])).toEqual([]);
    expect(c.scale).toBe(1);
  });

  it('without a GPU timer, throttled intervals with a light main thread keep scale 1.0', () => {
    for (const iv of [20, 33.3]) {
      const c = createScaleController(1);
      expect(run(c, 30, () => [iv, 2, null])).toEqual([]);
    }
  });

  it('a GPU-bound stretch at 60 Hz scales down, then recovers to the preset', () => {
    const c = createScaleController(1);
    run(c, 4, () => [16.7, 2, 1.5]); // establishes the 60 Hz refresh
    const downs = run(c, 12, () => [16.7, 2, 15.5]); // 15.5 ms > 0.85 x 16.7
    expect(downs.length).toBeGreaterThan(2);
    expect(downs[0]).toBe(0.9);
    expect(c.scale).toBeLessThan(0.8);
    const ups = run(c, 40, () => [16.7, 2, 6]); // 6 ms < 0.55 x 16.7: recovers (a downclocked GPU reads high, still < 9.2)
    expect(ups[ups.length - 1]).toBe(1);
    expect(c.scale).toBe(1);
  });

  it('a GPU so slow that it halves the frame rate at 60 Hz still scales down (the 60 Hz prior)', () => {
    const c = createScaleController(1);
    const downs = run(c, 6, () => [33.3, 3, 26]);
    expect(downs[0]).toBe(0.9);
  });

  it('holds between the thresholds (no oscillation)', () => {
    const c = createScaleController(1);
    run(c, 4, () => [16.7, 2, 1.5]);
    run(c, 12, () => [16.7, 2, 15.5]);
    const s = c.scale;
    expect(run(c, 20, () => [16.7, 2, 11])).toEqual([]); // 0.55 x 16.7 < 11 < 0.85 x 16.7
    expect(c.scale).toBe(s);
  });

  it('without a GPU timer, a CPU-bound slowdown scales down and recovers', () => {
    const c = createScaleController(1);
    run(c, 3, () => [16.7, 5, null]);
    const downs = run(c, 8, (i) => (i % 4 === 0 ? [16.7, 12, null] : [33.3, 14, null]));
    expect(downs[0]).toBe(0.9);
    const ups = run(c, 30, () => [16.7, 5, null]);
    expect(ups[ups.length - 1]).toBe(1);
  });

  it('the refresh estimate follows a real 30 Hz display up (slowly) and a faster one down (at once)', () => {
    const c = createScaleController(1);
    run(c, 20, () => [33.3, 2, 1.5]);
    expect(c.refreshMs).toBeGreaterThan(30);
    run(c, 2.5, () => [6.94, 1, 1]);
    expect(c.refreshMs).toBeCloseTo(DYNRES.REFRESH_MIN, 1);
  });

  it('supersampling presets range [MIN, renderScale]; the pixel-ratio cap bounds it on HiDPI', () => {
    const c = createScaleController(1.5);
    expect(c.scale).toBe(1.5);
    run(c, 30, () => [16.7, 2, 16]);
    expect(c.scale).toBe(DYNRES.MIN);
    expect(maxScaleFor({ maxDpr: 2, renderScale: 1.5 }, 1)).toBe(1.5);
    expect(maxScaleFor({ maxDpr: 2, renderScale: 1.5 }, 2)).toBe(MAX_PIXEL_RATIO / 2);
    expect(maxScaleFor({ maxDpr: 1.5, renderScale: 1 }, 3)).toBe(1); // no supersampling: never reduced by the cap
    c.setMax(1);
    expect(c.scale).toBeLessThanOrEqual(1);
  });

  it('missed vsyncs at a stable 60 Hz scale down even when the GPU timer reads low, and hold below the missed scale', () => {
    // ultra at 1.5x: timer 8.5 ms (half the 60 Hz interval: the GPU is busy), but ~1 frame in 9 takes two intervals
    // (compositor / resolve work the TIME_ELAPSED query does not see). Below DYNRES.MISS_GPU_MIN x refresh the misses
    // are not GPU load (see the idle-GPU test below).
    const c = createScaleController(1.5);
    run(c, 4, () => [16.7, 3, 8.5]);
    const miss = (i: number): [number, number, number | null] => (c.scale > 1.35 && i % 9 === 0 ? [33.4, 3, 8.5] : [16.7, 3, 8.5 * c.scale / 1.5]);
    let downs: number[] = [];
    for (let k = 0; k < 12; k++) downs = downs.concat(run(c, 2, miss));
    expect(downs[0]).toBe(1.4);
    // 1.5 and 1.4 miss; the cost rule alone would climb straight back to 1.5, the ceiling (1.4) stops it at 1.35
    expect(c.scale).toBeGreaterThanOrEqual(1.3);
    expect(c.scale).toBeLessThan(1.4);
    // later: at most a probe of 1.4 after the ceiling expires (it misses and holds twice as long), never back to 1.5
    const seen: number[] = [];
    for (let k = 0; k < 60; k++) seen.push(...run(c, 2, miss));
    expect(Math.max(...seen)).toBeLessThanOrEqual(1.4);
    expect(seen.filter((v) => v === 1.4).length).toBeLessThanOrEqual(3);
    expect(c.scale).toBeGreaterThanOrEqual(1.3);
  });

  it('missed-vsync detection ignores throttles and CPU stalls', () => {
    // 30 fps throttle: every interval doubles, p20 moves with it (not a stable display)
    const a = createScaleController(1.5);
    run(a, 4, () => [16.7, 2, 1.5]);
    expect(run(a, 30, () => [33.3, 2, 1.5])).toEqual([]);
    // the throttle starting mid-window (a 16.7 / 33.3 mix for one window) is not a miss either
    const a2 = createScaleController(1.5);
    run(a2, 3, () => [16.7, 2, 1.5]);
    expect(run(a2, 30, (i) => (i < 60 ? [16.7, 2, 1.5] : [33.3, 2, 1.5]))).toEqual([]);
    // a CPU-heavy stretch (streaming): the misses come with a busy main thread, fewer pixels would not help
    const b = createScaleController(1);
    run(b, 4, () => [16.7, 3, 2]);
    expect(run(b, 10, (i) => (i % 6 === 0 ? [33.4, 9, 2] : [16.7, 9, 2]))).toEqual([]);
  });

  it('missed vsyncs with an idle GPU (streaming hitches at 165 Hz on a fast GPU) keep the preset scale', () => {
    // RTX 5070 Ti, 165 Hz: GPU 1.5 of 6.06 ms; tile uploads / worker messages occasionally cost a frame
    const c = createScaleController(1);
    run(c, 4, () => [6.06, 1.2, 1.5]);
    expect(run(c, 20, (i) => (i % 8 === 0 ? [12.1, 1.5, 1.5] : [6.06, 1.2, 1.5]))).toEqual([]);
    expect(c.scale).toBe(1);
    expect(DYNRES.MISS_GPU_MIN * 6.06).toBeGreaterThan(1.5);
  });
});

describe('dynamic resolution: the resize happens before a frame is drawn (R3)', () => {
  it('update() only queues a new scale; beforeRender() applies it once', () => {
    // resizing the canvas clears its drawing buffer: a resize after the frame was drawn (the old step-12 apply)
    // presented that cleared buffer, a black frame on every scale change
    const calls: string[] = [];
    let pr = 1;
    const renderer = {
      getPixelRatio: () => pr,
      setPixelRatio: (v: number) => { pr = v; calls.push(`ratio ${v}`); },
      getSize: (v: THREE.Vector2) => v.set(1920, 1080),
    } as unknown as THREE.WebGLRenderer;
    const post = { setSize: (w: number, h: number) => calls.push(`size ${w}x${h}`), renderScale: 1 } as unknown as PostStack;
    const d = createDynamicResolution(post, renderer, { ...QUALITY.high, renderScale: 1, maxDpr: 1, dynamicResolution: true });
    expect(calls).toEqual([]);
    for (let i = 0; i < 240; i++) d.update(16.7, 2, 1.5); // establishes the 60 Hz refresh
    for (let i = 0; i < 360 && d.scale === 1; i++) d.update(16.7, 2, 15.5); // GPU-bound
    expect(d.scale).toBe(0.9);
    expect(calls).toEqual([]);
    d.beforeRender();
    expect(calls).toEqual(['ratio 0.9', 'size 1920x1080']);
    d.beforeRender();
    expect(calls.length).toBe(2);
  });
});

describe('fixed render scale', () => {
  it('corrects a stale boot DPR even when dynamic resolution is disabled', () => {
    let ratio = 1.5, resizes = 0;
    const renderer = {
      getPixelRatio: () => ratio,
      setPixelRatio: (r: number) => { ratio = r; },
      getSize: (v: THREE.Vector2) => v.set(1280, 800),
    } as unknown as THREE.WebGLRenderer;
    const post = { setSize: () => resizes++, get renderScale() { return ratio; } } as unknown as PostStack;
    const d = createDynamicResolution(post, renderer, { ...QUALITY.high, maxDpr: 1, renderScale: 1, dynamicResolution: false });
    expect(ratio).toBe(1);
    expect(resizes).toBe(1);
    for (let i = 0; i < 240; i++) { d.update(40, 30, 30); d.beforeRender(); }
    expect(ratio).toBe(1);
    expect(resizes).toBe(1);
  });
});
