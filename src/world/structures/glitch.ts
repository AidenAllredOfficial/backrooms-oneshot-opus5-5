// src/world/structures/glitch.ts — glitch (noclip) walls at dead ends (WP4).
//
// With p 0.03 per chunk (never in the storey's spawn district) one interior WALL edge closing a dead end becomes
// GLITCH: it collides like a wall; pushing into it inside the portal volume noclips the player into the next
// storey (WP12). Tells: a faint BUZZ emitter and WP5's misregistered material UVs on GLITCH faces.

import { CELL, PLAYER, WALL_T } from '../../core/constants.ts';
import { AnomalyKind, EdgeKind, EmitterKind, StructureKind, cellIdx, rngFor, SALT } from '../../core/index.ts';
import type { MatId, PortalSpec, Rng, ZoneGenContext } from '../../core/index.ts';
import { canStep, DX, DZ, edgeKindPassable, inChunk, isOpenFloor, isSeamSide, N, sideEdge, sideHA, sideKind } from '../content/util.ts';

export const GLITCH_P = 0.03;

/** Is the context chunk inside the district that holds this storey's spawn (the district at chunk (0,0))? */
export function isSpawnDistrict(ctx: ZoneGenContext): boolean {
  return ctx.world.districtAt(ctx.key.s, 0, 0).id === ctx.district.id;
}

/** Passable exits of a cell: in-chunk steps, plus walkable seam edges (they lead into the neighbour chunk). */
export function exitCount(ctx: ZoneGenContext, li: number, lj: number): number {
  const l = ctx.grid.layout;
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const ni = li + DX[d], nj = lj + DZ[d];
    if (inChunk(ni, nj)) { if (canStep(l, li, lj, d)) n++; }
    else if (edgeKindPassable(sideKind(l, li, lj, d), sideHA(l, li, lj, d))) n++;
  }
  return n;
}

export function placeGlitchWalls(ctx: ZoneGenContext): void {
  const key = ctx.key;
  const rng = rngFor(ctx.seed, SALT.ANOMALY, key.s, key.cx, key.cz, 1);
  if (!rng.chance(GLITCH_P)) return;
  if (isSpawnDistrict(ctx)) return;
  placeGlitchWallIn(ctx, rng);
}

/** Turn one dead-end WALL into a GLITCH wall (no probability / district gate; used by placeGlitchWalls and tests).
 * Returns the dead-end cell and the side of the glitch wall, or null when the chunk has no candidate. */
export function placeGlitchWallIn(ctx: ZoneGenContext, rng: Rng): { li: number; lj: number; d: number } | null {
  const g = ctx.grid, l = g.layout;

  // dead ends: open floor cells with exactly one exit; candidate wall = an interior WALL side (opposite first)
  const cands: { li: number; lj: number; d: number }[] = [];
  for (let lj = 1; lj < N - 1; lj++) {
    for (let li = 1; li < N - 1; li++) {
      const c = cellIdx(li, lj);
      if (!isOpenFloor(l, c) || exitCount(ctx, li, lj) !== 1) continue;
      let open = -1;
      for (let d = 0; d < 4; d++) if (canStep(l, li, lj, d)) open = d;
      const order = open >= 0 ? [open ^ 1, open ^ 1 ^ 2, open ^ 1 ^ 3] : [0, 1, 2, 3];
      for (const d of order) {
        if (d === open || isSeamSide(li, lj, d)) continue;
        if (sideKind(l, li, lj, d) !== EdgeKind.WALL) continue;
        const e = sideEdge(li, lj, d);
        if (g.isFrozenEdge(e.axis, e.i, e.j)) continue;
        const ni = li + DX[d], nj = lj + DZ[d];
        if (g.isReserved(ni, nj) || g.isReserved(li, lj)) continue;
        cands.push({ li, lj, d });
        break;
      }
    }
  }
  if (cands.length === 0) return null;
  const pick = cands[rng.int(0, cands.length - 1)];
  const { li, lj, d } = pick;
  const e = sideEdge(li, lj, d);
  const eg = e.axis === 'x' ? l.ex : l.ez;
  const ok = g.setEdge(e.axis, e.i, e.j, EdgeKind.GLITCH, {
    hA: 0, hB: 0, matNeg: eg.matNeg[e.k] as MatId, matPos: eg.matPos[e.k] as MatId, trim: eg.trim[e.k],
  });
  if (!ok) return null;

  const floor = l.floorCm[cellIdx(li, lj)] / 100;
  const T = WALL_T / 2, R = PLAYER.radius + 0.05;
  let x0: number, x1: number, z0: number, z1: number;
  if (e.axis === 'x') {
    const X = e.i * CELL;
    x0 = X - T; x1 = X + T; z0 = e.j * CELL; z1 = (e.j + 1) * CELL;
    if (d === 0) x0 -= R; else x1 += R; // the walkable side is the dead-end cell
  } else {
    const Z = e.j * CELL;
    z0 = Z - T; z1 = Z + T; x0 = e.i * CELL; x1 = (e.i + 1) * CELL;
    if (d === 2) z0 -= R; else z1 += R;
  }
  const portal: PortalSpec = { kind: 'glitch', min: [x0, floor, z0], max: [x1, floor + 2, z1], towerId: 0, endless: false };
  g.addStructure(StructureKind.GLITCH, li, lj, li + 1, lj + 1, 0, portal);
  // wall centre, nudged 5 cm off the face into the dead end (sources inside a wall confuse propagation)
  const cx = (li + 0.5) * CELL + DX[d] * (CELL / 2 - T - 0.05);
  const cz = (lj + 0.5) * CELL + DZ[d] * (CELL / 2 - T - 0.05);
  g.addAnomaly(AnomalyKind.GLITCH_WALL, cx, cz, 1.5);
  g.addEmitter(EmitterKind.BUZZ, cx, floor + 1.2, cz, 0.15);
  return pick;
}
