// src/player/input.ts (WP12) — keyboard / mouse (pointer lock) / gamepad -> PlayerInput.
//
// * Pointer lock: requestPointerLock({ unadjustedMovement: true }) with a plain fallback when unsupported.
//   The first mouse event after locking is dropped (browsers report a jump) and per-event deltas are clamped.
// * Keys: WASD / arrows move, Shift sprint (hold, or toggle with settings.toggleSprint), C crouch (hold or
//   toggle), F flashlight, E interact, Esc pause. Debug (documented only with debug=1): Space ascend in fly mode
//   (PlayerInputExt.up), F3 overlay, F4 cycle debug view. Esc / F3 / F4 are app actions: they are dispatched as a
//   window CustomEvent INPUT_ACTION_EVENT with detail { action: 'pause' | 'overlay' | 'debugView' } (and to
//   onAction if set).
// * R2 (B7) Ctrl is NOT crouch by default: Ctrl+W closes the tab, Ctrl+S / Ctrl+D open dialogs and break pointer
//   lock. Ctrl crouches only while the app reports fullscreen + a resolved navigator.keyboard.lock()
//   (setKeyboardLocked), when the browser delivers Ctrl+letter chords to the page. While pointer-locked, keydowns
//   with Ctrl / Meta on the game's letter keys are preventDefault()ed (the browser still owns Ctrl+W / Ctrl+T / Ctrl+N
//   without a keyboard lock: the app adds a beforeunload guard in play).
// * Gamepad (standard mapping): left stick moves, right stick looks (expo 1.6, speed follows the mouse
//   sensitivity setting), A interact, X flashlight,
//   B crouch, L3 / RT sprint, Start pause.
// * With autostart=1 in the URL the look works without pointer lock (headless QA).
// * Settings can change live: PlayerSystem forwards bus 'settingsChanged' to updateInputSettings(); (input as
//   InputExt).setSettings(s) also works (see docs/contract-changes/WP12.md).

import type { PlayerInput } from '../core/player.ts';
import type { InputSource } from '../core/runtime.ts';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings.ts';
import type { PlayerInputExt } from './controller.ts';

export const INPUT_ACTION_EVENT = 'backrooms:input-action';
export type InputAction = 'pause' | 'overlay' | 'debugView';

/** Extra members of the object returned by createInput (not part of the core InputSource contract). */
export interface InputExt extends InputSource {
  setSettings(s: Settings): void;
  onAction: ((a: InputAction) => void) | null;
}

/** lookRate: rad/s at full deflection with the default mouse sensitivity; it scales with settings.mouseSensitivity
 * (the one look-speed setting), clamped to LOOK_SCALE_MIN..MAX of the default. */
export const GAMEPAD = { deadzone: 0.15, expo: 1.6, lookRate: 2.8 } as const;
export const LOOK_SCALE_MIN = 0.25, LOOK_SCALE_MAX = 4;
/** Gamepad look speed (rad/s at full deflection) for a mouse sensitivity (rad per pixel). */
export function gamepadLookRate(sensitivity: number): number {
  const k = sensitivity > 0 ? sensitivity / DEFAULT_SETTINGS.mouseSensitivity : 1;
  return GAMEPAD.lookRate * Math.max(LOOK_SCALE_MIN, Math.min(LOOK_SCALE_MAX, k));
}
const MAX_MOUSE_DELTA = 400;
/** Letter keys the game reads; Ctrl / Meta chords on them are swallowed while pointer-locked. */
export const GAME_LETTER_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyE', 'KeyF', 'KeyR', 'KeyQ', 'KeyZ', 'KeyX', 'KeyV', 'KeyP']);
/** Keys requested from navigator.keyboard.lock() in fullscreen (movement, crouch/Ctrl, the chords above, Esc). */
export const KEYBOARD_LOCK_CODES: readonly string[] = [
  ...GAME_LETTER_KEYS, 'KeyT', 'KeyN', 'KeyL', 'Escape', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight',
];
let keyboardLocked = false;
/** The app calls this when fullscreen + navigator.keyboard.lock() resolved (true) or ended (false). */
export function setKeyboardLocked(on: boolean): void { keyboardLocked = on; }
/** Ctrl counts as crouch only while the keyboard is locked in fullscreen. */
export function ctrlCrouchEnabled(): boolean {
  return keyboardLocked && typeof document !== 'undefined' && !!document.fullscreenElement;
}
const MOVE_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
const isCtrl = (c: string): boolean => c === 'ControlLeft' || c === 'ControlRight';
const btnDown = (bs: readonly GamepadButton[], i: number): boolean => { const b = bs[i]; return !!b && (b.pressed || b.value > 0.5); };

const LIVE = new Set<InputExt>();
/** Pushes live settings (toggle sprint / crouch, sensitivity) to every InputSource made by createInput.
 * PlayerSystem forwards the bus 'settingsChanged' event here, so the app needs no extra wiring. */
export function updateInputSettings(s: Settings): void { for (const i of LIVE) i.setSettings(s); }

export function createInput(canvas: HTMLCanvasElement, settings: Settings): InputSource {
  let cfg = settings;
  const down = new Set<string>();
  let dx = 0, dy = 0, flash = false, interact = false;
  let sprintLatch = false, crouchLatch = false;
  let dropNextMove = false;
  let lastPoll = -1;
  const pad = { a: false, b: false, x: false, l3: false, start: false, back: false };
  let padCrouchLatch = false, padSprintLatch = false;
  let padsConnected = 0;
  // pads connected before this source existed (their 'gamepadconnected' event has already fired)
  try {
    const gps = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gps.length; i++) if (gps[i]?.connected) padsConnected++;
  } catch { /* getGamepads blocked (permissions policy) */ }
  const onPadOn = (): void => { padsConnected++; };
  const onPadOff = (): void => { padsConnected = Math.max(0, padsConnected - 1); };
  const autostart = (() => {
    try { return new URLSearchParams(location.search).get('autostart') === '1'; } catch { return false; }
  })();

  const isLocked = (): boolean => document.pointerLockElement === canvas;
  const key = (a: string, b: string): number => (down.has(a) || down.has(b) ? 1 : 0);
  const action = (a: InputAction): void => {
    src.onAction?.(a);
    try { window.dispatchEvent(new CustomEvent(INPUT_ACTION_EVENT, { detail: { action: a } })); } catch { /* no DOM events */ }
  };
  const typingTarget = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (typingTarget(e)) return;
    const c = e.code;
    if (!e.repeat) {
      if (c === 'KeyF') flash = true;
      else if (c === 'KeyE') interact = true;
      else if (c === 'ShiftLeft' || c === 'ShiftRight') sprintLatch = !sprintLatch;
      else if (c === 'KeyC' ? !e.ctrlKey && !e.metaKey : isCtrl(c) && ctrlCrouchEnabled()) crouchLatch = !crouchLatch;
      else if (c === 'Escape') action('pause');
      else if (c === 'F3') action('overlay');
      else if (c === 'F4') action('debugView');
    }
    if (c === 'F3' || c === 'F4' || c === 'Space' || c.startsWith('Arrow')) e.preventDefault();
    const chord = e.ctrlKey || e.metaKey;
    if (isLocked()) {
      if (isCtrl(c) && ctrlCrouchEnabled()) e.preventDefault();
      // Ctrl+S / Ctrl+D / Ctrl+F ... would open a browser dialog and drop pointer lock mid-walk. The browser action
      // is swallowed but WASD still move (a Ctrl held out of crouch habit must not freeze the player).
      if (chord && GAME_LETTER_KEYS.has(c)) e.preventDefault();
    }
    if (chord && c === 'KeyC' && !ctrlCrouchEnabled()) return; // Ctrl+C is not crouch (it is copy) outside fullscreen
    if (chord && GAME_LETTER_KEYS.has(c) && !MOVE_KEYS.has(c)) return;
    down.add(c);
  };
  const onKeyUp = (e: KeyboardEvent): void => { down.delete(e.code); };
  const onBlur = (): void => { down.clear(); };
  const onMouseMove = (e: MouseEvent): void => {
    if (!isLocked() && !autostart) return;
    if (dropNextMove) { dropNextMove = false; return; }
    const mx = e.movementX || 0, my = e.movementY || 0;
    dx += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, mx));
    dy += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, my));
  };
  const onLockChange = (): void => { if (isLocked()) dropNextMove = true; else down.clear(); };
  const onClick = (): void => { if (!isLocked()) src.lock(); };

  // radial deadzone, rescaled so the output starts at 0 on the deadzone edge; result in dz[0], dz[1] (no allocation)
  const dz = new Float64Array(2);
  const deadzone = (x: number, y: number): void => {
    const m = Math.hypot(x, y);
    if (m < GAMEPAD.deadzone) { dz[0] = 0; dz[1] = 0; return; }
    const k = Math.min(1, (m - GAMEPAD.deadzone) / (1 - GAMEPAD.deadzone)) / m;
    dz[0] = x * k; dz[1] = y * k;
  };
  const expo = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), GAMEPAD.expo);

  const pollGamepad = (out: PlayerInput, dt: number): void => {
    if (padsConnected <= 0) return; // no getGamepads() call (and no allocation) without a pad
    let gps: ArrayLike<Gamepad | null> = [];
    try { gps = navigator.getGamepads ? navigator.getGamepads() : []; } catch { return; }
    let gp: Gamepad | null = null;
    for (let i = 0; i < gps.length; i++) {
      const g = gps[i];
      if (!g || !g.connected) continue;
      if (!gp || (g.mapping === 'standard' && gp.mapping !== 'standard')) gp = g;
    }
    if (!gp) return;
    const ax = gp.axes;
    deadzone(ax[0] ?? 0, ax[1] ?? 0);
    const lx = dz[0], ly = dz[1];
    deadzone(ax[2] ?? 0, ax[3] ?? 0);
    const rx = dz[0], ry = dz[1];
    if (lx !== 0 || ly !== 0) { out.moveX = Math.max(-1, Math.min(1, out.moveX + lx)); out.moveZ = Math.max(-1, Math.min(1, out.moveZ - ly)); }
    // look deltas are in "pixels": the controller multiplies them by the sensitivity again
    const sens = cfg.mouseSensitivity > 0 ? cfg.mouseSensitivity : DEFAULT_SETTINGS.mouseSensitivity;
    const rate = gamepadLookRate(sens);
    out.lookDX += (expo(rx) * rate * dt) / sens;
    out.lookDY += (expo(ry) * rate * dt) / sens;
    const bs = gp.buttons;
    const a = btnDown(bs, 0), b = btnDown(bs, 1), x = btnDown(bs, 2), l3 = btnDown(bs, 10), start = btnDown(bs, 9), rt = btnDown(bs, 7);
    if (a && !pad.a) out.interactPressed = true;
    if (x && !pad.x) out.flashlightPressed = true;
    if (b && !pad.b) padCrouchLatch = !padCrouchLatch;
    if (l3 && !pad.l3) padSprintLatch = !padSprintLatch;
    if (start && !pad.start) action('pause');
    pad.a = a; pad.b = b; pad.x = x; pad.l3 = l3; pad.start = start;
    if (padSprintLatch && ly > -0.3) padSprintLatch = false; // stick released: sprint ends
    if (rt || padSprintLatch) out.sprint = true;
    if (cfg.toggleCrouch ? padCrouchLatch : b) out.crouch = true;
  };

  const src: InputExt = {
    onAction: null,
    poll(out: PlayerInput): void {
      const now = performance.now();
      const dt = lastPoll >= 0 ? Math.min(0.1, (now - lastPoll) / 1000) : 0;
      lastPoll = now;
      out.moveX = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');
      out.moveZ = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown');
      out.lookDX = dx; out.lookDY = dy;
      dx = 0; dy = 0;
      const shiftHeld = key('ShiftLeft', 'ShiftRight') === 1;
      if (cfg.toggleSprint) {
        if (out.moveZ <= 0) sprintLatch = false; // a toggled sprint ends when you stop moving forward
        out.sprint = sprintLatch;
      } else { out.sprint = shiftHeld; sprintLatch = false; }
      const crouchHeld = down.has('KeyC') || (ctrlCrouchEnabled() && (down.has('ControlLeft') || down.has('ControlRight')));
      if (cfg.toggleCrouch) out.crouch = crouchLatch; else { out.crouch = crouchHeld; crouchLatch = false; }
      (out as PlayerInputExt).up = down.has('Space');
      out.flashlightPressed = flash; out.interactPressed = interact;
      flash = false; interact = false;
      pollGamepad(out, dt);
    },
    lock(): void {
      if (isLocked()) return;
      const fallback = (): void => {
        try {
          const q = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          q?.catch?.(() => {});
        } catch { /* not allowed without a gesture */ }
      };
      try {
        const p = canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(fallback);
      } catch { fallback(); }
    },
    get locked(): boolean { return isLocked(); },
    setSettings(s: Settings): void { cfg = s; },
    dispose(): void {
      LIVE.delete(src);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('gamepadconnected', onPadOn);
      window.removeEventListener('gamepaddisconnected', onPadOff);
      if (isLocked()) document.exitPointerLock();
    },
  };

  LIVE.add(src);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  canvas.addEventListener('click', onClick);
  window.addEventListener('gamepadconnected', onPadOn);
  window.addEventListener('gamepaddisconnected', onPadOff);
  return src;
}
