// src/world/structures/elevator.ts — elevator cab + lobby stamping (WP4).
//
// Frame (core elevatorFootprint / footprintCell): u across W = 2, v along L = 3; v = 0, 1 is the 2x2 cab,
// v = 2 the 2x1 lobby strip. The cab is identical in every storey (storey-free fixture ids, isolated bake group);
// the lobby is an alcove open to the storey on its v = 3 side. The door between cab and lobby is a 1-cell DOORWAY
// at u = 0. WP12 owns the door leaves (dynamic meshes + virtual collision); no ELEVATOR_DOOR props are added here.

import { CELL, ELEVATOR } from '../../core/constants.ts';
import { AnomalyKind, CeilKind, CellFlag, EdgeKind, FixtureKind, Mat, SignKind, StructureKind, TileState } from '../../core/index.ts';
import { fixtureSeed, hash01, hash2, NO_WATER, SALT, setTile, structureFixtureId, STRUCTURE_ZONE, worldToCell } from '../../core/index.ts';
import type { ChunkGrid, ElevatorSite, MatId, PortalSpec } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { Frame } from './frame.ts';

const W = ELEVATOR.W_CELLS; // 2
const L = ELEVATOR.L_CELLS; // 3
const C = CELL;
/** Cab interior height and fixture luminance. */
export const ELEVATOR_CAB = { ceilCm: 240, doorU: 0, troffers: 4, luminance: 2000, wrongP: 0.1 } as const;

export const elevatorIdOf = (site: Pick<ElevatorSite, 'id'>): number => (site.id & 0x7fffffff) | 1;
export const elevatorFrame = (site: ElevatorSite): Frame => new Frame(site.i0, site.j0, W, L, site.rot);
/** WRONG_ELEVATOR: p 0.1 per elevator, hashed from its id (storey-free). */
export const isWrongElevator = (site: Pick<ElevatorSite, 'id'>): boolean => hash01(hash2(site.id, SALT.ELEVATOR)) < ELEVATOR_CAB.wrongP;

export function stampElevator(g: ChunkGrid, site: ElevatorSite, seed: number): void {
  const f = elevatorFrame(site);
  const id = elevatorIdOf(site);
  const l = g.layout;
  const [ri0, rj0, ri1, rj1] = f.rect();
  const cab = f.cellRect(0, 0, W, 2);
  const lobby = f.cellRect(0, 2, W, 3);
  const clear = CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.WET | CellFlag.NO_CEIL | CellFlag.SPAWN_OK | CellFlag.SEALED;

  // lobby first: keep its palette materials/ceiling, but a level dry floor at 0 like the cab
  const lobbyCeil = Math.max(250, l.ceilCm[lobby[1] * 32 + lobby[0]]);
  g.setCells(lobby[0], lobby[1], lobby[2], lobby[3], {
    floorCm: 0, ceilCm: lobbyCeil, waterCm: NO_WATER, blockCm: 0, cellZone: STRUCTURE_ZONE,
    flagsSet: CellFlag.ELEVATOR | CellFlag.RESERVED, flagsClear: clear,
  }, true);
  g.setCells(cab[0], cab[1], cab[2], cab[3], {
    floorCm: 0, ceilCm: ELEVATOR_CAB.ceilCm, waterCm: NO_WATER, blockCm: 0, cellZone: STRUCTURE_ZONE,
    floorMat: Mat.VINYL_VCT, ceilMat: Mat.METAL_PAINTED, ceilKind: CeilKind.TILES,
    flagsSet: CellFlag.ELEVATOR | CellFlag.RESERVED, flagsClear: clear,
  }, true);
  for (let lj = cab[1]; lj < cab[3]; lj++) {
    for (let li = cab[0]; li < cab[2]; li++) {
      const c = lj * 32 + li;
      l.wallMat[c] = Mat.METAL_PAINTED;
      l.trimMat[c] = Mat.METAL_PAINTED;
      l.tiles[c] = 0;
    }
  }

  // outside face materials: the palette wall of the neighbouring storey cell
  const outMat = (u: number, v: number): MatId => {
    const [li, lj] = f.cell(u, v);
    return (li >= 0 && lj >= 0 && li < 32 && lj < 32 ? l.wallMat[lj * 32 + li] : Mat.WALLPAPER_L0) as MatId;
  };
  const metal = Mat.METAL_PAINTED;
  // interior edges of the cab and the lobby strip: OPEN
  f.setEdge(g, 0, 0, 1, 0, EdgeKind.OPEN, metal, metal, { trim: 0 });
  f.setEdge(g, 0, 1, 1, 1, EdgeKind.OPEN, metal, metal, { trim: 0 });
  f.setEdge(g, 0, 0, 0, 1, EdgeKind.OPEN, metal, metal, { trim: 0 });
  f.setEdge(g, 1, 0, 1, 1, EdgeKind.OPEN, metal, metal, { trim: 0 });
  f.setEdge(g, 0, 2, 1, 2, EdgeKind.OPEN, outMat(0, 3), outMat(1, 3), { trim: 0 });
  // cab shell: back wall (v = 0 line), side walls (u = -1 / u = 2 lines)
  for (let u = 0; u < W; u++) f.setEdge(g, u, 0, u, -1, EdgeKind.WALL, metal, outMat(u, -1), { trim: 0 });
  for (let v = 0; v < 2; v++) {
    f.setEdge(g, 0, v, -1, v, EdgeKind.WALL, metal, outMat(-1, v), { trim: 0 });
    f.setEdge(g, W - 1, v, W, v, EdgeKind.WALL, metal, outMat(W, v), { trim: 0 });
  }
  // cab front (v = 2 line): one DOORWAY (1 cell) at u = doorU, the rest WALL; METAL on both faces (elevator front)
  for (let u = 0; u < W; u++) {
    const door = u === ELEVATOR_CAB.doorU;
    f.setEdge(g, u, 1, u, 2, door ? EdgeKind.DOORWAY : EdgeKind.WALL, metal, metal, { trim: 0, hA: door ? 210 : 0, hB: 0 });
  }
  // lobby alcove sides: walls in the storey palette; its v = 3 side stays open to the storey
  const lobbyMat = outMat(0, 2);
  f.setEdge(g, 0, 2, -1, 2, EdgeKind.WALL, lobbyMat, outMat(-1, 2), { trim: 0 });
  f.setEdge(g, W - 1, 2, W, 2, EdgeKind.WALL, lobbyMat, outMat(W, 2), { trim: 0 });
  for (let u = 0; u < W; u++) {
    const e = f.edge(u, 2, u, 3);
    if (!g.isFrozenEdge(e.axis, e.i, e.j) && g.getEdge(e.axis, e.i, e.j) !== EdgeKind.OPEN) {
      f.setEdge(g, u, 2, u, 3, EdgeKind.OPEN, outMat(u, 3), outMat(u, 3), { trim: 0 });
    }
  }

  // cab lighting: four TROFFER_2x2 around the cab centre (one 0.6 m tile each, inside one cell: never straddles)
  const color = kelvinToLinearRGB(4200, 0.02);
  const [tx, tz] = f.dir(1, 0);
  const tiles: [number, number][] = [[0.9, 0.9], [1.5, 0.9], [0.9, 1.5], [1.5, 1.5]];
  const py = ELEVATOR_CAB.ceilCm / 100;
  tiles.forEach(([um, vm], i) => {
    const [x, z] = f.point(um, vm);
    const fid = structureFixtureId(id, SALT.ELEVATOR, i);
    g.addFixture({
      kind: FixtureKind.TROFFER_2x2, state: 0, shape: 0, px: x, py, pz: z, nx: 0, ny: -1, nz: 0,
      tx: Math.abs(tx), ty: 0, tz: Math.abs(tz), w: 0.6, h: 0.6, color: [color[0], color[1], color[2]],
      luminance: ELEVATOR_CAB.luminance, hum: 0.35, bakeGroup: id,
    }, { id: fid, seed: fixtureSeed(fid) });
    const li = worldToCell(x), lj = worldToCell(z);
    const t = (Math.floor((z - lj * C) / 0.6) << 1) | Math.floor((x - li * C) / 0.6);
    setTile(l.tiles, lj * 32 + li, t, TileState.FIXTURE);
  });

  // lobby sign beside the door (storey side, on the front wall segment next to the doorway)
  const signU = ELEVATOR_CAB.doorU === 0 ? 1 : 0;
  const face = f.facePoint(signU, 2, signU, 1, 0.5);
  g.addDecal({ kind: SignKind.ELEVATOR, sign: true, px: face.x, py: 1.55, pz: face.z, nx: face.nx, ny: 0, nz: face.nz, rot: 0, w: 0.35, h: 0.35, alpha: 1 });

  const wrong = isWrongElevator(site);
  const cb = f.box(0, 0, W * C, 2 * C, 0, ELEVATOR_CAB.ceilCm / 100);
  const portal: PortalSpec = { kind: 'elevator', min: cb.min, max: cb.max, towerId: id, endless: false, wrong };
  g.addStructure(StructureKind.ELEVATOR, ri0, rj0, ri1, rj1, site.rot, portal);
  if (wrong) {
    const [x, z] = f.point(C, C);
    g.addAnomaly(AnomalyKind.WRONG_ELEVATOR, x, z, C);
  }
  void seed;
}

/** The storey cell in front of the lobby, in line with the cab door, facing the cab (-v). */
export function elevatorExitCell(site: ElevatorSite): { li: number; lj: number; yaw: number } {
  const f = elevatorFrame(site);
  const [li, lj] = f.cell(ELEVATOR_CAB.doorU, L);
  return { li, lj, yaw: f.yaw(0, -1) };
}
