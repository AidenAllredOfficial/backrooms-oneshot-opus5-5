// src/world/landmarks/serverRoom.ts — SERVER_ROOM (storey 1, 8x8): two facing rows of racks (SHELF_RACK props scaled
// to server-rack proportions) peppered with tiny emissive LED quads (decals with emit 40-200 nits, green / amber),
// cold 5000 K TUBE_STRIP battens over the aisles and a MACHINE emitter for the fan roar (WP4).
//
// Frame: u across (8 cells), v along (8 cells). The only door is a DOORWAY in the v = 0 wall; rack rows run along u
// at v = 2.2 m and v = 5.3 m with their fronts facing the central cold aisle.

import { CELL, WALL_T } from '../../core/constants.ts';
import { CeilKind, DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, SignKind, Storey } from '../../core/index.ts';
import type { Vec3 } from '../../core/index.ts';
import { PROP_DEFS } from '../../core/props.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, claim, DOWN, emitter, fixture, floorDecal, opening, OVERHEAD, pipeF, prop, THIN_F, troffer, wallDecal } from './common.ts';
import type { Lm } from './common.ts';
import type { LandmarkGenerator } from './index.ts';

const S = 8;
const CEIL = 3.0;
/** SHELF_RACK scaled to a 2.3 m tall, 0.6 m deep, 1.32 m wide cabinet. */
export const RACK_SCALE = 0.55;
const RACK = PROP_DEFS[PropKind.SHELF_RACK].size;
const RW = RACK[0] * RACK_SCALE, RH = RACK[1] * RACK_SCALE, RD = RACK[2] * RACK_SCALE;
/** Cabinet body half extents: between the rack's uprights across, 2 cm proud of the rack front / back. The rack is a
 * whole-footprint bake occluder (PROP_DEFS.occlude), so lightmapped faces must lie outside its AABB: the lit front
 * and back faces do; the sides (hidden by the neighbouring cabinets) and the top (above eye level) do not. */
const CAB_HW = RW / 2 - 0.045, CAB_HD = RD / 2 + 0.02;
const LED_GREEN: Vec3 = [0.1, 1, 0.18];
const LED_AMBER: Vec3 = [1, 0.55, 0.05];

/** LED status lights: a short row of n tiny emissive quads on a front plane (frame metres), green with some amber. */
function leds(lm: Lm, um: number, front: number, y: number, dv: number, n: number, pitch = 0.035): void {
  const [nx, nz] = lm.f.dir(0, dv);
  for (let i = 0; i < n; i++) {
    const amber = lm.rng.chance(0.16);
    const [x, z] = lm.f.point(um + i * pitch, front);
    lm.g.addDecal({
      kind: SignKind.BLANK, sign: true, px: x, py: y, pz: z, nx, ny: 0, nz,
      rot: 0, w: 0.014, h: 0.009, alpha: 1, emit: Math.round(lm.rng.range(60, 240)), color: amber ? LED_AMBER : LED_GREEN,
    });
  }
}

/** A row of racks along u centred at vm; fronts face dv (+1 / -1). R2 (B4): every cabinet gets a readable front:
 * either a perforated steel door (grate panel, handle, a status LED strip) or an open front of 1U-4U equipment
 * units with bezels, drive-bay slots and LED rows; a cable tray with cable bundles runs over the row. */
function rackRow(lm: Lm, vm: number, dv: 1 | -1, u0: number, u1: number): void {
  const n = Math.floor((u1 - u0) / (RW + 0.04));
  const span = n * RW + (n - 1) * 0.04;
  let um = u0 + (u1 - u0 - span) / 2 + RW / 2;
  const first = um;
  const side = dv; // +1: detail starts at the -u end of each front, -1: at the +u end (mirrored rows face each other)
  for (let k = 0; k < n; k++, um += RW + 0.04) {
    const p = prop(lm, PropKind.SHELF_RACK, um, vm, 0, 0, dv, lm.rng.chance(0.2) ? 1 : 0);
    p.scale = RACK_SCALE;
    // the equipment: a closed cabinet body inside the rack frame (hides the rack's cardboard loads)
    box(lm, um - CAB_HW, vm - CAB_HD, um + CAB_HW, vm + CAB_HD, 0.02, RH - 0.05, Mat.RUBBER); // near-black cabinet body
    const face = vm + dv * CAB_HD; // the body's front plane
    // the rear: a perforated steel door on every cabinet (the service aisle side), a handle, cable bundles dropping out
    const rear = vm - dv * CAB_HD;
    const [ra, rb] = dv > 0 ? [rear - 0.01, rear - 0.001] : [rear + 0.001, rear + 0.01];
    box(lm, um - CAB_HW + 0.03, ra, um + CAB_HW - 0.03, rb, 0.1, RH - 0.16, Mat.METAL_GRATE, THIN_F);
    const [rc, rd] = dv > 0 ? [rear - 0.035, rear - 0.01] : [rear + 0.01, rear + 0.035];
    box(lm, um - side * (CAB_HW - 0.09) - 0.012, rc, um - side * (CAB_HW - 0.09) + 0.012, rd, RH * 0.45, RH * 0.45 + 0.28, Mat.METAL_PAINTED, THIN_F);
    if (lm.rng.chance(0.5)) leds(lm, um + side * (CAB_HW - 0.12), rear - dv * 0.012, lm.rng.range(0.5, RH - 0.4), -dv as 1 | -1, lm.rng.int(1, 3), -side * 0.035);
    const at = (d: number): [number, number] => (dv > 0 ? [face + 0.001, face + d] : [face - d, face - 0.001]);
    if (lm.rng.chance(0.55)) {
      // perforated door: a grate panel standing 8 mm proud, a vertical handle, a top vent strip, LEDs on a status bar
      const [a, b] = at(0.01);
      box(lm, um - CAB_HW + 0.03, a, um + CAB_HW - 0.03, b, 0.1, RH - 0.16, Mat.METAL_GRATE, THIN_F);
      const hu = um + side * (CAB_HW - 0.09);
      const [c, d] = at(0.035);
      box(lm, hu - 0.012, c, hu + 0.012, d, RH * 0.45, RH * 0.45 + 0.28, Mat.METAL_PAINTED, THIN_F);
      const [e, f] = at(0.006);
      box(lm, um - CAB_HW + 0.03, e, um + CAB_HW - 0.03, f, RH - 0.14, RH - 0.08, Mat.METAL_PAINTED, THIN_F);
      leds(lm, um - side * (CAB_HW - 0.1), face + dv * 0.008, RH - 0.11, dv, lm.rng.int(2, 5), side * 0.03);
      // equipment glimpsed through the grate: a few lit LEDs just behind it
      for (let y = 0.4; y < RH - 0.3; y += 0.3) if (lm.rng.chance(0.5)) leds(lm, um - side * (CAB_HW - 0.12 - lm.rng.range(0, 0.1)), face + dv * 0.002, y, dv, lm.rng.int(1, 3), side * 0.035);
    } else {
      // open front: stacked equipment units of 1-4U (44.5 mm), alternating bezel finishes, gaps of blanking plate
      let y = 0.12;
      while (y < RH - 0.2) {
        const U = [1, 1, 2, 2, 3, 4][lm.rng.int(0, 5)];
        const h = U * 0.0445;
        if (y + h > RH - 0.16) break;
        if (lm.rng.chance(0.18)) { y += h; continue; } // an empty slot
        const light = lm.rng.chance(0.5);
        const [a, b] = at(light ? 0.018 : 0.012);
        box(lm, um - CAB_HW + 0.04, a, um + CAB_HW - 0.04, b, y + 0.002, y + h - 0.002, light ? Mat.METAL_PAINTED : Mat.PLASTIC, THIN_F);
        const front = face + dv * ((light ? 0.018 : 0.012) + 0.001);
        if (U >= 2 && lm.rng.chance(0.6)) {
          // drive bays: a row of dark slots across the bezel
          const [c, d] = at(light ? 0.02 : 0.014);
          for (let q = 0; q < 6; q++) {
            const x0 = um - CAB_HW + 0.12 + q * 0.07;
            if (x0 + 0.05 > um + CAB_HW - 0.12) break;
            box(lm, x0, c, x0 + 0.05, d, y + 0.012, y + h - 0.012, Mat.RUBBER, THIN_F);
          }
        }
        leds(lm, um - side * (CAB_HW - 0.07 - lm.rng.range(0, 0.04)), front, y + h / 2, dv, lm.rng.int(1, 4), side * 0.03);
        y += h;
      }
    }
  }
  // cable tray over the row with bundles of cable, and a drop into every other cabinet top
  const last = first + (n - 1) * (RW + 0.04);
  const ty = RH + 0.28;
  box(lm, first - RW / 2, vm - 0.16, last + RW / 2, vm + 0.16, ty, ty + 0.02, Mat.METAL_GRATE, OVERHEAD);
  for (const dvm of [-0.16, 0.16]) box(lm, first - RW / 2, vm + dvm - 0.008, last + RW / 2, vm + dvm + 0.008, ty, ty + 0.09, Mat.METAL_PAINTED, OVERHEAD);
  for (const [dvm, r] of [[-0.08, 0.035], [0.02, 0.03], [0.1, 0.028]] as [number, number][]) {
    pipeF(lm, first - RW / 2, vm + dvm, ty + 0.02 + r, last + RW / 2, vm + dvm, ty + 0.02 + r, r, Mat.RUBBER, OVERHEAD);
  }
  for (let k = 0; k < n; k += 2) {
    const cu = first + k * (RW + 0.04) + lm.rng.range(-0.2, 0.2);
    pipeF(lm, cu, vm, ty + 0.02, cu, vm, RH - 0.05, 0.03, Mat.RUBBER, OVERHEAD);
  }
}

export const serverRoom: LandmarkGenerator = {
  kind: LandmarkKind.SERVER_ROOM, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [S, S],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const wallMat = Mat.DRYWALL;
    claim(lm, { floorMat: Mat.VINYL_VCT, wallMat, ceilMat: Mat.CEILING_TILE, ceilKind: CeilKind.TILES, ceilCm: CEIL * 100, baseboard: true });
    const door = lm.rng.int(2, S - 3);
    opening(lm, door, 0, 0, -1, EdgeKind.DOORWAY, wallMat, EdgeTrim.CASING, 210);
    // AUTHORIZED sign next to the door, inside
    wallDecal(lm, door + 1 < S ? door + 1 : door - 1, 0, door + 1 < S ? door + 1 : door - 1, -1, 0.5, 1.6,
      { kind: SignKind.AUTHORIZED, sign: true, rot: 0, w: 0.35, h: 0.25, alpha: 1 });

    // two rows of racks, fronts facing the cold aisle between them; 1.1 m service aisles behind
    const u0 = 0.9, u1 = S * CELL - 0.9;
    const vA = 2.2 + RD / 2, vB = S * CELL - 2.4 - RD / 2;
    // Level 0 (R2): an IT closet: one row of racks, a workbench of old monitors and boxes where the other row was
    const closet = ctx.key.s === Storey.LOBBY;
    if (!closet) rackRow(lm, vA, 1, u0, u1);
    rackRow(lm, vB, -1, closet ? 3.2 : u0, u1);
    if (closet) {
      for (const um of [2.2, 4.0, 5.8]) {
        prop(lm, PropKind.DESK, um, vA, 0, 0, 1, lm.rng.int(0, 3));
        const n = lm.rng.int(1, 3);
        for (let i = 0; i < n; i++) {
          const [x, z] = lm.f.point(um + (i - (n - 1) / 2) * 0.45 + lm.rng.range(-0.04, 0.04), vA + lm.rng.range(-0.08, 0.05));
          g.addProp({ kind: PropKind.CRT_MONITOR, variant: lm.rng.int(0, 3), x, y: 0.75, z, yaw: lm.f.yaw(0, 1) + lm.rng.range(-0.25, 0.25), scale: 1, flags: 0, seed: lm.rng.next() });
          if (lm.rng.chance(0.4)) g.addProp({ kind: PropKind.CRT_MONITOR, variant: lm.rng.int(0, 3), x, y: 1.13, z, yaw: lm.f.yaw(0, 1) + lm.rng.range(-0.3, 0.3), scale: 1, flags: 0, seed: lm.rng.next() });
        }
        for (let i = 0; i < 2; i++) {
          const [x, z] = lm.f.point(um + lm.rng.range(-0.5, 0.5), vA + lm.rng.range(-0.1, 0.1));
          g.addProp({ kind: PropKind.CARDBOARD_BOX, variant: lm.rng.int(0, 3), x, y: 0, z, yaw: lm.rng.range(-0.3, 0.3), scale: 1, flags: 1, seed: lm.rng.next() });
        }
      }
      // a wall-mounted patch panel by the racks, blinking
      box(lm, WALL_T / 2, vB - 0.5, WALL_T / 2 + 0.12, vB + 0.5, 1.2, 1.9, Mat.METAL_PAINTED);
      for (let y = 1.3; y < 1.85; y += 0.1) {
        const [x, z] = lm.f.point(WALL_T / 2 + 0.121, vB - 0.4);
        const [nx, nz] = lm.f.dir(1, 0);
        for (let i = 0; i < 6; i++) {
          const [px, pz] = [x + lm.f.dir(0, 1)[0] * i * 0.12, z + lm.f.dir(0, 1)[1] * i * 0.12];
          if (lm.rng.chance(0.6)) g.addDecal({ kind: SignKind.BLANK, sign: true, px, py: y, pz, nx, ny: 0, nz, rot: 0, w: 0.012, h: 0.008, alpha: 1, emit: Math.round(lm.rng.range(60, 200)), color: lm.rng.chance(0.2) ? LED_AMBER : LED_GREEN });
        }
      }
    }

    // cold 5000 K battens over the three aisles (one of them flickering)
    const cold = kelvinToLinearRGB(5000, 0.02);
    const aisles = [WALL_T / 2 + (vA - RD / 2 - WALL_T / 2) / 2, (vA + vB) / 2, vB + RD / 2 + (S * CELL - WALL_T / 2 - vB - RD / 2) / 2];
    const flick = lm.rng.chance(0.4) ? lm.rng.int(0, 5) : -1;
    let k = 0;
    for (const vm of aisles) {
      for (const um of [S * CELL * 0.3, S * CELL * 0.7]) {
        const st = k === flick ? LightState.FLICKER : LightState.ON;
        if (closet) troffer(lm, Math.round((um - 0.3) / 0.6) * 0.6, Math.round((vm - 0.6) / 0.6) * 0.6, CEIL, cold, 3300, k === 1 ? LightState.OFF : st, true);
        else fixture(lm, FixtureKind.TUBE_STRIP, um, vm, CEIL - 0.05, DOWN, [1, 0], cold, 8600, st, { hum: 0.5 });
        k++;
      }
    }
    if (closet) ageCeiling(lm, 0.15, 0.03, 0.02);
    // the fan roar, a desk with a CRT by the door, cable scuffs on the floor
    emitter(lm, EmitterKind.MACHINE, (S * CELL) / 2, (vA + vB) / 2, 1.2, 0.7);
    const deskU = door < S / 2 ? S * CELL - 1.2 : 1.2;
    const deskV = WALL_T / 2 + 0.01 + PROP_DEFS[PropKind.DESK].size[2] / 2;
    prop(lm, PropKind.DESK, deskU, deskV, 0, 0, 1, lm.rng.int(0, 3));
    prop(lm, PropKind.CRT_MONITOR, deskU + lm.rng.range(-0.3, 0.3), deskV - 0.05, 0.75, 0, 1, 0, undefined, lm.rng.range(-0.2, 0.2));
    prop(lm, PropKind.OFFICE_CHAIR, deskU, deskV + 0.75, 0, 0, -1, lm.rng.int(0, 3), undefined, lm.rng.range(-0.5, 0.5));
    for (let i = 0; i < 3; i++) {
      floorDecal(lm, lm.rng.range(1.5, S * CELL - 1.5), (vA + vB) / 2 + lm.rng.range(-0.5, 0.5), 0,
        { kind: DecalKind.SCUFF, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.5, alpha: 0.4 });
    }
    return { entrances: lm.entrances };
  },
};
