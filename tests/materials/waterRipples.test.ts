import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events.ts';
import { Mood, Zone } from '../../src/core/ids.ts';
import { createEmptyLayout } from '../../src/core/layout.ts';
import { createPlayerState } from '../../src/core/player.ts';
import { QUALITY } from '../../src/core/quality.ts';
import { createGlobals } from '../../src/materials/MaterialSystem.ts';
import { RIPPLE_LERP } from '../../src/materials/WaterMaterial.ts';
import { createWaterRipples } from '../../src/materials/water/WaterRipples.ts';
import { RIPPLE } from '../../src/materials/water/rippleSources.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup(loaded = true) {
  const globals = createGlobals();
  const bus = new EventBus<GameEvents>();
  const ripples = createWaterRipples(globals, { ...QUALITY.high, waterRippleRes: 32, waterRippleTexel: 0.1 }, bus);
  cleanups.push(() => { ripples.dispose(); globals.ssaoTex.value.dispose(); globals.volTex.value.dispose(); });
  const player = createPlayerState(0, 8, 0, 8, 0, 0);
  player.waterDepth = 0.3;
  const layout = createEmptyLayout({ s: 0, cx: 0, cz: 0 }, Zone.POOLROOMS, 0, Mood.NORMAL);
  layout.ceilCm.fill(300); layout.waterCm.fill(30);
  layout.water.push({ x0: 0, z0: 0, x1: 38.4, z1: 38.4, y: 0.3, floorY: 0, kind: 0 });
  const world = { layoutAt: (cx: number, cz: number) => loaded && cx === 0 && cz === 0 ? layout : null };
  const previous = new THREE.WebGLCubeRenderTarget(4);
  cleanups.push(() => previous.dispose());
  let target: THREE.WebGLRenderTarget | null = previous, face = 4, level = 2;
  const clearColor = new THREE.Color(0.2, 0.3, 0.4);
  let alpha = 0.6, failDraw = false, failClear = false;
  const draws: { impulses: number; shift: number[] }[] = [];
  const renderer = {
    autoClear: true,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => level,
    setRenderTarget(rt: THREE.WebGLRenderTarget | null, f = 0, l = 0) { target = rt; face = f; level = l; },
    getClearColor(out: THREE.Color) { return out.copy(clearColor); },
    getClearAlpha: () => alpha,
    setClearColor(value: THREE.ColorRepresentation, a = 1) { clearColor.set(value); alpha = a; },
    clear() { if (failClear) throw new Error('clear failed'); },
    render(scene: THREE.Scene) {
      if (failDraw) throw new Error('draw failed');
      const u = ((scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).uniforms;
      draws.push({ impulses: u.uNImp.value, shift: u.uShift.value.toArray() });
    },
  };
  return { ripples, globals, bus, player, world, previous, draws, renderer,
    get target() { return target; }, get face() { return face; }, get level() { return level; },
    get clearColor() { return clearColor; }, get alpha() { return alpha; },
    set loaded(value: boolean) { loaded = value; },
    set failDraw(value: boolean) { failDraw = value; }, set failClear(value: boolean) { failClear = value; },
    update(dt: number, time: number) { ripples.update(renderer as unknown as THREE.WebGLRenderer, dt, time, player, world); },
  };
}

describe('water ripple runtime', () => {
  it('drops a hitch backlog without negative interpolation or skipped following frames', () => {
    const t = setup();
    t.update(0, 0);
    t.update(0.2, 0.2);
    expect(t.ripples.stats().steps).toBe(RIPPLE.MAX_STEPS);
    expect(RIPPLE_LERP.value).toBeGreaterThanOrEqual(0);
    expect(RIPPLE_LERP.value).toBeLessThan(1);
    t.update(RIPPLE.DT, 0.2 + RIPPLE.DT);
    expect(t.ripples.stats().steps).toBe(RIPPLE.MAX_STEPS + 1);
  });

  it('rebuilds a stationary mask when chunk water data arrives or leaves', () => {
    const t = setup(false);
    t.update(0, 0);
    expect(t.ripples.stats().maskCells).toBe(0);
    t.loaded = true;
    t.bus.emit('chunkLoaded', { key: '0:0:0' });
    t.update(0, 0);
    expect(t.ripples.stats().maskCells).toBeGreaterThan(0);
    expect(t.ripples.stats().maskBuilds).toBe(2);
    t.loaded = false;
    t.bus.emit('chunkUnloaded', { key: '0:0:0' });
    t.update(0, 0);
    expect(t.ripples.stats().maskCells).toBe(0);
    expect(t.ripples.stats().maskBuilds).toBe(3);
  });

  it('drops the old storey plane and queued impulses on a storey switch', () => {
    const t = setup();
    t.update(0, 0);
    t.ripples.poke(0, 0);
    expect(t.ripples.stats().impulses).toBe(1);
    t.bus.emit('storeyChanged', { from: 0, to: 1, dy: 0, via: 'elevator' });
    expect(t.globals.rippleOn.value).toBe(0);
    expect(t.ripples.stats().impulses).toBe(0);
    t.loaded = false; t.player.waterDepth = 0;
    t.update(0, 0);
    expect(t.ripples.stats().plane).toBeNull();
  });

  it('restores the target face and mip and autoClear after failed simulation draws', () => {
    const t = setup();
    t.update(0, 0);
    t.ripples.poke(0, 0);
    t.failDraw = true;
    expect(() => t.ripples.step(1)).toThrow('draw failed');
    expect(t.target).toBe(t.previous);
    expect([t.face, t.level]).toEqual([4, 2]);
    expect(t.renderer.autoClear).toBe(true);
    expect(t.ripples.stats().steps).toBe(0);
    expect(t.ripples.stats().impulses).toBe(1);
    t.failDraw = false;
    t.ripples.step(1);
    expect(t.draws[0].impulses).toBe(1);
  });

  it('restores clear colour, alpha and target face and mip after failed clears', () => {
    const t = setup();
    t.failClear = true;
    expect(() => t.update(0, 0)).toThrow('clear failed');
    expect(t.clearColor.toArray()).toEqual([0.2, 0.3, 0.4]);
    expect(t.alpha).toBe(0.6);
    expect(t.target).toBe(t.previous);
    expect([t.face, t.level]).toEqual([4, 2]);
    t.failClear = false;
  });
});
