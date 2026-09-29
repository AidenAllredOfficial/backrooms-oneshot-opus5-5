// tests/post/scenePass.test.ts — the frame graph's stage order (post/ScenePass.ts) against a mock renderer: prepass,
// afterDepth hooks, opaque shading, pyramid, afterOpaque hooks, MRT composite + depth blit, late render; no split and
// no MRT on low / medium; the MRT specular attachments start at zero; layers, clears and shadow state are restored.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import type { QualityConfig } from '../../src/core/quality.ts';
import { DebugView } from '../../src/core/ids.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { LAYER_LATE, MRT_PASS } from '../../src/materials/shared.ts';
import { ScenePass } from '../../src/post/ScenePass.ts';
import { ColorPyramid, MIP_DOWN_FRAG, mipSizes, PYR_LEVELS } from '../../src/post/frame/ColorPyramid.ts';
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
    if (!names.has(t)) names.set(t, t.textures.length === 4 ? 'sceneRT' : t.texture.name || 'rt');
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
  return { events, run, pass, renderer, camera, globals, input, ctxs, depth, scene };
}

const seq = (ev: Ev[]): string[] => ev.map((x) => x.e);
// high without SSR (package D turns it on at high / ultra): the plain split path without MRT
const HIGH_PLAIN: QualityConfig = { ...QUALITY.high, ssr: 'off' };

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
    const t = setup(HIGH_PLAIN);
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
      const t = setup(HIGH_PLAIN, o);
      t.run();
      expect(seq(t.events)).toEqual(['clear', 'prepass', 'hook:ssao', 'hook:hiz', 'shade', 'hook:ssr']);
      expect((t.events.find((x) => x.e === 'shade') as Ev).mask).toBe(1 | (1 << LAYER_LATE));
    }
    const w = setup(HIGH_PLAIN, { debugView: DebugView.WATER });
    w.run();
    expect(w.pass.lastFrame.split).toBe(true);
  });

  it('SSR on: MRT sceneRT, zeroed specular attachments, composite + depth blit before the late render', () => {
    const q: QualityConfig = { ...QUALITY.high, ssr: 'half' };
    const t = setup(q);
    t.run();
    expect(seq(t.events)).toEqual([
      'clear', 'prepass', 'hook:ssao', 'hook:hiz', 'clearBuffer1:0,0,0,0', 'clearBuffer2:0,0,0,0', 'clearBuffer3:0,0,0,0', 'shade',
      'quad:br-pyramid-full', 'hook:ssr', 'quad:br-mrt-composite', 'blitDepth', 'late',
    ]);
    const ev = (e: string): Ev => t.events.find((x) => x.e === e) as Ev;
    expect(ev('clear').target).toBe('sceneRT');
    expect(ev('prepass')).toMatchObject({ target: 'sceneRT', mrtPass: 1, clearColor: true });
    expect(ev('clearBuffer1:0,0,0,0').target).toBe('sceneRT');
    expect(ev('clearBuffer3:0,0,0,0').target).toBe('sceneRT');
    // the background's forced clear inside the shading render must not touch the colour attachments
    expect(ev('shade')).toMatchObject({ target: 'sceneRT', mrtPass: 1, clearColor: false, mask: 1 });
    expect(ev('quad:br-mrt-composite')).toMatchObject({ target: 'input', mrtPass: 0 });
    expect(ev('late').target).toBe('input');
    expect(t.ctxs[0].mrt).not.toBeNull();
    expect(t.ctxs[0].depth).toBe(t.ctxs[0].mrt?.depthTexture);
    // The pyramid reads both radiance attachments bilinearly; normal data stays nearest.
    const tex = (t.ctxs[0].mrt as THREE.WebGLRenderTarget).textures;
    expect(tex).toHaveLength(4);
    expect([tex[0].minFilter, tex[0].magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
    expect([tex[1].minFilter, tex[1].magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
    expect(tex[2].minFilter).toBe(THREE.NearestFilter);
    expect(tex[3]).toMatchObject({ name: 'Frame.SpecularWeight', type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    expect(t.pass.composite.material.uniforms.tWeight.value).toBe(tex[3]);
    const pyramid = t.pass.pyramid.materials[0];
    expect(pyramid.uniforms.uFallback.value).toBe(true);
    expect(pyramid.uniforms.tFallback.value).toBe(tex[1]);
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
    const t = setup(HIGH_PLAIN);
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
    expect(t.pass.materials.map((m) => m.name)).toEqual(['br-pyramid-full', 'br-pyramid-box', 'br-pyramid-down', 'br-mrt-composite']);
  });

  it('shares current scene transforms across all draws and restores frame state after a failing hook', () => {
    const t = setup(QUALITY.high);
    const update = vi.spyOn(t.scene, 'updateMatrixWorld');
    t.pass.addHook('afterOpaque', { name: 'failure', order: 100, run: () => {
      expect(t.scene.matrixWorldAutoUpdate).toBe(false);
      throw new Error('hook failed');
    } });
    expect(t.run).toThrow('hook failed');
    expect(update).toHaveBeenCalledTimes(1);
    expect(t.scene.matrixWorldAutoUpdate).toBe(true);
    expect(t.globals.waterVolOn.value).toBe(0);
    expect(MRT_PASS.value).toBe(0);
    expect(t.renderer.autoClearColor).toBe(true);
  });
});

describe('ColorPyramid mip chain', () => {
  it('includes fallback specular on MRT frames and resets it when the next frame uses plain colour', () => {
    const p = new ColorPyramid();
    const color = new THREE.Texture(), fallback = new THREE.Texture(), depth = new THREE.Texture();
    const camera = new THREE.PerspectiveCamera();
    const draws: { full: boolean; color: unknown; fallback: unknown; enabled: unknown }[] = [];
    const renderer = {
      setRenderTarget() {},
      getContext: () => ({}),
      properties: { get: () => ({}) },
      render(sc: THREE.Scene) {
        const m = (sc.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
        draws.push({ full: 'BR_PYR_FULL' in m.defines, color: m.uniforms.tColor.value,
          fallback: m.uniforms.tFallback.value, enabled: m.uniforms.uFallback.value });
      },
    } as unknown as THREE.WebGLRenderer;
    for (const scale of [1, 0.67]) {
      p.setSize(64, 32, scale);
      p.build(renderer, color, depth, camera, fallback);
      p.build(renderer, color, depth, camera);
    }
    expect(draws).toEqual([
      { full: true, color, fallback, enabled: true }, { full: true, color, fallback: null, enabled: false },
      { full: false, color, fallback, enabled: true }, { full: false, color, fallback: null, enabled: false },
    ]);
    p.dispose();
  });
  it('allocates PYR_LEVELS floor-halved levels, and again after a resize', () => {
    const p = new ColorPyramid();
    p.setSize(1920, 1080, 1);
    const mips = p.texture.mipmaps as unknown as { width: number; height: number }[];
    expect(mips.map((m) => [m.width, m.height])).toEqual(mipSizes(1920, 1080, PYR_LEVELS));
    expect(mips.length).toBe(PYR_LEVELS);
    expect([mips[7].width, mips[7].height]).toEqual([15, 8]);
    expect(p.texture.generateMipmaps).toBe(false);
    p.setSize(8, 4, 1);
    expect((p.texture.mipmaps as unknown[]).length).toBe(4);
    expect(mipSizes(2401, 1351)).toHaveLength(12);
    expect(mipSizes(3, 1)).toEqual([[3, 1], [1, 1]]);
  });

  it('renders level k from level k - 1 into a scratch of its size and blits it into level k (never self-sampling)', () => {
    const log: string[] = [];
    const tex = {};
    const gl = {
      TEXTURE_2D: 0xde1, TEXTURE_MAX_LEVEL: 0x813d, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, COLOR_BUFFER_BIT: 0x4000,
      NEAREST: 0x2600,
      texParameteri(_t: number, p: number, v: number) { log.push(`${p === 0x813d ? 'max' : p}=${v}`); },
      blitFramebuffer(_x0: number, _y0: number, w: number, h: number) { log.push(`blit:${read}->${draw}:${w}x${h}`); },
    };
    let read = '', draw = '';
    const p = new ColorPyramid();
    p.setSize(64, 32, 1);
    const fbOf = new Map<object, unknown>();
    const renderer = {
      getContext: () => gl,
      properties: {
        get: (o: object) => {
          if (o === p.texture) return { __webglTexture: tex };
          if (o === p.target) return { __webglFramebuffer: [0, 1, 2, 3, 4, 5, 6].map((k) => `L${k}`) };
          if (!fbOf.has(o)) fbOf.set(o, { __webglFramebuffer: (o as THREE.WebGLRenderTarget).texture.name });
          return fbOf.get(o);
        },
      },
      state: {
        bindTexture(_t: number, t: object) { if (t !== tex) log.push('bind:other'); },
        bindFramebuffer(target: number, fb: string | null) { if (target === gl.READ_FRAMEBUFFER) read = fb ?? ''; else draw = fb ?? ''; },
      },
      setRenderTarget(t: THREE.WebGLRenderTarget | null, _face = 0, level = 0) {
        log.push(t ? `rt:${t.texture.name}@${level}:${t.viewport.z}x${t.viewport.w}` : 'rt:null');
      },
      render(sc: THREE.Scene) {
        const m = (sc.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
        log.push(`draw:${m.name}${m.uniforms.uLod ? `:lod${m.uniforms.uLod.value}` : ''}`);
      },
    };
    p.build(renderer as unknown as THREE.WebGLRenderer, new THREE.Texture(), new THREE.Texture(), new THREE.PerspectiveCamera());
    const level = (k: number, w: number, h: number): string[] => [
      `rt:br-pyramid-down.${k}@0:${w}x${h}`, `draw:br-pyramid-down:lod${k - 1}`, `blit:br-pyramid-down.${k}->L${k}:${w}x${h}`,
    ];
    expect(log).toEqual([
      'rt:Frame.ColorPyramid@0:64x32', 'draw:br-pyramid-full',
      // the levels past the chain are not allocated: sampling stops at its last level
      'max=6',
      ...level(1, 32, 16), ...level(2, 16, 8), ...level(3, 8, 4), ...level(4, 4, 2), ...level(5, 2, 1), ...level(6, 1, 1),
      'rt:null',
    ]);
    let freed = 0;
    for (const t of fbOf.keys()) (t as THREE.WebGLRenderTarget).addEventListener('dispose', () => { freed++; });
    p.release();
    expect(freed).toBe(6);
  });

  it('the downsample is the binomial [1 3 3 1] / 8 in fp32 (4 bilinear taps 0.75 texels off centre), clamped', () => {
    expect(MIP_DOWN_FRAG).toContain('vec2 o = 0.75 * uSrcInv;');
    expect(MIP_DOWN_FRAG.match(/textureLod\( tSrc, uv \+ vec2\( [-o. xy,]+\), uLod \)/g)).toHaveLength(4);
    expect(MIP_DOWN_FRAG).toContain('outColor = vec4( min( c.rgb, vec3( uMax ) ), c.a );');
    // per axis: the level-k texel's centre lies on a source texel boundary (0); bilinear taps at -0.75 and +0.75,
    // each weighing 1/2, split between the source texel centres at -1.5, -0.5, 0.5, 1.5
    const w = [0, 0, 0, 0];
    for (const x of [-0.75, 0.75]) {
      const i = Math.floor(x + 1.5), f = x + 1.5 - i;
      w[i] += 0.5 * (1 - f);
      w[i + 1] += 0.5 * f;
    }
    expect(w).toEqual([1 / 8, 3 / 8, 3 / 8, 1 / 8]);
  });
});
