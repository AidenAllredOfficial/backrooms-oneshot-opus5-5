// src/ui/settingsPanel.ts (WP14) — settings (Video / Film / Comfort / Audio / Controls) and the key reference sheet.
// R2 (B7): Film split from Video (nothing clips at 1366x768), Fullscreen row, camera shake + walk pace (Comfort), a
// log-scale mouse sensitivity slider with a cm/360 readout, a scroll fade when a tab overflows, and the key sheet
// lists debug keys only with debug=1.
// Every control writes through the SettingsStore immediately (changes apply live); the app decides what needs a
// reload (texture size) and reports it with setNotice().

import { DEFAULT_SETTINGS } from '../core/settings.ts';
import type { Settings } from '../core/settings.ts';
import type { SettingsStore } from '../app/settingsStore.ts';
import { SETTINGS_RANGES } from '../app/settingsStore.ts';
import { el } from './dom.ts';
import type { UiSound } from './dom.ts';

export interface SettingsPanelCallbacks {
  sound(s: UiSound): void;
  onClose(): void;
  /** preset name that 'auto' currently resolves to (e.g. 'high') */
  autoQuality(): string;
  /** render scale of the selected preset (used when there is no override) */
  presetRenderScale(): number;
  presetDynamicResolution(): boolean;
  onReload(): void;
  /** fullscreen state + toggle (Video tab) */
  fullscreen(): boolean;
  setFullscreen(on: boolean): void;
  /** debug=1: the key sheet also lists the debug keys */
  debugKeys: boolean;
}

export interface SettingsPanel {
  readonly el: HTMLElement;
  open(mode: 'settings' | 'keys'): void;
  close(): void;
  readonly visible: boolean;
  setNotice(msg: string | null, reload?: boolean): void;
  refresh(): void;
}

type Tab = 'video' | 'film' | 'comfort' | 'audio' | 'controls';

interface RangeRow {
  kind: 'range'; label: string; min: number; max: number; step: number;
  get(s: Settings): number; set(v: number, s: Settings): Partial<Settings>; fmt(v: number): string; note?: string;
  /** logarithmic slider (min > 0): the thumb moves in log(value) */
  log?: boolean;
}
interface SegRow {
  kind: 'seg'; label: string; options: readonly (readonly [string, string])[];
  /** a patch for the store, or null when the row acts outside the settings (fullscreen) */
  get(s: Settings): string; set(v: string, s: Settings): Partial<Settings> | null; note?: string | ((s: Settings) => string);
}
interface GroupRow { kind: 'group'; label: string }
type Row = RangeRow | SegRow | GroupRow;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const onOff = [['on', 'On'], ['off', 'Off']] as const;
const holdToggle = [['hold', 'Hold'], ['toggle', 'Toggle']] as const;

export const KEYS: readonly (readonly [string, string])[] = [
  ['W A S D / arrows', 'Walk'],
  ['Mouse', 'Look'],
  ['Shift', 'Run (hold or toggle, see Comfort)'],
  ['C', 'Crouch (Ctrl too, in fullscreen)'],
  ['F', 'Flashlight'],
  ['E', 'Use: doors, phones, radios'],
  ['Esc', 'Pause menu'],
  ['Gamepad', 'Sticks walk / look · A use · X flashlight'],
  ['', 'B crouch · RT or L3 run · Start pause'],
];
export const DEBUG_KEYS: readonly (readonly [string, string])[] = [
  ['F3', 'Debug overlay'],
  ['F4', 'Cycle debug view'],
  ['Space', 'Ascend (fly=1)'],
];

/** One mouse count at `sens` rad/count: centimetres of mouse travel per 360 degrees at `dpi`. */
export function cmPer360(sens: number, dpi = 800): number {
  return sens > 0 ? ((2 * Math.PI) / sens / dpi) * 2.54 : Infinity;
}

export function createSettingsPanel(store: SettingsStore, cb: SettingsPanelCallbacks): SettingsPanel {
  const R = SETTINGS_RANGES;
  const film = (k: keyof Settings['film'], v: number | boolean, s: Settings): Partial<Settings> => ({ film: { ...s.film, [k]: v } });
  const vol = (k: keyof Settings['volume'], v: number, s: Settings): Partial<Settings> => ({ volume: { ...s.volume, [k]: v } });

  const TABS: Record<Tab, Row[]> = {
    video: [
      { kind: 'group', label: 'Rendering' },
      {
        kind: 'seg', label: 'Quality', options: [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']],
        get: (s) => s.quality, set: (v) => ({ quality: v as Settings['quality'] }),
        note: (s) => (s.quality === 'auto' ? `Auto selected ${cb.autoQuality().toUpperCase()} for this GPU.` : ''),
      },
      {
        kind: 'range', label: 'Render scale', min: R.renderScale[0], max: 1.5, step: 0.05,
        get: (s) => s.overrides.renderScale ?? cb.presetRenderScale(),
        set: (v, s) => ({ overrides: { ...s.overrides, renderScale: v } }), fmt: pct,
      },
      {
        kind: 'seg', label: 'Dynamic resolution', options: onOff,
        get: (s) => ((s.overrides.dynamicResolution ?? cb.presetDynamicResolution()) ? 'on' : 'off'),
        set: (v, s) => ({ overrides: { ...s.overrides, dynamicResolution: v === 'on' } }),
      },
      {
        kind: 'range', label: 'Field of view', min: R.fov[0], max: R.fov[1], step: 1,
        get: (s) => s.fov, set: (v) => ({ fov: v }), fmt: (v) => `${Math.round(v)}°`,
      },
      {
        kind: 'range', label: 'Brightness', min: R.brightnessEV[0], max: R.brightnessEV[1], step: 0.1,
        get: (s) => s.brightnessEV, set: (v) => ({ brightnessEV: Math.round(v * 10) / 10 }),
        fmt: (v) => `${v > 0.04 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} EV`,
      },
      { kind: 'group', label: 'Display' },
      {
        kind: 'seg', label: 'Fullscreen', options: onOff, get: () => (cb.fullscreen() ? 'on' : 'off'),
        set: (v) => { cb.setFullscreen(v === 'on'); return null; },
        note: 'Fullscreen also captures Ctrl, so it can crouch without closing the tab.',
      },
    ],
    film: [
      { kind: 'group', label: 'Camcorder' },
      {
        kind: 'seg', label: 'Camcorder', options: onOff, get: (s) => (s.film.camcorder ? 'on' : 'off'), set: (v, s) => film('camcorder', v === 'on', s),
        note: 'REC overlay, tape counter and date stamp; a looser handheld grip.',
      },
      { kind: 'group', label: 'Lens and film' },
      { kind: 'range', label: 'Grain', min: 0, max: 1, step: 0.05, get: (s) => s.film.grain, set: (v, s) => film('grain', v, s), fmt: pct },
      { kind: 'range', label: 'Chromatic aberration', min: 0, max: 1, step: 0.05, get: (s) => s.film.chromaticAberration, set: (v, s) => film('chromaticAberration', v, s), fmt: pct },
      { kind: 'range', label: 'Vignette', min: 0, max: 1, step: 0.05, get: (s) => s.film.vignette, set: (v, s) => film('vignette', v, s), fmt: pct },
      { kind: 'range', label: 'Lens distortion', min: 0, max: 1, step: 0.05, get: (s) => s.film.distortion, set: (v, s) => film('distortion', v, s), fmt: pct },
    ],
    comfort: [
      { kind: 'group', label: 'Motion' },
      { kind: 'range', label: 'Head bob', min: 0, max: 1, step: 0.05, get: (s) => s.headBob, set: (v) => ({ headBob: v }), fmt: pct },
      {
        kind: 'range', label: 'Camera shake', min: 0, max: 1, step: 0.05, get: (s) => s.cameraShake, set: (v) => ({ cameraShake: v }), fmt: pct,
        note: 'Handheld sway of the camera. 0% holds it perfectly still.',
      },
      {
        kind: 'seg', label: 'Walk pace', options: [['slow', 'Slow'], ['normal', 'Normal'], ['brisk', 'Brisk']],
        get: (s) => s.walkSpeed, set: (v) => ({ walkSpeed: v as Settings['walkSpeed'] }),
        note: (s) => `${s.walkSpeed === 'slow' ? '1.45' : s.walkSpeed === 'brisk' ? '2.0' : '1.75'} m/s walking · running 4.0 m/s.`,
      },
      { kind: 'group', label: 'Photosensitivity' },
      {
        kind: 'seg', label: 'Flickering lights', options: [['standard', 'Standard'], ['reduced', 'Reduced'], ['off', 'Off']],
        get: (s) => s.flicker, set: (v) => ({ flicker: v as Settings['flicker'] }),
        note: (s) => s.flicker === 'standard'
          ? 'Standard stays under 3 flashes per second (WCAG 2.3.1).'
          : s.flicker === 'reduced' ? 'Reduced: shallow dips, at most 2 per second, no lens strobe.' : 'Off: every light burns steadily.',
      },
      { kind: 'group', label: 'Input' },
      { kind: 'seg', label: 'Sprint', options: holdToggle, get: (s) => (s.toggleSprint ? 'toggle' : 'hold'), set: (v) => ({ toggleSprint: v === 'toggle' }) },
      { kind: 'seg', label: 'Crouch', options: holdToggle, get: (s) => (s.toggleCrouch ? 'toggle' : 'hold'), set: (v) => ({ toggleCrouch: v === 'toggle' }) },
    ],
    audio: [
      { kind: 'group', label: 'Volume' },
      { kind: 'range', label: 'Master', min: 0, max: 1, step: 0.05, get: (s) => s.volume.master, set: (v, s) => vol('master', v, s), fmt: pct },
      { kind: 'range', label: 'Ambience', min: 0, max: 1, step: 0.05, get: (s) => s.volume.ambience, set: (v, s) => vol('ambience', v, s), fmt: pct },
      { kind: 'range', label: 'Fluorescent hum', min: 0, max: 1, step: 0.05, get: (s) => s.volume.hum, set: (v, s) => vol('hum', v, s), fmt: pct },
      { kind: 'range', label: 'Effects', min: 0, max: 1, step: 0.05, get: (s) => s.volume.sfx, set: (v, s) => vol('sfx', v, s), fmt: pct },
      { kind: 'range', label: 'Interface', min: 0, max: 1, step: 0.05, get: (s) => s.volume.ui, set: (v, s) => vol('ui', v, s), fmt: pct },
      { kind: 'group', label: 'Electrical' },
      {
        kind: 'seg', label: 'Mains frequency', options: [['50', '50 Hz'], ['60', '60 Hz']],
        get: (s) => String(s.mainsHz), set: (v) => ({ mainsHz: v === '50' ? 50 : 60 }),
        note: (s) => `Ballasts hum at ${s.mainsHz * 2} Hz.`,
      },
    ],
    controls: [
      { kind: 'group', label: 'Mouse' },
      {
        kind: 'range', label: 'Sensitivity', min: R.mouseSensitivity[0], max: R.mouseSensitivity[1], step: 0.001, log: true,
        get: (s) => s.mouseSensitivity, set: (v) => ({ mouseSensitivity: Math.round(v * 1e6) / 1e6 }),
        fmt: (v) => `${(v / DEFAULT_SETTINGS.mouseSensitivity).toFixed(2)}×`,
        note: 'cm360',
      },
      { kind: 'seg', label: 'Invert Y', options: onOff, get: (s) => (s.invertY ? 'on' : 'off'), set: (v) => ({ invertY: v === 'on' }) },
    ],
  };
  const TAB_NAMES: Record<Tab, string> = { video: 'Video', film: 'Film', comfort: 'Comfort', audio: 'Audio', controls: 'Controls' };

  // ---- DOM
  const wrap = el('div', 'br-screen br-panel-wrap');
  const panel = el('div', 'br-panel');
  const title = el('div', 'br-panel-title');
  const titleText = el('span', '', 'Settings');
  title.append(titleText, el('small', '', 'Esc to close'));
  const tabs = el('div', 'br-tabs');
  const rows = el('div', 'br-rows');
  const foot = el('div', 'br-panel-foot');
  const notice = el('div', 'br-notice');
  const reload = el('button', 'br-btn is-accent', 'Reload now');
  reload.type = 'button';
  reload.hidden = true;
  const reset = el('button', 'br-btn', 'Defaults');
  reset.type = 'button';
  const back = el('button', 'br-btn', 'Back');
  back.type = 'button';
  foot.append(notice, reload, reset, back);
  panel.append(title, tabs, rows, foot);
  wrap.append(panel);

  let visible = false;
  let tab: Tab = 'video';
  let mode: 'settings' | 'keys' = 'settings';
  let updaters: (() => void)[] = [];
  const tabBtns = new Map<Tab, HTMLButtonElement>();

  for (const t of Object.keys(TABS) as Tab[]) {
    const b = el('button', 'br-tab', TAB_NAMES[t]);
    b.type = 'button';
    b.addEventListener('click', () => { if (tab !== t) { cb.sound('click'); select(t); } });
    b.addEventListener('mouseenter', () => cb.sound('hover'));
    tabs.append(b);
    tabBtns.set(t, b);
  }

  const buildRange = (r: RangeRow, row: HTMLElement, noteEl: HTMLElement | null): void => {
    const input = el('input', 'br-range');
    input.type = 'range';
    const lk = r.log ? Math.log(r.max / r.min) : 0;
    const toPos = (v: number): number => (r.log ? Math.log(Math.max(r.min, v) / r.min) / lk : (v - r.min) / (r.max - r.min));
    const fromPos = (p: number): number => (r.log ? r.min * Math.exp(p * lk) : r.min + p * (r.max - r.min));
    input.min = r.log ? '0' : String(r.min);
    input.max = r.log ? '1' : String(r.max);
    input.step = String(r.step);
    input.setAttribute('aria-label', r.label);
    const value = el('div', 'br-row-value');
    const update = (): void => {
      const v = r.get(store.get());
      input.value = String(r.log ? toPos(v) : v);
      value.textContent = r.fmt(v);
      input.style.setProperty('--fill', `${(toPos(v) * 100).toFixed(1)}%`);
      if (noteEl && r.note === 'cm360') noteEl.textContent = `${Math.round(cmPer360(v))} cm per 360° at 800 dpi · ${Math.round(cmPer360(v, 1600))} cm at 1600 dpi`;
    };
    input.addEventListener('input', () => {
      const v = r.log ? fromPos(Number(input.value)) : Number(input.value);
      store.set(r.set(v, store.get()));
      update();
    });
    input.addEventListener('change', () => cb.sound('click'));
    row.append(input, value);
    updaters.push(update);
    update();
  };

  const buildSeg = (r: SegRow, row: HTMLElement, noteEl: HTMLElement | null): void => {
    const seg = el('div', 'br-seg');
    const btns = r.options.map(([v, label]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        cb.sound('click');
        const patch = r.set(v, store.get());
        if (patch) store.set(patch);
        refresh();
      });
      seg.append(b);
      return [v, b] as const;
    });
    row.append(seg, el('div', 'br-row-value'));
    const update = (): void => {
      const s = store.get();
      const cur = r.get(s);
      for (const [v, b] of btns) b.classList.toggle('is-on', v === cur);
      if (noteEl) noteEl.textContent = typeof r.note === 'function' ? r.note(s) : r.note ?? '';
    };
    updaters.push(update);
    update();
  };

  const select = (t: Tab): void => {
    tab = t;
    for (const [k, b] of tabBtns) b.classList.toggle('is-active', k === t);
    rows.innerHTML = '';
    updaters = [];
    for (const r of TABS[t]) {
      if (r.kind === 'group') { rows.append(el('div', 'br-group', r.label)); continue; }
      const row = el('div', 'br-row');
      row.append(el('div', 'br-row-label', r.label));
      rows.append(row);
      const note = r.note !== undefined ? el('div', 'br-row-note') : null;
      if (note) { rows.append(note); if (typeof r.note === 'string' && r.note !== 'cm360') note.textContent = r.note; }
      if (r.kind === 'range') buildRange(r, row, note);
      else buildSeg(r, row, note);
    }
    rows.scrollTop = 0;
    requestAnimationFrame(updateFade);
  };

  // bottom fade while more rows are below the fold
  const updateFade = (): void => {
    rows.classList.toggle('is-more', rows.scrollHeight - rows.scrollTop - rows.clientHeight > 4);
  };
  rows.addEventListener('scroll', updateFade, { passive: true });
  window.addEventListener('resize', () => { if (visible) updateFade(); });

  const showKeys = (): void => {
    rows.innerHTML = '';
    updaters = [];
    const list = el('div', 'br-keys');
    for (const [k, v] of KEYS) list.append(el('kbd', '', k), el('span', '', v));
    rows.append(list);
    if (cb.debugKeys) {
      rows.append(el('div', 'br-group', 'Debug'));
      const dbg = el('div', 'br-keys');
      for (const [k, v] of DEBUG_KEYS) dbg.append(el('kbd', '', k), el('span', '', v));
      rows.append(dbg);
    }
    requestAnimationFrame(updateFade);
  };

  const refresh = (): void => { for (const u of updaters) u(); };

  const close = (): void => {
    if (!visible) return;
    wrap.classList.remove('is-open');
    visible = false;
    cb.sound('close');
    cb.onClose();
  };
  back.addEventListener('click', close);
  reload.addEventListener('click', () => cb.onReload());
  reset.addEventListener('click', () => {
    cb.sound('click');
    const d = DEFAULT_SETTINGS;
    store.set({
      quality: d.quality, overrides: {}, fov: d.fov, mouseSensitivity: d.mouseSensitivity, invertY: d.invertY, headBob: d.headBob,
      cameraShake: d.cameraShake, walkSpeed: d.walkSpeed,
      flicker: d.flicker, toggleSprint: d.toggleSprint, toggleCrouch: d.toggleCrouch, brightnessEV: d.brightnessEV,
      volume: { ...d.volume }, film: { ...d.film }, mainsHz: d.mainsHz,
    });
    refresh();
  });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  window.addEventListener('keydown', (e) => {
    if (!visible) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);

  return {
    el: wrap,
    open(m) {
      mode = m;
      panel.classList.toggle('is-single', m === 'keys');
      titleText.textContent = m === 'keys' ? 'Controls' : 'Settings';
      reset.hidden = m === 'keys';
      if (m === 'keys') showKeys();
      else select(tab);
      wrap.classList.add('is-open');
      visible = true;
      requestAnimationFrame(() => (m === 'keys' ? back : tabBtns.get(tab))?.focus({ preventScroll: true }));
    },
    close,
    get visible() { return visible; },
    setNotice(msg, withReload = false) {
      notice.textContent = msg ?? '';
      reload.hidden = !(msg && withReload);
    },
    refresh() { if (mode === 'settings') refresh(); },
  };
}
