import { describe, expect, it } from 'vitest';
import { CellFlag } from '../../src/core/ids.ts';
import { PLAYER } from '../../src/core/constants.ts';
import { STRUCTURE_EXIT_MAX_CM } from '../../src/world/chunkgen.ts';
import { elevatorExitCell } from '../../src/world/structures/elevator.ts';
import { towerExitCell } from '../../src/world/structures/tower.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

// Regression: Poolrooms decks (+36 cm) and Level 0 sunken rooms (-45 cm) used to land on tower / elevator exit cells.
// The tower's exit doorway head is at 210 cm, so a +36 cm sill left 1.74 m, less than the player, and 45 cm is more
// than a step. Every exit must sit within STRUCTURE_EXIT_MAX_CM of the vestibule floor (0) and reach the storey.
describe('tower and elevator exits are walkable', () => {
  it('exit floor is within a step of the vestibule and of a storey-side neighbour', () => {
    const stepCm = Math.round(PLAYER.stepMax * 100);
    const bad: string[] = [];
    let checked = 0;
    // seeds 1 and 4 both contain raised Poolrooms and Level 0 sunken-room exits before the fix
    for (const seed of [1, 4]) {
      const gen = createWorldGen({ seed, seedText: String(seed), forceZone: null, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
      for (const s of [0, 2] as const) {
        const seen = new Set<number>();
        for (let cz = -6; cz <= 6; cz++) for (let cx = -6; cx <= 6; cx++) {
          const sites = [...gen.towersNear(s, cx, cz).map((t) => ({ t, exit: towerExitCell(t) })),
            ...gen.elevatorsNear(s, cx, cz).map((t) => ({ t, exit: elevatorExitCell(t) }))];
          for (const { t, exit } of sites) {
            if (t.cx !== cx || t.cz !== cz || seen.has(t.id)) continue;
            seen.add(t.id);
            if (exit.li < 0 || exit.lj < 0 || exit.li >= 32 || exit.lj >= 32) continue;
            const l = gen.generateChunk({ s, cx, cz });
            const e = l.floorCm[exit.lj * 32 + exit.li];
            let reach = false;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const i = exit.li + di, j = exit.lj + dj;
              if (i < 0 || j < 0 || i >= 32 || j >= 32) { reach = true; continue; }
              const c = j * 32 + i;
              if (l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR | CellFlag.SOLID)) continue;
              if (Math.abs(l.floorCm[c] - e) <= stepCm) reach = true;
            }
            checked++;
            if (Math.abs(e) > STRUCTURE_EXIT_MAX_CM || !reach) bad.push(`seed ${seed} s${s} chunk (${cx},${cz}) exit floor ${e} cm, reach ${reach}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  }, 120_000);
});
