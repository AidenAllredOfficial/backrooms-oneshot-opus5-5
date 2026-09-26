// src/ui/overlay.ts (WP14) — F3 debug overlay (4 Hz, fields from stats()) and the HUD: the camcorder REC overlay (REC
// dot, SP + battery, tape counter, date stamp) and (R2, B7) the interaction cue (OSD bracket + 'E  TRY DOOR'), the
// camcorder title-generator captions (zone / landmark / storey) and the first-play controls strip.

import type { DebugStats } from '../core/debug.ts';
import { clockText, el, tapeDate, timecode } from './dom.ts';

export interface DebugOverlay {
  readonly el: HTMLElement;
  setVisible(on: boolean): void;
  readonly visible: boolean;
  update(s: DebugStats, extra: string): void;
}

const f1 = (v: number): string => v.toFixed(1);
const f2 = (v: number): string => v.toFixed(2);
const k = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function formatStats(s: DebugStats, extra: string): string {
  const p = s.player;
  const lines = [
    `BACKROOMS ${s.version}  seed ${s.seed}  ${s.quality} x${f2(s.renderScale)}  ${s.ready ? 'ready' : s.readyPhase}${s.timeFrozen ? '  [time frozen]' : ''}`,
    `fps ${f1(s.fps)}  frame avg ${f2(s.frameMs.avg)}  p95 ${f2(s.frameMs.p95)}  max ${f1(s.frameMs.max)}  max5s ${f1(s.frameMs.max5s)} ms`,
    `cpu ${f2(s.cpuMs)} ms  gpu ${s.gpuMs === null ? 'n/a' : `${f2(s.gpuMs)} ms`}`,
    `draws ${s.render.drawCalls}  tris ${k(s.render.triangles)}  programs ${s.render.programs}  tex ${s.render.textures} (pool ${s.render.texturesPooled})  geo ${s.render.geometries}`,
    `chunks ${s.chunks.resident}/${s.chunks.desired} (layouts ${s.chunks.layoutsPending})  tiles ${s.tiles.resident} (prev ${s.tiles.preview} full ${s.tiles.full})`,
    `jobs queued ${s.tiles.queued} in-flight ${s.tiles.inFlight}  uploads ${s.tiles.uploadsPending}  fading ${s.tiles.fadingIn}  workers ${s.workers.busy}/${s.workers.count}`,
    `bake last ${f1(s.bake.lastMs)} avg ${f1(s.bake.avgMs)} build ${f1(s.bake.buildAvgMs)} ms`,
    `pos s${p.s} ${f2(p.x)} ${f2(p.y)} ${f2(p.z)}  yaw ${f1((p.yaw * 180) / Math.PI)}° pitch ${f1((p.pitch * 180) / Math.PI)}°${p.fly ? '  FLY' : ''}${p.onGround ? '' : '  air'}`,
    `cell ${p.cell[0]},${p.cell[1]}  chunk ${p.chunk[0]},${p.chunk[1]}  ${p.zone || '?'} / ${p.mood || '?'}  ${p.surface}`,
    `exposure EV100 ${f2(s.exposure.ev100)}${s.exposure.locked ? ' (locked)' : ''}  lights dyn ${s.lights.dynamicResident}  flicker ${s.lights.flickerMode}`,
    `audio ${s.audio ? `${s.audio.state}  voices ${s.audio.voices}  rt60 ${f2(s.audio.rt60)} s` : 'off'}`,
  ];
  if (extra) lines.push(extra);
  let html = esc(lines.join('\n'));
  if (s.warnings.length) html += `\n<span class="w">${esc(`warnings (${s.warnings.length}): ${s.warnings.slice(-3).join(' | ')}`)}</span>`;
  if (s.errors.length) html += `\n<span class="e">${esc(`errors (${s.errors.length}): ${s.errors.slice(-2).join(' | ')}`)}</span>`;
  return html;
}

export function createDebugOverlay(): DebugOverlay {
  const root = el('div', 'br-overlay');
  let visible = false;
  return {
    el: root,
    setVisible(on) {
      visible = on;
      root.classList.toggle('is-on', on);
    },
    get visible() { return visible; },
    update(s, extra) {
      if (visible) root.innerHTML = formatStats(s, extra);
    },
  };
}

export interface Hud {
  readonly el: HTMLElement;
  /** interactable targeted: a verb ('Try door') shows the OSD bracket + 'E  TRY DOOR'; null hides it */
  setCue(verb: string | null): void;
  /** brief feedback after pressing E ('Locked', 'Nothing here'); replaces the cue for `ms` */
  cueFeedback(text: string, ms?: number): void;
  /** camcorder title-generator caption (zone / landmark / storey), ~3 s; `sub` is the small second line */
  caption(title: string, sub: string, ms?: number): void;
  /** onboarding strip at the bottom (first play), fades after `ms` */
  hint(text: string, ms: number): void;
  hideTransient(): void;
  /** camcorder overlay; playSeconds drives the tape counter */
  setRec(on: boolean): void;
  tick(playSeconds: number): void;
  setHidden(hidden: boolean): void;
}

export function createHud(seedText: string, onRecChange?: (on: boolean) => void): Hud {
  const root = el('div', 'br-hud');
  // interaction cue: OSD corner brackets around the centre + key/verb label under them
  const cue = el('div', 'br-cue');
  const cueBox = el('div', 'br-cue-box');
  cueBox.append(el('i'), el('i'), el('i'), el('i'));
  const cueLabel = el('div', 'br-cue-label');
  const cueKey = el('b', '', 'E');
  const cueVerb = el('span');
  cueLabel.append(cueKey, cueVerb);
  cue.append(cueBox, cueLabel);
  // captions + onboarding strip
  const cap = el('div', 'br-caption');
  const capTitle = el('div', 'br-caption-title');
  const capSub = el('div', 'br-caption-sub');
  cap.append(capTitle, capSub);
  const hintEl = el('div', 'br-hint-strip');
  const rec = el('div', 'br-rec');
  const frame = el('div', 'br-frame');
  frame.append(el('i'), el('i'), el('i'), el('i'));
  const tl = el('div', 'br-rec-tl');
  tl.append(el('i'), 'REC');
  const tr = el('div', 'br-rec-tr');
  tr.append('SP', el('span', 'br-batt'));
  const bl = el('div', 'br-rec-bl', '0:00:00');
  const br = el('div', 'br-rec-br');
  rec.append(frame, tl, tr, bl, br);
  root.append(rec, cue, cap, hintEl);
  let cueVerbCur: string | null = null, feedbackUntil = 0, feedbackTimer = 0;
  let capTimer = 0, hintTimer = 0;
  let recOn = false, lastSec = -1, lastMin = -1;
  const showCue = (verb: string | null, feedback: boolean): void => {
    cue.classList.toggle('is-on', verb !== null);
    cue.classList.toggle('is-feedback', feedback);
    if (verb !== null) {
      cueKey.hidden = feedback;
      cueVerb.textContent = verb;
    }
  };
  return {
    el: root,
    setCue(verb) {
      if (verb === cueVerbCur) return;
      cueVerbCur = verb;
      if (performance.now() < feedbackUntil) return;
      showCue(verb, false);
    },
    cueFeedback(text, ms = 1400) {
      feedbackUntil = performance.now() + ms;
      showCue(text, true);
      clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => { feedbackUntil = 0; showCue(cueVerbCur, false); }, ms);
    },
    caption(title, sub, ms = 3200) {
      capTitle.textContent = title;
      capSub.textContent = sub;
      cap.classList.remove('is-on');
      void cap.offsetWidth; // restart the reveal animation
      cap.classList.add('is-on');
      clearTimeout(capTimer);
      capTimer = window.setTimeout(() => cap.classList.remove('is-on'), ms);
    },
    hint(text, ms) {
      hintEl.textContent = text;
      hintEl.classList.add('is-on');
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => hintEl.classList.remove('is-on'), ms);
    },
    hideTransient() {
      clearTimeout(capTimer); clearTimeout(hintTimer); clearTimeout(feedbackTimer);
      feedbackUntil = 0; cueVerbCur = null;
      cap.classList.remove('is-on'); hintEl.classList.remove('is-on'); showCue(null, false);
    },
    setRec(on) {
      if (on === recOn) return;
      recOn = on;
      rec.classList.toggle('is-on', on);
      lastMin = -1;
      lastSec = -1;
      onRecChange?.(on);
    },
    tick(playSeconds) {
      if (!recOn) return;
      const sec = Math.floor(playSeconds);
      if (sec === lastSec) return;
      lastSec = sec;
      bl.textContent = timecode(sec);
      const now = new Date();
      if (now.getMinutes() !== lastMin) {
        lastMin = now.getMinutes();
        br.innerHTML = `${clockText(now)}<br>${tapeDate(seedText, now)}`;
      }
    },
    setHidden(hidden) { root.style.display = hidden ? 'none' : ''; },
  };
}
