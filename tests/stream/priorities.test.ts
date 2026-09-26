// tests/stream/priorities.test.ts (WP10) — priority ordering, desired set, hysteresis, look-ahead.

import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, EDGE_FOG } from '../../src/core/constants.ts';
import {
  basePriority, createMotion, desiredChunks, fogEnd, fogHidden, isDesired, jobPriority, keepResident, lookahead,
  QUERY_PRIORITY, rectDistance, updateMotion,
} from '../../src/stream/priorities.ts';

describe('priorities', () => {
  it('base = ring*20 + (inFrustum ? 0 : 30) + distance*2', () => {
    expect(basePriority(0, true, 0)).toBe(0);
    expect(basePriority(1, true, 20)).toBe(60);
    expect(basePriority(2, false, 40)).toBe(150);
  });

  it('orders: own chunk < nearer ring < frustum < distance; layout < build < bake; prefetch last', () => {
    const own = jobPriority(basePriority(0, true, 5), 'build', false, true);
    const ring0 = jobPriority(basePriority(0, true, 5), 'build', false, false);
    const ring1 = jobPriority(basePriority(1, true, 5), 'build', false, false);
    const ring1Behind = jobPriority(basePriority(1, false, 5), 'build', false, false);
    const ring1Far = jobPriority(basePriority(1, true, 30), 'build', false, false);
    expect(own).toBeLessThan(ring0);
    expect(ring0).toBeLessThan(ring1);
    expect(ring1).toBeLessThan(ring1Behind);
    expect(ring1).toBeLessThan(ring1Far);
    const b = basePriority(1, true, 10);
    expect(jobPriority(b, 'layout', false, false)).toBeLessThan(jobPriority(b, 'build', false, false));
    expect(jobPriority(b, 'build', false, false)).toBeLessThan(jobPriority(b, 'bake', false, false));
    // offsets exactly per spec
    expect(jobPriority(b, 'layout', false, false) - b).toBe(-90);
    expect(jobPriority(b, 'build', false, false) - b).toBe(-70);
    expect(jobPriority(b, 'bake', false, false) - b).toBe(60);
    expect(jobPriority(b, 'bake', true, false) - b).toBe(460);
    // the own-chunk head start is for layouts and builds, not full bakes
    expect(jobPriority(b, 'bake', false, true) - b).toBe(60);
    expect(jobPriority(b, 'build', false, true) - b).toBe(-1070);
    // distance beats the chunk ring: a ring-1 tile 2 m away is built before the far corner of the player's chunk
    expect(jobPriority(basePriority(1, true, 2), 'build', false, false)).toBeLessThan(jobPriority(basePriority(0, true, 50), 'build', false, false));
    // every build within the player gate (in view <= 40 m) precedes every bake, even the nearest in-view one
    expect(jobPriority(basePriority(1, true, 40), 'build', false, false)).toBeLessThan(jobPriority(basePriority(0, true, 0), 'bake', false, false, true));
    expect(jobPriority(basePriority(1, false, 20), 'build', false, false)).toBeLessThan(jobPriority(basePriority(0, true, 0), 'bake', false, false, true));
    // in-view bakes lead off-view bakes of the same ring and distance
    expect(jobPriority(basePriority(1, true, 10), 'bake', false, false, true)).toBeLessThan(jobPriority(basePriority(1, false, 10), 'bake', false, false, false));
    // a near bake leads the builds of tiles ~65 m farther away (lighting upgrades close by before the far ring)
    expect(jobPriority(basePriority(0, true, 5), 'bake', false, false)).toBeLessThan(jobPriority(basePriority(2, true, 75), 'build', false, false));
    // a prefetch build is behind every current-storey job within the radius
    expect(jobPriority(basePriority(0, true, 0), 'build', true, false)).toBeGreaterThan(jobPriority(basePriority(2, false, 60), 'bake', false, false));
    expect(QUERY_PRIORITY).toBeLessThan(own);
  });

  it('desired set: Chebyshev radius around the look-ahead chunk plus the player chunk, nearest ring first', () => {
    const out = new Int32Array(256);
    const n = desiredChunks(0, 0, 0, 0, 2, out);
    expect(n).toBe(25);
    expect([out[0], out[1]]).toEqual([0, 0]); // player chunk first
    for (let i = 1; i < 9; i++) expect(Math.max(Math.abs(out[i * 2]), Math.abs(out[i * 2 + 1]))).toBe(1);
    // look-ahead one chunk east: 5x5 around (1,0); the player chunk (0,0) is inside it
    const m = desiredChunks(1, 0, 0, 0, 2, out);
    expect(m).toBe(25);
    const set = new Set<string>();
    for (let i = 0; i < m; i++) set.add(`${out[i * 2]},${out[i * 2 + 1]}`);
    expect(set.has('3,0')).toBe(true);
    expect(set.has('-2,0')).toBe(false);
    expect(set.has('0,0')).toBe(true);
    // radius 0 with a far look-ahead: look-ahead chunk + player chunk
    const k = desiredChunks(1, 1, 0, 0, 0, out);
    expect(k).toBe(2);
    expect(isDesired(0, 0, 5, 5, 0, 0, 1)).toBe(true);
  });

  it('hysteresis: evict only beyond radius + 1 (6x6 chunks at radius 2)', () => {
    const R = 2;
    expect(keepResident(3, 0, 0, 0, 0, 0, R)).toBe(true); // at R+1: kept
    expect(keepResident(4, 0, 0, 0, 0, 0, R)).toBe(false); // beyond: evicted
    // walking east chunk by chunk, the resident band is at most 6 wide
    const resident = new Set<number>();
    for (let c = 0; c <= 6; c++) {
      for (let x = c - R; x <= c + R; x++) resident.add(x);
      for (const x of [...resident]) if (!keepResident(x, 0, c, 0, c, 0, R)) resident.delete(x);
      expect(resident.size).toBeLessThanOrEqual(2 * R + 2);
    }
    // oscillating across a chunk line never evicts and re-requests
    const band = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const c = i % 2;
      for (let x = c - R; x <= c + R; x++) band.add(x);
      for (const x of [...band]) if (!keepResident(x, 0, c, 0, c, 0, R)) band.delete(x);
    }
    expect([...band].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2, 3]);
    // the player's own chunk is always kept even if the look-ahead jumps far
    expect(keepResident(0, 0, 9, 9, 0, 0, R)).toBe(true);
  });

  it('look-ahead: centre = position + smoothed velocity * 2 s; teleports reset the velocity', () => {
    const m = createMotion();
    const out = { x: 0, z: 0 };
    // walk east at 3.2 m/s, 60 fps for 3 s
    for (let f = 0; f <= 180; f++) updateMotion(m, 3.2 * (f / 60), 0, (f * 1000) / 60);
    lookahead(m, m.x, m.z, out);
    expect(out.x - m.x).toBeGreaterThan(3.2 * EDGE_FOG.LOOKAHEAD_S * 0.95);
    expect(out.x - m.x).toBeLessThan(3.2 * EDGE_FOG.LOOKAHEAD_S * 1.01);
    expect(Math.abs(out.z)).toBeLessThan(1e-9);
    updateMotion(m, 500, 500, 3100); // teleport
    lookahead(m, 500, 500, out);
    expect(out.x).toBe(500);
    expect(out.z).toBe(500);
  });

  it('edge fog hides tiles whose nearest point is beyond EDGE_FOG.END * R', () => {
    expect(fogEnd(2)).toBeCloseTo(0.8 * 2 * CHUNK_SIZE);
    expect(fogEnd(0)).toBe(Infinity);
    expect(rectDistance(0, 0, 3, 4, 10, 10)).toBe(5);
    expect(rectDistance(5, 5, 0, 0, 10, 10)).toBe(0);
    expect(fogHidden(0, 0, 70, 0, 19.2, 2)).toBe(true); // 70 m > 61.44 m
    expect(fogHidden(0, 0, 60, 0, 19.2, 2)).toBe(false);
  });
});
