import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY, createSettingsStore, migrateSettings, validateSettings } from '../../src/app/settingsStore.ts';
import { CONTINUE_KEY, TAPE_LOG_KEY, TAPE_LOG_MAX, createContinueStore, createTapeLogStore, validateTapeLog } from '../../src/app/continueStore.ts';
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts';
import type { Settings } from '../../src/core/settings.ts';

/** In-memory Storage (the DOM interface, enough for the stores). */
class MemStorage implements Storage {
  private m = new Map<string, string>();
  failWrites = false;
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(k: string): string | null { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string): void { this.m.delete(k); }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.m.set(k, String(v));
  }
}

describe('validateSettings: defaults', () => {
  it('non-objects give the defaults (fresh copies)', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      const s = validateSettings(raw);
      expect(s).toEqual(DEFAULT_SETTINGS);
      expect(s.volume).not.toBe(DEFAULT_SETTINGS.volume);
      expect(s.film).not.toBe(DEFAULT_SETTINGS.film);
      expect(s.overrides).not.toBe(DEFAULT_SETTINGS.overrides);
    }
  });
  it('an empty object gives the defaults', () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it('a valid v1 object round-trips unchanged', () => {
    const v: Settings = {
      ...DEFAULT_SETTINGS, quality: 'ultra', overrides: { renderScale: 0.8, dynamicResolution: false }, fov: 75,
      mouseSensitivity: 0.003, invertY: true, headBob: 0.4, flicker: 'off', toggleSprint: true, toggleCrouch: true,
      brightnessEV: -0.5, volume: { master: 0.5, ambience: 0.1, hum: 0.2, sfx: 0.3, ui: 0 },
      film: { grain: 0.2, chromaticAberration: 0, vignette: 0.5, distortion: 0.25, camcorder: true }, mainsHz: 50, lastSeed: 'abc',
    };
    expect(validateSettings(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
});

describe('validateSettings: clamping and types', () => {
  it('clamps numbers into their ranges', () => {
    const s = validateSettings({
      version: 1, fov: 200, mouseSensitivity: -1, headBob: 3, brightnessEV: -9,
      volume: { master: 2, ambience: -1, hum: 0.5, sfx: 'x', ui: null },
      film: { grain: 7, chromaticAberration: -2, vignette: 0.3, distortion: Infinity },
      overrides: { renderScale: 9, streamRadius: 2.7, maxDpr: 0 },
    });
    expect(s.fov).toBe(90);
    expect(s.mouseSensitivity).toBe(0.0003);
    expect(s.headBob).toBe(1);
    expect(s.brightnessEV).toBe(-1);
    expect(s.volume).toEqual({ master: 1, ambience: 0, hum: 0.5, sfx: DEFAULT_SETTINGS.volume.sfx, ui: DEFAULT_SETTINGS.volume.ui });
    expect(s.film).toEqual({ grain: 1, chromaticAberration: 0, vignette: 0.3, distortion: DEFAULT_SETTINGS.film.distortion, camcorder: false });
    expect(s.overrides).toEqual({ renderScale: 2, streamRadius: 3, maxDpr: 0.5 });
  });
  it('enums fall back to defaults; unknown fields are dropped', () => {
    const s = validateSettings({ version: 1, quality: 'max', flicker: 'strobe', mainsHz: 55, invertY: 'yes', evil: 1, overrides: { lmTpc: 4, ao: 'High' } });
    expect(s.quality).toBe('auto');
    expect(s.flicker).toBe('standard');
    expect(s.mainsHz).toBe(60);
    expect(s.invertY).toBe(false);
    expect('evil' in s).toBe(false);
    expect(s.overrides).toEqual({});
  });
  it('accepts numeric strings and string mains', () => {
    const s = validateSettings({ version: 1, fov: '70', mainsHz: '50' });
    expect(s.fov).toBe(70);
    expect(s.mainsHz).toBe(50);
  });
  it('lastSeed is trimmed and capped', () => {
    expect(validateSettings({ version: 1, lastSeed: '  hi  ' }).lastSeed).toBe('hi');
    expect(validateSettings({ version: 1, lastSeed: 'z'.repeat(99) }).lastSeed).toHaveLength(64);
    expect(validateSettings({ version: 1, lastSeed: 1234 }).lastSeed).toBe('1234');
  });
});

describe('migration', () => {
  it('unversioned (v0) flat settings map onto v1', () => {
    const s = validateSettings({ sensitivity: 0.004, volume: 0.3, reducedFlicker: true, bob: false, grain: 0.1, vignette: 0.2, seed: 'legacy', fov: 80 });
    expect(s.version).toBe(1);
    expect(s.mouseSensitivity).toBe(0.004);
    expect(s.volume.master).toBe(0.3);
    expect(s.volume.hum).toBe(DEFAULT_SETTINGS.volume.hum);
    expect(s.flicker).toBe('reduced');
    expect(s.headBob).toBe(0);
    expect(s.film.grain).toBe(0.1);
    expect(s.film.vignette).toBe(0.2);
    expect(s.lastSeed).toBe('legacy');
    expect(s.fov).toBe(80);
  });
  it('v0 numeric bob and reducedFlicker=false', () => {
    const s = validateSettings({ bob: 0.5, reducedFlicker: false });
    expect(s.headBob).toBe(0.5);
    expect(s.flicker).toBe('standard');
  });
  it('a newer version keeps the fields this build understands', () => {
    const s = validateSettings({ version: 3, fov: 77, futureThing: { a: 1 } });
    expect(s.version).toBe(1);
    expect(s.fov).toBe(77);
  });
  it('migrateSettings leaves v1 untouched', () => {
    const v1 = { version: 1, fov: 70 };
    expect(migrateSettings(v1)).toBe(v1);
  });
});

describe('createSettingsStore', () => {
  it('loads, validates and persists', () => {
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, fov: 300, lastSeed: 'x' }));
    const store = createSettingsStore(st);
    expect(store.get().fov).toBe(90);
    store.set({ fov: 55 });
    expect(JSON.parse(st.getItem(SETTINGS_KEY) as string).fov).toBe(55);
    expect(createSettingsStore(st).get().fov).toBe(55);
  });
  it('corrupt JSON or null storage -> defaults', () => {
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY, '{nope');
    expect(createSettingsStore(st).get()).toEqual(DEFAULT_SETTINGS);
    const mem = createSettingsStore(null);
    mem.set({ fov: 60 });
    expect(mem.get().fov).toBe(60);
  });
  it('patches are clamped, nested groups merge, overrides replace', () => {
    const store = createSettingsStore(new MemStorage());
    store.set({ volume: { master: 5 } as Settings['volume'] });
    expect(store.get().volume).toEqual({ ...DEFAULT_SETTINGS.volume, master: 1 });
    store.set({ film: { camcorder: true } as Settings['film'] });
    expect(store.get().film).toEqual({ ...DEFAULT_SETTINGS.film, camcorder: true });
    store.set({ overrides: { renderScale: 0.7 } });
    store.set({ overrides: { dynamicResolution: false } });
    expect(store.get().overrides).toEqual({ dynamicResolution: false });
  });
  it('keeps one live object; subscribers fire once per effective change; unsubscribe works', () => {
    const store = createSettingsStore(new MemStorage());
    const obj = store.get();
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.fov));
    store.set({ fov: 70 });
    store.set({ fov: 70 }); // no change -> no notification
    store.set({ fov: 999 }); // clamped to 90
    expect(seen).toEqual([70, 90]);
    expect(store.get()).toBe(obj);
    expect(obj.fov).toBe(90);
    off();
    store.set({ fov: 60 });
    expect(seen).toEqual([70, 90]);
  });
  it('storage write failures keep the value in memory', () => {
    const st = new MemStorage();
    const store = createSettingsStore(st);
    st.failWrites = true;
    expect(() => store.set({ fov: 66 })).not.toThrow();
    expect(store.get().fov).toBe(66);
  });
});

describe('createContinueStore', () => {
  const p = { seedText: '1234-5678', s: 1 as const, x: 10.5, y: 0, z: -4, yaw: 1.2, savedAt: 1000 };
  it('save / load / clear', () => {
    const st = new MemStorage();
    const cs = createContinueStore(st);
    expect(cs.load()).toBeNull();
    cs.save(p);
    expect(cs.load()).toEqual(p);
    expect(JSON.parse(st.getItem(CONTINUE_KEY) as string).seedText).toBe('1234-5678');
    cs.clear();
    expect(cs.load()).toBeNull();
  });
  it('rejects invalid points', () => {
    const st = new MemStorage();
    const cs = createContinueStore(st);
    for (const bad of [{ ...p, s: 3 }, { ...p, x: NaN }, { ...p, seedText: '' }, { ...p, z: 1e9 }]) {
      st.setItem(CONTINUE_KEY, JSON.stringify(bad));
      expect(cs.load()).toBeNull();
    }
    st.setItem(CONTINUE_KEY, '{broken');
    expect(cs.load()).toBeNull();
    cs.save({ ...p, yaw: Infinity });
    expect(cs.load()).toBeNull(); // the invalid save did not overwrite with garbage
  });
  it('null storage is inert', () => {
    const cs = createContinueStore(null);
    cs.save(p);
    expect(cs.load()).toBeNull();
    expect(() => cs.clear()).not.toThrow();
  });
});

describe('R2 (B7) settings', () => {
  it('defaults: cameraShake 0.5, walkSpeed normal, sensitivity 0.0014 (~14 cm/360 at 800 dpi)', () => {
    expect(DEFAULT_SETTINGS.cameraShake).toBe(0.5);
    expect(DEFAULT_SETTINGS.walkSpeed).toBe('normal');
    expect(DEFAULT_SETTINGS.mouseSensitivity).toBe(0.0014);
    const cm = ((2 * Math.PI) / DEFAULT_SETTINGS.mouseSensitivity / 800) * 2.54;
    expect(cm).toBeGreaterThan(13.5);
    expect(cm).toBeLessThan(15);
  });
  it('cameraShake clamps, walkSpeed falls back', () => {
    expect(validateSettings({ version: 1, cameraShake: 3 }).cameraShake).toBe(1);
    expect(validateSettings({ version: 1, cameraShake: -1 }).cameraShake).toBe(0);
    expect(validateSettings({ version: 1, walkSpeed: 'brisk' }).walkSpeed).toBe('brisk');
    expect(validateSettings({ version: 1, walkSpeed: 'jog' }).walkSpeed).toBe('normal');
  });
  it('pre-R2 settings: the untouched old sensitivity default migrates, chosen values stay', () => {
    expect(validateSettings({ version: 1, mouseSensitivity: 0.0022, fov: 70 }).mouseSensitivity).toBe(0.0014);
    expect(validateSettings({ version: 1, mouseSensitivity: 0.003 }).mouseSensitivity).toBe(0.003);
    expect(validateSettings({ sensitivity: 0.0022 }).mouseSensitivity).toBe(0.0014); // v0 too
    // written by an R2 build (has cameraShake): 0.0022 was chosen on purpose
    expect(validateSettings({ version: 1, mouseSensitivity: 0.0022, cameraShake: 0.5 }).mouseSensitivity).toBe(0.0022);
  });
});

describe('R2 (B7) tape log', () => {
  it('per-seed save / load; unknown seed = empty log', () => {
    const st = new MemStorage();
    const ts = createTapeLogStore(st);
    expect(ts.load('a')).toMatchObject({ zones: 0, landmarks: [], storeys: 0, metres: 0, seconds: 0 });
    ts.save('a', { zones: 0b101, landmarks: [3, 0, 3], storeys: 1, metres: 412.5, seconds: 90, updatedAt: 0 });
    ts.save('b', { zones: 1, landmarks: [], storeys: 4, metres: 1, seconds: 2, updatedAt: 0 });
    const a = createTapeLogStore(st).load('a');
    expect(a).toMatchObject({ zones: 0b101, landmarks: [0, 3], storeys: 1, metres: 412.5, seconds: 90 });
    expect(a.updatedAt).toBeGreaterThan(0);
    expect(createTapeLogStore(st).load('b').storeys).toBe(4);
  });
  it('validates garbage and keeps at most TAPE_LOG_MAX seeds', () => {
    expect(validateTapeLog(null)).toBeNull();
    expect(validateTapeLog({ zones: -5, landmarks: ['x', 2.5, 7], metres: NaN, seconds: 1e20 })).toMatchObject({ zones: 0, landmarks: [7], metres: 0, seconds: 1e9 });
    const st = new MemStorage();
    st.setItem(TAPE_LOG_KEY, '{broken');
    const ts = createTapeLogStore(st);
    expect(ts.load('x').zones).toBe(0);
    for (let i = 0; i < TAPE_LOG_MAX + 5; i++) ts.save(`seed-${i}`, { zones: i, landmarks: [], storeys: 0, metres: 0, seconds: 0, updatedAt: 0 });
    expect(Object.keys(JSON.parse(st.getItem(TAPE_LOG_KEY) as string)).length).toBe(TAPE_LOG_MAX);
    expect(() => createTapeLogStore(null).save('a', validateTapeLog({})!)).not.toThrow();
  });
});
