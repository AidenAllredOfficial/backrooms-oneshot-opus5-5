import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { CHUNK_SIZE } from '../../src/core/constants.ts';
import { portalDistance, throughPortal, worldPortalFrame } from '../../src/core/portalMath.ts';
import type { StoreyId } from '../../src/core/ids.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';
import { opts } from '../world/wp4-helpers.ts';
import { input, recordingBus, yawOf } from './helpers.ts';

describe('architectural doorways', () => {
  for (const destination of ['interior', 'level'] as const) it(`opens, crosses and walks back through a ${destination} doorway`, () => {
    const g = createWorldGen(opts(7));
    const k = destination === 'interior' ? { s: 0 as StoreyId, cx: 1, cz: 2 } : { s: 1 as StoreyId, cx: -4, cz: -4 };
    const l = g.generateChunk(k), spec = l.structures.find((s) => s.portal?.doorway?.effect === destination)!.portal!;
    const hit = { spec, ox: k.cx * CHUNK_SIZE, oz: k.cz * CHUNK_SIZE }, a = worldPortalFrame(hit), b = spec.doorway!.target;
    let s = k.s;
    const sets = [new StoreyData(), new StoreyData(), new StoreyData()];
    const register = (storey: StoreyId, x: number, z: number) => {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const layout = g.generateChunk({ s: storey, cx: Math.floor(x / CHUNK_SIZE) + dx, cz: Math.floor(z / CHUNK_SIZE) + dz });
        sets[storey].set(createChunkData(layout, buildChunkCollision(layout)));
      }
    };
    register(s, a.x, a.z); register(b.s, b.x, b.z);
    const world = createWorldQuery({ storey: () => s, data: (k) => sets[k] });
    let ready = false;
    const poses: number[] = [];
    const prefetched: { s: StoreyId; x: number; z: number }[] = [];
    const host = { prefetch(s: StoreyId, x: number, z: number) { prefetched.push({ s, x, z }); }, isPrefetched: () => ready, switchStorey(to: StoreyId) { s = to; }, findSafeSpawn: async () => null,
      attachDynamicMesh: () => null, setDoorYaw(_s: number, _cx: number, _cz: number, _seed: number, yaw: number) { poses.push(yaw); } };
    const { bus, ev } = recordingBus();
    const p = createPlayerSystem({ s, x: a.x + a.nx * 1.3, y: 0, z: a.z + a.nz * 1.3, yaw: yawOf(-a.nx, -a.nz), pitch: 0, zone: 0, score: 0, reason: 'test' }, DEFAULT_SETTINGS, bus, host);
    p.update(1 / 60, input({ interactPressed: true }), world, bus, false);
    expect(ev.interact?.[0].door).toBe('open');
    expect(ev.interact?.[0].seed).toBe(spec.doorway!.id);
    for (let f = 0; f < 90; f++) p.update(1 / 60, input(), world, bus, false);
    expect(poses.some((yaw) => Math.abs(yaw - poses[0]) > 1)).toBe(true);
    // A slow destination cannot strand the player in the blind cell beyond the opening.
    for (let f = 0; f < 120; f++) p.update(1 / 60, input({ moveZ: 1 }), world, bus, false);
    expect(portalDistance(a, p.state.x, p.state.z)).toBeGreaterThan(0.27);
    expect(p.state.s).toBe(k.s);
    ready = true;
    for (let f = 0; f < 150 && !ev.teleport?.length; f++) p.update(1 / 60, input({ moveZ: 1 }), world, bus, false);
    expect(p.state.s).toBe(b.s);
    expect(prefetched).toContainEqual({ s: k.s, x: a.x, z: a.z });
    expect(portalDistance(b, p.state.x, p.state.z)).toBeGreaterThan(0);
    expect(Math.hypot(p.state.x - b.x, p.state.z - b.z)).toBeLessThan(2);
    p.state.yaw = yawOf(-b.nx, -b.nz);
    for (let f = 0; f < 150 && (ev.teleport?.length ?? 0) < 2; f++) p.update(1 / 60, input({ moveZ: 1 }), world, bus, false);
    expect(p.state.s).toBe(k.s);
    expect(portalDistance(a, p.state.x, p.state.z)).toBeGreaterThan(0);
    expect(ev.teleport?.length).toBe(2);
    expect(Math.abs(p.state.yaw)).toBeLessThanOrEqual(Math.PI);

    // The reported downward angle was only 3 cm from the plane: the ordinary 5 cm near clip cut it away.
    p.teleport(k.s, a.x + a.nx * 0.031, 0, a.z + a.nz * 0.031, yawOf(-a.nx, -a.nz) + 0.08, -0.9674);
    p.update(1 / 60, input(), world, bus, false);
    const camera = new PerspectiveCamera(62, 1.6, 0.05, 400);
    p.applyToCamera(camera, 62);
    expect(camera.near).toBeLessThan(0.01);
    expect(portalDistance(a, camera.position.x, camera.position.z)).toBeGreaterThan(0);

    // Sideways head bob at the threshold cannot reveal the blind backing cell for a frame.
    p.teleport(k.s, a.x + a.nx * 0.001, 0, a.z + a.nz * 0.001, yawOf(-a.nx, -a.nz) + 0.6, 0);
    p.state.speed = 4; p.state.stridePhase = 1.5;
    p.update(1 / 1000, input(), world, bus, false);
    expect(portalDistance(a, p.state.eyeX, p.state.eyeZ)).toBeGreaterThanOrEqual(0.0039);
    p.applyToCamera(camera, 62);
    expect(camera.near).toBeLessThan(0.002);
    p.teleport(k.s, a.x + a.nx * 1, 0, a.z + a.nz * 1, 0, 0);
    p.update(1 / 60, input(), world, bus, false);
    p.applyToCamera(camera, 62);
    expect(camera.near).toBe(0.05);
  });

  it('preserves lateral position and height on a round trip for every orientation', () => {
    for (const n of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const m of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = { x: -20, y: 0, z: 300, nx: n[0], nz: n[1] }, b = { x: 90, y: 0.3, z: -70, nx: m[0], nz: m[1] };
      const p = { x: a.x + 0.14, y: 1.62, z: a.z - 0.4 };
      const q = throughPortal(a, b, p.x, p.y, p.z), r = throughPortal(b, a, q.x, q.y, q.z);
      expect(r.x).toBeCloseTo(p.x, 10); expect(r.y).toBeCloseTo(p.y, 10); expect(r.z).toBeCloseTo(p.z, 10);
    }
  });
});
