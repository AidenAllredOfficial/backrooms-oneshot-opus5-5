import { describe, expect, it } from 'vitest';
import { locationLinkSearch, sharedLocationSearch } from '../../src/app/locationLink.ts';
import { locationSearch, parseLaunchParams } from '../../src/app/urlParams.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';

describe('location links', () => {
  it('copies generation overrides and height so the pasted link resolves to the same world', () => {
    const params = parseLaunchParams('?seed=custom&forceZone=OFFICE&forceMood=DARK&forceLandmark=ATRIUM&testScene=cornell&lights=dead', DEFAULT_SETTINGS);
    const search = sharedLocationSearch(params, { s: 1, x: 12, y: -1.325, z: 14, yaw: 1, pitch: 0 });
    const next = parseLaunchParams(locationLinkSearch(`https://example.com/${search}`), DEFAULT_SETTINGS);
    for (const key of ['seedText', 'forceZone', 'forceMood', 'forceLandmark', 'testScene', 'lights'] as const) {
      expect(next[key]).toBe(params[key]);
    }
    expect(next.y).toBe(-1.325);
    expect(next.warnings).toEqual([]);
  });
  it('round trips a copied location, including encoded seed text and a negative pose', () => {
    const search = locationSearch('a tape & #7', 2, -123.45, 678.9, -2.345, -0.25);
    const loaded = locationLinkSearch(`https://example.com/backrooms/${search}`);
    expect(loaded).toBe(search);
    const pose = parseLaunchParams(loaded, DEFAULT_SETTINGS);
    expect([pose.seedText, pose.s, pose.x, pose.z, pose.yaw, pose.pitch])
      .toEqual(['a tape & #7', 2, -123.45, 678.9, -2.345, -0.25]);
  });

  it('accepts query strings, level spawns and named destinations', () => {
    for (const search of ['?seed=7&s=1', '?seed=7&zone=PARKING', '?seed=7&goto=landmark:CHAPEL', '?seed=7&x=1&y=2&z=3']) {
      expect(new URLSearchParams(locationLinkSearch(search)).get('seed')).toBe('7');
    }
    expect(locationLinkSearch(' seed=7&s=0 ')).toBe('?seed=7&s=0');
  });

  it('ignores video, audio, automation and unknown fields instead of changing local controls', () => {
    expect(locationLinkSearch('https://other.host/?seed=8&s=2&quality=ultra&noaudio=1&autostart=1&hud=0&unknown=foo'))
      .toBe('?seed=8&s=2');
  });

  it('rejects missing locations, malformed poses and unsafe URL schemes without a spawn fallback', () => {
    for (const input of ['', 'not a link', 'javascript:alert(1)', 'file:///game?seed=7&s=0', '?x=1&z=2', '?seed=7',
      '?seed=7&s=9', '?seed=7&x=1', '?seed=7&x=no&z=2', '?seed=7&zone=NOPE', '?seed=7&s=1&s=2',
      '?seed=7&x=99999999999&z=0', '?seed=7&goto=zone:PARKING&x=1&z=2']) {
      expect(() => locationLinkSearch(input), input).toThrow();
    }
  });
});
