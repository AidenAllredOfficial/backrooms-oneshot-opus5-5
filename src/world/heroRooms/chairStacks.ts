// src/world/heroRooms/chairStacks.ts — CHAIR_STACKS hero (Level 0 family; 8x8, R2 B4): a storeroom packed with
// a hundred and ten stacking chairs: nested stacks of four to ten crowding the back of the room, a few pulled off and left standing, and one set
// out alone in the only clear patch of floor, facing the door. One troffer works; one flickers.
//
// Frame: u across, v along (8 x 8 cells). Door in the v = 0 wall; the stacks fill the back two thirds.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, LandmarkKind, LightState, PropKind, Storey, Zone } from '../../core/index.ts';
import type { ZoneId } from '../../core/index.ts';
import { defaultPropFlags } from '../content/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, claim, emitter, floorDecal, opening, prop, storeyStyle, troffer } from '../landmarks/common.ts';
import type { Lm } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const S = 8;
const CEIL = 2.6;
/** Vertical pitch of nested stacking chairs. */
export const CHAIR_NEST = 0.085;
export const CHAIR_STACKS = { total: 110 } as const;

/** A nested stack of n chairs at frame metres (um, vm) facing (du, dv); only the bottom chair collides. */
export function chairStack(lm: Lm, um: number, vm: number, du: number, dv: number, n: number): void {
  const [x, z] = lm.f.point(um, vm);
  const yaw = lm.f.yaw(du, dv) + lm.rng.range(-0.08, 0.08);
  for (let k = 0; k < n; k++) {
    lm.g.addProp({
      kind: PropKind.CHAIR_STACKING, variant: 0, x: x + lm.rng.range(-0.012, 0.012), y: k * CHAIR_NEST, z: z + lm.rng.range(-0.012, 0.012),
      yaw: yaw + lm.rng.range(-0.02, 0.02), scale: 1, flags: k === 0 ? defaultPropFlags(PropKind.CHAIR_STACKING) : 0, seed: lm.rng.next(),
    });
  }
}

export const chairStacks: LandmarkGenerator = {
  kind: LandmarkKind.CHAIR_STACKS, storeys: [Storey.LOBBY, Storey.SUBLEVEL, Storey.POOLROOMS], weight: 1, footprint: [S, S], heroOnly: true,
  hero: [Zone.LOBBY, Zone.MANILA, Zone.DARK, Zone.MAZE, Zone.OFFICE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const st = storeyStyle(s, CEIL * 100);
    claim(lm, st);
    const door = lm.rng.int(2, 5);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, st.wallMat, s === 0 ? EdgeTrim.CASING : 0, 210);
    if (lm.rng.chance(0.5)) opening(lm, S - 1, 1, 1, 0, EdgeKind.DOORWAY, st.wallMat, s === 0 ? EdgeTrim.CASING : 0, 210);

    // stacks on a loose grid over the back two thirds of the room (0.62 m pitch), placed in shuffled order until the
    // chairs run out: 14-16 nested stacks of 4-10 chairs, 1.1-1.6 m tall, crowding the room
    let left = CHAIR_STACKS.total - 5; // 5 loose chairs below
    const back = S * CELL - WALL_T / 2;
    const spots: [number, number][] = [];
    for (let r = 0; r < 6; r++) for (let um = 0.55 + (r & 1) * 0.3; um < S * CELL - 0.5; um += 0.66) spots.push([um, back - 0.4 - r * 0.72]);
    lm.rng.shuffle(spots);
    for (const [um, vm] of spots) {
      if (left <= 0) break;
      const n = Math.min(left, lm.rng.int(4, 10));
      chairStack(lm, um + lm.rng.range(-0.06, 0.06), vm + lm.rng.range(-0.06, 0.06), 0, lm.rng.chance(0.8) ? 1 : -1, n);
      left -= n;
    }
    // loose chairs: a few pulled off the stacks, one set out alone facing the door
    for (let k = 0; k < 4; k++) {
      prop(lm, PropKind.CHAIR_STACKING, lm.rng.range(0.6, S * CELL - 0.6), lm.rng.range(2.8, 4.0), 0, 0, 1, 0, undefined, lm.rng.range(-1.2, 1.2));
    }
    prop(lm, PropKind.CHAIR_STACKING, (door + 0.5) * CELL + lm.rng.range(-0.2, 0.2), 2.2, 0, 0, -1, 0, undefined, lm.rng.range(-0.05, 0.05));
    floorDecal(lm, (door + 0.5) * CELL, 2.4, 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.2, h: 0.8, alpha: 0.4 });
    // light: one working troffer over the door side, a flickering one over the stacks
    const col = kelvinToLinearRGB(4100, 0.035);
    troffer(lm, 3 * CELL + 0.3, 1 * CELL, CEIL, col, 3300, LightState.ON);
    troffer(lm, 4 * CELL + 0.3, 5 * CELL, CEIL, col, 3300, lm.rng.chance(0.6) ? LightState.FLICKER : LightState.DYING);
    if (s === 0) ageCeiling(lm, 0.2, 0.05, 0.02);
    emitter(lm, EmitterKind.BUZZ, 4 * CELL, 5.5 * CELL, CEIL - 0.3, 0.2);
    return { entrances: lm.entrances };
  },
};
