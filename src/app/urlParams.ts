// src/app/urlParams.ts (WP14, PURE) — URL search string -> LaunchParams (§7.1). Never throws; bad values -> warnings.
// Every recognised key is validated and clamped; clamped / rejected / unknown values are reported in `warnings`
// (surfaced through stats().warnings, which headless QA requires to be empty).

import type { LaunchParams } from '../core/debug.ts';
import { DEBUG_VIEW_NAMES, LANDMARK_NAMES, MOOD_NAMES, VIGNETTE_NAMES, ZONE_NAMES } from '../core/ids.ts';
import type { LandmarkKindId, MoodId, StoreyId, ZoneId } from '../core/ids.ts';
import type { QualityName } from '../core/quality.ts';
import type { FlickerMode, Settings } from '../core/settings.ts';
import { TEST_SCENES } from '../core/world.ts';
import { STRATA_WEIGHTS } from '../core/zones.ts';
import type { TestSceneId } from '../core/world.ts';
import type { BakeTerm } from '../core/worker.ts';

/** Every key §7.1 defines (plus `pitchDeg`, the obvious twin of `yawDeg`). */
export const LAUNCH_PARAM_KEYS: readonly string[] = [
  'seed', 'autostart', 's', 'x', 'y', 'z', 'yaw', 'pitch', 'yawDeg', 'pitchDeg', 'fov', 'goto', 'zone', 'forceZone',
  'forceMood', 'forceLandmark', 'testScene', 'quality', 'scale', 'radius', 'view', 'time', 'freeze', 'exposure',
  'flashlight', 'fly', 'noaudio', 'nopost', 'ao', 'bloom', 'grain', 'lens', 'flicker', 'lights', 'bake', 'bakeTerm',
  'camcorder', 'hud', 'debug', 'noprime',
];

/** Simple goto targets (no NAME part). */
export const GOTO_SIMPLE: readonly string[] = ['tower', 'elevator', 'dark', 'water', 'flicker', 'spawn'];

export const LIMITS = {
  fov: [50, 90],
  scale: [0.5, 2],
  radius: [1, 4],
  pitch: [-1.5, 1.5], // radians (about +-86 deg)
  coord: 1e6, // |x|, |z| metres
  y: [-50, 50],
  time: [0, 1e7],
  exposure: [-6, 24], // EV100
} as const;

const QUALITY_VALUES: readonly (QualityName | 'auto')[] = ['low', 'medium', 'high', 'ultra', 'auto'];
const FLICKER_VALUES: readonly FlickerMode[] = ['standard', 'reduced', 'off'];
const LIGHTS_VALUES: readonly LaunchParams['lights'][] = ['default', 'on', 'dead'];
const BAKE_TERMS: readonly BakeTerm[] = ['all', 'direct', 'indirect'];
const TRUE_WORDS = ['1', 'true', 'yes', 'on', ''];
const FALSE_WORDS = ['0', 'false', 'no', 'off'];

/** Case-insensitive lookup of NAME in a name table; returns the index or -1. Accepts '-' / ' ' for '_'. */
export function nameIndex(names: readonly string[], raw: string): number {
  const n = raw.trim().toUpperCase().replace(/[-\s]+/g, '_');
  return names.indexOf(n);
}

/** Normalises a goto target ('zone:lobby' -> 'zone:LOBBY'); null if invalid. */
export function normalizeGoto(raw: string): string | null {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (GOTO_SIMPLE.includes(lower)) return lower;
  const c = v.indexOf(':');
  if (c <= 0) return null;
  const kind = v.slice(0, c).toLowerCase();
  const name = v.slice(c + 1);
  const table = kind === 'zone' ? ZONE_NAMES : kind === 'landmark' ? LANDMARK_NAMES : kind === 'vignette' ? VIGNETTE_NAMES : null;
  if (!table) return null;
  const i = nameIndex(table, name);
  return i < 0 ? null : `${kind}:${table[i]}`;
}

/**
 * Storeys to search for a goto target, in order, when the launch gives no explicit storey. Zones live in fixed
 * strata (STRATA_WEIGHTS; PARKING etc. only exist below Level 0), so a `zone:NAME` query skips storeys where the zone
 * has weight 0 (unless `forceZone` makes every district that zone): `start` first when it can hold the zone, then the
 * others by decreasing weight. Other queries (landmarks, vignettes, water, ...) try `start`, then the other two.
 */
export function gotoStoreyOrder(query: string, start: StoreyId, forceZone: ZoneId | null = null): StoreyId[] {
  const all: StoreyId[] = [start, ((start + 1) % 3) as StoreyId, ((start + 2) % 3) as StoreyId];
  if (!query.startsWith('zone:') || forceZone !== null) return all;
  const z = ZONE_NAMES.indexOf(query.slice(5));
  if (z < 0) return all;
  const w = (s: StoreyId): number => STRATA_WEIGHTS[s][z] ?? 0;
  const rest = all.slice(1).filter((s) => w(s) > 0).sort((a, b) => w(b) - w(a));
  return w(start) > 0 ? [start, ...rest] : rest;
}

/** The default URL-param-free launch (also what parseLaunchParams returns for an empty search). */
function defaults(seedText: string): LaunchParams {
  return {
    seedText, autostart: false, s: null, x: null, y: null, z: null, yaw: null, pitch: null, fov: null, goto: null, zone: null,
    forceZone: null, forceMood: null, forceLandmark: null, testScene: null, quality: null, scale: null, radius: null,
    view: 'final', time: null, freeze: false, exposure: 'auto', flashlight: false, fly: false, audio: true, post: true,
    ao: true, bloom: true, grain: true, lens: true, flicker: null, lights: 'default', bake: 'full', bakeTerm: 'all',
    camcorder: false, hud: true, debug: false, prime: true, warnings: [],
  };
}

/**
 * @param search `location.search` (with or without the leading '?')
 * @param settings persisted settings (`lastSeed` is the default seed)
 * @param randomSeedText entropy supplied by the caller (this module is pure): used when `seed` is absent and
 *        `settings.lastSeed` is empty (contract change WP14, accepted)
 */
export function parseLaunchParams(search: string, settings: Settings, randomSeedText?: string): LaunchParams {
  const out = defaults('');
  const w = out.warnings;
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    w.push('url: unparseable search string');
    p = new URLSearchParams();
  }

  // ---- unknown / repeated keys
  const seen = new Set<string>();
  for (const k of p.keys()) {
    if (!LAUNCH_PARAM_KEYS.includes(k)) {
      if (!seen.has(k)) w.push(`unknown parameter '${k}'`);
    } else if (seen.has(k)) {
      w.push(`${k}: given more than once; the first value is used`);
    }
    seen.add(k);
  }

  const str = (k: string): string | null => p.get(k);
  const num = (k: string): number | null => {
    const v = str(k);
    if (v === null) return null;
    const t = v.trim();
    const n = t === '' ? NaN : Number(t);
    if (!Number.isFinite(n)) {
      w.push(`${k}: '${v}' is not a number`);
      return null;
    }
    return n;
  };
  const clampNum = (k: string, v: number | null, lo: number, hi: number): number | null => {
    if (v === null) return null;
    if (v < lo || v > hi) {
      const c = v < lo ? lo : hi;
      w.push(`${k}: ${v} clamped to ${c}`);
      return c;
    }
    return v;
  };
  const bool = (k: string, dflt: boolean): boolean => {
    const v = str(k);
    if (v === null) return dflt;
    const t = v.trim().toLowerCase();
    if (TRUE_WORDS.includes(t)) return true;
    if (FALSE_WORDS.includes(t)) return false;
    w.push(`${k}: '${v}' is not a boolean (use 1 or 0)`);
    return dflt;
  };
  const oneOf = <T extends string>(k: string, values: readonly T[]): T | null => {
    const v = str(k);
    if (v === null) return null;
    const t = v.trim();
    const hit = values.find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit === undefined) {
      w.push(`${k}: unknown value '${v}' (expected ${values.join('|')})`);
      return null;
    }
    return hit;
  };
  const named = (k: string, names: readonly string[]): number | null => {
    const v = str(k);
    if (v === null) return null;
    const i = nameIndex(names, v);
    if (i < 0) {
      w.push(`${k}: unknown name '${v}'`);
      return null;
    }
    return i;
  };

  // ---- seed
  const seedRaw = str('seed');
  let seedText = seedRaw === null ? '' : seedRaw.trim();
  if (seedRaw !== null && seedText === '') w.push("seed: empty value ignored");
  if (seedText.length > 64) {
    w.push('seed: truncated to 64 characters');
    seedText = seedText.slice(0, 64);
  }
  if (seedText === '') seedText = settings.lastSeed.trim();
  if (seedText === '') seedText = randomSeedText ?? '';
  out.seedText = seedText;

  out.autostart = bool('autostart', false);

  // ---- position / view
  const sNum = num('s');
  if (sNum !== null) {
    if (sNum === 0 || sNum === 1 || sNum === 2) out.s = sNum as StoreyId;
    else w.push(`s: ${sNum} is not a storey (0, 1, 2)`);
  }
  out.x = clampNum('x', num('x'), -LIMITS.coord, LIMITS.coord);
  out.z = clampNum('z', num('z'), -LIMITS.coord, LIMITS.coord);
  out.y = clampNum('y', num('y'), LIMITS.y[0], LIMITS.y[1]);
  if ((out.x === null) !== (out.z === null)) {
    w.push('x/z: both are required for an explicit position; ignored');
    out.x = null;
    out.z = null;
  }
  if (out.y !== null && out.x === null) {
    w.push('y: ignored without x and z');
    out.y = null;
  }
  const yaw = num('yaw');
  const yawDeg = num('yawDeg');
  if (yaw !== null) out.yaw = yaw;
  else if (yawDeg !== null) out.yaw = (yawDeg * Math.PI) / 180;
  if (yaw !== null && yawDeg !== null) w.push('yawDeg: ignored because yaw is given');
  const pitch = num('pitch');
  const pitchDeg = num('pitchDeg');
  const pRad = pitch ?? (pitchDeg === null ? null : (pitchDeg * Math.PI) / 180);
  out.pitch = clampNum(pitch !== null ? 'pitch' : 'pitchDeg', pRad, LIMITS.pitch[0], LIMITS.pitch[1]);
  out.fov = clampNum('fov', num('fov'), LIMITS.fov[0], LIMITS.fov[1]);

  // ---- destinations
  const gotoRaw = str('goto');
  if (gotoRaw !== null) {
    const g = normalizeGoto(gotoRaw);
    if (g === null) w.push(`goto: unknown target '${gotoRaw}'`);
    else out.goto = g;
  }
  const zone = named('zone', ZONE_NAMES);
  if (zone !== null) out.zone = zone as ZoneId;
  if (out.goto !== null && out.zone !== null) w.push('zone: ignored because goto is given');
  if (out.x !== null && (out.goto !== null || out.zone !== null)) w.push('goto/zone: ignored because x/z are given');

  // ---- generation overrides
  const fz = named('forceZone', ZONE_NAMES);
  if (fz !== null) out.forceZone = fz as ZoneId;
  const fm = named('forceMood', MOOD_NAMES);
  if (fm !== null) out.forceMood = fm as MoodId;
  const fl = named('forceLandmark', LANDMARK_NAMES);
  if (fl !== null) out.forceLandmark = fl as LandmarkKindId;
  out.testScene = oneOf<TestSceneId>('testScene', TEST_SCENES);

  // ---- quality
  out.quality = oneOf('quality', QUALITY_VALUES);
  out.scale = clampNum('scale', num('scale'), LIMITS.scale[0], LIMITS.scale[1]);
  const radius = clampNum('radius', num('radius'), LIMITS.radius[0], LIMITS.radius[1]);
  if (radius !== null) {
    out.radius = Math.round(radius);
    if (out.radius !== radius) w.push(`radius: ${radius} rounded to ${out.radius}`);
  }

  // ---- debug / measurement
  const view = str('view');
  if (view !== null) {
    const t = view.trim().toLowerCase();
    if (DEBUG_VIEW_NAMES.includes(t)) out.view = t;
    else w.push(`view: unknown value '${view}'`);
  }
  out.time = clampNum('time', num('time'), LIMITS.time[0], LIMITS.time[1]);
  out.freeze = bool('freeze', false);
  const exp = str('exposure');
  if (exp !== null && exp.trim().toLowerCase() !== 'auto') {
    const ev = clampNum('exposure', num('exposure'), LIMITS.exposure[0], LIMITS.exposure[1]);
    if (ev !== null) out.exposure = ev;
  }
  out.flashlight = bool('flashlight', false);
  out.fly = bool('fly', false);
  out.audio = !bool('noaudio', false);
  out.post = !bool('nopost', false);
  out.ao = bool('ao', true);
  out.bloom = bool('bloom', true);
  out.grain = bool('grain', true);
  out.lens = bool('lens', true);
  out.flicker = oneOf('flicker', FLICKER_VALUES);
  out.lights = oneOf('lights', LIGHTS_VALUES) ?? 'default';
  // automation (autostart=1: shoot / qa) waits for full bakes; a player on the title screen does not (R2 B9)
  out.bake = oneOf('bake', ['preview', 'full', 'interactive'] as const) ?? (out.autostart ? 'full' : 'interactive');
  out.bakeTerm = oneOf('bakeTerm', BAKE_TERMS) ?? 'all';
  out.camcorder = bool('camcorder', false);
  out.hud = bool('hud', true);
  out.debug = bool('debug', false);
  out.prime = !bool('noprime', false);
  return out;
}

/** Inverse for the pause menu's "Copy location link" (seed/s/x/z/yaw/pitch). */
export function locationSearch(seedText: string, s: StoreyId, x: number, z: number, yaw: number, pitch: number): string {
  const p = new URLSearchParams();
  p.set('seed', seedText);
  p.set('s', String(s));
  p.set('x', x.toFixed(2));
  p.set('z', z.toFixed(2));
  p.set('yaw', yaw.toFixed(3));
  p.set('pitch', pitch.toFixed(3));
  return `?${p.toString()}`;
}
