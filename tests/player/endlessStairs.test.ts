import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { StoreyId } from '../../src/core/ids.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { stampTower, towerFrame } from '../../src/world/structures/tower.ts';
import { input, openLayout, recordingBus, yawOf } from './helpers.ts';

describe('endless stair traversal on production collision', () => {
  for (const rot of [0, 1, 2, 3] as const) for (const direction of [-1, 1]) for (const offset of [-0.23, 0, 0.23]) {
    it(`walks repeated flights and reverses, rotation ${rot}, direction ${direction}, offset ${offset}`, () => {
      const site = { id: 17, cx: 0, cz: 0, i0: 8, j0: 8, rot, endless: true };
      const l = openLayout();
      stampTower(createChunkGrid(l, 1), site, 1);
      const data = new StoreyData();
      data.set(createChunkData(l, buildChunkCollision(l)));
      const world = createWorldQuery({ storey: () => 0, data: () => data });
      const host = { prefetch() {}, isPrefetched: () => true, switchStorey() {}, findSafeSpawn: async () => null, attachDynamicMesh: () => null };
      const f = towerFrame(site);
      const point = (u: number, v: number) => f.point(u * CELL + offset, v * CELL);
      const start = point(0.5, 0.5);
      const { bus } = recordingBus();
      const p = createPlayerSystem({ s: 0, x: start[0], z: start[1], y: 0, yaw: 0, pitch: 0, zone: 0, score: 0, reason: 'test' }, DEFAULT_SETTINGS, bus, host);
      const down = [point(0.5, 4.5), point(1.5, 4.5), point(1.5, 0.5), point(0.5, 0.5)];
      const up = [point(1.5, 0.5), point(1.5, 4.5), point(0.5, 4.5), point(0.5, 0.5)];
      for (const dir of [direction, -direction]) for (let lap = 0; lap < 4; lap++) {
        for (const [x, z] of dir < 0 ? down : up) {
          let frames = 0;
          while (Math.hypot(x - p.state.x, z - p.state.z) > 0.12 && frames++ < 1200) {
            p.state.yaw = yawOf(x - p.state.x, z - p.state.z);
            p.update(1 / 120, input({ moveZ: 1, sprint: lap % 2 === 1 }), world, bus, false);
          }
          expect(frames, JSON.stringify(p.state)).toBeLessThan(1200);
        }
      }
      expect(p.state.s).toBe(0);
      expect((p as any).debug.towerSwitches).toBeGreaterThanOrEqual(8);
      expect((p as any).debug.unstuckCount).toBe(0);
    });
  }

  for (const rot of [0, 1, 2, 3] as const) for (const direction of [-1, 1]) {
    it(`keeps feet on a mid-flight loading stop and permits reversal, rotation ${rot}, direction ${direction}`, () => {
      const site = { id: 17, cx: 0, cz: 0, i0: 8, j0: 8, rot, endless: false };
      const sets = [new StoreyData(), new StoreyData(), new StoreyData()];
      for (const s of [0, 1, 2] as StoreyId[]) {
        const l = openLayout(s);
        stampTower(createChunkGrid(l, 1), site, 1);
        sets[s].set(createChunkData(l, buildChunkCollision(l)));
      }
      let storey: StoreyId = 0, ready = false;
      const requested = new Set<number>();
      const world = createWorldQuery({ storey: () => storey, data: (s) => sets[s] });
      const host = { prefetch(s: StoreyId) { requested.add(s); }, isPrefetched: () => ready,
        switchStorey(s: StoreyId) { storey = s; }, findSafeSpawn: async () => null, attachDynamicMesh: () => null };
      const f = towerFrame(site), lane = direction < 0 ? 1.5 : 0.5;
      const [x, z] = f.point(lane * CELL, 4.5 * CELL), [dx, dz] = f.dir(0, -1);
      const { bus } = recordingBus();
      const p = createPlayerSystem({ s: 0, x, z, y: direction * 1.5, yaw: yawOf(dx, dz), pitch: 0, zone: 0, score: 0, reason: 'test' }, DEFAULT_SETTINGS, bus, host);
      for (let frame = 0; frame < 180; frame++) {
        p.update(1 / 60, input({ moveZ: 1, sprint: true }), world, bus, false);
        expect(Math.abs(p.state.y - world.floorAt(p.state.x, p.state.z, p.state.y))).toBeLessThan(0.005);
      }
      expect(p.state.s).toBe(0);
      expect(p.state.y).toBeCloseTo(direction * 1.59, 5);
      expect(requested.has(1) && requested.has(2)).toBe(true);
      const heldX = p.state.x, heldZ = p.state.z;
      p.state.yaw += Math.PI;
      for (let frame = 0; frame < 45; frame++) p.update(1 / 60, input({ moveZ: 1 }), world, bus, false);
      expect(Math.hypot(p.state.x - heldX, p.state.z - heldZ)).toBeGreaterThan(0.4);
      expect((p as any).debug.towerClamp).toBe(0);
      p.state.yaw -= Math.PI; ready = true;
      for (let frame = 0; frame < 240 && p.state.s === 0; frame++) p.update(1 / 60, input({ moveZ: 1 }), world, bus, false);
      expect(p.state.s).toBe(direction < 0 ? 1 : 2);
      expect((p as any).debug.unstuckCount).toBe(0);
    });
  }
});
