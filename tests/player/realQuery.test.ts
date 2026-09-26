// Integration: WP12's controller / traversal against WP10's real WorldQuery (src/stream/WorldQueryImpl.ts) over
// layouts from the WP1/WP4 test scenes and synthetic sketches, with WP12's buildChunkCollision. The TestWorld in
// helpers.ts is a reference implementation; this file checks the player behaves the same on the production query
// (e.g. its floorAt reports the lowest surface ABOVE the step reach instead of -Infinity).
import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_SIZE, PLAYER, TOWER, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, ezIdx, footprintPoint } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, SolidFlag, StructureKind, type StoreyId } from '../../src/core/ids.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import type { MeshBuffers } from '../../src/core/mesh.ts';
import { createPlayerState } from '../../src/core/player.ts';
import type { DynamicMeshHandle, WorldQuery } from '../../src/core/runtime.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import type { SpawnPoint } from '../../src/core/world.ts';
import { MOVE_RESULT, moveAndCollide, SCRATCH_BOXES } from '../../src/player/collision.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { DEFAULT_CONTROLLER, stepPlayer } from '../../src/player/controller.ts';
import { createPlayerSystem, type TraversalHost } from '../../src/player/PlayerSystem.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';
import { TOWER_DOOR_D } from '../../src/world/structures/tower.ts';
import { testSceneChunk, testSceneSpawn, testTowerSite } from '../../src/world/testScenes.ts';
import { input, openLayout, recordingBus, spawnAt, yawOf } from './helpers.ts';

class RealWorld {
  storey: StoreyId = 0;
  readonly sets: StoreyData[] = [new StoreyData(), new StoreyData(), new StoreyData()];
  readonly q: WorldQuery = createWorldQuery({ storey: () => this.storey, data: (s) => this.sets[s] });
  add(l: ChunkLayout): this { this.sets[l.key.s].set(createChunkData(l, buildChunkCollision(l))); return this; }
}

class RealHost implements TraversalHost {
  switches: StoreyId[] = [];
  prefetched = new Set<StoreyId>([0, 1, 2]);
  private readonly w: RealWorld;
  constructor(w: RealWorld) { this.w = w; }
  prefetch(): void {}
  isPrefetched(s: StoreyId): boolean { return this.prefetched.has(s); }
  switchStorey(to: StoreyId): void { this.switches.push(to); this.w.storey = to; }
  findSafeSpawn(s: StoreyId): Promise<SpawnPoint | null> {
    return Promise.resolve({ s, x: 5, y: 0, z: 5, yaw: 0, pitch: 0, zone: 0, score: 0, reason: 'test' });
  }
  attachDynamicMesh(_k: string, _m: MeshBuffers): DynamicMeshHandle | null { return null; }
}

const DT = 1 / 120;
const noEmit = (() => {}) as Parameters<typeof stepPlayer>[5];

describe('player on the production WorldQuery (WP10)', () => {
  it('walls: no tunnelling at 20 m/s, stops at radius from the face, slides at 45 degrees', () => {
    const l = openLayout();
    for (let li = 0; li < 32; li++) l.ez.kind[ezIdx(li, 10)] = EdgeKind.WALL;
    const w = new RealWorld().add(l);
    const face = 10 * CELL - WALL_T / 2;
    const s = createPlayerState(0, 10, 0, 8, 0, 0);
    s.yaw = yawOf(0, 1);
    for (let i = 0; i < 240; i++) {
      s.vx = 0; s.vz = 20; // 20 m/s into the wall every step
      stepPlayer(s, input({ moveZ: 1, sprint: true }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
      expect(s.z).toBeLessThanOrEqual(face - PLAYER.radius + 0.001);
    }
    expect(Math.abs(s.z - (face - PLAYER.radius))).toBeLessThan(0.001);
    // 45 degrees: keeps sliding along x
    const x0 = s.x;
    s.yaw = yawOf(1, 1);
    for (let i = 0; i < 240; i++) stepPlayer(s, input({ moveZ: 1 }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(s.x - x0).toBeGreaterThan(1.2);
    expect(s.z).toBeLessThanOrEqual(face - PLAYER.radius + 0.001);
  });

  it('steps up 0.30 m but not 0.45 m, never pops onto a higher surface', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) { l.floorCm[cellIdx(12, lj)] = 30; l.floorCm[cellIdx(20, lj)] = 45; l.floorCm[cellIdx(26, lj)] = 120; }
    const w = new RealWorld().add(l);
    const a = createPlayerState(0, 12.5, 0, 10, yawOf(1, 0), 0);
    let maxY = 0;
    for (let i = 0; i < 480; i++) { stepPlayer(a, input({ moveZ: 1 }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false); maxY = Math.max(maxY, a.y); }
    expect(maxY).toBeCloseTo(0.3, 5);
    expect(a.y).toBeCloseTo(0, 5);
    const b = createPlayerState(0, 22.5, 0, 10, yawOf(1, 0), 0);
    for (let i = 0; i < 360; i++) stepPlayer(b, input({ moveZ: 1, sprint: true }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(b.y).toBeCloseTo(0, 5);
    expect(Math.abs(b.x - (20 * CELL - PLAYER.radius))).toBeLessThan(0.001);
    // a 1.2 m ledge: blocked, feet never leave the floor
    const c = createPlayerState(0, 29, 0, 10, yawOf(1, 0), 0);
    for (let i = 0; i < 360; i++) {
      stepPlayer(c, input({ moveZ: 1, sprint: true }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
      expect(c.y).toBe(0);
    }
    expect(c.x).toBeLessThanOrEqual(26 * CELL - PLAYER.radius + 0.001);
  });

  it('doorways: entered without snagging from off-centre and oblique approaches', () => {
    const l = openLayout();
    for (let li = 0; li < 32; li++) l.ez.kind[ezIdx(li, 10)] = EdgeKind.WALL;
    l.ez.kind[ezIdx(10, 10)] = EdgeKind.DOORWAY; l.ez.hA[ezIdx(10, 10)] = 210;
    const w = new RealWorld().add(l);
    const doorX = 10.5 * CELL, lineZ = 10 * CELL;
    for (const off of [0, 0.12, -0.12, 0.22, -0.22]) {
      for (const deg of [0, 25, -25, 45, -45]) {
        const a = (deg * Math.PI) / 180;
        const s = createPlayerState(0, doorX + off - Math.tan(a) * 1.5, 0, lineZ - 1.5, yawOf(Math.sin(a), Math.cos(a)), 0);
        let steps = 0;
        while (s.z < lineZ + 0.6 && steps < 600) {
          stepPlayer(s, input({ moveZ: 1 }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
          steps++;
        }
        // 1.5 m / cos(a) at 1.45 m/s plus acceleration: well under 3 s, never parked on a jamb
        expect(s.z, `offset ${off} angle ${deg}`).toBeGreaterThan(lineZ + 0.6);
        expect(steps / 120, `offset ${off} angle ${deg}`).toBeLessThan(2.2 / Math.cos(a) + 0.4);
      }
    }
  });

  it('ramps: the soffit under a flight stops the head, the rim keeps the body off its sides', () => {
    const l = openLayout();
    l.solids.push({ kind: 'ramp', id: 1, x0: 6, z0: 6, x1: 7.2, z1: 13.2, y0: 1.0, y1: 4.0, dir: 2, steps: 20, mat: 9, flags: SolidFlag.COLLIDE | SolidFlag.WALKABLE_TOP, bakeGroup: 0 });
    const w = new RealWorld().add(l);
    const scratch = new Float32Array(SCRATCH_BOXES * 6);
    const walkX = (z: number, height: number): number => {
      const s = createPlayerState(0, 4, 0, z, 0, 0);
      for (let i = 0; i < 480; i++) moveAndCollide(w.q, s, 1.45 / 120, 0, height, scratch);
      return s.x;
    };
    expect(walkX(8.0, PLAYER.height)).toBeLessThan(6 - PLAYER.radius * 0.9 + 1e-3); // soffit 1.63 m
    expect(MOVE_RESULT.blocked).toBe(true);
    expect(walkX(9.0, PLAYER.height)).toBeGreaterThan(8); // soffit 2.05 m: walk under
    expect(walkX(7.0, PLAYER.height)).toBeLessThan(6 - PLAYER.radius * 0.9 + 1e-3); // side at body height
  });

  it('walking into an unloaded chunk is blocked', () => {
    const w = new RealWorld().add(openLayout(0, 0, 0));
    const s = createPlayerState(0, 35, 0, 10, yawOf(1, 0), 0);
    for (let i = 0; i < 600; i++) stepPlayer(s, input({ moveZ: 1, sprint: true }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(s.x).toBeLessThanOrEqual(CHUNK_SIZE - PLAYER.radius + 1e-6);
    expect(s.y).toBe(0);
  });

  it('crouch is blocked from standing up under a 1.5 m ceiling', () => {
    const l = openLayout();
    for (let lj = 0; lj < 32; lj++) for (let li = 15; li < 18; li++) l.ceilCm[cellIdx(li, lj)] = 150;
    const w = new RealWorld().add(l);
    const s = createPlayerState(0, 17 * CELL + 0.6, 0, 10, yawOf(1, 0), 0);
    for (let i = 0; i < 60; i++) stepPlayer(s, input({ crouch: true }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(s.crouch).toBe(1);
    for (let i = 0; i < 60; i++) stepPlayer(s, input(), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(s.crouch).toBe(1);
    // a standing player cannot walk in
    const t = createPlayerState(0, 13 * CELL, 0, 10, yawOf(1, 0), 0);
    for (let i = 0; i < 360; i++) stepPlayer(t, input({ moveZ: 1 }), DT, w.q, DEFAULT_CONTROLLER, noEmit, 0.0022, false);
    expect(t.x).toBeLessThanOrEqual(15 * CELL - PLAYER.radius + 0.001);
  });

  it('pit: walking into a VOID cell falls and warps to the storey below', async () => {
    const mk = (s: StoreyId): ChunkLayout => {
      const l = openLayout(s);
      for (let j = 10; j < 12; j++) for (let i = 10; i < 12; i++) l.flags[cellIdx(i, j)] = CellFlag.VOID;
      l.structures.push({
        id: 9, kind: StructureKind.PIT, bakeGroup: 0, i0: 10, j0: 10, i1: 12, j1: 12, rot: 0,
        portal: { kind: 'pit', min: [12, -6, 12], max: [14.4, -1.5, 14.4], towerId: 0, endless: false },
      });
      return l;
    };
    const w = new RealWorld().add(mk(0)).add(mk(1));
    const { bus, ev } = recordingBus();
    const host = new RealHost(w);
    const p = createPlayerSystem(spawnAt(13.2, 10.5, yawOf(0, 1)), DEFAULT_SETTINGS, bus, host);
    for (let f = 0; f < 60 * 4; f++) {
      p.update(1 / 60, input({ moveZ: f < 90 ? 1 : 0 }), w.q, bus, false);
      await Promise.resolve();
    }
    expect(ev.glitch?.[0]).toEqual({ seconds: 1.2, strength: 0.6 });
    expect(p.state.s).toBe(1);
    expect(ev.storeyChanged?.length).toBe(1);
    expect(ev.storeyChanged?.[0]).toMatchObject({ from: 0, to: 1, via: 'pit' });
    expect(p.state.y).toBe(0);
    expect(p.state.x).toBeCloseTo(5, 5);
  });

  it('teleport without y into a SOLID block: lands at floor level in a free cell (no drop from above)', () => {
    const l = openLayout();
    for (let j = 10; j < 13; j++) for (let i = 10; i < 13; i++) l.flags[cellIdx(i, j)] = CellFlag.SOLID;
    const w = new RealWorld().add(l);
    const { bus, ev } = recordingBus();
    const p = createPlayerSystem(spawnAt(5, 5), DEFAULT_SETTINGS, bus, new RealHost(w));
    p.teleport(0, 11.5 * CELL, null, 11.5 * CELL, 0, 0);
    let maxY = -Infinity;
    for (let f = 0; f < 120; f++) {
      p.update(1 / 60, input(), w.q, bus, false);
      maxY = Math.max(maxY, p.state.y);
      expect(Number.isFinite(p.state.eyeY)).toBe(true);
    }
    expect(maxY).toBeLessThan(0.01);
    expect(p.state.y).toBe(0);
    expect(ev.land ?? []).toEqual([]);
    const inside = p.state.x > 10 * CELL - PLAYER.radius && p.state.x < 13 * CELL + PLAYER.radius &&
      p.state.z > 10 * CELL - PLAYER.radius && p.state.z < 13 * CELL + PLAYER.radius;
    expect(inside).toBe(false);
  });

  const scene = new RealWorld();
  for (const s of [0, 1, 2] as StoreyId[]) for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) scene.add(testSceneChunk('tower', { s, cx, cz }, 1));
  const hasTower = scene.q.layoutAt(0, 0)?.structures.some((s) => s.kind === StructureKind.TOWER && s.portal) ?? false;

  it.runIf(hasTower)('tower scene: down both flights and back up; one switch each way, continuous height', () => {
    const site = testTowerSite(1);
    const P = (um: number, vm: number): [number, number] => footprintPoint(site.i0, site.j0, TOWER.W_CELLS, TOWER.L_CELLS, site.rot, um, vm);
    const dMid = (TOWER_DOOR_D.v0 + TOWER_DOOR_D.v1) / 2;
    const down: [number, number][] = [P(3.0, 5.4), P(3.0, dMid), P(1.8, dMid), P(0.6, 0.6), P(0.6, 5.4), P(1.8, 5.4), P(1.8, 0.6)];
    const back: [number, number][] = [P(1.8, 5.4), P(0.6, 5.4), P(0.6, 0.6)];
    scene.storey = 0;
    const { bus, ev } = recordingBus();
    const host = new RealHost(scene);
    const p = createPlayerSystem(testSceneSpawn('tower', 0, 1), DEFAULT_SETTINGS, bus, host);
    let off = 0, prevEff = NaN, maxJump = 0, lastS = p.state.s, maxEyeJump = 0, prevEye = NaN;
    const walk = (path: [number, number][]): number => {
      let i = 0;
      for (let f = 0; f < 120 * 60 && i < path.length; f++) {
        const [tx, tz] = path[i];
        const st = p.state;
        const d = Math.hypot(tx - st.x, tz - st.z);
        if (d < 0.15) { i++; continue; }
        st.yaw = yawOf(tx - st.x, tz - st.z);
        p.update(1 / 120, input({ moveZ: Math.min(1, d / 0.3 + 0.2) }), scene.q, bus, false);
        if (st.s !== lastS) { off += (st.s === ((lastS + 1) % 3) ? -3 : 3); lastS = st.s; }
        const eff = st.y + off;
        if (prevEff === prevEff) maxJump = Math.max(maxJump, Math.abs(eff - prevEff));
        prevEff = eff;
        const eye = st.eyeY + off;
        if (prevEye === prevEye) maxEyeJump = Math.max(maxEyeJump, Math.abs(eye - prevEye));
        prevEye = eye;
      }
      return i;
    };
    expect(walk(down)).toBe(down.length);
    expect(host.switches).toEqual([1]);
    expect(prevEff).toBeCloseTo(-3, 1);
    expect(walk(back)).toBe(back.length);
    expect(host.switches).toEqual([1, 0]);
    expect(ev.storeyChanged?.length).toBe(2);
    expect(maxJump).toBeLessThan(0.02);
    expect(maxEyeJump).toBeLessThan(0.02); // camera: no pop at the switch
  });
  it('update() cost: 60 fps frames in the tower scene stay well inside the 0.7 ms player/lighting/audio budget', () => {
    scene.storey = 0;
    const { bus } = recordingBus();
    const p = createPlayerSystem(testSceneSpawn('tower', 0, 1), DEFAULT_SETTINGS, bus, new RealHost(scene));
    const inp = input({ moveZ: 1 });
    for (let f = 0; f < 120; f++) p.update(1 / 60, inp, scene.q, bus, false); // warm up (JIT)
    const N = 1200;
    const t0 = performance.now();
    for (let f = 0; f < N; f++) {
      p.state.yaw += 0.01;
      p.update(1 / 60, inp, scene.q, bus, false);
    }
    const ms = (performance.now() - t0) / N;
    console.log(`[WP12 bench] PlayerSystem.update at 60 fps (2 sub-steps): ${ms.toFixed(4)} ms/frame`);
    expect(ms).toBeLessThan(0.35);
  });
});
