import { describe, expect, it } from 'vitest';
import { CELL, TOWER_SPAN, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, SolidFlag, StructureKind, type StoreyId } from '../../src/core/ids.ts';
import type { ChunkLayout, Solid } from '../../src/core/layout.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { input, openLayout, recordingBus, spawnAt, TestHost, TestWorld, yawOf } from './helpers.ts';

// Tower per §2.4 at i0 = j0 = 8, rot 0 (u -> +x, v -> +z). World == chunk-local (chunk 0,0).
const X0 = 8 * CELL, Z0 = 8 * CELL;
const WALK: Solid['flags'] = SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP | SolidFlag.OCCLUDE | SolidFlag.RENDER;

export function towerLayout(s: StoreyId, endless = false): ChunkLayout {
  const l = openLayout(s, 0, 0);
  for (let v = 0; v < 5; v++) for (let u = 0; u < 3; u++) {
    const c = cellIdx(8 + u, 8 + v);
    l.flags[c] = CellFlag.TOWER | CellFlag.RESERVED;
    l.floorCm[c] = -600; l.ceilCm[c] = 600;
  }
  // perimeter walls (edges extrude over -6..6) + the shaft|vestibule wall on the u = 2 line
  for (let v = 0; v < 5; v++) {
    l.ex.kind[exIdx(8, 8 + v)] = EdgeKind.WALL;
    l.ex.kind[exIdx(11, 8 + v)] = EdgeKind.WALL;
    l.ex.kind[exIdx(10, 8 + v)] = EdgeKind.WALL;
  }
  for (let u = 0; u < 3; u++) { l.ez.kind[ezIdx(8 + u, 8)] = EdgeKind.WALL; l.ez.kind[ezIdx(8 + u, 13)] = EdgeKind.WALL; }
  // replicated period (bakeGroup 0: the test authors all replicas explicitly)
  let id = 1;
  for (let k = -2; k <= 2; k++) {
    const dy = 3 * k;
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
      if (y1 < -TOWER_SPAN || y0 > TOWER_SPAN) return;
      l.solids.push({ kind: 'box', id: id++, min: [x0, y0, z0], max: [x1, y1, z1], mat: 9, flags: WALK, bakeGroup: 0 });
    };
    box(X0, -0.2 + dy, Z0, X0 + 2.4, dy, Z0 + 1.2); // end0 landing
    box(X0, -1.7 + dy, Z0 + 4.8, X0 + 2.4, -1.5 + dy, Z0 + 6.0); // end1 landing
    if (Math.abs(dy) <= TOWER_SPAN) {
      l.solids.push({ kind: 'ramp', id: id++, x0: X0, z0: Z0 + 1.2, x1: X0 + 1.2, z1: Z0 + 4.8, y0: -1.5 + dy, y1: dy, dir: 3, steps: 13, mat: 9, flags: WALK, bakeGroup: 0 });
      l.solids.push({ kind: 'ramp', id: id++, x0: X0 + 1.2, z0: Z0 + 1.2, x1: X0 + 2.4, z1: Z0 + 4.8, y0: dy, y1: 1.5 + dy, dir: 2, steps: 13, mat: 9, flags: WALK, bakeGroup: 0 });
    }
  }
  l.solids.push({ kind: 'box', id: id++, min: [X0 + 1.2 - WALL_T / 2, -6, Z0 + 1.2], max: [X0 + 1.2 + WALL_T / 2, 6, Z0 + 4.8], mat: 12, flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE, bakeGroup: 0 });
  l.structures.push({
    id: 77, kind: StructureKind.TOWER, bakeGroup: 77, i0: 8, j0: 8, i1: 11, j1: 13, rot: 0,
    portal: { kind: 'tower', min: [X0, -6, Z0], max: [X0 + 3.6, 6, Z0 + 6.0], towerId: 77, endless },
  });
  return l;
}

function towerWorld(endless = false): TestWorld {
  const w = new TestWorld();
  for (const s of [0, 1, 2] as StoreyId[]) w.add(towerLayout(s, endless));
  return w;
}

const DOWN_PATH: [number, number][] = [[X0 + 0.6, Z0 + 5.4], [X0 + 1.8, Z0 + 5.4], [X0 + 1.8, Z0 + 0.6]];
const UP_PATH: [number, number][] = [[X0 + 1.8, Z0 + 5.4], [X0 + 0.6, Z0 + 5.4], [X0 + 0.6, Z0 + 0.6]];

type Sys = ReturnType<typeof createPlayerSystem>;
/** Walks waypoints at 120 fps (one sub-step per frame); returns per-frame (s, y). */
function walk(p: Sys, w: TestWorld, bus: Parameters<Sys['update']>[3], path: [number, number][], maxFrames = 20 * 120): { s: number[]; y: number[] } {
  const out = { s: [] as number[], y: [] as number[] };
  let i = 0;
  for (let f = 0; f < maxFrames && i < path.length; f++) {
    const [tx, tz] = path[i];
    const st = p.state;
    const d = Math.hypot(tx - st.x, tz - st.z);
    if (d < 0.12) { i++; continue; }
    st.yaw = yawOf(tx - st.x, tz - st.z);
    p.update(1 / 120, input({ moveZ: Math.min(1, d / 0.3 + 0.2) }), w, bus, false);
    out.s.push(st.s); out.y.push(st.y);
  }
  return out;
}

/** Storey-independent height: every down switch adds -3 m, every up switch +3 m. */
function effective(tr: { s: number[]; y: number[] }, dys: number[]): number[] {
  let off = 0, k = 0;
  const e: number[] = [];
  for (let i = 0; i < tr.y.length; i++) {
    if (i > 0 && tr.s[i] !== tr.s[i - 1]) off -= dys[k++];
    e.push(tr.y[i] + off);
  }
  return e;
}

describe('stair tower traversal', () => {
  it('walks down one storey: exactly one switch, continuous height (+-1 cm), then back up with no thrashing', () => {
    const w = towerWorld();
    const { bus, ev } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(X0 + 0.6, Z0 + 0.6, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    const down = walk(p, w, bus, DOWN_PATH);
    expect(p.state.s).toBe(1);
    expect(host.switches).toEqual([1]);
    expect(ev.storeyChanged?.length).toBe(1);
    expect(ev.storeyChanged?.[0]).toMatchObject({ from: 0, to: 1, dy: 3, via: 'tower' });
    expect(ev.transition?.filter((t) => t.phase === 'switch').length).toBe(1);
    expect(p.state.y).toBeCloseTo(0, 2); // end0 landing of the new storey
    const e = effective(down, [3]);
    for (let i = 1; i < e.length; i++) expect(Math.abs(e[i] - e[i - 1])).toBeLessThan(0.01);
    expect(e[e.length - 1]).toBeCloseTo(-3, 2);

    const upTr = walk(p, w, bus, UP_PATH);
    expect(p.state.s).toBe(0);
    expect(host.switches).toEqual([1, 0]);
    expect(ev.storeyChanged?.[1]).toMatchObject({ from: 1, to: 0, dy: -3, via: 'tower' });
    const e2 = effective(upTr, [-3]);
    for (let i = 1; i < e2.length; i++) expect(Math.abs(e2[i] - e2[i - 1])).toBeLessThan(0.01);
    expect(p.state.y).toBeCloseTo(0, 2);
  });

  it('dithering around the switch point never thrashes (hysteresis)', () => {
    const w = towerWorld();
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(X0 + 0.6, Z0 + 0.6, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    walk(p, w, bus, DOWN_PATH.slice(0, 2));
    // lane B, from end1: back and forth over the first metre of the flight (crosses -1.6 once going down)
    for (let r = 0; r < 4; r++) {
      walk(p, w, bus, [[X0 + 1.8, Z0 + 4.2]]);
      walk(p, w, bus, [[X0 + 1.8, Z0 + 5.3]]);
    }
    expect(host.switches.length).toBeLessThanOrEqual(2);
    expect(host.switches.length % 2 === 0 ? p.state.s === 0 : p.state.s === 1).toBe(true);
    // the switch count equals the number of real threshold crossings: at most one each way per excursion
    const n = host.switches.length;
    walk(p, w, bus, [[X0 + 1.8, Z0 + 5.3]]);
    expect(host.switches.length).toBe(n);
  });

  it('clamps at -1.59 until the target storey is prefetched, then switches seamlessly', () => {
    const w = towerWorld();
    const { bus } = recordingBus();
    const host = new TestHost(w);
    host.prefetched = new Set([0]);
    const p = createPlayerSystem(spawnAt(X0 + 0.6, Z0 + 0.6, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    walk(p, w, bus, DOWN_PATH.slice(0, 2));
    // go down lane B for a while: clamped, no switch
    const tr = walk(p, w, bus, [[X0 + 1.8, Z0 + 3.4]]);
    expect(host.switches).toEqual([]);
    expect(Math.min(...tr.y)).toBeGreaterThanOrEqual(-1.6); // the rule triggers below -1.6, the clamp holds -1.59
    expect(p.state.y).toBeCloseTo(-1.59, 5);
    // the prefetch policy asked for the storey below (keep-alive)
    expect(host.prefetchCalls.some((c) => c.s === 1 && Math.abs(c.x - (X0 + 1.8)) < 1e-6 && Math.abs(c.z - (Z0 + 3.0)) < 1e-6)).toBe(true);
    host.prefetched.add(1);
    walk(p, w, bus, [[X0 + 1.8, Z0 + 2.6]]);
    expect(host.switches).toEqual([1]);
    expect(p.state.s).toBe(1);
    // after the switch the feet follow the real flight: lane B (k = 0) at z = Z0 + 2.6
    expect(p.state.y).toBeCloseTo((1.5 * (2.6 - 1.2)) / 3.6, 1);
  });

  it('prefetches the storey above when climbing inside the footprint', () => {
    const w = towerWorld();
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(X0 + 1.8, Z0 + 0.6, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    walk(p, w, bus, [[X0 + 1.8, Z0 + 5.4]]); // up lane B from 0 to +1.5
    expect(host.prefetchCalls.some((c) => c.s === 2)).toBe(true);
    expect(host.prefetchCalls.some((c) => c.s === 1)).toBe(true);
  });

  it('ENDLESS_STAIRS shift y without changing the storey', () => {
    const w = towerWorld(true);
    const { bus, ev } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(X0 + 0.6, Z0 + 0.6, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    walk(p, w, bus, DOWN_PATH);
    expect(p.state.s).toBe(0);
    expect(host.switches).toEqual([]);
    expect(ev.storeyChanged ?? []).toEqual([]);
    expect(ev.transition?.filter((t) => t.phase === 'switch').length).toBe(1);
    expect(p.state.y).toBeCloseTo(0, 2);
  });
});
