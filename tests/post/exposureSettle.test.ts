// tests/post/exposureSettle.test.ts — the auto-exposure meter's settle mode (src/post/AutoExposurePass.ts), which the
// automation ready gate uses (PostStack settleExposure): a reading every frame, and a reading already in flight when
// the settle starts is dropped, so every applied reading meters a frame rendered after the call.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AutoExposurePass, MEASURE_EVERY } from '../../src/post/AutoExposurePass.ts';
import { packLog2 } from '../../src/post/exposureMath.ts';

/** A renderer that records meter reads and lets the test resolve them (the async PBO readback). */
function fakeRenderer() {
  const reads: { px: Uint8Array; resolve(): void }[] = [];
  const r = {
    setRenderTarget() {},
    render() {},
    readRenderTargetPixelsAsync(_rt: unknown, _x: number, _y: number, _w: number, _h: number, px: Uint8Array) {
      return new Promise<void>((resolve) => { reads.push({ px, resolve }); });
    },
  };
  return { r: r as unknown as THREE.WebGLRenderer, reads };
}
const input = new THREE.WebGLRenderTarget(4, 4);
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
async function answer(read: { px: Uint8Array; resolve(): void }, log2: number): Promise<void> {
  const [hi, lo] = packLog2(log2);
  read.px[0] = hi; read.px[1] = lo;
  read.resolve();
  await flush();
}

describe('auto-exposure settle mode', () => {
  it(`reads every ${MEASURE_EVERY} frames normally, every frame while settling`, async () => {
    const ae = new AutoExposurePass();
    const { r, reads } = fakeRenderer();
    for (let f = 0; f < 3 * MEASURE_EVERY; f++) {
      ae.render(r, input);
      if (reads.length && f % MEASURE_EVERY === 0) await answer(reads[reads.length - 1], 2);
    }
    expect(reads.length).toBe(3);
    ae.settle(true);
    const n0 = reads.length;
    for (let f = 0; f < 5; f++) {
      ae.render(r, input);
      await answer(reads[reads.length - 1], 3);
    }
    expect(reads.length - n0).toBe(5);
    ae.settle(false);
    const n1 = reads.length;
    for (let f = 0; f < MEASURE_EVERY; f++) {
      ae.render(r, input);
      if (reads.length > n1) await answer(reads[reads.length - 1], 3);
    }
    expect(reads.length - n1).toBe(1);
    ae.dispose();
  });

  it('drops the reading in flight when the settle starts (it metered an older frame)', async () => {
    const ae = new AutoExposurePass();
    const { r, reads } = fakeRenderer();
    ae.render(r, input); // frame 1: a read goes out
    expect(reads.length).toBe(1);
    ae.settle(true);
    await answer(reads[0], 5); // arrives after the settle started: not applied
    expect(ae.measurements).toBe(0);
    ae.render(r, input);
    expect(reads.length).toBe(2);
    await answer(reads[1], -1);
    expect(ae.measurements).toBe(1);
    expect(ae.measuredLog2).toBeCloseTo(-1, 3);
    ae.dispose();
  });
});
