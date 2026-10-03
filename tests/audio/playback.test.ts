import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import { EmitterKind } from '../../src/core/ids.ts';
import { Rng } from '../../src/core/rng.ts';
import type { EmitterRef, WorldQuery } from '../../src/core/runtime.ts';
import { Emitters } from '../../src/audio/emitters.ts';
import type { AudioEnv } from '../../src/audio/env.ts';
import { OneShots } from '../../src/audio/oneShots.ts';
import { Spatializer } from '../../src/audio/spatial.ts';
import { stopSource } from '../../src/audio/voice.ts';
import { MockContext } from './webaudioMock.ts';

function setup() {
  const ctx = new MockContext();
  const bus = ctx.createGain();
  const buffer = ctx.createBuffer(1, 48000, 48000);
  const rates = new Set<AudioParam>();
  const spatial = new Spatializer();
  const env = {
    ctx, spatial, rng: new Rng(1), mains: 60, lx: 0, ly: 1.6, lz: 0, hrtf: false, log: () => {},
    bank: { ensure: () => buffer, get: () => buffer, request: () => Promise.resolve(buffer) },
    graph: {
      buses: { sfx: bus, amb: bus, water: bus, foley: bus }, tapeSilent: false,
      registerRate: (param: AudioParam) => { rates.add(param); return { param, base: 1 }; },
      unregisterRate: (entry: { param: AudioParam } | null) => { if (entry) rates.delete(entry.param); },
    },
  } as unknown as AudioEnv;
  return { ctx, bus, buffer, rates, spatial, env };
}

function emitterWorld(storey: number, kind: typeof EmitterKind.RADIO | typeof EmitterKind.PHONE, positions: number[]): WorldQuery {
  const refs = positions.map((x, seed): EmitterRef => ({ e: { kind, x, y: 0.8, z: 0, gain: 1, seed }, wx: x, wy: 0.8, wz: 0 }));
  return {
    storey, cellWalkable: () => true, edgeSound: () => 1, losClear: () => true,
    emittersNear(x: number, z: number, r: number, out: EmitterRef[]) {
      out.length = 0;
      out.push(...refs.filter((ref) => Math.hypot(ref.wx - x, ref.wz - z) <= r));
      return out.length;
    },
  } as unknown as WorldQuery;
}

describe('audio playback cleanup', () => {
  it('preserves source cleanup when a stop is scheduled for later', () => {
    const { ctx, bus, buffer } = setup();
    const gain = ctx.createGain();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain).connect(bus);
    src.start(ctx.currentTime);
    src.onended = () => gain.disconnect();
    stopSource(src as unknown as AudioBufferSourceNode, ctx.currentTime + 0.25);
    ctx.advance(0.5);
    expect(bus.connected).toBe(0);
    expect(src.outs.size).toBe(0);
  });

  it('stops active and future flat one-shots on reset and frees their nodes and rate handles', () => {
    const { ctx, bus, rates, env } = setup();
    const shots = new OneShots(env);
    const req = OneShots.oneShotReq('elevatorMotor', 0);
    expect(shots.playFlat(req, 1, 'sfx')).toBe(true);
    expect(shots.playFlat(req, 1, 'sfx', 0, 1, ctx.currentTime + 2)).toBe(true);
    const sources = [...ctx.sources];
    expect(rates.size).toBe(2);
    expect(bus.connected).toBe(2);
    shots.stopAll();
    expect(sources.every((src) => src.stopped >= 0)).toBe(true);
    expect(rates.size).toBe(0);
    expect(bus.connected).toBe(0);
    ctx.advance(3);
    expect(bus.connected).toBe(0);
    shots.stopAll();
  });

  it('disconnects the gain node of an emitter after its source stops', () => {
    const { ctx, env, spatial } = setup();
    const world = emitterWorld(0, EmitterKind.RADIO, [5]);
    spatial.update(world);
    const emitters = new Emitters(env);
    emitters.update(world);
    const src = [...ctx.sources][0];
    const gain = [...src.outs][0];
    emitters.stopAll(0.1);
    ctx.advance(0.2);
    expect(src.outs.size).toBe(0);
    expect(gain.outs.size).toBe(0);
  });

  it('disconnects a pending radio station when it is stopped before its buffer arrives', async () => {
    const { ctx, env, spatial, buffer } = setup();
    const world = emitterWorld(0, EmitterKind.RADIO, [5]);
    spatial.update(world);
    const emitters = new Emitters(env);
    emitters.update(world);
    let deliver!: (buffer: AudioBuffer) => void;
    env.bank.get = () => null;
    env.bank.request = () => new Promise((resolve) => { deliver = resolve; });
    const gains: ReturnType<MockContext['createGain']>[] = [];
    const createGain = ctx.createGain.bind(ctx);
    ctx.createGain = () => { const gain = createGain(); gains.push(gain); return gain; };
    expect(emitters.cycleRadio(5, 0, 1)).toBe('tune');
    expect(gains[0].outs.size).toBe(1);
    emitters.stopAll(0.05);
    expect(gains[0].outs.size).toBe(0);
    const starts = ctx.starts;
    deliver(buffer as unknown as AudioBuffer);
    await Promise.resolve();
    expect(ctx.starts).toBe(starts);
    ctx.advance(1);
  });
});

describe('audio emitter interactions', () => {
  it('tunes the nearest radio even when its voice is outside the eight-slot pool', () => {
    const { ctx, env, spatial } = setup();
    const world = emitterWorld(0, EmitterKind.RADIO, [1, 2, 3, 4, 5, 6, 7, 19, 20]);
    spatial.update(world);
    const emitters = new Emitters(env);
    emitters.update(world);
    expect(emitters.activeCount).toBe(8);
    const sources = [...ctx.sources];
    expect(emitters.cycleRadio(20, 0, 4)).toBe('tune');
    expect(sources.every((src) => src.stopped < 0)).toBe(true);
    emitters.stopAll(0);
    ctx.advance(1);
  });

  it('silences the nearest unvoiced phone without silencing a farther voiced phone', () => {
    const { ctx, env, spatial } = setup();
    const world = emitterWorld(0, EmitterKind.PHONE, [4, 5, 6, 7, 8, 9, 10, 19, 20]);
    spatial.update(world);
    const emitters = new Emitters(env);
    emitters.update(world);
    expect(emitters.activeCount).toBe(8);
    const sources = [...ctx.sources];
    emitters.silenceNearest(EmitterKind.PHONE, 20, 0, 4);
    expect(sources.every((src) => src.stopped < 0)).toBe(true);
    emitters.stopAll(0);
    ctx.advance(1);
  });

  it('keeps radio interaction state separate between storeys', () => {
    const { ctx, env, spatial } = setup();
    const emitters = new Emitters(env);
    const first = emitterWorld(0, EmitterKind.RADIO, [5]);
    spatial.update(first);
    emitters.update(first);
    expect(emitters.cycleRadio(5, 0, 1)).toBe('tune');
    expect(emitters.cycleRadio(5, 0, 1)).toBe('tune');
    expect(emitters.cycleRadio(5, 0, 1)).toBe('tune');
    expect(emitters.cycleRadio(5, 0, 1)).toBe('off');
    const second = emitterWorld(1, EmitterKind.RADIO, [5]);
    spatial.update(second);
    emitters.update(second);
    expect(emitters.activeCount).toBe(1);
    expect(emitters.cycleRadio(5, 0, 1)).toBe('tune');
    spatial.update(first);
    emitters.update(first);
    expect(emitters.activeCount).toBe(0);
    expect(emitters.cycleRadio(5, 0, 1)).toBe('on');
    emitters.stopAll(0);
    ctx.advance(1);
  });
});

describe('moving audio sources', () => {
  it('follows an open edge instead of crossing a wall into a reachable cell', () => {
    const spatial = new Spatializer();
    const world = {
      cellWalkable: (x: number, z: number) => x >= 0 && x <= 2 && z >= 0 && z <= 1,
      edgeSound: (axis: string, x: number, z: number) => axis === 'x' && x === 2 && z === 0 ? 0 : 1,
      losClear: () => false,
    } as unknown as WorldQuery;
    spatial.setListener(CELL / 2, 1.6, CELL / 2);
    spatial.update(world);
    const cell: [number, number] = [CELL * 1.5, CELL / 2];
    expect(spatial.stepAway(new Rng(1), cell)).toBe(true);
    expect(cell).toEqual([CELL * 1.5, CELL * 1.5]);
  });
});
