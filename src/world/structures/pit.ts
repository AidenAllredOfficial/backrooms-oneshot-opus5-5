// src/world/structures/pit.ts — collapsed-floor pits in decayed districts (WP4).
//
// With p 0.08 per chunk in districts whose mean decay exceeds 0.5, and p 0.03 anywhere else (any mood, R2): a
// 2x2-cell hole (VOID cells, edges stay OPEN) inside a >= 5x5 block of open floor, away from ports and keepClear
// cells, ringed by fallen ceiling debris and a warning ring of traffic cones / a wet-floor sign, with a faint warm
// glow far below (a CAGE_BULB on the shaft wall 5 m down) so the hole reads as depth, not as a black decal.
// Falling in (feet below -1.5 m inside the portal) drops the player into the next storey (WP12).

import { CELL, CHUNK_SIZE, TOWER_SPAN } from '../../core/constants.ts';
import { CeilKind, CellFlag, EdgeKind, FixtureKind, PropKind, StructureKind, TileState, cellIdx, exIdx, ezIdx, fixtureSeed, hash3, rngFor, SALT, setTile } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import type { PortalSpec, ZoneGenContext } from '../../core/index.ts';
import { computeKeepClear } from '../content/keepClear.ts';
import { isOpenFloor, N } from '../content/util.ts';

export const PIT_P = 0.08;
/** R2: the chance outside decayed districts (any mood). */
export const PIT_P_ANY = 0.03;
export const PIT_DECAY_MIN = 0.5;

/** Mean of the decay field over the district: 5x5 samples spanning +-2 chunks around the district site. */
export function districtMeanDecay(ctx: ZoneGenContext): number {
  const d = ctx.district;
  const sx = d.siteX * CHUNK_SIZE, sz = d.siteZ * CHUNK_SIZE;
  let sum = 0;
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) sum += ctx.fields.decay(sx + i * CHUNK_SIZE, sz + j * CHUNK_SIZE);
  return sum / 25;
}

export function placePits(ctx: ZoneGenContext): void {
  const key = ctx.key;
  const rng = rngFor(ctx.seed, SALT.ANOMALY, key.s, key.cx, key.cz, 2);
  const u = rng.float();
  if (u >= PIT_P) return;
  if (u >= PIT_P_ANY && districtMeanDecay(ctx) <= PIT_DECAY_MIN) return;
  placePitIn(ctx, rng.next());
}

/** Place a pit (used by placePits and by tests). Returns the pit's min cell or null when no 5x5 block fits. */
export function placePitIn(ctx: ZoneGenContext, pickSeed: number): [number, number] | null {
  const g = ctx.grid, l = g.layout;
  const keep = computeKeepClear(l);
  const blocked = new Uint8Array(N * N);
  for (let c = 0; c < N * N; c++) blocked[c] = !isOpenFloor(l, c) || l.waterCm[c] > l.floorCm[c] || (l.flags[c] & CellFlag.WET) !== 0 ? 1 : 0;
  for (const p of l.props) {
    const li = Math.floor(p.x / CELL), lj = Math.floor(p.z / CELL);
    if (li >= 0 && lj >= 0 && li < N && lj < N) blocked[lj * N + li] = 1;
  }
  for (const s of l.solids) {
    if (s.kind !== 'box' && s.kind !== 'ramp') continue;
    const x0 = s.kind === 'box' ? s.min[0] : s.x0, z0 = s.kind === 'box' ? s.min[2] : s.z0;
    const x1 = s.kind === 'box' ? s.max[0] : s.x1, z1 = s.kind === 'box' ? s.max[2] : s.z1;
    for (let lj = Math.max(0, Math.floor(z0 / CELL)); lj < Math.min(N, Math.ceil(z1 / CELL)); lj++) {
      for (let li = Math.max(0, Math.floor(x0 / CELL)); li < Math.min(N, Math.ceil(x1 / CELL)); li++) blocked[lj * N + li] = 1;
    }
  }
  const cands: [number, number][] = [];
  for (let bj = 2; bj + 5 <= N - 2; bj++) {
    for (let bi = 2; bi + 5 <= N - 2; bi++) {
      if (!blockOk(l, blocked, bi, bj)) continue;
      // the pit sits at the block centre (offset 1..2 leaves a walkable ring of 1-2 cells)
      const pi = bi + 1 + (((bi + bj) & 1)), pj = bj + 1 + ((bi >> 1) & 1);
      let ok = true;
      for (let dj = 0; dj < 2 && ok; dj++) for (let di = 0; di < 2 && ok; di++) if (keep[(pj + dj) * N + pi + di]) ok = false;
      if (ok) cands.push([pi, pj]);
    }
  }
  if (cands.length === 0) return null;
  const [pi, pj] = cands[pickSeed % cands.length];
  g.setCells(pi, pj, pi + 2, pj + 2, { flagsSet: CellFlag.VOID, flagsClear: CellFlag.WET | CellFlag.SPAWN_OK });
  for (let dj = 0; dj < 2; dj++) {
    for (let di = 0; di < 2; di++) {
      const li = pi + di, lj = pj + dj;
      // edges around / inside the hole stay OPEN
      g.setEdge('x', li, lj, EdgeKind.OPEN); g.setEdge('x', li + 1, lj, EdgeKind.OPEN);
      g.setEdge('z', li, lj, EdgeKind.OPEN); g.setEdge('z', li, lj + 1, EdgeKind.OPEN);
    }
  }

  // collapse above: tiles over the hole and part of the ring fall; debris lies on the ring
  const r = rngFor(pickSeed, SALT.ANOMALY, 7);
  for (let lj = pj - 1; lj <= pj + 2; lj++) {
    for (let li = pi - 1; li <= pi + 2; li++) {
      const c = cellIdx(li, lj);
      const inside = li >= pi && li < pi + 2 && lj >= pj && lj < pj + 2;
      if (l.ceilKind[c] === CeilKind.TILES) {
        for (let t = 0; t < 4; t++) {
          const cur = (l.tiles[c] >> (t * 4)) & 15;
          if (cur === TileState.FIXTURE) continue;
          if (inside ? r.chance(0.85) : r.chance(0.3)) setTile(l.tiles, c, t, TileState.MISSING);
        }
      }
      if (inside) continue;
      const [x, z] = g.cellCenter(li, lj);
      const floor = l.floorCm[c] / 100;
      if (r.chance(0.55)) {
        g.addProp({ kind: PropKind.CEILING_DEBRIS, variant: r.int(0, 3), x: x + r.range(-0.1, 0.1), y: floor, z: z + r.range(-0.1, 0.1), yaw: r.int(0, 3) * Math.PI / 2, scale: 1, flags: 0, seed: r.next() });
      } else if (r.chance(0.6)) {
        g.addProp({ kind: PropKind.TILE_FRAGMENT, variant: r.int(0, 3), x: x + r.range(-0.3, 0.3), y: floor, z: z + r.range(-0.3, 0.3), yaw: r.range(0, 6.283), scale: 1, flags: 0, seed: r.next() });
      }
    }
  }
  // warning ring: cones on the ring corners, sometimes a wet-floor sign
  const ring: [number, number][] = [[pi - 1, pj - 1], [pi + 2, pj - 1], [pi - 1, pj + 2], [pi + 2, pj + 2]];
  for (const [li, lj] of ring) {
    const c = cellIdx(li, lj);
    if (li < 0 || lj < 0 || li >= N || lj >= N || !isOpenFloor(l, c) || !r.chance(0.8)) continue;
    const [x, z] = g.cellCenter(li, lj);
    g.addProp({
      kind: PropKind.CONE, variant: r.int(0, 3), x: x + Math.sign(pi + 0.5 - li) * 0.25, y: l.floorCm[c] / 100, z: z + Math.sign(pj + 0.5 - lj) * 0.25,
      yaw: r.range(0, 6.283), scale: 1, flags: 0, seed: r.next(),
    });
  }
  if (r.chance(0.5)) {
    const li = pi + (r.chance(0.5) ? -1 : 2), lj = pj + r.int(0, 1);
    const c = cellIdx(li, lj);
    if (li >= 0 && li < N && isOpenFloor(l, c)) {
      const [x, z] = g.cellCenter(li, lj);
      g.addProp({ kind: PropKind.WET_FLOOR_SIGN, variant: 0, x, y: l.floorCm[c] / 100, z, yaw: r.range(0, 6.283), scale: 1, flags: 0, seed: r.next() });
    }
  }
  // the faint glow far below: a warm caged bulb on one shaft wall, 5 m down
  {
    const fid = hash3(pickSeed, SALT.ANOMALY, 0x9175);
    const x = pi * CELL + 0.2, z = (pj + 1) * CELL;
    const col = kelvinToLinearRGB(2700, 0.02);
    g.addFixture({
      kind: FixtureKind.CAGE_BULB, state: 0, shape: 1, px: x, py: -5.0, pz: z, nx: 1, ny: 0, nz: 0, tx: 0, ty: 0, tz: 1,
      w: 0.1, h: 0.1, color: [col[0], col[1], col[2]], luminance: 22, hum: 0.2, bakeGroup: 0,
    }, { id: fid, seed: fixtureSeed(fid) });
  }
  const portal: PortalSpec = {
    kind: 'pit', min: [pi * CELL, -TOWER_SPAN, pj * CELL], max: [(pi + 2) * CELL, -1.5, (pj + 2) * CELL], towerId: 0, endless: false,
  };
  g.addStructure(StructureKind.PIT, pi, pj, pi + 2, pj + 2, 0, portal);
  return [pi, pj];
}

/** 5x5 block of open, dry, unobstructed floor at one height with only OPEN edges inside it. */
function blockOk(l: ZoneGenContext['grid']['layout'], blocked: Uint8Array, bi: number, bj: number): boolean {
  const f0 = l.floorCm[cellIdx(bi, bj)];
  for (let lj = bj; lj < bj + 5; lj++) {
    for (let li = bi; li < bi + 5; li++) {
      const c = cellIdx(li, lj);
      if (blocked[c] || l.floorCm[c] !== f0) return false;
      if (li > bi && l.ex.kind[exIdx(li, lj)] !== EdgeKind.OPEN) return false;
      if (lj > bj && l.ez.kind[ezIdx(li, lj)] !== EdgeKind.OPEN) return false;
    }
  }
  return true;
}
