// src/core/zones.ts — structural zone metadata shared across WPs. Palettes/lighting/props live in each
// ZoneGenerator (WP2/WP3); atmosphere (fog/exposure/grade) in lighting/atmospheres.ts (WP11);
// acoustics in audio/zoneAudio.ts (WP13). WP1 may edit STRATA_WEIGHTS numbers via contract-changes/WP1.md.

import { LIGHT } from './constants.ts';
import { LandmarkKind, SeamMode, type SeamModeId, type StoreyId, Zone, type ZoneId } from './ids.ts';

export interface ZoneInfo {
  id: ZoneId;
  name: string;
  seamMode: SeamModeId; // for same-district seams (different districts are always BOUNDARY)
  open: boolean; // long sightlines; bake uses LIGHT.R_OPEN
  lightR: number; // bake window radius (m)
  baseZone: ZoneId; // generator that implements it (MANILA/DARK -> LOBBY)
}

const zi = (id: ZoneId, name: string, seamMode: SeamModeId, open: boolean, baseZone: ZoneId): ZoneInfo =>
  ({ id, name, seamMode, open, lightR: open ? LIGHT.R_OPEN : LIGHT.R_STATIC, baseZone });

export const ZONE_INFO: readonly ZoneInfo[] = [
  zi(Zone.LOBBY, 'LOBBY', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.MANILA, 'MANILA', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.DARK, 'DARK', SeamMode.PATTERN, false, Zone.LOBBY),
  zi(Zone.MAZE, 'MAZE', SeamMode.PATTERN, false, Zone.MAZE),
  zi(Zone.LOW_EXPANSE, 'LOW_EXPANSE', SeamMode.GLOBAL, true, Zone.LOW_EXPANSE),
  zi(Zone.PILLAR_HALL, 'PILLAR_HALL', SeamMode.GLOBAL, true, Zone.PILLAR_HALL),
  zi(Zone.OFFICE, 'OFFICE', SeamMode.GLOBAL, false, Zone.OFFICE),
  zi(Zone.POOLROOMS, 'POOLROOMS', SeamMode.GLOBAL, true, Zone.POOLROOMS),
  zi(Zone.PARKING, 'PARKING', SeamMode.GLOBAL, true, Zone.PARKING),
  zi(Zone.PIPEWORKS, 'PIPEWORKS', SeamMode.PATTERN, false, Zone.PIPEWORKS),
  zi(Zone.WAREHOUSE, 'WAREHOUSE', SeamMode.GLOBAL, true, Zone.WAREHOUSE),
  zi(Zone.CONCRETE, 'CONCRETE', SeamMode.PATTERN, false, Zone.CONCRETE),
];

/** Per-storey zone weights (index = ZoneId). Storey 0 district nearest the origin is forced LOBBY;
 * the next 4 nearest sites get a seed-permutation of [PILLAR_HALL, LOW_EXPANSE, DARK, OFFICE]. */
export const STRATA_WEIGHTS: Readonly<Record<StoreyId, readonly number[]>> = {
  //   LOBBY MANILA DARK MAZE LOWEXP PILLAR OFFICE POOLS PARKING PIPES WAREHOUSE CONCRETE
  0: [40, 6, 10, 10, 10, 10, 12, 2, 0, 0, 0, 0],
  1: [8, 0, 8, 10, 0, 0, 0, 0, 26, 18, 14, 16],
  2: [0, 4, 0, 0, 10, 14, 0, 60, 0, 4, 0, 8], // R2 (B4): + a pipeworks / concrete service stratum
};
export const ONBOARDING_ZONES: readonly ZoneId[] = [Zone.PILLAR_HALL, Zone.LOW_EXPANSE, Zone.DARK, Zone.OFFICE];
export const MOOD_WEIGHTS: readonly number[] = [72, 14, 8, 6]; // NORMAL SPARSE DYING DARK (DARK zone forces DARK)
export const MOOD_POWER_MUL: readonly number[] = [1.0, 0.75, 0.6, 0.3];

/** cellZone of every TOWER / ELEVATOR cell in every storey (mood there is always NORMAL): atmosphere, ambience and
 * audio follow cellZone (WorldQuery.zoneAt/moodAt), so nothing crossfades at a storey switch. */
export const STRUCTURE_ZONE: ZoneId = Zone.CONCRETE;
/** Optional per-landmark bake window radius (m) for lights inside the landmark's cells; 0 = default rule. */
export const LANDMARK_LIGHT_R: Readonly<Partial<Record<number, number>>> = {
  [LandmarkKind.ATRIUM]: 20, [LandmarkKind.SKYLIGHT_HALL]: 16, [LandmarkKind.CHAIR_CATHEDRAL]: 14,
  // R2 (B4): tall new kinds
  [LandmarkKind.LIGHT_WELL]: 18, [LandmarkKind.SLIDE_TOWER]: 18, [LandmarkKind.TALL_ROOM]: 12, [LandmarkKind.CHAPEL]: 12,
  [LandmarkKind.CRANE_BAY]: 14, [LandmarkKind.MEZZANINE_OFFICE]: 12, [LandmarkKind.LAZY_RIVER]: 12, [LandmarkKind.DRAINED_POOL]: 12,
};
