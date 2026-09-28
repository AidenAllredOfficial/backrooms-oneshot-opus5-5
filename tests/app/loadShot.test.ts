// tests/app/loadShot.test.ts — __backrooms.load(search), the in-place shot of the capture contract v2: which
// launches it refuses (boot parameters), which ones reset the world, and resetLaunchToggles (src/app/boot.ts), which
// must leave every toggle the debug API or evals can change exactly as a fresh boot of the same preset has it.

import { describe, expect, it } from 'vitest';
import type { FeatureToggles } from '../../src/app/appState.ts';
import { applyLaunchToggles, DEFAULT_FEATURES, featuresOf, rememberBootPost, resetLaunchToggles } from '../../src/app/boot.ts';
import { createClock } from '../../src/app/clock.ts';
import { BOOT_PARAM_KEYS, bootParamDiff, loadRefusal, parseLaunchParams, worldChanged } from '../../src/app/urlParams.ts';
import type { LaunchParams } from '../../src/core/debug.ts';
import { QUALITY_NAMES } from '../../src/core/quality.ts';
import { DEFAULT_SETTINGS, type FlickerMode } from '../../src/core/settings.ts';

const P = (search: string): LaunchParams => parseLaunchParams(search, DEFAULT_SETTINGS, 'rand');
const BASE = 'seed=7&time=10&noaudio=1&hud=0&autostart=1&quality=high';

describe('load(): boot parameters', () => {
  it('BOOT_PARAM_KEYS is the contract list', () => {
    expect([...BOOT_PARAM_KEYS]).toEqual(['quality', 'scale', 'radius', 'bake', 'camcorder', 'hud', 'debug', 'noaudio', 'autostart', 'noprime']);
  });

  it('refuses a search whose boot parameters differ, naming the keys; accepts pose, world and toggle changes', () => {
    const live = P(BASE);
    expect(loadRefusal(live, P(`${BASE}&zone=OFFICE&ssr=0&view=albedo&x=1&z=2&stream=capture&fov=70`), 'high', 'high')).toEqual([]);
    expect(loadRefusal(live, P(BASE.replace('quality=high', 'quality=ultra')), 'high', 'high')).toEqual(['quality']);
    expect(loadRefusal(live, P(BASE.replace('hud=0', 'hud=1').replace('noaudio=1', 'noaudio=0')), 'high', 'high').sort()).toEqual(['hud', 'noaudio']);
    expect(loadRefusal(live, P(`${BASE}&noprime=1&scale=1&radius=2&camcorder=1&debug=1&bake=preview`), 'high', 'high').sort())
      .toEqual(['bake', 'camcorder', 'debug', 'noprime', 'radius', 'scale']);
    expect(loadRefusal(live, P(BASE.replace('&autostart=1', '')), 'high', 'high')).toContain('autostart');
    // an absent key is its default: noaudio=0 equals no noaudio at all
    expect(bootParamDiff(P('seed=1'), P('seed=1&noaudio=0&hud=1'))).toEqual([]);
  });

  it("refuses when the running preset is no longer the one boot resolved (setQuality in place)", () => {
    expect(loadRefusal(P(BASE), P(BASE), 'high', 'ultra')).toEqual(['quality']);
  });

  it('only world parameters reset the streamer', () => {
    const a = P(BASE);
    expect(worldChanged(a, P(`${BASE}&zone=OFFICE&x=3&z=4&yawDeg=30&time=2&ssr=0`))).toBe(false);
    for (const w of ['seed=8', 'forceZone=LOBBY', 'forceMood=DARK', 'forceLandmark=RED_ROOM', 'testScene=grid', 'lights=dead', 'bakeTerm=direct']) {
      const b = P(`${BASE.replace('seed=7', '')}&${w}${w.startsWith('seed') ? '' : '&seed=7'}`);
      expect(worldChanged(a, b), w).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- resetLaunchToggles on a fake system set

interface Rec {
  lock: number | null; enabled: Record<string, boolean>; refl: string; view: number; cs: number; flash: boolean;
  flickerL: FlickerMode; flickerA: FlickerMode; fly: boolean; features: FeatureToggles; t: number; frozen: boolean; coreFlicker: FlickerMode;
}

function fakeCore(params: LaunchParams) {
  const post = {
    lock: null as number | null,
    enabled: { ao: true, bloom: true, lens: true, grain: true, smaa: true, exposure: true, grade: true, ssr: true } as Record<string, boolean>,
    refl: 'off',
    setExposureLock(ev: number | null) { this.lock = ev; },
    setEnabled(p: Record<string, boolean | undefined>) { for (const [k, v] of Object.entries(p)) if (typeof v === 'boolean') this.enabled[k] = v; },
    setReflectionDebug(m: string) { this.refl = m; },
  };
  rememberBootPost(post as never, post.enabled);
  const materials = { view: 0, globals: { csOn: { value: 1 } }, setDebugView(v: number) { this.view = v; } };
  // bootSystems: lighting / audio take core.flickerMode (the flicker= launch param, else the settings)
  const boot: FlickerMode = params.flicker ?? DEFAULT_SETTINGS.flicker;
  const lighting = {
    flashlight: { on: false, set(on: boolean) { this.on = on; } },
    flicker: boot,
    setFlickerMode(m: FlickerMode) { this.flicker = m; },
  };
  const audio = { flicker: boot, setFlickerMode(m: FlickerMode) { this.flicker = m; } };
  const player = { fly: false, setFly(on: boolean) { this.fly = on; } };
  const sys = { post, materials, lighting, audio, player, features: featuresOf(P('')) };
  const settings = { get: () => DEFAULT_SETTINGS };
  const core = { sys, params, clock: createClock(), settings, flickerMode: params.flicker ?? DEFAULT_SETTINGS.flicker };
  return core;
}
type FakeCore = ReturnType<typeof fakeCore>;

const snapshot = (c: FakeCore): Rec => ({
  lock: c.sys.post.lock, enabled: { ...c.sys.post.enabled }, refl: c.sys.post.refl, view: c.sys.materials.view,
  cs: c.sys.materials.globals.csOn.value, flash: c.sys.lighting.flashlight.on, flickerL: c.sys.lighting.flicker,
  flickerA: c.sys.audio.flicker, fly: c.sys.player.fly, features: { ...c.sys.features }, t: c.clock.t, frozen: c.clock.frozen,
  coreFlicker: c.flickerMode,
});

/** What every debug-API call and eval could have left behind on a long-lived page. */
function dirty(c: FakeCore): void {
  c.clock.set(123);
  c.sys.post.setExposureLock(3);
  c.sys.post.setEnabled({ ao: false, bloom: false, lens: false, grain: false, smaa: false, exposure: false, grade: false, ssr: false });
  c.sys.post.setReflectionDebug('conf');
  c.sys.materials.setDebugView(4);
  c.sys.materials.globals.csOn.value = 0;
  c.sys.lighting.flashlight.set(true);
  c.sys.lighting.setFlickerMode('off');
  c.sys.audio.setFlickerMode('off');
  c.flickerMode = 'off';
  c.sys.player.setFly(true);
  Object.assign(c.sys.features, { ssr: false, probe: false, cs: false, bounce: false, vol: false, reflView: 'ssr' });
}

describe('resetLaunchToggles', () => {
  const shots = [
    `${BASE}`,
    `${BASE}&nopost=1&view=albedo&exposure=8&flashlight=1&fly=1`,
    `${BASE}&ssr=0&probe=0&cs=0&bounce=0&vol=0&reflView=conf&ao=0&lens=0&flicker=reduced`,
    'seed=7&autostart=1&freeze=1&bloom=0&grain=0',
  ];

  for (const q of QUALITY_NAMES) {
    it(`an in-place shot starts from a fresh boot's toggle state (${q})`, () => {
      for (const s of shots) {
        const params = P(`${s}&quality=${q}`);
        // fresh boot: systems as bootSystems leaves them, then the gate's toggles
        const fresh = fakeCore(params);
        const bootState = snapshot(fresh);
        applyLaunchToggles(fresh as never);
        // long-lived page: dirtied by an earlier shot, reset, then the same gate's toggles
        const reused = fakeCore(params);
        dirty(reused);
        expect({ ...snapshot(reused), t: 0 }).not.toEqual({ ...bootState, t: 0 });
        resetLaunchToggles(reused as never);
        const afterReset = snapshot(reused);
        expect({ ...afterReset, t: 0, frozen: false }, s).toEqual({ ...bootState, t: 0, frozen: false });
        expect(afterReset.frozen, 'the clock runs again').toBe(false);
        expect(afterReset.features).toEqual(DEFAULT_FEATURES);
        applyLaunchToggles(reused as never);
        const a = snapshot(fresh), b = snapshot(reused);
        // the clock value itself belongs to the shot (time= sets it; otherwise it runs from the load)
        expect({ ...b, t: 0 }, s).toEqual({ ...a, t: 0 });
      }
    });
  }
});
