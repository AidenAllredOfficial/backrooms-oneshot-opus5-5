// src/mesh/surfaces.ts — lightmap charts + atlas of a tile. Produces charts identical to buildTile's (the bake
// job calls this; it does NOT build vertex buffers). Pure module (no three/DOM).
//
// Both entry points run the same deterministic planning pass (planTile): face records + chart specs are generated
// in a fixed order (floor grid, ceiling grid, walls by line / side / position, steps, soffits, boxes by id, ramps by
// id, plenums: the chart spec keys sort in that order), then the atlas is packed (atlas.ts).

import { LM_ATLAS_W, TILE_CELLS, type LmTpc } from '../core/constants.ts';
import { tileKeyStr, type TileKey } from '../core/grid.ts';
import type { SurfaceSet } from '../core/mesh.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { packAtlas } from './atlas.ts';
import { CeilCharts, emitCeilings, tileRecessed } from './ceilings.ts';
import { chartHash } from './chartHash.ts';
import { emitDecals } from './decals.ts';
import { VFaceIndex } from './faceIndex.ts';
import { emitFloors, emitPitBottoms, floorAux } from './floors.ts';
import { expandPeriodicSolids } from './periodic.ts';
import { Plan, toChart, type ChartSpec } from './plan.ts';
import { emitBlockers, emitBoxes } from './solids.ts';
import { emitRamps } from './stairs.ts';
import { cix, TileGrid } from './tileGrid.ts';
import { emitTrims } from './trims.ts';
import { WallModel, emitWalls } from './walls.ts';
import { emitWater } from './water.ts';

export interface TilePlan {
  grid: TileGrid;
  walls: WallModel;
  plan: Plan;
  specs: ChartSpec[];
  surfaces: SurfaceSet;
}

/** Most frequent value of a per-cell byte over the tile's cells that pass `ok` (ties: lowest value). */
function modeOf(g: TileGrid, arr: Uint8Array, ok: (k: number) => boolean, dflt: number): number {
  const cnt = new Int32Array(256);
  for (let cj = 0; cj < TILE_CELLS; cj++) for (let ci = 0; ci < TILE_CELLS; ci++) { const k = cix(ci, cj); if (ok(k)) cnt[arr[k]]++; }
  let best = dflt, n = 0;
  for (let i = 0; i < 256; i++) if (cnt[i] > n) { n = cnt[i]; best = i; }
  return best;
}

/** The shared planning pass behind buildTile and buildTileSurfaces. */
export function planTile(nb: LayoutNeighborhood, tile: TileKey, tpc: LmTpc): TilePlan {
  const g = new TileGrid(nb, tile);
  const floorLayer = modeOf(g, g.floorMat, (k) => g.hasFloor(k), 1);
  const ceilLayer = modeOf(g, g.ceilMat, (k) => !g.isSolid(k) && !g.isTower(k), 2);
  const plan = new Plan(tpc, floorLayer, ceilLayer);
  const walls = new WallModel(g);
  const solids = expandPeriodicSolids(nb.center);

  const aux = floorAux(g);
  emitFloors(plan, g, aux);
  emitPitBottoms(plan, g);
  const cc = new CeilCharts(plan, g);
  emitCeilings(plan, g, tileRecessed(g), cc);
  emitWalls(plan, walls);
  emitBlockers(plan, g);
  emitBoxes(plan, g, solids);
  emitRamps(plan, g, solids);
  const idx = new VFaceIndex(plan, g);
  emitTrims(plan, walls, idx);
  emitDecals(plan, g, idx, cc);
  emitWater(plan, g, aux);

  const specs = plan.finalize();
  const atlasH = packAtlas(specs, tpc);
  const charts = specs.map(toChart);
  const surfaces: SurfaceSet = { tileKey: tileKeyStr(tile), tpc, atlasW: LM_ATLAS_W, atlasH, charts, hash: chartHash(charts) };
  return { grid: g, walls, plan, specs, surfaces };
}

export function buildTileSurfaces(nb: LayoutNeighborhood, tile: TileKey, tpc: LmTpc): SurfaceSet {
  return planTile(nb, tile, tpc).surfaces;
}
