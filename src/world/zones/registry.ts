// src/world/zones/registry.ts — zone id -> ZoneGenerator (via ZONE_INFO[zone].baseZone) (WP1).
// The table is built lazily on first use so that generator modules which import WP1 helpers (rooms.ts,
// defaultSeam.ts, ...) never observe an uninitialised binding through an import cycle.

import { Zone, type ZoneId } from '../../core/ids.ts';
import type { ZoneGenerator } from '../../core/world.ts';
import { ZONE_INFO } from '../../core/zones.ts';
import { concreteGenerator } from './concrete.ts';
import { lobbyGenerator } from './lobby.ts';
import { lowExpanseGenerator } from './lowExpanse.ts';
import { mazeGenerator } from './maze.ts';
import { officeGenerator } from './office.ts';
import { parkingGenerator } from './parking.ts';
import { pillarHallGenerator } from './pillarHall.ts';
import { pipeworksGenerator } from './pipeworks.ts';
import { poolroomsGenerator } from './poolrooms.ts';
import { warehouseGenerator } from './warehouse.ts';

let table: ZoneGenerator[] | null = null;

function buildTable(): ZoneGenerator[] {
  const byBase: Partial<Record<ZoneId, ZoneGenerator>> = {
    [Zone.LOBBY]: lobbyGenerator,
    [Zone.MAZE]: mazeGenerator,
    [Zone.LOW_EXPANSE]: lowExpanseGenerator,
    [Zone.PILLAR_HALL]: pillarHallGenerator,
    [Zone.OFFICE]: officeGenerator,
    [Zone.POOLROOMS]: poolroomsGenerator,
    [Zone.PARKING]: parkingGenerator,
    [Zone.PIPEWORKS]: pipeworksGenerator,
    [Zone.WAREHOUSE]: warehouseGenerator,
    [Zone.CONCRETE]: concreteGenerator,
  };
  return ZONE_INFO.map((zi) => {
    const g = byBase[zi.baseZone];
    if (!g) throw new Error(`zones/registry: no generator for base zone ${zi.baseZone} (${zi.name})`);
    return g;
  });
}

/** ZONE_GENERATORS[zone] (MANILA and DARK resolve to the LOBBY generator). */
export function generatorFor(zone: ZoneId): ZoneGenerator {
  table ??= buildTable();
  const g = table[zone];
  if (!g) throw new Error(`zones/registry: unknown zone ${zone}`);
  return g;
}
