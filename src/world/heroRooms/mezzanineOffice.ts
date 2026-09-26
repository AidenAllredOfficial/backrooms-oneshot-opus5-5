// src/world/heroRooms/mezzanineOffice.ts — MEZZANINE_OFFICE hero (WAREHOUSE; 14x12, R2 B4): a foreman's office box
// perched on a steel mezzanine in an 8 m warehouse bay. A steep industrial stair with handrails climbs to the deck;
// the cabin's window band glows warm from a light left on inside (a desk, a chair, a filing cabinet visible through
// it); pallets and a racking bay sit in the shadow under the deck; high-bay lamps light the floor.
//
// Frame: u across (14 cells), v along (12 cells). Deck: u 1.2..9.6 m, v 7.2 m..back wall at 3.4 m on 8 columns.
// Stair: u 9.6..14.0 m, v 7.2..8.3 m (0 -> 3.4 m toward -u). Cabin: u 1.8..7.8 m, v 8.6..13.9 m.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DECAL_PAINT_STRIPE, EdgeKind, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { begin, box, claim, DOWN, emitter, fixture, floorDecal, handrail, opening, prop, ramp, SOLID_F, THIN_F, WALK_F } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const W = 14, L = 12;
const CEIL = 8.0;
export const MEZZANINE = { deckY: 3.4, deck: [1.2, 7.2, 9.6] as const, stair: [9.6, 14.0, 7.2, 8.3] as const, cabin: [1.8, 8.6, 7.8] as const, cabinH: 2.6 } as const;

export const mezzanineOffice: LandmarkGenerator = {
  kind: LandmarkKind.MEZZANINE_OFFICE, storeys: [Storey.SUBLEVEL], weight: 1, footprint: [W, L], heroOnly: true,
  hero: [Zone.WAREHOUSE] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, W, L);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.CMU_PAINTED;
    claim(lm, { floorMat: Mat.CONCRETE_FLOOR, wallMat, ceilMat: Mat.METAL_DECK, ceilKind: CeilKind.TRUSS, ceilCm: CEIL * 100, trimMat: Mat.METAL_PAINTED });
    for (const u of [5, 6, 7]) opening(lm, u, 0, 0, -1, EdgeKind.OPEN, wallMat);
    opening(lm, W - 1, lm.rng.int(2, 4), 1, 0, EdgeKind.HEADER, wallMat, 0, 300);
    const M = MEZZANINE;
    const y = M.deckY;
    const back = L * CELL - WALL_T / 2;
    const [du0, dv0, du1] = M.deck;
    const steel = Mat.METAL_PAINTED;
    // the deck: grating on a steel frame, columns, a kick plate and rails on the open edges
    box(lm, du0, dv0, du1, back, y - 0.3, y - 0.05, steel, SOLID_F);
    box(lm, du0, dv0, du1, back, y - 0.05, y, Mat.METAL_GRATE, WALK_F);
    for (const um of [du0 + 0.15, (du0 + du1) / 2, du1 - 0.15]) for (const vm of [dv0 + 0.15, back - 0.3]) box(lm, um - 0.12, vm - 0.12, um + 0.12, vm + 0.12, 0, y - 0.3, steel, SOLID_F);
    handrail(lm, du0 + 0.05, dv0 + 0.05, y, du1 - 0.05, dv0 + 0.05, y, Mat.METAL_PAINTED, 1.05, 6);
    handrail(lm, du0 + 0.05, dv0 + 0.05, y, du0 + 0.05, back - 0.1, y, Mat.METAL_PAINTED, 1.05, 4);
    handrail(lm, du1 - 0.05, M.stair[3] + 0.1, y, du1 - 0.05, back - 0.1, y, Mat.METAL_PAINTED, 1.05, 4);
    box(lm, du0, dv0, du1, dv0 + 0.02, y, y + 0.12, Mat.METAL_PAINTED, THIN_F);
    // the stair: 20 risers up toward -u, rails both sides
    const [su0, su1, sv0, sv1] = M.stair;
    ramp(lm, su0, sv0, su1, sv1, -1, 0, 0, y, 20, Mat.METAL_GRATE);
    handrail(lm, su1 - 0.1, sv0 + 0.04, 0.15, su0, sv0 + 0.04, y, Mat.METAL_PAINTED, 0.95, 4);
    handrail(lm, su1 - 0.1, sv1 - 0.04, 0.15, su0, sv1 - 0.04, y, Mat.METAL_PAINTED, 0.95, 4);
    // the cabin: wall panels below and above a window band, mullions, a roof; a door at the stair end
    const [cu0, cv0, cu1] = M.cabin;
    const cv1 = back - 0.1;
    const y0 = y, y1 = y + 1.0, y2 = y + 2.0, y3 = y + M.cabinH;
    const t = 0.1, panel = Mat.DRYWALL;
    box(lm, cu0, cv0, cu1, cv0 + t, y0, y1, panel, SOLID_F);
    box(lm, cu0, cv0, cu1, cv0 + t, y2, y3, panel, SOLID_F);
    box(lm, cu0, cv0, cu0 + t, cv1, y0, y1, panel, SOLID_F);
    box(lm, cu0, cv0, cu0 + t, cv1, y2, y3, panel, SOLID_F);
    box(lm, cu1 - t, cv0, cu1, cv0 + 1.2, y0, y3, panel, SOLID_F);
    box(lm, cu1 - t, cv0 + 2.1, cu1, cv1, y0, y3, panel, SOLID_F);
    box(lm, cu1 - t, cv0 + 1.2, cu1, cv0 + 2.1, y + 2.1, y3, panel, SOLID_F);
    for (let um = cu0; um <= cu1 + 1e-6; um += (cu1 - cu0) / 4) box(lm, um - 0.03, cv0, um + 0.03, cv0 + t, y1, y2, steel, THIN_F);
    for (let vm = cv0 + 1.3; vm < cv1; vm += 1.3) box(lm, cu0, vm - 0.03, cu0 + t, vm + 0.03, y1, y2, steel, THIN_F);
    box(lm, cu0 - 0.1, cv0 - 0.1, cu1 + 0.1, cv1, y3, y3 + 0.15, Mat.METAL_DECK, SOLID_F);
    // inside: the light left on, a desk, a chair, a cabinet
    fixture(lm, FixtureKind.TUBE_STRIP, (cu0 + cu1) / 2, (cv0 + cv1) / 2, y3 - 0.05, DOWN, [1, 0], kelvinToLinearRGB(3300, 0.02), 7000, LightState.ON, { hum: 0.5 });
    prop(lm, PropKind.DESK, (cu0 + cu1) / 2 - 0.8, cv0 + 0.75, y, 0, 1, lm.rng.int(0, 3));
    prop(lm, PropKind.OFFICE_CHAIR, (cu0 + cu1) / 2 - 0.8, cv0 + 1.55, y, 0, -1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.6, 0.6));
    prop(lm, PropKind.CRT_MONITOR, (cu0 + cu1) / 2 - 0.9, cv0 + 0.55, y + 0.75, 0, 1, 0);
    prop(lm, PropKind.FILING_CABINET, cu0 + 0.45, cv1 - 0.35, y, 0, -1, lm.rng.int(0, 3));
    prop(lm, PropKind.FILING_CABINET, cu0 + 0.95, cv1 - 0.35, y, 0, -1, lm.rng.int(0, 3));
    // under the deck: pallets and boxes in the shadow; floor markings around the stair foot
    for (let k = 0; k < 4; k++) {
      const um = 2.2 + k * 1.7, vm = back - 1.2 - lm.rng.range(0, 0.4);
      const p = prop(lm, PropKind.PALLET, um, vm, 0, 0, 1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.1, 0.1));
      if (lm.rng.chance(0.6)) g.addProp({ kind: PropKind.CRATE, variant: lm.rng.int(0, 3), x: p.x, y: 0.15, z: p.z, yaw: p.yaw, scale: 1, flags: 1, seed: lm.rng.next() });
    }
    floorDecal(lm, (du0 + du1) / 2, dv0 - 0.4, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(1, 0), w: 0.12, h: du1 - du0, alpha: 0.85 });
    floorDecal(lm, su1 + 0.3, (sv0 + sv1) / 2, 0.002, { kind: DECAL_PAINT_STRIPE, sign: false, rot: lm.f.yaw(0, 1), w: 0.12, h: 2.2, alpha: 0.85 });
    // open floor: a rack bay against the far side wall, a pallet jack spot
    prop(lm, PropKind.SHELF_RACK, W * CELL - 0.7, 2.4, 0, -1, 0, lm.rng.int(0, 3));
    // high-bay lamps
    const hb = kelvinToLinearRGB(4200, 0.02);
    const dead = lm.rng.int(0, 3);
    [[4.0, 3.2], [11.5, 3.2], [11.5, 10.8], [4.8, 5.4]].forEach(([um, vm], i) => {
      const st: LightStateId = i === dead ? LightState.DYING : LightState.ON;
      fixture(lm, FixtureKind.HIGHBAY, um, vm, CEIL - 1.2, DOWN, [1, 0], hb, 3400, st, { shape: 1, w: 0.45, h: 0.45, hum: 0.5 });
    });
    emitter(lm, EmitterKind.RADIO, (cu0 + cu1) / 2, (cv0 + cv1) / 2, y + 1.0, 0.2);
    emitter(lm, EmitterKind.VENT, W * CELL / 2, L * CELL / 2, CEIL - 0.5, 0.3);
    return { entrances: lm.entrances };
  },
};
