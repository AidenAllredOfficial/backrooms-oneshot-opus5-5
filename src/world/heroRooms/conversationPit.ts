// src/world/heroRooms/conversationPit.ts — CONVERSATION_PIT hero (Level 0 family, offices; 10x10, R2 B4): a 1970s
// sunken lounge in the middle of an office floor. Three carpeted steps lead down 45 cm into a square pit lined with
// built-in upholstered benches around a low wooden table (a telephone, papers); a warm linear pendant hangs over it
// while the ceiling grid around is half dead.
//
// Frame: u across, v along (10 x 10 cells). Pit: cells [3, 7)^2 at -45; steps in cells (4..6, 3) up toward -v.

import { CELL } from '../../core/constants.ts';
import { DecalKind, EdgeKind, EdgeTrim, EmitterKind, FixtureKind, LandmarkKind, LightState, Mat, PropKind, Storey, Zone } from '../../core/index.ts';
import type { LightStateId, ZoneId } from '../../core/index.ts';
import { kelvinToLinearRGB } from '../content/kelvin.ts';
import { ageCeiling, begin, box, cells, claim, DOWN, emitter, fixture, floorDecal, opening, prop, ramp, SOLID_F, storeyStyle, THIN_F, troffer } from '../landmarks/common.ts';
import type { LandmarkGenerator } from '../landmarks/index.ts';

const S = 10;
const CEIL = 2.8;
export const CONVERSATION_PIT = { pit: [3, 7] as const, depthCm: -45, steps: [4, 6] as const } as const;

export const conversationPit: LandmarkGenerator = {
  kind: LandmarkKind.CONVERSATION_PIT, storeys: [Storey.LOBBY, Storey.SUBLEVEL], weight: 1, footprint: [S, S], heroOnly: true,
  hero: [Zone.LOBBY, Zone.OFFICE, Zone.LOW_EXPANSE, Zone.PILLAR_HALL] as readonly ZoneId[],
  stamp(g, ctx, site) {
    const lm = begin(g, ctx, site, S, S);
    if (!lm) return { entrances: [] };
    const s = ctx.key.s;
    const deep = s === Storey.SUBLEVEL;
    const st = storeyStyle(s, CEIL * 100, deep ? { floorMat: Mat.VINYL_VCT } : {});
    claim(lm, st);
    const trim = deep ? 0 : EdgeTrim.BASEBOARD;
    for (const u of [4, 5]) opening(lm, u, 0, 0, -1, EdgeKind.HEADER, st.wallMat, trim, 225);
    opening(lm, 0, lm.rng.int(3, 6), -1, 0, EdgeKind.DOORWAY, st.wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, S - 1, lm.rng.int(3, 6), 1, 0, EdgeKind.DOORWAY, st.wallMat, deep ? 0 : EdgeTrim.CASING, 210);
    opening(lm, lm.rng.int(3, 6), S - 1, 0, 1, EdgeKind.HEADER, st.wallMat, trim, 225);

    const P = CONVERSATION_PIT;
    const [p0, p1] = P.pit;
    const d = P.depthCm / 100;
    cells(lm, p0, p0, p1, p1, { floorCm: P.depthCm, floorMat: Mat.CARPET_OFFICE });
    const [s0, s1] = P.steps;
    ramp(lm, s0 * CELL, p0 * CELL, s1 * CELL, (p0 + 1) * CELL, 0, -1, d, 0, 3, Mat.CARPET_OFFICE, true);
    // built-in benches along the pit walls (upholstered), leaving the steps free
    const A = p0 * CELL, B = p1 * CELL;
    const seat = d + 0.42, dep = 0.6;
    const uph = Mat.FABRIC_PARTITION;
    box(lm, A, B - dep, B, B, d, seat, uph, SOLID_F); // far side
    box(lm, A, A + dep, A + dep, B - dep, d, seat, uph, SOLID_F); // left
    box(lm, B - dep, A + dep, B, B - dep, d, seat, uph, SOLID_F); // right
    box(lm, A, A, s0 * CELL, A + dep, d, seat, uph, SOLID_F); // near side, left of the steps
    box(lm, s1 * CELL, A, B, A + dep, d, seat, uph, SOLID_F); // near side, right of the steps
    // padded backs rising above the rim (a soft lip around the pit)
    box(lm, A, B - 0.14, B, B, seat, 0.28, uph, THIN_F);
    box(lm, A, A, A + 0.14, B, seat, 0.28, uph, THIN_F);
    box(lm, B - 0.14, A, B, B, seat, 0.28, uph, THIN_F);
    // the table, a phone, papers, a mug ring
    const c = ((p0 + p1) / 2) * CELL;
    box(lm, c - 0.7, c - 0.5, c + 0.7, c + 0.5, d, d + 0.36, Mat.WOOD, SOLID_F);
    prop(lm, PropKind.PHONE, c + 0.3, c - 0.1, d + 0.36, 0, -1, 0, undefined, lm.rng.range(-0.5, 0.5));
    floorDecal(lm, c - 0.25, c + 0.1, d + 0.362, { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(0, 6.28), w: 0.3, h: 0.22, alpha: 0.95 });
    floorDecal(lm, c - 0.1, c - 0.2, d + 0.362, { kind: DecalKind.PAPER, sign: false, rot: lm.rng.range(0, 6.28), w: 0.3, h: 0.22, alpha: 0.95 });
    floorDecal(lm, c + lm.rng.range(-1, 1), c + lm.rng.range(0.7, 1.2), d + 0.003, { kind: DecalKind.WATER_STAIN, sign: false, rot: lm.rng.range(0, 6.28), w: 1.0, h: 0.8, alpha: 0.4 });
    // the warm pendant over the pit; the ceiling grid around, half dead
    fixture(lm, FixtureKind.PENDANT_LINEAR, c, c, 2.05, DOWN, [1, 0], kelvinToLinearRGB(2700, 0), 3800, LightState.ON, { hum: 0.3 });
    const col = kelvinToLinearRGB(4100, 0.035);
    for (const [u, v] of [[1, 1], [7, 1], [1, 7], [7, 7], [1, 4], [8, 4], [4, 8]] as [number, number][]) {
      const r = lm.rng.float();
      const stt: LightStateId = r < 0.45 ? LightState.OFF : r < 0.6 ? LightState.DYING : LightState.ON;
      troffer(lm, u * CELL + 0.3, v * CELL, CEIL, col, 3300, stt);
    }
    if (!deep) ageCeiling(lm, 0.16, 0.04, 0.02);
    // a potted-plant stand that lost its plant, an ashtray stand by the steps
    box(lm, 0.4, S * CELL - 0.9, 0.9, S * CELL - 0.4, 0, 0.55, Mat.PLASTIC, SOLID_F);
    box(lm, s1 * CELL + 0.4, A - 0.5, s1 * CELL + 0.55, A - 0.35, 0, 0.62, Mat.METAL_PAINTED, THIN_F);
    emitter(lm, EmitterKind.BUZZ, c, c, 2.2, 0.15);
    return { entrances: lm.entrances };
  },
};
