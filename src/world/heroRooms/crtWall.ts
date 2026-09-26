// src/world/heroRooms/crtWall.ts — CRT_WALL hero (Level 0 family, offices; 10x8, R2 B4): a dark room whose back wall
// is a steel shelving unit holding thirty old CRT monitors, six across and five high. One of them is on: a pale blue
// screen that lights a swivel chair left in front of it. A couple of others show a green standby light. The ceiling
// lights are dead but one, which is dying.
//
// Frame: u across (10 cells), v along (8 cells). Door in the v = 0 wall; the shelving against the v = L wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { Vec3, ZoneId } from '../../core/index.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, claim, DOWN, emitter, fixture, floorDecal, glowPanel, opening, prop, storeyStyle, THIN_F, troffer } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 10, L = 8;
const CEIL = 2.7;
export const CRT_WALL = { cols: 6, rows: 5, pitchU: 0.56, pitchY: 0.46, y0: 0.08 } as const;
const SCREEN: Vec3 = [0.55, 0.72, 1.0];
const STANDBY: Vec3 = [0.15, 1.0, 0.2];

export const crtWall: LandmarkGenerator = {
  kind: LandmarkKind.CRT_WALL, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.LOBBY, Zone.OFFICE, Zone.DARK, Zone.MAZE, Zone.LOW_EXPANSE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const st = storeyStyle(s, CEIL * 100, s === 0 ? { floorMat: Mat.CARPET_OFFICE, wallMat: Mat.DRYWALL } : {});
    claim(lm, st);
    const door = lm.rng.int(1, 3);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, st.wallMat, s === 0 ? EdgeTrim.CASING : 0, 210);
    opening(lm, W - 1, lm.rng.int(1, 3), 1, 0, EdgeKind.DOORWAY, st.wallMat, s === 0 ? EdgeTrim.CASING : 0, 210);

    const C = CRT_WALL;
    const crt = PROP_DEFS[PropKind.CRT_MONITOR].size; // 0.4 x 0.38 x 0.42
    const back = L * CELL - WALL_T / 2;
    const depth = 0.5;
    const width = C.cols * C.pitchU + 0.1;
    const u0 = (W * CELL - width) / 2;
    const steel = Mat.METAL_PAINTED;
    // the shelving: uprights and a shelf under every row
    for (let k = 0; k <= C.cols; k++) {
      const um = u0 + 0.05 + k * C.pitchU;
      for (const vm of [back - depth, back - 0.04]) box(lm, um - 0.02, vm, um + 0.02, vm + 0.04, 0, C.y0 + C.rows * C.pitchY + 0.05, steel, THIN_F);
    }
    for (let r = 0; r <= C.rows; r++) box(lm, u0, back - depth, u0 + width, back, C.y0 + r * C.pitchY - 0.03, C.y0 + r * C.pitchY, steel, THIN_F);
    // thirty monitors, slightly askew; one on, some on standby
    const on = [lm.rng.int(1, C.cols - 2), lm.rng.int(1, 3)];
    const vmC = back - depth / 2 - 0.02;
    for (let r = 0; r < C.rows; r++) {
      for (let c = 0; c < C.cols; c++) {
        const um = u0 + 0.05 + (c + 0.5) * C.pitchU + lm.rng.range(-0.03, 0.03);
        const y = C.y0 + r * C.pitchY;
        const isOn = c === on[0] && r === on[1];
        prop(lm, PropKind.CRT_MONITOR, um, vmC, y, 0, -1, lm.rng.int(0, 3), 0, isOn ? 0 : lm.rng.range(-0.08, 0.08));
        const front = vmC - crt[2] / 2 - 0.004;
        if (isOn) {
          glowPanel(lm, um, front, y + 0.2, 0, -1, 0.3, 0.22, 450, SCREEN);
          // the screen's light: a small bulb hidden inside the monitor body
          fixture(lm, FixtureKind.CAGE_BULB, um, vmC + 0.02, y + 0.17, DOWN, [1, 0], SCREEN, 90, LightState.ON, { shape: 1, w: 0.04, h: 0.04, hum: 0.15 });
        } else if (lm.rng.chance(0.12)) {
          glowPanel(lm, um + 0.13, front, y + 0.05, 0, -1, 0.012, 0.008, 160, STANDBY);
        }
      }
    }
    // the chair left facing the lit screen, cables across the floor
    const onU = u0 + 0.05 + (on[0] + 0.5) * C.pitchU;
    prop(lm, PropKind.OFFICE_CHAIR, onU + lm.rng.range(-0.2, 0.2), back - depth - 1.1, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.3, 0.3));
    for (let k = 0; k < 3; k++) {
      floorDecal(lm, u0 + lm.rng.range(0.3, width - 0.3), back - depth - lm.rng.range(0.2, 0.9), 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.f.yaw(1, 0) + lm.rng.range(-0.4, 0.4), w: 0.12, h: 1.6, alpha: 0.6 });
    }
    // a desk with a keyboard-less monitor and a phone near the door
    prop(lm, PropKind.DESK, 1.4, 1.2, 0, 0, 1, lm.rng.int(0, 3));
    prop(lm, PropKind.PHONE, 1.1, 1.3, 0.75, 0, 1, 0, undefined, lm.rng.range(-0.4, 0.4));
    // dead ceiling except one dying troffer at the far side
    const col = kelvinToLinearRGB(4100, 0.035);
    for (let v = 1; v < L - 1; v += 3) for (let u = 1; u < W - 1; u += 3) {
      const last = u >= W - 3 && v === 1;
      troffer(lm, u * CELL + 0.3, v * CELL, CEIL, col, 3300, last ? LightState.DYING : LightState.OFF);
    }
    if (s === 0) ageCeiling(lm, 0.2, 0.04, 0.03);
    emitter(lm, EmitterKind.BUZZ, onU, back - 0.3, 1.0, 0.3); // the flyback whine
    return { entrances: lm.entrances };
  },
};
