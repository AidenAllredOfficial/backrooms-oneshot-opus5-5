// src/ui/dom.ts (WP14, private) — tiny DOM helpers shared by the UI screens (no framework).

export type UiSound = 'hover' | 'click' | 'open' | 'close';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A menu entry: a <button> with a marker, label and optional right-aligned detail. */
export function menuItem(label: string, detail?: string): { btn: HTMLButtonElement; setDetail(d: string): void; setLabel(l: string): void } {
  const btn = el('button', 'br-item');
  btn.type = 'button';
  const mark = el('span', 'br-mark', '▸');
  const lab = el('span', 'br-label', label);
  const det = el('span', 'br-detail', detail ?? '');
  btn.append(mark, lab, det);
  return { btn, setDetail: (d) => { det.textContent = d; }, setLabel: (l) => { lab.textContent = l; } };
}

/**
 * Keyboard + mouse navigation over a vertical list of buttons (arrow keys / W,S move, Enter/Space activate).
 * `isActive` gates the global key listener (only the visible screen reacts). An item may also be a text input
 * (the title's seed field): it is focused like a button, its row (closest .br-item) gets the marker, and the
 * input itself calls move(+-1) on ArrowUp / ArrowDown (W / S type letters there).
 */
export function navigable(items: () => (HTMLButtonElement | HTMLInputElement)[], isActive: () => boolean, sound: (s: UiSound) => void): {
  focusFirst(): void; move(delta: number): void; dispose(): void;
} {
  let idx = 0;
  const row = (b: HTMLElement): HTMLElement => (b.closest('.br-item') as HTMLElement | null) ?? b;
  const enabled = (): (HTMLButtonElement | HTMLInputElement)[] => items().filter((b) => !b.disabled && b.offsetParent !== null);
  const focus = (i: number): void => {
    const list = enabled();
    if (list.length === 0) return;
    idx = (i + list.length) % list.length;
    for (const b of items()) row(b).classList.remove('is-active');
    row(list[idx]).classList.add('is-active');
    list[idx].focus({ preventScroll: true });
  };
  const sync = (): void => {
    const cur = enabled().indexOf(document.activeElement as HTMLButtonElement);
    if (cur >= 0) idx = cur;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    sync();
    if (e.code === 'ArrowDown' || e.code === 'KeyS') { focus(idx + 1); sound('hover'); e.preventDefault(); }
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') { focus(idx - 1); sound('hover'); e.preventDefault(); }
  };
  const onOver = (e: Event): void => {
    const b = (e.target as HTMLElement).closest?.('button');
    if (!b || !isActive()) return;
    const list = enabled();
    const i = list.indexOf(b as HTMLButtonElement);
    if (i >= 0 && i !== idx) { focus(i); sound('hover'); }
  };
  window.addEventListener('keydown', onKey);
  document.addEventListener('mouseover', onOver);
  return {
    focusFirst: () => focus(0),
    move: (d) => { sync(); focus(idx + d); sound('hover'); },
    dispose: () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mouseover', onOver);
    },
  };
}

/** Camcorder-style date stamp ("SEP 24 1996") for a fictional year derived from the seed. */
export function tapeDate(seedText: string, now: Date): string {
  let h = 0;
  for (let i = 0; i < seedText.length; i++) h = (h * 31 + seedText.charCodeAt(i)) >>> 0;
  const year = 1989 + (h % 11);
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][now.getMonth()];
  return `${m} ${String(now.getDate()).padStart(2, '0')} ${year}`;
}

export function clockText(now: Date): string {
  const h = now.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(now.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** h:mm:ss tape counter */
export function timecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
