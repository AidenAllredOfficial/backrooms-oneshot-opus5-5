// WP4 — structures: elevators, glitch walls, pits and the 13 landmarks (registry, stamping, entrances reachable
// after repair over 1000 forced-landmark chunks). Tower geometry lives in tower.test.ts.
import { describe, expect, it } from 'vitest';
import { CELL, ELEVATOR, PLAYER, TOWER_SPAN, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx, forwardXZ } from '../../src/core/grid.ts';
import {
  AnomalyKind, CellFlag, EdgeKind, EmitterKind, LANDMARK_COUNT, LandmarkKind, LANDMARK_NAMES, Mat, PropKind, type StoreyId,
  StructureKind, Zone,
} from '../../src/core/ids.ts';
import { structureFixtureId, fixtureSeed, type ChunkLayout } from '../../src/core/layout.ts';
import { Rng, SALT } from '../../src/core/rng.ts';
import type { ChunkGrid, ElevatorSite, FieldSampler, ZoneGenContext } from '../../src/core/world.ts';
import { elevatorFootprint } from '../../src/core/world.ts';
import { STRUCTURE_ZONE } from '../../src/core/zones.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { cellWalkable } from '../../src/world/connectivity.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { computeKeepClear } from '../../src/world/content/keepClear.ts';
import { LANDMARKS } from '../../src/world/landmarks/index.ts';
import { ELEVATOR_CAB, elevatorExitCell, elevatorIdOf, isWrongElevator, stampElevator } from '../../src/world/structures/elevator.ts';
import { GLITCH_P, placeGlitchWallIn, placeGlitchWalls } from '../../src/world/structures/glitch.ts';
import { PIT_P, PIT_P_ANY, placePitIn, placePits } from '../../src/world/structures/pit.ts';
import { ctxFor, fixtureHitsWall, N, openLayout, opts, reachable } from './wp4-helpers.ts';

// ------------------------------------------------------------------------------------------ elevators

function stampedElevator(site: ElevatorSite, s: StoreyId = 0): { l: ChunkLayout; g: ChunkGrid } {
  const l = openLayout(s);
  const g = createChunkGrid(l, 7);
  stampElevator(g, site, 7);
  return { l, g };
}

describe('stampElevator', () => {
  for (const rot of [0, 1, 2, 3] as const) {
    it(`rot ${rot}: cells, cab shell, 1-cell door, storey-free fixtures, portal, exit`, () => {
      const site: ElevatorSite = { id: 123457 + rot, cx: 3, cz: 5, i0: 10, j0: 12, rot };
      const { l } = stampedElevator(site);
      const id = elevatorIdOf(site);
      const [i0, j0, i1, j1] = elevatorFootprint(site);
      for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) {
        const c = cellIdx(li, lj);
        expect(l.flags[c] & (CellFlag.ELEVATOR | CellFlag.RESERVED)).toBe(CellFlag.ELEVATOR | CellFlag.RESERVED);
        expect(l.cellZone[c]).toBe(STRUCTURE_ZONE);
      }
      // cab fixtures: TROFFER_2x2 at 2000 nits, ids structureFixtureId(id, SALT.ELEVATOR, i), isolated bake group
      expect(l.fixtures.length).toBe(ELEVATOR_CAB.troffers);
      l.fixtures.forEach((f, i) => {
        expect(f.id).toBe(structureFixtureId(id, SALT.ELEVATOR, i) >>> 0);
        expect(f.seed).toBe(fixtureSeed(f.id));
        expect(f.bakeGroup).toBe(id);
        expect(f.luminance).toBe(2000);
      });
      // no ELEVATOR_DOOR props (WP12 owns the leaves)
      expect(l.props.some((p) => p.kind === PropKind.ELEVATOR_DOOR)).toBe(false);
      // exactly one DOORWAY between cab (v = 1) and lobby (v = 2), and it is 1 cell wide; cab walls are METAL_PAINTED
      const st = l.structures.find((s) => s.kind === StructureKind.ELEVATOR);
      expect(st).toBeDefined();
      expect(st!.bakeGroup).toBe(id);
      expect(st!.portal!.kind).toBe('elevator');
      expect(st!.portal!.towerId).toBe(id);
      // portal = the cab AABB (the 2x2 cells with v in {0, 1})
      const cabCells: number[][] = [];
      for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) if (l.ceilCm[cellIdx(li, lj)] === ELEVATOR_CAB.ceilCm) cabCells.push([li, lj]);
      expect(cabCells.length).toBe(4);
      const mnI = Math.min(...cabCells.map((c) => c[0])), mxI = Math.max(...cabCells.map((c) => c[0])) + 1;
      const mnJ = Math.min(...cabCells.map((c) => c[1])), mxJ = Math.max(...cabCells.map((c) => c[1])) + 1;
      expect(st!.portal!.min[0]).toBeCloseTo(mnI * CELL, 6);
      expect(st!.portal!.max[0]).toBeCloseTo(mxI * CELL, 6);
      expect(st!.portal!.min[2]).toBeCloseTo(mnJ * CELL, 6);
      expect(st!.portal!.max[2]).toBeCloseTo(mxJ * CELL, 6);
      let doors = 0, cabWalls = 0;
      const isCab = (li: number, lj: number): boolean => cabCells.some((c) => c[0] === li && c[1] === lj);
      for (const [li, lj] of cabCells) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isCab(li + dx, lj + dz)) continue;
          const k = dx !== 0 ? l.ex.kind[exIdx(dx > 0 ? li + 1 : li, lj)] : l.ez.kind[ezIdx(li, dz > 0 ? lj + 1 : lj)];
          const inMat = dx !== 0 ? (dx > 0 ? l.ex.matNeg[exIdx(li + 1, lj)] : l.ex.matPos[exIdx(li, lj)]) : (dz > 0 ? l.ez.matNeg[ezIdx(li, lj + 1)] : l.ez.matPos[ezIdx(li, lj)]);
          if (k === EdgeKind.DOORWAY) doors++;
          else { expect(k).toBe(EdgeKind.WALL); cabWalls++; }
          expect(inMat).toBe(Mat.METAL_PAINTED);
        }
      }
      expect(doors).toBe(1);
      expect(cabWalls).toBe(7);
      // exit cell: outside the footprint, in front of the lobby, facing the cab
      const e = elevatorExitCell(site);
      expect(e.li >= i0 && e.li < i1 && e.lj >= j0 && e.lj < j1).toBe(false);
      const fwd = { x: 0, z: 0 };
      forwardXZ(e.yaw, fwd);
      const ni = e.li + Math.round(fwd.x), nj = e.lj + Math.round(fwd.z);
      expect(l.flags[cellIdx(ni, nj)] & CellFlag.ELEVATOR).toBeTruthy();
      expect(l.ceilCm[cellIdx(ni, nj)]).not.toBe(ELEVATOR_CAB.ceilCm); // the lobby strip
      // the lobby cell in front of the exit leads straight to the door
      const ci = ni + Math.round(fwd.x), cj = nj + Math.round(fwd.z);
      expect(isCab(ci, cj)).toBe(true);
      const k = Math.abs(fwd.x) > 0.5 ? l.ex.kind[exIdx(Math.max(ni, ci), nj)] : l.ez.kind[ezIdx(ni, Math.max(nj, cj))];
      expect(k).toBe(EdgeKind.DOORWAY);
    });
  }

  it('cab content is identical in all three storeys', () => {
    const site: ElevatorSite = { id: 99991, cx: 0, cz: 0, i0: 6, j0: 6, rot: 1 };
    const fx = [0, 1, 2].map((s) => JSON.stringify(stampedElevator(site, s as StoreyId).l.fixtures));
    expect(fx[1]).toBe(fx[0]);
    expect(fx[2]).toBe(fx[0]);
  });

  it('WRONG_ELEVATOR: p 0.1 per elevator, hashed from the id; sets portal.wrong and an AnomalySite', () => {
    let wrong = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (isWrongElevator({ id: 1000 + i * 7919 })) wrong++;
    expect(Math.abs(wrong / n - 0.1)).toBeLessThan(0.02);
    let tested = 0;
    for (let i = 0; tested < 3 && i < 500; i++) {
      const site: ElevatorSite = { id: 1000 + i * 7919, cx: 0, cz: 0, i0: 8, j0: 8, rot: 0 };
      if (!isWrongElevator(site)) continue;
      const { l } = stampedElevator(site);
      expect(l.structures[0].portal!.wrong).toBe(true);
      expect(l.anomalies.some((a) => a.kind === AnomalyKind.WRONG_ELEVATOR)).toBe(true);
      tested++;
    }
    expect(tested).toBe(3);
  });

  it('elevator footprint is 2x3 cells', () => {
    expect([ELEVATOR.W_CELLS, ELEVATOR.L_CELLS]).toEqual([2, 3]);
  });
});

// ------------------------------------------------------------------------------------------ glitch walls

/** Solid mass with an L-shaped corridor that ends in a dead end at (20, 10); the corridor leaves via the W seam. */
function deadEndLayout(): ChunkLayout {
  const l = openLayout(1, 7, 9, Zone.CONCRETE);
  l.flags.fill(CellFlag.SOLID);
  const open = (li: number, lj: number): void => { l.flags[cellIdx(li, lj)] = 0; };
  for (let li = 0; li <= 20; li++) open(li, 10);
  // walls around the corridor
  for (let li = 0; li <= 20; li++) { l.ez.kind[ezIdx(li, 10)] = EdgeKind.WALL; l.ez.kind[ezIdx(li, 11)] = EdgeKind.WALL; }
  l.ex.kind[exIdx(21, 10)] = EdgeKind.WALL;
  return l;
}

describe('glitch walls', () => {
  it('placeGlitchWallIn turns the dead-end WALL into GLITCH with portal, anomaly and BUZZ emitter', () => {
    const l = deadEndLayout();
    const ctx = ctxFor(l, 11);
    const r = placeGlitchWallIn(ctx, new Rng(3));
    expect(r).not.toBeNull();
    expect(r!.li).toBe(20);
    expect(r!.lj).toBe(10);
    expect(l.ex.kind[exIdx(21, 10)]).toBe(EdgeKind.GLITCH);
    const st = l.structures.find((s) => s.kind === StructureKind.GLITCH)!;
    expect(st).toBeDefined();
    expect([st.i0, st.j0, st.i1, st.j1]).toEqual([20, 10, 21, 11]);
    const p = st.portal!;
    expect(p.kind).toBe('glitch');
    expect(p.towerId).toBe(0);
    expect(p.endless).toBe(false);
    // the edge AABB grown by radius + 5 cm on the walkable (dead-end) side, y in [floor, floor + 2]
    expect(p.min[0]).toBeCloseTo(21 * CELL - WALL_T / 2 - (PLAYER.radius + 0.05), 6);
    expect(p.max[0]).toBeCloseTo(21 * CELL + WALL_T / 2, 6);
    expect(p.min[2]).toBeCloseTo(10 * CELL, 6);
    expect(p.max[2]).toBeCloseTo(11 * CELL, 6);
    expect(p.min[1]).toBe(0);
    expect(p.max[1]).toBe(2);
    expect(l.anomalies.some((a) => a.kind === AnomalyKind.GLITCH_WALL)).toBe(true);
    const em = l.emitters.find((e) => e.kind === EmitterKind.BUZZ)!;
    expect(em.gain).toBe(0.15);
    expect(em.y).toBeCloseTo(1.2, 6);
  });

  it('placeGlitchWalls: p 0.03 per chunk, never in the spawn district', () => {
    let hits = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) {
      const l = deadEndLayout();
      (l.key as { cx: number }).cx = i;
      const ctx = ctxFor(l, 5);
      placeGlitchWalls(ctx);
      if (l.structures.length) hits++;
    }
    expect(Math.abs(hits / n - GLITCH_P)).toBeLessThan(0.012);
    // spawn district: the district at chunk (0, 0) of the storey
    let spawnHits = 0;
    for (let i = 0; i < 1500; i++) {
      const l = deadEndLayout();
      (l.key as { cx: number }).cx = i;
      const ctx = ctxFor(l, 5);
      ctx.world = { ...ctx.world, districtAt: () => ctx.district };
      placeGlitchWalls(ctx);
      if (l.structures.length) spawnHits++;
    }
    expect(spawnHits).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ pits

describe('pits', () => {
  it('placePitIn: 2x2 VOID hole inside a >= 5x5 open block, OPEN edges, debris ring, PIT portal y in [-6, -1.5]', () => {
    const l = openLayout(0, 2, 2, Zone.LOBBY);
    // a 7x7 room in the middle of solid mass, reached from the W seam by a corridor
    l.flags.fill(CellFlag.SOLID);
    for (let lj = 10; lj < 17; lj++) for (let li = 10; li < 17; li++) l.flags[cellIdx(li, lj)] = 0;
    for (let li = 0; li < 10; li++) l.flags[cellIdx(li, 13)] = 0;
    const ctx = ctxFor(l, 21);
    const keep = computeKeepClear(l);
    const at = placePitIn(ctx, 12345);
    expect(at).not.toBeNull();
    const [pi, pj] = at!;
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const c = cellIdx(pi + di, pj + dj);
      expect(l.flags[c] & CellFlag.VOID).toBeTruthy();
      expect(keep[c]).toBe(0);
    }
    // the hole is inside the room, with open floor on every side (a walkable ring)
    expect(pi).toBeGreaterThanOrEqual(11);
    expect(pj).toBeGreaterThanOrEqual(11);
    expect(pi + 2).toBeLessThanOrEqual(16);
    expect(pj + 2).toBeLessThanOrEqual(16);
    for (let dj = -1; dj <= 2; dj++) for (let i = pi - 1; i <= pi + 2; i++) {
      expect(l.ex.kind[exIdx(i + 1, pj + dj)]).toBe(EdgeKind.OPEN);
    }
    const st = l.structures.find((s) => s.kind === StructureKind.PIT)!;
    expect([st.i0, st.j0, st.i1, st.j1]).toEqual([pi, pj, pi + 2, pj + 2]);
    expect(st.portal!.kind).toBe('pit');
    expect(st.portal!.min).toEqual([pi * CELL, -TOWER_SPAN, pj * CELL]);
    expect(st.portal!.max).toEqual([(pi + 2) * CELL, -1.5, (pj + 2) * CELL]);
    expect(l.props.some((p) => p.kind === PropKind.CEILING_DEBRIS)).toBe(true);
    // every debris prop lies on the ring, never over the hole
    for (const p of l.props) {
      const li = Math.floor(p.x / CELL), lj = Math.floor(p.z / CELL);
      expect(li >= pi && li < pi + 2 && lj >= pj && lj < pj + 2).toBe(false);
    }
  });

  it('placePitIn refuses rooms smaller than 5x5', () => {
    const l = openLayout(0, 2, 2, Zone.LOBBY);
    l.flags.fill(CellFlag.SOLID);
    for (let lj = 10; lj < 14; lj++) for (let li = 10; li < 20; li++) l.flags[cellIdx(li, lj)] = 0; // 10 x 4
    expect(placePitIn(ctxFor(l, 21), 1)).toBeNull();
  });

  it('placePits: p 0.08 per chunk where the district-mean decay > 0.5, p 0.03 anywhere else (R2)', () => {
    const count = (decay: number): number => {
      let hits = 0;
      for (let i = 0; i < 2500; i++) {
        const l = openLayout(0, i, 3, Zone.LOBBY);
        const ctx: ZoneGenContext = ctxFor(l, 31);
        const f: FieldSampler = { power: () => 0.5, decay: () => decay, humidity: () => 0.3, warmth: () => 0.5 };
        ctx.fields = f;
        placePits(ctx);
        if (l.structures.some((s) => s.kind === StructureKind.PIT)) hits++;
      }
      return hits / 2500;
    };
    expect(Math.abs(count(0.3) - PIT_P_ANY)).toBeLessThan(0.015);
    expect(Math.abs(count(0.5) - PIT_P_ANY)).toBeLessThan(0.015);
    expect(Math.abs(count(0.9) - PIT_P)).toBeLessThan(0.02);
  });
});

// ------------------------------------------------------------------------------------------ landmarks

describe('landmark registry', () => {
  it('LANDMARKS[k].kind === k for all 13 kinds, positive weights, >= 4 kinds per storey', () => {
    expect(LANDMARKS.length).toBe(LANDMARK_COUNT);
    LANDMARKS.forEach((lg, k) => {
      expect(lg.kind, LANDMARK_NAMES[k]).toBe(k);
      expect(lg.weight).toBeGreaterThan(0);
      expect(lg.storeys.length).toBeGreaterThan(0);
    });
    for (const s of [0, 1, 2] as StoreyId[]) expect(LANDMARKS.filter((lg) => lg.storeys.includes(s)).length).toBeGreaterThanOrEqual(4);
  });

  it('footprints and storeys follow the spec table', () => {
    const want: [number, number[], number, number][] = [
      // R2 (B4) cross-storey restyles: RED_ROOM on 0-1, LOCKED_EXIT / VENDING_ALCOVE on all storeys, SERVER_ROOM on 0-1
      [LandmarkKind.RED_ROOM, [0, 1], 6, 6], [LandmarkKind.ENDLESS_HALL, [0, 1], 32, 2], [LandmarkKind.ATRIUM, [2], 18, 18],
      [LandmarkKind.CHAIR_CATHEDRAL, [0], 24, 24], [LandmarkKind.FLOODED_HALL, [0, 1], 12, 16], [LandmarkKind.LOCKED_EXIT, [0, 1, 2], 8, 3],
      [LandmarkKind.VENDING_ALCOVE, [0, 1, 2], 4, 3], [LandmarkKind.SERVER_ROOM, [0, 1], 8, 8], [LandmarkKind.DEEP_END, [2], 12, 12],
      [LandmarkKind.SKYLIGHT_HALL, [2], 16, 12], [LandmarkKind.LOCKER_ROOM, [2], 10, 8], [LandmarkKind.LOADING_DOCK, [1], 14, 10],
      [LandmarkKind.BOILER_HALL, [1], 12, 12],
    ];
    for (const [k, storeys, w, h] of want) {
      expect([...LANDMARKS[k].storeys], LANDMARK_NAMES[k]).toEqual(storeys);
      expect(LANDMARKS[k].footprint, LANDMARK_NAMES[k]).toEqual([w, h]);
    }
  });
});

/** Generate chunk (0,0) of `s` with forceLandmark = kind, capturing the entrances `stamp` returned. */
function forced(seed: number, kind: number, s: StoreyId): { l: ChunkLayout; entrances: [number, number][] } {
  const lg = LANDMARKS[kind];
  const orig = lg.stamp;
  let entrances: [number, number][] = [];
  lg.stamp = (g, ctx, site) => {
    const r = orig.call(lg, g, ctx, site);
    entrances = r.entrances.map((e) => [e[0], e[1]]);
    return r;
  };
  try {
    const l = createWorldGen(opts(seed, { forceLandmark: kind as never })).generateChunk({ s, cx: 0, cz: 0 });
    return { l, entrances };
  } finally {
    lg.stamp = orig;
  }
}

describe('landmark stamping', () => {
  it('every kind stamps, claims LANDMARK cells and returns walkable entrances in every storey it lists', () => {
    for (let k = 0; k < LANDMARK_COUNT; k++) {
      for (const s of LANDMARKS[k].storeys) {
        let ok = 0;
        for (let seed = 1; seed <= 4; seed++) {
          const { l, entrances } = forced(seed * 101 + k, k, s);
          const m = l.landmarks.find((x) => x.kind === k);
          if (!m) continue;
          ok++;
          expect(entrances.length, `${LANDMARK_NAMES[k]} s${s}`).toBeGreaterThan(0);
          // authored fixtures never intersect a wall; every landmark fixture / prop lies inside the chunk
          for (const f of l.fixtures) {
            const c = cellIdx(Math.min(N - 1, Math.floor(f.px / CELL)), Math.min(N - 1, Math.floor(f.pz / CELL)));
            if (!(l.flags[c] & CellFlag.LANDMARK)) continue;
            expect(fixtureHitsWall(l, f), `${LANDMARK_NAMES[k]} s${s} fixture kind ${f.kind} at ${f.px.toFixed(2)},${f.py.toFixed(2)},${f.pz.toFixed(2)}`).toBe(false);
          }
          let cellsIn = 0;
          for (let lj = m.j0; lj < m.j1; lj++) for (let li = m.i0; li < m.i1; li++) if (l.flags[cellIdx(li, lj)] & CellFlag.LANDMARK) cellsIn++;
          expect(cellsIn).toBe((m.i1 - m.i0) * (m.j1 - m.j0));
          // >= 2 cells from the seam lines (ENDLESS_HALL spans the chunk)
          if (k !== LandmarkKind.ENDLESS_HALL) {
            expect(Math.min(m.i0, m.j0)).toBeGreaterThanOrEqual(2);
            expect(Math.max(m.i1, m.j1)).toBeLessThanOrEqual(N - 2);
            const [w, h] = LANDMARKS[k].footprint;
            const dims = [m.i1 - m.i0, m.j1 - m.j0].sort((a, b) => a - b);
            expect(dims).toEqual([w, h].sort((a, b) => a - b));
          }
        }
        expect(ok, `${LANDMARK_NAMES[k]} s${s} placed`).toBeGreaterThanOrEqual(3);
      }
    }
  }, 240_000);

  it('entrances are walkable and reachable after repair (1000 chunks, forceLandmark rotation)', () => {
    const total = Number(process.env.WP4_LANDMARK_CHUNKS ?? 1000);
    const pairs: [number, StoreyId][] = [];
    for (let k = 0; k < LANDMARK_COUNT; k++) for (const s of LANDMARKS[k].storeys) pairs.push([k, s]);
    let placed = 0, entrancesChecked = 0;
    for (let i = 0; i < total; i++) {
      const [k, s] = pairs[i % pairs.length];
      const { l, entrances } = forced(7000 + i, k, s);
      if (!l.landmarks.some((m) => m.kind === k)) continue;
      placed++;
      const seen = reachable(l);
      for (const [li, lj] of entrances) {
        const c = cellIdx(li, lj);
        expect(cellWalkable(l, c), `${LANDMARK_NAMES[k]} seed ${7000 + i}: entrance (${li},${lj}) walkable`).toBe(true);
        expect(seen[c], `${LANDMARK_NAMES[k]} seed ${7000 + i}: entrance (${li},${lj}) reachable`).toBe(1);
        entrancesChecked++;
      }
    }
    expect(placed).toBeGreaterThan(total * 0.9);
    expect(entrancesChecked).toBeGreaterThan(placed);
  }, 600_000);
});

// ------------------------------------------------------------------------------------------ R2 architecture stamps

import { buildLightWell, buildSplitHall, SPLIT_DEPTHS, stairRect, WELL_DEPTH_CM, type SplitHall } from '../../src/world/structures/splitLevel.ts';
import { missingTiles, openCeiling, removedFixtures } from '../../src/world/structures/plenum.ts';
import { DEAD_END_MAX, hangDoors } from '../../src/world/structures/doors.ts';
import { windowWall, WINDOW_HEAD, WINDOW_SILL } from '../../src/world/structures/windows.ts';
import { unreachedWalkable } from '../../src/world/structures/util.ts';
import { CeilKind, FixtureKind, TileState } from '../../src/core/ids.ts';
import { getTile } from '../../src/core/layout.ts';

const hallSpec = (o: Partial<SplitHall> = {}): SplitHall => ({
  i0: 8, j0: 6, i1: 17, j1: 19, depthCm: 300, stairAxis: 'z', stairSide: -1, stairHead: -1, stairW: 2, stairL: 5,
  wallMat: Mat.WALLPAPER_L0, stairMat: Mat.CARPET_L0, parapetMat: Mat.WALLPAPER_L0, columns: true,
  pendant: { kind: FixtureKind.PENDANT_LINEAR, luminance: 9000, cct: [3700, 4600], w: 1.2, h: 0.2 }, ...o,
});
const kindAt = (l: ChunkLayout, axis: 'x' | 'z', i: number, j: number): number => (axis === 'x' ? l.ex.kind[exIdx(i, j)] : l.ez.kind[ezIdx(i, j)]);

describe('R2 split-level hall', () => {
  for (const [depth, axis, side, head] of [[300, 'z', -1, -1], [450, 'z', 1, 1], [300, 'x', 1, -1], [450, 'x', -1, 1]] as const) {
    it(`depth ${depth}, stair along ${axis} (side ${side}, head ${head}): sunken hall, parapet, open stair head, 15-step ramp, all reachable`, () => {
      const l = openLayout(0, 2, 2);
      const ctx = ctxFor(l, 5);
      const dims = axis === 'z' ? { i0: 8, j0: 6, i1: 17, j1: 19 } : { i0: 6, j0: 8, i1: 19, j1: 17 }; // long along the stair
      const h = hallSpec({ ...dims, depthCm: depth, stairAxis: axis, stairSide: side, stairHead: head, stairL: depth > 300 ? 7 : 5 });
      const info = buildSplitHall(ctx, h);
      expect(SPLIT_DEPTHS).toContain(depth);
      const [si0, sj0, si1, sj1] = stairRect(h);
      expect(info.stair).toEqual([si0, sj0, si1, sj1]);
      for (let lj = h.j0; lj < h.j1; lj++) for (let li = h.i0; li < h.i1; li++) {
        const c = cellIdx(li, lj);
        expect(l.floorCm[c]).toBe(-depth);
        expect(l.ceilCm[c] - l.floorCm[c]).toBe(270 + depth);
      }
      // perimeter: HALF at base + 95, except the stair head (OPEN)
      let heads = 0;
      for (let lj = h.j0; lj < h.j1; lj++) for (const i of [h.i0, h.i1]) {
        const k = kindAt(l, 'x', i, lj);
        if (k === EdgeKind.OPEN) heads++; else { expect(k).toBe(EdgeKind.HALF); expect(l.ex.hA[exIdx(i, lj)]).toBe(95); }
      }
      for (let li = h.i0; li < h.i1; li++) for (const j of [h.j0, h.j1]) {
        const k = kindAt(l, 'z', li, j);
        if (k === EdgeKind.OPEN) heads++; else { expect(k).toBe(EdgeKind.HALF); expect(l.ez.hA[ezIdx(li, j)]).toBe(95); }
      }
      expect(heads).toBe(h.stairW);
      const ramps = l.solids.filter((s) => s.kind === 'ramp');
      expect(ramps.length).toBe(1);
      const r = ramps[0];
      if (r.kind === 'ramp') {
        expect(r.steps).toBe(15);
        expect([r.y0, r.y1]).toEqual([-depth / 100, 0]);
        expect([r.x0, r.z0, r.x1, r.z1]).toEqual([si0 * CELL, sj0 * CELL, si1 * CELL, sj1 * CELL]);
      }
      // columns stand on the hall floor, wrapped by walls; pendants hang 3 m above it
      expect(info.columns).toBeGreaterThan(0);
      expect(info.pendants).toBeGreaterThan(0);
      for (const f of l.fixtures) { expect(f.kind).toBe(FixtureKind.PENDANT_LINEAR); expect(f.py).toBeCloseTo(-depth / 100 + 3, 5); }
      // every walkable cell (hall included) is reachable from the ports through the stair
      expect(unreachedWalkable(l)).toBe(0);
      const seen = reachable(l);
      let hallReached = 0;
      for (let lj = h.j0; lj < h.j1; lj++) for (let li = h.i0; li < h.i1; li++) if (seen[cellIdx(li, lj)]) hallReached++;
      expect(hallReached).toBe((h.i1 - h.i0) * (h.j1 - h.j0) - info.columns);
    });
  }
});

describe('R2 light well, open ceiling, missing tiles', () => {
  it('buildLightWell: NOWALK shaft 6 m down, RAIL rim, water with an underwater lamp or a lit floor', () => {
    for (const water of [true, false]) {
      const l = openLayout(0, 1, 1);
      const ctx = ctxFor(l, 9);
      buildLightWell(ctx, { i0: 10, j0: 10, i1: 13, j1: 13, water }, 1);
      for (let lj = 10; lj < 13; lj++) for (let li = 10; li < 13; li++) {
        const c = cellIdx(li, lj);
        expect(l.flags[c] & CellFlag.NOWALK).toBeTruthy();
        expect(l.floorCm[c]).toBe(-WELL_DEPTH_CM);
      }
      for (let k = 10; k < 13; k++) for (const e of [10, 13]) { expect(kindAt(l, 'x', e, k)).toBe(EdgeKind.RAIL); expect(kindAt(l, 'z', k, e)).toBe(EdgeKind.RAIL); }
      expect(l.fixtures.some((f) => f.kind === (water ? FixtureKind.UNDERWATER : FixtureKind.CAGE_BULB) && f.py < -3.5)).toBe(true);
      expect(l.water.length).toBe(water ? 1 : 0);
      expect(unreachedWalkable(l)).toBe(0);
    }
  });

  it('openCeiling: NO_CEIL + OPEN_DARK cells up to the deck, deck / duct solids inside the patch', () => {
    const l = openLayout(0, 1, 1);
    const ctx = ctxFor(l, 3);
    const info = openCeiling(ctx, 4, 5, 7, 9, new Rng(4));
    expect(info.cells).toBe(12);
    for (let lj = 5; lj < 9; lj++) for (let li = 4; li < 7; li++) {
      const c = cellIdx(li, lj);
      expect(l.flags[c] & CellFlag.NO_CEIL).toBeTruthy();
      expect(l.ceilKind[c]).toBe(CeilKind.OPEN_DARK);
      expect(l.ceilCm[c]).toBeGreaterThanOrEqual(270 + 80);
    }
    const deck = l.solids.find((s) => s.kind === 'box' && s.mat === Mat.METAL_DECK);
    expect(deck).toBeDefined();
    for (const s of l.solids) {
      if (s.kind !== 'box') continue;
      expect(s.min[0]).toBeGreaterThanOrEqual(4 * CELL - 1e-9); expect(s.max[0]).toBeLessThanOrEqual(7 * CELL + 1e-9);
      expect(s.min[2]).toBeGreaterThanOrEqual(5 * CELL - 1e-9); expect(s.max[2]).toBeLessThanOrEqual(9 * CELL + 1e-9);
      expect(s.min[1]).toBeGreaterThan(2.7); // everything in the plenum is above the old ceiling line
    }
  });

  it('missingTiles / removedFixtures: tile states only on TILES cells; pulled slots leave no lattice rect', () => {
    const l = openLayout(0, 1, 1);
    const ctx = ctxFor(l, 3);
    const n = missingTiles(ctx, 0, 0, 8, 8, 0.5, new Rng(1));
    expect(n).toBeGreaterThan(40);
    let miss = 0;
    for (let c = 0; c < N * N; c++) for (let t = 0; t < 4; t++) if (getTile(l.tiles, c, t) === TileState.MISSING) miss++;
    expect(miss).toBe(n);
    const l2 = openLayout(0, 1, 1);
    const ctx2 = ctxFor(l2, 3);
    expect(removedFixtures(ctx2, 0, 0, N, N)).toBeGreaterThan(0);
  });
});

describe('R2 door leaves', () => {
  /** A corridor along z = 10..11 with rooms off it: a 3x3 dead-end room (one door) and a through room (two doors). */
  function doorLayout(): ChunkLayout {
    const l = openLayout(0, 4, 4);
    const g = createChunkGrid(l, 1);
    // dead-end room [4,7) x [4,7): walls, one door on its south side at x = 5
    g.rectWalls(4, 4, 7, 7, EdgeKind.WALL);
    g.setEdge('z', 5, 7, EdgeKind.DOORWAY, { hA: 210 });
    // through room [12,16) x [4,8): doors south and north
    g.rectWalls(12, 4, 16, 8, EdgeKind.WALL);
    g.setEdge('z', 13, 8, EdgeKind.DOORWAY, { hA: 210 });
    g.setEdge('z', 14, 4, EdgeKind.DOORWAY, { hA: 210 });
    return l;
  }
  it('p 1: every doorway gets a leaf; stuck (ajar / closed) leaves only on the dead-end room; open ones stand clear', () => {
    let stuckDead = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const l = doorLayout();
      const ctx = ctxFor(l, seed);
      const n = hangDoors(ctx, { p: 1, variant: () => 1, tag: seed });
      expect(n.doorways).toBe(3);
      expect(n.leaves).toBe(3);
      for (const p of l.props) {
        expect(p.kind).toBe(PropKind.DOOR_LEAF);
        // a stuck leaf lies (nearly) in the door plane; only the dead-end room's door may hold one
        const across = Math.abs(Math.cos(p.yaw)) > 0.5; // local +x along world x: the leaf spans x
        const nearDead = Math.abs(p.x - 5.5 * CELL) < 1 && Math.abs(p.z - 7 * CELL) < 1;
        if (across && Math.abs(p.z - Math.round(p.z / CELL) * CELL) < 0.35) { expect(nearDead).toBe(true); stuckDead++; }
      }
      expect(n.open + n.ajar + n.closed).toBe(3);
    }
    expect(stuckDead).toBeGreaterThan(0);
    expect(DEAD_END_MAX).toBeGreaterThanOrEqual(9);
  });
  it('open leaves never swing into a 1-cell corridor running along the door line (they would wall it off)', () => {
    let leaves = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const l = openLayout(0, 4, 4);
      const g = createChunkGrid(l, 1);
      // a 1-cell corridor j = 10 over i = 1..30 (30 cells: not a dead end), a 6x6 room north of it, door at i = 10
      g.rectWalls(1, 10, 31, 11, EdgeKind.WALL);
      g.rectWalls(8, 4, 14, 10, EdgeKind.WALL);
      g.setEdge('z', 10, 10, EdgeKind.DOORWAY, { hA: 210 });
      const ctx = ctxFor(l, seed);
      const n = hangDoors(ctx, { p: 1, variant: () => 1, tag: seed });
      expect(n.ajar + n.closed).toBe(0);
      for (const p of l.props) {
        if (p.kind !== PropKind.DOOR_LEAF) continue;
        leaves++;
        expect(p.z).toBeLessThan(10 * CELL); // on the room side of the door line
      }
    }
    expect(leaves).toBeGreaterThan(50);
  });
});

describe('R2 windows to nowhere', () => {
  it('a WALL run becomes WINDOW edges backed by a SOLID strip with a 6500 K panel each; nothing is cut off', () => {
    let built = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const l = openLayout(0, 2, 3);
      const g = createChunkGrid(l, seed);
      g.wallRun('x', 12, 6, 14, EdgeKind.WALL);
      const ctx = ctxFor(l, seed);
      const run = windowWall(ctx, new Rng(seed), null, Mat.WALLPAPER_L0);
      if (!run) continue;
      built++;
      expect(unreachedWalkable(l)).toBe(0);
      let windows = 0;
      for (let c = run.c0; c < run.c1; c++) {
        const k = kindAt(l, run.axis, run.axis === 'x' ? run.line : c, run.axis === 'x' ? c : run.line);
        if (k === EdgeKind.WINDOW) {
          windows++;
          const e = run.axis === 'x' ? exIdx(run.line, c) : ezIdx(c, run.line);
          const eg = run.axis === 'x' ? l.ex : l.ez;
          expect([eg.hA[e], eg.hB[e]]).toEqual([WINDOW_SILL, WINDOW_HEAD]);
        }
        const bi = run.axis === 'x' ? (run.side < 0 ? run.line - 1 : run.line) : c, bj = run.axis === 'x' ? c : (run.side < 0 ? run.line - 1 : run.line);
        expect(l.flags[cellIdx(bi, bj)] & CellFlag.SOLID).toBeTruthy();
      }
      expect(windows).toBe(run.windows);
      const panels = l.fixtures.filter((f) => f.kind === FixtureKind.SODIUM);
      expect(panels.length).toBe(windows);
      for (const f of panels) { expect(Math.abs(f.ny)).toBe(0); expect(f.luminance).toBeGreaterThan(400); expect(f.color[2]).toBeGreaterThan(0.9); }
    }
    expect(built).toBeGreaterThan(10);
  });
});
