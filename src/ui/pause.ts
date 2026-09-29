// src/ui/pause.ts (WP14) — pause menu (Esc or pointer-lock loss): Resume, Settings, Controls, Fullscreen, Copy
// location link, Load location link, Debug menu, New tape, Quit to title. R2 (B7): the location line uses display names (coordinates on a small
// second line) and a tape log (zones / landmarks / storeys found, metres walked, tape time) sits on the right.

import { el, menuItem, navigable, timecode } from './dom.ts';
import type { UiSound } from './dom.ts';

export interface PauseInfo {
  /** 'Level 0 — Manila Rooms' */
  place: string;
  /** 's0 · x 51.0 z 19.8' */
  coords: string;
  log: { zones: [number, number]; landmarks: [number, number]; storeys: [number, number]; metres: number; seconds: number } | null;
}

export interface PauseCallbacks {
  onResume(): void;
  onSettings(): void;
  onControls(): void;
  onDebug(): void;
  onLoadLocation(): void;
  onFullscreen(): void;
  onNewTape(): void;
  /** returns the link to copy */
  locationLink(): string;
  onQuit(): void;
  toast(msg: string): void;
  sound(s: UiSound): void;
}

export interface PauseScreen {
  readonly el: HTMLElement;
  show(info: PauseInfo): void;
  /** fullscreen menu label */
  setFullscreen(on: boolean): void;
  hide(): void;
  readonly visible: boolean;
  setInteractive(on: boolean): void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function createPause(cb: PauseCallbacks): PauseScreen {
  const root = el('div', 'br-screen br-pause br-scan');
  const head = el('div', 'br-pause-head');
  head.append(el('span', 'br-pause-icon', '❚❚'), 'Pause');
  const loc = el('div', 'br-loc');
  const coords = el('div', 'br-coords');
  head.append(loc, coords);
  const menu = el('div', 'br-menu');
  const resume = menuItem('Resume', 'click');
  const settings = menuItem('Settings');
  const controls = menuItem('Controls');
  const fullscreen = menuItem('Fullscreen', 'off');
  const copy = menuItem('Copy location link');
  const load = menuItem('Load location link');
  const debug = menuItem('Debug menu', 'teleport');
  const newTape = menuItem('New tape', 'random seed');
  const quit = menuItem('Quit to title');
  const items = [resume.btn, settings.btn, controls.btn, fullscreen.btn, copy.btn, load.btn, debug.btn, newTape.btn, quit.btn];
  menu.append(...items);
  // tape log (right column)
  const log = el('div', 'br-tapelog');
  const logHead = el('div', 'br-tapelog-head', 'Tape log');
  const logGrid = el('div', 'br-tapelog-grid');
  log.append(logHead, logGrid);
  root.append(head, menu, log);

  let visible = false;
  let interactive = true;
  const nav = navigable(() => items, () => visible && interactive, cb.sound);

  resume.btn.addEventListener('click', () => { cb.sound('close'); cb.onResume(); });
  settings.btn.addEventListener('click', () => { cb.sound('open'); cb.onSettings(); });
  controls.btn.addEventListener('click', () => { cb.sound('open'); cb.onControls(); });
  load.btn.addEventListener('click', () => { cb.sound('open'); cb.onLoadLocation(); });
  debug.btn.addEventListener('click', () => { cb.sound('open'); cb.onDebug(); });
  fullscreen.btn.addEventListener('click', () => { cb.sound('click'); cb.onFullscreen(); });
  newTape.btn.addEventListener('click', () => { cb.sound('click'); cb.onNewTape(); });
  quit.btn.addEventListener('click', () => { cb.sound('click'); cb.onQuit(); });
  copy.btn.addEventListener('click', () => {
    cb.sound('click');
    const link = cb.locationLink();
    void copyText(link).then((ok) => {
      copy.setDetail(ok ? 'copied' : '');
      cb.toast(ok ? 'Location link copied' : link);
      setTimeout(() => copy.setDetail(''), 2500);
    });
  });

  return {
    el: root,
    show(info) {
      loc.textContent = info.place;
      coords.textContent = info.coords;
      logGrid.innerHTML = '';
      log.hidden = info.log === null;
      if (info.log) {
        const L = info.log;
        const row = (k: string, v: string): void => { logGrid.append(el('span', '', k), el('b', '', v)); };
        row('Zones seen', `${L.zones[0]} / ${L.zones[1]}`);
        row('Landmarks', `${L.landmarks[0]} / ${L.landmarks[1]}`);
        row('Storeys', `${L.storeys[0]} / ${L.storeys[1]}`);
        row('Walked', L.metres >= 1000 ? `${(L.metres / 1000).toFixed(2)} km` : `${Math.round(L.metres)} m`);
        row('Tape', timecode(L.seconds));
      }
      root.classList.add('is-open');
      visible = true;
      requestAnimationFrame(() => nav.focusFirst());
    },
    hide() {
      root.classList.remove('is-open');
      visible = false;
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    get visible() { return visible; },
    setFullscreen(on) { fullscreen.setDetail(on ? 'on' : 'off'); },
    setInteractive(on) {
      interactive = on;
      if (on && visible) nav.focusFirst();
    },
  };
}
