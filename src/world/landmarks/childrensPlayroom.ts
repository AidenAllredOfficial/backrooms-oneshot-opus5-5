// src/world/landmarks/childrensPlayroom.ts — CHILDRENS_PLAYROOM (storey 0; 10x10, R2 B4): an office creche with
// nobody in it. Rubber play floor, low tables with child-sized chairs, cubby shelves, a little plastic slide with a
// platform and steps, a sunken padded play pit, paper drawings taped along the walls at child height. All the lights
// are on; a radio somewhere plays to no one.
//
// Frame: u across (10 cells), v along (10 cells). Door in the v = 0 wall (+ a side door); the slide in the far corner.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EdgeTrim, EmitterKind, LandmarkKind, LightState, Mat, PropKind, Storey } from '../../core/index.ts';
import type { Vec3 } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, cells, claim, emitter, floorDecal, opening, prop, ramp, SOLID_F, THIN_F, troffer, WALK_F, wallDecal } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const W = 10, L = 10;
const CEIL = 2.7;
export const PLAYROOM = { pit: [6, 1, 9, 4] as const, pitCm: -40, chairScale: 0.62 } as const;

/** Crayon-bright tints for the drawings (decal colour). */
const DRAWING: readonly Vec3[] = [[0.9, 0.2, 0.15], [0.2, 0.45, 0.9], [0.95, 0.8, 0.15], [0.25, 0.75, 0.3], [0.85, 0.4, 0.8]];

export const childrensPlayroom: LandmarkGenerator = {
  kind: LandmarkKind.CHILDRENS_PLAYROOM, storeys: [Storey.LOBBY], weight: 0.9, footprint: [W, L],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.DRYWALL;
    claim(lm, { floorMat: Mat.VINYL_VCT, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, baseboard: true });
    opening(lm, lm.rng.int(1, 3), 0, 0, -1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
    opening(lm, 0, lm.rng.int(3, 5), -1, 0, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);

    // a carpet square in the middle (story corner)
    cells(lm, 2, 4, 6, 8, { floorMat: Mat.CARPET_OFFICE });
    // the padded pit: 40 cm deep, soft floor, a 2-step ramp in
    const [pu0, pv0, pu1, pv1] = PLAYROOM.pit;
    cells(lm, pu0, pv0, pu1, pv1, { floorCm: PLAYROOM.pitCm, floorMat: Mat.FABRIC_PARTITION });
    ramp(lm, pu0 * CELL, (pv1 - 1) * CELL, (pu0 + 1) * CELL, pv1 * CELL, -1, 0, PLAYROOM.pitCm / 100, 0, 2, Mat.RUBBER, true);
    // cushions (soft boxes) scattered in the pit
    for (let k = 0; k < 6; k++) {
      const um = lm.rng.range((pu0 + 1.2) * CELL, pu1 * CELL - 0.5), vm = lm.rng.range(pv0 * CELL + 0.5, pv1 * CELL - 0.5);
      const s = lm.rng.range(0.3, 0.5);
      box(lm, um - s, vm - s * 0.7, um + s, vm + s * 0.7, PLAYROOM.pitCm / 100, PLAYROOM.pitCm / 100 + 0.14, Mat.FABRIC_PARTITION, THIN_F);
    }

    // the slide: a platform with steps, a sloped chute down toward the room
    const su = 1.0, sv = L * CELL - WALL_T / 2 - 1.3; // platform min corner
    box(lm, su, sv, su + 1.0, sv + 1.0, 0, 0.9, Mat.PLASTIC, WALK_F);
    for (const [a, b] of [[su, sv], [su + 0.96, sv], [su, sv + 0.96], [su + 0.96, sv + 0.96]]) box(lm, a, b, a + 0.04, b + 0.04, 0.9, 1.6, Mat.METAL_PAINTED, THIN_F);
    box(lm, su, sv + 0.97, su + 1.0, sv + 1.0, 1.2, 1.6, Mat.PLASTIC, THIN_F); // back panel
    ramp(lm, su + 1.0, sv + 0.1, su + 1.9, sv + 0.9, -1, 0, 0, 0.9, 5, Mat.PLASTIC, true); // moulded steps up (+u side)
    ramp(lm, su + 0.15, sv - 2.2, su + 0.85, sv, 0, 1, 0.02, 0.9, 0, Mat.PLASTIC); // the chute (smooth)
    box(lm, su + 0.12, sv - 2.2, su + 0.15, sv, 0.02, 1.1, Mat.PLASTIC, THIN_F); // chute sides
    box(lm, su + 0.85, sv - 2.2, su + 0.88, sv, 0.02, 1.1, Mat.PLASTIC, THIN_F);

    // low tables + child chairs (a stacking chair at 62%)
    const tables: [number, number][] = [[3.3, 2.1], [6.2, 5.2]];
    for (const [tu, tv] of tables) {
      box(lm, tu - 0.6, tv - 0.4, tu + 0.6, tv + 0.4, 0.5, 0.54, Mat.WOOD, SOLID_F);
      for (const [a, b] of [[-0.55, -0.35], [0.55, -0.35], [-0.55, 0.35], [0.55, 0.35]]) box(lm, tu + a - 0.02, tv + b - 0.02, tu + a + 0.02, tv + b + 0.02, 0, 0.5, Mat.METAL_PAINTED, THIN_F);
      for (const [du, dv, cu, cv] of [[0, 1, 0.3, -0.72], [0, 1, -0.3, -0.72], [0, -1, 0.3, 0.72], [0, -1, -0.3, 0.72]]) {
        if (lm.rng.chance(0.2)) continue;
        const p = prop(lm, PropKind.CHAIR_STACKING, tu + cu, tv + cv, 0, du, dv, 0, 0, lm.rng.range(-0.3, 0.3));
        p.scale = PLAYROOM.chairScale;
      }
    }
    // one little chair alone in the corner, facing the wall
    const lone = prop(lm, PropKind.CHAIR_STACKING, W * CELL - 0.5, L * CELL - 0.5, 0, 1, 1, 0, 0, lm.rng.range(-0.1, 0.1));
    lone.scale = PLAYROOM.chairScale;

    // cubby shelves along the u = W wall: a 3x4 grid of open boxes, some with a backpack
    const cu = W * CELL - WALL_T / 2;
    const cv0 = 5.2;
    box(lm, cu - 0.4, cv0, cu, cv0 + 3.2, 0, 0.03, Mat.WOOD, THIN_F);
    for (let r = 0; r <= 3; r++) box(lm, cu - 0.4, cv0, cu, cv0 + 3.2, 0.03 + r * 0.38, 0.05 + r * 0.38, Mat.WOOD, THIN_F);
    for (let k = 0; k <= 4; k++) box(lm, cu - 0.4, cv0 + k * 0.79, cu, cv0 + k * 0.79 + 0.02, 0, 1.2, Mat.WOOD, THIN_F);
    for (let k = 0; k < 4; k++) if (lm.rng.chance(0.4)) prop(lm, PropKind.BACKPACK, cu - 0.2, cv0 + k * 0.79 + 0.4, 0.05 + lm.rng.int(0, 2) * 0.38, -1, 0, 0);

    // drawings taped along the walls at child height (tinted paper), a poster or two higher up
    for (let u = 1; u < W - 1; u++) {
      if (lm.rng.chance(0.35)) continue;
      const col = DRAWING[lm.rng.int(0, DRAWING.length - 1)];
      wallDecal(lm, u, L - 1, u, L, lm.rng.range(0.3, 0.7), lm.rng.range(0.85, 1.2), { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(-0.2, 0.2), w: 0.34, h: 0.26, alpha: 0.95, color: col });
    }
    for (let v = 1; v < L - 1; v++) {
      if (lm.rng.chance(0.5)) continue;
      const col = DRAWING[lm.rng.int(0, DRAWING.length - 1)];
      wallDecal(lm, 0, v, -1, v, lm.rng.range(0.3, 0.7), lm.rng.range(0.85, 1.2), { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(-0.2, 0.2), w: 0.34, h: 0.26, alpha: 0.95, color: col });
    }
    wallDecal(lm, 4, L - 1, 4, L, 0.5, 1.8, { kind: DecalKind.POSTER, sign: false, rot: 0, w: 0.7, h: 0.9, alpha: 0.9 });
    floorDecal(lm, 4.8, 7.0, 0, { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.6, alpha: 0.35 });

    // bright, even light: all on
    const col = kelvinToLinearRGB(4300, 0.02);
    for (let v = 1; v < L - 1; v += 3) for (let u = 1; u < W - 1; u += 3) troffer(lm, u * CELL + 0.3, v * CELL, CEIL, col, 3400, LightState.ON);
    ageCeiling(lm, 0.08, 0.02, 0);
    emitter(lm, EmitterKind.RADIO, cu - 0.3, cv0 + 2.9, 1.25, 0.25);
    prop(lm, PropKind.RADIO, cu - 0.22, cv0 + 2.9, 0.05 + 3 * 0.38, -1, 0, 0);
    return { entrances: lm.entrances };
  },
};
