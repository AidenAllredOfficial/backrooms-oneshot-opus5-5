import { describe, expect, it } from 'vitest';
import { CELL, PLAYER, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, PropKind, StructureKind, type StoreyId } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem, type PlayerSystemDebug } from '../../src/player/PlayerSystem.ts';
import { input, layoutFrom, openLayout, place, recordingBus, spawnAt, TestHost, TestWorld, yawOf } from './helpers.ts';

type Sys = ReturnType<typeof createPlayerSystem>;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Runs `frames` 60 fps frames, yielding to the microtask queue so host promises resolve like in the app. */
async function frames(p: Sys, w: TestWorld, bus: Parameters<Sys['update']>[3], n: number, inp: ReturnType<typeof input>, each?: () => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    p.update(1 / 60, inp, w, bus, false);
    each?.();
    if (i % 4 === 0) await tick();
  }
}

// ---------------------------------------------------------------- glitch
/** 1-cell corridor (column 10, rows 10..13) ending in a GLITCH edge on line z = 14 * CELL. */
function glitchLayout(s: StoreyId): ChunkLayout {
  const text = place([
    '+-+',
    '|.|',
    '+ +',
    '|.|',
    '+ +',
    '|.|',
    '+ +',
    '|.|',
    '+%+',
  ].join('\n'), 10, 10);
  const l = layoutFrom(text, s);
  // open the corridor's north end into a room so it is a dead end, not a closed box
  l.ez.kind[ezIdx(10, 10)] = EdgeKind.OPEN;
  for (let j = 4; j < 10; j++) for (let i = 6; i < 15; i++) l.flags[cellIdx(i, j)] = 0;
  const line = 14 * CELL;
  l.structures.push({
    id: 5, kind: StructureKind.GLITCH, bakeGroup: 0, i0: 10, j0: 13, i1: 11, j1: 14, rot: 0,
    portal: { kind: 'glitch', min: [10 * CELL, 0, line - WALL_T / 2 - PLAYER.radius - 0.05], max: [11 * CELL, 2, line + WALL_T / 2], towerId: 0, endless: false },
  });
  return l;
}

describe('glitch walls', () => {
  it('enabling fly mode cancels a pending glitch warp', async () => {
    const w = new TestWorld().add(glitchLayout(0)).add(glitchLayout(1));
    const { bus, ev } = recordingBus();
    const host = new TestHost(w);
    host.prefetched = new Set([0]);
    const p = createPlayerSystem(spawnAt(10.5 * CELL, 15.0, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 180, input({ moveZ: 1 }));
    expect(ev.glitch?.length).toBeGreaterThan(0);
    expect((p as unknown as { debug: PlayerSystemDebug }).debug.warping).toBe(true);
    p.setFly(true);
    host.prefetched.add(1);
    await frames(p, w, bus, 30, input({ moveZ: 1 }));
    expect(p.state.s).toBe(0);
    expect(host.switches).toEqual([]);
    expect((p as unknown as { debug: PlayerSystemDebug }).debug.warping).toBe(false);
  });
  it('never passes through; 1.2 s of pushing triggers exactly one glitch and a warp to (s+1)%3', async () => {
    const w = new TestWorld().add(glitchLayout(0)).add(glitchLayout(1));
    let t = 0;
    const { bus, ev, times } = recordingBus(() => t);
    const host = new TestHost(w);
    host.safe = { s: 1, x: 12.6, y: 0, z: 9.0, yaw: 1, pitch: 0, zone: 0, score: 1, reason: 'safe' };
    const p = createPlayerSystem(spawnAt(10.5 * CELL, 15.0, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    const line = 14 * CELL;
    let maxZ = 0;
    let arrived: [number, number] | null = null;
    await frames(p, w, bus, 60 * 4, input({ moveZ: 1 }), () => {
      t += 1 / 60;
      if (p.state.s === 0) maxZ = Math.max(maxZ, p.state.z);
      else if (!arrived) arrived = [p.state.x, p.state.z];
    });
    expect(maxZ).toBeLessThan(line - WALL_T / 2 - PLAYER.radius + 0.001);
    expect(ev.glitch?.length).toBe(1);
    expect(ev.glitch?.[0]).toEqual({ seconds: 0.8, strength: 1 });
    // ~1.2 s of pushing after reaching the wall (walk 1.2 m takes ~1 s)
    expect(times.glitch[0]).toBeGreaterThan(1.2);
    expect(p.state.s).toBe(1);
    expect(host.switches).toEqual([1]);
    expect(arrived![0]).toBeCloseTo(12.6, 1); // the safe spawn (plus at most one frame of walking)
    expect(arrived![1]).toBeCloseTo(9.0, 1);
    expect(p.state.yaw).toBeCloseTo(1, 5); // spawn orientation
    expect(ev.storeyChanged?.[0]).toMatchObject({ from: 0, to: 1, via: 'glitch' });
  });

  it('walking along the glitch wall (no push into it) never triggers', async () => {
    const w = new TestWorld().add(glitchLayout(0));
    const { bus, ev } = recordingBus();
    const p = createPlayerSystem(spawnAt(10.5 * CELL, 16.4, yawOf(1, 0)), DEFAULT_SETTINGS, bus, new TestHost(w));
    // strafe/push sideways into the corridor walls while standing in the portal
    await frames(p, w, bus, 60 * 3, input({ moveZ: 1 }));
    expect(ev.glitch ?? []).toEqual([]);
  });

  it('waits for the prefetch while the glitch holds the screen (re-emits never overlap)', async () => {
    const w = new TestWorld().add(glitchLayout(0)).add(glitchLayout(1));
    let t = 0;
    const { bus, ev, times } = recordingBus(() => t);
    const host = new TestHost(w);
    host.prefetched = new Set([0]);
    const p = createPlayerSystem(spawnAt(10.5 * CELL, 15.0, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    const step = (): void => { t += 1 / 60; };
    await frames(p, w, bus, 60 * 3, input({ moveZ: 1 }), step);
    expect(p.state.s).toBe(0);
    const held = ev.glitch?.length ?? 0;
    expect(held).toBeGreaterThanOrEqual(1);
    const z = p.state.z;
    await frames(p, w, bus, 60 * 3, input({ moveZ: 1 }), step);
    expect(p.state.z).toBe(z); // held in place
    const g = ev.glitch ?? [];
    expect(g.length).toBeGreaterThan(held); // re-emitted to hold the screen
    // each hold starts only when the previous glitch has run out, and lasts HOLD_S (>= WP13's tape-stop cycle)
    const tg = times.glitch;
    for (let i = 1; i < g.length; i++) {
      expect(g[i]).toEqual({ seconds: 1.0, strength: 1 });
      expect(tg[i] - tg[i - 1]).toBeGreaterThanOrEqual(g[i - 1].seconds - 1 / 60 - 1e-9);
    }
    expect(g.length).toBeLessThanOrEqual(1 + Math.ceil((t - tg[0]) / 0.8));
    expect(host.prefetchCalls.some((c) => c.s === 1)).toBe(true);
    host.prefetched.add(1);
    const before = g.length;
    await frames(p, w, bus, 10, input(), step);
    expect(p.state.s).toBe(1);
    expect(ev.glitch?.length).toBe(before); // no event after the warp
  });

  it('prefetches the storey below around glitch walls and pits within the proximity radius', async () => {
    const w = new TestWorld().add(glitchLayout(0));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    // 6 m from the glitch portal, not pushing
    const p = createPlayerSystem(spawnAt(10.5 * CELL, 11.0, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 60, input());
    const near = host.prefetchCalls.filter((c) => c.s === 1);
    expect(near.length).toBeGreaterThanOrEqual(2); // keep-alive at the proximity cadence
    expect(near[0].x).toBeCloseTo(10.5 * CELL, 3);
    expect(Math.abs(near[0].z - 14 * CELL)).toBeLessThan(0.5);
    const w2 = new TestWorld().add(pitLayout(0));
    const h3 = new TestHost(w2);
    const r = createPlayerSystem(spawnAt(5, 5, 0), DEFAULT_SETTINGS, bus, h3);
    await frames(r, w2, bus, 30, input());
    expect(h3.prefetchCalls.some((c) => c.s === 1 && Math.abs(c.x - 13.2) < 0.01 && Math.abs(c.z - 13.2) < 0.01)).toBe(true);
    // far from any portal (> 12 m): nothing
    const h4 = new TestHost(w2);
    const q = createPlayerSystem(spawnAt(30, 30, 0), DEFAULT_SETTINGS, bus, h4);
    await frames(q, w2, bus, 30, input());
    expect(h4.prefetchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------- pits
function pitLayout(s: StoreyId): ChunkLayout {
  const l = openLayout(s);
  for (let j = 10; j < 12; j++) for (let i = 10; i < 12; i++) l.flags[cellIdx(i, j)] = CellFlag.VOID;
  l.structures.push({
    id: 9, kind: StructureKind.PIT, bakeGroup: 0, i0: 10, j0: 10, i1: 12, j1: 12, rot: 0,
    portal: { kind: 'pit', min: [12, -6, 12], max: [14.4, -1.5, 14.4], towerId: 0, endless: false },
  });
  return l;
}

describe('pits', () => {
  it('falling into a pit glitches (1.2 s, 0.6) and warps to the storey below', async () => {
    const w = new TestWorld().add(pitLayout(0)).add(pitLayout(1));
    const { bus, ev } = recordingBus();
    const host = new TestHost(w);
    host.safe = { s: 1, x: 5, y: 0, z: 5, yaw: 0, pitch: 0, zone: 0, score: 1, reason: 'safe' };
    const p = createPlayerSystem(spawnAt(13.2, 10.8, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    let minY = 0;
    await frames(p, w, bus, 60 * 4, input({ moveZ: 1 }), () => { if (p.state.s === 0) minY = Math.min(minY, p.state.y); });
    expect(minY).toBeLessThan(-1.5);
    expect(minY).toBeGreaterThan(-2.0); // held near the trigger depth
    expect(ev.glitch?.[0]).toEqual({ seconds: 1.2, strength: 0.6 });
    expect(p.state.s).toBe(1);
    expect(p.state.x).toBeCloseTo(5, 5);
    expect(ev.storeyChanged?.[0]).toMatchObject({ from: 0, to: 1, via: 'pit' });
  });
});

// ---------------------------------------------------------------- elevator
/** Elevator at i0 = j0 = 10, rot 0: cab cells (10..11, 10..11), lobby (10..11, 12); door on u = 0. */
function elevatorLayout(s: StoreyId): ChunkLayout {
  const l = openLayout(s);
  for (let j = 10; j < 13; j++) {
    for (let i = 10; i < 12; i++) l.flags[cellIdx(i, j)] = CellFlag.ELEVATOR | CellFlag.RESERVED;
    l.ex.kind[exIdx(10, j)] = EdgeKind.WALL; l.ex.kind[exIdx(12, j)] = EdgeKind.WALL;
  }
  l.ez.kind[ezIdx(10, 10)] = EdgeKind.WALL; l.ez.kind[ezIdx(11, 10)] = EdgeKind.WALL;
  l.ez.kind[ezIdx(10, 12)] = EdgeKind.DOORWAY; l.ez.hA[ezIdx(10, 12)] = 210;
  l.ez.kind[ezIdx(11, 12)] = EdgeKind.WALL;
  l.structures.push({
    id: 55, kind: StructureKind.ELEVATOR, bakeGroup: 55, i0: 10, j0: 10, i1: 12, j1: 13, rot: 0,
    portal: { kind: 'elevator', min: [12, 0, 12], max: [14.4, 2.7, 14.4], towerId: 55, endless: false },
  });
  return l;
}

describe('elevator', () => {
  it('enabling fly mode cancels an elevator ride before its storey switch', async () => {
    const w = new TestWorld().add(elevatorLayout(0)).add(elevatorLayout(1));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(12.6, 13.2, 0), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 240, input());
    expect((p as unknown as { debug: PlayerSystemDebug }).debug.elevatorPhase).toBe('ride');
    p.setFly(true);
    await frames(p, w, bus, 240, input());
    expect(p.state.s).toBe(0);
    expect(host.switches).toEqual([]);
  });
  it('rides: dwell 2 s -> doorsClosing -> ride (switch at 3 s) -> doorsOpening; doors block while closed', async () => {
    const w = new TestWorld().add(elevatorLayout(0)).add(elevatorLayout(1));
    let t = 0;
    const { bus, ev, times } = recordingBus(() => t);
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(12.6, 15.0, yawOf(0, -1)), DEFAULT_SETTINGS, bus, host);
    const step = (): void => { t += 1 / 60; };
    // walk into the cab through the doorway
    await frames(p, w, bus, 90, input({ moveZ: 1 }), step);
    expect(p.state.z).toBeLessThan(14.4 - 0.3);
    // lobby entry prefetched the storey below
    expect(host.prefetchCalls.some((c) => c.s === 1)).toBe(true);
    // turn around, stand still
    p.state.yaw = yawOf(0, 1);
    await frames(p, w, bus, 60 * 4, input(), step);
    const phases = (ev.transition ?? []).filter((e) => e.kind === 'elevator').map((e) => e.phase);
    expect(phases).toContain('doorsClosing');
    expect(phases).toContain('ride');
    // door leaves were attached and are now closed (offset 0)
    expect(host.attached.length).toBeGreaterThanOrEqual(2);
    // try to walk out during the ride: blocked by the closed leaves
    await frames(p, w, bus, 60 * 2, input({ moveZ: 1 }), step);
    expect(p.state.z).toBeLessThan(14.4 - 0.1);
    await frames(p, w, bus, 60 * 6, input(), step);
    const ph = (ev.transition ?? []).filter((e) => e.kind === 'elevator').map((e) => e.phase);
    const iC = ph.indexOf('doorsClosing'), iR = ph.indexOf('ride'), iS = ph.indexOf('switch'), iO = ph.indexOf('doorsOpening');
    expect(iC).toBeGreaterThanOrEqual(0);
    expect(iC < iR && iR < iS && iS < iO).toBe(true);
    const tt = (ev.transition ?? []).map((e, i) => ({ e, t: times.transition[i] })).filter((x) => x.e.kind === 'elevator');
    const tR = tt.find((x) => x.e.phase === 'ride')!.t, tS = tt.find((x) => x.e.phase === 'switch')!.t, tO = tt.find((x) => x.e.phase === 'doorsOpening')!.t;
    expect(tS - tR).toBeGreaterThanOrEqual(3 - 0.02);
    expect(tO - tR).toBeGreaterThanOrEqual(6 - 0.02);
    expect(host.switches).toEqual([1]);
    expect(p.state.s).toBe(1);
    expect(ev.storeyChanged?.[0]).toMatchObject({ from: 0, to: 1, dy: 0, via: 'elevator' });
    // doors reopened: walking out works now
    await frames(p, w, bus, 60 * 3, input({ moveZ: 1 }), step);
    expect(p.state.z).toBeGreaterThan(14.4 + 0.3);
    // new leaves in the new storey's tile, old ones disposed
    expect(host.attached.filter((a) => a.key.startsWith('1:')).length).toBeGreaterThanOrEqual(2);
    expect(host.attached.filter((a) => a.key.startsWith('0:')).every((a) => a.disposed)).toBe(true);
  });

  it('a portal seen before its layout is readable gets its door leaves once the layout arrives', async () => {
    class LateLayoutWorld extends TestWorld {
      hideLayouts = true;
      override layoutAt(cx: number, cz: number): ChunkLayout | null { return this.hideLayouts ? null : super.layoutAt(cx, cz); }
    }
    const w = new LateLayoutWorld();
    w.add(elevatorLayout(0));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(12.6, 16.0, yawOf(0, -1)), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 30, input());
    expect(host.attached.length).toBe(0); // door side unknown: no leaves yet
    w.hideLayouts = false;
    await frames(p, w, bus, 30, input());
    expect(host.attached.length).toBe(2);
    await frames(p, w, bus, 60, input());
    expect(host.attached.length).toBe(2); // the tracked frame is not rebuilt every proximity tick
    expect(host.attached.every((a) => !a.disposed)).toBe(true);
  });

  it('elevators beyond the tracking radius show parked open leaves; hand-over and eviction never double or drop them', async () => {
    const w = new TestWorld().add(elevatorLayout(0)).add(openLayout(0, 1, 0));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const live = (): typeof host.attached => host.attached.filter((a) => !a.disposed);
    // ~31 m from the cab: not tracked (> 14 m), within DECOR_R (40 m)
    const p = createPlayerSystem(spawnAt(36, 16, yawOf(-1, 0)), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 30, input());
    expect((p as unknown as { debug: PlayerSystemDebug }).debug.elevatorPhase).toBe('open'); // idle: nothing tracked
    expect(live().length).toBe(2);
    for (const a of live()) expect(Math.hypot(a.off[0], a.off[2])).toBeGreaterThan(0.4); // parked open
    // walk toward it until it is tracked: always exactly 2 live leaves
    let minLive = 2, maxLive = 2;
    await frames(p, w, bus, 60 * 9, input({ moveZ: 1 }), () => { minLive = Math.min(minLive, live().length); maxLive = Math.max(maxLive, live().length); });
    expect(p.state.x).toBeLessThan(26);
    expect([minLive, maxLive]).toEqual([2, 2]);
    expect(host.attached.slice(0, 2).every((a) => a.disposed)).toBe(true); // the parked pair went to the tracker
    // walk (sprint) away beyond DECOR_R: everything is released
    p.state.yaw = yawOf(1, 0);
    await frames(p, w, bus, 60 * 14, input({ moveZ: 1, sprint: true }), () => { maxLive = Math.max(maxLive, live().length); });
    expect(p.state.x).toBeGreaterThan(14.4 + 42);
    expect(maxLive).toBe(2);
    expect(live().length).toBe(0);
  });

  it('the door leaves are built as tile-local props-material meshes', async () => {
    const w = new TestWorld().add(elevatorLayout(0));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(12.6, 16.0, yawOf(0, -1)), DEFAULT_SETTINGS, bus, host);
    await frames(p, w, bus, 30, input());
    expect(host.attached.length).toBe(2);
    for (const a of host.attached) {
      expect(a.m.vertexCount).toBeGreaterThan(0);
      expect(a.m.indexCount % 3).toBe(0);
      const [x0, y0, z0, x1, y1, z1] = a.m.bounds;
      // one leaf: about 0.5 m wide along x (door line along x), <= 0.06 thick, 2.2 m tall, near the doorway
      expect(x1 - x0).toBeLessThan(0.52);
      expect(z1 - z0).toBeLessThan(0.07);
      expect(y1 - y0).toBeCloseTo(2.2, 1);
      expect(y0).toBeCloseTo(0, 3);
      expect(z0).toBeGreaterThan(14.4 - 0.25);
      expect(z1).toBeLessThan(14.4);
      for (let i = 0; i < a.m.position.length; i++) expect(Number.isFinite(a.m.position[i])).toBe(true);
      // the transform is a proper rotation: triangle winding agrees with the stored normals
      const P = a.m.position, Nn = a.m.normal, I = a.m.index;
      let agree = 0, total = 0;
      for (let t = 0; t < a.m.indexCount; t += 3) {
        const [i0, i1, i2] = [I[t], I[t + 1], I[t + 2]];
        const ux = P[i1 * 3] - P[i0 * 3], uy = P[i1 * 3 + 1] - P[i0 * 3 + 1], uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
        const vx = P[i2 * 3] - P[i0 * 3], vy = P[i2 * 3 + 1] - P[i0 * 3 + 1], vz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        if (Math.hypot(cx, cy, cz) < 1e-9) continue;
        total++;
        if (cx * Nn[i0 * 4] + cy * Nn[i0 * 4 + 1] + cz * Nn[i0 * 4 + 2] > 0) agree++;
      }
      expect(agree / total).toBeGreaterThan(0.95);
    }
    void PropKind;
  });
});
