import { DEFAULT_SETTINGS } from '../core/settings.ts';
import { parseLaunchParams } from './urlParams.ts';

/** World and pose fields only. A pasted link never changes the player's video/audio controls. */
export const LOCATION_KEYS = [
  'seed', 's', 'x', 'y', 'z', 'yaw', 'pitch', 'yawDeg', 'pitchDeg', 'goto', 'zone',
  'forceZone', 'forceMood', 'forceLandmark', 'testScene', 'lights',
] as const;

/** Read a shared URL or query string as location data, without navigating to its host. */
export function locationLinkSearch(text: string): string {
  const value = text.trim();
  if (!value) throw new Error('Paste a location link first.');
  let raw: string;
  if (value.startsWith('?') || value.startsWith('seed=')) raw = value;
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Use a full location URL or a query starting with ?seed=.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Location URLs must use http or https.');
    raw = url.search;
  }
  const source = new URLSearchParams(raw);
  const selected = new URLSearchParams();
  for (const key of LOCATION_KEYS) {
    const values = source.getAll(key);
    if (values.length > 1) throw new Error(`The link repeats ${key}.`);
    if (values.length === 1) selected.set(key, values[0]);
  }
  if (!selected.get('seed')?.trim()) throw new Error('The link needs a world seed.');
  const params = parseLaunchParams(`?${selected}`, DEFAULT_SETTINGS);
  if (params.warnings.length) throw new Error(`Invalid location: ${params.warnings.join('; ')}`);
  if (params.s === null && params.x === null && params.goto === null && params.zone === null) {
    throw new Error('The link needs a level, coordinates, or a zone destination.');
  }
  return `?${selected}`;
}
