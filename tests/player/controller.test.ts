import { describe, expect, it } from 'vitest';
import { CELL, PLAYER } from '../../src/core/constants.ts';
import { EventBus, type GameEvents } from '../../src/core/events.ts';
import { cellIdx } from '../../src/core/grid.ts';
import { CellFlag } from '../../src/core/ids.ts';
import { createPlayerState, type PlayerState } from '../../src/core/player.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { penetrationAt, SCRATCH_BOXES } from '../../src/player/collision.ts';
import { controllerExtra, DEFAULT_CONTROLLER, FATIGUE_START, STRIDE, stepPlayer, WALK_SPEEDS } from '../../src/player/controller.ts';
import { createPlayerSystem, type PlayerSystemExt } from '../../src/player/PlayerSystem.ts';
import { input, openLayout, recordingBus, spawnAt, TestHost, TestWorld, yawOf } from './helpers.ts';

const DT = 1 / 120;
const noEmit = (() => {}) as <K extends keyof GameEvents>(k: K, e: GameEvents[K]) => void;

function run(s: PlayerState, w: TestWorld, seconds: number, inp = input({ moveZ: 1 }), emit = noEmit): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepPlayer(s, inp, DT, w, DEFAULT_CONTROLLER, emit, 0.0022, false);
}

describe('controller', () => {
  it('accelerates smoothly to walking speed and decelerates to rest', () => {
    const w = new TestWorld().add(openLayout());
    const s = createPlayerState(0, 10, 0, 10, yawOf(1, 0), 0);
    let prev = 0, monotone = true;
    for (let i = 0; i < 120; i++) {
      run(s, w, DT);
      if (s.speed + 1e-9 < prev) monotone = false;
      prev = s.speed;
    }
    expect(monotone).toBe(true);
    expect(s.speed).toBeCloseTo(PLAYER.walk, 3);
    run(s, w, 1.0, input());
    expect(s.speed).toBeLessThan(0.01);
  });

  it('steps up 0.30 m but not 0.45 m', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) { l.floorCm[cellIdx(12, lj)] = 30; l.floorCm[cellIdx(20, lj)] = 45; }
    const w = new TestWorld().add(l);
    const a = createPlayerState(0, 12.5, 0, 10, yawOf(1, 0), 0);
    let maxY = 0;
    for (let i = 0; i < 480; i++) { run(a, w, DT); maxY = Math.max(maxY, a.y); }
    expect(a.x).toBeGreaterThan(13 * CELL + 0.5); // walked over the 0.3 m step and down the other side
    expect(maxY).toBeCloseTo(0.3, 5);
    expect(a.y).toBeCloseTo(0, 5);
    const b = createPlayerState(0, 22.5, 0, 10, yawOf(1, 0), 0);
    run(b, w, 3);
    expect(b.y).toBeCloseTo(0, 5);
    expect(Math.abs(b.x - (20 * CELL - PLAYER.radius))).toBeLessThan(0.001);
  });

  it('falls off a ledge under gravity and emits one land event', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) for (let li = 0; li < 10; li++) l.floorCm[cellIdx(li, lj)] = 100;
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 10 * CELL - 0.6, 1, 10, yawOf(1, 0), 0);
    const lands: GameEvents['land'][] = [];
    const emit = ((k: string, e: unknown) => { if (k === 'land') lands.push(e as GameEvents['land']); }) as typeof noEmit;
    run(s, w, 2, input({ moveZ: 1 }), emit);
    expect(s.y).toBeCloseTo(0, 5);
    expect(lands.length).toBe(1);
    expect(lands[0].impact).toBeGreaterThan(3.5); // sqrt(2 g 1 m) = 4.43
    expect(lands[0].impact).toBeLessThan(4.6);
  });

  it('crouch: 0.22 s smoothstep, blocked from standing up under a 1.5 m ceiling', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) for (let li = 15; li < 20; li++) l.ceilCm[cellIdx(li, lj)] = 150;
    const w = new TestWorld().add(l);
    // standing: cannot enter the low area
    const a = createPlayerState(0, 16, 0, 10, yawOf(1, 0), 0);
    run(a, w, 2);
    expect(Math.abs(a.x - (15 * CELL - PLAYER.radius))).toBeLessThan(0.002);
    // crouched: enters; crouch reaches 1 after 0.22 s
    const b = createPlayerState(0, 16, 0, 10, yawOf(1, 0), 0);
    run(b, w, 0.11, input({ crouch: true }));
    expect(b.crouch).toBeGreaterThan(0.3);
    expect(b.crouch).toBeLessThan(0.7);
    run(b, w, 3.5, input({ moveZ: 1, crouch: true }));
    expect(b.x).toBeGreaterThan(15 * CELL + 0.4);
    expect(b.x).toBeLessThan(20 * CELL);
    expect(b.speed).toBeCloseTo(PLAYER.crouch, 2);
    // release crouch under the low ceiling: stays crouched
    run(b, w, 1, input({ crouch: false }));
    expect(b.crouch).toBeCloseTo(1, 5);
    expect(controllerExtra(b).crouchRefused).toBe(true);
  });

  it('refuses to crouch in water deeper than crouchEye - 0.15 (0.9 m)', () => {
    const l = openLayout();
    l.waterCm.fill(90);
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 10, 0, 10, 0, 0);
    run(s, w, 1, input({ crouch: true }));
    expect(s.waterDepth).toBeCloseTo(0.9, 5);
    expect(s.crouch).toBe(0);
    expect(controllerExtra(s).crouchRefused).toBe(true);
    // shallow water: crouch works
    l.waterCm.fill(40);
    run(s, w, 1, input({ crouch: true }));
    expect(s.crouch).toBeCloseTo(1, 5);
  });

  it('wades slower: speed x (1 - 0.6 min(depth, 1))', () => {
    const l = openLayout();
    l.waterCm.fill(50);
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 5, 0, 10, yawOf(1, 0), 0);
    run(s, w, 2);
    expect(s.speed).toBeCloseTo(PLAYER.walk * (1 - 0.6 * 0.5), 2);
  });

  it('walking into an unloaded chunk is blocked', () => {
    const w = new TestWorld().add(openLayout(0, 0, 0));
    const s = createPlayerState(0, 35, 0, 10, yawOf(1, 0), 0);
    run(s, w, 5, input({ moveZ: 1, sprint: true }));
    expect(s.x).toBeLessThanOrEqual(38.4 - PLAYER.radius + 1e-6);
    expect(s.x).toBeGreaterThan(38.4 - PLAYER.radius - 0.02);
    expect(Number.isFinite(s.y)).toBe(true);
  });

  it('sprint fatigue: after FATIGUE_START (25 s) the speed decays to sprintTired over 5 s, recovering at 2x', () => {
    expect(FATIGUE_START).toBe(25);
    const w = new TestWorld();
    for (let cx = -1; cx <= 4; cx++) for (let cz = -1; cz <= 1; cz++) w.add(openLayout(0, cx, cz));
    const s = createPlayerState(0, 0, 0, 10, yawOf(1, 0), 0);
    run(s, w, 24.5, input({ moveZ: 1, sprint: true }));
    expect(s.speed).toBeCloseTo(PLAYER.sprint, 2);
    expect(s.fatigue).toBe(0);
    run(s, w, 6.5, input({ moveZ: 1, sprint: true }));
    expect(s.fatigue).toBeCloseTo(1, 5);
    expect(s.speed).toBeCloseTo(PLAYER.sprintTired, 1);
    run(s, w, 1.25, input({ moveZ: 1 }));
    expect(s.fatigue).toBeCloseTo(0.5, 1);
  });

  it('R2 pace: walk 1.75 m/s, sprint 4.0, tired 3.2; walk cadence ~2.3 Hz', () => {
    expect([PLAYER.walk, PLAYER.sprint, PLAYER.sprintTired]).toEqual([1.75, 4.0, 3.2]);
    expect(STRIDE.walk).toBe(0.75);
    expect(PLAYER.walk / STRIDE.walk).toBeGreaterThan(2.2);
    expect(PLAYER.walk / STRIDE.walk).toBeLessThan(2.45);
    expect(WALK_SPEEDS).toEqual({ slow: 1.45, normal: 1.75, brisk: 2.0 });
  });

  it('unstuck: a player wedged between boxes recovers within 1 s', () => {
    const l = openLayout();
    // a 0.4 m slot between two solids: narrower than the 0.56 m body, so push-outs fight each other
    l.solids.push({ kind: 'box', id: 1, min: [9, 0, 8], max: [10, 2.5, 12], mat: 0, flags: 1, bakeGroup: 0 });
    l.solids.push({ kind: 'box', id: 2, min: [10.4, 0, 8], max: [11.4, 2.5, 12], mat: 0, flags: 1, bakeGroup: 0 });
    l.solids.push({ kind: 'box', id: 3, min: [9, 0, 7.6], max: [11.4, 2.5, 8], mat: 0, flags: 1, bakeGroup: 0 });
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 10.2, 0, 9, 0, 0);
    const scratch = new Float32Array(SCRATCH_BOXES * 6);
    expect(penetrationAt(w, s.x, s.z, s.y, PLAYER.height, scratch)).toBeGreaterThan(0.05);
    run(s, w, 1.0, input());
    expect(penetrationAt(w, s.x, s.z, s.y, PLAYER.height, scratch)).toBeLessThan(0.002);
    expect(controllerExtra(s).unstuckCount).toBe(1);
  });

  it('unstuck: a player deep inside SOLID cells ends up in a free cell within 1 s', () => {
    const l = openLayout();
    for (let lj = 5; lj < 10; lj++) for (let li = 5; li < 10; li++) l.flags[cellIdx(li, lj)] = CellFlag.SOLID;
    const w = new TestWorld().add(l);
    const s = createPlayerState(0, 7.5 * CELL, 0, 7.5 * CELL, 0, 0);
    run(s, w, 1.0, input());
    const scratch = new Float32Array(SCRATCH_BOXES * 6);
    expect(penetrationAt(w, s.x, s.z, s.y, PLAYER.height, scratch)).toBeLessThan(0.002);
  });

  it('fly mode: noclip flight at 4 m/s with vertical control', () => {
    const w = new TestWorld().add(openLayout());
    const s = createPlayerState(0, 10, 0, 10, yawOf(1, 0), 0);
    s.fly = true;
    run(s, w, 2);
    expect(s.speed).toBeCloseTo(4, 2);
    const y0 = s.y;
    run(s, w, 1, { ...input(), up: true } as ReturnType<typeof input>);
    expect(s.y - y0).toBeGreaterThan(3);
  });
});

describe('PlayerSystem feel', () => {
  it('footsteps at 1.45 m/s occur at 1.96 Hz (+-2%) and each coincides with the bob minimum (+-1 frame)', () => {
    const w = new TestWorld();
    for (let cx = -1; cx <= 2; cx++) for (let cz = -1; cz <= 1; cz++) w.add(openLayout(0, cx, cz));
    let frame = 0;
    const { bus, times } = recordingBus(() => frame);
    const p = createPlayerSystem(spawnAt(1, 10, yawOf(1, 0)), DEFAULT_SETTINGS, bus, new TestHost(w));
    const FPS = 60, fdt = 1 / FPS;
    const eyeOff: number[] = [];
    const inp = input({ moveZ: 1 });
    for (frame = 0; frame < FPS * 14; frame++) {
      p.update(fdt, inp, w, bus, false);
      eyeOff.push(p.state.eyeY - (p.state.y + PLAYER.eye));
    }
    const steps = (times.footstep ?? []).filter((f) => f > FPS * 2); // steady state
    const span = (steps[steps.length - 1] - steps[0]) / FPS;
    const hz = (steps.length - 1) / span;
    expect(Math.abs(hz - PLAYER.walk / STRIDE.walk) / (PLAYER.walk / STRIDE.walk)).toBeLessThan(0.02);
    expect(hz).toBeGreaterThan(2.2); // ~2.3 Hz: an unhurried walk
    expect(hz).toBeLessThan(2.45);
    // bob minima
    const minima: number[] = [];
    for (let i = FPS * 2; i < eyeOff.length - 1; i++) if (eyeOff[i] <= eyeOff[i - 1] && eyeOff[i] < eyeOff[i + 1]) minima.push(i);
    for (const f of steps.slice(0, -1)) {
      const d = Math.min(...minima.map((m) => Math.abs(m - f)));
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('emits a soft settle footstep when stopping from > 0.8 m/s', () => {
    const w = new TestWorld().add(openLayout());
    const { bus, ev } = recordingBus();
    const p = createPlayerSystem(spawnAt(5, 10, yawOf(1, 0)), DEFAULT_SETTINGS, bus, new TestHost(w));
    for (let i = 0; i < 120; i++) p.update(1 / 60, input({ moveZ: 1 }), w, bus, false);
    const before = (ev.footstep ?? []).length;
    for (let i = 0; i < 90; i++) p.update(1 / 60, input(), w, bus, false);
    const settle = (ev.footstep ?? []).slice(before).filter((e) => e.settle);
    expect(settle.length).toBe(1);
    expect(settle[0].intensity).toBeCloseTo(0.35, 5);
  });

  it('interpolates the camera between 120 Hz sub-steps (no jitter at odd frame rates)', () => {
    const w = new TestWorld();
    for (let cx = 0; cx <= 1; cx++) w.add(openLayout(0, cx, 0));
    const bus = new EventBus<GameEvents>();
    const p = createPlayerSystem(spawnAt(2, 10, yawOf(1, 0)), { ...DEFAULT_SETTINGS, headBob: 0 }, bus, new TestHost(w));
    for (let i = 0; i < 200; i++) p.update(1 / 47, input({ moveZ: 1 }), w, bus, false);
    // steady walk at 47 fps: eye x advances by walk/47 every frame within 2 %
    let prev = p.state.eyeX;
    for (let i = 0; i < 60; i++) {
      p.update(1 / 47, input({ moveZ: 1 }), w, bus, false);
      const d = p.state.eyeX - prev;
      prev = p.state.eyeX;
      expect(Math.abs(d - PLAYER.walk / 47) / (PLAYER.walk / 47)).toBeLessThan(0.02);
    }
  });
});

describe('R2 walk pace setting', () => {
  it('walks at settings.walkSpeed only while the app reports user pace; the default pace otherwise', () => {
    const w = new TestWorld();
    for (let cx = -1; cx <= 3; cx++) for (let cz = -1; cz <= 1; cz++) w.add(openLayout(0, cx, cz));
    const bus = new EventBus<GameEvents>();
    const p = createPlayerSystem(spawnAt(2, 10, yawOf(1, 0)), { ...DEFAULT_SETTINGS, walkSpeed: 'brisk', headBob: 0 }, bus, new TestHost(w)) as PlayerSystemExt;
    for (let i = 0; i < 120; i++) p.update(1 / 60, input({ moveZ: 1 }), w, bus, false);
    expect(p.state.speed).toBeCloseTo(PLAYER.walk, 2); // attract / autowalk: default pace
    p.setUserPace(true);
    expect(p.walkSpeed).toBe(2.0);
    for (let i = 0; i < 120; i++) p.update(1 / 60, input({ moveZ: 1 }), w, bus, false);
    expect(p.state.speed).toBeCloseTo(2.0, 2);
    bus.emit('settingsChanged', { ...DEFAULT_SETTINGS, walkSpeed: 'slow' });
    for (let i = 0; i < 120; i++) p.update(1 / 60, input({ moveZ: 1 }), w, bus, false);
    expect(p.state.speed).toBeCloseTo(1.45, 2);
  });
});
