import { CELL, CHUNK_SIZE } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, EdgeTrim, FixtureKind, Mat, PropKind, SolidFlag, StructureKind, Zone, type StoreyId } from '../../core/ids.ts';
import type { DoorwayLink, PortalFrame, PortalSpec } from '../../core/layout.ts';
import { hash01, hash3, hash4 } from '../../core/rng.ts';
import type { ZoneGenContext } from '../../core/world.ts';
import type { Sites } from '../sites.ts';
import { Frame } from './frame.ts';
import { placeLeaf } from './doors.ts';

const SALT = 0x506f7274;
const REGION = 4;
export interface DoorwaySite {
  id: number; effect: DoorwayLink['effect']; s: StoreyId; cx: number; cz: number;
  interior: boolean; source: boolean; frame: Frame; target: PortalFrame & { s: StoreyId };
}

const aperture = (f: Frame, interior: boolean): PortalFrame => {
  const [x, z] = f.point((interior ? 5.5 : 1.5) * CELL, (interior ? 12 : 2) * CELL);
  const [nx, nz] = f.dir(0, -1);
  return { x, y: 0, z, nx, nz };
};

/** One quiet anomaly per selected 154 m region. Both endpoints are chosen together, independent of load order. */
export function doorwaySites(seed: number, cx: number, cz: number, sites: Sites): DoorwaySite[] {
  const rx = Math.floor(cx / REGION), rz = Math.floor(cz / REGION);
  const h = hash4(seed, SALT, rx, rz);
  if (hash01(h) > 0.68) return [];
  const effect = hash01(hash3(h, 1, 0)) < 0.5 ? 'level' : 'interior';
  const pair = ([[0, 1], [0, 2], [1, 2]] as const)[hash3(h, 2, 0) % 3];
  const available = (x: number, z: number): boolean => !sites.towerAt(x, z) && !sites.elevatorAt(x, z) &&
    sites.arteriesInChunk(x, z).length === 0 && ([0, 1, 2] as StoreyId[]).every((s) => !sites.landmarkAt(s, x, z));
  for (let k = 0; k < 16; k++) {
    const pick = (hash3(h, 3, 0) + k * 7) % 16;
    const ax = rx * REGION + (pick & 3), az = rz * REGION + (pick >> 2);
    const bx = effect === 'level' ? ax : rx * REGION + ((pick + 2) & 3);
    const bz = effect === 'level' ? az : rz * REGION + (((pick >> 2) + 2) & 3);
    if (!available(ax, az) || !available(bx, bz)) continue;
    const aS: StoreyId = effect === 'level' ? pair[0] : 0;
    const bS: StoreyId = effect === 'level' ? pair[1] : 0;
    const a = new Frame(5, 5, 3, 4, (hash3(h, 4, 0) % 4) as 0 | 1 | 2 | 3);
    const b = effect === 'level' ? new Frame(5, 5, 3, 4, ((hash3(h, 4, 0) + 2) % 4) as 0 | 1 | 2 | 3) : new Frame(3, 3, 11, 13, 0);
    const fa = aperture(a, false), fb = aperture(b, effect === 'interior');
    const out: DoorwaySite[] = [];
    if (cx === ax && cz === az) out.push({ id: h, effect, s: aS, cx, cz, interior: false, source: true, frame: a,
      target: { ...fb, x: bx * CHUNK_SIZE + fb.x, z: bz * CHUNK_SIZE + fb.z, s: bS } });
    if (cx === bx && cz === bz) out.push({ id: h, effect, s: bS, cx, cz, interior: effect === 'interior', source: false, frame: b,
      target: { ...fa, x: ax * CHUNK_SIZE + fa.x, z: az * CHUNK_SIZE + fa.z, s: aS } });
    return out;
  }
  return [];
}

export function stampDoorways(ctx: ZoneGenContext, sites: Sites): [number, number][] {
  const g = ctx.grid, l = g.layout, entrances: [number, number][] = [];
  for (const site of doorwaySites(ctx.seed, ctx.key.cx, ctx.key.cz, sites)) {
    if (site.s !== ctx.key.s) continue;
    const f = site.frame, W = site.interior ? 11 : 3, L = site.interior ? 13 : 4;
    const [i0, j0, i1, j1] = f.rect();
    const yellow = site.effect === 'interior' || site.s === 0;
    const pool = !yellow && site.s === 2;
    const wall = yellow ? Mat.WALLPAPER_L0 : pool ? Mat.POOL_TILE : Mat.CMU_PAINTED;
    const floor = yellow ? Mat.CARPET_L0 : pool ? Mat.POOL_MOSAIC : Mat.CONCRETE_FLOOR;
    const ceil = site.interior ? 4.2 : 2.7;
    g.setCells(i0, j0, i1, j1, {
      floorCm: 0, ceilCm: Math.round(ceil * 100), blockCm: 0, floorMat: floor,
      ceilMat: yellow ? Mat.CEILING_TILE : Mat.CONCRETE_CEIL,
      ceilKind: yellow ? CeilKind.TILES : CeilKind.CONCRETE,
      cellZone: yellow ? Zone.LOBBY : pool ? Zone.POOLROOMS : Zone.CONCRETE,
      flagsSet: CellFlag.RESERVED | (site.interior ? CellFlag.SEALED : 0),
      flagsClear: CellFlag.SOLID | CellFlag.VOID | CellFlag.NOWALK | CellFlag.NO_CEIL | CellFlag.WET,
    }, true);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      l.wallMat[j * 32 + i] = wall; l.trimMat[j * 32 + i] = Mat.TRIM_PAINT;
    }
    for (let v = 0; v < L; v++) for (let u = 0; u < W; u++) {
      if (u + 1 < W) f.setEdge(g, u, v, u + 1, v, EdgeKind.OPEN, wall, wall, { trim: 0 });
      if (v + 1 < L) f.setEdge(g, u, v, u, v + 1, EdgeKind.OPEN, wall, wall, { trim: 0 });
    }
    for (let u = 0; u < W; u++) {
      f.setEdge(g, u, 0, u, -1, EdgeKind.WALL, wall, wall);
      f.setEdge(g, u, L - 1, u, L, EdgeKind.WALL, wall, wall);
    }
    for (let v = 0; v < L; v++) {
      f.setEdge(g, 0, v, -1, v, EdgeKind.WALL, wall, wall);
      f.setEdge(g, W - 1, v, W, v, EdgeKind.WALL, wall, wall);
    }
    const du = site.interior ? 5 : 1, dv = site.interior ? 12 : 2;
    // A framed opening followed by a blind backing cell. Only the portal joins it to the destination.
    for (let u = 0; u < W; u++) f.setEdge(g, u, dv - 1, u, dv, u === du ? EdgeKind.DOORWAY : EdgeKind.WALL, wall, wall, { trim: EdgeTrim.CASING, hA: 210 });
    if (!site.interior) {
      f.setEdge(g, 1, 0, 1, -1, EdgeKind.DOORWAY, wall, ctx.palette.wallMat, { trim: EdgeTrim.CASING, hA: 210 });
      entrances.push(f.cell(1, -1));
    }
    if (site.source) {
      const e = f.edge(du, dv - 1, du, dv);
      placeLeaf(g, e.axis, e.i, e.j, e.aIsNeg ? -1 : 1, -1, 0, site.effect === 'level' ? 2 : 0, site.id);
    }
    const lamp = (u: number, v: number, n: number) => {
      const [x, z] = f.point(u * CELL, v * CELL);
      g.addFixture({ kind: FixtureKind.TUBE_STRIP, state: 0, shape: 0, px: x, py: ceil - 0.08, pz: z,
        nx: 0, ny: -1, nz: 0, tx: 1, ty: 0, tz: 0, w: 1.0, h: 0.09,
        color: pool ? [0.85, 0.95, 1] : [1, 0.9, 0.72], luminance: site.interior ? 7600 : 4200, hum: 0.35, bakeGroup: 0 },
        { id: hash3(site.id, site.s, n), seed: hash3(site.id, site.s, n) });
    };
    if (site.interior) {
      for (const u of [2.5, 5.5, 8.5]) for (const v of [2.5, 6.5, 10.5]) lamp(u, v, Math.round(u + v * 20));
      // Sparse supports and abandoned storage make the extra depth feel like part of the building.
      for (const u of [2.5, 8.5]) for (const v of [4.5, 8.5]) {
        const [x, z] = f.point(u * CELL, v * CELL);
        g.addSolid({ kind: 'box', min: [x - 0.2, 0, z - 0.2], max: [x + 0.2, ceil, z + 0.2], mat: Mat.CMU_PAINTED,
          flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE | SolidFlag.RENDER, bakeGroup: 0 });
      }
      for (const v of [2.5, 4.5, 7.5]) {
        const [x, z] = f.point(0.7 * CELL, v * CELL);
        g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: 1, x, y: 0, z, yaw: 0, scale: 1, flags: 1, seed: hash3(site.id, 5, Math.round(v * 2)) });
      }
    } else lamp(1.5, 1, 10);
    const frame = aperture(f, site.interior);
    const p: PortalSpec = { kind: 'doorway', towerId: 0, endless: false,
      min: [frame.x - 0.6, 0, frame.z - 0.6], max: [frame.x + 0.6, 2.1, frame.z + 0.6],
      doorway: { id: site.id, effect: site.effect, frame, target: site.target } };
    g.addStructure(StructureKind.DOORWAY, i0, j0, i1, j1, f.rot, p);
  }
  return entrances;
}
