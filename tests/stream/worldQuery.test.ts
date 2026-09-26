// tests/stream/worldQuery.test.ts (WP10) — WorldQueryImpl over hand-built layouts + collision.

import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_CELL_COUNT, CHUNK_CELLS, CHUNK_SIZE, PLAYER } from '../../src/core/constants.ts';
import { EDGE_SOUND } from '../../src/core/edges.ts';
import { cellIdx, chunkKeyStr, exIdx, ezIdx, type ChunkKey } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mat, Mood, PropKind, SolidFlag, StructureKind, SurfaceSound, Zone, type StoreyId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout, type Fixture } from '../../src/core/layout.ts';
import type { ChunkCollision } from '../../src/core/mesh.ts';
import type { FixtureRef, PortalHit } from '../../src/core/runtime.ts';
import { STRUCTURE_ZONE } from '../../src/core/zones.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';

type Box = { b: [number, number, number, number, number, number]; flags: number };

/** ChunkCollision with cell buckets expanded by PLAYER.radius (the WP12 rule). */
function collisionOf(k: ChunkKey, boxes: Box[], ramps: number[][] = []): ChunkCollision {
  const lists: number[][] = Array.from({ length: CHUNK_CELL_COUNT }, () => []);
  boxes.forEach(({ b }, i) => {
    const r = PLAYER.radius;
    const i0 = Math.max(0, Math.floor((b[0] - r) / CELL)), i1 = Math.min(31, Math.floor((b[3] + r) / CELL));
    const j0 = Math.max(0, Math.floor((b[2] - r) / CELL)), j1 = Math.min(31, Math.floor((b[5] + r) / CELL));
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) lists[cellIdx(ii, j)].push(i);
  });
  const cellStart = new Uint32Array(CHUNK_CELL_COUNT + 1);
  const flat: number[] = [];
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) { cellStart[c] = flat.length; flat.push(...lists[c]); }
  cellStart[CHUNK_CELL_COUNT] = flat.length;
  return {
    chunkKey: chunkKeyStr(k), boxes: new Float32Array(boxes.flatMap((x) => x.b)), boxFlags: new Uint8Array(boxes.map((x) => x.flags)),
    cellStart, cellBoxes: new Uint32Array(flat), ramps: new Float32Array(ramps.flat()),
  };
}

function fixture(id: number, px: number, py: number, pz: number, bakeGroup = 0): Fixture {
  return {
    id, kind: 0, state: 0, shape: 0, px, py, pz, nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 1.2, h: 0.6,
    color: [1, 1, 1], luminance: 3300, seed: 1, hum: 0.5, bakeGroup, dynamic: false,
  };
}

function plain(k: ChunkKey, floorCm = 0): ChunkLayout {
  const l = createEmptyLayout(k, Zone.LOBBY, 1, Mood.NORMAL);
  l.floorCm.fill(floorCm);
  l.ceilCm.fill(floorCm + 270);
  return l;
}

function world() {
  const kA: ChunkKey = { s: 0, cx: 0, cz: 0 };
  const A = plain(kA);
  A.mood = Mood.DYING;
  for (let lj = 0; lj < 32; lj++) A.ex.kind[exIdx(10, lj)] = EdgeKind.WALL; // wall on x = 12 m
  for (let li = 0; li < 10; li++) { A.ez.kind[ezIdx(li, 20)] = EdgeKind.PARTITION; A.ez.hA[ezIdx(li, 20)] = 150; } // z = 24 m
  A.flags[cellIdx(3, 3)] |= CellFlag.SOLID;
  A.blockCm[cellIdx(5, 5)] = 40;
  A.waterCm[cellIdx(6, 6)] = 30;
  A.floorMat[cellIdx(7, 7)] = Mat.CONCRETE_FLOOR;
  A.flags[cellIdx(8, 8)] |= CellFlag.VOID;
  A.flags[cellIdx(9, 2)] |= CellFlag.NOWALK;
  A.waterCm[cellIdx(9, 3)] = 150; // deeper than PLAYER.wadeMaxDepth
  A.blockCm[cellIdx(9, 4)] = 30; // a blocker low enough to step onto
  A.flags[cellIdx(20, 20)] |= CellFlag.TOWER;
  A.props.push({ kind: PropKind.PHONE, variant: 0, x: 15, y: 0.8, z: 15, yaw: 0, scale: 1, flags: 0, seed: 42 });
  A.props.push({ kind: PropKind.RADIO, variant: 0, x: 10, y: 0.8, z: 30, yaw: 0.3, scale: 1, flags: 0, seed: 43 });
  A.props.push({ kind: PropKind.CRATE, variant: 0, x: 15, y: 0, z: 12, yaw: 0, scale: 1, flags: 0, seed: 44 });
  A.fixtures.push(fixture(11, 4.2, 2.7, 4.2));
  A.fixtures.push(fixture(12, 25, 1.2, 25, 77));
  A.structures.push({
    id: 1, kind: StructureKind.TOWER, bakeGroup: 77, i0: 20, j0: 20, i1: 23, j1: 25, rot: 0,
    portal: { kind: 'tower', min: [24, -6, 24], max: [27.6, 6, 30], towerId: 77, endless: false },
  });
  A.emitters.push({ kind: 0, x: 2, y: 2.5, z: 2, gain: 1, seed: 3 });
  const cA = collisionOf(kA, [
    { b: [1.2, 0, 1.2, 2.4, 0.3, 2.4], flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP },
    { b: [0, 1.9, 13.2, 3.6, 2.0, 14.4], flags: SolidFlag.COLLIDE }, // an overhang (duct) at 1.9 m
  ], [[8.4, 1.2, 10.8, 2.4, 0, 0.3, 0, 0]]);
  const kB: ChunkKey = { s: 0, cx: 1, cz: 0 };
  const B = plain(kB);
  const s0 = new StoreyData();
  s0.set(createChunkData(A, cA));
  s0.set(createChunkData(B, collisionOf(kB, [])));
  const s1 = new StoreyData();
  const k1: ChunkKey = { s: 1, cx: 0, cz: 0 };
  s1.set(createChunkData(plain(k1, -300), collisionOf(k1, [])));
  const data = [s0, s1, new StoreyData()];
  const cur = { s: 0 as StoreyId };
  const q = createWorldQuery({ storey: () => cur.s, data: (s) => data[s] });
  return { q, cur };
}

describe('WorldQueryImpl', () => {
  const { q, cur } = world();

  it('floorAt: cell floor, WALKABLE_TOP boxes, ramps, blockers; NaN when unloaded', () => {
    expect(q.floorAt(-1, 5, 0)).toBeNaN(); // chunk (-1, 0) not loaded
    expect(q.isLoaded(-1, 5)).toBe(false);
    expect(q.floorAt(20, 5, 0)).toBe(0);
    expect(q.floorAt(1.8, 1.8, 0)).toBeCloseTo(0.3, 6); // step onto the box
    expect(q.floorAt(9.6, 1.8, 0)).toBeCloseTo(0.15, 6); // halfway up the ramp
    expect(q.floorAt(6.6, 6.6, 0)).toBe(0); // blocker 0.4 m is above step reach
    expect(q.floorAt(6.6, 6.6, 0.1)).toBeCloseTo(0.4, 6);
    expect(q.floorAt(10.2, 10.2, 0)).toBe(-Infinity); // VOID cell: falls
    expect(q.floorAt(CHUNK_SIZE + 3, 3, 0)).toBe(0); // neighbour chunk
    expect(q.floorAt(4.2, 4.2, 0)).toBeGreaterThan(PLAYER.stepMax + 1); // SOLID cell: never standable
  });

  it('ceilingAt: cell ceiling and overhanging boxes; waterAt / surfaceAt', () => {
    expect(q.ceilingAt(20, 5, 0)).toBeCloseTo(2.7, 6);
    expect(q.ceilingAt(1.8, 13.8, 0)).toBeCloseTo(1.9, 6);
    expect(q.ceilingAt(4.2, 4.2, 1)).toBe(1); // SOLID cell: no headroom
    expect(q.waterAt(7.8, 7.8)).toBeCloseTo(0.3, 6);
    expect(q.waterAt(20, 5)).toBe(null);
    expect(q.surfaceAt(7.8, 7.8, 0)).toBe(SurfaceSound.WATER_SHALLOW);
    expect(q.surfaceAt(20, 5, 0)).toBe(SurfaceSound.CARPET);
    expect(q.surfaceAt(9, 9, 0)).toBe(SurfaceSound.CONCRETE);
  });

  it('losClear / rayDistance: walls, partitions by height, SOLID cells, unloaded chunks, chunk borders', () => {
    expect(q.losClear(6, 1.5, 6, 18, 1.5, 6)).toBe(false); // through the wall at x = 12
    expect(q.losClear(6, 1.5, 6, 11, 1.5, 9)).toBe(true);
    expect(q.losClear(6, 1.0, 22, 6, 1.0, 26)).toBe(false); // partition (150 cm) at z = 24
    expect(q.losClear(6, 1.8, 22, 6, 1.8, 26)).toBe(true); // over it
    expect(q.losClear(1, 1, 4.2, 6, 1, 4.2)).toBe(false); // through the SOLID cell (3, 3)
    expect(q.losClear(1, 1, 5, -3, 1, 5)).toBe(false); // into an unloaded chunk
    expect(q.losClear(30, 1.5, 5, 45, 1.5, 7)).toBe(true); // across the chunk border
    expect(q.losClear(20, 1.5, 5, 20, 3.5, 5.5)).toBe(false); // exits through the ceiling
    expect(q.rayDistance(6, 1.5, 6, 1, 0, 20)).toBeCloseTo(6, 9);
    expect(q.rayDistance(6, 1.5, 6, 1, 0, 3)).toBe(3);
    expect(q.rayDistance(6, 1.5, 6, -1, 0, 20)).toBeCloseTo(6, 9); // unloaded chunk at x < 0
    expect(q.rayDistance(18, 1.5, 6, -2, 0, 20)).toBeCloseTo(6, 9); // direction need not be normalised
  });

  it('edgeSound / cellWalkable', () => {
    expect(q.edgeSound('x', 10, 0)).toBe(EDGE_SOUND[EdgeKind.WALL]);
    expect(q.edgeSound('x', 5, 0)).toBe(1);
    expect(q.edgeSound('z', 3, 20)).toBe(EDGE_SOUND[EdgeKind.PARTITION]);
    expect(q.edgeSound('x', -5, 0)).toBe(0); // unloaded
    expect(q.cellWalkable(3, 3)).toBe(false);
    expect(q.cellWalkable(8, 8)).toBe(false);
    expect(q.cellWalkable(4, 4)).toBe(true);
    expect(q.cellWalkable(5, 5)).toBe(false); // 40 cm blocker > stepMax
    expect(q.cellWalkable(9, 4)).toBe(true); // 30 cm blocker: a step
    expect(q.cellWalkable(6, 6)).toBe(true); // 30 cm of water: wade
    expect(q.cellWalkable(9, 3)).toBe(false); // 1.5 m of water
    expect(q.cellWalkable(9, 2)).toBe(false); // NOWALK
    expect(q.cellWalkable(20, 20)).toBe(true); // TOWER cells are walked through
    expect(q.cellWalkable(CHUNK_CELLS + 1, 1)).toBe(true);
    expect(q.cellWalkable(-1, 1)).toBe(false);
  });

  it('boxesNear returns each box once, in world coordinates', () => {
    const out = new Float32Array(6 * 16);
    expect(q.boxesNear(1.8, 1.8, 2, out)).toBe(1);
    expect(Array.from(out.slice(0, 6))).toEqual([1.2, 0, 1.2, 2.4, expect.closeTo(0.3, 6), 2.4].map((v) => (typeof v === 'number' ? expect.closeTo(v, 5) : v)));
    expect(q.boxesNear(1.8, 1.8, 20, out)).toBe(2);
    expect(q.boxesNear(30, 30, 1, out)).toBe(0);
    expect(q.boxesNear(1.8, 1.8, 20, new Float32Array(6))).toBe(1); // capacity respected
  });

  it('portalAt / portalsNear', () => {
    const hit = q.portalAt(25, 0, 25) as PortalHit;
    expect(hit).not.toBe(null);
    expect(hit.spec.kind).toBe('tower');
    expect(hit.ox).toBe(0);
    expect(q.portalAt(25, 7, 25)).toBe(null);
    expect(q.portalAt(10, 0, 10)).toBe(null);
    const out: PortalHit[] = [];
    expect(q.portalsNear(20, 20, 12, out)).toBe(1);
    expect(out[0]).toBe(hit); // precomputed, no allocation
    expect(q.portalsNear(0, 0, 5, out)).toBe(0);
    expect(out.length).toBe(0);
  });

  it('propAt: interactable props only, rotated footprints, walls hide props', () => {
    const h = q.propAt(15, 16.5, 0, 1.6); // looking -z at the phone at z = 15
    expect(h?.kind).toBe(PropKind.PHONE);
    expect(h?.seed).toBe(42);
    expect(q.propAt(15, 17.5, 0, 1.6)).toBe(null); // too far
    expect(q.propAt(15, 13.4, Math.PI, 1.6)?.kind).toBe(PropKind.PHONE); // from the other side
    expect(q.propAt(15, 13.4, 0, 3)).toBe(null); // CRATE is not interactable
    expect(q.propAt(13, 30, Math.PI / 2, 5)).toBe(null); // radio behind the wall at x = 12
  });

  it('zoneAt / moodAt are cell-based (tower cells: STRUCTURE_ZONE, NORMAL)', () => {
    expect(q.zoneAt(5, 5)).toBe(Zone.LOBBY);
    expect(q.zoneAt(20 * CELL + 0.5, 20 * CELL + 0.5)).toBe(STRUCTURE_ZONE);
    expect(q.moodAt(5, 5)).toBe(Mood.DYING);
    expect(q.moodAt(20 * CELL + 0.5, 20 * CELL + 0.5)).toBe(Mood.NORMAL);
  });

  it('fixturesNear expands tower fixtures (replicas share the base fixture); emittersNear', () => {
    const out: FixtureRef[] = [];
    const n = q.fixturesNear(25, 25, 2, out);
    expect(n).toBe(4); // y = 1.2 + 3k within |y| <= 6: k = -2..1
    expect(new Set(out.map((f) => f.f.id))).toEqual(new Set([12]));
    expect(out.map((f) => f.wy).sort((a, b) => a - b)).toEqual([-4.8, -1.8, 1.2, 4.2].map((v) => expect.closeTo(v, 9)));
    expect(out[0].tileKey).toBe('0:0:0:3');
    expect(q.fixturesNear(4, 4, 1, out)).toBe(1);
    expect(out[0].tileKey).toBe('0:0:0:0');
    const em: { e: unknown }[] = [];
    expect(q.emittersNear(2, 2, 1, em as never)).toBe(1);
  });

  it('huge, infinite or NaN ranges stay bounded (clamped to the loaded chunks)', () => {
    const out = new Float32Array(6 * 16);
    expect(q.boxesNear(1.8, 1.8, Infinity, out)).toBe(2);
    expect(q.boxesNear(1.8, 1.8, 1e9, out)).toBe(2);
    expect(q.boxesNear(Infinity, 1.8, 1, out)).toBe(0);
    expect(q.boxesNear(NaN, 1.8, 1, out)).toBe(0);
    expect(q.boxesNear(1.8, 1.8, NaN, out)).toBe(0);
    const fx: FixtureRef[] = [];
    expect(q.fixturesNear(0, 0, Infinity, fx)).toBe(5); // 1 plain + 4 tower replicas
    expect(q.fixturesNear(-Infinity, 0, 5, fx)).toBe(0);
    const pt: PortalHit[] = [];
    expect(q.portalsNear(0, 0, 1e12, pt)).toBe(1);
    // rays: unloaded chunks occlude, so an infinite maxDist ends at the loaded edge
    expect(q.rayDistance(40, 1.2, 5, 1, 0, Infinity)).toBeCloseTo(2 * CHUNK_SIZE - 40, 6);
    expect(q.rayDistance(40, 1.2, 5, 1, 0, 1e12)).toBeCloseTo(2 * CHUNK_SIZE - 40, 6);
    expect(q.losClear(40, 1.2, 5, 1e12, 1.2, 5)).toBe(false);
    // an empty storey
    cur.s = 2;
    expect(q.boxesNear(0, 0, Infinity, out)).toBe(0);
    expect(q.fixturesNear(0, 0, Infinity, fx)).toBe(0);
    cur.s = 0;
  });

  it('reads the current storey data set', () => {
    cur.s = 1;
    expect(q.storey).toBe(1);
    expect(q.floorAt(5, 5, -3)).toBe(-3);
    expect(q.layoutAt(0, 0)?.key.s).toBe(1);
    expect(q.floorAt(CHUNK_SIZE + 5, 5, 0)).toBeNaN();
    cur.s = 0;
    expect(q.floorAt(5, 5, 0)).toBe(0);
  });
});
