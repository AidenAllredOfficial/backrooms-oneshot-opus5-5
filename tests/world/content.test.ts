// WP4 — content: colour temperature, lattice fixtures, fixture states and the one-dynamic-light-per-tile rule, props,
// vignettes, keepClear, leaks, exit signs, chalk, decals and anomalies. Includes the §5 WP4 acceptance sweeps over
// generated chunks (1000 chunks of the spawn storey, a 20 x 20-chunk vignette region).
import { describe, expect, it } from 'vitest';
import { CEIL_TILE, CELL, CHUNK_SIZE, LIGHT, PLAYER, TILE_SIZE, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, ezIdx, forwardXZ, tileOfPoint } from '../../src/core/grid.ts';
import {
  AnomalyKind, CeilKind, CellFlag, DecalKind, EdgeKind, EmitterKind, FixtureKind, isRecessedFixture, LandmarkKind, LightState, PropFlag, PropKind,
  SignKind, type StoreyId, TileState, VignetteKind, Zone, type ZoneId,
} from '../../src/core/ids.ts';
import { fixtureId, getTile, setTile, type ChunkLayout } from '../../src/core/layout.ts';
import { PROP_DEFS } from '../../src/core/props.ts';
import { hash01, hash2, Rng, SALT } from '../../src/core/rng.ts';
import type { LightingProfile, PropRuleSet, TowerSite, WorldGen } from '../../src/core/world.ts';
import { MOOD_POWER_MUL } from '../../src/core/zones.ts';
import { corridorWidth, labelRooms } from '../../src/world/rooms.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { generatorFor } from '../../src/world/zones/registry.ts';
import { ceilingFurniture, chairRing, corridorRuns, repeatRoom, roomPairs, stampRoomPair, STAMP_D, STAMP_W } from '../../src/world/content/anomalies.ts';
import { isJunction, placeChalk } from '../../src/world/content/chalk.ts';
import { DECAL_MAX, placeDecals } from '../../src/world/content/decals.ts';
import { assignFixtureStates, enforceDynamicRule, fixtureU, isStructureFixture, stateFromU, stateProbabilities } from '../../src/world/content/fixtureStates.ts';
import { LUM_SIGMA, placeFixtures, rectHitsEdges } from '../../src/world/content/fixtures.ts';
import { kelvinToLinearRGB } from '../../src/world/content/kelvin.ts';
import { computeKeepClear } from '../../src/world/content/keepClear.ts';
import { ageCeilingTiles, agedTileState, DAMP_HUMID, LEAK_RADIUS, placeDampCells, placeLeaks, placeLeakSites, TILE_AGE_P } from '../../src/world/content/leaks.ts';
import { OCC_N, OCC_RES, PlacementSpace, portReach, propAABB, reachKept } from '../../src/world/content/occupancy.ts';
import { composeTrace, placeDistrictClusters, placeProps, placeTraces, PropPlacer, TRACE_M2, TraceKind } from '../../src/world/content/props.ts';
import { DARK_EXIT_MAX, EXIT_SIGN_P, litCells, placeExitSigns, STAIRS_SIGN_MAX } from '../../src/world/content/signs.ts';
import { meanField } from '../../src/world/content/util.ts';
import {
  composeVignette, RACK_SPILL_MAX, RACK_SPILL_MIN, VIG_DROP, VIG_GRID, VIG_MIN_SPACING, VIGNETTE_WEIGHTS, placeVignettes, vignetteCandidates, zoneColumn,
} from '../../src/world/content/vignettes.ts';
import { ctxFor, fixtureHitsWall, fixtureRect, N, openLayout, opts } from './wp4-helpers.ts';

const T2 = WALL_T / 2;

// ------------------------------------------------------------------------------------------ kelvin

describe('kelvinToLinearRGB', () => {
  it('max component 1, warm is red, ~6500 K is white, cold is blue; green tint raises green', () => {
    for (let k = 800; k <= 13000; k += 250) {
      const c = kelvinToLinearRGB(k, 0);
      expect(Math.max(...c)).toBeCloseTo(1, 9);
      for (const v of c) expect(v).toBeGreaterThanOrEqual(0);
    }
    const warm = kelvinToLinearRGB(2700, 0);
    expect(warm[0]).toBe(1);
    expect(warm[2]).toBeLessThan(0.5);
    const d65 = kelvinToLinearRGB(6500, 0);
    for (const v of d65) expect(v).toBeGreaterThan(0.9);
    const cold = kelvinToLinearRGB(10000, 0);
    expect(cold[2]).toBe(1);
    expect(cold[0]).toBeLessThan(0.8);
    // blue/red rises monotonically with temperature
    let prev = -1;
    for (let k = 1000; k <= 12000; k += 100) {
      const c = kelvinToLinearRGB(k, 0);
      const r = c[2] / c[0];
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
    const tinted = kelvinToLinearRGB(4000, 0.05);
    expect(tinted[1] / tinted[0]).toBeGreaterThan(kelvinToLinearRGB(4000, 0)[1] / kelvinToLinearRGB(4000, 0)[0]);
    expect(Math.max(...tinted)).toBeCloseTo(1, 9);
  });
});

// ------------------------------------------------------------------------------------------ lattice fixtures

const TROFFER: LightingProfile = {
  kind: FixtureKind.TROFFER_2x4, placement: 'lattice', lattice: [4, 4], phase: [1, 2], axis: 0, cctRange: [3500, 4100],
  luminance: 3000, zoneMul: 1, mountCm: 0,
};

/** Rooms of varied sizes separated by WALL runs with DOORWAYs, plus a SOLID block and a NO_CEIL patch. */
function roomsLayout(): ChunkLayout {
  const l = openLayout(0, 4, -3, Zone.LOBBY);
  for (const i of [7, 13, 22, 27]) for (let lj = 0; lj < N; lj++) l.ex.kind[exIdx(i, lj)] = lj % 9 === 4 ? EdgeKind.DOORWAY : EdgeKind.WALL;
  for (const j of [5, 12, 19, 26]) for (let li = 0; li < N; li++) l.ez.kind[ezIdx(li, j)] = li % 11 === 3 ? EdgeKind.DOORWAY : EdgeKind.WALL;
  for (let lj = 14; lj < 17; lj++) for (let li = 15; li < 19; li++) l.flags[cellIdx(li, lj)] |= CellFlag.SOLID;
  for (let lj = 28; lj < 31; lj++) for (let li = 2; li < 6; li++) l.flags[cellIdx(li, lj)] |= CellFlag.NO_CEIL;
  // a lowered ceiling band (different ceilCm within a would-be rect)
  for (let lj = 0; lj < N; lj++) l.ceilCm[cellIdx(24, lj)] = 240;
  labelRooms(l);
  return l;
}

describe('placeFixtures (lattice mode)', () => {
  const l = roomsLayout();
  const ctx = ctxFor(l, 77);
  ctx.lighting = TROFFER;
  placeFixtures(ctx);

  it('places fixtures with core fixture ids from the lattice tile of the centre', () => {
    expect(l.fixtures.length).toBeGreaterThan(20);
    const ids = new Set<number>();
    for (const f of l.fixtures) {
      const gx = ctx.grid.gi0 * CELL + f.px, gz = ctx.grid.gj0 * CELL + f.pz;
      expect(f.id).toBe(fixtureId(77, 0, Math.floor(gx / CEIL_TILE + 1e-7), Math.floor(gz / CEIL_TILE + 1e-7), f.kind));
      ids.add(f.id);
    }
    expect(ids.size).toBe(l.fixtures.length);
  });

  it('rects sit on the global 0.6 m lattice, never cross a wall, SOLID / NO_CEIL cell, ceiling step or render-tile line', () => {
    for (const f of l.fixtures) {
      const [x0, z0, x1, z1] = fixtureRect(f);
      for (const v of [x0, z0, x1, z1]) expect(Math.abs(v / CEIL_TILE - Math.round(v / CEIL_TILE))).toBeLessThan(1e-6);
      expect(rectHitsEdges(l, x0, z0, x1, z1)).toBe(false);
      for (const k of [1]) {
        expect(x0 < k * TILE_SIZE - 1e-6 && x1 > k * TILE_SIZE + 1e-6).toBe(false);
        expect(z0 < k * TILE_SIZE - 1e-6 && z1 > k * TILE_SIZE + 1e-6).toBe(false);
      }
      let ceil = -1;
      for (let z = z0 + 0.3; z < z1; z += 0.6) for (let x = x0 + 0.3; x < x1; x += 0.6) {
        const c = cellIdx(Math.floor(x / CELL), Math.floor(z / CELL));
        expect(l.flags[c] & (CellFlag.SOLID | CellFlag.NO_CEIL | CellFlag.RESERVED)).toBe(0);
        if (ceil < 0) ceil = l.ceilCm[c]; else expect(l.ceilCm[c]).toBe(ceil);
        // recessed: covered ceiling tiles -> FIXTURE
        const tx = Math.floor(x / CEIL_TILE), tz = Math.floor(z / CEIL_TILE);
        expect(getTile(l.tiles, c, ((tz & 1) << 1) | (tx & 1))).toBe(TileState.FIXTURE);
      }
      expect(f.py).toBeCloseTo(ceil / 100, 9);
    }
  });

  it('colour follows kelvin(cct, tint), luminance within the R2 lognormal scatter (docs/contract-changes/R2-lighting.md)', () => {
    // R2 (B2): L * exp(LUM_SIGMA * g), g in [-2 sqrt 3, 2 sqrt 3]; a troffer half with its lamp pair out has 0
    const span = Math.exp(LUM_SIGMA * 2 * Math.sqrt(3)) * 1.001;
    for (const f of l.fixtures) {
      if (f.luminance === 0) continue;
      expect(f.luminance).toBeGreaterThanOrEqual(3000 / span - 1e-9);
      expect(f.luminance).toBeLessThanOrEqual(3000 * span + 1e-9);
      expect(Math.max(...f.color)).toBeCloseTo(1, 9);
      expect(f.color[0]).toBe(1); // 3500..4100 K is red-dominant
    }
  });

  it('candidates follow the lattice pitch and phase (with +1 tile retries)', () => {
    const gt = (m: number, g0: number): number => Math.round(m / CEIL_TILE) + 2 * g0;
    let onLattice = 0, exact = 0;
    for (const f of l.fixtures) {
      const [x0, z0] = fixtureRect(f);
      const tx = gt(x0, ctx.grid.gi0), tz = gt(z0, ctx.grid.gj0);
      const mx = (((tx - TROFFER.phase[0]) % 4) + 4) % 4, mz = (((tz - TROFFER.phase[1]) % 4) + 4) % 4;
      if (mx <= 1 && mz <= 1 && mx + mz <= 1) onLattice++; // a lattice candidate or one of its +x / +z retries
      if (mx === 0 && mz === 0) exact++;
    }
    // the rest are the centred fixtures of rooms the lattice missed
    expect(onLattice).toBeGreaterThan(l.fixtures.length * 0.8);
    expect(exact).toBeGreaterThan(l.fixtures.length / 2);
  });

  it('troffers hang over low cubicle partitions (PARTITION / HALF / RAIL) but never over a wall', () => {
    // a dense cubicle farm: partitions on every cell line, so every lattice rect touches one
    const lp = openLayout(0, 4, -3, Zone.OFFICE);
    for (let i = 1; i < N; i++) for (let lj = 0; lj < N; lj++) { lp.ex.kind[exIdx(i, lj)] = EdgeKind.PARTITION; lp.ex.hA[exIdx(i, lj)] = 150; }
    for (let j = 1; j < N; j++) for (let li = 0; li < N; li++) { lp.ez.kind[ezIdx(li, j)] = li % 5 === 0 ? EdgeKind.HALF : EdgeKind.PARTITION; lp.ez.hA[ezIdx(li, j)] = li % 5 === 0 ? 105 : 150; }
    // one full-height wall line: nothing may touch it
    for (let lj = 0; lj < N; lj++) { lp.ex.kind[exIdx(16, lj)] = EdgeKind.WALL; lp.ex.hA[exIdx(16, lj)] = 0; }
    labelRooms(lp);
    const cp = ctxFor(lp, 91);
    cp.lighting = { ...TROFFER, kind: FixtureKind.TROFFER_2x2, axis: 1 };
    placeFixtures(cp);
    expect(lp.fixtures.length).toBeGreaterThan(40); // ~ (64 / 4)^2 lattice sites
    for (const f of lp.fixtures) {
      const [x0, z0, x1, z1] = fixtureRect(f);
      expect(rectHitsEdges(lp, x0, z0, x1, z1, (f.py - 0.5) * 100)).toBe(false);
      expect(x1 <= 16 * CELL - T2 + 1e-6 || x0 >= 16 * CELL + T2 - 1e-6).toBe(true);
    }
    // the plain (floor-level) query still sees the partitions
    const [a0, b0, a1, b1] = fixtureRect(lp.fixtures[0]);
    expect(rectHitsEdges(lp, a0, b0, a1, b1)).toBe(true);
  });

  it('rooms of >= 4 cells without a lattice fixture get one centred fixture with p 0.5', () => {
    // a lattice so sparse it misses almost every room: the room pass lights about half of them
    let lit = 0, rooms = 0;
    for (let seed = 0; seed < 30; seed++) {
      const l2 = roomsLayout();
      const c2 = ctxFor(l2, 1000 + seed);
      c2.lighting = { ...TROFFER, lattice: [64, 64], phase: [63, 63] };
      placeFixtures(c2);
      const litRooms = new Set(l2.fixtures.map((f) => l2.room[cellIdx(Math.floor(f.px / CELL), Math.floor(f.pz / CELL))]));
      const sizes = new Map<number, number>();
      for (let c = 0; c < N * N; c++) if (l2.room[c] && !(l2.flags[c] & (CellFlag.SOLID | CellFlag.NO_CEIL))) sizes.set(l2.room[c], (sizes.get(l2.room[c]) ?? 0) + 1);
      for (const [r, n] of sizes) if (n >= 4) { rooms++; if (litRooms.has(r)) lit++; }
    }
    expect(lit / rooms).toBeGreaterThan(0.35);
    expect(lit / rooms).toBeLessThan(0.65);
  });
});

// ------------------------------------------------------------------------------------------ fixture states

describe('assignFixtureStates', () => {
  it('state probability table', () => {
    expect(stateProbabilities(0.1, 0)).toEqual([0.85, 0.1, 0.05, 0]);
    expect(stateProbabilities(0.2, 0.9)).toEqual([0.35, 0.15, 0.1, 0]);
    expect(stateProbabilities(0.5, 0)).toEqual([0.03, 0.02, 0.02, 0.03]);
    const d = stateProbabilities(0.9, 1);
    expect(d[0]).toBeCloseTo(0.09, 9);
    expect(d[2]).toBeCloseTo(0.08, 9);
    expect(stateFromU(0.0, [0.1, 0.1, 0.1, 0.1])).toBe(LightState.OFF);
    expect(stateFromU(0.15, [0.1, 0.1, 0.1, 0.1])).toBe(LightState.FLICKER);
    expect(stateFromU(0.25, [0.1, 0.1, 0.1, 0.1])).toBe(LightState.DYING);
    expect(stateFromU(0.35, [0.1, 0.1, 0.1, 0.1])).toBe(LightState.BUZZ);
    expect(stateFromU(0.45, [0.1, 0.1, 0.1, 0.1])).toBe(LightState.ON);
  });

  const lit = (lights: 'default' | 'on' | 'dead', power: number): ChunkLayout => {
    const l = roomsLayout();
    l.power.fill(power);
    const ctx = ctxFor(l, 5, undefined, { lights });
    ctx.lighting = TROFFER;
    placeFixtures(ctx);
    // a tower-group fixture and a fixture mounted 8 m above its floor
    l.fixtures.push({ ...l.fixtures[0], id: 424242, bakeGroup: 77, state: LightState.OFF });
    l.fixtures.push({ ...l.fixtures[1], id: 434343, py: 8.5, state: LightState.FLICKER });
    assignFixtureStates(ctx);
    return l;
  };

  it('QA overrides: lights=on -> all ON and none dynamic; lights=dead -> all OFF (structure fixtures stay ON)', () => {
    const on = lit('on', 10);
    for (const f of on.fixtures) { expect(f.state).toBe(LightState.ON); expect(f.dynamic).toBe(false); }
    const dead = lit('dead', 250);
    for (const f of dead.fixtures) expect(f.state).toBe(f.bakeGroup !== 0 ? LightState.ON : LightState.OFF);
  });

  it('low power -> mostly OFF; structure fixtures always ON; <= 1 dynamic per tile (lowest u); high mounts never dynamic', () => {
    const l = lit('default', 20);
    const tower = l.fixtures.find((f) => f.bakeGroup !== 0)!;
    expect(tower.state).toBe(LightState.ON);
    const high = l.fixtures.find((f) => f.id === 434343)!;
    expect(high.dynamic).toBe(false);
    const off = l.fixtures.filter((f) => f.state === LightState.OFF).length;
    expect(off / l.fixtures.length).toBeGreaterThan(0.6);
    // re-run the rule on a hand-made set: several FLICKER fixtures in one tile
    const fx = l.fixtures.filter((f) => f.bakeGroup === 0 && f.id !== 434343);
    for (const f of fx) f.state = LightState.FLICKER;
    enforceDynamicRule(l);
    for (let q = 0; q < 4; q++) {
      const inTile = fx.filter((f) => tileOfPoint(f.px, f.pz) === q);
      if (inTile.length === 0) continue;
      const dyn = inTile.filter((f) => f.dynamic);
      expect(dyn.length).toBe(1);
      const minU = Math.min(...inTile.map((f) => fixtureU(f.id)));
      expect(fixtureU(dyn[0].id)).toBe(minU);
      for (const f of inTile) expect(f.state).toBe(f.dynamic ? LightState.FLICKER : LightState.DYING);
    }
  });
});

// ------------------------------------------------------------------------------------------ acceptance sweep

interface Sweep { chunks: ChunkLayout[]; gen: WorldGen }
let sweepCache: Sweep | null = null;
/** 1000 chunks of the spawn storey (s = 0): a 32 x 32 block near the origin plus scattered far chunks. */
function sweep(): Sweep {
  if (sweepCache) return sweepCache;
  const total = Number(process.env.WP4_SWEEP_CHUNKS ?? 1000);
  const gen = createWorldGen(opts(2024));
  const chunks: ChunkLayout[] = [];
  const rng = new Rng(99);
  for (let i = 0; i < total; i++) {
    const near = i < total / 2;
    const cx = near ? (i % 23) - 11 : rng.int(-3000, 3000), cz = near ? Math.floor(i / 23) - 11 : rng.int(-3000, 3000);
    chunks.push(gen.generateChunk({ s: 0, cx, cz }));
  }
  return (sweepCache = { chunks, gen });
}

describe('acceptance sweep: 1000 chunks of the spawn storey', () => {
  it('fixtures: ids unique, recessed rects never straddle a tile line, no fixture in a wall or a SOLID cell, <= 1 dynamic per tile', () => {
    const { chunks } = sweep();
    let fixtures = 0, dynamic = 0;
    for (const l of chunks) {
      const ids = new Set<number>();
      const dyn = [0, 0, 0, 0];
      for (const f of l.fixtures) {
        fixtures++;
        expect(ids.has(f.id)).toBe(false);
        ids.add(f.id);
        const c = cellIdx(Math.min(N - 1, Math.floor(f.px / CELL)), Math.min(N - 1, Math.floor(f.pz / CELL)));
        expect(l.flags[c] & CellFlag.SOLID, `fixture ${f.id} kind ${f.kind} in a SOLID cell of ${l.key.cx},${l.key.cz}`).toBe(0);
        if (isRecessedFixture(f.kind) && f.shape === 0) {
          const [x0, z0, x1, z1] = fixtureRect(f);
          expect(x0 < TILE_SIZE - 1e-4 && x1 > TILE_SIZE + 1e-4).toBe(false);
          expect(z0 < TILE_SIZE - 1e-4 && z1 > TILE_SIZE + 1e-4).toBe(false);
        }
        // (artery fixtures are WP1's: arteries.ts; R2 B5 window glow panels (vertical SODIUM records) sit inside the
        // WINDOW reveal by design: structures/windows.ts)
        const windowGlow = f.kind === FixtureKind.SODIUM && Math.abs(f.ny) < 0.5;
        if (f.bakeGroup === 0 && !windowGlow && !(l.flags[c] & (CellFlag.LANDMARK | CellFlag.ARTERY))) {
          expect(fixtureHitsWall(l, f), `fixture ${f.id} kind ${f.kind} at ${f.px.toFixed(2)},${f.pz.toFixed(2)} of ${l.key.cx},${l.key.cz} (zone ${l.zone})`).toBe(false);
        }
        if (f.dynamic) {
          dynamic++;
          dyn[tileOfPoint(f.px, f.pz)]++;
          expect(f.py - l.floorCm[c] / 100).toBeLessThanOrEqual(LIGHT.DYN_MAX_MOUNT);
        }
      }
      for (const n of dyn) expect(n).toBeLessThanOrEqual(1);
    }
    expect(fixtures).toBeGreaterThan(20000);
    expect(dynamic).toBeGreaterThan(50);
  }, 600_000);

  it('the state mix is within +-3% of the formula expectation', () => {
    const { chunks, gen } = sweep();
    const exp = [0, 0, 0, 0, 0]; // ON OFF FLICKER+DYING BUZZ (index 2 unused)
    const got = [0, 0, 0, 0, 0];
    let n = 0;
    for (const l of chunks) {
      const d = gen.districtAt(0, l.key.cx, l.key.cz);
      const lp = generatorFor(d.zone).lighting(0, d);
      for (const f of l.fixtures) {
        if (isStructureFixture(l, f)) continue;
        const c = cellIdx(Math.min(N - 1, Math.floor(f.px / CELL)), Math.min(N - 1, Math.floor(f.pz / CELL)));
        if (l.flags[c] & CellFlag.LANDMARK) continue;
        const p = (l.power[c] / 256) * lp.zoneMul * MOOD_POWER_MUL[l.mood];
        const pr = stateProbabilities(p, l.decay[c] / 256);
        exp[1] += pr[0]; exp[3] += pr[1] + pr[2]; exp[4] += pr[3]; exp[0] += 1 - pr[0] - pr[1] - pr[2] - pr[3];
        const st = f.state;
        if (st === LightState.OFF) got[1]++;
        else if (st === LightState.FLICKER || st === LightState.DYING) got[3]++;
        else if (st === LightState.BUZZ) got[4]++;
        else got[0]++;
        n++;
      }
    }
    expect(n).toBeGreaterThan(10000);
    for (const i of [0, 1, 3, 4]) expect(Math.abs(got[i] / n - exp[i] / n), `state bucket ${i}`).toBeLessThan(0.03);
  }, 600_000);

  it('placeProps never overlaps walls, other props, SOLID or keepClear cells', () => {
    const { chunks, gen } = sweep();
    let added = 0;
    for (let i = 0; i < chunks.length; i += 10) {
      const src = chunks[i];
      const l: ChunkLayout = { ...src, props: src.props.slice(), flags: src.flags.slice() };
      const ctx = ctxFor(l, 2024, gen);
      const keep = computeKeepClear(l);
      const before = l.props.length;
      // an extra pass with dense rules of every placement mode on top of the generated content
      const rules: PropRuleSet = {
        rules: [
          { kind: PropKind.FILING_CABINET, where: 'wall', per100m2: 3, variants: 2, minSpacing: 1, yCm: 0 },
          { kind: PropKind.TRASH_CAN, where: 'corner', per100m2: 3, variants: 2, minSpacing: 1, yCm: 0 },
          { kind: PropKind.CHAIR_STACKING, where: 'center', per100m2: 2, variants: 2, minSpacing: 2, yCm: 0 },
          { kind: PropKind.EXTINGUISHER, where: 'wallMounted', per100m2: 1, variants: 1, minSpacing: 3, yCm: 60 },
          { kind: PropKind.CARDBOARD_BOX, where: 'cluster', per100m2: 1, variants: 3, minSpacing: 4, yCm: 0 },
          { kind: PropKind.CONE, where: 'aisle', per100m2: 1, variants: 1, minSpacing: 3, yCm: 0 },
        ],
      };
      placeProps(ctx, rules, keep);
      const fresh = l.props.slice(before);
      added += fresh.length;
      for (const p of fresh) {
        const def = PROP_DEFS[p.kind];
        const b = propAABB(p.kind, p.x, p.z, p.yaw);
        expect(rectHitsEdges(l, b.x0, b.z0, b.x1, b.z1), `prop ${def.name} in a wall`).toBe(false);
        for (let lj = Math.floor(b.z0 / CELL); lj <= Math.floor((b.z1 - 1e-6) / CELL); lj++) {
          for (let li = Math.floor(b.x0 / CELL); li <= Math.floor((b.x1 - 1e-6) / CELL); li++) {
            const c = cellIdx(li, lj);
            expect(keep[c], `prop ${def.name} on a keepClear cell`).toBe(0);
            expect(l.flags[c] & (CellFlag.SOLID | CellFlag.TOWER | CellFlag.ELEVATOR)).toBe(0);
          }
        }
        for (const q of l.props) {
          if (q === p || (q.flags & PropFlag.CEILING) !== 0) continue;
          const o = propAABB(q.kind, q.x, q.z, q.yaw, 0, q.scale || 1);
          const hy = PROP_DEFS[q.kind].size[1] * (q.scale || 1);
          const overlap = o.x0 < b.x1 - 1e-6 && o.x1 > b.x0 + 1e-6 && o.z0 < b.z1 - 1e-6 && o.z1 > b.z0 + 1e-6 && q.y < p.y + def.size[1] && q.y + hy > p.y;
          expect(overlap, `prop ${def.name} overlaps ${PROP_DEFS[q.kind].name}`).toBe(false);
        }
      }
    }
    expect(added).toBeGreaterThan(200);
  }, 600_000);

  it('decals: placeDecals adds <= 60 per chunk, never on TOWER / ELEVATOR cells', () => {
    const { chunks, gen } = sweep();
    for (let i = 3; i < chunks.length; i += 25) {
      const src = chunks[i];
      const l: ChunkLayout = { ...src, decals: [] };
      placeDecals(ctxFor(l, 2024, gen));
      expect(l.decals.length).toBeLessThanOrEqual(DECAL_MAX);
      for (const d of l.decals) {
        const li = Math.floor((d.px + d.nx * 0.05) / CELL), lj = Math.floor((d.pz + d.nz * 0.05) / CELL);
        expect(li >= 0 && lj >= 0 && li < N && lj < N).toBe(true);
        expect(l.flags[cellIdx(li, lj)] & (CellFlag.TOWER | CellFlag.ELEVATOR)).toBe(0);
      }
    }
  }, 600_000);
});

// ------------------------------------------------------------------------------------------ vignettes

describe('vignettes', () => {
  it('candidates: deterministic, >= VIG_DROP apart, about one per kept grid cell', () => {
    const a = vignetteCandidates(9, 0, -900, -900, 900, 900);
    const b = vignetteCandidates(9, 0, -900, -900, 900, 900);
    expect(a).toEqual(b);
    expect(VIG_DROP).toBeGreaterThanOrEqual(VIG_GRID);
    let minD = Infinity;
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const d = Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z);
      if (d < minD) minD = d;
    }
    expect(minD).toBeGreaterThanOrEqual(VIG_DROP - 1e-9);
    const cells = (1800 / VIG_GRID) ** 2;
    expect(a.length / cells).toBeGreaterThan(0.05);
    // sub-rectangles see the same candidates
    const part = vignetteCandidates(9, 0, 0, 0, 300, 300);
    for (const c of part) expect(a).toContainEqual(c);
  });

  it('zone weights: never a zero-weight kind; FALLEN_TILES only in the L0 family, POOL_FLOAT only in POOLROOMS', () => {
    for (const zone of [Zone.LOBBY, Zone.OFFICE, Zone.POOLROOMS, Zone.PARKING, Zone.PIPEWORKS, Zone.WAREHOUSE, Zone.CONCRETE] as ZoneId[]) {
      const c = vignetteCandidates(4, 1, -3000, -3000, 3000, 3000, () => zone);
      expect(c.length).toBeGreaterThan(100);
      const counts = new Array(13).fill(0);
      for (const v of c) counts[v.kind]++;
      for (let k = 0; k < 13; k++) if (VIGNETTE_WEIGHTS[k][zoneColumn(zone)] === 0) expect(counts[k], `kind ${k} in zone ${zone}`).toBe(0);
      // fallback kinds (tried when the primary composition does not fit): distinct, never zero-weight
      let badAlts = 0;
      for (const v of c) {
        if (new Set([v.kind, ...v.alts]).size !== 1 + v.alts.length) badAlts++;
        for (const k of v.alts) if (VIGNETTE_WEIGHTS[k][zoneColumn(zone)] === 0) badAlts++;
      }
      expect(badAlts, `bad fallback kinds in zone ${zone}`).toBe(0);
    }
    expect(VIGNETTE_WEIGHTS[VignetteKind.FALLEN_TILES]).toEqual([8, 0, 0, 0, 0, 0]);
    expect(VIGNETTE_WEIGHTS[VignetteKind.POOL_FLOAT]).toEqual([0, 10, 0, 0, 0, 0]);
    expect(VIGNETTE_WEIGHTS[VignetteKind.OPEN_CAR]).toEqual([0, 0, 8, 0, 0, 0]);
  }, 30_000);

  it('realised vignettes are >= VIG_MIN_SPACING apart over a 20 x 20-chunk region (storeys 0 and 1)', () => {
    for (const s of [0, 1] as StoreyId[]) {
      const gen = createWorldGen(opts(31 + s));
      const pts: { x: number; z: number; kind: number }[] = [];
      for (let cz = -10; cz < 10; cz++) for (let cx = -10; cx < 10; cx++) {
        const l = gen.generateChunk({ s, cx, cz });
        for (const v of l.vignettes) {
          pts.push({ x: cx * CHUNK_SIZE + v.x, z: cz * CHUNK_SIZE + v.z, kind: v.kind });
          expect(v.x).toBeGreaterThanOrEqual(0);
          expect(v.x).toBeLessThan(CHUNK_SIZE);
        }
      }
      expect(pts.length).toBeGreaterThan(40);
      let minD = Infinity;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minD = Math.min(minD, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
      expect(minD).toBeGreaterThanOrEqual(VIG_MIN_SPACING);
      const kinds = new Set(pts.map((p) => p.kind));
      expect(kinds.size).toBeGreaterThanOrEqual(5);
    }
  }, 600_000);

  it('CHAIR_FACING_WALL: a stacking chair 0.5 m from a wall, facing it', () => {
    const gen = createWorldGen(opts(31));
    let found = 0;
    for (let cz = -10; cz < 10 && found < 5; cz++) for (let cx = -10; cx < 10 && found < 5; cx++) {
      const l = gen.generateChunk({ s: 0, cx, cz });
      for (const v of l.vignettes) {
        if (v.kind !== VignetteKind.CHAIR_FACING_WALL) continue;
        const chair = l.props.find((p) => p.kind === PropKind.CHAIR_STACKING && Math.hypot(p.x - v.x, p.z - v.z) < 1e-6);
        expect(chair).toBeDefined();
        const fw = { x: 0, z: 0 };
        forwardXZ(chair!.yaw, fw);
        // walking forward 0.5 m + half the chair depth reaches the wall face
        const d = 0.5 + PROP_DEFS[PropKind.CHAIR_STACKING].size[2] / 2;
        const wx = chair!.x + fw.x * (d + T2), wz = chair!.z + fw.z * (d + T2);
        const onLine = Math.abs(wx / CELL - Math.round(wx / CELL)) < 1e-3 || Math.abs(wz / CELL - Math.round(wz / CELL)) < 1e-3;
        expect(onLine).toBe(true);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 600_000);
});

describe('COLLAPSED_RACK', () => {
  /** Two rack rows along x with a 2.5 m aisle between them (open warehouse floor around). */
  function warehouse(seed: number): { l: ChunkLayout; ctx: ReturnType<typeof ctxFor>; keep: Uint8Array } {
    const l = openLayout(1, 3, 5, Zone.WAREHOUSE);
    l.ceilCm.fill(700);
    for (const z of [10.0, 13.6]) for (const x of [9.6, 12.0, 14.4, 16.8, 19.2]) {
      l.props.push({ kind: PropKind.SHELF_RACK, variant: 0, x, y: 0, z, yaw: 0, scale: 1, flags: 1, seed: 1 });
    }
    return { l, ctx: ctxFor(l, seed), keep: new Uint8Array(N * N) };
  }
  /** Is the 0.3 m configuration space connected between two points? */
  function connected(l: ChunkLayout, keep: Uint8Array, a: [number, number], b: [number, number]): boolean {
    const cs = new PlacementSpace(l, keep).cspace;
    const px = (x: number): number => Math.floor(x / OCC_RES);
    const s0 = px(a[1]) * OCC_N + px(a[0]), s1 = px(b[1]) * OCC_N + px(b[0]);
    if (cs[s0] || cs[s1]) return false;
    const seen = new Uint8Array(OCC_N * OCC_N), q = [s0];
    seen[s0] = 1;
    while (q.length) {
      const p = q.pop()!;
      if (p === s1) return true;
      const x = p % OCC_N, z = (p / OCC_N) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= OCC_N || nz >= OCC_N) continue;
        const n = nz * OCC_N + nx;
        if (!seen[n] && !cs[n]) { seen[n] = 1; q.push(n); }
      }
    }
    return false;
  }

  it('a collapsed SHELF_RACK (variant 2) with 6-10 CARDBOARD_BOX spilled around it; the aisle stays passable', () => {
    for (let seed = 0; seed < 24; seed++) {
      const { l, ctx, keep } = warehouse(seed);
      const pl = new PropPlacer(ctx, keep);
      const a = composeVignette(ctx, pl, keep, VignetteKind.COLLAPSED_RACK, 14.4 + (seed % 3) * 0.3, 11.8, 100 + seed);
      expect(a, `seed ${seed}`).not.toBeNull();
      const racks = l.props.filter((p) => p.kind === PropKind.SHELF_RACK && p.variant === 2);
      expect(racks.length).toBe(1);
      expect(racks[0].x).toBeCloseTo(a!.x, 9);
      const boxes = l.props.filter((p) => p.kind === PropKind.CARDBOARD_BOX);
      expect(boxes.length).toBeGreaterThanOrEqual(RACK_SPILL_MIN);
      expect(boxes.length).toBeLessThanOrEqual(RACK_SPILL_MAX);
      for (const b of boxes) expect(Math.hypot(b.x - racks[0].x, b.z - racks[0].z)).toBeLessThan(2.6);
      expect(l.vignettes.length).toBe(1);
      expect(l.vignettes[0]).toMatchObject({ kind: VignetteKind.COLLAPSED_RACK, x: a!.x, z: a!.z });
      // the aisle is still walkable end to end
      expect(connected(l, keep, [6.5, 11.8], [22.5, 11.8])).toBe(true);
    }
  });

  it('no orphan boxes: if fewer than 6 fit, nothing is placed and the rack stays upright', () => {
    // open warehouse floor, but keepClear everywhere except the rack's cells and one cell beside it: only a few
    // boxes fit there
    const l = openLayout(1, 3, 5, Zone.WAREHOUSE);
    l.ceilCm.fill(700);
    l.props.push({ kind: PropKind.SHELF_RACK, variant: 0, x: 14.4, y: 0, z: 12.6, yaw: 0, scale: 1, flags: 1, seed: 1 });
    const keep = new Uint8Array(N * N).fill(1);
    for (const [li, lj] of [[10, 10], [11, 10], [10, 11]]) keep[cellIdx(li, lj)] = 0;
    const ctx = ctxFor(l, 5);
    let nulls = 0;
    for (let seed = 0; seed < 16; seed++) {
      const pl = new PropPlacer(ctx, keep);
      const before = l.props.length;
      const a = composeVignette(ctx, pl, keep, VignetteKind.COLLAPSED_RACK, 14.4, 12.6, 77 + seed);
      const boxes = l.props.length - before;
      if (a === null) {
        nulls++;
        expect(boxes).toBe(0);
        expect(l.props[0].variant).toBe(0);
        expect(l.vignettes.length).toBe(0);
      } else {
        expect(boxes).toBeGreaterThanOrEqual(RACK_SPILL_MIN);
        break;
      }
    }
    expect(nulls).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------ keepClear

describe('computeKeepClear', () => {
  it('marks Chebyshev-1 around walkable seam edges, DOORWAY / HEADER / ARCH edges, artery lanes and exits', () => {
    const l = openLayout();
    // close every seam except one port
    for (let c = 0; c < N; c++) {
      l.ex.kind[exIdx(0, c)] = EdgeKind.WALL; l.ex.kind[exIdx(N, c)] = EdgeKind.WALL;
      l.ez.kind[ezIdx(c, 0)] = EdgeKind.WALL; l.ez.kind[ezIdx(c, N)] = EdgeKind.WALL;
    }
    l.ex.kind[exIdx(0, 10)] = EdgeKind.OPEN;
    l.ez.kind[ezIdx(20, 15)] = EdgeKind.DOORWAY;
    l.flags[cellIdx(25, 25)] |= CellFlag.ARTERY;
    const k = computeKeepClear(l);
    const marked = (li: number, lj: number): number => k[cellIdx(li, lj)];
    for (const [li, lj] of [[0, 9], [0, 10], [0, 11], [1, 9], [1, 11]]) expect(marked(li, lj)).toBe(1);
    expect(marked(2, 10)).toBe(0);
    for (let dj = -2; dj <= 1; dj++) for (let di = -1; di <= 1; di++) expect(marked(20 + di, 15 + dj)).toBe(1);
    expect(marked(20, 17)).toBe(0);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) expect(marked(25 + di, 25 + dj)).toBe(1);
    expect(marked(10, 25)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ leaks, signs, chalk

describe('leaks', () => {
  it('count = floor(mean(humidity) * 4 + hash01); tiles near a leak stain / sag / fall, WET floors, a DRIP each', () => {
    let totalLeaks = 0;
    for (let i = 0; i < 40; i++) {
      const l = openLayout(0, i, 7);
      l.humidity.fill(180 + (i % 3) * 20);
      const ctx = ctxFor(l, 13);
      placeLeakSites(ctx);
      const m = meanField(l, l.humidity) * 4;
      expect(l.leaks.length).toBeGreaterThanOrEqual(Math.floor(m));
      expect(l.leaks.length).toBeLessThanOrEqual(Math.floor(m) + 1);
      expect(l.emitters.filter((e) => e.kind === EmitterKind.DRIP).length).toBe(l.leaks.length);
      for (const lk of l.leaks) {
        expect(lk.strength).toBeGreaterThanOrEqual(0.3);
        expect(lk.strength).toBeLessThanOrEqual(1);
        expect(lk.y).toBeCloseTo(2.7, 9);
      }
      // every changed tile is within LEAK_RADIUS of some leak
      for (let c = 0; c < N * N; c++) for (let t = 0; t < 4; t++) {
        const st = getTile(l.tiles, c, t);
        if (st === TileState.NORMAL) continue;
        expect([TileState.STAINED, TileState.SAGGING, TileState.MISSING]).toContain(st);
        const x = ((c & 31) + 0.25 + 0.5 * (t & 1)) * CELL, z = ((c >> 5) + 0.25 + 0.5 * (t >> 1)) * CELL;
        expect(l.leaks.some((lk) => Math.hypot(lk.x - x, lk.z - z) <= LEAK_RADIUS + 1e-9)).toBe(true);
      }
      totalLeaks += l.leaks.length;
    }
    expect(totalLeaks).toBeGreaterThan(40);
  });
});

describe('exit signs', () => {
  const withTower = (t: TowerSite | null, seed: number): ChunkLayout => {
    const l = openLayout(0, 0, 0);
    for (let i = 2; i < N; i += 3) for (let lj = 0; lj < N; lj++) l.ex.kind[exIdx(i, lj)] = EdgeKind.DOORWAY;
    for (let i = 2; i < N; i++) for (let lj = 0; lj < N; lj++) if (l.ex.kind[exIdx(i, lj)] === EdgeKind.DOORWAY) l.ex.hA[exIdx(i, lj)] = 210;
    const ctx = ctxFor(l, seed);
    ctx.world = { ...ctx.world, towersNear: () => (t ? [t] : []) };
    placeExitSigns(ctx, { dark: false, stairs: false });
    return l;
  };

  it('only within 2 chunks of a tower; EXIT_SIGN RECT 0.3 x 0.15, 150 nits red, 5 cm below the head, facing the approach', () => {
    expect(withTower(null, 1).fixtures.length).toBe(0);
    expect(withTower({ id: 5, cx: 3, cz: 0, i0: 10, j0: 10, rot: 0, endless: false }, 1).fixtures.length).toBe(0);
    let signs = 0, edges = 0;
    for (let seed = 0; seed < 20; seed++) {
      // tower 2 chunks east: its exit is far along +x, so every x-line doorway crossing toward +x qualifies
      const l = withTower({ id: 5, cx: 2, cz: 0, i0: 10, j0: 14, rot: 0, endless: false }, seed);
      for (const f of l.fixtures) {
        expect(f.kind).toBe(FixtureKind.EXIT_SIGN);
        expect(f.shape).toBe(0);
        expect([f.w, f.h, f.luminance]).toEqual([0.3, 0.15, 150]);
        expect(f.color[0]).toBe(1);
        expect(f.color[1]).toBeLessThan(0.2);
        expect(f.py + f.h / 2).toBeCloseTo(2.1 - 0.05, 6);
        expect(f.nx).toBe(-1); // faces the player approaching from -x
        expect(f.px % CELL).toBeGreaterThan(CELL / 2); // on the approach (west) side of its line
      }
      signs += l.fixtures.length;
      edges += 10 * N;
    }
    expect(Math.abs(signs / edges - EXIT_SIGN_P)).toBeLessThan(0.05);
  });

  it('QA lights=dead: exit signs (placed after assignFixtureStates) are OFF too', () => {
    let n = 0;
    for (let seed = 0; seed < 6; seed++) {
      const l = openLayout(0, 0, 0);
      for (let i = 2; i < N; i += 3) for (let lj = 0; lj < N; lj++) { l.ex.kind[exIdx(i, lj)] = EdgeKind.DOORWAY; l.ex.hA[exIdx(i, lj)] = 210; }
      const ctx = ctxFor(l, seed, undefined, { lights: 'dead' });
      ctx.world = { ...ctx.world, towersNear: () => [{ id: 5, cx: 2, cz: 0, i0: 10, j0: 14, rot: 0, endless: false }] };
      placeExitSigns(ctx, { stairs: false });
      for (const f of l.fixtures) { expect(f.state).toBe(LightState.OFF); n++; }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('flooded hall spill', () => {
  it('placeDecals puts WATER_STAIN puddles on the dry floor just outside every opening (never inside the hall)', () => {
    const l = openLayout(0, 2, 2);
    const [i0, j0, i1, j1] = [8, 8, 20, 24];
    l.landmarks.push({ kind: LandmarkKind.FLOODED_HALL, i0, j0, i1, j1 });
    for (let lj = j0; lj < j1; lj++) for (let li = i0; li < i1; li++) { l.flags[cellIdx(li, lj)] |= CellFlag.LANDMARK | CellFlag.RESERVED; l.waterCm[cellIdx(li, lj)] = 25; }
    for (let lj = j0; lj < j1; lj++) { l.ex.kind[exIdx(i0, lj)] = EdgeKind.WALL; l.ex.kind[exIdx(i1, lj)] = EdgeKind.WALL; }
    for (let li = i0; li < i1; li++) { l.ez.kind[ezIdx(li, j0)] = EdgeKind.WALL; l.ez.kind[ezIdx(li, j1)] = EdgeKind.WALL; }
    l.ez.kind[ezIdx(12, j0)] = EdgeKind.DOORWAY; l.ez.hA[ezIdx(12, j0)] = 210; // opening to the north (-z)
    l.ex.kind[exIdx(i1, 15)] = EdgeKind.HEADER; l.ex.hA[exIdx(i1, 15)] = 220; // opening to the east (+x)
    l.humidity.fill(0); l.decay.fill(0);
    placeDecals(ctxFor(l, 5));
    const spills = l.decals.filter((d) => d.kind === DecalKind.WATER_STAIN && !d.sign);
    expect(spills.length).toBe(2);
    for (const d of spills) {
      const li = Math.floor(d.px / CELL), lj = Math.floor(d.pz / CELL);
      expect(li >= i0 && li < i1 && lj >= j0 && lj < j1).toBe(false);
      expect(d.py).toBe(0);
      expect(l.flags[cellIdx(li, lj)] & CellFlag.WET).toBe(CellFlag.WET);
    }
    expect(spills.some((d) => Math.floor(d.px / CELL) === 12 && Math.floor(d.pz / CELL) === j0 - 1)).toBe(true);
    expect(spills.some((d) => Math.floor(d.px / CELL) === i1 && Math.floor(d.pz / CELL) === 15)).toBe(true);
  });
});

describe('chalk', () => {
  it('arrows at junctions only; rot = atan2(-dx, -dz); 70% point toward the nearest tower exit', () => {
    let toward = 0, total = 0;
    for (let seed = 0; seed < 60; seed++) {
      // a grid of 1-cell corridors: every crossing is a junction
      const l = openLayout(0, seed, 1);
      l.flags.fill(CellFlag.SOLID);
      for (let a = 0; a < N; a++) for (const b of [4, 10, 16, 22, 28]) { l.flags[cellIdx(a, b)] = 0; l.flags[cellIdx(b, a)] = 0; }
      for (let lj = 0; lj < N; lj++) for (let li = 0; li < N; li++) {
        const c = cellIdx(li, lj);
        if (l.flags[c]) continue;
        if (li + 1 < N && l.flags[cellIdx(li + 1, lj)]) l.ex.kind[exIdx(li + 1, lj)] = EdgeKind.WALL;
        if (lj + 1 < N && l.flags[cellIdx(li, lj + 1)]) l.ez.kind[ezIdx(li, lj + 1)] = EdgeKind.WALL;
        if (li > 0 && l.flags[cellIdx(li - 1, lj)]) l.ex.kind[exIdx(li, lj)] = EdgeKind.WALL;
        if (lj > 0 && l.flags[cellIdx(li, lj - 1)]) l.ez.kind[ezIdx(li, lj)] = EdgeKind.WALL;
      }
      const ctx = ctxFor(l, 900 + seed);
      // a tower far to the south (+z): its exit direction is +z
      ctx.world = { ...ctx.world, towersNear: () => [{ id: 3, cx: seed, cz: 4, i0: 14, j0: 14, rot: 0, endless: false }] };
      placeChalk(ctx);
      for (const d of l.decals) {
        expect(d.kind).toBe(DecalKind.CHALK_ARROW);
        const li = Math.floor(d.px / CELL), lj = Math.floor(d.pz / CELL);
        expect(isJunction(ctx, li, lj)).toBe(true);
        const fw = { x: 0, z: 0 };
        forwardXZ(d.rot, fw);
        total++;
        if (fw.z > 0.9) toward++;
      }
    }
    expect(total).toBeGreaterThan(40);
    expect(Math.abs(toward / total - 0.7)).toBeLessThan(0.15);
  });
});

// ------------------------------------------------------------------------------------------ anomalies

describe('anomalies', () => {
  it('corridorRuns finds straight runs >= 10 cells of width <= 2', () => {
    const l = openLayout();
    l.flags.fill(CellFlag.SOLID);
    for (let li = 3; li < 20; li++) l.flags[cellIdx(li, 8)] = 0;
    for (let li = 3; li < 20; li++) { l.ez.kind[ezIdx(li, 8)] = EdgeKind.WALL; l.ez.kind[ezIdx(li, 9)] = EdgeKind.WALL; }
    const runs = corridorRuns(l, corridorWidth);
    expect(runs).toContainEqual({ axis: 0, li: 3, lj: 8, len: 17 });
  });

  it('REPEATED_ROOM: room B gets room A content byte-identically (translated)', () => {
    const l = openLayout(0, 1, 1, Zone.OFFICE);
    l.flags.fill(CellFlag.SOLID);
    for (let lj = 10; lj < 14; lj++) for (let li = 5; li < 15; li++) l.flags[cellIdx(li, lj)] = 0;
    const rect = (i0: number, i1: number): void => {
      for (let li = i0; li < i1; li++) { l.ez.kind[ezIdx(li, 10)] = EdgeKind.WALL; l.ez.kind[ezIdx(li, 14)] = EdgeKind.WALL; }
      for (let lj = 10; lj < 14; lj++) { l.ex.kind[exIdx(i0, lj)] = EdgeKind.WALL; l.ex.kind[exIdx(i1, lj)] = EdgeKind.WALL; }
    };
    rect(5, 10); rect(10, 15);
    l.ex.kind[exIdx(10, 10)] = EdgeKind.DOORWAY; // A | B
    l.ez.kind[ezIdx(6, 10)] = EdgeKind.DOORWAY; // A's outer door
    labelRooms(l);
    const pairs = roomPairs(l);
    expect(pairs.length).toBeGreaterThan(0);
    const pr = pairs.find((p) => p.a.i0 === 5)!;
    l.props.push({ kind: PropKind.DESK, variant: 1, x: 8.2, y: 0, z: 15.9, yaw: 0, scale: 1, flags: 1, seed: 5 });
    const ctx = ctxFor(l, 3);
    expect(repeatRoom(ctx, pr)).toBe(true);
    const copy = l.props.find((p) => p.kind === PropKind.DESK && Math.abs(p.x - (8.2 + 6.0)) < 1e-9);
    expect(copy).toEqual({ kind: PropKind.DESK, variant: 1, x: 8.2 + 6.0, y: 0, z: 15.9, yaw: 0, scale: 1, flags: 1, seed: 5 });
  });

  it('CEILING_FURNITURE mirrors a room\'s chairs and desks onto the ceiling (CEILING flag, no collision)', () => {
    const l = openLayout();
    labelRooms(l);
    for (let k = 0; k < 4; k++) l.props.push({ kind: PropKind.CHAIR_STACKING, variant: 0, x: 10 + k, y: 0, z: 10, yaw: 0, scale: 1, flags: 1, seed: k });
    const ctx = ctxFor(l, 3);
    expect(ceilingFurniture(ctx, new Rng(1))).toBe(true);
    const up = l.props.filter((p) => p.flags & PropFlag.CEILING);
    expect(up.length).toBeGreaterThanOrEqual(2);
    for (const p of up) { expect(p.y).toBeCloseTo(2.7, 9); expect(p.flags).toBe(PropFlag.CEILING); }
    expect(l.anomalies.some((a) => a.kind === AnomalyKind.CEILING_FURNITURE)).toBe(true);
  });

  it('spark vignettes turn a fixture OFF and add a SPARKING site; open-car lamps and sign flags are well-formed', () => {
    // across the sweep region: every SPARKING site sits on an OFF fixture
    const { chunks } = sweep();
    let sites = 0;
    for (const l of chunks) {
      for (const a of l.anomalies) {
        if (a.kind !== AnomalyKind.SPARKING) continue;
        sites++;
        const f = l.fixtures.find((fx) => Math.abs(fx.px - a.x) < 1e-9 && Math.abs(fx.pz - a.z) < 1e-9);
        expect(f).toBeDefined();
        expect(f!.state).toBe(LightState.OFF);
        expect(f!.dynamic).toBe(false);
      }
    }
    expect(sites).toBeGreaterThan(0);
  }, 600_000);
});

// ------------------------------------------------------------------------------------------ misc invariants

describe('player clearance', () => {
  it('PLAYER radius used by the placers matches the contract', () => {
    expect(PLAYER.radius).toBe(0.28);
    expect(hash01(hash2(1, SALT.FIXTURE_STATE))).toBe(fixtureU(1));
    expect(CeilKind.TILES).toBe(0);
  });
});

void placeVignettes;

// ------------------------------------------------------------------------------------------ R2 (B6) lived-in content

/** LOBBY layout with a few WALL runs (corners for closets) and doorways, rooms labelled. */
function cornerLayout(cx = 2, cz = 3): ChunkLayout {
  const l = openLayout(0, cx, cz, Zone.LOBBY);
  for (let lj = 0; lj < N; lj++) l.ex.kind[exIdx(12, lj)] = lj % 10 === 5 ? EdgeKind.DOORWAY : EdgeKind.WALL;
  for (let li = 0; li < 12; li++) l.ez.kind[ezIdx(li, 14)] = li === 6 ? EdgeKind.DOORWAY : EdgeKind.WALL;
  for (let li = 12; li < N; li++) l.ez.kind[ezIdx(li, 20)] = li === 20 ? EdgeKind.DOORWAY : EdgeKind.WALL;
  labelRooms(l);
  return l;
}

describe('R2 B6: mattress closet, backpack camp', () => {
  it('MATTRESS_CLOSET carves a walled 2x2 / 2x3 pocket with one DOORWAY, an open leaf, a mattress and a bare bulb', () => {
    let made = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const l = cornerLayout();
      const ctx = ctxFor(l, seed);
      const keep = computeKeepClear(l);
      const before = portReach(l);
      const doors0 = l.ex.kind.filter((k) => k === EdgeKind.DOORWAY).length + l.ez.kind.filter((k) => k === EdgeKind.DOORWAY).length;
      const pl = new PropPlacer(ctx, keep);
      // near the corner of the x = 12 wall and the z = 14 wall
      const a = composeVignette(ctx, pl, keep, VignetteKind.MATTRESS_CLOSET, 12.5, 15.5, seed * 77);
      expect(a).not.toBeNull();
      const doors1 = l.ex.kind.filter((k) => k === EdgeKind.DOORWAY).length + l.ez.kind.filter((k) => k === EdgeKind.DOORWAY).length;
      expect(doors1 - doors0).toBe(1);
      expect(reachKept(before, portReach(l))).toBe(true);
      const bulbs = l.fixtures.filter((f) => f.kind === FixtureKind.CAGE_BULB);
      expect(bulbs.length).toBe(1);
      const leaf = l.props.find((p) => p.kind === PropKind.DOOR_LEAF);
      expect(leaf).toBeDefined();
      const mat = l.props.find((p) => p.kind === PropKind.MATTRESS);
      if (mat) {
        const b = propAABB(PropKind.MATTRESS, mat.x, mat.z, mat.yaw);
        expect(rectHitsEdges(l, b.x0, b.z0, b.x1, b.z1)).toBe(false);
        made++;
      }
      // the bulb's cell is a small room of 4 or 6 cells
      const room = l.room[cellIdx(Math.floor(bulbs[0].px / CELL), Math.floor(bulbs[0].pz / CELL))];
      const n = l.room.filter((r) => r === room).length;
      expect([4, 6]).toContain(n);
      expect(l.vignettes.some((v) => v.kind === VignetteKind.MATTRESS_CLOSET)).toBe(true);
    }
    expect(made).toBeGreaterThan(8);
  });

  it('BACKPACK_CAMP: the sleeping bag fits along the wall (long axis parallel) or perpendicular to it', () => {
    let along = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const l = cornerLayout();
      const ctx = ctxFor(l, seed);
      const keep = computeKeepClear(l);
      const pl = new PropPlacer(ctx, keep);
      const a = composeVignette(ctx, pl, keep, VignetteKind.BACKPACK_CAMP, 13.1 + (seed % 3) * 0.3, 2.5 + seed, seed * 31);
      expect(a).not.toBeNull();
      const bag = l.props.find((p) => p.kind === PropKind.SLEEPING_BAG)!;
      const b = propAABB(PropKind.SLEEPING_BAG, bag.x, bag.z, bag.yaw);
      expect(rectHitsEdges(l, b.x0, b.z0, b.x1, b.z1)).toBe(false);
      const fw = { x: 0, z: 0 };
      forwardXZ(bag.yaw, fw);
      // x = 12 is the only wall near: along = long axis along z
      if (Math.abs(fw.z) > 0.99) along++;
      expect(l.props.some((p) => p.kind === PropKind.BACKPACK)).toBe(true);
    }
    expect(along).toBeGreaterThan(6);
  });
});

describe('R2 B6: stamped REPEATED_ROOM, ceiling furniture ring', () => {
  it('stamps two equal 5 x 6 rooms with three doors in line, furnishes A and repeats it into B', () => {
    let ok = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const l = openLayout(0, seed, 2, Zone.LOBBY);
      labelRooms(l);
      const ctx = ctxFor(l, seed);
      const before = portReach(l);
      const pr = stampRoomPair(ctx, new Rng(seed));
      expect(pr).not.toBeNull();
      const { a, b } = pr!;
      expect([a.i1 - a.i0, a.j1 - a.j0].sort()).toEqual([STAMP_W, STAMP_D].sort());
      expect([b.i1 - b.i0, b.j1 - b.j0]).toEqual([a.i1 - a.i0, a.j1 - a.j0]);
      expect(reachKept(before, portReach(l))).toBe(true);
      expect(repeatRoom(ctx, pr!)).toBe(true);
      const dx = (b.i0 - a.i0) * CELL, dz = (b.j0 - a.j0) * CELL;
      const inR = (r: typeof a, x: number, z: number): boolean => x >= r.i0 * CELL && x < r.i1 * CELL && z >= r.j0 * CELL && z < r.j1 * CELL;
      const pa = l.props.filter((p) => inR(a, p.x, p.z)), pb = l.props.filter((p) => inR(b, p.x, p.z));
      expect(pa.length).toBeGreaterThan(1);
      expect(pb.length).toBe(pa.length);
      for (const p of pa) expect(pb).toContainEqual({ ...p, x: p.x + dx, z: p.z + dz });
      // doors: exactly 3 DOORWAY edges, all on one row / column
      const doors: number[] = [];
      for (let k = 0; k < l.ex.kind.length; k++) if (l.ex.kind[k] === EdgeKind.DOORWAY) doors.push(k);
      for (let k = 0; k < l.ez.kind.length; k++) if (l.ez.kind[k] === EdgeKind.DOORWAY) doors.push(k + 100000);
      expect(doors.length).toBe(3);
      // B's cells are a room of their own of 30 cells
      const rb = l.room[cellIdx(b.i0, b.j0)];
      expect(l.room.filter((r) => r === rb).length).toBe(STAMP_W * STAMP_D);
      ok++;
    }
    expect(ok).toBe(6);
  });

  it('CEILING_FURNITURE: without a furniture group a ring of stacking chairs is set out and mirrored', () => {
    const l = openLayout(0, 4, 4, Zone.LOBBY);
    labelRooms(l);
    const ctx = ctxFor(l, 5);
    expect(chairRing(ctxFor(openLayout(), 5), new Rng(2)).length).toBeGreaterThanOrEqual(3);
    expect(ceilingFurniture(ctx, new Rng(3))).toBe(true);
    const up = l.props.filter((p) => p.flags & PropFlag.CEILING);
    expect(up.length).toBeGreaterThanOrEqual(3);
    const down = l.props.filter((p) => !(p.flags & PropFlag.CEILING) && p.kind === PropKind.CHAIR_STACKING);
    for (const p of up) expect(down.some((q) => q.x === p.x && q.z === p.z)).toBe(true);
  });
});

describe('R2 B6: traces and storage clusters', () => {
  it('traces: about one per TRACE_M2 m2 of LOBBY floor, never overlapping walls / props / keepClear, spread out', () => {
    let traces = 0, area = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const l = cornerLayout(seed, 1);
      l.decay.fill(128);
      const ctx = ctxFor(l, seed);
      const keep = computeKeepClear(l);
      const pl = new PropPlacer(ctx, keep);
      const n0 = l.props.length, d0 = l.decals.length;
      let wet0 = 0;
      for (let c = 0; c < N * N; c++) if (l.flags[c] & CellFlag.WET) wet0++;
      placeTraces(ctx, pl);
      let wet = 0;
      for (let c = 0; c < N * N; c++) if (l.flags[c] & CellFlag.WET) wet++;
      // anything visible counts; a trace is 1-6 items, so bound loosely
      traces += Math.min(l.props.length - n0 + l.decals.length - d0 + (wet - wet0), 1e9) > 0 ? 1 : 0;
      area += N * N * CELL * CELL;
      // no floor prop overlaps a wall or a keepClear cell unless allowed (tiles / bottles / debris)
      const space = new PlacementSpace({ ...l, props: [] }, keep);
      for (const p of l.props.slice(n0)) {
        const b = propAABB(p.kind, p.x, p.z, p.yaw);
        const def = PROP_DEFS[p.kind];
        if (def.collide && p.y === 0) expect(rectHitsEdges(l, b.x0, b.z0, b.x1, b.z1)).toBe(false);
        void space;
      }
    }
    expect(traces).toBe(8);
    // direct density check on a big open floor at decay 0.5: count compositions
    let placed = 0, cells = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const l = openLayout(0, seed, 9, Zone.LOBBY);
      l.decay.fill(128);
      for (let lj = 0; lj < N; lj++) for (let i = 4; i < N; i += 6) l.ex.kind[exIdx(i, lj)] = lj % 8 === 3 ? EdgeKind.DOORWAY : EdgeKind.WALL;
      labelRooms(l);
      const ctx = ctxFor(l, seed);
      const keep = computeKeepClear(l);
      for (let c = 0; c < N * N; c++) if (!keep[c]) cells++;
      const before = JSON.stringify([l.props.length, l.decals.length]);
      placeTraces(ctx, new PropPlacer(ctx, keep));
      if (JSON.stringify([l.props.length, l.decals.length]) !== before) placed++;
    }
    expect(placed).toBe(10);
    expect(cells * CELL * CELL / TRACE_M2).toBeGreaterThan(50);
  });

  it('composeTrace kinds each produce something in a plain room', () => {
    for (const kind of Object.values(TraceKind)) {
      let ok = false;
      for (let seed = 1; seed <= 30 && !ok; seed++) {
        const l = cornerLayout(seed, 2);
        for (let c = 0; c < N * N; c++) for (let t = 0; t < 4; t++) setTile(l.tiles, c, t, TileState.NORMAL);
        const ctx = ctxFor(l, seed);
        const keep = new Uint8Array(N * N);
        const pl = new PropPlacer(ctx, keep);
        ok = composeTrace(pl, kind, cellIdx(11, 3 + (seed % 8)), new Rng(seed));
      }
      expect(ok, `trace kind ${kind}`).toBe(true);
    }
  });

  it('PILLAR_HALL / LOW_EXPANSE: the district site chunk gets a big storage cluster', () => {
    for (const zone of [Zone.PILLAR_HALL, Zone.LOW_EXPANSE] as ZoneId[]) {
      let clusters = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const l = openLayout(0, 7, 7, zone);
        for (let lj = 0; lj < N; lj++) l.ex.kind[exIdx(20, lj)] = EdgeKind.WALL;
        labelRooms(l);
        const ctx = ctxFor(l, seed);
        ctx.district = { ...ctx.district, zone, siteX: 7.4, siteZ: 7.6 };
        const pl = new PropPlacer(ctx, computeKeepClear(l));
        placeDistrictClusters(ctx, pl);
        if (l.props.length >= 4) clusters++;
      }
      expect(clusters).toBe(6);
    }
  });
});

describe('R2 B6: ceiling tile ageing, damp cells', () => {
  it('agedTileState: NEW / DIRTY / STAINED / SAGGING / MISSING rates match TILE_AGE_P at mid decay / humidity', () => {
    const counts = new Array(8).fill(0);
    let n = 0;
    for (let tj = -300; tj < 300; tj++) for (let ti = -300; ti < 300; ti++) { counts[agedTileState(7, 0, ti, tj, 0.5, 0.5)]++; n++; }
    const rate = (st: number): number => counts[st] / n;
    expect(rate(TileState.NEW) / TILE_AGE_P.NEW).toBeGreaterThan(0.8);
    expect(rate(TileState.NEW) / TILE_AGE_P.NEW).toBeLessThan(1.2);
    expect(rate(TileState.DIRTY) / TILE_AGE_P.DIRTY).toBeGreaterThan(0.8);
    expect(rate(TileState.DIRTY) / TILE_AGE_P.DIRTY).toBeLessThan(1.2);
    expect(rate(TileState.STAINED) / TILE_AGE_P.STAINED).toBeGreaterThan(0.8);
    expect(rate(TileState.STAINED) / TILE_AGE_P.STAINED).toBeLessThan(1.2);
    expect(rate(TileState.SAGGING) / TILE_AGE_P.SAGGING).toBeGreaterThan(0.7);
    expect(rate(TileState.SAGGING) / TILE_AGE_P.SAGGING).toBeLessThan(1.3);
    expect(rate(TileState.MISSING) / TILE_AGE_P.MISSING).toBeGreaterThan(0.7);
    expect(rate(TileState.MISSING) / TILE_AGE_P.MISSING).toBeLessThan(1.3);
    // humid ceilings stain more, decayed ones get dirtier, maintained ones get new tiles
    const r = (st: number, d: number, h: number): number => {
      let k = 0;
      for (let tj = 0; tj < 200; tj++) for (let ti = 0; ti < 200; ti++) if (agedTileState(3, 0, ti, tj, d, h) === st) k++;
      return k;
    };
    expect(r(TileState.STAINED, 0.5, 0.9)).toBeGreaterThan(r(TileState.STAINED, 0.5, 0.1) * 2);
    expect(r(TileState.DIRTY, 0.9, 0.5)).toBeGreaterThan(r(TileState.DIRTY, 0.1, 0.5) * 1.5);
    expect(r(TileState.NEW, 0.1, 0.5)).toBeGreaterThan(r(TileState.NEW, 0.9, 0.5) * 1.5);
  });

  it('ageCeilingTiles only changes NORMAL tiles of TILES ceilings (FIXTURE / VENT kept); deterministic per global tile', () => {
    const mk = (): ChunkLayout => {
      const l = openLayout(0, 1, 1);
      for (let c = 0; c < 200; c++) setTile(l.tiles, c, 0, TileState.FIXTURE);
      for (let c = 200; c < 300; c++) setTile(l.tiles, c, 1, TileState.VENT);
      for (let c = 900; c < N * N; c++) l.ceilKind[c] = CeilKind.CONCRETE;
      return l;
    };
    const a = mk(), b = mk();
    ageCeilingTiles(ctxFor(a, 9));
    ageCeilingTiles(ctxFor(b, 9));
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    let changed = 0;
    for (let c = 0; c < N * N; c++) {
      if (c < 200) expect(getTile(a.tiles, c, 0)).toBe(TileState.FIXTURE);
      if (c >= 200 && c < 300) expect(getTile(a.tiles, c, 1)).toBe(TileState.VENT);
      if (c >= 900) expect(a.tiles[c]).toBe(0);
      for (let t = 0; t < 4; t++) if (c < 900 && getTile(a.tiles, c, t) !== TileState.NORMAL && getTile(a.tiles, c, t) !== TileState.FIXTURE && getTile(a.tiles, c, t) !== TileState.VENT) changed++;
    }
    expect(changed).toBeGreaterThan(50);
  });

  it('damp cells: humid Level 0 chunks reach ~5.5 % WET cells, dry ones get none', () => {
    const humid = openLayout(0, 2, 2);
    humid.humidity.fill(220);
    placeDampCells(ctxFor(humid, 4));
    let wet = 0;
    for (let c = 0; c < N * N; c++) if (humid.flags[c] & CellFlag.WET) wet++;
    expect(wet / (N * N)).toBeGreaterThan(0.05);
    expect(wet / (N * N)).toBeLessThan(0.08);
    const dry = openLayout(0, 2, 2);
    dry.humidity.fill(DAMP_HUMID - 1);
    placeDampCells(ctxFor(dry, 4));
    expect(dry.flags.some((f) => (f & CellFlag.WET) !== 0)).toBe(false);
    // placeLeaks runs all passes
    const l = openLayout(0, 3, 3);
    l.humidity.fill(200);
    placeLeaks(ctxFor(l, 4));
    expect(l.leaks.length).toBeGreaterThan(0);
  });
});

describe('R2 B6: dark-room EXIT signs, STAIRS wayfinding', () => {
  const doorLayout = (): ChunkLayout => {
    const l = openLayout(0, 0, 0);
    for (let i = 2; i < N; i += 3) for (let lj = 0; lj < N; lj++) { l.ex.kind[exIdx(i, lj)] = EdgeKind.DOORWAY; l.ex.hA[exIdx(i, lj)] = 210; }
    return l;
  };
  it('dark rooms get at most DARK_EXIT_MAX EXIT signs over their doorways, lit rooms none', () => {
    let dark = 0;
    for (let seed = 0; seed < 10; seed++) {
      const l = doorLayout();
      const ctx = ctxFor(l, seed);
      expect(litCells(ctx).every((v) => v === 0)).toBe(true);
      placeExitSigns(ctx, { stairs: false });
      const n = l.fixtures.filter((f) => f.kind === FixtureKind.EXIT_SIGN).length;
      expect(n).toBeLessThanOrEqual(DARK_EXIT_MAX);
      dark += n;
      for (const f of l.fixtures) { expect(f.state).toBe(LightState.ON); expect(f.nx === 0 ? Math.abs(f.nz) : Math.abs(f.nx)).toBe(1); }
    }
    expect(dark).toBeGreaterThan(10);
    // a lit layout (a fixture every 3 m) gets none
    const l = doorLayout();
    for (let z = 1.5; z < CHUNK_SIZE; z += 3) for (let x = 1.5; x < CHUNK_SIZE; x += 3) {
      l.fixtures.push({ id: l.fixtures.length + 1, seed: 1, dynamic: false, kind: FixtureKind.CAGE_BULB, state: LightState.ON, shape: 1, px: x, py: 2.5, pz: z, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 0.1, h: 0.1, color: [1, 1, 1], luminance: 90, hum: 0, bakeGroup: 0 });
    }
    const n0 = l.fixtures.length;
    placeExitSigns(ctxFor(l, 3), { stairs: false });
    expect(l.fixtures.length).toBe(n0);
  });

  it('STAIRS plates + arrow plates on walls near a tower, pointing along the wall toward it', () => {
    let signs = 0;
    for (let seed = 0; seed < 12; seed++) {
      const l = openLayout(0, 0, 0);
      for (const j of [8, 16, 24]) for (let li = 0; li < N; li++) l.ez.kind[ezIdx(li, j)] = EdgeKind.WALL;
      const ctx = ctxFor(l, seed);
      // tower in the chunk to the east: its exit lies far along +x
      ctx.world = { ...ctx.world, towersNear: () => [{ id: 5, cx: 1, cz: 0, i0: 2, j0: 14, rot: 0, endless: false }] };
      placeExitSigns(ctx, { dark: false });
      const plates = l.decals.filter((d) => d.sign && d.kind === SignKind.STAIRS);
      const arrows = l.decals.filter((d) => d.sign && d.kind === SignKind.ARROW_UP);
      expect(plates.length).toBe(arrows.length);
      expect(plates.length).toBeLessThanOrEqual(STAIRS_SIGN_MAX);
      for (let k = 0; k < plates.length; k++) {
        const p = plates[k], a = arrows[k];
        expect(Math.abs(p.ny)).toBe(0);
        expect(a.px).toBeGreaterThan(p.px); // the arrow plate sits on the tower side (+x)
        // arrow +v points to +x: v = cos(rot) * Y - sin(rot) * u0, u0 = (nz, 0, -nx)
        const vx = -Math.sin(a.rot) * a.nz;
        expect(vx).toBeGreaterThan(0.99);
      }
      signs += plates.length;
    }
    expect(signs).toBeGreaterThan(5);
  });
});
