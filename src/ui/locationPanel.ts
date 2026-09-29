import { Storey, type StoreyId, type ZoneId } from '../core/ids.ts';
import { STRATA_WEIGHTS, ZONE_INFO } from '../core/zones.ts';
import { el, type UiSound } from './dom.ts';
import { storeyTitle, zoneTitle } from './names.ts';

type Mode = 'debug' | 'link';

export interface LocationPanelCallbacks {
  teleport(storey: StoreyId, zone: ZoneId | null): Promise<void>;
  loadLink(text: string): Promise<void>;
  onClose(): void;
  sound(s: UiSound): void;
}

export interface LocationPanel {
  readonly el: HTMLElement;
  readonly visible: boolean;
  open(mode: Mode, storey: StoreyId): void;
  /** Dismiss immediately when the app presents a fatal error, even during a pending load. */
  hide(): void;
}

export function createLocationPanel(cb: LocationPanelCallbacks): LocationPanel {
  const root = el('div', 'br-screen br-panel-wrap br-location-wrap');
  const panel = el('form', 'br-panel is-single br-location-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'br-location-title');
  const heading = el('div', 'br-panel-title');
  const title = el('span');
  title.id = 'br-location-title';
  heading.append(title, el('small', '', 'Esc back'));
  const body = el('div', 'br-location-body');
  const note = el('p', 'br-location-note');
  const destinations = el('div', 'br-location-destinations');
  const storeyLabel = el('label', 'br-location-field', 'Level');
  const storey = el('select', 'br-location-input');
  for (const s of Object.values(Storey)) storey.append(new Option(storeyTitle(s), String(s)));
  storeyLabel.append(storey);
  const zoneLabel = el('label', 'br-location-field', 'Zone');
  const zone = el('select', 'br-location-input');
  zoneLabel.append(zone);
  destinations.append(storeyLabel, zoneLabel);
  const linkLabel = el('label', 'br-location-field', 'Location link');
  const link = el('input', 'br-location-input');
  link.type = 'text';
  link.placeholder = 'https://…/?seed=7&s=2&x=…&z=…';
  link.autocomplete = 'off';
  link.spellcheck = false;
  linkLabel.append(link);
  body.append(note, destinations, linkLabel);
  const footer = el('div', 'br-panel-foot');
  const status = el('div', 'br-notice br-location-status');
  status.id = 'br-location-status';
  status.setAttribute('role', 'status');
  panel.setAttribute('aria-describedby', status.id);
  const back = el('button', 'br-btn', 'Back');
  back.type = 'button';
  const go = el('button', 'br-btn is-accent');
  go.type = 'submit';
  footer.append(status, back, go);
  panel.append(heading, body, footer);
  root.append(panel);
  let mode: Mode = 'debug';
  let visible = false;
  let busy = false;
  let returnFocus: HTMLElement | null = null;
  const controls = [storey, zone, link, back, go];
  const refreshZones = (): void => {
    zone.replaceChildren(new Option('Level spawn', ''));
    for (const info of ZONE_INFO) {
      if (STRATA_WEIGHTS[Number(storey.value) as StoreyId][info.id] > 0) {
        zone.append(new Option(zoneTitle(info.id), String(info.id)));
      }
    }
    status.textContent = '';
  };
  storey.addEventListener('change', refreshZones);
  zone.addEventListener('change', () => { status.textContent = ''; });
  link.addEventListener('input', () => { status.textContent = ''; link.removeAttribute('aria-invalid'); });
  const close = (): void => {
    if (!visible || busy) return;
    visible = false;
    root.classList.remove('is-open');
    cb.sound('close');
    cb.onClose();
    const target = returnFocus;
    requestAnimationFrame(() => { if (!visible) target?.focus({ preventScroll: true }); });
  };
  back.addEventListener('click', close);
  // Keep keyboard focus in the dialog, including when a native select is active.
  window.addEventListener('keydown', (event) => {
    if (!visible) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      const enabled = controls.filter((c) => !c.disabled && c.offsetParent !== null);
      if (!enabled.length) { event.preventDefault(); return; }
      const i = enabled.indexOf(document.activeElement as typeof enabled[number]);
      if (i < 0 || (event.shiftKey && i === 0) || (!event.shiftKey && i === enabled.length - 1)) {
        event.preventDefault();
        enabled[event.shiftKey ? enabled.length - 1 : 0].focus();
      }
    }
  });
  panel.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    controls.forEach((c) => { c.disabled = true; });
    panel.setAttribute('aria-busy', 'true');
    status.textContent = mode === 'debug' ? 'Finding and loading destination…' : 'Loading location…';
    cb.sound('click');
    void (async () => {
      try {
        if (mode === 'debug') await cb.teleport(Number(storey.value) as StoreyId, zone.value === '' ? null : Number(zone.value) as ZoneId);
        else await cb.loadLink(link.value);
        busy = false;
        close();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Unable to load this location.';
        if (mode === 'link') link.setAttribute('aria-invalid', 'true');
      } finally {
        busy = false;
        controls.forEach((c) => { c.disabled = false; });
        panel.removeAttribute('aria-busy');
        if (visible) (mode === 'link' ? link : go).focus();
      }
    })();
  });
  return {
    el: root,
    get visible() { return visible; },
    open(nextMode, s) {
      if (visible) return;
      returnFocus = document.activeElement as HTMLElement | null;
      mode = nextMode;
      title.textContent = mode === 'debug' ? 'Debug menu' : 'Load location link';
      note.textContent = mode === 'debug'
        ? 'Visit a level spawn or find the nearest zone in this tape.'
        : "Load the link's seed and location. Your video and audio settings stay the same.";
      destinations.hidden = mode !== 'debug';
      linkLabel.hidden = mode !== 'link';
      go.textContent = mode === 'debug' ? 'Teleport' : 'Load location';
      storey.value = String(s);
      refreshZones();
      link.value = '';
      link.removeAttribute('aria-invalid');
      visible = true;
      root.classList.add('is-open');
      requestAnimationFrame(() => { if (visible) (mode === 'debug' ? storey : link).focus(); });
    },
    hide() {
      visible = false;
      root.classList.remove('is-open');
    },
  };
}
