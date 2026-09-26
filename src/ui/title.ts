// src/ui/title.ts (WP14) — title screen over the attract mode: CONTINUE / ENTER / SEED [____] ↻ / CAMCORDER on|off /
// SETTINGS / CONTROLS / FULLSCREEN, a photosensitivity line, a camcorder-style OSD, and the compact loading phase
// list while the world boots. The seed field is part of the arrow-key navigation (R2, B7).

import { clockText, el, menuItem, navigable, tapeDate } from './dom.ts';
import type { UiSound } from './dom.ts';
import type { PhaseList } from './loading.ts';

export interface TitleContinue { seedText: string; storeyName: string }

export interface TitleCallbacks {
  onEnter(): void;
  onContinue(): void;
  /** committed seed text (Enter in the field or ↻); the app regenerates the world */
  onSeed(seedText: string): void;
  /** a fresh random seed for ↻ */
  randomSeed(): string;
  onSettings(): void;
  onControls(): void;
  /** camcorder OSD setting (read for the row label, toggled by the row) */
  camcorder(): boolean;
  onCamcorder(): void;
  onFullscreen(): void;
  sound(s: UiSound): void;
}

export interface TitleScreen {
  readonly el: HTMLElement;
  show(instant?: boolean): void;
  hide(): void;
  readonly visible: boolean;
  /** world ready (ENTER label changes from LOADING) */
  setReady(r: boolean): void;
  setContinue(c: TitleContinue | null): void;
  /** mounts the phase list in the status slot (null removes it) */
  setStatus(list: PhaseList | null): void;
  /** suspend key handling while an overlaid panel is open */
  setInteractive(on: boolean): void;
  /** re-read the camcorder row; fullscreen label */
  refresh(fullscreen: boolean): void;
  /** a line under the photosensitivity notice (integrated-GPU hint); null hides it */
  setGpuNote(text: string | null): void;
}

export function createTitle(seedText: string, cb: TitleCallbacks, storeyName = 'Level 0'): TitleScreen {
  const root = el('div', 'br-screen br-title br-scan');
  const head = el('div', 'br-title-head');
  const logo = el('h1', 'br-logo', 'Backrooms');
  const sub = el('div', 'br-sub');
  sub.append('Tape ', el('b', '', seedText || '—'), ` · ${storeyName}`);
  head.append(logo, sub);

  const menu = el('div', 'br-menu');
  const cont = menuItem('Continue');
  const enter = menuItem('Enter', 'loading');
  const seedRow = el('div', 'br-item br-seedrow');
  seedRow.append(el('span', 'br-mark', '▸'), el('span', 'br-label', 'Seed'));
  const seed = el('input', 'br-seed');
  seed.type = 'text';
  seed.value = seedText;
  seed.maxLength = 64;
  seed.spellcheck = false;
  seed.autocomplete = 'off';
  seed.setAttribute('aria-label', 'World seed');
  const reroll = el('button', 'br-reroll', '↻');
  reroll.type = 'button';
  reroll.title = 'New random seed';
  const hint = el('span', 'br-hint', '⏎ load tape');
  seedRow.append(seed, reroll, hint);
  const camcorder = menuItem('Camcorder', cb.camcorder() ? 'on' : 'off');
  const settings = menuItem('Settings');
  const controls = menuItem('Controls');
  const fullscreen = menuItem('Fullscreen', 'off');
  menu.append(cont.btn, enter.btn, seedRow, camcorder.btn, settings.btn, controls.btn, fullscreen.btn);

  const warning = el('div', 'br-warning',
    'Photosensitivity: this contains flickering lights and brief flashes. Reduce or switch them off in Settings › Comfort.');
  const gpuNote = el('div', 'br-gpu-note');
  gpuNote.hidden = true;
  warning.append(gpuNote);
  const osdTr = el('div', 'br-osd-tr');
  osdTr.innerHTML = 'Play ▶<br>SP';
  const osdBr = el('div', 'br-osd-br');
  const status = el('div', 'br-status');
  root.append(head, menu, warning, osdTr, status, osdBr);

  let visible = false;
  let interactive = true;
  const tickDate = (): void => {
    const now = new Date();
    osdBr.innerHTML = `${clockText(now)}<br>${tapeDate(seedText, now)}`;
  };
  tickDate();
  setInterval(() => { if (visible) tickDate(); }, 15000);

  const buttons = (): (HTMLButtonElement | HTMLInputElement)[] => [cont.btn, enter.btn, seed, camcorder.btn, settings.btn, controls.btn, fullscreen.btn];
  const nav = navigable(buttons, () => visible && interactive, cb.sound);

  cont.btn.hidden = true;
  cont.btn.addEventListener('click', () => { cb.sound('click'); cb.onContinue(); });
  enter.btn.addEventListener('click', () => { cb.sound('click'); cb.onEnter(); });
  settings.btn.addEventListener('click', () => { cb.sound('open'); cb.onSettings(); });
  controls.btn.addEventListener('click', () => { cb.sound('open'); cb.onControls(); });
  camcorder.btn.addEventListener('click', () => {
    cb.sound('click');
    cb.onCamcorder();
    camcorder.setDetail(cb.camcorder() ? 'on' : 'off');
  });
  fullscreen.btn.addEventListener('click', () => { cb.sound('click'); cb.onFullscreen(); });

  const commitSeed = (): void => {
    const v = seed.value.trim();
    hint.classList.remove('is-on');
    if (v === '') { seed.value = seedText; return; }
    if (v !== seedText) { cb.sound('click'); cb.onSeed(v); }
  };
  seed.addEventListener('input', () => hint.classList.toggle('is-on', seed.value.trim() !== seedText && seed.value.trim() !== ''));
  seed.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitSeed(); }
    else if (e.key === 'Escape') { seed.value = seedText; hint.classList.remove('is-on'); seed.blur(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!interactive) return;
      e.preventDefault();
      if (seed.value.trim() === '') seed.value = seedText;
      nav.move(e.key === 'ArrowDown' ? 1 : -1);
    }
  });
  seed.addEventListener('blur', () => { if (seed.value.trim() === '') seed.value = seedText; });
  reroll.addEventListener('click', () => {
    seed.value = cb.randomSeed();
    commitSeed();
  });

  return {
    el: root,
    show(instant = false) {
      root.classList.toggle('is-instant', instant);
      root.classList.add('is-open');
      visible = true;
      tickDate();
      requestAnimationFrame(() => { root.classList.remove('is-instant'); nav.focusFirst(); });
    },
    hide() {
      root.classList.remove('is-open');
      visible = false;
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    get visible() { return visible; },
    setReady(r) {
      enter.setDetail(r ? '' : 'loading');
    },
    setContinue(c) {
      cont.btn.hidden = c === null;
      if (c) cont.setDetail(`${c.seedText} · ${c.storeyName}`);
      if (visible) nav.focusFirst();
    },
    setGpuNote(text) {
      gpuNote.textContent = text ?? '';
      gpuNote.hidden = text === null;
    },
    setStatus(list) {
      status.innerHTML = '';
      if (list) { list.setCompact(true); status.append(list.el); }
    },
    setInteractive(on) {
      interactive = on;
      if (on && visible) nav.focusFirst();
    },
    refresh(fs) {
      camcorder.setDetail(cb.camcorder() ? 'on' : 'off');
      fullscreen.setDetail(fs ? 'on' : 'off');
    },
  };
}
