// tests/materials/factory.test.ts (WP9) — the tile material factory: fresh materials and fresh uniform objects per
// tile (never Material.clone()), onBeforeCompile binds the SHARED global objects and the EXACT TileBindings objects
// by reference, one constant program cache key per (variant, quality defines), variant render state, quality
// defines applied only in setQuality, debug view as an int uniform.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ShaderLib } from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import type { MaterialSystem, TextureSet, TileMaterials } from '../../src/core/runtime.ts';
import { createMaterialSystem } from '../../src/materials/MaterialSystem.ts';
import { CACHE_KEY_PREFIX } from '../../src/materials/SurfaceMaterial.ts';

function fakeTextures(): TextureSet {
  const t = (name: string): THREE.Texture => { const x = new THREE.Texture(); x.name = name; return x; };
  return {
    size: 512, albedo: t('albedo'), normal: t('normal'), ormh: t('ormh'), grime: t('grime'),
    waterNormals: t('waterNormals'), cookie: t('cookie'), dispose() { /* test */ },
  };
}
const fakeRenderer = {} as unknown as THREE.WebGLRenderer;

interface FakeShader { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }
function compile(m: THREE.Material): FakeShader {
  const shader: FakeShader = { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
  (m.onBeforeCompile as (s: FakeShader, r: THREE.WebGLRenderer) => void)(shader, fakeRenderer);
  return shader;
}
const keyOf = (m: THREE.Material): string => m.customProgramCacheKey();
const surfaces = (t: TileMaterials): THREE.MeshStandardMaterial[] => [t.shell, t.props, t.decal];

let sys: MaterialSystem | null = null;
afterEach(() => { vi.restoreAllMocks(); sys = null; });

describe('WP9 material factory', () => {
  it('creates fresh MeshStandardMaterials and fresh binding objects per tile, never via clone()', () => {
    const cloneSpy = vi.spyOn(THREE.Material.prototype, 'clone');
    const copySpy = vi.spyOn(THREE.Material.prototype, 'copy');
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const a = sys.createTileMaterials(true);
    const b = sys.createTileMaterials(false);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    for (const m of [...surfaces(a), ...surfaces(b)]) expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(a.shell).not.toBe(b.shell);
    expect(a.props).not.toBe(b.props);
    expect(a.bindings).not.toBe(b.bindings);
    for (const k of Object.keys(a.bindings) as (keyof typeof a.bindings)[]) expect(a.bindings[k], k).not.toBe(b.bindings[k]);
    expect(a.bindings.flick.value).toBeInstanceOf(Float32Array);
    expect(a.bindings.flick.value.length).toBe(27);
    expect(a.bindings.flick.value).not.toBe(b.bindings.flick.value);
    expect(a.water).toBeInstanceOf(THREE.ShaderMaterial);
    expect(b.water).toBeNull();
    // missing data defaults to the shared zero textures
    expect(a.bindings.lmFlick.value).toBe(sys.zeroTextures.lm2d);
    expect(a.bindings.volC.value).toBe(sys.zeroTextures.vol3d);
    expect(a.bindings.fade.value).toBe(1);
  });

  it('onBeforeCompile puts the shared globals and the exact per-tile uniform objects into shader.uniforms', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const t = sys.createTileMaterials(true);
    const g = sys.globals;
    for (const m of [...surfaces(t), t.water!]) {
      const u = m instanceof THREE.ShaderMaterial ? m.uniforms : compile(m).uniforms;
      expect(u.uTime).toBe(g.time);
      expect(u.uDebugView).toBe(g.debugView);
      expect(u.uHazeDensity).toBe(g.hazeDensity);
      expect(u.uHazeTint).toBe(g.hazeTint);
      expect(u.uHazeAlbedo).toBe(g.hazeAlbedo);
      expect(u.uEdgeFog).toBe(g.edgeFog);
      expect(u.uFarColor).toBe(g.farColor);
      expect(u.uFlickerMode).toBe(g.flickerMode);
      expect(u.uReflTex).toBe(g.reflTex);
      expect(u.uReflMatrix).toBe(g.reflMatrix);
      expect(u.uReflOn).toBe(g.reflOn);
      expect(u.uReflY).toBe(g.reflY);
      expect(u.uFloorReflOn).toBe(g.floorReflOn);
      const b = t.bindings;
      expect(u.uTileOrigin).toBe(b.tileOrigin);
      expect(u.uNoiseOrigin).toBe(b.noiseOrigin);
      expect(u.uLmIrr).toBe(b.lmIrr);
      expect(u.uLmDir).toBe(b.lmDir);
      expect(u.uLmMask).toBe(b.lmMask);
      expect(u.uLmFlick).toBe(b.lmFlick);
      expect(u.uEmission).toBe(b.emission);
      expect(u.uVolA).toBe(b.volA);
      expect(u.uVolB).toBe(b.volB);
      expect(u.uVolC).toBe(b.volC);
      expect(u.uVolMask).toBe(b.volMask);
      expect(u.uFlick).toBe(b.flick);
      expect(u.uOwnParity).toBe(b.ownParity);
      expect(u.uFade).toBe(b.fade);
    }
    // a later .value assignment (WP10/WP11) is visible through the compiled uniforms
    const u = compile(t.shell).uniforms;
    const tex = new THREE.Texture();
    t.bindings.lmFlick.value = tex;
    expect(u.uLmFlick.value).toBe(tex);
    sys.setDebugView(4);
    expect(u.uDebugView.value).toBe(4);
  });

  it('the shared texture set is bound (same objects in every tile)', () => {
    const tex = fakeTextures();
    sys = createMaterialSystem(fakeRenderer, tex, QUALITY.high);
    const a = compile(sys.createTileMaterials(false).shell).uniforms;
    const b = compile(sys.createTileMaterials(false).props).uniforms;
    expect(a.uBrAlbedo.value).toBe(tex.albedo);
    expect(a.uBrNormal.value).toBe(tex.normal);
    expect(a.uBrOrmh.value).toBe(tex.ormh);
    expect(a.uBrGrime.value).toBe(tex.grime);
    expect(a.uBrAlbedo).toBe(b.uBrAlbedo);
    expect(a.uBrLayerA).toBe(b.uBrLayerA);
    expect((a.uBrLayerA.value as Float32Array).length).toBe(28 * 4);
  });

  it('100 tile material sets share one cache key per variant (one program per variant)', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const keys = new Map<string, Set<string>>();
    const progKeys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const t = sys.createTileMaterials(true);
      for (const m of [...surfaces(t), t.water!]) {
        const v = m.userData.brVariant as string;
        if (!keys.has(v)) keys.set(v, new Set());
        keys.get(v)!.add(keyOf(m));
        // what three folds into the program key beyond customProgramCacheKey: defines + onBeforeCompile source
        progKeys.add(`${m.type}|${keyOf(m)}|${JSON.stringify(m.defines)}|${m.onBeforeCompile.toString()}`);
      }
    }
    expect([...keys.keys()].sort()).toEqual(['decal', 'props', 'shell', 'water']);
    for (const [v, s] of keys) expect(s.size, v).toBe(1);
    expect(progKeys.size).toBe(4);
    expect([...keys.get('shell')!][0]).toBe(`${CACHE_KEY_PREFIX}|shell|R1A1L0`);
    expect([...keys.get('props')!][0]).toBe(`${CACHE_KEY_PREFIX}|props|R1A1L0`);
    expect([...keys.get('decal')!][0]).toBe(`${CACHE_KEY_PREFIX}|decal|R1A1L0`);
  });

  it('compiled shader text is identical for every tile of a variant', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.medium);
    const a = compile(sys.createTileMaterials(false).shell);
    const b = compile(sys.createTileMaterials(false).shell);
    expect(a.fragmentShader).toBe(b.fragmentShader);
    expect(a.vertexShader).toBe(b.vertexShader);
  });

  it('variant render state: FrontSide, opaque shell/props, premultiplied decal, blended water; no three maps', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const t = sys.createTileMaterials(true);
    for (const m of surfaces(t)) {
      expect(m.side).toBe(THREE.FrontSide);
      expect(m.transparent).toBe(false);
      expect(m.map).toBeNull();
      expect(m.normalMap).toBeNull();
      expect(m.lightMap).toBeNull();
      expect(m.aoMap).toBeNull();
      expect(m.roughnessMap).toBeNull();
      expect(m.emissiveMap).toBeNull();
    }
    expect(t.shell.blending).toBe(THREE.NormalBlending);
    expect(t.shell.depthWrite).toBe(true);
    expect(t.shell.defines).toHaveProperty('BR_SHELL');
    expect(t.props.defines).toHaveProperty('BR_PROPS');
    expect(t.props.defines).toHaveProperty('BR_LV');
    expect(t.shell.defines).not.toHaveProperty('BR_LV');
    const d = t.decal;
    expect(d.defines).toHaveProperty('BR_DECAL');
    expect(d.blending).toBe(THREE.CustomBlending);
    expect(d.blendSrc).toBe(THREE.OneFactor);
    expect(d.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(d.transparent).toBe(false);
    expect(d.depthWrite).toBe(false);
    expect(d.polygonOffset).toBe(true);
    expect(d.polygonOffsetFactor).toBe(-1);
    expect(d.polygonOffsetUnits).toBe(-4);
    const w = t.water as THREE.ShaderMaterial;
    expect(w.transparent).toBe(true);
    expect(w.depthWrite).toBe(false);
    expect(w.blending).toBe(THREE.CustomBlending);
    expect(w.blendSrc).toBe(THREE.OneFactor);
    expect(w.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(w.lights).toBe(true);
  });

  it('quality defines follow the preset and change only in setQuality', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.low);
    const t = sys.createTileMaterials(true);
    expect(t.shell.defines).not.toHaveProperty('BR_FLOOR_REFL');
    expect(t.shell.defines).not.toHaveProperty('BR_AIRLIGHT');
    expect(t.shell.defines).toHaveProperty('BR_LITE'); // low: lite surface detail
    expect(keyOf(t.shell)).toBe(`${CACHE_KEY_PREFIX}|shell|R0A0L1`);
    expect(sys.globals.floorReflOn.value).toBe(0);
    const v0 = t.shell.version;
    sys.setQuality(QUALITY.low); // no change -> no recompile
    expect(t.shell.version).toBe(v0);
    sys.setQuality(QUALITY.ultra);
    for (const m of [...surfaces(t)]) {
      expect(m.defines).toHaveProperty('BR_FLOOR_REFL');
      expect(m.defines).toHaveProperty('BR_AIRLIGHT');
      expect(m.defines).not.toHaveProperty('BR_LITE');
      expect(keyOf(m)).toMatch(/\|R1A1L0$/);
    }
    expect(t.shell.version).toBeGreaterThan(v0);
    expect((t.water as THREE.ShaderMaterial).defines).toHaveProperty('BR_AIRLIGHT');
    expect(sys.globals.floorReflOn.value).toBe(1);
    // tiles created afterwards use the new defines too
    const t2 = sys.createTileMaterials(false);
    expect(keyOf(t2.props)).toBe(`${CACHE_KEY_PREFIX}|props|R1A1L0`);
    // disposed tiles are no longer touched by setQuality
    t2.dispose();
    const v2 = t2.props.version;
    sys.setQuality(QUALITY.low);
    expect(t2.props.version).toBe(v2);
    expect(keyOf(t.props)).toBe(`${CACHE_KEY_PREFIX}|props|R0A0L1`);
  });

  it('setDebugView writes the int uniform only (no recompiles)', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const t = sys.createTileMaterials(false);
    const v0 = t.shell.version;
    const k0 = keyOf(t.shell);
    sys.setDebugView(9);
    expect(sys.globals.debugView.value).toBe(9);
    sys.setDebugView(Number.NaN);
    expect(sys.globals.debugView.value).toBe(0);
    expect(t.shell.version).toBe(v0);
    expect(keyOf(t.shell)).toBe(k0);
  });

  it('dispose() disposes the tile materials exactly once and leaves textures alone', () => {
    const tex = fakeTextures();
    sys = createMaterialSystem(fakeRenderer, tex, QUALITY.high);
    const t = sys.createTileMaterials(true);
    const spies = [...surfaces(t), t.water!].map((m) => vi.spyOn(m, 'dispose'));
    const texSpy = vi.spyOn(tex.albedo, 'dispose');
    const zeroSpy = vi.spyOn(sys.zeroTextures.lm2d, 'dispose');
    t.dispose();
    t.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    expect(texSpy).not.toHaveBeenCalled();
    expect(zeroSpy).not.toHaveBeenCalled();
  });
});
