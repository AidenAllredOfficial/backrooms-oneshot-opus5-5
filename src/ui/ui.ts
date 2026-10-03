// src/ui/ui.ts (WP14) — the DOM UI layer (no framework): black curtain, loading phase list, title, pause,
// settings panel, press-to-enter prompt, F3 overlay, HUD, toast and the error screen.
// Stacking (bottom -> top): canvas | HUD | curtain | loading | title | pause | settings | location | prompt | F3 | toast | error.

import './style.css';
import { createLocationPanel, type LocationPanel, type LocationPanelCallbacks } from './locationPanel.ts';
import { createCurtain } from './curtain.ts';
import type { SettingsStore } from '../app/settingsStore.ts';
import { el } from './dom.ts';
import { createLoadingScreen, createPhaseList } from './loading.ts';
import type { LoadingScreen, PhaseList } from './loading.ts';
import { createDebugOverlay, createHud } from './overlay.ts';
import type { DebugOverlay, Hud } from './overlay.ts';
import { createPause } from './pause.ts';
import type { PauseCallbacks, PauseScreen } from './pause.ts';
import { createSettingsPanel } from './settingsPanel.ts';
import type { SettingsPanel, SettingsPanelCallbacks } from './settingsPanel.ts';
import { createTitle } from './title.ts';
import type { TitleCallbacks, TitleScreen } from './title.ts';

export interface UIOptions {
  seedText: string;
  /** storey the launch starts in ('Level 0', 'Sublevel', 'Poolrooms'), shown under the title */
  storeyName: string;
  store: SettingsStore;
  title: TitleCallbacks;
  pause: Omit<PauseCallbacks, 'toast'>;
  settings: SettingsPanelCallbacks;
  location: LocationPanelCallbacks;
}

export interface UI {
  readonly layer: HTMLElement;
  readonly phases: PhaseList;
  readonly loading: LoadingScreen;
  readonly title: TitleScreen;
  readonly pause: PauseScreen;
  readonly settings: SettingsPanel;
  readonly location: LocationPanel;
  readonly overlay: DebugOverlay;
  readonly hud: Hud;
  /** fades the black curtain (over the picture, under the menus) to `opacity` */
  curtain(opacity: number, ms: number): Promise<void>;
  showPrompt(label: string, onGo: () => void): void;
  hidePrompt(): void;
  toast(msg: string): void;
  /** the error screen; `action` replaces the default Retry (reload) button */
  error(title: string, message: string, detail?: string, action?: { label: string; run(): void }): void;
  /** hide every overlay (hud=0) */
  setHudHidden(hidden: boolean): void;
}

export function createUI(root: HTMLElement, o: UIOptions): UI {
  const layer = el('div', 'br-ui');
  const hud = createHud(o.seedText, (on) => layer.classList.toggle('has-rec', on));
  const curtainEl = el('div', 'br-curtain');
  const phases = createPhaseList();
  const loading = createLoadingScreen();
  const title = createTitle(o.seedText, o.title, o.storeyName);
  let toastTimer = 0;
  const toastEl = el('div', 'br-toast');
  const toast = (msg: string): void => {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('is-on'), 2600);
  };
  const pause = createPause({ ...o.pause, toast });
  const settings = createSettingsPanel(o.store, o.settings);
  const locationPanel = createLocationPanel(o.location);
  const overlay = createDebugOverlay();
  const prompt = el('div', 'br-screen br-press');
  const promptText = el('span');
  prompt.append(promptText);
  const errorEl = el('div', 'br-screen br-error');
  layer.append(hud.el, curtainEl, loading.el, title.el, pause.el, settings.el, locationPanel.el, prompt, overlay.el, toastEl, errorEl);
  root.append(layer);

  let promptGo: (() => void) | null = null;
  const go = (e: Event): void => {
    if (!promptGo) return;
    e.preventDefault();
    const f = promptGo;
    promptGo = null;
    prompt.classList.remove('is-open');
    f();
  };
  prompt.addEventListener('mousedown', go);
  // any key continues, except the ones the app handles itself (Esc pauses, F3/F4 debug)
  const PASS_KEYS = ['Escape', 'F3', 'F4'];
  window.addEventListener('keydown', (e) => { if (promptGo && !e.repeat && !PASS_KEYS.includes(e.code)) go(e); });

  return {
    layer, phases, loading, title, pause, settings, location: locationPanel, overlay, hud,
    curtain: createCurtain(curtainEl),
    showPrompt(label, onGo) {
      promptText.textContent = label;
      promptGo = onGo;
      prompt.classList.add('is-open');
    },
    hidePrompt() {
      promptGo = null;
      prompt.classList.remove('is-open');
    },
    toast,
    error(t, message, detail, action) {
      errorEl.innerHTML = '';
      const h = el('h1', '', 'Signal lost');
      const sub = el('p', '', t);
      sub.style.color = 'var(--br-amber)';
      const p = el('p', '', message);
      errorEl.append(h, sub, p);
      if (detail) errorEl.append(el('pre', '', detail));
      const retry = el('button', 'br-btn is-accent', action?.label ?? 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => (action ? action.run() : location.reload()));
      errorEl.append(retry);
      for (const s of [loading, title, pause]) s.hide();
      settings.close();
      locationPanel.hide();
      hud.hideTransient();
      promptGo = null;
      prompt.classList.remove('is-open');
      requestAnimationFrame(() => retry.focus({ preventScroll: true }));
      errorEl.classList.add('is-open');
    },
    setHudHidden(hidden) {
      hud.setHidden(hidden);
      overlay.el.style.display = hidden ? 'none' : '';
    },
  };
}
