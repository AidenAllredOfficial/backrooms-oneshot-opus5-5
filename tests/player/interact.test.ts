import { describe, expect, it } from 'vitest';
import { PropKind } from '../../src/core/ids.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { input, openLayout, recordingBus, spawnAt, TestHost, TestWorld, yawOf } from './helpers.ts';

describe('interact', () => {
  it('targets interactables within 1.6 m while looking level and emits interact', () => {
    const l = openLayout();
    l.props.push({ kind: PropKind.PHONE, variant: 0, x: 11, y: 0.75, z: 10, yaw: 0, scale: 1, flags: 0, seed: 1234 });
    l.props.push({ kind: PropKind.CRATE, variant: 0, x: 10, y: 0, z: 13, yaw: 0, scale: 1, flags: 0, seed: 5 });
    const w = new TestWorld().add(l);
    const { bus, ev } = recordingBus();
    const p = createPlayerSystem(spawnAt(10, 10, yawOf(1, 0)), DEFAULT_SETTINGS, bus, new TestHost(w));
    p.update(1 / 60, input(), w, bus, false);
    expect(p.state.target).toBe(PropKind.PHONE);
    p.update(1 / 60, input({ interactPressed: true }), w, bus, false);
    expect(ev.interact?.[0]).toMatchObject({ propKind: PropKind.PHONE, seed: 1234 });
    // looking steeply down: nothing targeted
    p.state.pitch = -0.9;
    p.update(1 / 60, input(), w, bus, false);
    expect(p.state.target).toBe(-1);
    // facing away: nothing; interact still emits with propKind -1
    p.state.pitch = 0; p.state.yaw = yawOf(-1, 0);
    p.update(1 / 60, input({ interactPressed: true }), w, bus, false);
    expect(p.state.target).toBe(-1);
    expect(ev.interact?.[1]).toMatchObject({ propKind: -1 });
    // too far (> 1.6 m)
    p.teleport(0, 8, 0, 10, yawOf(1, 0), 0);
    p.update(1 / 60, input(), w, bus, false);
    expect(p.state.target).toBe(-1);
  });

  it('teleport without y snaps to the floor once the chunk loads, and rescues a spawn inside a wall', () => {
    const l = openLayout();
    l.floorCm.fill(40);
    l.solids.push({ kind: 'box', id: 1, min: [9, 0, 9], max: [11, 3, 11], mat: 0, flags: 1, bakeGroup: 0 });
    const w = new TestWorld();
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(5, 5, 0), DEFAULT_SETTINGS, bus, host);
    p.teleport(0, 10, null, 10, 0, 0);
    p.update(1 / 60, input(), w, bus, false); // nothing loaded yet: holds
    expect(p.state.x).toBe(10);
    w.add(l);
    for (let i = 0; i < 5; i++) p.update(1 / 60, input(), w, bus, false);
    expect(p.state.y).toBeCloseTo(0.4, 5);
    // moved out of the box
    const inside = p.state.x > 9 - 0.28 && p.state.x < 11 + 0.28 && p.state.z > 9 - 0.28 && p.state.z < 11 + 0.28;
    expect(inside).toBe(false);
    expect(Math.hypot(p.state.x - 10, p.state.z - 10)).toBeLessThan(4 * 1.2);
  });

  it('teleport to another storey switches the streamer storey', () => {
    const w = new TestWorld().add(openLayout(0)).add(openLayout(2));
    const { bus } = recordingBus();
    const host = new TestHost(w);
    const p = createPlayerSystem(spawnAt(5, 5, 0), DEFAULT_SETTINGS, bus, host);
    p.teleport(2, 6, 0, 6, 0, 0);
    expect(host.switches).toEqual([2]);
    expect(p.state.s).toBe(2);
  });
});
