// tests/audio/engine.test.ts — drives the whole WP13 runtime (createAudioSystem) against a strict Web Audio mock and
// a synthetic room world under Node: start -> 'running', hum voices at lit fixtures, dead sectors silent, RT60 of a
// LOBBY-like carpet room < a PARKING-like concrete hall, flicker transients sample-aligned with flickerEvents, and
// every bus event handled without throwing / non-finite AudioParam values (the mock throws like the real API).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELLS } from '../../src/core/constants.ts';
import { EventBus, type GameEvents } from '../../src/core/events.ts';
import { flickerEvents, type FlickerEvent } from '../../src/core/flicker.ts';
import { CellFlag, EmitterKind, LandmarkKind, LightState, Mat, Mood, PropKind, SurfaceSound, Zone, type LightStateId, type MatId, type MoodId, type SurfaceSoundId, type ZoneId } from '../../src/core/ids.ts';
import { createEmptyLayout, fixtureSeed, type AudioEmitterSpec, type ChunkLayout, type Fixture } from '../../src/core/layout.ts';
import { createPlayerState, type PlayerState } from '../../src/core/player.ts';
import { QUALITY } from '../../src/core/quality.ts';
import type { AudioSystem, EmitterRef, FixtureRef, LightingRuntime, WorldQuery } from '../../src/core/runtime.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createAudioSystem } from '../../src/audio/AudioEngine.ts';
import type { AudioEnv } from '../../src/audio/env.ts';
import { Foley } from '../../src/audio/foley.ts';
import { AudioGraph, sliderGain } from '../../src/audio/graph.ts';
import { Voice } from '../../src/audio/voice.ts';
import { createResolution } from '../../src/audio/propagation.ts';
import { synthEmitter } from '../../src/audio/dsp/emitters.ts';
import { installWebAudioMock, MockBuffer, MockContext, MockNode, MockParam, MockSource } from './webaudioMock.ts';

interface RoomOpts {
  w: number; l: number; h: number; // cells, cells, metres
  zone: ZoneId; mood?: MoodId;
  floor: MatId; wall: MatId; ceil: MatId;
  fixtures: { x: number; z: number; state: LightStateId; dynamic?: boolean; id: number }[];
  emitters?: AudioEmitterSpec[];
  lockedExit?: boolean;
}

/** A rectangular room of w x l cells starting at the world origin (may span several chunks); SOLID elsewhere. */
function roomWorld(o: RoomOpts): WorldQuery {
  const W = o.w * CELL, L = o.l * CELL;
  const inside = (gi: number, gj: number): boolean => gi >= 0 && gj >= 0 && gi < o.w && gj < o.l;
  const layouts = new Map<string, ChunkLayout>();
  const fixtures: Fixture[] = o.fixtures.map((f) => ({
    id: f.id, kind: 0, state: f.state, shape: 0, px: f.x, py: o.h - 0.01, pz: f.z, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0,
    w: 1.2, h: 0.6, color: [1, 1, 1], luminance: 3300, seed: fixtureSeed(f.id), hum: 1, bakeGroup: 0, dynamic: !!f.dynamic,
  }));
  const layoutAt = (cx: number, cz: number): ChunkLayout | null => {
    if (cx < -1 || cz < -1 || cx > 2 || cz > 2) return null;
    const k = `${cx},${cz}`;
    let l = layouts.get(k);
    if (!l) {
      l = createEmptyLayout({ s: 0, cx, cz }, o.zone, 1, o.mood ?? Mood.NORMAL);
      for (let lj = 0; lj < CHUNK_CELLS; lj++) for (let li = 0; li < CHUNK_CELLS; li++) {
        const c = lj * CHUNK_CELLS + li;
        const gi = cx * CHUNK_CELLS + li, gj = cz * CHUNK_CELLS + lj;
        if (!inside(gi, gj)) { l.flags[c] = CellFlag.SOLID; continue; }
        l.floorMat[c] = o.floor; l.wallMat[c] = o.wall; l.ceilMat[c] = o.ceil; l.ceilCm[c] = Math.round(o.h * 100);
        l.cellZone[c] = o.zone;
      }
      if (o.lockedExit && cx === 0 && cz === 0) l.landmarks.push({ kind: LandmarkKind.LOCKED_EXIT, i0: 0, j0: 0, i1: 3, j1: 8 });
      layouts.set(k, l);
    }
    return l;
  };
  const q = {
    storey: 0,
    isLoaded: () => true,
    floorAt: () => 0,
    ceilingAt: () => o.h,
    waterAt: () => null,
    surfaceAt: () => SurfaceSound.CARPET,
    boxesNear: () => 0,
    portalAt: () => null,
    portalsNear: () => 0,
    propAt: () => null,
    layoutAt,
    zoneAt: () => o.zone,
    moodAt: () => o.mood ?? Mood.NORMAL,
    fixturesNear(x: number, z: number, r: number, out: FixtureRef[]): number {
      out.length = 0;
      for (const f of fixtures) if (Math.hypot(f.px - x, f.pz - z) <= r) out.push({ f, wx: f.px, wy: f.py, wz: f.pz, tileKey: '0:0:0:0' });
      return out.length;
    },
    emittersNear(x: number, z: number, r: number, out: EmitterRef[]): number {
      out.length = 0;
      for (const e of o.emitters ?? []) if (Math.hypot(e.x - x, e.z - z) <= r) out.push({ e, wx: e.x, wy: e.y, wz: e.z });
      return out.length;
    },
    losClear: (ax: number, _ay: number, az: number, bx: number, _by: number, bz: number) =>
      ax >= 0 && az >= 0 && ax <= W && az <= L && bx >= 0 && bz >= 0 && bx <= W && bz <= L,
    rayDistance(x: number, _y: number, z: number, dx: number, dz: number, maxDist: number): number {
      let t = maxDist;
      if (dx > 1e-9) t = Math.min(t, (W - x) / dx); else if (dx < -1e-9) t = Math.min(t, -x / dx);
      if (dz > 1e-9) t = Math.min(t, (L - z) / dz); else if (dz < -1e-9) t = Math.min(t, -z / dz);
      return Math.max(0, t);
    },
    edgeSound: (axis: 'x' | 'z', gi: number, gj: number) => (axis === 'x' ? inside(gi - 1, gj) && inside(gi, gj) : inside(gi, gj - 1) && inside(gi, gj)) ? 1 : 0,
    cellWalkable: (gi: number, gj: number) => inside(gi, gj),
  };
  return q as unknown as WorldQuery;
}

/** Lit ceiling grid, one fixture per 2 x 2 cells (2.4 m), ids from the lattice. */
function grid(w: number, l: number, state: LightStateId = LightState.ON): RoomOpts['fixtures'] {
  const out: RoomOpts['fixtures'] = [];
  for (let j = 1; j < l; j += 2) for (let i = 1; i < w; i += 2) out.push({ x: i * CELL, z: j * CELL, state, id: 1000 + j * 64 + i });
  return out;
}

const lighting = { intensityOf: () => 1 } as unknown as LightingRuntime;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rig { audio: AudioSystem; bus: EventBus<GameEvents>; ctx: MockContext; player: PlayerState; t: number }

async function rig(): Promise<Rig> {
  const bus = new EventBus<GameEvents>();
  const audio = createAudioSystem(bus, { ...DEFAULT_SETTINGS, volume: { ...DEFAULT_SETTINGS.volume } }, QUALITY.high);
  await audio.start();
  const ctx = MockContext.last as MockContext;
  return { audio, bus, ctx, player: createPlayerState(0, 6, 0, 6, 0, 0), t: 0 };
}

/** Wait until the main-thread DSP fallback has rendered everything queued (buffer count stable for 1.5 s). */
async function drain(r: Rig, maxMs = 60000): Promise<void> {
  const t0 = Date.now();
  let last = -1, stableSince = Date.now();
  for (;;) {
    await sleep(100);
    const n = r.ctx.buffers;
    if (n !== last) { last = n; stableSince = Date.now(); }
    if (Date.now() - stableSince > 1500 || Date.now() - t0 > maxMs) return;
  }
}

function run(r: Rig, world: WorldQuery, seconds: number, dt = 1 / 60, each?: (t: number) => void): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    r.ctx.advance(dt);
    r.t += dt;
    each?.(r.t);
    r.audio.update(r.t, dt, r.player, world, lighting);
  }
}

function place(p: PlayerState, x: number, z: number): void {
  p.x = x; p.z = z; p.eyeX = x; p.eyeZ = z; p.eyeY = 1.62; p.y = 0;
}

let restore: () => void = () => undefined;
beforeAll(() => { restore = installWebAudioMock(); });
afterAll(() => restore());

describe('AudioSystem runtime (Web Audio mock)', () => {
  it('starts, runs, voices the hum at lit fixtures and measures RT60 LOBBY < PARKING', async () => {
    const r = await rig();
    expect(r.audio.stats().state).toBe('running');
    // buffers render on the main-thread fallback (no Worker under Node); a few frames first so bus buffers queue
    const lobby = roomWorld({ w: 9, l: 9, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: grid(9, 9) });
    place(r.player, 5.4, 5.4);
    run(r, lobby, 0.5);
    await drain(r);
    run(r, lobby, 3);
    const s1 = { ...r.audio.stats() };
    expect(s1.voices).toBeGreaterThan(4);
    expect(s1.rt60).toBeGreaterThan(0.12);
    expect(s1.rt60).toBeLessThan(0.6);
    expect(s1.ir).toBeGreaterThanOrEqual(0);

    const parking = roomWorld({ w: 34, l: 34, h: 2.6, zone: Zone.PARKING, floor: Mat.CONCRETE_FLOOR, wall: Mat.CONCRETE_WALL, ceil: Mat.CONCRETE_CEIL, fixtures: grid(34, 34) });
    place(r.player, 20, 20);
    r.bus.emit('teleport', { s: 0, x: 20, y: 0, z: 20 });
    run(r, parking, 4);
    const s2 = { ...r.audio.stats() };
    expect(s2.rt60).toBeGreaterThan(1.8);
    expect(s2.rt60).toBeGreaterThan(s1.rt60);
    expect(s2.ir).toBeGreaterThan(s1.ir);
    // the IR crossfade and the zone bed change are logged
    const log = r.audio.recentEvents().join('\n');
    expect(log).toMatch(/audio started/);
    expect(log).toMatch(/reverb IR/);
    expect(log).toMatch(/zone beds -> fanDrone/);
    r.audio.dispose();
    expect(r.audio.stats().state).toBe('closed');
  }, 90000);

  it('dead sectors fall silent (room tone only), flicker transients are sample-aligned, events are handled', async () => {
    const r = await rig();
    // FLICKER fixture 3 m away; find a seed-time window with transients
    const flickId = 424242;
    const room = (state: LightStateId, dyn: boolean): WorldQuery => roomWorld({
      w: 12, l: 12, h: 2.7, zone: Zone.LOBBY, mood: Mood.DYING, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE,
      fixtures: [{ x: 7.2, z: 7.2, state, dynamic: dyn, id: flickId }],
      emitters: [
        { kind: EmitterKind.PHONE, x: 12, y: 0.8, z: 12, gain: 1, seed: 5 },
        { kind: EmitterKind.RADIO, x: 3, y: 0.8, z: 3, gain: 1, seed: 6 },
        { kind: EmitterKind.VENT, x: 7, y: 2.6, z: 2, gain: 1, seed: 7 },
      ],
      lockedExit: true,
    });
    const dead = roomWorld({ w: 12, l: 12, h: 2.7, zone: Zone.DARK, mood: Mood.DARK, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: [] });
    place(r.player, 6, 6);
    run(r, dead, 0.5);
    await drain(r);
    run(r, dead, 2);
    // dead sector: no hum voices (only beds: room tone + the DARK hvac)
    const deadVoices = r.audio.stats().voices;
    expect(deadVoices).toBeLessThanOrEqual(2);

    // flicker: record every buffer source started while only the FLICKER light is near
    const w = room(LightState.FLICKER, true);
    run(r, w, 1); // allocate the hum voice + dynamic list
    const seed = fixtureSeed(flickId);
    const expected: FlickerEvent[] = [];
    const offset = r.ctx.currentTime - r.t; // AudioContext clock vs simulation clock
    const dt = 1 / 60;
    const started: { when: number; len: number }[] = [];
    const t0 = r.t;
    const origStart = MockSource.prototype.start;
    MockSource.prototype.start = function (this: MockSource, when = 0, offset = 0): void {
      origStart.call(this, when, offset);
      if (!this.loop && this.buffer) started.push({ when, len: this.buffer.length });
    };
    try {
      run(r, w, 24);
    } finally {
      MockSource.prototype.start = origStart;
    }
    // the frames covered (t + 0.03, t + 0.03 + dt] for t = t0 + dt .. r.t
    flickerEvents(LightState.FLICKER, seed, t0 + dt + 0.03, r.t + dt + 0.03, 'standard', expected);
    expect(expected.length).toBeGreaterThan(0);
    // fixture transient buffers: 0.3 / 1.1 / 0.7 / 0.45 s (tink / strike / pop / off)
    const lens = new Set([0.3, 1.1, 0.7, 0.45].map((s) => Math.round(s * 48000)));
    const fx = started.filter((s) => lens.has(s.len));
    // each flicker event starts one buffer at ctxTime + 0.03 + (ev.t - t) - outputLatency (mock: 20 ms), i.e. at the
    // AudioContext time that corresponds to ev.t plus the 30 ms display latency, sample-exact
    expect(fx.length).toBe(expected.length);
    for (const ev of expected) {
      const want = ev.t + offset + 0.03 - 0.02;
      expect(fx.some((s) => Math.abs(s.when - want) < 1e-6), `transient ${ev.kind} @ ${ev.t.toFixed(3)}`).toBe(true);
    }

    // events: every kind, several phases, must not throw or write non-finite params
    const e = r.bus;
    for (let s = 0; s <= 10; s++) {
      e.emit('footstep', { surface: s as SurfaceSoundId, intensity: 1, foot: (s & 1) as 0 | 1, x: 6, y: 0, z: 6, waterDepth: 0, settle: s === 3 });
    }
    e.emit('footstep', { surface: SurfaceSound.CARPET, intensity: NaN, foot: 0, x: 6, y: 0, z: 6, waterDepth: 0.5, settle: false });
    e.emit('land', { surface: SurfaceSound.CONCRETE, impact: 4, x: 6, y: 0, z: 6 });
    e.emit('breath', { rate: 0.5, depth: 0.8 });
    e.emit('flashlight', { on: true });
    e.emit('spark', { x: 7, y: 2.5, z: 7, strength: 1 });
    e.emit('interact', { propKind: PropKind.DOOR_LEAF, x: 1, y: 0, z: 2, yaw: 0, seed: 3 });
    e.emit('interact', { propKind: PropKind.RADIO, x: 3, y: 0, z: 4, yaw: 0, seed: 3 });
    for (const phase of ['enter', 'doorsClosing', 'ride', 'switch', 'doorsOpening', 'exit'] as const) {
      e.emit('transition', { kind: 'elevator', phase, id: 9 });
      run(r, w, 0.2);
    }
    // walk into the water + sprint (wade bed), then the phone: stops ringing within 3 m
    r.player.speed = 3; r.player.waterDepth = 0.4;
    run(r, w, 0.5);
    r.player.speed = 0; r.player.waterDepth = 0;
    place(r.player, 11, 11);
    run(r, w, 1);
    expect(r.audio.recentEvents().join('\n')).toMatch(/phone stops ringing/);
    e.emit('interact', { propKind: PropKind.PHONE, x: 11.5, y: 0, z: 11.5, yaw: 0, seed: 1 });
    e.emit('glitch', { seconds: 1, strength: 1 });
    run(r, w, 1.2);
    r.audio.setPaused(true);
    run(r, w, 0.3);
    r.audio.setPaused(false);
    r.audio.setQuality(QUALITY.low);
    r.audio.setFlickerMode('reduced');
    r.audio.setVolumes({ master: 0.5, ambience: 0.2, hum: 1, sfx: 0.3, ui: 0 });
    e.emit('settingsChanged', { ...DEFAULT_SETTINGS, mainsHz: 50 });
    run(r, w, 1);
    const log = r.audio.recentEvents().join('\n');
    expect(log).toMatch(/interact door \(locked exit\)/);
    expect(log).toMatch(/interact radio: (tune|off)/);
    expect(log).toMatch(/interact phone: picked up/);
    expect(log).toMatch(/elevator doorsOpening/);
    expect(log).toMatch(/glitch: tape stop/);
    expect(log).toMatch(/mains 50 Hz/);
    expect(r.audio.stats().voices).toBeGreaterThan(0);
    r.audio.dispose();
  }, 120000);

  it('flicker transients are scheduled exactly once when the frame dt varies', async () => {
    const r = await rig();
    const flickId = 515151;
    const w = roomWorld({
      w: 10, l: 10, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE,
      fixtures: [{ x: 6, z: 6, state: LightState.FLICKER, dynamic: true, id: flickId }],
    });
    place(r.player, 4.8, 4.8);
    run(r, w, 0.5);
    await drain(r);
    run(r, w, 1);
    const offset = r.ctx.currentTime - r.t;
    const started: number[] = [];
    const origStart = MockSource.prototype.start;
    MockSource.prototype.start = function (this: MockSource, when = 0, off = 0): void {
      origStart.call(this, when, off);
      if (!this.loop && this.buffer) started.push(when);
    };
    const dts = [1 / 60, 1 / 30, 1 / 144, 1 / 50, 1 / 240, 1 / 24];
    let first = NaN, lastEnd = NaN;
    try {
      for (let i = 0; i < 2400; i++) {
        const dt = dts[i % dts.length];
        r.ctx.advance(dt);
        r.t += dt;
        if (i === 0) first = r.t + 0.03;
        lastEnd = Math.max(Number.isFinite(lastEnd) ? lastEnd : -Infinity, r.t + 0.03 + dt);
        r.audio.update(r.t, dt, r.player, w, lighting);
      }
    } finally {
      MockSource.prototype.start = origStart;
    }
    const expected: FlickerEvent[] = [];
    flickerEvents(LightState.FLICKER, fixtureSeed(flickId), first, lastEnd, 'standard', expected);
    expect(expected.length).toBeGreaterThan(0);
    for (const ev of expected) {
      const want = ev.t + offset + 0.03 - 0.02;
      const hits = started.filter((wh) => Math.abs(wh - want) < 1e-6).length;
      const same = expected.filter((o) => o.t === ev.t).length; // e.g. strike + pop on the burst's last boundary
      expect(hits, `transient ${ev.kind} @ ${ev.t.toFixed(3)}`).toBe(same);
    }
    r.audio.dispose();
  }, 120000);

  it('the Poisson ambient director plays rare, gapped, non-repeating events 25-60 m away', async () => {
    const r = await rig();
    // a long hall (60 m) so reachable cells 25-60 m away exist inside the 24-cell propagation window
    const hall = roomWorld({ w: 48, l: 6, h: 2.7, zone: Zone.POOLROOMS, floor: Mat.POOL_TILE, wall: Mat.POOL_TILE, ceil: Mat.CONCRETE_CEIL, fixtures: grid(48, 6) });
    place(r.player, 2, 3.6);
    run(r, hall, 0.5);
    await drain(r);
    run(r, hall, 600, 1 / 20); // 10 minutes at 20 Hz
    const evs = r.audio.recentEvents().filter((l) => / ambient /.test(l));
    // pools: lambda 1/20 s with a 15 s gap -> roughly 10 min / 35 s ~ 17; allow a wide band
    expect(evs.length).toBeGreaterThan(5);
    expect(evs.length).toBeLessThan(40);
    let prevT = -1e9, prevKind = '';
    for (const l of evs) {
      const m = /^([\d.]+)s ambient (\w+) at (\d+) m/.exec(l);
      expect(m).not.toBeNull();
      if (!m) continue;
      const t = Number(m[1]);
      expect(t - prevT).toBeGreaterThanOrEqual(15 - 0.1);
      expect(m[2]).not.toBe(prevKind);
      expect(['dripPlink', 'drainGurgle', 'filterPump']).toContain(m[2]);
      const d = Number(m[3]);
      expect(d).toBeGreaterThanOrEqual(10); // path 25-60 m; euclid may be shorter in a hall only by rounding
      prevT = t; prevKind = m[2];
    }
    r.audio.dispose();
  }, 180000);

  it('meters the post-limiter output into stats() and recentEvents(), and flags non-finite output', async () => {
    const r = await rig();
    const w = roomWorld({ w: 9, l: 9, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: grid(9, 9) });
    place(r.player, 5.4, 5.4);
    MockContext.meterAmp = 0.1; // sine peak 0.1 -> -20 dBFS peak, -23 dBFS RMS
    run(r, w, 12);
    const s = r.audio.stats() as ReturnType<AudioSystem['stats']> & { outRmsDb: number; outPeakDb: number };
    expect(s.outPeakDb).toBeCloseTo(-20, 0);
    expect(s.outRmsDb).toBeCloseTo(-23, 0);
    expect(r.audio.recentEvents().join('\n')).toMatch(/output rms -23(\.\d)? dBFS, peak -20(\.\d)? dBFS/);
    expect(r.audio.recentEvents().join('\n')).not.toMatch(/output WARNING/);
    MockContext.meterAmp = NaN;
    try { run(r, w, 10.5); } finally { MockContext.meterAmp = 0.1; }
    expect(r.audio.recentEvents().join('\n')).toMatch(/output WARNING: \d+ non-finite samples/);
    r.audio.dispose();
  }, 60000);

  it('voice fades run on a separate envelope, so level automation never bends the fade-in ramp', () => {
    const ctx = new MockContext();
    const bus = ctx.createGain();
    const v = new Voice(ctx as unknown as AudioContext, bus as unknown as AudioNode, { hrtf: false });
    const gain = v.gain.gain as unknown as MockParam, envg = v.envelope.gain as unknown as MockParam;
    // chain: gain -> envelope -> filter -> panner -> bus
    expect((v.gain as unknown as MockNode).outs.has(v.envelope as unknown as MockNode)).toBe(true);
    expect((v.envelope as unknown as MockNode).outs.has(v.filter as unknown as MockNode)).toBe(true);
    const res = createResolution();
    res.x = 1; res.y = 1; res.z = 1; res.cutoff = 8000; res.gain = 0.5;
    v.level = 0.2;
    v.apply(res, 0.08, true);
    v.fadeIn(0.3);
    expect(envg.value).toBe(1); // ramp target
    const envEvents = envg.events;
    // per-frame flicker / 5 Hz propagation automation touches only the level gain
    v.mul = 0.5;
    v.setGain(0.012);
    v.apply(res, 0.08);
    expect(envg.events).toBe(envEvents);
    expect(gain.value).toBeCloseTo(0.2 * 0.5 * 0.5, 9);
    v.release(0.3);
    expect(envg.value).toBe(0);
    expect(v.alive).toBe(false);
  });

  it('ui sounds play on the ui bus (post make-up -> compressor, bypassing master) while the context runs', async () => {
    const r = await rig();
    const w = roomWorld({ w: 6, l: 6, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: [] });
    place(r.player, 3, 3);
    run(r, w, 0.2);
    // src -> gain -> ui bus -> post (make-up gain) -> compressor (checked at start: sources disconnect when they end)
    const reachesCompressorIn = (n: MockNode, hops: number): boolean =>
      hops === 0 ? n.type === 'compressor' : [...n.outs].some((o) => reachesCompressorIn(o, hops - 1));
    const got: { src: MockSource; routed: boolean }[] = [];
    const origStart = MockSource.prototype.start;
    MockSource.prototype.start = function (this: MockSource, when = 0, off = 0): void {
      origStart.call(this, when, off);
      got.push({ src: this, routed: reachesCompressorIn(this, 4) });
    };
    try {
      r.bus.emit('ui', { name: 'click' });
      r.bus.emit('ui', { name: 'hover' });
      r.bus.emit('ui', { name: 'hover' }); // inside the 45 ms hover gap: dropped
      r.ctx.advance(0.1);
      r.bus.emit('ui', { name: 'open' });
      r.bus.emit('ui', { name: 'close' });
    } finally {
      MockSource.prototype.start = origStart;
    }
    expect(got.length).toBe(4);
    for (const g of got) {
      expect(g.src.buffer && g.src.buffer.length).toBeGreaterThan(0);
      expect(g.routed, 'ui sound routed through the ui bus').toBe(true);
    }
    expect(r.audio.recentEvents().join('\n')).toMatch(/ui click/);
    // a suspended context plays nothing
    r.ctx.state = 'suspended';
    const before = r.ctx.starts;
    r.bus.emit('ui', { name: 'click' });
    expect(r.ctx.starts).toBe(before);
    r.audio.dispose();
  }, 60000);

  it('radio: each press tunes to the next station (tuning sweep), then off, then back on; phone pick-up opens the line', async () => {
    const r = await rig();
    const w = roomWorld({
      w: 10, l: 10, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: grid(10, 10),
      emitters: [{ kind: EmitterKind.RADIO, x: 3, y: 0.8, z: 3, gain: 1, seed: 6 }],
    });
    place(r.player, 4, 4);
    run(r, w, 0.5);
    await drain(r);
    run(r, w, 1);
    await drain(r); // a voiced radio queues its other stations
    // the 4 station renders, recognised by their first samples
    const sig = (x: Float32Array): string => Array.from(x.subarray(0, 16), (v) => v.toFixed(6)).join(',');
    const stations = new Map<string, number>();
    for (let v = 0; v < 4; v++) stations.set(sig(synthEmitter(EmitterKind.RADIO, v, 48000, 8, 60)[0]), v);
    const radios = (): number[] => [...r.ctx.sources]
      .filter((s) => s.loop && s.started >= 0 && s.stopped < 0 && s.buffer && stations.has(sig(s.buffer.getChannelData(0))))
      .map((s) => stations.get(sig((s.buffer as MockBuffer).getChannelData(0))) as number);
    expect(radios().length).toBe(1);
    const press = (): void => { r.bus.emit('interact', { propKind: PropKind.RADIO, x: 3, y: 0, z: 3, yaw: 0, seed: 4 }); run(r, w, 1); };
    const heard = new Set<number>(radios());
    for (let k = 0; k < 3; k++) {
      press();
      const now = radios();
      expect(now.length, `station ${k + 1}`).toBe(1);
      heard.add(now[0]);
    }
    expect(heard.size).toBe(4); // four different stations
    const radioLoops = (): number => radios().length;
    press();
    expect(radioLoops()).toBe(0);
    press();
    expect(radioLoops()).toBe(1);
    const log = r.audio.recentEvents().join('\n');
    expect(log.match(/interact radio: tune/g)?.length).toBe(3);
    expect(log).toMatch(/interact radio: off[\s\S]*interact radio: on/);
    // phone: pick-up clunk, then the 4.8 s open line starts ~0.12 s later
    const got: { when: number; len: number }[] = [];
    const origStart = MockSource.prototype.start;
    MockSource.prototype.start = function (this: MockSource, when = 0, off = 0): void { origStart.call(this, when, off); if (this.buffer) got.push({ when, len: this.buffer.length }); };
    try {
      r.bus.emit('interact', { propKind: PropKind.PHONE, x: 5, y: 0, z: 5, yaw: 0, seed: 2 });
    } finally {
      MockSource.prototype.start = origStart;
    }
    const line = got.find((g) => g.len === Math.round(4.8 * 48000));
    expect(line).toBeDefined();
    expect((line?.when ?? 0) - r.ctx.currentTime).toBeCloseTo(0.12, 3);
    expect(r.audio.recentEvents().join('\n')).toMatch(/interact phone: picked up, dial tone/);
    r.audio.dispose();
  }, 90000);

  it('sliders are perceptual (v^2, 0 mutes)', () => {
    expect(sliderGain(0)).toBe(0);
    expect(sliderGain(1)).toBe(1);
    expect(sliderGain(0.5)).toBeCloseTo(0.25, 9);
    expect(sliderGain(0.8)).toBeCloseTo(0.64, 9);
    expect(sliderGain(NaN)).toBe(1);
    expect(sliderGain(2)).toBe(1);
  });

  it('the ui bus ignores the master fade but follows the user Master slider (Master 0 mutes menu sounds)', () => {
    const ctx = new MockContext();
    const vol = { ...DEFAULT_SETTINGS.volume };
    const g = new AudioGraph(ctx as unknown as AudioContext, vol, vol.master);
    const ui = (): number => (g.buses.ui.gain as unknown as MockParam).value;
    expect(ui()).toBeCloseTo(sliderGain(vol.ui) * sliderGain(vol.master), 9);
    g.setVolumes({ ...vol, master: 0 }, vol.master); // title silence: App fades master only
    expect(ui()).toBeCloseTo(sliderGain(vol.ui) * sliderGain(vol.master), 9);
    expect((g.master.gain as unknown as MockParam).value).toBe(0);
    g.setVolumes({ ...vol, master: 0 }, 0); // the user set Master to 0
    expect(ui()).toBe(0);
    g.dispose();
  });

  it('cloth rustle ignores ordinary mouse-look; steps, crouching and whip turns drive it (turns capped)', () => {
    const ctx = new MockContext();
    ctx.state = 'running';
    const foleyBus = ctx.createGain();
    const buf = ctx.createBuffer(1, 48000, 48000);
    const env = {
      ctx, bank: { ensure: () => buf, get: () => buf },
      graph: { buses: { foley: foleyBus }, registerRate: () => null, unregisterRate: () => undefined, tapeSilent: false },
    } as unknown as AudioEnv;
    const f = new Foley(env);
    const gain = (f as unknown as { rustleGain: { gain: MockParam } }).rustleGain.gain;
    const p = createPlayerState(0, 1, 0, 1, 0, 0);
    const dt = 1 / 60;
    const turn = (rate: number, seconds: number): number => {
      let peak = 0;
      for (let i = 0; i < seconds / dt; i++) { p.camYaw += rate * dt; f.frame(p, dt); peak = Math.max(peak, gain.value); }
      return peak;
    };
    // standing, looking around at 2.5 rad/s (brisk mouse-look): silent
    p.speed = 0;
    expect(turn(2.5, 1)).toBeLessThan(0.005);
    // a 12 rad/s whip-around: audible but capped at the 0.25 share
    const whip = turn(12, 0.5);
    expect(whip).toBeGreaterThan(0.03);
    expect(whip).toBeLessThanOrEqual(0.35 * 0.25 + 1e-9);
    // walking with steps: rhythmic swish, louder than the whip cap allows for yaw alone
    turn(0, 1);
    p.speed = 3.2;
    let peak = 0;
    for (let k = 0; k < 4; k++) { f.onStep(1, false); peak = Math.max(peak, turn(0, 0.45)); }
    expect(peak).toBeGreaterThan(0.1);
    // crouch transition
    p.speed = 0;
    turn(0, 1);
    for (let i = 0; i < 12; i++) { p.crouch = Math.min(1, p.crouch + 0.1); f.frame(p, dt); }
    expect(gain.value).toBeGreaterThan(0.1);
  });

  it('does not touch Web Audio before start() and dispose is idempotent', () => {
    const bus = new EventBus<GameEvents>();
    MockContext.last = null;
    const a = createAudioSystem(bus, DEFAULT_SETTINGS, QUALITY.medium);
    const w = roomWorld({ w: 4, l: 4, h: 2.7, zone: Zone.LOBBY, floor: Mat.CARPET_L0, wall: Mat.WALLPAPER_L0, ceil: Mat.CEILING_TILE, fixtures: [] });
    a.update(1, 1 / 60, createPlayerState(0, 1, 0, 1, 0, 0), w, lighting);
    bus.emit('footstep', { surface: 0, intensity: 1, foot: 0, x: 1, y: 0, z: 1, waterDepth: 0, settle: false });
    expect(MockContext.last).toBeNull();
    expect(a.stats().state).toBe('none');
    a.dispose();
    a.dispose();
    expect(a.stats().state).toBe('closed');
  });
});

