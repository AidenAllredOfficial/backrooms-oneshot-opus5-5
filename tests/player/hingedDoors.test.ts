import { describe, expect, it } from 'vitest';
import { PLAYER } from '../../src/core/constants.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { createHingedDoors, angleDelta } from '../../src/player/hingedDoors.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';
import { createChunkGrid } from '../../src/world/chunkGrid.ts';
import { placeLeaf } from '../../src/world/structures/doors.ts';
import { openLayout, recordingBus } from './helpers.ts';

describe('operable doors', () => {
  it('pauses against the player, resumes, remembers an evicted pose and latches only after closing', () => {
    const layout = () => {
      const l = openLayout();
      placeLeaf(createChunkGrid(l, 1), 'z', 10, 10, -1, -1, 0, 0, 123);
      return l;
    };
    const l = layout(), p = l.props[0], data = new StoreyData();
    data.set(createChunkData(l, buildChunkCollision(l)));
    const world = createWorldQuery({ storey: () => 0, data: () => data });
    const host = { prefetch() {}, isPrefetched: () => true, switchStorey() {}, findSafeSpawn: async () => null, attachDynamicMesh: () => null };
    const doors = createHingedDoors(host), player = createPlayerState(0, 12.6, 0, 11.5, 0, 0);
    const { bus, ev } = recordingBus(), emit = bus.emit.bind(bus);
    const hit = { kind: p.kind, x: p.x, y: p.y, z: p.z, cx: 0, cz: 0, seed: p.seed };
    doors.update(world, player, 0, emit);
    expect(doors.cue(hit)).toBe('Open door');
    expect(doors.use(hit)).toBe('open');
    for (let frame = 0; frame < 120; frame++) doors.update(world, player, 1 / 60, emit);
    const blocked = p.yaw;
    expect(Math.abs(angleDelta(blocked, p.door!.openYaw))).toBeGreaterThan(0.1);
    doors.update(world, player, 1 / 60, emit);
    expect(p.yaw).toBe(blocked);
    const boxes = new Float32Array(48), n = doors.appendBoxes(player.x, player.z, 2, boxes, 0);
    for (let i = 0; i < n; i++) {
      const o = i * 6, x = Math.max(boxes[o], Math.min(boxes[o + 3], player.x)), z = Math.max(boxes[o + 2], Math.min(boxes[o + 5], player.z));
      expect(Math.hypot(x - player.x, z - player.z)).toBeGreaterThanOrEqual(PLAYER.radius);
    }
    player.x = 15;
    doors.update(world, player, 1, emit);
    expect(angleDelta(p.yaw, p.door!.openYaw)).toBeCloseTo(0, 6);
    doors.reset();
    const fresh = layout(); data.set(createChunkData(fresh, buildChunkCollision(fresh)));
    doors.update(world, player, 0, emit);
    expect(fresh.props[0].yaw).toBeCloseTo(p.yaw, 6);
    expect(doors.cue(hit)).toBe('Close door');
    expect(doors.use(hit)).toBe('close');
    doors.update(world, player, 0.2, emit);
    expect(ev.interact ?? []).toHaveLength(0);
    doors.update(world, player, 1, emit);
    doors.update(world, player, 1, emit);
    expect(ev.interact).toHaveLength(1);
    expect(ev.interact![0].door).toBe('latch');
    expect(doors.cue(hit)).toBe('Open door');
  });
});
