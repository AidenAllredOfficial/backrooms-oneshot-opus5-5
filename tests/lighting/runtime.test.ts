// tests/lighting/runtime.test.ts (WP11) — LightingRuntime, atmospheres, flashlight and the anomaly director in Node
// (three objects are plain JS; no WebGL needed) against fake tiles / world queries.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHUNK_SIZE, EDGE_FOG, LV } from '../../src/core/constants.ts';
import { EventBus } from '../../src/core/events.ts';
import type { GameBus, GameEvents } from '../../src/core/events.ts';
import { flicker } from '../../src/core/flicker.ts';
import { toHalf } from '../../src/core/half.ts';
import { AnomalyKind, LightState, Mood, Zone, ZONE_COUNT } from '../../src/core/ids.ts';
import { createEmptyLayout } from '../../src/core/layout.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import type { DynLightRef } from '../../src/core/mesh.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { QUALITY } from '../../src/core/quality.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import type { FixtureRef, MaterialGlobals, TextureSet, TileRuntime, WorldQuery } from '../../src/core/runtime.ts';
import { ATMOSPHERES, MOOD_EXTRA, MOOD_MODS } from '../../src/lighting/atmospheres.ts';
import {
  atmosphereTarget, copyParams, createAtmosphereBlender, DARK_MOTES_MIN, DUST_MAX, lerpParams, newParams, VOL_DEFAULTS,
} from '../../src/lighting/atmosphereBlend.ts';
import { createLightingRuntime, FAR_FRACTION, FAR_WARM, FLASH_METER_FOCUS, sampleLightVolume } from '../../src/lighting/LightingRuntime.ts';
import { createAnomalyDirector, sparkBurstTime, lightDiesRoll } from '../../src/lighting/anomalyDirector.ts';
import { FLASHLIGHT, handSway, type FlashlightRig } from '../../src/lighting/Flashlight.ts';
import { FLASHLIGHT_OPTICS } from '../../src/lighting/flashlightOptics.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { LAYER_LATE } from '../../src/materials/shared.ts';

// ---------------------------------------------------------------- fakes
function globals(): MaterialGlobals {
  return {
    ...createGlobals(), // the graphics-realism fields (inert); the ones below keep this file's values
    time: { value: 0 }, debugView: { value: 0 }, hazeDensity: { value: 0 }, hazeTint: { value: new THREE.Color() },
    hazeAlbedo: { value: 0 }, edgeFog: { value: new THREE.Vector2() }, farColor: { value: new THREE.Color() },
    flickerMode: { value: 0 }, reflTex: { value: null }, reflMatrix: { value: new THREE.Matrix4() }, reflOn: { value: 0 },
    reflY: { value: 0 }, floorReflOn: { value: 0 },
  };
}
const textures = { cookie: new THREE.Texture() } as unknown as TextureSet;
function volume(lux: number): THREE.Data3DTexture {
  const d = new Uint16Array(LV.NX * LV.NY * LV.NZ * 4);
  const h = toHalf(lux);
  for (let i = 0; i < d.length; i += 4) { d[i] = h; d[i + 1] = h; d[i + 2] = h; d[i + 3] = toHalf(1); }
  return new THREE.Data3DTexture(d, LV.NX, LV.NY, LV.NZ);
}
function tile(cx: number, cz: number, q: 0 | 1 | 2 | 3, lights: (DynLightRef | null)[], lux = 250): TileRuntime {
  return {
    key: { s: 0, cx, cz, q }, keyStr: `0:${cx}:${cz}:${q}`, zone: 0, group: new THREE.Group(),
    materials: {
      bindings: {
        flick: { value: new Float32Array(27).fill(-1) },
        volA: { value: volume(lux) },
        volMask: { value: new THREE.DataTexture(new Uint8Array(18 * 18 * 4), 18, 18) },
      },
    } as unknown as TileRuntime['materials'],
    dynLights: lights, bake: 'full', state: 'resident', visible: true,
  };
}
function world(zone: number = Zone.LOBBY, mood: number = Mood.NORMAL, layouts: Map<string, ChunkLayout> = new Map(), fixtures: FixtureRef[] = []): WorldQuery & { zone: number; mood: number } {
  const w = {
    zone, mood,
    zoneAt: () => w.zone, moodAt: () => w.mood,
    layoutAt: (cx: number, cz: number) => layouts.get(`${cx}:${cz}`) ?? null,
    fixturesNear: (x: number, z: number, r: number, out: FixtureRef[]) => {
      out.length = 0;
      for (const f of fixtures) if (Math.hypot(f.wx - x, f.wz - z) <= r) out.push(f);
      return out.length;
    },
    losClear: () => true,
  };
  return w as unknown as WorldQuery & { zone: number; mood: number };
}
const light = (id: number, seed: number, color: [number, number, number], state = LightState.FLICKER): DynLightRef => ({ id, state, seed, color, x: 3, y: 2.6, z: 3 });
const player = (x = 5, z = 5) => createPlayerState(0, x, 0, z, 0, 0);

// ---------------------------------------------------------------- atmospheres
describe('atmospheres', () => {
  it('every zone has a row; mood mods apply as specified', () => {
    for (let z = 0; z < ZONE_COUNT; z++) {
      const a = ATMOSPHERES[z];
      expect(a).toBeTruthy();
      expect(a.ev100Range[0]).toBeLessThan(a.ev100Range[1]);
      expect(a.aoColor).toEqual([0.12, 0.09, 0.04]);
      expect(a.hazeDensity).toBeGreaterThan(0);
    }
    expect(MOOD_MODS.length).toBe(4);
    const lobby = ATMOSPHERES[Zone.LOBBY];
    expect(lobby.hazeDensity).toBe(0.006);
    expect(lobby.hazeTint).toEqual([1.0, 0.93, 0.75]);
    // R2-post: NORMAL Level 0 floors at EV 4 (an unlit pocket reads as max-gain murk, not #000)
    expect(lobby.ev100Range).toEqual([4, 11]);
    const dark = atmosphereTarget(Zone.LOBBY, Mood.DARK, newParams());
    expect(dark.hazeDensity).toBeCloseTo(0.009, 10);
    expect(dark.hazeTint[0]).toBeCloseTo(0.8, 10);
    expect(dark.ev100Range[0]).toBeCloseTo(5.5, 10);
    expect(dark.ev100Range[1]).toBeCloseTo(10, 10);
    expect(dark.bloomIntensity).toBeCloseTo(0.6, 10);
    expect(dark.grain).toBeCloseTo(1.0, 10); // R2-post: 0.8 x 1.25
    // the DARK zone forced to mood DARK gives the same "DARK (mood)" row
    const dz = atmosphereTarget(Zone.DARK, Mood.DARK, newParams());
    expect(dz.ev100Range).toEqual(dark.ev100Range);
    // evMin is a floor: a zone whose range already starts at 5.5 does not go lower
    expect(atmosphereTarget(Zone.PARKING, Mood.DARK, newParams()).ev100Range[0]).toBeCloseTo(5.5, 10);
    expect(ATMOSPHERES[Zone.POOLROOMS].ev100Range).toEqual([8, 13.5]);
  });

  it('R2-post: camcorder exposure biases, pedestals blend, dark moods keep their floors', () => {
    for (const z of [Zone.LOBBY, Zone.MAZE]) expect(ATMOSPHERES[z].exposureBias).toBeCloseTo(1.0, 10);
    expect(ATMOSPHERES[Zone.POOLROOMS].exposureBias).toBeCloseTo(1.6, 10);
    for (const z of [Zone.LOBBY, Zone.MANILA, Zone.MAZE, Zone.OFFICE, Zone.LOW_EXPANSE, Zone.PILLAR_HALL]) {
      expect(ATMOSPHERES[z].ev100Range[0]).toBeLessThanOrEqual(4.5);
      // SPARSE / DYING / DARK moods still floor at 6 / 5.8 / 5.5
      expect(atmosphereTarget(z, Mood.SPARSE, newParams()).ev100Range[0]).toBeCloseTo(6, 10);
      expect(atmosphereTarget(z, Mood.DYING, newParams()).ev100Range[0]).toBeCloseTo(5.8, 10);
      expect(atmosphereTarget(z, Mood.DARK, newParams()).ev100Range[0]).toBeCloseTo(5.5, 10);
    }
    expect(ATMOSPHERES[Zone.DARK].ev100Range[0]).toBe(6.5);
    // the +1 EV look bias is mostly withheld in a DARK sector
    expect(atmosphereTarget(Zone.LOBBY, Mood.DARK, newParams()).exposureBias).toBeLessThan(0.5);
    const b = createAtmosphereBlender();
    b.update(Zone.LOBBY, Mood.NORMAL, 0, true);
    expect(b.current.grade.pedestal).toBeCloseTo(ATMOSPHERES[Zone.LOBBY].grade.pedestal ?? 0, 10);
    b.update(Zone.POOLROOMS, Mood.NORMAL, 0.75, false);
    const mid = b.current.grade.pedestal ?? 0;
    expect(mid).toBeLessThan(ATMOSPHERES[Zone.LOBBY].grade.pedestal ?? 0);
    expect(mid).toBeGreaterThan(ATMOSPHERES[Zone.POOLROOMS].grade.pedestal ?? 0);
  });

  it('crossfades over 1.5 s (smooth), snaps on request, first update is immediate', () => {
    const b = createAtmosphereBlender();
    b.update(Zone.LOBBY, Mood.NORMAL, 0.016, false);
    expect(b.current.hazeDensity).toBe(0.006);
    b.update(Zone.POOLROOMS, Mood.NORMAL, 0.0, false);
    expect(b.current.hazeDensity).toBe(0.006);
    b.update(Zone.POOLROOMS, Mood.NORMAL, 0.75, false);
    expect(b.current.hazeDensity).toBeCloseTo((0.006 + 0.015) / 2, 6);
    b.update(Zone.POOLROOMS, Mood.NORMAL, 0.75, false);
    expect(b.current.hazeDensity).toBeCloseTo(0.015, 10);
    expect(b.progress).toBe(1);
    b.update(Zone.OFFICE, Mood.NORMAL, 0.016, true);
    expect(b.current.hazeDensity).toBe(0.005);
  });
});

// ---------------------------------------------------------------- lighting runtime
describe('atmosphere: the living-air fields (package F)', () => {
  it('copy / lerp carry dust, mist, phase and motes; absent fields read as the defaults', () => {
    const a = newParams(), b = newParams(), d = newParams();
    copyParams(a, ATMOSPHERES[Zone.POOLROOMS]);
    expect(a.mistDensity).toBeGreaterThan(0);
    expect(a.hazePhase).toBe(0.85);
    copyParams(b, ATMOSPHERES[Zone.DARK]);
    lerpParams(d, a, b, 0.5);
    expect(d.dustDensity).toBeCloseTo(0.5 * ((a.dustDensity ?? 0) + (b.dustDensity ?? 0)), 12);
    expect(d.mistDensity).toBeCloseTo(0.5 * (a.mistDensity ?? 0), 12);
    expect(d.moteDensity).toBeCloseTo(0.5 * ((a.moteDensity ?? 0) + (b.moteDensity ?? 0)), 12);
    // a row without the fields (older tables, the harness) reads as the defaults
    const bare = { ...ATMOSPHERES[Zone.LOBBY] };
    delete bare.dustDensity; delete bare.hazePhase; delete bare.moteDensity;
    copyParams(d, bare);
    expect(d.dustDensity).toBe(VOL_DEFAULTS.dustDensity);
    expect(d.hazePhase).toBe(VOL_DEFAULTS.hazePhase);
    expect(d.moteDensity).toBe(VOL_DEFAULTS.moteDensity);
    lerpParams(d, bare, bare, 0.3);
    expect(d.dustNoise).toBe(VOL_DEFAULTS.dustNoise);
  });

  it('moods multiply the dust (capped) and a DARK mood shows most motes; lit zones keep motes sparse', () => {
    expect(MOOD_EXTRA.map((m) => m.dustMul)).toEqual([1, 1.2, 1.6, 1.9]);
    const n = atmosphereTarget(Zone.LOBBY, Mood.NORMAL, newParams()), y = atmosphereTarget(Zone.LOBBY, Mood.DYING, newParams());
    expect(y.dustDensity).toBeCloseTo((n.dustDensity ?? 0) * 1.6, 12);
    for (let z = 0; z < ZONE_COUNT; z++) {
      expect(atmosphereTarget(z, Mood.DARK, newParams()).dustDensity).toBeLessThanOrEqual(DUST_MAX);
      expect(atmosphereTarget(z, Mood.DARK, newParams()).moteDensity).toBeGreaterThanOrEqual(DARK_MOTES_MIN);
    }
    for (const z of [Zone.LOBBY, Zone.MANILA, Zone.MAZE, Zone.OFFICE, Zone.POOLROOMS]) {
      expect(ATMOSPHERES[z].moteDensity).toBeLessThanOrEqual(0.35);
    }
  });
});

describe('atmosphere blender robustness', () => {
  it('an invalid zone/mood (unloaded cell) does not restart the crossfade every frame', () => {
    const b = createAtmosphereBlender();
    b.update(Zone.LOBBY, Mood.NORMAL, 0, true);
    for (let f = 0; f < 120; f++) b.update(NaN, NaN, 1 / 60, false);
    expect(b.progress).toBe(1);
    expect(b.zone).toBe(0);
  });
});

describe('LightingRuntime', () => {
  it('fills flick uniforms (color/luma * i), evaluates each light once and honours overrides', () => {
    const bus: GameBus = new EventBus<GameEvents>();
    const scene = new THREE.Scene();
    const g = globals();
    const rt = createLightingRuntime(scene, g, textures, QUALITY.high, DEFAULT_SETTINGS, bus);
    const L = light(77, 12345, [1, 0.9, 0.7]);
    const tiles = [tile(0, 0, 0, [L, null, null, null, null, null, null, null, null]), tile(0, 0, 1, [null, L, null, null, null, null, null, null, null])];
    const p = player();
    const w = world();
    const s = { i: 0, tint: 0, buzz: 0 };
    const luma = 0.2126 + 0.7152 * 0.9 + 0.0722 * 0.7;
    for (const t of [0.5, 3.3, 17.2, 41.7, 100.01]) {
      rt.update(t, 1 / 60, tiles, p, new THREE.PerspectiveCamera(), w);
      flicker(LightState.FLICKER, 12345, t, 'standard', s);
      const f0 = tiles[0].materials.bindings.flick.value;
      const f1 = tiles[1].materials.bindings.flick.value;
      expect(f0[0]).toBeCloseTo(s.i / luma, 5);
      expect(f0[1]).toBeCloseTo(0.9 * s.i / luma, 5);
      expect(f0[2]).toBeCloseTo(0.7 * s.i / luma, 5);
      expect(f1[3]).toBe(f0[0]);
      for (let k = 3; k < 27; k++) expect(f0[k]).toBe(0);
      expect(rt.intensityOf(77)).toBe(s.i);
    }
    rt.setOverride(77, 0.2);
    rt.update(200, 1 / 60, tiles, p, new THREE.PerspectiveCamera(), w);
    expect(tiles[0].materials.bindings.flick.value[0]).toBeCloseTo(0.2 / luma, 5);
    expect(rt.intensityOf(77)).toBe(0.2);
    rt.setOverride(77, null);
    rt.update(200.02, 1 / 60, tiles, p, new THREE.PerspectiveCamera(), w);
    flicker(LightState.FLICKER, 12345, 200.02, 'standard', s);
    expect(rt.intensityOf(77)).toBe(s.i);
    expect(rt.intensityOf(999)).toBe(1); // unknown/static lights
  });

  it('emits lightToggle exactly on 0.5 crossings', () => {
    const bus: GameBus = new EventBus<GameEvents>();
    const toggles: { on: boolean; t: number }[] = [];
    let now = 0;
    bus.on('lightToggle', (e) => toggles.push({ on: e.on, t: now }));
    const rt = createLightingRuntime(new THREE.Scene(), globals(), textures, QUALITY.high, DEFAULT_SETTINGS, bus);
    const tiles = [tile(0, 0, 0, [light(5, 99, [1, 1, 1]), null, null, null, null, null, null, null, null])];
    const s = { i: 0, tint: 0, buzz: 0 };
    let expected = 0;
    let prev: boolean | null = null;
    for (let f = 0; f < 60 * 120; f++) {
      now = f / 60;
      rt.update(now, 1 / 60, tiles, player(), new THREE.PerspectiveCamera(), world());
      flicker(LightState.FLICKER, 99, now, 'standard', s);
      const on = s.i >= 0.5;
      if (prev !== null && on !== prev) expected++;
      prev = on;
    }
    expect(expected).toBeGreaterThan(4);
    expect(toggles.length).toBe(expected);
  });

  it('lightToggle is emitted only for lights referenced by a tile of the player storey', () => {
    const run = (hiddenFirst: boolean, withCurrent: boolean): number => {
      const bus: GameBus = new EventBus<GameEvents>();
      let n = 0;
      bus.on('lightToggle', () => { n++; });
      const rt = createLightingRuntime(new THREE.Scene(), globals(), textures, QUALITY.high, DEFAULT_SETTINGS, bus);
      const L = light(5, 99, [1, 1, 1]);
      const hidden = tile(0, 0, 0, [L, null, null, null, null, null, null, null, null]);
      (hidden as { key: TileRuntime['key'] }).key = { s: 1, cx: 0, cz: 0, q: 0 };
      const cur = tile(0, 0, 1, [null, L, null, null, null, null, null, null, null]);
      const tiles = withCurrent ? (hiddenFirst ? [hidden, cur] : [cur, hidden]) : [hidden];
      for (let f = 0; f < 60 * 120; f++) rt.update(f / 60, 1 / 60, tiles, player(), new THREE.PerspectiveCamera(), world());
      return n;
    };
    const a = run(true, true);
    expect(a).toBeGreaterThan(4);
    expect(run(false, true)).toBe(a); // tile order does not matter
    expect(run(true, false)).toBe(0); // a light only seen through another storey's tiles is silent
  });

  it('atmosphere: globals, far colour from camera irradiance, edge fog, scene.background, flicker mode', () => {
    const scene = new THREE.Scene();
    const g = globals();
    const q = QUALITY.medium;
    const rt = createLightingRuntime(scene, g, textures, q, DEFAULT_SETTINGS, new EventBus<GameEvents>());
    const p = player(5, 5);
    const tiles = [tile(0, 0, 0, Array(9).fill(null), 320)];
    const w = world(Zone.LOBBY, Mood.NORMAL);
    rt.update(10, 0, tiles, p, new THREE.PerspectiveCamera(), w);
    const a = rt.atmosphere();
    expect(a.camIrradiance[0]).toBeCloseTo(320, 0);
    const R = q.streamRadius * CHUNK_SIZE;
    expect(a.edgeFog[0]).toBeCloseTo(EDGE_FOG.START * R, 9);
    expect(a.edgeFog[1]).toBeCloseTo(EDGE_FOG.END * R, 9);
    expect(g.edgeFog.value.x).toBeCloseTo(EDGE_FOG.START * R, 5);
    expect(g.hazeDensity.value).toBe(0.006);
    expect(g.hazeTint.value.g).toBeCloseTo(0.93, 5);
    const far = 320 * a.hazeAlbedo / Math.PI * FAR_FRACTION;
    expect(g.farColor.value.r).toBeCloseTo(far * a.hazeTint[0] * FAR_WARM[0], 3);
    expect(g.farColor.value.b).toBeCloseTo(far * a.hazeTint[2] * FAR_WARM[2], 3);
    expect(g.farColor.value.b).toBeLessThan(g.farColor.value.r); // warm gloom
    expect(a.flashlight).toBe(0);
    expect(a.flickerMode).toBe(0);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect((scene.background as THREE.Color).equals(g.farColor.value)).toBe(true);
    // zone change crossfades over 1.5 s (simulation time)
    w.zone = Zone.POOLROOMS;
    rt.update(10.1, 0.75, tiles, p, new THREE.PerspectiveCamera(), w);
    expect(g.hazeDensity.value).toBeGreaterThan(0.006);
    expect(g.hazeDensity.value).toBeLessThan(0.015);
    rt.update(10.2, 0.8, tiles, p, new THREE.PerspectiveCamera(), w);
    expect(g.hazeDensity.value).toBeCloseTo(0.015, 9);
    rt.setFlickerMode('reduced');
    expect(g.flickerMode.value).toBe(1);
    rt.setFlickerMode('off');
    expect(g.flickerMode.value).toBe(2);
  });

  it('light-volume lookup: trilinear, wall clamp and tower wrap', () => {
    const d = new Uint16Array(LV.NX * LV.NY * LV.NZ * 4);
    // irradiance = 10 * sample index i along x, 100 at level k = 2
    for (let j = 0; j < LV.NZ; j++) for (let k = 0; k < LV.NY; k++) for (let i = 0; i < LV.NX; i++) {
      const o = ((j * LV.NY + k) * LV.NX + i) * 4;
      d[o] = toHalf(10 * i); d[o + 1] = toHalf(k === 2 ? 100 : 0); d[o + 2] = toHalf(0);
    }
    const out = new Float64Array(3);
    expect(sampleLightVolume(d, null, (5 + 0.5) * 0.6, LV.Y[2], 3, false, out)).toBe(true);
    expect(out[0]).toBeCloseTo(50, 1);
    expect(out[1]).toBeCloseTo(100, 1);
    sampleLightVolume(d, null, 6 * 0.6, LV.Y[2], 3, false, out);
    expect(out[0]).toBeCloseTo(55, 1);
    // wall on the E side of cell 0: lookups clamp to x <= 1.2 - 0.3
    const mask = new Uint8Array(18 * 18 * 4);
    mask[((0 + 1) * 18 + (0 + 1)) * 4] = 2;
    sampleLightVolume(d, mask, 1.19, LV.Y[2], 0.5, false, out);
    expect(out[0]).toBeCloseTo(10 * (0.9 / 0.6 - 0.5), 1);
    // tower wrap: y = 1.5 + 3 samples like y = 1.5
    const a0 = new Float64Array(3);
    sampleLightVolume(d, null, 3, 1.5, 3, true, a0);
    sampleLightVolume(d, null, 3, 4.5 + 3, 3, true, out);
    expect(out[1]).toBeCloseTo(a0[1], 6);
  });

  it('flashlight: constant light, castShadow always, far == distance, off = intensity 0 + no shadow updates', () => {
    const bus: GameBus = new EventBus<GameEvents>();
    const evs: boolean[] = [];
    bus.on('flashlight', (e) => evs.push(e.on));
    const scene = new THREE.Scene();
    const rt = createLightingRuntime(scene, globals(), textures, QUALITY.low, DEFAULT_SETTINGS, bus);
    const fl = rt.flashlight;
    expect(scene.children).toContain(fl.light);
    // lit by both the opaque render (layer 0) and ScenePass's late render (LAYER_LATE only: water, sparks)
    expect(fl.light.layers.isEnabled(0) && fl.light.layers.isEnabled(LAYER_LATE)).toBe(true);
    expect(fl.light.castShadow).toBe(true);
    expect(fl.light.shadow.camera.far).toBe(FLASHLIGHT.DISTANCE);
    expect(fl.light.distance).toBe(FLASHLIGHT.DISTANCE);
    // package F optics: one source for the photometry; the cookie and the shadow map span the cone x MAP_FOCUS
    expect(fl.light.intensity).toBe(0);
    expect(FLASHLIGHT.CD).toBe(FLASHLIGHT_OPTICS.PEAK_CD);
    expect(fl.light.angle).toBe(FLASHLIGHT_OPTICS.CONE);
    expect(fl.light.penumbra).toBe(FLASHLIGHT_OPTICS.PENUMBRA);
    expect(fl.light.distance).toBe(FLASHLIGHT_OPTICS.RANGE);
    expect(fl.light.shadow.focus).toBe(FLASHLIGHT_OPTICS.MAP_FOCUS);
    // three reads the cookie at the normal-biased position: on a wall 0.3 m away that lookup must stay inside the map
    // wherever the cone lights (else the bare cone shines through outside the cookie)
    const tanRim = Math.tan(FLASHLIGHT_OPTICS.CONE);
    expect(tanRim * (1 + FLASHLIGHT.NORMAL_BIAS / 0.3)).toBeLessThan(Math.tan(FLASHLIGHT_OPTICS.CONE * FLASHLIGHT_OPTICS.MAP_FOCUS));
    expect(fl.light.shadow.mapSize.x).toBe(512);
    expect(fl.light.shadow.needsUpdate).toBe(true);
    expect(fl.light.intensity).toBe(0);
    fl.set(true);
    expect(fl.light.intensity).toBe(FLASHLIGHT.CD);
    expect(FLASHLIGHT.CD).toBeGreaterThanOrEqual(1500); // R2-post: a usable torch
    expect(fl.light.shadow.autoUpdate).toBe(true);
    fl.set(false);
    expect(fl.light.intensity).toBe(0);
    expect(fl.light.shadow.autoUpdate).toBe(false);
    expect(fl.light.castShadow).toBe(true);
    expect(evs).toEqual([true, false]);
    // a quality switch resizes the map in place (three's next shadow render): freeing it would leave the lit draws
    // before that render with three's compare-less fallback depth texture (GL_INVALID_OPERATION on the shadow sampler)
    const map = new THREE.WebGLRenderTarget(512, 512);
    fl.light.shadow.map = map;
    fl.light.shadow.needsUpdate = false;
    rt.setQuality(QUALITY.ultra);
    expect(fl.light.shadow.mapSize.x).toBe(2048);
    expect(fl.light.shadow.map).toBe(map);
    expect(fl.light.shadow.needsUpdate).toBe(true);
    // rig: eye + (0.15, -0.2, 0) in camera space; yaw 0 looks along -Z
    const p = player(10, 20);
    p.eyeX = 10; p.eyeY = 1.62; p.eyeZ = 20; p.camYaw = 0; p.camPitch = 0; p.camRoll = 0;
    rt.update(1, 0, [], p, new THREE.PerspectiveCamera(), world());
    expect(fl.light.position.x).toBeCloseTo(10.15, 6);
    expect(fl.light.position.y).toBeCloseTo(1.42, 6);
    expect(fl.light.position.z).toBeCloseTo(20, 6);
    expect(fl.light.target.position.z).toBeLessThan(20);
    // lagged rotation spring: a sudden 90 deg turn is followed within ~0.5 s
    p.camYaw = Math.PI / 2;
    rt.update(1.016, 1 / 60, [], p, new THREE.PerspectiveCamera(), world());
    const tx0 = fl.light.target.position.x;
    expect(tx0).toBeGreaterThan(10 - FLASHLIGHT.CONVERGE + 0.25); // not there yet (lags)
    for (let i = 0; i < 40; i++) rt.update(1.016 + i / 60, 1 / 60, [], p, new THREE.PerspectiveCamera(), world());
    expect(fl.light.target.position.x).toBeCloseTo(10 - FLASHLIGHT.CONVERGE, 1);
  });

  it('flashlight meter focus and hand sway: none on frozen frames, small while walking', () => {
    const scene = new THREE.Scene();
    const rt = createLightingRuntime(scene, globals(), textures, QUALITY.high, DEFAULT_SETTINGS, new EventBus<GameEvents>());
    const fl = rt.flashlight as FlashlightRig;
    const p = player(10, 20);
    p.eyeX = 10; p.eyeY = 1.62; p.eyeZ = 20; p.camYaw = 0.3; p.camPitch = -0.1; p.camRoll = 0;
    fl.set(true);
    rt.update(1, 0, [], p, new THREE.PerspectiveCamera(), world());
    expect(rt.atmosphere().flashlight).toBe(FLASH_METER_FOCUS);
    // the plain aim of the harness (no gait) as the reference
    const ref = new THREE.Vector3();
    fl.aim(10, 1.62, 20, 0.3, -0.1, 0, 0);
    ref.copy(fl.light.target.position);
    // frozen time (dt = 0) with a moving, tired player: no sway at all
    p.speed = 4; p.stridePhase = 0.5; p.fatigue = 1;
    rt.update(1, 0, [], p, new THREE.PerspectiveCamera(), world());
    expect(fl.light.target.position.distanceTo(ref)).toBeLessThan(1e-12);
    // walking at 4 m/s for 6 s: the aim sways, by less than 0.012 rad
    const dir = new THREE.Vector3();
    const refDir = ref.clone().sub(fl.light.position).normalize();
    let maxA = 0;
    for (let i = 0; i < 360; i++) {
      p.stridePhase += 4 / 60 / 0.75; // ~0.75 m per step
      rt.update(1 + i / 60, 1 / 60, [], p, new THREE.PerspectiveCamera(), world());
      dir.copy(fl.light.target.position).sub(fl.light.position).normalize();
      maxA = Math.max(maxA, dir.angleTo(refDir));
    }
    expect(maxA).toBeGreaterThan(0.003);
    expect(maxA).toBeLessThan(0.012);
    // the sway follows handSway exactly: zero at the start, standing still
    const out = new Float64Array(2);
    handSway(0, { speed: 0, stridePhase: 0.3, fatigue: 0.5 }, out);
    expect([out[0], out[1]]).toEqual([0, 0]);
    // off: the meter returns to the normal centre-weighted average
    fl.set(false);
    rt.update(8, 1 / 60, [], p, new THREE.PerspectiveCamera(), world());
    expect(rt.atmosphere().flashlight).toBe(0);
  });
});

// ---------------------------------------------------------------- anomaly director
describe('anomaly director', () => {
  it('spark schedule is Poisson-like at ~1/8 s and deterministic', () => {
    let n = 0;
    for (let b = 0; b < 20000; b++) {
      const t = sparkBurstTime(4242, b);
      if (!Number.isNaN(t)) { n++; expect(t).toBeGreaterThanOrEqual(b); expect(t).toBeLessThan(b + 1); }
      expect(Object.is(sparkBurstTime(4242, b), t)).toBe(true);
    }
    expect(n / 20000).toBeGreaterThan(0.1);
    expect(n / 20000).toBeLessThan(0.135);
    let dies = 0;
    for (let b = 0; b < 600000; b++) if (lightDiesRoll(b, 0)) dies++;
    expect(dies / 600000).toBeGreaterThan(0.5 / 600);
    expect(dies / 600000).toBeLessThan(2 / 600);
  });

  it('bursts SPARKING sites within 20 m, dips a dynamic light within 2 m, never emits glitch', () => {
    const bus: GameBus = new EventBus<GameEvents>();
    const sparks: GameEvents['spark'][] = [];
    let glitches = 0;
    bus.on('spark', (e) => sparks.push({ ...e }));
    bus.on('glitch', () => glitches++);
    const scene = new THREE.Scene();
    const rt = createLightingRuntime(scene, globals(), textures, QUALITY.high, DEFAULT_SETTINGS, bus);
    const overrides: (number | null)[] = [];
    const orig = rt.setOverride.bind(rt);
    rt.setOverride = (id, v) => { overrides.push(v); orig(id, v); };
    const lay = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.LOBBY, 1, Mood.NORMAL);
    lay.ceilCm.fill(270);
    lay.anomalies.push({ kind: AnomalyKind.SPARKING, x: 6, z: 6, r: 1, seed: 31337 });
    lay.anomalies.push({ kind: AnomalyKind.SPARKING, x: 36, z: 36, r: 1, seed: 7 }); // > 20 m from the player
    const dyn = { id: 900, dynamic: true, px: 6.5, py: 2.68, pz: 6 } as unknown as FixtureRef['f'];
    const fref: FixtureRef = { f: dyn, wx: 6.5, wy: 2.68, wz: 6, tileKey: '0:0:0:0' };
    const w = world(Zone.LOBBY, Mood.NORMAL, new Map([['0:0', lay]]), [fref]);
    const dir = createAnomalyDirector(bus, rt, scene);
    expect(scene.children.some((c) => c.name === 'sparks')).toBe(true);
    // sparks draw only in the late render, after the opaque colour copy
    expect(scene.getObjectByName('sparks')!.layers.mask).toBe(1 << LAYER_LATE);
    const p = player(4, 4);
    const T = 400;
    let expected = 0;
    for (let b = 0; b < T; b++) if (!Number.isNaN(sparkBurstTime(31337, b)) && sparkBurstTime(31337, b) > 1 / 60) expected++;
    for (let f = 1; f <= T * 60; f++) dir.update(f / 60, 1 / 60, p, w);
    expect(sparks.length).toBe(expected);
    expect(sparks.length).toBeGreaterThan(20);
    for (const s of sparks) { expect(s.x).toBeCloseTo(6, 6); expect(s.z).toBeCloseTo(6, 6); expect(s.y).toBeCloseTo(2.62, 6); } // no fixture in the layout: just below the 270 cm ceiling
    expect(glitches).toBe(0);
    expect(overrides.filter((v) => v === 0.2).length).toBeGreaterThan(0);
    expect(overrides[overrides.length - 1]).toBe(null);
  });

  it('"light dies ahead" in DARK moods: ramps to 0 over 2 s, recovers after 20 s', () => {
    const bus: GameBus = new EventBus<GameEvents>();
    const an: string[] = [];
    bus.on('anomaly', (e) => an.push(`${e.kind}:${e.phase}`));
    const scene = new THREE.Scene();
    const rt = createLightingRuntime(scene, globals(), textures, QUALITY.high, DEFAULT_SETTINGS, bus);
    const dyn = { id: 901, dynamic: true, px: 5, py: 2.6, pz: 0 } as unknown as FixtureRef['f'];
    const fref: FixtureRef = { f: dyn, wx: 5, wy: 2.6, wz: -4, tileKey: '0:0:0:0' }; // 9 m ahead (-Z)
    const w = world(Zone.LOBBY, Mood.DARK, new Map(), [fref]);
    const dir = createAnomalyDirector(bus, rt, scene);
    const p = player(5, 5);
    p.eyeX = 5; p.eyeZ = 5; p.eyeY = 1.62; p.camYaw = 0;
    // find the first roll bin
    let bin = 1;
    while (!lightDiesRoll(bin, 0)) bin++;
    let minI = Infinity;
    let started = -1;
    let ended = -1;
    for (let f = 1; f <= (bin + 30) * 60; f++) {
      const t = f / 60;
      dir.update(t, 1 / 60, p, w);
      const i = rt.intensityOf(901);
      if (an.length === 1 && started < 0) started = t;
      if (an.length === 2 && ended < 0) ended = t;
      if (started >= 0 && t - started > 2.05 && ended < 0) minI = Math.min(minI, i);
    }
    expect(an).toEqual(['lightDies:start', 'lightDies:end']);
    expect(started).toBeGreaterThanOrEqual(bin);
    expect(minI).toBe(0);
    expect(ended - started).toBeCloseTo(22, 1);
    expect(rt.intensityOf(901)).toBe(1); // released
  });
});
