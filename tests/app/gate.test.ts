// tests/app/gate.test.ts — the automation ready gate v2 (src/app/loop.ts): the stream condition and the settle state
// machine, a pure function of (capture ready, uploads, atlas pending, probe settled, exposure settled).

import { describe, expect, it } from 'vitest';
import {
  createSettle, QUIET_FRAMES, READY_FRAMES, SETTLE_MAX_FRAMES, settleStep, streamReadyFor, type GateStream, type SettleInput,
} from '../../src/app/loop.ts';

const calm: SettleInput = { captureReady: true, uploads: 0, atlasPending: 0, probeSettled: true, exposureSettled: false };

describe('stream condition', () => {
  const stream = (ring1: boolean, ring1Full: boolean, capture?: boolean): GateStream => ({
    isReady: (_r, full) => (full ? ring1Full : ring1),
    isReadyNear: () => true,
    ...(capture === undefined ? {} : { isCaptureReady: () => capture }),
  });

  it("bake=full waits for the capture set when the streamer has one, else for ring 1 fully baked", () => {
    expect(streamReadyFor('full', stream(true, true, false))).toEqual({ pre: true, full: false });
    expect(streamReadyFor('full', stream(true, false, true))).toEqual({ pre: true, full: true });
    expect(streamReadyFor('full', stream(false, true, true))).toEqual({ pre: false, full: false });
    expect(streamReadyFor('full', stream(true, false))).toEqual({ pre: true, full: false });
    expect(streamReadyFor('full', stream(true, true))).toEqual({ pre: true, full: true });
  });

  it('players keep the near / in-view preview gate and READY_FRAMES = 10', () => {
    expect(streamReadyFor('interactive', stream(false, false, false))).toEqual({ pre: true, full: true });
    expect(READY_FRAMES).toBe(10);
  });
});

describe('settle state machine', () => {
  const run = (inputs: SettleInput[]): string[] => {
    const s = createSettle();
    return inputs.map((i) => settleStep(s, i));
  };

  it('QUIET_FRAMES calm frames, then snap; ready once the exposure readings are applied on calm frames', () => {
    const steps = run([calm, calm, calm, calm, calm, { ...calm, exposureSettled: true }]);
    expect(QUIET_FRAMES).toBe(3);
    expect(steps).toEqual(['wait', 'wait', 'snap', 'wait', 'wait', 'ready']);
  });

  it('every condition breaks the calm: uploads, atlas slots, the probe, an incomplete capture set', () => {
    for (const bad of [{ uploads: 1 }, { atlasPending: 2 }, { probeSettled: false }, { captureReady: false }]) {
      const steps = run([calm, calm, { ...calm, ...bad }, calm, calm, calm]);
      expect(steps, JSON.stringify(bad)).toEqual(['wait', 'wait', 'wait', 'wait', 'wait', 'snap']);
    }
  });

  it('a stale exposure-settled flag before the snap does not count', () => {
    const steps = run([{ ...calm, exposureSettled: true }, { ...calm, exposureSettled: true }, { ...calm, exposureSettled: true }]);
    expect(steps).toEqual(['wait', 'wait', 'snap']);
  });

  it('a late upload while the exposure settles starts the quiet count over and snaps again', () => {
    const steps = run([calm, calm, calm, { ...calm, uploads: 1 }, calm, calm, calm, { ...calm, exposureSettled: true }]);
    expect(steps).toEqual(['wait', 'wait', 'snap', 'wait', 'wait', 'wait', 'snap', 'ready']);
  });

  it(`gives up after SETTLE_MAX_FRAMES (${SETTLE_MAX_FRAMES}) frames`, () => {
    const s = createSettle();
    let last = '';
    for (let i = 0; i < SETTLE_MAX_FRAMES; i++) last = settleStep(s, { ...calm, uploads: 1 });
    expect(last).toBe('timeout');
  });
});
