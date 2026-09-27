// src/app/settingsStore.ts (WP14) — persisted Settings (localStorage 'backrooms.settings.v1'): validate + clamp + migrate.
//
// The store keeps ONE Settings object for the app's lifetime and updates it in place (nested groups are replaced by
// fresh objects), so systems that captured the object at construction (input toggles, head bob) read live values.
// Subscribers are called after every accepted change with that same object.

import { DEFAULT_SETTINGS } from '../core/settings.ts';
import type { FlickerMode, Settings, WalkSpeed } from '../core/settings.ts';
import type { QualityConfig, QualityName } from '../core/quality.ts';

export interface SettingsStore { get(): Settings; set(patch: Partial<Settings>): void; subscribe(fn: (s: Settings) => void): () => void }

export const SETTINGS_KEY = 'backrooms.settings.v1';

/** Clamping ranges (also used by the settings panel for its sliders). */
export const SETTINGS_RANGES = {
  fov: [50, 90],
  mouseSensitivity: [0.0003, 0.008],
  headBob: [0, 1],
  cameraShake: [0, 1],
  brightnessEV: [-1, 1],
  volume: [0, 1],
  film: [0, 1],
  renderScale: [0.5, 2],
  streamRadius: [1, 4],
  maxDpr: [0.5, 3],
  propDistance: [10, 120],
} as const;

const QUALITY_VALUES: readonly (QualityName | 'auto')[] = ['low', 'medium', 'high', 'ultra', 'auto'];
const FLICKER_VALUES: readonly FlickerMode[] = ['standard', 'reduced', 'off'];
const WALK_VALUES: readonly WalkSpeed[] = ['slow', 'normal', 'brisk'];
/** The pre-R2 mouse sensitivity default. A stored value equal to it in settings written before R2 (no cameraShake
 * key) was almost certainly never chosen: it migrates to the new default instead of staying twitchy. */
export const OLD_DEFAULT_SENSITIVITY = 0.0022;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const numIn = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return n < lo ? lo : n > hi ? hi : n;
};
const boolOr = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : v === 1 || v === 'true' ? true : v === 0 || v === 'false' ? false : d);
const oneOf = <T>(v: unknown, values: readonly T[], d: T): T => (values.includes(v as T) ? (v as T) : d);

function freshDefaults(): Settings {
  const d = DEFAULT_SETTINGS;
  return { ...d, overrides: { ...d.overrides }, volume: { ...d.volume }, film: { ...d.film } };
}

/**
 * Pre-release (unversioned, "v0") settings used flat names:
 *   { sensitivity, fov, volume: number, musicVolume?, reducedFlicker: boolean, bob: boolean | number,
 *     grain: number, vignette: number, quality, seed }
 * They are mapped onto the v1 schema, then validated like any v1 object.
 */
export function migrateSettings(raw: Obj): Obj {
  const v = raw.version;
  if (v === 1) return migrateR2(raw);
  if (typeof v === 'number' && v > 1) return { ...raw, version: 1 }; // newer build wrote it: keep what we understand
  const out: Obj = { ...raw, version: 1 };
  if (raw.sensitivity !== undefined && raw.mouseSensitivity === undefined) out.mouseSensitivity = raw.sensitivity;
  if (typeof raw.volume === 'number') out.volume = { master: raw.volume };
  if (typeof raw.reducedFlicker === 'boolean' && raw.flicker === undefined) out.flicker = raw.reducedFlicker ? 'reduced' : 'standard';
  if (raw.bob !== undefined && raw.headBob === undefined) out.headBob = typeof raw.bob === 'boolean' ? (raw.bob ? 1 : 0) : raw.bob;
  if ((raw.grain !== undefined || raw.vignette !== undefined) && !isObj(raw.film)) {
    out.film = { grain: raw.grain, vignette: raw.vignette };
  }
  if (typeof raw.seed === 'string' && raw.lastSeed === undefined) out.lastSeed = raw.seed;
  delete out.sensitivity; delete out.reducedFlicker; delete out.bob; delete out.grain; delete out.vignette; delete out.seed;
  return migrateR2(out);
}

/** R2 (B7): settings written before cameraShake / walkSpeed existed keep every value except an untouched old
 * sensitivity default (0.0022 -> the new default). */
function migrateR2(raw: Obj): Obj {
  if (raw.cameraShake !== undefined || raw.walkSpeed !== undefined) return raw;
  const n = typeof raw.mouseSensitivity === 'number' ? raw.mouseSensitivity : typeof raw.mouseSensitivity === 'string' ? Number(raw.mouseSensitivity) : NaN;
  if (Math.abs(n - OLD_DEFAULT_SENSITIVITY) < 1e-9) return { ...raw, mouseSensitivity: DEFAULT_SETTINGS.mouseSensitivity };
  return raw;
}

/** Only the QualityConfig fields a user may override (the settings panel writes renderScale/dynamicResolution). */
function validateOverrides(raw: unknown): Partial<QualityConfig> {
  const o: Partial<QualityConfig> = {};
  if (!isObj(raw)) return o;
  const R = SETTINGS_RANGES;
  if (raw.renderScale !== undefined) o.renderScale = numIn(raw.renderScale, R.renderScale[0], R.renderScale[1], 1);
  if (typeof raw.dynamicResolution === 'boolean') o.dynamicResolution = raw.dynamicResolution;
  if (raw.streamRadius !== undefined) o.streamRadius = Math.round(numIn(raw.streamRadius, R.streamRadius[0], R.streamRadius[1], 2));
  if (raw.maxDpr !== undefined) o.maxDpr = numIn(raw.maxDpr, R.maxDpr[0], R.maxDpr[1], 1);
  if (raw.propDistance !== undefined) o.propDistance = numIn(raw.propDistance, R.propDistance[0], R.propDistance[1], 45);
  return o;
}

export function validateSettings(raw: unknown): Settings {
  const d = freshDefaults();
  if (!isObj(raw)) return d;
  const r = migrateSettings(raw);
  const R = SETTINGS_RANGES;
  const vol = isObj(r.volume) ? r.volume : {};
  const film = isObj(r.film) ? r.film : {};
  const v = (k: keyof Settings['volume']): number => numIn(vol[k], R.volume[0], R.volume[1], d.volume[k]);
  const f = (k: 'grain' | 'chromaticAberration' | 'vignette' | 'distortion' | 'motionBlur' | 'flare'): number => numIn(film[k], R.film[0], R.film[1], d.film[k]);
  const lastSeed = typeof r.lastSeed === 'string' ? r.lastSeed.trim().slice(0, 64) : typeof r.lastSeed === 'number' ? String(r.lastSeed) : '';
  return {
    version: 1,
    quality: oneOf(r.quality, QUALITY_VALUES, d.quality),
    overrides: validateOverrides(r.overrides),
    fov: numIn(r.fov, R.fov[0], R.fov[1], d.fov),
    mouseSensitivity: numIn(r.mouseSensitivity, R.mouseSensitivity[0], R.mouseSensitivity[1], d.mouseSensitivity),
    invertY: boolOr(r.invertY, d.invertY),
    headBob: numIn(r.headBob, R.headBob[0], R.headBob[1], d.headBob),
    cameraShake: numIn(r.cameraShake, R.cameraShake[0], R.cameraShake[1], d.cameraShake),
    walkSpeed: oneOf(r.walkSpeed, WALK_VALUES, d.walkSpeed),
    flicker: oneOf(r.flicker, FLICKER_VALUES, d.flicker),
    toggleSprint: boolOr(r.toggleSprint, d.toggleSprint),
    toggleCrouch: boolOr(r.toggleCrouch, d.toggleCrouch),
    brightnessEV: numIn(r.brightnessEV, R.brightnessEV[0], R.brightnessEV[1], d.brightnessEV),
    volume: { master: v('master'), ambience: v('ambience'), hum: v('hum'), sfx: v('sfx'), ui: v('ui') },
    film: {
      grain: f('grain'), chromaticAberration: f('chromaticAberration'), vignette: f('vignette'), distortion: f('distortion'),
      camcorder: boolOr(film.camcorder, d.film.camcorder), motionBlur: f('motionBlur'), flare: f('flare'),
    },
    mainsHz: r.mainsHz === 50 || r.mainsHz === '50' ? 50 : r.mainsHz === 60 || r.mainsHz === '60' ? 60 : d.mainsHz,
    lastSeed,
  };
}

function readStorage(storage: Storage | null): unknown {
  if (!storage) return null;
  try {
    const txt = storage.getItem(SETTINGS_KEY);
    return txt === null ? null : (JSON.parse(txt) as unknown);
  } catch {
    return null; // corrupt JSON or storage access denied -> defaults
  }
}

export function createSettingsStore(storage: Storage | null): SettingsStore {
  const cur = validateSettings(readStorage(storage));
  const subs = new Set<(s: Settings) => void>();
  const persist = (): void => {
    if (!storage) return;
    try { storage.setItem(SETTINGS_KEY, JSON.stringify(cur)); } catch { /* quota / private mode: keep in memory */ }
  };
  return {
    get: () => cur,
    set(patch) {
      if (!isObj(patch)) return;
      const merged: Obj = {
        ...cur,
        ...patch,
        version: 1,
        volume: { ...cur.volume, ...(isObj(patch.volume) ? patch.volume : {}) },
        film: { ...cur.film, ...(isObj(patch.film) ? patch.film : {}) },
        overrides: isObj(patch.overrides) ? { ...patch.overrides } : { ...cur.overrides },
      };
      const next = validateSettings(merged);
      if (JSON.stringify(next) === JSON.stringify(cur)) return; // no effective change
      Object.assign(cur, next);
      persist();
      for (const fn of [...subs]) fn(cur);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}
