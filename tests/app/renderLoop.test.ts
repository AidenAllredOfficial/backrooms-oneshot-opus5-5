import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createClock } from '../../src/app/clock.ts';
import { createFrameStats } from '../../src/app/perf.ts';
import { createLoop } from '../../src/app/loop.ts';
import type { AppCore } from '../../src/app/appState.ts';
import { createPlayerState } from '../../src/core/player.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';

function fixture() {
  const camera = new THREE.PerspectiveCamera();
  const state = createPlayerState(0, 0, 0, 0, 0, 0);
  const errors: unknown[] = [];
  const observed: { stage: string; x: number; matrixX: number }[] = [];
  const read = (stage: string): void => {
    observed.push({ stage, x: camera.position.x, matrixX: camera.matrixWorld.elements[12] });
  };
  const sys = {
    q: { dynamicResolution: false, planarReflectionScale: 0 },
    dynRes: { beforeRender() {} },
    input: { poll() {} },
    player: {
      state,
      update() { state.eyeX += 1; },
      applyToCamera(c: THREE.PerspectiveCamera) { c.position.x = state.eyeX; },
    },
    streamer: {
      query: { isLoaded: () => false, layoutAt: vi.fn((_cx: number, _cz: number): ChunkLayout | null => null) },
      update() { read('stream'); }, processUploads() {}, tiles: () => [],
    },
    lighting: { update() { read('lighting'); }, atmosphere: () => ({}), flashlight: { on: false } },
    anomaly: { update() {} },
    materials: { globals: { time: { value: 0 } } },
    features: { probe: false, bounce: false },
    ripples: { update() {} }, probe: { update() {} },
    reflection: { update() { throw new Error('mirror must render after the depth pass'); } },
    reflectionPlaneY: null as number | null,
    post: { setAtmosphere() {}, render() {} },
    audio: { update() {} },
  };
  const core = {
    sys, camera, renderer: { info: { reset() {} } }, clock: createClock(),
    frameStats: createFrameStats(), params: { bake: 'interactive' }, mode: 'play', frame: 0,
    gate: { active: false, tick() {} }, debug: { ready: true }, hooks: [],
    bus: { emit() {} }, fov: () => 60, fail: (e: unknown) => errors.push(e),
  } as unknown as AppCore;
  const loop = createLoop(core, () => {});
  return { core, sys, camera, state, errors, observed, step: () => loop(core.frame * 1000 / 60) };
}

function waterFixture() {
  const f = fixture();
  f.sys.player.update = () => {};
  f.sys.q.planarReflectionScale = 0.35;
  const water = { x0: 0, z0: 0, x1: 38.4, z1: 38.4, y: 0, floorY: -1, kind: 0 as const };
  const layout = { water: [water] } as ChunkLayout;
  f.sys.streamer.query.layoutAt.mockImplementation((cx, cz) => cx === 0 && cz === 0 ? layout : null);
  const planes: (number | null)[] = [];
  f.sys.post.render = () => { planes.push(f.sys.reflectionPlaneY); };
  return { ...f, water, planes };
}

describe('render loop camera ordering', () => {
  it('publishes this frame\'s pose and matrices before streaming and lighting during normal play', () => {
    const f = fixture();
    f.step();
    f.step();
    expect(f.errors).toEqual([]);
    expect(f.observed).toEqual([
      { stage: 'stream', x: 1, matrixX: 1 }, { stage: 'lighting', x: 1, matrixX: 1 },
      { stage: 'stream', x: 2, matrixX: 2 }, { stage: 'lighting', x: 2, matrixX: 2 },
    ]);
  });
});

describe('planar plane selection before post rendering', () => {
  it('keeps the six-frame scan cadence during ordinary movement', () => {
    const f = waterFixture();
    f.step();
    expect(f.planes).toEqual([0]);
    expect(f.sys.streamer.query.layoutAt).toHaveBeenCalledTimes(9);
    f.water.y = 0.2;
    for (let i = 0; i < 5; i++) { f.state.eyeX += 0.1; f.step(); }
    expect(f.planes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(f.sys.streamer.query.layoutAt).toHaveBeenCalledTimes(9);
    f.step();
    expect(f.planes.at(-1)).toBe(0.2);
    expect(f.sys.streamer.query.layoutAt).toHaveBeenCalledTimes(18);
    expect(f.errors).toEqual([]);
  });

  it.each(['storey', 'eyeX', 'eyeY', 'eyeZ', 'preset', 'scale'] as const)('refreshes immediately after a %s change', (change) => {
    const f = waterFixture();
    f.step();
    f.water.y = 0.2;
    if (change === 'storey') f.state.s = 1;
    else if (change === 'preset') f.sys.q = { ...f.sys.q };
    else if (change === 'scale') f.sys.q.planarReflectionScale = 0.5;
    else f.state[change] += 3.1;
    f.step(); // frame 1, before the next scheduled scan
    expect(f.planes).toEqual([0, 0.2]);
    expect(f.sys.streamer.query.layoutAt).toHaveBeenCalledTimes(18);
    expect(f.errors).toEqual([]);
  });

  it('selects a fresh plane when enabled and clears it immediately when disabled', () => {
    const f = waterFixture();
    f.sys.q.planarReflectionScale = 0;
    f.step();
    expect(f.planes).toEqual([null]);
    expect(f.sys.streamer.query.layoutAt).not.toHaveBeenCalled();
    f.sys.q.planarReflectionScale = 0.35;
    f.water.y = 0.4;
    f.step();
    expect(f.planes.at(-1)).toBe(0.4);
    f.sys.q.planarReflectionScale = 0;
    f.step();
    expect(f.planes.at(-1)).toBeNull();
    expect(f.sys.streamer.query.layoutAt).toHaveBeenCalledTimes(9);
    expect(f.errors).toEqual([]);
  });
});
