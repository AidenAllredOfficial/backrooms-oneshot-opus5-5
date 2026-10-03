import { describe, expect, it } from 'vitest';
import { ZONE_NAMES } from '../../src/core/ids.ts';
import { STRATA_WEIGHTS } from '../../src/core/zones.ts';
import { LAUNCH_PARAM_KEYS, gotoStoreyOrder, locationSearch, normalizeGoto, parseLaunchParams } from '../../src/app/urlParams.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import type { Settings } from '../../src/core/settings.ts';
import { LandmarkKind, Mood, Zone } from '../../src/core/ids.ts';

const S: Settings = { ...DEFAULT_SETTINGS, lastSeed: '' };
const parse = (q: string, s: Settings = S, rnd?: string) => parseLaunchParams(q, s, rnd);

describe('parseLaunchParams: defaults', () => {
  it('empty search -> defaults, no warnings', () => {
    const p = parse('');
    expect(p.warnings).toEqual([]);
    expect(p).toMatchObject({
      seedText: '', autostart: false, s: null, x: null, y: null, z: null, yaw: null, pitch: null, fov: null, goto: null,
      zone: null, forceZone: null, forceMood: null, forceLandmark: null, testScene: null, quality: null, scale: null,
      radius: null, view: 'final', time: null, freeze: false, exposure: 'auto', flashlight: false, fly: false, audio: true,
      post: true, ao: true, bloom: true, grain: true, lens: true, flicker: null, lights: 'default', bake: 'interactive',
      bakeTerm: 'all', camcorder: false, hud: true, debug: false, prime: true,
      ssr: true, probe: true, cs: true, bounce: true, vol: true, reflView: 'off',
    });
  });
  it('bake: full for automation (autostart=1), interactive for a player, explicit values win', () => {
    expect(parse('autostart=1').bake).toBe('full');
    expect(parse('seed=1&x=4&z=4').bake).toBe('interactive');
    expect(parse('autostart=1&bake=preview').bake).toBe('preview');
    expect(parse('bake=full').bake).toBe('full');
    expect(parse('autostart=1&bake=interactive').bake).toBe('interactive');
  });
  it('stream: capture only with bake=full (automation), full otherwise', () => {
    expect(parse('autostart=1').stream).toBe('full');
    expect(parse('autostart=1&stream=capture').stream).toBe('capture');
    expect(parse('autostart=1&stream=capture').warnings).toEqual([]);
    expect(parse('bake=full&stream=capture').stream).toBe('capture');
    const player = parse('stream=capture');
    expect(player.stream).toBe('full');
    expect(player.warnings.join(' ')).toMatch(/stream/);
    expect(parse('autostart=1&stream=bogus').warnings.join(' ')).toMatch(/stream/);
  });
  it('accepts a leading "?" or none', () => {
    expect(parse('?seed=abc').seedText).toBe('abc');
    expect(parse('seed=abc').seedText).toBe('abc');
  });
});

describe('seed', () => {
  it('param > settings.lastSeed > random > empty', () => {
    expect(parse('seed=42', { ...S, lastSeed: 'old' }, '1111-2222').seedText).toBe('42');
    expect(parse('', { ...S, lastSeed: 'old' }, '1111-2222').seedText).toBe('old');
    expect(parse('', S, '1111-2222').seedText).toBe('1111-2222');
    expect(parse('', S).seedText).toBe('');
  });
  it('trims, keeps arbitrary strings, truncates at 64', () => {
    expect(parse('seed=%20hello%20world%20').seedText).toBe('hello world');
    const long = 'x'.repeat(80);
    const p = parse(`seed=${long}`);
    expect(p.seedText).toHaveLength(64);
    expect(p.warnings.some((w) => w.startsWith('seed:'))).toBe(true);
  });
  it('an empty seed= falls back with a warning', () => {
    const p = parse('seed=', { ...S, lastSeed: 'kept' });
    expect(p.seedText).toBe('kept');
    expect(p.warnings).toHaveLength(1);
  });
});

describe('every parameter parses', () => {
  it('position and view', () => {
    const p = parse('s=2&x=12.5&z=-3&y=1.5&yaw=0.5&pitch=-0.2&fov=70');
    expect(p).toMatchObject({ s: 2, x: 12.5, z: -3, y: 1.5, yaw: 0.5, pitch: -0.2, fov: 70 });
    expect(p.warnings).toEqual([]);
  });
  it('yawDeg / pitchDeg convert to radians; yaw wins over yawDeg', () => {
    const p = parse('yawDeg=90&pitchDeg=-45');
    expect(p.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(p.pitch).toBeCloseTo(-Math.PI / 4, 12);
    const q = parse('yaw=1&yawDeg=90');
    expect(q.yaw).toBe(1);
    expect(q.warnings).toHaveLength(1);
    const pitch = parse('pitch=0.5&pitchDeg=90');
    expect(pitch.pitch).toBe(0.5);
    expect(pitch.warnings).toEqual(['pitchDeg: ignored because pitch is given']);
    expect(Number.isFinite(parse('yawDeg=1e308').yaw)).toBe(true);
  });
  it('goto targets (case-insensitive names) and zone shorthand', () => {
    expect(parse('goto=zone:poolrooms').goto).toBe('zone:POOLROOMS');
    expect(parse('goto=landmark:red_room').goto).toBe('landmark:RED_ROOM');
    expect(parse('goto=vignette:RADIO').goto).toBe('vignette:RADIO');
    for (const g of ['tower', 'elevator', 'dark', 'water', 'flicker', 'spawn']) expect(parse(`goto=${g}`).goto).toBe(g);
    expect(parse('goto=TOWER').goto).toBe('tower');
    expect(parse('zone=low_expanse').zone).toBe(Zone.LOW_EXPANSE);
    expect(parse('zone=pillar-hall').zone).toBe(Zone.PILLAR_HALL);
  });
  it('generation overrides', () => {
    const p = parse('forceZone=PARKING&forceMood=dark&forceLandmark=ATRIUM&testScene=cornell');
    expect(p).toMatchObject({ forceZone: Zone.PARKING, forceMood: Mood.DARK, forceLandmark: LandmarkKind.ATRIUM, testScene: 'cornell' });
    expect(p.warnings).toEqual([]);
  });
  it('quality / scale / radius', () => {
    for (const q of ['low', 'medium', 'high', 'ultra', 'auto']) expect(parse(`quality=${q}`).quality).toBe(q);
    expect(parse('quality=HIGH').quality).toBe('high');
    expect(parse('scale=0.75').scale).toBe(0.75);
    expect(parse('radius=3').radius).toBe(3);
  });
  it('debug / measurement', () => {
    const p = parse('view=lightmap&time=10&freeze=1&exposure=9.5&flashlight=1&fly=1&noaudio=1&nopost=1&ao=0&bloom=0&grain=0&lens=0'
      + '&flicker=reduced&lights=dead&bake=preview&bakeTerm=indirect&camcorder=1&hud=0&debug=1&autostart=1&noprime=1');
    expect(p).toMatchObject({
      view: 'lightmap', time: 10, freeze: true, exposure: 9.5, flashlight: true, fly: true, audio: false, post: false,
      ao: false, bloom: false, grain: false, lens: false, flicker: 'reduced', lights: 'dead', bake: 'preview',
      bakeTerm: 'indirect', camcorder: true, hud: false, debug: true, autostart: true, prime: false,
    });
    expect(p.warnings).toEqual([]);
  });
  it('exposure=auto keeps auto; every debug view name parses', () => {
    expect(parse('exposure=auto').exposure).toBe('auto');
    for (const v of ['final', 'albedo', 'normal', 'roughness', 'lightmap', 'directionality', 'ao', 'flicker', 'mask', 'layer',
      'texel', 'zone', 'room', 'uv', 'emission', 'lv', 'wetness', 'height', 'volumetric', 'bounce', 'water', 'probe', 'specw',
      'ssao']) expect(parse(`view=${v}`).view).toBe(v);
  });
  it('graphics-realism feature toggles: ssr / probe / cs / bounce / vol (0|1) and reflView', () => {
    const p = parse('ssr=0&probe=0&cs=0&bounce=0&vol=0&reflView=conf');
    expect(p).toMatchObject({ ssr: false, probe: false, cs: false, bounce: false, vol: false, reflView: 'conf' });
    expect(p.warnings).toEqual([]);
    expect(parse('ssr=1&reflView=ssr')).toMatchObject({ ssr: true, reflView: 'ssr' });
    const bad = parse('reflView=mirror&cs=maybe');
    expect(bad).toMatchObject({ reflView: 'off', cs: true });
    expect(bad.warnings).toHaveLength(2);
  });
  it('boolean spellings', () => {
    expect(parse('fly=true').fly).toBe(true);
    expect(parse('fly').fly).toBe(true); // bare key
    expect(parse('hud=off').hud).toBe(false);
    expect(parse('ao=1').ao).toBe(true);
  });
  it('every key §7.1 lists is known (no unknown-parameter warning)', () => {
    const q = LAUNCH_PARAM_KEYS.map((k) => `${k}=`).join('&');
    const p = parse(q);
    expect(p.warnings.some((w) => w.startsWith('unknown parameter'))).toBe(false);
  });
});

describe('clamping', () => {
  it('fov 50-90, scale 0.5-2, radius 1-4 (rounded), pitch +-1.5, time >= 0, exposure range', () => {
    const p = parse('fov=120&scale=5&radius=9&pitch=3&time=-4&exposure=99');
    expect(p).toMatchObject({ fov: 90, scale: 2, radius: 4, pitch: 1.5, time: 0, exposure: 24 });
    expect(p.warnings).toHaveLength(6);
    const q = parse('fov=10&scale=0.1&radius=0&pitch=-9');
    expect(q).toMatchObject({ fov: 50, scale: 0.5, radius: 1, pitch: -1.5 });
    const r = parse('radius=2.6');
    expect(r.radius).toBe(3);
    expect(r.warnings).toHaveLength(1);
  });
  it('huge coordinates are clamped', () => {
    const p = parse('x=1e9&z=-1e9');
    expect(p.x).toBe(1e6);
    expect(p.z).toBe(-1e6);
    expect(p.warnings).toHaveLength(2);
  });
});

describe('bad values -> warnings, never throws', () => {
  it('invalid values are reported and replaced by defaults', () => {
    const p = parse('s=7&x=abc&z=1&fov=wide&goto=moon&zone=NOWHERE&forceZone=X&forceMood=HAPPY&forceLandmark=Y&testScene=z'
      + '&quality=max&view=xray&flicker=strobe&lights=disco&bake=half&bakeTerm=both&fly=maybe');
    expect(p.s).toBeNull();
    expect(p.x).toBeNull(); // z alone is not a position
    expect(p.z).toBeNull();
    expect(p.fov).toBeNull();
    expect(p.goto).toBeNull();
    expect(p.zone).toBeNull();
    expect(p.forceZone).toBeNull();
    expect(p.forceMood).toBeNull();
    expect(p.forceLandmark).toBeNull();
    expect(p.testScene).toBeNull();
    expect(p.quality).toBeNull();
    expect(p.view).toBe('final');
    expect(p.flicker).toBeNull();
    expect(p.lights).toBe('default');
    expect(p.bake).toBe('interactive'); // no autostart
    expect(p.bakeTerm).toBe('all');
    expect(p.fly).toBe(false);
    expect(p.warnings.length).toBeGreaterThanOrEqual(17);
  });
  it('unknown keys, repeated keys, y without x/z', () => {
    const p = parse('foo=1&seed=a&seed=b&y=2');
    expect(p.seedText).toBe('a');
    expect(p.y).toBeNull();
    expect(p.warnings).toEqual([
      "unknown parameter 'foo'",
      'seed: given more than once; the first value is used',
      'y: ignored without x and z',
    ]);
  });
  it('conflicting destinations are reported', () => {
    expect(parse('goto=tower&zone=LOBBY').warnings).toHaveLength(1);
    expect(parse('x=1&z=2&goto=tower').warnings).toHaveLength(1);
  });
  it('garbage inputs never throw', () => {
    const junk = ['%', '%%%', '&&&', '=', '==x', 'seed=%E0%A4%A', 'x=Infinity&z=NaN', '\u0000=\u0000', 'a'.repeat(5000),
      'goto=zone:', 'goto=:x', 'exposure=', 'radius=1e400'];
    for (const j of junk) expect(() => parse(j)).not.toThrow();
    expect(parse('x=Infinity&z=NaN').x).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizeGoto', () => {
    expect(normalizeGoto('Zone:office')).toBe('zone:OFFICE');
    expect(normalizeGoto('zone:NOPE')).toBeNull();
    expect(normalizeGoto('portal')).toBeNull();
  });
  it('locationSearch round-trips through parseLaunchParams', () => {
    const q = locationSearch('4821-0937', 1, 12.345, -6.789, 1.2345, -0.25);
    const p = parse(q);
    expect(p.warnings).toEqual([]);
    expect(p).toMatchObject({ seedText: '4821-0937', s: 1, pitch: -0.25 });
    expect(p.x).toBeCloseTo(12.345, 1);
    expect(p.z).toBeCloseTo(-6.789, 1);
    expect(p.yaw).toBeCloseTo(1.2345, 2);
  });
  it('locationSearch preserves tower and elevator heights when supplied', () => {
    const p = parse(locationSearch('tower', 2, 3, 4, 0.5, -0.2, -1.325));
    expect(p).toMatchObject({ seedText: 'tower', s: 2, x: 3, z: 4, y: -1.325 });
    expect(p.warnings).toEqual([]);
  });
});

describe('gotoStoreyOrder', () => {
  it('deep zones are searched in their stratum only', () => {
    expect(gotoStoreyOrder('zone:PARKING', 0)).toEqual([1]);
    // storeys that can hold the zone, by weight (the start storey first when it can); data-driven (R2 B4 moved strata)
    const conc = ZONE_NAMES.indexOf('CONCRETE');
    const w = (st: 0 | 1 | 2): number => STRATA_WEIGHTS[st][conc] ?? 0;
    const others = ([0, 1] as const).filter((st) => w(st) > 0).sort((a, b) => w(b) - w(a));
    expect(gotoStoreyOrder('zone:CONCRETE', 2)).toEqual(w(2) > 0 ? [2, ...others] : others);
    expect(gotoStoreyOrder('zone:POOLROOMS', 1)).toEqual([2, 0]); // weight 70 on storey 2, 2 on storey 0, 0 on 1
  });
  it('the start storey comes first when it can hold the zone', () => {
    expect(gotoStoreyOrder('zone:LOBBY', 0)).toEqual([0, 1]);
    expect(gotoStoreyOrder('zone:POOLROOMS', 0)).toEqual([0, 2]);
  });
  it('forceZone and non-zone queries try every storey, start first', () => {
    expect(gotoStoreyOrder('zone:PARKING', 0, Zone.PARKING)).toEqual([0, 1, 2]);
    expect(gotoStoreyOrder('landmark:RED_ROOM', 1)).toEqual([1, 2, 0]);
    expect(gotoStoreyOrder('tower', 2)).toEqual([2, 0, 1]);
  });
});
