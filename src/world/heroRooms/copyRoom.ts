// src/world/heroRooms/copyRoom.ts — COPY_ROOM hero (OFFICE, MANILA; 6x6, R2 B4): a windowless copy room. A big
// floor-standing photocopier hums with its scan lamp leaking green light under the lid; reams of paper are stacked in
// boxes, a steel shelf is full of them, and copies of the same page lie all over the floor. One buzzing troffer.
//
// Frame: u across (6 cells), v along (6 cells). Door in the v = 0 wall; the copier against the v = L wall.

import { CELL, WALL_T } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { Vec3, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, claim, emitter, floorDecal, glowPanel, opening, prop, SOLID_F, storeyStyle, THIN_F, troffer, wallDecal } from '../landmarks/common.ts';
import type { Lm } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const S = 6;
const CEIL = 2.6;
const SCAN: Vec3 = [0.35, 1.0, 0.45];

/** A floor-standing photocopier at frame metres (um, vm) with its back to the wall (front facing -v). */
export function photocopier(lm: Lm, um: number, backV: number, scanOn: boolean): void {
  const w = 1.15, d = 0.72;
  const v0 = backV - d, v1 = backV;
  box(lm, um - w / 2, v0, um + w / 2, v1, 0.05, 0.92, Mat.PLASTIC, SOLID_F); // body
  box(lm, um - w / 2 + 0.04, v0 + 0.04, um + w / 2 - 0.04, v1 - 0.04, 0, 0.05, Mat.RUBBER, SOLID_F); // plinth
  // the lid stands open against the wall; the platen glass shows, the scan bar lit across it
  box(lm, um - w / 2 + 0.02, v1 - 0.06, um + w / 2 - 0.2, v1 - 0.02, 0.92, 1.5, Mat.PLASTIC, THIN_F);
  // platen glass and control panel: dark (shell solids take their layer's mean albedo, untinted: on PLASTIC they
  // vanished into the light grey body)
  box(lm, um - w / 2 + 0.06, v0 + 0.08, um + w / 2 - 0.24, v1 - 0.1, 0.92, 0.925, Mat.RUBBER, THIN_F); // platen glass
  box(lm, um + w / 2 - 0.2, v0 + 0.02, um + w / 2, v0 + 0.3, 0.92, 0.99, Mat.RUBBER, THIN_F); // control panel
  box(lm, um - w / 2 - 0.35, v0 + 0.15, um - w / 2, v1 - 0.1, 0.62, 0.66, Mat.PLASTIC, THIN_F); // output tray
  for (let k = 0; k < 3; k++) box(lm, um - w / 2 + 0.06, v0 - 0.006, um + w / 2 - 0.06, v0, 0.12 + k * 0.24, 0.13 + k * 0.24, Mat.RUBBER, THIN_F); // drawer lines
  if (scanOn) {
    // the scan bar under the glass: a bright green line across the platen, and its spill on the lid
    const [x, z] = lm.f.point(um - 0.09, v0 + 0.25 + lm.rng.range(0, 0.25));
    lm.g.addDecal({ kind: 15, sign: true, px: x, py: 0.927, pz: z, nx: 0, ny: 1, nz: 0, rot: lm.f.yaw(0, 1), w: w - 0.34, h: 0.035, alpha: 1, emit: 900, color: SCAN });
    glowPanel(lm, um - 0.09, v1 - 0.065, 1.08, 0, -1, w - 0.4, 0.2, 60, SCAN);
  }
  glowPanel(lm, um + w / 2 - 0.1, v0 + 0.018, 0.955, 0, -1, 0.07, 0.03, 180, [1.0, 0.55, 0.1]); // amber status display
}

export const copyRoom: LandmarkGenerator = {
  kind: LandmarkKind.COPY_ROOM, storeys: [Storey.LOBBY, Storey.POOLROOMS], weight: 1, footprint: [S, S], heroOnly: true,
  hero: [Zone.OFFICE, Zone.MANILA] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const st = storeyStyle(s, CEIL * 100, s === 0 ? { floorMat: Mat.VINYL_VCT, wallMat: Mat.DRYWALL } : {});
    claim(lm, st);
    const door = lm.rng.int(1, 4);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, st.wallMat, s === 0 ? EdgeTrim.CASING : 0, 210);
    const back = S * CELL - WALL_T / 2;
    const cu = lm.rng.range(2.6, 4.6);
    photocopier(lm, cu, back - 0.02, true);
    // a steel shelf of paper boxes on the u = 0 wall
    const su = WALL_T / 2;
    for (let r = 0; r < 4; r++) box(lm, su, 1.4, su + 0.45, 4.6, 0.1 + r * 0.5, 0.13 + r * 0.5, Mat.METAL_PAINTED, THIN_F);
    for (const vm of [1.42, 4.56]) for (const um of [su + 0.02, su + 0.43]) box(lm, um - 0.02, vm - 0.02, um + 0.02, vm + 0.02, 0, 1.75, Mat.METAL_PAINTED, THIN_F);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) {
      if (lm.rng.chance(0.25)) continue;
      const [x, z] = lm.f.point(su + 0.23, 1.75 + k * 0.5);
      g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: lm.rng.int(0, 3), x, y: 0.13 + r * 0.5, z, yaw: lm.f.yaw(1, 0) + lm.rng.range(-0.1, 0.1), scale: 0.95, flags: 0, seed: lm.rng.next() });
    }
    // floor stacks of reams by the copier, a bin overflowing
    for (let k = 0; k < 4; k++) {
      const [x, z] = lm.f.point(S * CELL - 0.5, back - 0.4 - k * 0.45);
      const h = lm.rng.int(1, 3);
      for (let i = 0; i < h; i++) g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: lm.rng.int(0, 3), x, y: i * 0.4, z, yaw: lm.rng.range(-0.15, 0.15), scale: 1, flags: i === 0 ? 1 : 0, seed: lm.rng.next() });
    }
    prop(lm, PropKind.TRASH_CAN, cu - 1.1, back - 0.3, 0, 0, -1, lm.rng.int(0, 3));
    // copies of the same page everywhere
    for (let k = 0; k < 16; k++) {
      floorDecal(lm, lm.rng.range(0.8, S * CELL - 0.8), lm.rng.range(0.6, back - 0.9), 0, { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(0, 6.28), w: 0.3, h: 0.22, alpha: 0.95 });
    }
    wallDecal(lm, S - 1, 2, S, 2, 0.5, 1.5, { kind: DecalKind.POSTER, sign: false, rot: 0, w: 0.6, h: 0.8, alpha: 0.85 });
    // one buzzing troffer
    troffer(lm, 2 * CELL + 0.3, 2 * CELL, CEIL, kelvinToLinearRGB(4200, 0.05), 3300, LightState.BUZZ);
    if (s === 0) ageCeiling(lm, 0.18, 0.04, 0.02);
    emitter(lm, EmitterKind.MACHINE, cu, back - 0.4, 0.6, 0.45);
    return { entrances: lm.entrances };
  },
};
