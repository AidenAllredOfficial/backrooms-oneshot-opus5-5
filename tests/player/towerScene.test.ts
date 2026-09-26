// Integration: the real `tower` test scene (WP1 layoutFromAscii + WP4 stampTower + WP5 expandPeriodicSolids) with
// WP12's collision build and controller. Walks in through the exit X, the vestibule and door D, down lane A and
// lane B through the storey switch.
import { describe, expect, it } from 'vitest';
import { TOWER } from '../../src/core/constants.ts';
import { footprintPoint } from '../../src/core/grid.ts';
import { StructureKind, type StoreyId } from '../../src/core/ids.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import { createPlayerSystem } from '../../src/player/PlayerSystem.ts';
import { TOWER_DOOR_D } from '../../src/world/structures/tower.ts';
import { testSceneChunk, testSceneSpawn, testTowerSite } from '../../src/world/testScenes.ts';
import { input, recordingBus, TestHost, TestWorld, yawOf } from './helpers.ts';

const SEED = 1;

function sceneWorld(): TestWorld {
  const w = new TestWorld();
  for (const s of [0, 1, 2] as StoreyId[]) for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.add(testSceneChunk('tower', { s, cx, cz }, SEED));
  return w;
}

describe('tower test scene (WP1 + WP4 + WP5 geometry)', () => {
  const w = sceneWorld();
  const l = w.layoutAt(0, 0)!;
  const hasTower = l.structures.some((s) => s.kind === StructureKind.TOWER && s.portal);
  it.runIf(hasTower)('walks in through X and D, down both flights: one switch, continuous height', () => {
    const site = testTowerSite(SEED);
    const P = (um: number, vm: number): [number, number] => footprintPoint(site.i0, site.j0, TOWER.W_CELLS, TOWER.L_CELLS, site.rot, um, vm);
    const dMid = (TOWER_DOOR_D.v0 + TOWER_DOOR_D.v1) / 2;
    const path: [number, number][] = [
      P(3.0, 5.4), P(3.0, dMid), P(1.8, dMid), P(0.6, 0.6), P(0.6, 5.4), P(1.8, 5.4), P(1.8, 0.6),
    ];
    const { bus, ev } = recordingBus();
    const host = new TestHost(w);
    const spawn = testSceneSpawn('tower', 0, SEED);
    const p = createPlayerSystem(spawn, DEFAULT_SETTINGS, bus, host);
    let i = 0, off = 0, prevEff = NaN, maxJump = 0, lastS = p.state.s;
    const reached: number[] = [];
    for (let f = 0; f < 120 * 60 && i < path.length; f++) {
      const [tx, tz] = path[i];
      const st = p.state;
      const d = Math.hypot(tx - st.x, tz - st.z);
      if (d < 0.15) { reached.push(i); i++; continue; }
      st.yaw = yawOf(tx - st.x, tz - st.z);
      p.update(1 / 120, input({ moveZ: Math.min(1, d / 0.3 + 0.2) }), w, bus, false);
      if (st.s !== lastS) { off -= 3; lastS = st.s; }
      const eff = st.y + off;
      if (prevEff === prevEff) maxJump = Math.max(maxJump, Math.abs(eff - prevEff));
      prevEff = eff;
    }
    expect(reached.length).toBe(path.length);
    expect(host.switches).toEqual([1]);
    expect(ev.storeyChanged?.length).toBe(1);
    expect(maxJump).toBeLessThan(0.02);
    expect(prevEff).toBeCloseTo(-3, 1);
  });
});
