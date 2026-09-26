// src/audio/zoneAudio.ts — per-zone acoustics: ambience beds, ambient-event family, reverb return EQ, footstep
// fallback surface for "not your footsteps". Keyed by WorldQuery.zoneAt (cellZone: towers/elevators are CONCRETE).

import { Mood, SurfaceSound, Zone, type MoodId, type SurfaceSoundId, type ZoneId } from '../core/ids.ts';
import type { BedKind } from './dsp/beds.ts';
import type { OneShotKind } from './dsp/oneshots.ts';

export type EventFamily = 'L0' | 'industrial' | 'pools';

export interface BedLayer { kind: BedKind; dbfs: number } // target RMS level at the listener (dBFS)
export interface ZoneAudioDef {
  beds: readonly BedLayer[];
  family: EventFamily;
  eqLowDb: number; // reverb return shelves
  eqHighDb: number;
  stepSurface: SurfaceSoundId; // surface of phantom footsteps in this zone
}

const hvac = (db: number): BedLayer => ({ kind: 'hvac', dbfs: db });

export const ZONE_AUDIO: readonly ZoneAudioDef[] = [
  /* LOBBY */ { beds: [hvac(-37)], family: 'L0', eqLowDb: 0, eqHighDb: -3, stepSurface: SurfaceSound.CARPET },
  /* MANILA */ { beds: [hvac(-37)], family: 'L0', eqLowDb: 0, eqHighDb: -3, stepSurface: SurfaceSound.CARPET },
  /* DARK */ { beds: [hvac(-47)], family: 'L0', eqLowDb: 1, eqHighDb: -4, stepSurface: SurfaceSound.CARPET },
  /* MAZE */ { beds: [hvac(-38)], family: 'L0', eqLowDb: 0, eqHighDb: -3, stepSurface: SurfaceSound.CARPET },
  /* LOW_EXPANSE */ { beds: [hvac(-36)], family: 'L0', eqLowDb: 1, eqHighDb: -2, stepSurface: SurfaceSound.CARPET },
  /* PILLAR_HALL */ { beds: [hvac(-36)], family: 'L0', eqLowDb: 1, eqHighDb: -1, stepSurface: SurfaceSound.CARPET },
  /* OFFICE */ { beds: [{ kind: 'officeHvac', dbfs: -39 }], family: 'L0', eqLowDb: 0, eqHighDb: -4, stepSurface: SurfaceSound.CARPET },
  /* POOLROOMS */ { beds: [{ kind: 'water', dbfs: -33 }], family: 'pools', eqLowDb: -2, eqHighDb: 2, stepSurface: SurfaceSound.TILE },
  /* PARKING */ { beds: [{ kind: 'fanDrone', dbfs: -37 }], family: 'industrial', eqLowDb: 1, eqHighDb: 0, stepSurface: SurfaceSound.CONCRETE },
  /* PIPEWORKS */ { beds: [{ kind: 'pump', dbfs: -37 }, { kind: 'drone', dbfs: -43 }], family: 'industrial', eqLowDb: 2, eqHighDb: -1, stepSurface: SurfaceSound.CONCRETE },
  /* WAREHOUSE */ { beds: [{ kind: 'roofCreaks', dbfs: -38 }, { kind: 'fanDrone', dbfs: -41 }], family: 'industrial', eqLowDb: 2, eqHighDb: -1, stepSurface: SurfaceSound.CONCRETE },
  /* CONCRETE */ { beds: [{ kind: 'drone', dbfs: -39 }, { kind: 'pump', dbfs: -47 }], family: 'industrial', eqLowDb: 1, eqHighDb: 0, stepSurface: SurfaceSound.CONCRETE },
];

export const zoneAudio = (z: ZoneId): ZoneAudioDef => ZONE_AUDIO[z] ?? ZONE_AUDIO[Zone.LOBBY];

/** Extra bed attenuation by mood (dying / dark sectors are quieter; the hum bed follows the lights anyway). */
export const moodBedDb = (m: MoodId): number => (m === Mood.DARK ? -5 : m === Mood.DYING ? -2 : 0);

/** Room tone level (dBFS RMS): what remains when everything else falls silent. */
export const ROOM_TONE_DBFS = -42;

export interface EventTable { rate: number; kinds: readonly OneShotKind[]; weights: readonly number[] }
/** Poisson ambient events (§5 WP13): rate per second, kinds and weights. */
export const EVENT_TABLE: Readonly<Record<EventFamily, EventTable>> = {
  L0: { rate: 1 / 40, kinds: ['doorThud', 'chairScrape', 'tileCreak', 'ballastPop', 'damperClunk'], weights: [3, 2, 3, 2, 3] },
  industrial: { rate: 1 / 25, kinds: ['pipeKnock', 'metalGroan', 'pumpCycle', 'chainRattle'], weights: [4, 2, 3, 1] },
  pools: { rate: 1 / 20, kinds: ['dripPlink', 'drainGurgle', 'filterPump'], weights: [4, 2, 2] },
};
export const EVENT_MIN_GAP = 15;
export const EVENT_MIN_DIST = 25;
export const EVENT_MAX_DIST = 60;
/** Ambient event peak at the listener (dBFS) before occlusion losses. */
export const EVENT_PEAK_DBFS = -18;
/** Source height (m above storey datum) per ambient kind: overhead sounds come from the ceiling. */
export const EVENT_HEIGHT: Readonly<Partial<Record<OneShotKind, number>>> = {
  tileCreak: 2.6, ballastPop: 2.6, damperClunk: 2.7, pipeKnock: 2.4, chainRattle: 2.2, metalGroan: 2.8,
  doorThud: 1.0, chairScrape: 0.4, dripPlink: 0.2, drainGurgle: 0.1, filterPump: 0.5, pumpCycle: 0.8,
};
