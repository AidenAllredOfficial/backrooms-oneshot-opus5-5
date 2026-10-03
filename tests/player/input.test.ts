// input.ts under a minimal fake DOM (vitest runs in node): key mapping, hold/toggle sprint and crouch, edge-triggered
// flashlight/interact, pointer-lock gating of the mouse look (autostart bypass), the unadjustedMovement fallback,
// app actions and live settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerInput } from '../../src/core/player.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings.ts';
import type { PlayerInputExt } from '../../src/player/controller.ts';
import { createInput, GAMEPAD, INPUT_ACTION_EVENT, setKeyboardLocked, updateInputSettings, type InputExt } from '../../src/player/input.ts';

type Handler = (e: unknown) => void;
class FakeTarget {
  handlers = new Map<string, Handler[]>();
  addEventListener(k: string, f: Handler): void { (this.handlers.get(k) ?? this.handlers.set(k, []).get(k)!).push(f); }
  removeEventListener(k: string, f: Handler): void { const l = this.handlers.get(k); if (l) l.splice(l.indexOf(f), 1); }
  fire(k: string, e: unknown): void { for (const f of [...(this.handlers.get(k) ?? [])]) f(e); }
  count(): number { let n = 0; for (const l of this.handlers.values()) n += l.length; return n; }
}

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, location: g.location, CustomEvent: g.CustomEvent };

function setup(search = '', lockMode: 'promise' | 'reject' = 'promise') {
  const win = new FakeTarget() as FakeTarget & { dispatchEvent(e: { type: string; detail: unknown }): void };
  const actions: string[] = [];
  win.dispatchEvent = (e) => { if (e.type === INPUT_ACTION_EVENT) actions.push((e.detail as { action: string }).action); };
  const doc = new FakeTarget() as FakeTarget & { pointerLockElement: unknown; exitPointerLock(): void };
  doc.pointerLockElement = null;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; };
  const lockCalls: unknown[] = [];
  const canvas = new FakeTarget() as FakeTarget & { requestPointerLock(o?: unknown): Promise<void> };
  canvas.requestPointerLock = (o?: unknown) => {
    lockCalls.push(o ?? null);
    if (lockMode === 'reject' && o) return Promise.reject(new Error('unadjustedMovement unsupported'));
    doc.pointerLockElement = canvas;
    doc.fire('pointerlockchange', {});
    return Promise.resolve();
  };
  g.window = win; g.document = doc; g.location = { search };
  g.CustomEvent = class { type: string; detail: unknown; constructor(t: string, o: { detail: unknown }) { this.type = t; this.detail = o.detail; } };
  const inp = createInput(canvas as unknown as HTMLCanvasElement, { ...DEFAULT_SETTINGS }) as InputExt;
  const key = (code: string, down = true, repeat = false): void =>
    win.fire(down ? 'keydown' : 'keyup', { code, repeat, target: null, preventDefault() {} });
  const mouse = (dx: number, dy: number): void => doc.fire('mousemove', { movementX: dx, movementY: dy });
  const out: PlayerInputExt = { moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false, flashlightPressed: false, interactPressed: false };
  const poll = (): PlayerInputExt => { inp.poll(out as PlayerInput); return out; };
  return { inp, win, doc, canvas, key, mouse, poll, actions, lockCalls };
}

afterEach(() => { Object.assign(g, saved); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('input', () => {
  it('maps WASD / arrows, edge-triggers F and E, holds Shift and C, Space = up', () => {
    const t = setup();
    t.key('KeyW'); t.key('KeyD'); t.key('ShiftLeft'); t.key('KeyC'); t.key('KeyF'); t.key('KeyE'); t.key('Space');
    let o = t.poll();
    expect([o.moveX, o.moveZ, o.sprint, o.crouch, o.flashlightPressed, o.interactPressed, o.up]).toEqual([1, 1, true, true, true, true, true]);
    o = t.poll();
    expect([o.flashlightPressed, o.interactPressed]).toEqual([false, false]); // edge-triggered
    t.key('KeyW', false); t.key('KeyD', false); t.key('ArrowDown'); t.key('ArrowLeft'); t.key('ShiftLeft', false); t.key('KeyC', false);
    o = t.poll();
    expect([o.moveX, o.moveZ, o.sprint, o.crouch]).toEqual([-1, -1, false, false]);
    t.win.fire('blur', {});
    o = t.poll();
    expect([o.moveX, o.moveZ]).toEqual([0, 0]); // focus loss releases every key
    t.inp.dispose();
  });

  it('toggle sprint / crouch follow live settings forwarded from the bus', () => {
    const t = setup();
    const s: Settings = { ...DEFAULT_SETTINGS, toggleSprint: true, toggleCrouch: true };
    updateInputSettings(s);
    t.key('KeyW'); t.key('ShiftLeft'); t.key('ShiftLeft', false); t.key('KeyC'); t.key('KeyC', false);
    let o = t.poll();
    expect([o.sprint, o.crouch]).toEqual([true, true]);
    t.key('KeyC'); t.key('KeyC', false);
    o = t.poll();
    expect([o.sprint, o.crouch]).toEqual([true, false]);
    t.key('KeyW', false); // stopping ends a toggled sprint
    o = t.poll();
    expect(o.sprint).toBe(false);
    t.inp.dispose();
  });

  it('mouse look only while pointer-locked (first event after locking dropped), or always with autostart', () => {
    const t = setup();
    t.mouse(10, 5);
    expect(t.poll().lookDX).toBe(0);
    t.inp.lock();
    expect(t.lockCalls[0]).toEqual({ unadjustedMovement: true });
    expect(t.inp.locked).toBe(true);
    t.mouse(300, 300); // browser jump on lock: dropped
    t.mouse(10, -4); t.mouse(2, 1);
    const o = t.poll();
    expect([o.lookDX, o.lookDY]).toEqual([12, -3]);
    expect(t.poll().lookDX).toBe(0); // consumed
    t.inp.dispose();
    expect(t.win.count() + t.doc.count() + t.canvas.count()).toBe(0); // every listener removed

    const a = setup('?autostart=1');
    a.mouse(7, 0);
    expect(a.poll().lookDX).toBe(7);
    a.inp.dispose();
  });

  it('falls back to a plain requestPointerLock when unadjustedMovement is rejected', async () => {
    const t = setup('', 'reject');
    t.inp.lock();
    await Promise.resolve(); await Promise.resolve();
    expect(t.lockCalls).toEqual([{ unadjustedMovement: true }, null]);
    expect(t.inp.locked).toBe(true);
    t.inp.dispose();
  });

  it('Esc / F3 / F4 are app actions (onAction and a window event)', () => {
    const t = setup();
    const seen: string[] = [];
    t.inp.onAction = (a) => seen.push(a);
    t.key('Escape'); t.key('F3'); t.key('F4'); t.key('F4', true, true /* auto-repeat: ignored */);
    expect(seen).toEqual(['pause', 'overlay', 'debugView']);
    expect(t.actions).toEqual(['pause', 'overlay', 'debugView']);
    t.inp.dispose();
  });

  it('gamepad: right stick look speed follows the mouse sensitivity setting; a pad connected before createInput counts', () => {
    const axes = [0, 0, 1, 0];
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
    const pad = { connected: true, mapping: 'standard', axes, buttons };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const t = setup(); // the pad is already connected: no 'gamepadconnected' event will come
    t.poll(); // first poll: dt = 0
    const lookRad = (sens: number): number => {
      updateInputSettings({ ...DEFAULT_SETTINGS, mouseSensitivity: sens });
      now += 100;
      return t.poll().lookDX * sens; // radians of yaw the controller will apply
    };
    const base = lookRad(DEFAULT_SETTINGS.mouseSensitivity);
    expect(base).toBeCloseTo(GAMEPAD.lookRate * 0.1, 6); // full deflection, expo(1) = 1
    expect(lookRad(DEFAULT_SETTINGS.mouseSensitivity * 2) / base).toBeCloseTo(2, 6);
    expect(lookRad(DEFAULT_SETTINGS.mouseSensitivity * 0.5) / base).toBeCloseTo(0.5, 6);
    // expo 1.6 on a half deflection
    axes[2] = 0.5;
    const half = lookRad(DEFAULT_SETTINGS.mouseSensitivity);
    const d = (0.5 - GAMEPAD.deadzone) / (1 - GAMEPAD.deadzone);
    expect(half / base).toBeCloseTo(Math.pow(d, GAMEPAD.expo), 6);
    // A = interact (edge-triggered), left stick moves
    buttons[0] = { pressed: true, value: 1, touched: true };
    axes[1] = -1; axes[2] = 0;
    now += 16;
    let o = t.poll();
    expect([o.interactPressed, o.moveZ]).toEqual([true, 1]);
    now += 16;
    o = t.poll();
    expect(o.interactPressed).toBe(false);
    updateInputSettings(DEFAULT_SETTINGS);
    t.inp.dispose();
  });

  it('R2: Ctrl is not crouch (Ctrl+W closes the tab); only with fullscreen + a keyboard lock', () => {
    const t = setup();
    t.key('ControlLeft');
    expect(t.poll().crouch).toBe(false);
    t.key('ControlLeft', false);
    const doc = t.doc as unknown as { fullscreenElement: unknown };
    doc.fullscreenElement = {};
    setKeyboardLocked(true);
    try {
      t.key('ControlLeft');
      expect(t.poll().crouch).toBe(true);
      t.key('ControlLeft', false);
      expect(t.poll().crouch).toBe(false);
      doc.fullscreenElement = null; // leaving fullscreen drops the lock
      t.key('ControlRight');
      expect(t.poll().crouch).toBe(false);
    } finally {
      setKeyboardLocked(false);
      t.inp.dispose();
    }
  });

  it('R2: while pointer-locked, Ctrl / Meta chords on game letters are swallowed (WASD still move, Ctrl+C no crouch)', () => {
    const t = setup();
    t.inp.lock();
    let prevented = 0;
    const chord = (code: string, mods: { ctrlKey?: boolean; metaKey?: boolean }): void =>
      t.win.fire('keydown', { code, repeat: false, target: null, ...mods, preventDefault() { prevented++; } });
    chord('KeyS', { ctrlKey: true });
    chord('KeyD', { metaKey: true });
    chord('KeyC', { ctrlKey: true });
    expect(prevented).toBe(3);
    const o = t.poll();
    expect([o.moveX, o.moveZ, o.crouch]).toEqual([1, -1, false]);
    t.inp.dispose();
  });

  it('Ctrl and Meta shortcuts never queue flashlight or interaction actions', () => {
    const t = setup();
    t.inp.lock();
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const code of ['KeyF', 'KeyE']) {
        t.win.fire('keydown', { code, repeat: false, target: null, ...mods, preventDefault() {} });
      }
    }
    const o = t.poll();
    expect([o.flashlightPressed, o.interactPressed]).toEqual([false, false]);
    t.inp.dispose();
  });

  it.each(['blur', 'pointerlockchange'])('clears toggles and queued actions when %s releases control', (event) => {
    const t = setup();
    t.inp.setSettings({ ...DEFAULT_SETTINGS, toggleSprint: true, toggleCrouch: true });
    t.inp.lock();
    t.mouse(300, 300); // discarded lock jump
    t.mouse(20, 5);
    t.key('KeyW'); t.key('ShiftLeft'); t.key('KeyC'); t.key('KeyF'); t.key('KeyE');
    if (event === 'blur') t.win.fire(event, {});
    else { t.doc.pointerLockElement = null; t.doc.fire(event, {}); }
    const o = t.poll();
    expect([o.moveX, o.moveZ, o.lookDX, o.lookDY, o.sprint, o.crouch, o.flashlightPressed, o.interactPressed])
      .toEqual([0, 0, 0, 0, false, false, false, false]);
    t.key('KeyW');
    expect(t.poll().sprint).toBe(false);
    t.inp.dispose();
  });

  it('leaves native selects and editable controls to the browser', () => {
    const t = setup();
    for (const target of [{ tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      for (const code of ['KeyW', 'KeyF', 'KeyE', 'ArrowDown']) {
        t.win.fire('keydown', { code, repeat: false, target, preventDefault() { throw new Error('native control intercepted'); } });
      }
    }
    const o = t.poll();
    expect([o.moveZ, o.flashlightPressed, o.interactPressed]).toEqual([0, false, false]);
    t.inp.dispose();
  });

  it.each(['true', 'YES', 'on', ''])('honours autostart=%s for unlocked mouse look', (value) => {
    const t = setup(`?autostart=${value}`);
    t.mouse(7, 2);
    expect([t.poll().lookDX, t.poll().lookDX]).toEqual([7, 0]);
    t.inp.dispose();
  });

  it('disconnecting a gamepad clears its crouch latch and button edges before reconnecting', () => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
    const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
    vi.stubGlobal('navigator', { getGamepads: () => pad.connected ? [pad] : [] });
    const t = setup();
    t.inp.setSettings({ ...DEFAULT_SETTINGS, toggleCrouch: true });
    buttons[0].pressed = buttons[1].pressed = true;
    expect([t.poll().crouch, t.poll().interactPressed]).toEqual([true, false]);
    pad.connected = false;
    t.win.fire('gamepaddisconnected', {});
    t.poll();
    pad.connected = true;
    buttons[1].pressed = false;
    t.win.fire('gamepadconnected', {});
    const o = t.poll();
    expect([o.crouch, o.interactPressed]).toEqual([false, true]);
    t.inp.dispose();
  });
});
