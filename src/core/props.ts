// src/core/props.ts — prop footprint table shared by placement (WP4), geometry (WP6), collision (WP12),
// the baker (occluders, WP7) and audio. Geometry built by WP6 MUST fit inside `size` (tested).
// Local frame: origin at the base centre, +Y up, FRONT faces -Z at yaw 0. size = [x, y, z] metres.

import type { PropKindId } from './ids.ts';

export interface PropDef {
  kind: PropKindId;
  name: string;
  size: readonly [number, number, number];
  collide: boolean; // player collision AABB (rotated footprint, yaw snapped to 90deg for collision)
  occlude: boolean; // whole-footprint light-bake occluder box (large props; yaw snapped to 90deg), unless the kind
                    // has PROP_OCCLUDERS part boxes (desk tops, seats, car bodies, rack decks, ...), which take precedence
  wallMounted: boolean; // back (+Z face) touches the wall
  maxTris: number;
}

const P = (kind: number, name: string, x: number, y: number, z: number, collide: boolean, occlude: boolean, wallMounted: boolean, maxTris: number): PropDef =>
  ({ kind: kind as PropKindId, name, size: [x, y, z], collide, occlude, wallMounted, maxTris });

export const PROP_DEFS: readonly PropDef[] = [
  P(0, 'CHAIR_STACKING', 0.5, 0.82, 0.52, true, false, false, 400),
  P(1, 'OFFICE_CHAIR', 0.62, 1.05, 0.62, true, false, false, 900),
  P(2, 'DESK', 1.5, 0.75, 0.75, true, false, false, 400),
  P(3, 'FILING_CABINET', 0.47, 1.33, 0.62, true, true, true, 300),
  P(4, 'CRT_MONITOR', 0.4, 0.38, 0.42, false, false, false, 400),
  P(5, 'WATER_COOLER', 0.32, 1.3, 0.32, true, false, true, 500),
  P(6, 'VENDING_MACHINE', 0.9, 1.83, 0.8, true, true, true, 600),
  P(7, 'CONFERENCE_TABLE', 3.0, 0.75, 1.2, true, false, false, 300),
  P(8, 'CRATE', 1.0, 0.8, 1.0, true, true, false, 200),
  P(9, 'PALLET', 1.2, 0.15, 1.0, true, false, false, 300),
  P(10, 'SHELF_RACK', 2.4, 4.2, 1.1, true, true, false, 1500),
  P(11, 'TRASH_CAN', 0.4, 0.6, 0.4, true, false, false, 200),
  P(12, 'CONE', 0.36, 0.7, 0.36, true, false, false, 150),
  P(13, 'WET_FLOOR_SIGN', 0.3, 0.62, 0.35, true, false, false, 120),
  P(14, 'WHEEL_STOP', 1.8, 0.12, 0.18, false, false, false, 60),
  P(15, 'CAR_SEDAN', 1.8, 1.45, 4.6, true, true, false, 2500),
  P(16, 'POOL_LADDER', 0.6, 1.9, 0.5, false, false, true, 600),
  P(17, 'LOUNGE_CHAIR', 0.65, 0.9, 1.9, true, false, false, 600),
  P(18, 'LIFEBUOY', 0.6, 0.6, 0.12, false, false, true, 400),
  P(19, 'BENCH_TILED', 2.4, 0.45, 0.6, true, false, false, 60),
  P(20, 'MATTRESS', 0.9, 0.2, 1.9, false, false, false, 200),
  P(21, 'PHONE', 0.22, 0.12, 0.2, false, false, false, 300),
  P(22, 'RADIO', 0.35, 0.2, 0.12, false, false, false, 300),
  P(23, 'BACKPACK', 0.35, 0.5, 0.25, false, false, false, 400),
  P(24, 'DOOR_FRAME', 1.1, 2.2, 0.15, true, false, false, 120),
  P(25, 'DOOR_LEAF', 0.9, 2.08, 0.045, true, false, false, 120),
  P(26, 'ELEVATOR_DOOR', 1.0, 2.2, 0.05, true, false, false, 60),
  P(27, 'VENT_GRILLE', 0.6, 0.3, 0.05, false, false, true, 200),
  P(28, 'OUTLET', 0.07, 0.12, 0.02, false, false, true, 60),
  P(29, 'THERMOSTAT', 0.1, 0.12, 0.03, false, false, true, 60),
  P(30, 'EXTINGUISHER', 0.5, 0.8, 0.25, false, false, true, 400),
  P(31, 'PIPE_VALVE', 0.3, 0.3, 0.3, false, false, false, 300),
  P(32, 'BOILER', 1.6, 2.2, 1.6, true, true, false, 1200),
  P(33, 'TANK', 1.2, 2.4, 1.2, true, true, false, 800),
  P(34, 'HANDRAIL', 1.2, 1.0, 0.08, false, false, true, 200),
  P(35, 'CEILING_DEBRIS', 1.2, 0.1, 1.2, false, false, false, 300),
  P(36, 'TILE_FRAGMENT', 0.6, 0.02, 0.6, false, false, false, 40),
  P(37, 'BOTTLE', 0.08, 0.3, 0.08, false, false, false, 120),
  P(38, 'SLEEPING_BAG', 0.8, 0.12, 2.0, false, false, false, 200),
  P(39, 'BUCKET', 0.32, 0.35, 0.32, true, false, false, 200),
  P(40, 'MOP', 0.3, 1.3, 0.3, false, false, false, 150),
  P(41, 'CARDBOARD_BOX', 0.5, 0.4, 0.4, true, false, false, 60),
  P(42, 'FLOAT_ROPE', 1.2, 0.12, 0.12, false, false, false, 300), // lane rope + floats across a cell edge at water level
  P(43, 'POOL_FLOAT', 1.1, 0.25, 0.6, false, false, false, 400), // inflatable ring/lounger, floats at water y
  P(44, 'TOWEL', 0.6, 0.03, 1.4, false, false, false, 120),
];

export type Box6 = readonly [number, number, number, number, number, number]; // x0,y0,z0,x1,y1,z1, prop-local metres
/** Part occluder boxes (prop-local frame, yaw snapped to 90deg) for the WP7 VisGrid, light volume, AO and the
 * near-field gather, keyed by PropKind. A part list takes precedence over `occlude` (and the OCCLUDE flag): only
 * props without one (crates, vending machines, boilers, tanks, filing cabinets, landmark racks) are baked as a
 * whole-footprint box. Boxes follow the props/ meshes (tested to lie inside `size`); thin or perforated details
 * (chair columns and star bases, rack bracing, wire mesh) are left out. */
export const PROP_OCCLUDERS: Readonly<Partial<Record<number, readonly Box6[]>>> = {
  0: [[-0.235, 0.43, -0.245, 0.235, 0.462, 0.222]], // CHAIR_STACKING seat (back: PROP_OCCLUDERS_ALIGNED)
  1: [[-0.245, 0.42, -0.25, 0.245, 0.5, 0.24]], // OFFICE_CHAIR seat
  2: [ // DESK top, modesty panel, side panels
    [-0.75, 0.72, -0.375, 0.75, 0.75, 0.375], [-0.71, 0.3, 0.3, 0.71, 0.72, 0.33],
    [-0.74, 0, -0.35, -0.71, 0.72, 0.35], [0.71, 0, -0.35, 0.74, 0.72, 0.35],
  ],
  4: [[-0.2, 0.06, -0.194, 0.2, 0.38, 0.18]], // CRT_MONITOR housing (the stand is a 13 cm disc)
  5: [[-0.16, 0, -0.16, 0.16, 1.3, 0.16]], // WATER_COOLER
  7: [ // CONFERENCE_TABLE top + the two pedestal legs
    [-1.5, 0.72, -0.6, 1.5, 0.75, 0.6], [-0.9, 0, -0.28, -0.8, 0.71, 0.28], [0.8, 0, -0.28, 0.9, 0.71, 0.28],
  ],
  9: [[-0.6, 0.1, -0.5, 0.6, 0.145, 0.5]], // PALLET deck (top boards on the stringers)
  10: [ // SHELF_RACK: 4 C-channel uprights and the 3 wire decks with their step beams (props/industrial.ts)
    [-1.2, 0, -0.535, -1.12, 4.2, -0.465], [-1.2, 0, 0.465, -1.12, 4.2, 0.535],
    [1.12, 0, -0.535, 1.2, 4.2, -0.465], [1.12, 0, 0.465, 1.2, 4.2, 0.535],
    [-1.12, 1.17, -0.525, 1.12, 1.204, 0.525], [-1.12, 2.37, -0.525, 1.12, 2.404, 0.525],
    [-1.12, 3.57, -0.525, 1.12, 3.604, 0.525],
  ],
  11: [[-0.2, 0, -0.2, 0.2, 0.6, 0.2]], // TRASH_CAN
  15: [ // CAR_SEDAN (props/car.ts, half width 0.82): lower body above the sills, cabin, underbody, 4 wheels
    [-0.82, 0.24, -2.28, 0.82, 0.8, 2.28], [-0.73, 0.8, -0.65, 0.73, 1.41, 1.18], [-0.57, 0.14, -1.8, 0.57, 0.25, 1.8],
    [0.615, 0, 1.045, 0.825, 0.63, 1.675], [-0.825, 0, 1.045, -0.615, 0.63, 1.675],
    [0.615, 0, -1.675, 0.825, 0.63, -1.045], [-0.825, 0, -1.675, -0.615, 0.63, -1.045],
  ],
  17: [[-0.325, 0.3, -0.95, 0.325, 0.36, 0.95]], // LOUNGE_CHAIR frame
  19: [[-1.2, 0, -0.3, 1.2, 0.45, 0.3]], // BENCH_TILED
  20: [[-0.45, 0, -0.95, 0.45, 0.2, 0.95]], // MATTRESS
  23: [[-0.15, 0, -0.1, 0.15, 0.46, 0.09]], // BACKPACK
  39: [[-0.155, 0, -0.155, 0.155, 0.345, 0.155]], // BUCKET
  41: [[-0.248, 0, -0.198, 0.248, 0.398, 0.198]], // CARDBOARD_BOX (closed)
};
/** Per-variant replacements of a PROP_OCCLUDERS list (variants whose shape differs from the base list). */
export const PROP_OCCLUDER_VARIANTS: Readonly<Partial<Record<number, Readonly<Partial<Record<number, readonly Box6[]>>>>>> = {
  2: { // DESK variants 1 and 3: drawer pedestal on the right
    1: [...PROP_OCCLUDERS[2]!, [0.3, 0.05, -0.345, 0.71, 0.7, 0.3]],
    3: [...PROP_OCCLUDERS[2]!, [0.3, 0.05, -0.345, 0.71, 0.7, 0.3]],
  },
  10: { // SHELF_RACK variant 2 (collapsed): only the -x end frame still stands; its beams, decks and loads hang or
    // lie at random angles
    2: [[-1.2, 0, -0.535, -1.12, 4.2, -0.465], [-1.2, 0, 0.465, -1.12, 4.2, 0.535]],
  },
  15: { // CAR_SEDAN variant 3: compact body (half width 0.74), driver door swung open about its front edge
    3: [
      [-0.74, 0.24, -2.28, 0.74, 0.8, 2.28], [-0.65, 0.8, -0.65, 0.65, 1.41, 1.18], [-0.49, 0.14, -1.8, 0.49, 0.25, 1.8],
      [0.535, 0, 1.045, 0.745, 0.63, 1.675], [-0.745, 0, 1.045, -0.535, 0.63, 1.675],
      [0.535, 0, -1.675, 0.745, 0.63, -1.045], [-0.745, 0, -1.675, -0.535, 0.63, -1.045],
      [-0.9, 0.24, -0.95, -0.74, 0.8, 0.1],
    ],
  },
  41: { 1: [[-0.2, 0, -0.15, 0.2, 0.3, 0.15]], 3: [[-0.25, 0, -0.2, 0.25, 0.31, 0.2]] }, // CARDBOARD_BOX open / crushed
};
/** Thin parts set off the prop's centre (chair backs): added only when the yaw is within OCC_ALIGN_TOL of a quarter
 * turn, since the 90-degree snap would otherwise put the box beside the mesh. */
export const PROP_OCCLUDERS_ALIGNED: Readonly<Partial<Record<number, readonly Box6[]>>> = {
  0: [[-0.212, 0.565, 0.195, 0.212, 0.795, 0.25]], // CHAIR_STACKING back
  1: [[-0.22, 0.52, 0.17, 0.22, 1.04, 0.3]], // OFFICE_CHAIR back
};
export const OCC_ALIGN_TOL = 0.2;
/** The part list of a placed prop (variant replacement, else the kind's list), undefined if it has none. */
export const propOccluders = (kind: number, variant: number): readonly Box6[] | undefined =>
  PROP_OCCLUDER_VARIANTS[kind]?.[variant] ?? PROP_OCCLUDERS[kind];
/** Kinds that meet the floor with a round base (a swivel chair's star base under its seat, lathe-turned bins): their
 * analytic contact AO (bake/ao.ts) is a disc darkest under the centre, not the footprint rectangle's flat square. */
export const PROP_ROUND_CONTACT: ReadonlySet<number> = new Set([1 /* OFFICE_CHAIR */, 11 /* TRASH_CAN */, 39 /* BUCKET */]);
/** Is a yaw (radians) within OCC_ALIGN_TOL of a multiple of 90 degrees? */
export function quarterAligned(yaw: number): boolean {
  const q = Math.PI / 2;
  return Math.abs(yaw - Math.round(yaw / q) * q) < OCC_ALIGN_TOL;
}
/** Props that respond to the interact key (WP12 targets them, WP13 plays their sound). */
export const INTERACTABLE_PROPS: readonly PropKindId[] = [25 /* DOOR_LEAF */, 21 /* PHONE */, 22 /* RADIO */] as PropKindId[];
