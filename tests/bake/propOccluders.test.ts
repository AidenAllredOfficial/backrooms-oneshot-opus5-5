// tests/bake/propOccluders.test.ts — prop part occluders (core/props.ts PROP_OCCLUDERS, bake/visgrid.ts): every part
// box lies inside its prop's footprint, part lists take precedence over `occlude` (cars stand on wheels, racks let
// light through between their decks), chair backs only near a quarter-turn yaw, contactBox marks footprints with
// a box standing on the floor (chairs keep their contact AO), neighbouring racks' touching uprights merge into one
// box with the same solid.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { fromHalf } from '../../src/core/half.ts';
import { PropKind, SolidFlag } from '../../src/core/ids.ts';
import { ChartKind } from '../../src/core/mesh.ts';
import {
  OCC_ALIGN_TOL, PROP_DEFS, PROP_OCCLUDER_VARIANTS, PROP_OCCLUDERS, PROP_OCCLUDERS_ALIGNED, propOccluders, quarterAligned, type Box6,
} from '../../src/core/props.ts';
import type { LayoutNeighborhood } from '../../src/core/world.ts';
import { bakeTile } from '../../src/bake/index.ts';
import { setupTexels, TX_VALID } from '../../src/bake/context.ts';
import { createJob } from '../../src/bake/job.ts';
import { HALO_OFF } from '../../src/bake/util.ts';
import { buildVisGrid, MAT_PROP } from '../../src/bake/visgrid.ts';
import { Q_HIGH, addLight, carveRoom, findChart, gridTexel, handNeighborhood, solidLayout, surfacesOf, texelLum } from './helpers.ts';

const TILE: TileKey = { s: 0, cx: 0, cz: 0, q: 0 };

function allTables(): [number, string, Box6][] {
  const out: [number, string, Box6][] = [];
  for (const [k, list] of Object.entries(PROP_OCCLUDERS)) for (const b of list ?? []) out.push([Number(k), 'base', b]);
  for (const [k, list] of Object.entries(PROP_OCCLUDERS_ALIGNED)) for (const b of list ?? []) out.push([Number(k), 'aligned', b]);
  for (const [k, vs] of Object.entries(PROP_OCCLUDER_VARIANTS)) {
    for (const [v, list] of Object.entries(vs ?? {})) for (const b of list ?? []) out.push([Number(k), `variant ${v}`, b]);
  }
  return out;
}

/** Prop boxes (MAT_PROP) of the VisGrid of a hand room holding one prop. */
function propBoxes(kind: number, yaw: number, variant = 0): number {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  l.props.push({ kind: kind as never, variant, x: 8.4, y: 0, z: 8.4, yaw, scale: 1, flags: 0, seed: 1 });
  const g = buildVisGrid(handNeighborhood(l), TILE);
  let n = 0;
  for (let b = 0; b < g.nBox; b++) if (g.boxMat[b] === MAT_PROP) n++;
  return n;
}

describe('PROP_OCCLUDERS tables', () => {
  it('every part box lies inside its prop footprint and height', () => {
    const rows = allTables();
    expect(rows.length).toBeGreaterThan(40);
    for (const [k, where, b] of rows) {
      const s = PROP_DEFS[k].size;
      const tag = `${PROP_DEFS[k].name} ${where} ${b.join(',')}`;
      expect(b[0], tag).toBeLessThan(b[3]); expect(b[1], tag).toBeLessThan(b[4]); expect(b[2], tag).toBeLessThan(b[5]);
      expect(b[0], tag).toBeGreaterThanOrEqual(-s[0] / 2 - 1e-9); expect(b[3], tag).toBeLessThanOrEqual(s[0] / 2 + 1e-9);
      expect(b[2], tag).toBeGreaterThanOrEqual(-s[2] / 2 - 1e-9); expect(b[5], tag).toBeLessThanOrEqual(s[2] / 2 + 1e-9);
      expect(b[1], tag).toBeGreaterThanOrEqual(0); expect(b[4], tag).toBeLessThanOrEqual(s[1] + 1e-9);
    }
  });

  it('variant lists replace the base list; props without a list have none', () => {
    expect(propOccluders(PropKind.DESK, 0)).toBe(PROP_OCCLUDERS[PropKind.DESK]);
    expect(propOccluders(PropKind.DESK, 1)!.length).toBe(PROP_OCCLUDERS[PropKind.DESK]!.length + 1); // + drawer pedestal
    expect(propOccluders(PropKind.SHELF_RACK, 2)!.length).toBe(2); // collapsed: one standing end frame
    expect(propOccluders(PropKind.CRATE, 0)).toBeUndefined();
  });

  it('quarterAligned: within OCC_ALIGN_TOL of a multiple of 90 degrees', () => {
    for (const yaw of [0, 0.1, -0.15, Math.PI / 2 + 0.19, Math.PI - 0.05, -Math.PI / 2, 6.2]) expect(quarterAligned(yaw), String(yaw)).toBe(true);
    for (const yaw of [0.6, OCC_ALIGN_TOL + 0.01, Math.PI / 4, Math.PI / 2 + 0.3, 3.5]) expect(quarterAligned(yaw), String(yaw)).toBe(false);
  });
});

describe('VisGrid part boxes', () => {
  it('chair backs only near a quarter-turn yaw', () => {
    for (const kind of [PropKind.CHAIR_STACKING, PropKind.OFFICE_CHAIR]) {
      expect(propBoxes(kind, 0.1)).toBe(2);
      expect(propBoxes(kind, Math.PI / 2 - 0.1)).toBe(2);
      expect(propBoxes(kind, 0.6)).toBe(1); // seat only
    }
  });

  it('a part list takes precedence over `occlude` (car: 7 parts, rack: 4 uprights + 3 decks); others keep the footprint box', () => {
    expect(propBoxes(PropKind.CAR_SEDAN, 0)).toBe(7);
    expect(propBoxes(PropKind.SHELF_RACK, 0)).toBe(7);
    expect(propBoxes(PropKind.CRATE, 0)).toBe(1);
  });

  it('contactBox marks the footprints of props with a box standing on the floor', () => {
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 1, 1, 15, 15);
    l.props.push({ kind: PropKind.DESK, variant: 0, x: 4.2, y: 0, z: 4.2, yaw: 0, scale: 1, flags: 0, seed: 1 });
    l.props.push({ kind: PropKind.CONE, variant: 0, x: 9.6, y: 0, z: 9.6, yaw: 0, scale: 1, flags: 0, seed: 2 });
    l.props.push({ kind: PropKind.OFFICE_CHAIR, variant: 0, x: 13.2, y: 0, z: 13.2, yaw: 0, scale: 1, flags: 0, seed: 3 });
    l.props.push({ kind: PropKind.CAR_SEDAN, variant: 0, x: 15.6, y: 0, z: 4.8, yaw: 0, scale: 1, flags: 0, seed: 4 });
    const g = buildVisGrid(handNeighborhood(l), TILE);
    expect(g.nContact).toBe(4);
    const byX = [0, 1, 2, 3].sort((a, b) => g.contact[a * 4] - g.contact[b * 4]);
    expect(g.contactBox[byX[0]]).toBe(1); // desk: side panels on the floor
    expect(g.contactBox[byX[1]]).toBe(0); // cone: no part boxes, keeps its analytic contact AO
    expect(g.contactBox[byX[2]]).toBe(0); // office chair: the seat floats over the untraced star base
    expect(g.contactBox[byX[3]]).toBe(1); // car: on its wheels
  });

  it("neighbouring racks' touching uprights merge into one box; rays see the same solid", () => {
    const row = (n: number): ReturnType<typeof buildVisGrid> => {
      const l = solidLayout({ s: 0, cx: 0, cz: 0 });
      carveRoom(l, 1, 1, 15, 15);
      for (let k = 0; k < n; k++) l.props.push({ kind: PropKind.SHELF_RACK, variant: 0, x: 4.8 + 2.4 * k, y: 0, z: 8.4 + 0.6, yaw: 0, scale: 1, flags: 0, seed: 1 + k });
      return buildVisGrid(handNeighborhood(l), TILE);
    };
    const count = (g: ReturnType<typeof buildVisGrid>): number => { let c = 0; for (let b = 0; b < g.nBox; b++) if (g.boxMat[b] === MAT_PROP) c++; return c; };
    expect(count(row(1))).toBe(7);
    expect(count(row(3))).toBe(3 * 7 - 2 * 2); // 2 rack lines x 2 upright pairs
    const g = row(3);
    // the merged upright spans both racks' channels (0.16 m wide on the rack line x = 6.0 m)
    let wide = 0;
    for (let b = 0; b < g.nBox; b++) {
      const o = b * 6;
      if (g.boxMat[b] === MAT_PROP && Math.abs((g.box[o + 3] - g.box[o]) * CELL - 0.16) < 1e-6 && g.box[o + 4] - g.box[o + 1] > 4) wide++;
    }
    expect(wide).toBe(4);
  });
});

describe('car on wheels', () => {
  const l = solidLayout({ s: 0, cx: 0, cz: 0 });
  carveRoom(l, 1, 1, 15, 15);
  addLight(l, { px: 8.4, pz: 8.4, py: 2.7 });
  addLight(l, { px: 8.4, pz: 5.4, py: 2.7 });
  addLight(l, { px: 8.4, pz: 11.4, py: 2.7 });
  l.props.push({ kind: PropKind.CAR_SEDAN, variant: 0, x: 8.4, y: 0, z: 8.4, yaw: 0, scale: 1, flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE, seed: 1 });
  const nb: LayoutNeighborhood = handNeighborhood(l);
  it('the floor under the body is valid and in the car shadow (< 0.3x the floor 2.4 m beside it)', () => {
    const s = surfacesOf(nb, TILE, 12);
    const T = setupTexels(createJob(nb, TILE, Q_HIGH, null), s);
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const [u, v] = gridTexel(floor, 12, 8.4, 8.4);
    const t = T.map[v * s.atlasW + u];
    expect(t).toBeGreaterThanOrEqual(0);
    expect(T.state[t]).toBe(TX_VALID);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'direct');
    const under = texelLum(lm, u, v);
    const [u2, v2] = gridTexel(floor, 12, 8.4 + 2.4, 8.4);
    const beside = texelLum(lm, u2, v2);
    expect(beside).toBeGreaterThan(50);
    expect(under).toBeLessThan(0.3 * beside);
  });
});

describe('shelf rack decks', () => {
  // rack along x at z = 8.4 (depth 1.1 m, back face at 8.95) in a 5 m high room whose back wall is at z = 10.8; a
  // lamp 2 m in front of the rack at 1.8 m, between the first (1.2 m) and second (2.4 m) deck
  const mk = (kind: number): LayoutNeighborhood => {
    const l = solidLayout({ s: 0, cx: 0, cz: 0 });
    carveRoom(l, 1, 1, 15, 9, 500);
    addLight(l, { px: 8.4, pz: 6.4, py: 1.8, shape: 1, nx: 0, ny: -1, nz: 0, w: 0.3, h: 0.3, luminance: 20000 });
    l.props.push({ kind: kind as never, variant: 0, x: 8.4, y: 0, z: 8.4, yaw: 0, scale: 1, flags: SolidFlag.COLLIDE | SolidFlag.OCCLUDE, seed: 1 });
    return handNeighborhood(l);
  };
  /** Direct luminance of the back-wall texel (normal -z) nearest to tile-local (x, y) on the wall z = 10.8. */
  const wallLum = (nb: LayoutNeighborhood, x: number, y: number): number => {
    const s = surfacesOf(nb, TILE, 12);
    const T = setupTexels(createJob(nb, TILE, Q_HIGH, null), s);
    const lm = bakeTile(nb, TILE, s, 'full', Q_HIGH, 'direct');
    const hx = HALO_OFF + x / CELL, hz = HALO_OFF + 10.8 / CELL;
    let best = -1, bd = Infinity;
    for (let t = 0; t < T.n; t++) {
      if (T.state[t] !== TX_VALID || T.nz[t] > -0.9) continue;
      const d = ((T.x[t] - hx) * CELL) ** 2 + (T.y[t] - y) ** 2 + ((T.z[t] - hz) * CELL) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    expect(bd).toBeLessThan(0.03);
    const o = T.atlas[best] * 4;
    return 0.2126 * fromHalf(lm.irr[o]) + 0.7152 * fromHalf(lm.irr[o + 1]) + 0.0722 * fromHalf(lm.irr[o + 2]);
  };
  it('light passes between the decks onto the wall behind the rack; a solid prop there blocks it', () => {
    const rack = wallLum(mk(PropKind.SHELF_RACK), 8.4, 1.65);
    const open = wallLum(mk(PropKind.CONE), 8.4, 1.65); // (a cone: 0.7 m, below the segment)
    const vend = wallLum(mk(PropKind.VENDING_MACHINE), 8.4, 1.65);
    expect(open).toBeGreaterThan(50);
    expect(rack).toBeGreaterThan(0.8 * open);
    expect(vend).toBeLessThan(0.05 * open);
    // 0.4 m up, the segment to the lamp crosses the first deck inside the rack: the wall is in the deck's shadow
    expect(wallLum(mk(PropKind.SHELF_RACK), 8.4, 0.4)).toBeLessThan(0.1 * wallLum(mk(PropKind.CONE), 8.4, 0.4));
  });
  it('the floor under the rack is valid (no longer inside one 4.2 m box)', () => {
    const nb = mk(PropKind.SHELF_RACK);
    const s = surfacesOf(nb, TILE, 12);
    const T = setupTexels(createJob(nb, TILE, Q_HIGH, null), s);
    const floor = findChart(s, ChartKind.FLOOR_GRID);
    const [u, v] = gridTexel(floor, 12, 8.4, 8.4);
    expect(T.state[T.map[v * s.atlasW + u]]).toBe(TX_VALID);
  });
});
