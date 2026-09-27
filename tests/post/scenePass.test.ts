// tests/post/scenePass.test.ts — the frame graph's stage order (post/ScenePass.ts) against a mock renderer: prepass,
// afterDepth hooks, opaque shading, pyramid, afterOpaque hooks, MRT composite + depth blit, late render; no split and
// no MRT on low / medium; the MRT specular attachments start at zero; layers, clears and shadow state are restored.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import type { QualityConfig } from '../../src/core/quality.ts';
import { DebugView } from '../../src/core/ids.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { LAYER_LATE, MRT_PASS } from '../../src/materials/shared.ts';
import { ScenePass } from '../../src/post/ScenePass.ts';
import type { FrameContext } from '../../src/post/ScenePass.ts';

interface Ev { e: string; target?: string; mask?: number; volOn?: number; mrtPass?: number; shadow?: boolean; locked?: boolean; clearColor?: boolean }

function setup(q: QualityConfig, opts: { water?: boolean; waterInView?: boolean; debugView?: number } = {}) {
  const events: Ev[] = [];
  const scene = new THREE.Scene();
  const depthMat = new THREE.MeshBasicMaterial();
  const surf = new THREE.MeshBasicMaterial(); surf.userData.brDepth = depthMat;
  const geo = new THREE.BoxGeometry();
  const shell = new THREE.Mesh(geo, surf);
  shell.position.set(0, 0, -5);
  scene.add(shell);
  if (opts.water !== false) {
    const water = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true }));
    water.layers.set(LAYER_LATE);
    water.position.set(0, 0, opts.waterInView === false ? 50 : -4); // +z: behind the camera
    scene.add(water);
  }
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(60, 2, 0.05, 400);
  camera.layers.enable(LAYER_LATE);
  const globals = createGlobals();
  globals.debugView.value = opts.debugView ?? 0;

  const names = new Map<object, string>();
  const input = new THREE.WebGLRenderTarget(64, 32, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(64, 32, THREE.FloatType) });
  const output = new THREE.WebGLRenderTarget(64, 32, { type: THREE.HalfFloatType });
  names.set(input, 'input');
  names.set(output, 'output');
  const depth = { mask: true, locked: false, setMask(v: boolean) { if (!this.locked) this.mask = v; }, setLocked(v: boolean) { this.locked = v; } };
  let current: THREE.WebGLRenderTarget | null = null;
  const nameOf = (t: THREE.WebGLRenderTarget | null): string => {
    if (t === null) return 'screen';
    if (!names.has(t)) names.set(t, t.textures.length === 3 ? 'sceneRT' : t.texture.name || 'rt');
    return names.get(t) as string;
  };
  const gl = {
    COLOR: 0x1800, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, DEPTH_BUFFER_BIT: 0x100, NEAREST: 0x2600,
    clearBufferfv(_b: number, i: number, v: Float32Array) { events.push({ e: `clearBuffer${i}:${[...v].join(',')}`, target: nameOf(current) }); },
    bindFramebuffer() {},
    blitFramebuffer() { events.push({ e: 'blitDepth' }); },
  };
  const renderer = {
    autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    shadowMap: { autoUpdate: true },
    state: { buffers: { depth, color: { setMask() {} } } },
    properties: { get: () => ({ __webglFramebuffer: {} }) },
    getContext: () => gl,
    getClearAlpha: () => 1,
    setRenderTarget(t: THREE.WebGLRenderTarget | null) { current = t; },
    getRenderTarget: () => current,
    clear() { events.push({ e: 'clear', target: nameOf(current) }); },
    render(sc: THREE.Scene, cam: THREE.Camera) {
      const base = { target: nameOf(current), volOn: globals.waterVolOn.value, mrtPass: MRT_PASS.value };
      if (sc !== scene) {
        const m = (sc.children[0] as THREE.Mesh).material as THREE.Material;
        events.push({ e: `quad:${m.name}`, ...base });
        return;
      }
      const e = shell.material === depthMat ? 'prepass' : cam.layers.mask === 1 << LAYER_LATE ? 'late' : 'shade';
      events.push({ e, ...base, mask: cam.layers.mask, shadow: renderer.shadowMap.autoUpdate, locked: depth.locked, clearColor: renderer.autoClearColor });
    },
  };
  const pass = new ScenePass(scene, camera);
  pass.setQuality(q);
  pass.bindGlobals(globals);
  const ctxs: FrameContext[] = [];
  pass.addHook('afterOpaque', { name: 'ssr', order: 10, run: (c) => { events.push({ e: 'hook:ssr', target: nameOf(current) }); ctxs.push({ ...c }); } });
  pass.addHook('afterDepth', { name: 'hiz', order: 20, run: () => { events.push({ e: 'hook:hiz' }); } });
  pass.addHook('afterDepth', { name: 'ssao', order: 10, run: (c) => { events.push({ e: 'hook:ssao', target: nameOf(current), volOn: globals.waterVolOn.value }); ctxs.push({ ...c }); current = null; } });
  const run = (): void => pass.render(renderer as unknown as THREE.WebGLRenderer, input, output);
  return { events, run, pass, renderer, camera, globals, input, ctxs, depth };
}

const seq = (ev: Ev[]): string[] => ev.map((x) => x.e);

describe('ScenePass frame graph', () => {
  it('low / medium: one prepass + shading render into the input buffer, no split, no MRT (water in view)', () => {
    for (const name of ['low', 'medium'] as const) {
      const t = setup(QUALITY[name]);
      t.run();
      expect(seq(t.events)).toEqual(['clear', 'prepass', 'hook:ssao', 'hook:hiz', 'shade', 'hook:ssr']);
      const shade = t.events.find((x) => x.e === 'shade') as Ev;
      expect(shade).toMatchObject({ target: 'input', mask: 1 | (1 << LAYER_LATE), volOn: 0, mrtPass: 0, shadow: false, locked: true, clearColor: true });
      expect(t.pass.lastFrame).toEqual({ mrt: false, split: false });
      expect(t.globals.sceneColor.value).toBeNull();
    }
  });

  it('high with water in view: split frame (opaque without LAYER_LATE, pyramid, afterOpaque, late render)', () => {
    const t = setup(QUALITY.high);
    t.run();
    expect(seq(t.events)).toEqual(['clear', 'prepass', 'hook:ssao', 'hook:hiz', 'shade', 'quad:br-pyramid-full', 'hook:ssr', 'late']);
    const ev = (e: string): Ev => t.events.find((x) => x.e === e) as Ev;
    // the hook unbound the target: the pass rebinds it before shading
    expect(ev('shade')).toMatchObject({ target: 'input', mask: 1, volOn: 1, shadow: false, locked: true });
    expect(ev('hook:ssao').volOn).toBe(1);
    expect(ev('quad:br-pyramid-full').target).toBe('Frame.ColorPyramid');
    // depth writes per material in the late render (package E: the refracting water writes its surface)
    expect(ev('late')).toMatchObject({ target: 'input', mask: 1 << LAYER_LATE, volOn: 1, shadow: false, locked: false, clearColor: false });
    expect(t.pass.lastFrame).toEqual({ mrt: false, split: true });
    expect(t.globals.sceneColor.value).toBe(t.pass.pyramid.texture);
    expect(t.globals.sceneInvSize.value.toArray()).toEqual([1 / 64, 1 / 32]);
    expect(t.ctxs[1].pyramid).toBe(t.pass.pyramid);
    // everything restored
    expect(t.camera.layers.mask).toBe(1 | (1 << LAYER_LATE));
    expect(t.globals.waterVolOn.value).toBe(0);
    expect(t.renderer).toMatchObject({ autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true, shadowMap: { autoUpdate: true } });
    expect(t.depth).toMatchObject({ locked: false, mask: true });
  });

  it('ultra builds a 0.67 pyramid with the box filter', () => {
    const t = setup(QUALITY.ultra);
    t.run();
    expect(seq(t.events)).toContain('quad:br-pyramid-box');
    expect([t.pass.pyramid.width, t.pass.pyramid.height]).toEqual([Math.round(64 * 0.67), Math.round(32 * 0.67)]);
  });

  it('no split without a late mesh in view, nor in debug views other than WATER', () => {
    for (const o of [{ waterInView: false }, { water: false }, { debugView: DebugView.ALBEDO }]) {
      const t = setup(QUALITY.high, o);
      t.run();
      expect(seq(t.events)).toEqual(['clear', 'prepass', 'hook:ssao', 'hook:hiz', 'shade', 'hook:ssr']);
      expect((t.events.find((x) => x.e === 'shade') as Ev).mask).toBe(1 | (1 << LAYER_LATE));
    }
    const w = setup(QUALITY.high, { debugView: DebugView.WATER });
    w.run();
    expect(w.pass.lastFrame.split).toBe(true);
  });

  it('SSR on: MRT sceneRT, zeroed specular attachments, composite + depth blit before the late render', () => {
    const q: QualityConfig = { ...QUALITY.high, ssr: 'half' };
    const t = setup(q);
    t.run();
    expect(seq(t.events)).toEqual([
      'clear', 'prepass', 'hook:ssao', 'hook:hiz', 'clearBuffer1:0,0,0,0', 'clearBuffer2:0,0,0,0', 'shade',
      'quad:br-pyramid-full', 'hook:ssr', 'quad:br-mrt-composite', 'blitDepth', 'late',
    ]);
    const ev = (e: string): Ev => t.events.find((x) => x.e === e) as Ev;
    expect(ev('clear').target).toBe('sceneRT');
    expect(ev('prepass')).toMatchObject({ target: 'sceneRT', mrtPass: 1, clearColor: true });
    expect(ev('clearBuffer1:0,0,0,0').target).toBe('sceneRT');
    // the background's forced clear inside the shading render must not touch the colour attachments
    expect(ev('shade')).toMatchObject({ target: 'sceneRT', mrtPass: 1, clearColor: false, mask: 1 });
    expect(ev('quad:br-mrt-composite')).toMatchObject({ target: 'input', mrtPass: 0 });
    expect(ev('late').target).toBe('input');
    expect(t.ctxs[0].mrt).not.toBeNull();
    expect(t.ctxs[0].depth).toBe(t.ctxs[0].mrt?.depthTexture);
    // the pyramid's 4-tap box (ultra) reads the colour attachment bilinearly; the G-buffer stays nearest
    const tex = (t.ctxs[0].mrt as THREE.WebGLRenderTarget).textures;
    expect([tex[0].minFilter, tex[0].magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
    expect([tex[1].minFilter, tex[2].minFilter]).toEqual([THREE.NearestFilter, THREE.NearestFilter]);
    expect(t.pass.lastFrame).toEqual({ mrt: true, split: true });
    expect(t.renderer.autoClearColor).toBe(true);
    expect(MRT_PASS.value).toBe(0);
  });

  it('the ssr toggle and debug views fall back to the plain path', () => {
    const q: QualityConfig = { ...QUALITY.high, ssr: 'half' };
    const off = setup(q);
    off.pass.setSsrEnabled(false);
    off.run();
    expect(off.pass.lastFrame.mrt).toBe(false);
    expect(seq(off.events)).not.toContain('quad:br-mrt-composite');
    const dv = setup(q, { debugView: DebugView.ALBEDO });
    dv.run();
    expect(dv.pass.lastFrame).toEqual({ mrt: false, split: false });
  });

  it('hooks run in order within a stage and can be removed; ctx carries the depth of the target', () => {
    const t = setup(QUALITY.high);
    const remove = t.pass.addHook('afterDepth', { name: 'vol', order: 40, run: () => { t.events.push({ e: 'hook:vol' }); } });
    t.pass.addHook('afterDepth', { name: 'atlas', order: 30, run: () => { t.events.push({ e: 'hook:atlas' }); } });
    t.run();
    expect(seq(t.events).slice(2, 6)).toEqual(['hook:ssao', 'hook:hiz', 'hook:atlas', 'hook:vol']);
    expect(t.ctxs[0].depth).toBe(t.input.depthTexture);
    expect([t.ctxs[0].width, t.ctxs[0].height]).toEqual([64, 32]);
    expect(t.ctxs[0].globals).toBe(t.globals);
    remove();
    expect(t.pass.hooks.afterDepth.map((h) => h.name)).toEqual(['ssao', 'hiz', 'atlas']);
  });

  it('a switch to a preset without split frames frees the pyramid target and resets sceneColor', () => {
    const t = setup(QUALITY.high);
    t.run();
    expect(t.globals.sceneColor.value).toBe(t.pass.pyramid.texture);
    let freed = 0;
    t.pass.pyramid.target.addEventListener('dispose', () => { freed++; });
    t.pass.setQuality(QUALITY.ultra);
    expect(freed).toBe(0);
    t.pass.setQuality(QUALITY.medium);
    expect(freed).toBe(1);
    expect(t.globals.sceneColor.value).toBeNull();
  });

  it('keeps the composer depth textures (needsDepthTexture)', () => {
    const t = setup(QUALITY.low);
    expect(t.pass.needsDepthTexture).toBe(true);
    expect(t.pass.materials.map((m) => m.name)).toEqual(['br-pyramid-full', 'br-pyramid-box', 'br-mrt-composite']);
  });
});
