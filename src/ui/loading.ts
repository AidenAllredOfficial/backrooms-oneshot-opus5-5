// src/ui/loading.ts (WP14) — the loading phase list (textures, shaders, world, lighting) with progress.
// One instance is shown full-screen (autostart / entering before ready) or compact inside the title.

import { el } from './dom.ts';

export const LOAD_PHASES = ['textures', 'shaders', 'world', 'lighting'] as const;
export type LoadPhaseName = (typeof LOAD_PHASES)[number];

export interface PhaseList {
  readonly el: HTMLElement;
  setPhase(p: LoadPhaseName): void;
  setProgress(p: LoadPhaseName, fraction: number): void;
  /** every phase done */
  complete(): void;
  setCompact(c: boolean): void;
}

export function createPhaseList(): PhaseList {
  const root = el('div', 'br-phases');
  const rows = LOAD_PHASES.map((name) => {
    const n = el('div', 'br-phase br-phase-name', name);
    const bar = el('div', 'br-phase br-phase-bar');
    const fill = el('div', 'br-phase-fill');
    bar.append(fill);
    const pct = el('div', 'br-phase br-phase-pct', '');
    root.append(n, bar, pct);
    return { name, parts: [n, bar, pct], fill, pct, frac: 0 };
  });
  let current = -1;
  const mark = (): void => {
    rows.forEach((r, i) => {
      for (const p of r.parts) {
        p.classList.toggle('is-active', i === current);
        p.classList.toggle('is-done', i < current || r.frac >= 1);
      }
      if (i < current && r.frac < 1) setFrac(i, 1);
    });
  };
  const setFrac = (i: number, f: number): void => {
    const r = rows[i];
    r.frac = Math.max(r.frac, Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)));
    r.fill.style.width = `${(r.frac * 100).toFixed(1)}%`;
    r.pct.textContent = r.frac >= 1 ? 'OK' : `${Math.floor(r.frac * 100)}%`;
  };
  return {
    el: root,
    setPhase(p) {
      const i = LOAD_PHASES.indexOf(p);
      if (i < 0 || i < current) return;
      current = i;
      mark();
    },
    setProgress(p, f) {
      const i = LOAD_PHASES.indexOf(p);
      if (i < 0) return;
      if (i > current) { current = i; }
      setFrac(i, f);
      mark();
    },
    complete() {
      rows.forEach((_r, i) => setFrac(i, 1));
      current = rows.length;
      mark();
    },
    setCompact(c) { root.classList.toggle('is-compact', c); },
  };
}

export interface LoadingScreen {
  readonly el: HTMLElement;
  show(list: PhaseList, seedText: string): void;
  hide(instant?: boolean): void;
  readonly visible: boolean;
}

export function createLoadingScreen(): LoadingScreen {
  const root = el('div', 'br-screen br-loading br-scan');
  const head = el('div', 'br-loading-head');
  root.append(head);
  let visible = false;
  return {
    el: root,
    show(list, seedText) {
      head.innerHTML = '';
      head.append('Loading tape ', el('b', '', seedText || '—'));
      list.setCompact(false);
      if (list.el.parentElement !== root) root.append(list.el);
      root.classList.remove('is-instant');
      root.classList.add('is-open');
      visible = true;
    },
    hide(instant = false) {
      root.classList.toggle('is-instant', instant);
      root.classList.remove('is-open');
      visible = false;
    },
    get visible() { return visible; },
  };
}
