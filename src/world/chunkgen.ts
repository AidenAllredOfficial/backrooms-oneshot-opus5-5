// src/world/chunkgen.ts — the generateChunk pipeline, strict order per DESIGN §5 WP1 "Chunk pipeline" (WP1).
//
//  1. test scene?            7. zone generate(ctx)
//  2. setup (palette, cells)  8. glitch walls, pits
//  3. fields                  9. connectivity repair (targets: tower/elevator exits + landmark entrances)
//  4. seams -> freeze        10. labelRooms
//  5. arteries               11. lights: placeFixtures (lattice) + assignFixtureStates
//  6. stamps (tower,         12. content: keepClear, props, vignettes, anomalies, leaks, exit signs, chalk, decals
//     elevator, landmark)    13. spawn flags, ports, hash (+ validateLayout in dev/tests)

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE } from '../core/constants.ts';
import { cellIdx, type ChunkKey } from '../core/grid.ts';
import { CellFlag, EdgeTrim, type StoreyId, Zone, ZONE_NAMES } from '../core/ids.ts';
import { createEmptyLayout, NO_WATER, type ChunkLayout } from '../core/layout.ts';
import { rngFor, SALT } from '../core/rng.ts';
import type {
  DistrictInfo, FieldSampler, LightingProfile, WorldGen, WorldGenOptions, ZoneGenContext, ZonePalette,
} from '../core/world.ts';
import { STRUCTURE_ZONE } from '../core/zones.ts';
import { stampArteries } from './arteries.ts';
import { createChunkGrid } from './chunkGrid.ts';
import { computePorts, repairConnectivity } from './connectivity.ts';
import type { Districts } from './districts.ts';
import { fieldByte, withDecayAdd } from './fields.ts';
import { labelRooms, markSpawnCells } from './rooms.ts';
import type { Seams } from './seams.ts';
import type { Sites } from './sites.ts';
import { applyLightsOverride, testSceneChunk } from './testScenes.ts';
import { layoutHash, validateLayout } from './validate.ts';
import { generatorFor } from './zones/registry.ts';
import { LANDMARKS } from './landmarks/index.ts';
import { elevatorExitCell, stampElevator } from './structures/elevator.ts';
import { placeGlitchWalls } from './structures/glitch.ts';
import { placePits } from './structures/pit.ts';
import { stampTower, towerExitCell } from './structures/tower.ts';
import { stampDoorways } from './structures/doorways.ts';
import { placeAnomalies } from './content/anomalies.ts';
import { placeChalk } from './content/chalk.ts';
import { placeDecals } from './content/decals.ts';
import { assignFixtureStates } from './content/fixtureStates.ts';
import { placeFixtures } from './content/fixtures.ts';
import { computeKeepClear } from './content/keepClear.ts';
import { placeLeaks } from './content/leaks.ts';
import { placeProps } from './content/props.ts';
import { placeExitSigns } from './content/signs.ts';
import { placeVignettes } from './content/vignettes.ts';

const N = CHUNK_CELLS;

/** Everything the pipeline needs from the world (built once per WorldGen by worldgen.ts). */
export interface GenWorld {
  readonly seed: number;
  readonly opts: WorldGenOptions;
  readonly districts: Districts;
  readonly sites: Sites;
  readonly seams: Seams;
  fields(s: StoreyId): FieldSampler;
  paletteOf(s: StoreyId, d: DistrictInfo): ZonePalette;
  lightingOf(s: StoreyId, d: DistrictInfo): LightingProfile;
  arteryPalette(s: StoreyId): ZonePalette;
  /** The public facade (ctx.world, validateLayout's gen). */
  readonly facade: WorldGen;
}

type MetaEnv = { MODE?: string; DEV?: boolean };
/** 'test' under vitest (failures throw), 'dev' in the Vite dev server (failures warn), null otherwise (production,
 * plain Node tools). `WORLD_VALIDATE=warn` (Node env) downgrades test-mode failures to warnings; `off` disables. */
const ENV_MODE: 'test' | 'dev' | null = (() => {
  // vitest loads src natively (vitest.config.ts: no Vite transform, so no import.meta.env); its worker state carries
  // the env the transform would have injected (MODE 'test'). Plain Node tools, even ones a test spawns, have neither.
  const env = (import.meta as { env?: MetaEnv }).env ?? (globalThis as { __vitest_worker__?: { metaEnv?: MetaEnv } }).__vitest_worker__?.metaEnv;
  if (!env) return null;
  return env.MODE === 'test' ? 'test' : env.DEV ? 'dev' : null;
})();
function validateMode(): 'test' | 'dev' | null {
  if (ENV_MODE === null) return null;
  const o = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WORLD_VALIDATE;
  if (o === 'off') return null;
  return ENV_MODE === 'test' && o === 'warn' ? 'dev' : ENV_MODE;
}
let devWarnings = 0;

export function generateChunk(w: GenWorld, key: ChunkKey): ChunkLayout {
  const { seed, opts } = w;
  // ---- 1. test scene
  if (opts.testScene !== null) return applyLightsOverride(testSceneChunk(opts.testScene, key, seed), opts.lights);
  const { s, cx, cz } = key;

  // ---- 2. setup
  const district = w.districts.districtAt(s, cx, cz);
  const zone = district.zone;
  const gen = generatorFor(zone);
  const palette = w.paletteOf(s, district);
  const lighting = w.lightingOf(s, district);
  const l = createEmptyLayout(key, zone, district.id, district.mood);
  l.ceilCm.fill(palette.ceilCm);
  l.floorMat.fill(palette.floorMat);
  l.ceilMat.fill(palette.ceilMat);
  l.ceilKind.fill(palette.ceilKind);
  l.cellZone.fill(zone);
  l.wallMat.fill(palette.wallMat);
  l.trimMat.fill(palette.trimMat);
  const interiorTrim = palette.baseboard ? EdgeTrim.BASEBOARD : 0;
  for (const e of [l.ex, l.ez]) {
    e.matNeg.fill(palette.wallMat);
    e.matPos.fill(palette.wallMat);
    e.trim.fill(interiorTrim);
  }
  const grid = createChunkGrid(l, seed);

  // ---- 3. fields (the lighting profile's decay offset applies to the whole chunk)
  const baseFields = w.fields(s);
  const fields = lighting.decayAdd ? withDecayAdd(baseFields, lighting.decayAdd) : baseFields;
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  for (let lj = 0; lj < N; lj++) {
    const z = oz + (lj + 0.5) * CELL;
    for (let li = 0; li < N; li++) {
      const x = ox + (li + 0.5) * CELL;
      const c = cellIdx(li, lj);
      l.power[c] = fieldByte(fields.power(x, z));
      l.decay[c] = fieldByte(fields.decay(x, z));
      l.humidity[c] = fieldByte(fields.humidity(x, z));
      l.warmth[c] = fieldByte(fields.warmth(x, z));
    }
  }

  // ---- 4. seams, then freeze
  const seams = {
    W: w.seams.seam(s, 'x', cx, cz), N: w.seams.seam(s, 'z', cx, cz),
    E: w.seams.seam(s, 'x', cx + 1, cz), S: w.seams.seam(s, 'z', cx, cz + 1),
  };
  grid.setSeam('W', seams.W);
  grid.setSeam('N', seams.N);
  grid.setSeam('E', seams.E);
  grid.setSeam('S', seams.S);
  grid.freezeSeams();

  // ---- 5. arteries
  stampArteries(grid, w.sites.arteriesInChunk(cx, cz), w.arteryPalette(s), s);

  const ctx: ZoneGenContext = {
    key, seed, opts,
    rng: rngFor(seed, SALT.ZONE_LAYOUT, s, cx, cz),
    district, grid, seams,
    neighbors: {
      W: w.districts.districtAt(s, cx - 1, cz).zone, N: w.districts.districtAt(s, cx, cz - 1).zone,
      E: w.districts.districtAt(s, cx + 1, cz).zone, S: w.districts.districtAt(s, cx, cz + 1).zone,
    },
    fields, palette, lighting,
    world: w.facade,
  };

  // ---- 6. stamps
  const targets: [number, number][] = [];
  const structureExits: [number, number][] = [];
  const tower = w.sites.towerAt(cx, cz);
  if (tower) {
    stampTower(grid, tower, seed);
    const e = towerExitCell(tower);
    targets.push([e.li, e.lj]);
    structureExits.push([e.li, e.lj]);
  }
  const elevator = w.sites.elevatorAt(cx, cz);
  if (elevator) {
    stampElevator(grid, elevator, seed);
    const e = elevatorExitCell(elevator);
    targets.push([e.li, e.lj]);
    structureExits.push([e.li, e.lj]);
  }
  for (let c = 0; c < CHUNK_CELL_COUNT; c++) {
    if ((l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) l.cellZone[c] = STRUCTURE_ZONE;
  }
  const landmark = w.sites.landmarkAt(s, cx, cz);
  if (landmark) {
    const lg = LANDMARKS[landmark.kind];
    if (lg) {
      const r = lg.stamp(grid, ctx, landmark);
      for (const t of r.entrances) targets.push([t[0], t[1]]);
    }
  }

  const doorwayExits = stampDoorways(ctx, w.sites);
  targets.push(...doorwayExits);
  structureExits.push(...doorwayExits);

  // ---- 7. zone
  gen.generate(ctx);

  // ---- 8. structures that depend on the zone layout
  placeGlitchWalls(ctx);
  placePits(ctx);
  for (const [li, lj] of structureExits) levelStructureExit(l, li, lj);

  // ---- 9. connectivity
  repairConnectivity(grid, targets, zone === Zone.OFFICE || zone === Zone.MANILA ? 'doorway' : 'open');

  // ---- 10. rooms
  labelRooms(l);

  // ---- 11. lights
  if (lighting.placement === 'lattice') placeFixtures(ctx);
  assignFixtureStates(ctx);

  // ---- 12. content
  const keepClear = computeKeepClear(l);
  placeProps(ctx, gen.props, keepClear);
  placeVignettes(ctx, keepClear);
  placeAnomalies(ctx);
  placeLeaks(ctx);
  placeExitSigns(ctx);
  placeChalk(ctx);
  placeDecals(ctx); // last: reacts to leaks, pipes and props

  // ---- 13. finish
  markSpawnCells(l);
  l.ports = computePorts(l);
  l.hash = layoutHash(l);
  const mode = validateMode();
  if (mode !== null) {
    const errs = validateLayout(l, w.facade);
    if (errs.length > 0) {
      const msg = `validateLayout ${s}:${cx}:${cz} (${ZONE_NAME(zone)}): ${errs.slice(0, 8).join('; ')}`;
      if (mode === 'test') throw new Error(msg);
      if (devWarnings++ < 50) console.warn(msg);
    }
  }
  return l;
}

const ZONE_NAME = (z: number): string => ZONE_NAMES[z] ?? String(z);

/** Max |floor| (cm) of a tower / elevator exit cell. The vestibule and lobby floors are at 0 and the tower exit's
 * DOORWAY head is at 210 cm, so 30 cm keeps both the step (<= PLAYER.stepMax) and standing headroom (>= 1.8 m). */
export const STRUCTURE_EXIT_MAX_CM = 30;

/** Zones may raise or sink the cell outside a tower / elevator exit (Poolrooms decks at +36 cm, Level 0 sunken rooms
 * at -45 cm). A +36 cm sill under the 210 cm doorway head leaves 1.74 m, less than the player's height, and 45 cm is
 * more than a step. Split the difference: the exit cell goes halfway between 0 and the zone's level (capped), so the
 * player takes two small steps. */
export function levelStructureExit(l: ChunkLayout, li: number, lj: number): void {
  if (li < 0 || lj < 0 || li >= CHUNK_CELLS || lj >= CHUNK_CELLS) return;
  const c = lj * CHUNK_CELLS + li;
  const f = l.floorCm[c];
  if (f === 0 || l.waterCm[c] !== NO_WATER) return;
  l.floorCm[c] = Math.max(-STRUCTURE_EXIT_MAX_CM, Math.min(STRUCTURE_EXIT_MAX_CM, Math.round(f / 2)));
}
