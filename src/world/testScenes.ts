// src/world/testScenes.ts — hand-authored test scenes: leak / cornell / tower / materials / flicker / grid (WP1).
//
// Scenes are built with layoutFromAscii at chunk (0, 0) of storey s; every other chunk is SOLID-filled (the scene
// rooms are inset, so every chunk border line is OPEN between SOLID cells and all chunks agree). `grid` (the WP0
// room grid) tiles every chunk: its border lines carry the same walls + doorways on both sides.

import { CELL, CHUNK_CELLS, CHUNK_CELL_COUNT, CHUNK_SIZE, STD_CEIL_CM, WALL_T } from '../core/constants.ts';
import { cellIdx, exIdx, ezIdx, type ChunkKey } from '../core/grid.ts';
import {
  CeilKind, CellFlag, FixtureKind, LightState, Mat, MAT_COUNT, Mood, PROP_KIND_COUNT, PropKind, type PropKindId, SolidFlag,
  type StoreyId, Zone,
} from '../core/ids.ts';
import { createEmptyLayout, fixtureId, fixtureSeed, type ChunkLayout } from '../core/layout.ts';
import { PROP_DEFS } from '../core/props.ts';
import { hash3, SALT } from '../core/rng.ts';
import type { ChunkGrid, SpawnPoint, TestSceneId, TowerSite, WorldGenOptions } from '../core/world.ts';
import { STRUCTURE_ZONE } from '../core/zones.ts';
import { layoutFromAscii } from './ascii.ts';
import { markFixtureTiles } from './arteries.ts';
import { createChunkGrid } from './chunkGrid.ts';
import { computePorts } from './connectivity.ts';
import { labelRooms, markSpawnCells } from './rooms.ts';
import { layoutHash } from './validate.ts';
import { stampTower, towerExitCell } from './structures/tower.ts';

const N = CHUNK_CELLS;
const ROOM = 8; // grid scene room size

/** Character-grid builder in the ascii.ts format (cells default SOLID). */
class SceneText {
  readonly rows: string[][] = [];
  constructor() {
    for (let y = 0; y <= 2 * N; y++) this.rows.push(new Array<string>(2 * N + 1).fill(' '));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) this.rows[2 * j + 1][2 * i + 1] = '#';
  }
  cell(i: number, j: number, ch: string): void { this.rows[2 * j + 1][2 * i + 1] = ch; }
  /** Floor cells [i0,i1)x[j0,j1) enclosed by WALL edges (existing edges inside are kept). */
  room(i0: number, j0: number, i1: number, j1: number): void {
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) this.cell(i, j, '.');
    for (let j = j0; j < j1; j++) { this.xEdge(i0, j, '|'); this.xEdge(i1, j, '|'); }
    for (let i = i0; i < i1; i++) { this.zEdge(i, j0, '-'); this.zEdge(i, j1, '-'); }
  }
  xEdge(i: number, j: number, ch: string): void { this.rows[2 * j + 1][2 * i] = ch; }
  zEdge(i: number, j: number, ch: string): void { this.rows[2 * j][2 * i + 1] = ch; }
  text(): string { return this.rows.map((r) => r.join('')).join('\n'); }
}

/** The tower of the `tower` scene (same site in every storey: towers are storey-free). */
export function testTowerSite(seed: number): TowerSite {
  return { id: hash3(seed, SALT.TOWER, 0x7e57), cx: 0, cz: 0, i0: 14, j0: 12, rot: 0, endless: false };
}

function sceneText(id: TestSceneId): { text: string; palette?: Parameters<typeof layoutFromAscii>[2] } {
  const t = new SceneText();
  switch (id) {
    case 'leak': {
      // rooms A [4,12) and B [12,20) share the WALL on line x = 12; one light in A, 1.5 m from the wall
      t.room(4, 8, 12, 16);
      t.room(12, 8, 20, 16);
      t.cell(10, 11, 'L');
      break;
    }
    case 'cornell': {
      t.room(10, 10, 16, 16); // 6x6; the SKY_PANEL and the grey wall are patched in below
      break;
    }
    case 'tower': {
      t.room(3, 3, 29, 29);
      for (let j = 5; j < 29; j += 4) for (let i = 5; i < 29; i += 4) if (!(i >= 12 && i < 19 && j >= 10 && j < 19)) t.cell(i, j, 'L');
      break;
    }
    case 'materials': {
      t.room(2, 2, 30, 30);
      for (let j = 4; j < 30; j += 4) for (let i = 3; i < 30; i += 4) t.cell(i, j, 'L');
      break;
    }
    case 'flicker': {
      t.room(8, 8, 24, 24);
      t.cell(11, 11, 'f');
      t.cell(20, 11, 'y');
      t.cell(11, 20, 'y');
      t.cell(20, 20, 'y');
      break;
    }
    case 'grid': {
      const n = N / ROOM, mid = ROOM / 2;
      for (let rj = 0; rj < n; rj++) {
        for (let ri = 0; ri < n; ri++) {
          const i0 = ri * ROOM, j0 = rj * ROOM;
          t.room(i0, j0, i0 + ROOM, j0 + ROOM);
          t.cell(i0 + 3, j0 + 3, 'L');
        }
      }
      for (let rj = 0; rj < n; rj++) {
        for (let ri = 0; ri < n; ri++) {
          const i0 = ri * ROOM, j0 = rj * ROOM;
          t.xEdge(i0, j0 + mid, 'd'); t.xEdge(i0 + ROOM, j0 + mid, 'd');
          t.zEdge(i0 + mid, j0, 'd'); t.zEdge(i0 + mid, j0 + ROOM, 'd');
        }
      }
      break;
    }
  }
  return { text: t.text() };
}

/** Recomputes lattice fixture ids with the world seed (layoutFromAscii has no seed). */
function reseed(l: ChunkLayout, seed: number): void {
  const ox = l.key.cx * CHUNK_SIZE, oz = l.key.cz * CHUNK_SIZE;
  for (const f of l.fixtures) {
    if (f.bakeGroup !== 0) continue;
    const id = fixtureId(seed, l.key.s, Math.floor((ox + f.px) / 0.6 + 1e-6), Math.floor((oz + f.pz) / 0.6 + 1e-6), f.kind);
    f.id = id;
    f.seed = fixtureSeed(id);
  }
}

function finish(l: ChunkLayout): ChunkLayout {
  labelRooms(l);
  markSpawnCells(l);
  l.ports = computePorts(l);
  l.hash = 0;
  l.hash = layoutHash(l);
  return l;
}

function solidChunk(key: ChunkKey): ChunkLayout {
  const l = createEmptyLayout(key, Zone.LOBBY, 0, Mood.NORMAL);
  l.flags.fill(CellFlag.SOLID);
  l.ceilCm.fill(STD_CEIL_CM);
  l.floorMat.fill(Mat.CARPET_L0);
  l.ceilMat.fill(Mat.CEILING_TILE);
  l.ceilKind.fill(CeilKind.TILES);
  l.wallMat.fill(Mat.WALLPAPER_L0);
  for (const e of [l.ex, l.ez]) { e.matNeg.fill(Mat.WALLPAPER_L0); e.matPos.fill(Mat.WALLPAPER_L0); }
  return finish(l);
}

export function testSceneChunk(id: TestSceneId, key: ChunkKey, seed: number): ChunkLayout {
  if (id !== 'grid' && (key.cx !== 0 || key.cz !== 0)) return solidChunk(key);
  const { text } = sceneText(id);
  const l = layoutFromAscii(key, text);
  // uniform, calm fields for hand-authored scenes
  l.power.fill(220); l.decay.fill(40); l.humidity.fill(60); l.warmth.fill(128);
  reseed(l, seed);
  const g = createChunkGrid(l, seed);
  switch (id) {
    case 'cornell': {
      // grey (WAREHOUSE palette: CMU_PAINTED) east wall, seen from inside (face in cell i-1 => matNeg)
      for (let j = 10; j < 16; j++) l.ex.matNeg[exIdx(16, j)] = Mat.CMU_PAINTED;
      // one 1.2 x 1.2 SKY_PANEL centred on the vertex (13, 13)
      const px = 13 * CELL, pz = 13 * CELL;
      g.addFixture({
        kind: FixtureKind.SKY_PANEL, state: LightState.ON, shape: 0, px, py: STD_CEIL_CM / 100, pz,
        nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 1.2, h: 1.2, color: [1, 0.97, 0.93], luminance: 2500, hum: 0.3, bakeGroup: 0,
      }, { latticeI: Math.floor((key.cx * CHUNK_SIZE + px) / 0.6 + 1e-6), latticeJ: Math.floor((key.cz * CHUNK_SIZE + pz) / 0.6 + 1e-6) });
      markFixtureTiles(l, px, pz, 0.6, 0.6);
      break;
    }
    case 'materials': {
      // 28 floor patches (7 columns x 4 rows of 4x7 cells) and 28 wall panels along the north and south walls: the
      // placed layers 0..27 (the texture realism v2 reserved layers from 28 on are not placed until their lanes do)
      const placed = Math.min(MAT_COUNT, 28);
      for (let j = 2; j < 30; j++) {
        for (let i = 2; i < 30; i++) {
          const layer = Math.min(placed - 1, Math.floor((i - 2) / 4) + 7 * Math.floor((j - 2) / 7));
          l.floorMat[cellIdx(i, j)] = layer;
        }
      }
      for (let i = 2; i < 30; i++) {
        const layer = i - 2;
        l.ez.matPos[ezIdx(i, 2)] = layer; // north wall, face inside the room (cell j = 2)
        l.ez.matNeg[ezIdx(i, 30)] = placed - 1 - layer; // south wall, face in cell j = 29
        l.ez.trim[ezIdx(i, 2)] = 0; l.ez.trim[ezIdx(i, 30)] = 0;
      }
      placePropGallery(g, 2, 30, 2, 30);
      break;
    }
    case 'tower': {
      const site = testTowerSite(seed);
      stampTower(g, site, seed);
      // defensive: whatever the stamp did, tower cells belong to the structure zone
      for (let c = 0; c < CHUNK_CELL_COUNT; c++) if ((l.flags[c] & (CellFlag.TOWER | CellFlag.ELEVATOR)) !== 0) l.cellZone[c] = STRUCTURE_ZONE;
      break;
    }
    case 'flicker': {
      for (const f of l.fixtures) if (f.state === LightState.FLICKER) f.dynamic = true;
      break;
    }
    default: break;
  }
  return finish(l);
}

/** QA `lights` override on a finished scene layout (generated chunks get it from WP4 assignFixtureStates):
 * 'on' = every fixture ON and static, 'dead' = every fixture OFF; structure (tower/elevator) fixtures stay ON. */
export function applyLightsOverride(l: ChunkLayout, mode: WorldGenOptions['lights']): ChunkLayout {
  if (mode === 'default') return l;
  for (const f of l.fixtures) {
    f.dynamic = false;
    f.state = f.bakeGroup !== 0 || mode === 'on' ? LightState.ON : LightState.OFF;
  }
  markSpawnCells(l);
  l.hash = 0;
  l.hash = layoutHash(l);
  return l;
}

/** Base height (m above the floor) of wall-mounted gallery props; everything else stands on the floor. */
const GALLERY_MOUNT: Readonly<Partial<Record<number, number>>> = {
  [PropKind.VENT_GRILLE]: 2.2, [PropKind.OUTLET]: 0.3, [PropKind.THERMOSTAT]: 1.4, [PropKind.EXTINGUISHER]: 0.45,
  [PropKind.LIFEBUOY]: 1.1,
};
const GALLERY_MAX_H = 2.6; // m: taller props (SHELF_RACK) are scaled to fit under the 2.7 m ceiling
const GALLERY_GAP = 0.4; // m between neighbouring props along a wall

/** One prop of every PropKind along the west wall (cells li = x0), then the east wall (li = x1 - 1) of the room
 * [x0, x1) x [z0, z1), each with its back to the wall and facing into the room (DESIGN §5 WP6 screenshot). */
function placePropGallery(g: ChunkGrid, x0: number, x1: number, z0: number, z1: number): void {
  const wallW = x0 * CELL + WALL_T / 2, wallE = x1 * CELL - WALL_T / 2;
  const zStart = z0 * CELL + 0.3, zEnd = z1 * CELL - 0.3;
  let side = 0; // 0 = west wall (facing +x, yaw -PI/2), 1 = east wall (facing -x, yaw +PI/2)
  let z = zStart;
  for (let kind = 0; kind < PROP_KIND_COUNT; kind++) {
    const def = PROP_DEFS[kind];
    const scale = def.size[1] > GALLERY_MAX_H ? GALLERY_MAX_H / def.size[1] : 1;
    const along = def.size[0] * scale, depth = def.size[2] * scale;
    if (z + along > zEnd) {
      if (side === 1) break; // both walls full (does not happen for the 45 kinds: ~56 m of 67 m used)
      side = 1;
      z = zStart;
    }
    const x = side === 0 ? wallW + depth / 2 + 0.02 : wallE - depth / 2 - 0.02;
    g.addProp({
      kind: kind as PropKindId, variant: 0, x, y: GALLERY_MOUNT[kind] ?? 0, z: z + along / 2,
      yaw: side === 0 ? -Math.PI / 2 : Math.PI / 2, scale,
      flags: (def.collide ? SolidFlag.COLLIDE : 0) | (def.occlude ? SolidFlag.OCCLUDE : 0), seed: hash3(0x9a11e7, SALT.PROP, kind),
    });
    z += along + GALLERY_GAP;
  }
}

/** Where to stand in each scene (storey s). */
export function testSceneSpawn(id: TestSceneId, s: StoreyId, seed: number): SpawnPoint {
  const P = (li: number, lj: number, yaw: number, reason: string): SpawnPoint =>
    ({ s, x: (li + 0.5) * CELL, y: 0, z: (lj + 0.5) * CELL, yaw, pitch: 0, zone: Zone.LOBBY, score: 0, reason: `testScene ${id}: ${reason}` });
  switch (id) {
    case 'leak': return P(16, 12, Math.PI / 2, 'room B facing the shared wall');
    case 'cornell': return P(10, 12, -Math.PI / 2 + 0.25, 'facing the grey wall');
    case 'tower': {
      const site = testTowerSite(seed);
      const e = towerExitCell(site);
      return { ...P(e.li, e.lj, e.yaw, 'tower exit facing in'), zone: Zone.LOBBY };
    }
    case 'materials': return P(15, 27, 0, 'facing the north wall panels');
    case 'flicker': return P(16, 16, Math.PI / 4, 'facing the dynamic light');
    default: return P(3, 3, 0, 'grid room');
  }
}
