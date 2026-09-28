// tests/materials/factory.test.ts (WP9) — the tile material factory: fresh materials and fresh uniform objects per
// tile (never Material.clone()), onBeforeCompile binds the SHARED global objects and the EXACT TileBindings objects
// by reference, one constant program cache key per (variant, quality defines), variant render state, quality
// defines applied only in setQuality, debug view as an int uniform.
// The expected program keys and defines are derived from qualityDefinesOf(QUALITY[name]) through FLAGS (an
// independent table of every QualityDefines field: key token and define), never from literals.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ShaderLib } from 'three';
import { bakeQualityOf, QUALITY, QUALITY_NAMES } from '../../src/core/quality.ts';
import type { QualityConfig } from '../../src/core/quality.ts';
import type { MaterialGlobals, MaterialSystem, TextureSet, TileMaterials } from '../../src/core/runtime.ts';
import { createGlobals, createMaterialSystem } from '../../src/materials/MaterialSystem.ts';
import { applySurfaceDefines, buildSurfaceFragment, buildSurfaceVertex, CACHE_KEY_PREFIX, SURFACE_VARIANTS } from '../../src/materials/SurfaceMaterial.ts';
import type { SurfaceVariant } from '../../src/materials/SurfaceMaterial.ts';
import { RIPPLE_LERP, waterFragmentGlsl } from '../../src/materials/WaterMaterial.ts';
import { bakedLobeRoughness, FRAG_LIGHTS_GLSL, LOBE } from '../../src/materials/chunks/lighting.ts';
import { f, TUNE } from '../../src/materials/chunks/params.ts';
import { definesKey, MRT_PASS, qualityDefinesOf, REFL_PASS } from '../../src/materials/shared.ts';
import type { QualityDefines } from '../../src/materials/shared.ts';

/** Every QualityDefines field: its program-key token (null: part of the R?A?L? prefix) and its surface define
 * (null: water-only, package E's applyWaterDefines); `only` restricts the define to one variant. */
const FLAGS: readonly { f: keyof QualityDefines; short: string | null; define: string | null; only?: SurfaceVariant }[] = [
  { f: 'floorRefl', short: null, define: 'BR_FLOOR_REFL' },
  { f: 'airlight', short: null, define: 'BR_AIRLIGHT' },
  { f: 'lite', short: null, define: 'BR_LITE' },
  { f: 'ssr', short: 'ssr', define: 'BR_SSR' },
  { f: 'probe', short: 'prb', define: 'BR_PROBE' },
  { f: 'ssao', short: 'ao', define: 'BR_SSAO' },
  { f: 'cs', short: 'cs', define: 'BR_CS_STEPS' },
  { f: 'puddles', short: 'pud', define: 'BR_PUDDLES' },
  { f: 'detail', short: 'det', define: 'BR_DETAIL_MAPS' },
  { f: 'pom', short: 'pom', define: 'BR_POM', only: 'shell' },
  { f: 'sheen', short: 'sh', define: 'USE_SHEEN' },
  { f: 'coat', short: 'cc', define: 'USE_CLEARCOAT', only: 'props' },
  { f: 'specAA', short: 'saa', define: 'BR_SPEC_AA' },
  { f: 'waterRefract', short: 'wr', define: 'BR_WATER_VOL' },
  { f: 'waterWaves', short: 'ww', define: null },
  { f: 'waterRipple', short: 'wp', define: null },
  { f: 'waterDebris', short: 'wd', define: 'BR_WATER_WETBAND' },
  { f: 'causticsFull', short: 'wc', define: 'BR_CAUSTICS_FULL' },
  { f: 'waterVolLight', short: 'wv', define: null },
  { f: 'volumetric', short: 'vol', define: 'BR_VOLUMETRIC' },
  { f: 'bounce', short: 'fb', define: 'BR_BOUNCE_N' },
];
const isOn = (v: boolean | number): boolean => v !== false && v !== 0;
function expectedKey(d: QualityDefines): string {
  let k = `R${d.floorRefl ? 1 : 0}A${d.airlight ? 1 : 0}L${d.lite ? 1 : 0}`;
  for (const { f, short } of FLAGS) if (short !== null && isOn(d[f])) k += `.${short}${d[f] === true ? 1 : d[f]}`;
  return k;
}
function expectedDefines(v: SurfaceVariant, d: QualityDefines): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === 'shell') out.BR_SHELL = '';
  if (v === 'props') { out.BR_PROPS = ''; out.BR_LV = ''; }
  if (v === 'decal') out.BR_DECAL = '';
  for (const { f, define, only } of FLAGS) {
    if (define !== null && isOn(d[f]) && (only === undefined || only === v)) out[define] = typeof d[f] === 'number' ? String(d[f]) : '';
  }
  return out;
}
const keyFor = (name: keyof typeof QUALITY): string => expectedKey(qualityDefinesOf(QUALITY[name]));
/** Every define on (numbers at their largest planned values). */
const ALL_ON: QualityDefines = {
  floorRefl: true, airlight: true, lite: false, ssr: true, probe: true, ssao: true, cs: 8, puddles: true, detail: true, pom: 2,
  sheen: true, coat: true, specAA: true, waterRefract: 10, waterWaves: 8, waterRipple: true, waterDebris: true,
  causticsFull: true, waterVolLight: 4, volumetric: true, bounce: 8,
};

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
    expect([...keys.get('shell')!][0]).toBe(`${CACHE_KEY_PREFIX}|shell|${keyFor('high')}`);
    expect([...keys.get('props')!][0]).toBe(`${CACHE_KEY_PREFIX}|props|${keyFor('high')}`);
    expect([...keys.get('decal')!][0]).toBe(`${CACHE_KEY_PREFIX}|decal|${keyFor('high')}`);
    expect([...keys.get('water')!][0]).toBe(`br-water-v2|${keyFor('high')}`);
  });

  it('compiled shader text is identical for every tile of a variant', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.medium);
    const a = compile(sys.createTileMaterials(false).shell);
    const b = compile(sys.createTileMaterials(false).shell);
    expect(a.fragmentShader).toBe(b.fragmentShader);
    expect(a.vertexShader).toBe(b.vertexShader);
  });

  it('variant render state: FrontSide, opaque shell/props, premultiplied decal, opaque refracting water; no three maps', () => {
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
    // package E: high refracts (split frames): the water is opaque and writes depth; the premultiplied blend stays for
    // the legacy path of tiles fading in
    const w = t.water as THREE.ShaderMaterial;
    expect(w.transparent).toBe(false);
    expect(w.depthWrite).toBe(true);
    expect(w.defines).toMatchObject({ BR_WATER_REFRACT: '8', BR_WATER_VOLLIGHT: '2' });
    expect(w.blending).toBe(THREE.CustomBlending);
    expect(w.blendSrc).toBe(THREE.OneFactor);
    expect(w.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(w.lights).toBe(true);
    // medium: the premultiplied water blended over the submerged surfaces (they absorb in their own shader)
    sys.setQuality(QUALITY.medium);
    expect(w.transparent).toBe(true);
    expect(w.depthWrite).toBe(false);
    expect(w.defines).not.toHaveProperty('BR_WATER_REFRACT');
  });

  it('quality defines follow the preset and change only in setQuality', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.low);
    const t = sys.createTileMaterials(true);
    expect(t.shell.defines).not.toHaveProperty('BR_FLOOR_REFL');
    expect(t.shell.defines).not.toHaveProperty('BR_AIRLIGHT');
    expect(t.shell.defines).toHaveProperty('BR_LITE'); // low: lite surface detail
    expect(keyOf(t.shell)).toBe(`${CACHE_KEY_PREFIX}|shell|${keyFor('low')}`);
    expect(sys.globals.floorReflOn.value).toBe(0);
    const v0 = t.shell.version;
    sys.setQuality(QUALITY.low); // no change -> no recompile
    expect(t.shell.version).toBe(v0);
    sys.setQuality(QUALITY.ultra);
    for (const m of [...surfaces(t)]) {
      expect(m.defines).toHaveProperty('BR_FLOOR_REFL');
      expect(m.defines).toHaveProperty('BR_AIRLIGHT');
      expect(m.defines).not.toHaveProperty('BR_LITE');
      expect(keyOf(m)).toBe(`${CACHE_KEY_PREFIX}|${m.userData.brVariant as string}|${keyFor('ultra')}`);
    }
    expect(t.shell.version).toBeGreaterThan(v0);
    expect((t.water as THREE.ShaderMaterial).defines).toHaveProperty('BR_AIRLIGHT');
    expect(sys.globals.floorReflOn.value).toBe(1);
    // tiles created afterwards use the new defines too
    const t2 = sys.createTileMaterials(false);
    expect(keyOf(t2.props)).toBe(`${CACHE_KEY_PREFIX}|props|${keyFor('ultra')}`);
    // disposed tiles are no longer touched by setQuality
    t2.dispose();
    const v2 = t2.props.version;
    sys.setQuality(QUALITY.low);
    expect(t2.props.version).toBe(v2);
    expect(keyOf(t.props)).toBe(`${CACHE_KEY_PREFIX}|props|${keyFor('low')}`);
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

describe('A.0 contract: quality defines, program keys, globals', () => {
  it('the FLAGS table covers every QualityDefines field', () => {
    expect(FLAGS.map((x) => x.f).sort()).toEqual(Object.keys(qualityDefinesOf(QUALITY.high)).sort());
  });

  it('every preset x variant: defines and program key follow the table', () => {
    for (const name of QUALITY_NAMES) {
      const d = qualityDefinesOf(QUALITY[name]);
      sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY[name]);
      const t = sys.createTileMaterials(true);
      for (const v of SURFACE_VARIANTS) {
        expect(t[v].defines, `${name}/${v}`).toEqual(expectedDefines(v, d));
        expect(keyOf(t[v]), `${name}/${v}`).toBe(`${CACHE_KEY_PREFIX}|${v}|${expectedKey(d)}`);
      }
      expect(keyOf(t.water!)).toBe(`br-water-v2|${expectedKey(d)}`);
      // package E: the water material's own defines follow the preset
      const wd: Record<string, string> = { BR_WATER: '' };
      if (d.airlight) wd.BR_AIRLIGHT = '';
      if (d.waterWaves > 0) wd.BR_WATER_WAVES = String(d.waterWaves);
      if (d.waterRipple) wd.BR_WATER_RIPPLE = '';
      if (d.waterDebris) wd.BR_WATER_DEBRIS = '';
      if (d.volumetric) wd.BR_VOLUMETRIC = ''; // package F: the water's haze reads the froxel volume
      if (d.waterRefract > 0) {
        wd.BR_WATER_REFRACT = String(d.waterRefract);
        if (d.waterVolLight > 0) wd.BR_WATER_VOLLIGHT = String(d.waterVolLight);
      }
      if (d.probe) wd.BR_PROBE = '';
      expect((t.water as THREE.ShaderMaterial).defines, name).toEqual(wd);
      expect((t.water as THREE.ShaderMaterial).depthWrite, name).toBe(d.waterRefract > 0);
      expect((t.water as THREE.ShaderMaterial).uniforms.uBrRippleLerp, name).toBe(RIPPLE_LERP);
      expect(definesKey(d)).toBe(expectedKey(d));
    }
  });

  it('every define on: the full mapping (POM on the shell only, clearcoat on props only)', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.ultra);
    const t = sys.createTileMaterials(false);
    for (const v of SURFACE_VARIANTS) {
      applySurfaceDefines(t[v], v, ALL_ON);
      expect(t[v].defines, v).toEqual(expectedDefines(v, ALL_ON));
      expect(keyOf(t[v])).toBe(`${CACHE_KEY_PREFIX}|${v}|${expectedKey(ALL_ON)}`);
    }
    expect(t.shell.defines).toMatchObject({ BR_POM: '2', BR_CS_STEPS: '8', BR_BOUNCE_N: '8', USE_SHEEN: '' });
    expect(t.props.defines).toHaveProperty('USE_CLEARCOAT');
    expect(t.shell.defines).not.toHaveProperty('USE_CLEARCOAT');
    expect(t.props.defines).not.toHaveProperty('BR_POM');
    // lite never gets the clearcoat or detail programs
    expect(qualityDefinesOf(QUALITY.low)).toMatchObject({ coat: false, detail: false });
    expect(qualityDefinesOf({ ...QUALITY.low, detailMaps: true }).detail).toBe(false);
  });

  it('decals blend the SSR attachment alpha with (Zero, OneMinusSrcAlpha) only when SSR is on', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.medium);
    const d = sys.createTileMaterials(false).decal;
    expect([d.blendSrcAlpha, d.blendDstAlpha, d.blendEquationAlpha]).toEqual([null, null, null]);
    applySurfaceDefines(d, 'decal', ALL_ON);
    expect([d.blendSrcAlpha, d.blendDstAlpha, d.blendEquationAlpha]).toEqual([THREE.ZeroFactor, THREE.OneMinusSrcAlphaFactor, THREE.AddEquation]);
    expect([d.blendSrc, d.blendDst, d.blendEquation]).toEqual([THREE.OneFactor, THREE.OneMinusSrcAlphaFactor, THREE.AddEquation]);
    applySurfaceDefines(d, 'decal', qualityDefinesOf(QUALITY.medium));
    expect([d.blendSrcAlpha, d.blendDstAlpha, d.blendEquationAlpha]).toEqual([null, null, null]);
    applySurfaceDefines(d, 'decal', qualityDefinesOf(QUALITY.high)); // high / ultra trace SSR
    expect([d.blendSrcAlpha, d.blendDstAlpha, d.blendEquationAlpha]).toEqual([THREE.ZeroFactor, THREE.OneMinusSrcAlphaFactor, THREE.AddEquation]);
  });

  it('program keys differ for every single-field change (no token collisions)', () => {
    const base = qualityDefinesOf(QUALITY.medium);
    const keys = new Set([definesKey(base)]);
    for (const { f } of FLAGS) {
      const v = base[f];
      keys.add(definesKey({ ...base, [f]: typeof v === 'boolean' ? !v : v === 0 ? 3 : 0 } as QualityDefines));
    }
    expect(keys.size).toBe(FLAGS.length + 1);
    // numbers keep their value in the key
    expect(definesKey({ ...base, cs: 8 })).not.toBe(definesKey({ ...base, cs: 12 }));
    expect(definesKey({ ...base, pom: 1 })).toContain('.pom1');
  });

  it('setQuality compares the full key: a change of any define recompiles, an identical preset does not', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const t = sys.createTileMaterials(true);
    const v0 = t.shell.version;
    sys.setQuality({ ...QUALITY.high });
    expect(t.shell.version).toBe(v0);
    // floorRefl and airlight unchanged: the old early return skipped this
    // flip two flags relative to the preset, so the owners' final values never turn this into a no-op
    const bounce = QUALITY.high.flashlightBounce === 4 ? 8 : 4;
    const q: QualityConfig = { ...QUALITY.high, detailMaps: !QUALITY.high.detailMaps, flashlightBounce: bounce };
    sys.setQuality(q);
    expect(t.shell.version).toBeGreaterThan(v0);
    expect(t.shell.defines).toMatchObject({ BR_BOUNCE_N: String(bounce) });
    expect('BR_DETAIL_MAPS' in t.shell.defines!).toBe(q.detailMaps);
    expect(keyOf(t.props)).toBe(`${CACHE_KEY_PREFIX}|props|${expectedKey(qualityDefinesOf(q))}`);
    expect(keyOf(t.water!)).toBe(`br-water-v2|${expectedKey(qualityDefinesOf(q))}`);
  });

  it('new globals start inert and every MaterialGlobals / TileBindings field is bound by reference', () => {
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.ultra);
    const g = sys.globals;
    expect(g.probeTex.value).toBeNull();
    expect(g.sceneColor.value).toBeNull();
    expect(g.hiZ.value).toBeNull();
    expect(g.ripple.value).toBeNull();
    for (const k of ['probeOn', 'waterVolOn', 'fbOn', 'rippleOn', 'nDrips', 'nUw'] as const) expect(g[k].value, k).toBe(0);
    expect(g.csOn.value).toBe(1);
    expect(g.ssaoParams.value.x).toBe(0); // the surfaces never read uSsaoTex
    expect(g.volZ.value.w).toBe(0); // the analytic haze
    const half = (t: THREE.Texture): number[] => [...((t as THREE.DataTexture).image.data as Uint16Array)].map((h) => THREE.DataUtils.fromHalfFloat(h));
    expect(g.ssaoTex.value.type).toBe(THREE.HalfFloatType);
    expect(half(g.ssaoTex.value)).toEqual([1, 1, 1, 1]);
    expect(half(g.volTex.value)).toEqual([0, 0, 0, 1]);
    for (const [k, n] of [['fbP', 8], ['fbN', 8], ['fbC', 8], ['fbBox', 8], ['drips', 8], ['uwPos', 4], ['uwDir', 4], ['uwCol', 4]] as const) {
      expect(g[k].value.length, k).toBe(n);
      expect(new Set(g[k].value).size, k).toBe(n);
    }
    const t = sys.createTileMaterials(true);
    expect(t.bindings.water.value).toBe(0);
    for (const m of [...surfaces(t), t.water!]) {
      const u = m instanceof THREE.ShaderMaterial ? m.uniforms : compile(m).uniforms;
      const bound = new Set<unknown>(Object.values(u));
      for (const k of Object.keys(g) as (keyof MaterialGlobals)[]) expect(bound.has(g[k]), `globals.${k}`).toBe(true);
      for (const k of Object.keys(t.bindings) as (keyof typeof t.bindings)[]) expect(bound.has(t.bindings[k]), `bindings.${k}`).toBe(true);
      expect(u.uBrMrt).toBe(MRT_PASS);
      expect(u.uBrReflPass).toBe(REFL_PASS);
      expect(u.uTileWater).toBe(t.bindings.water);
      expect(u.uSsaoP).toBe(g.ssaoParams);
      expect(u.uBrProbe).toBe(g.probeTex);
    }
    // the shared layer tables C/D/E (package B fills them) and the detail array: one object for every tile
    const a = compile(sys.createTileMaterials(false).shell).uniforms;
    const b = compile(sys.createTileMaterials(false).props).uniforms;
    for (const n of ['uBrLayerC', 'uBrLayerD', 'uBrLayerE', 'uBrDetail']) expect(a[n], n).toBe(b[n]);
    expect((a.uBrLayerC.value as Float32Array).length).toBe(28 * 4);
    expect(a.uBrDetail.value).toBeNull();
    expect(createGlobals().ssaoTex.value).not.toBe(g.ssaoTex.value); // per system, never shared module state
  });

  it('every bound uniform is declared exactly once, with matching array sizes and int counters', () => {
    const texts = {
      vertex: buildSurfaceVertex(ShaderLib.physical.vertexShader),
      fragment: buildSurfaceFragment(ShaderLib.physical.fragmentShader),
      water: waterFragmentGlsl(),
    };
    const decls = (s: string, n: string): RegExpMatchArray[] => [...s.matchAll(new RegExp(`\\buniform\\s+(\\w+)\\s+${n}\\s*(\\[[^\\]]*\\])?\\s*;`, 'g'))];
    sys = createMaterialSystem(fakeRenderer, fakeTextures(), QUALITY.high);
    const u = compile(sys.createTileMaterials(true).shell).uniforms;
    for (const n of Object.keys(u)) {
      const counts = Object.values(texts).map((s) => decls(s, n).length);
      expect(Math.max(...counts), `${n} declared twice`).toBeLessThanOrEqual(1);
      expect(counts.some((c) => c === 1), `${n} declared nowhere`).toBe(true);
    }
    const arr = (n: string): string => decls(texts.fragment, n)[0][2].replace(/[[\]\s]/g, '');
    for (const [n, len] of [['uFbP', 8], ['uFbN', 8], ['uFbC', 8], ['uFbBox', 8], ['uDrips', 8], ['uUwPos', 4], ['uUwDir', 4], ['uUwCol', 4]] as const) {
      expect(arr(n), n).toBe(String(len));
      expect((u[n].value as unknown[]).length, n).toBe(len);
    }
    expect(decls(texts.fragment, 'uNDrips')[0][1]).toBe('int');
    expect(decls(texts.fragment, 'uNUw')[0][1]).toBe('int');
    expect(decls(texts.fragment, 'uBrProbe')[0][1]).toBe('samplerCube');
    expect(decls(texts.fragment, 'uBrDetail')[0][1]).toBe('sampler2DArray');
  });
});

describe('A.0 contract: quality presets', () => {
  const NEW_FIELDS = [
    'ssr', 'ssrMaxRoughness', 'ssrSteps', 'ssrFilter', 'reflectionProbe', 'colorPyramidScale', 'contactShadowSteps', 'wetPuddles',
    'detailMaps', 'pom', 'clothSheen', 'specularAA', 'motionBlurTaps', 'glareStreaks', 'glareGhosts', 'waterRefractionSteps',
    'waterWaves', 'waterRippleRes', 'waterRippleTexel', 'waterDebris', 'waterCaustics', 'waterVolumetrics', 'volumetrics',
    'dustMotes', 'flashlightBounce', 'bakeNearRays',
  ] as const;

  it('every graphics-realism field sits on its own line in every preset (one-line flips per owner)', () => {
    const src = readFileSync(new URL('../../src/core/quality.ts', import.meta.url), 'utf8');
    for (const f of NEW_FIELDS) {
      expect(src.match(new RegExp(`^ {4}${f}: [^,\\n]+,$`, 'gm'))?.length ?? 0, f).toBe(4);
      for (const n of QUALITY_NAMES) expect(QUALITY[n], `${n}.${f}`).toHaveProperty(f);
    }
  });

  it('bakeQualityOf sends nearRays only when > 0 (worker inputs of presets without it stay byte-identical)', () => {
    for (const n of QUALITY_NAMES) {
      const b = bakeQualityOf(QUALITY[n]);
      if (QUALITY[n].bakeNearRays > 0) expect(b.nearRays).toBe(QUALITY[n].bakeNearRays);
      else expect(Object.keys(b)).toEqual(['tpc', 'shadowSamples', 'probeRays']);
    }
    expect(bakeQualityOf({ ...QUALITY.high, bakeNearRays: 16 }).nearRays).toBe(16);
  });
});

describe('the baked dominant-direction lobe is an area estimate (chunks/lighting.ts)', () => {
  const MIN = TUNE.DIRECT_MIN_ROUGH;

  it('a single frontal source (w = 1, n_g . L above NG_FADE) keeps max(r, DIRECT_MIN_ROUGH)', () => {
    for (const r of [0, 0.1, MIN, 0.5, 0.9]) {
      expect(bakedLobeRoughness(r, 1, LOBE.NG_FADE)).toBeCloseTo(Math.max(r, MIN), 12);
      expect(bakedLobeRoughness(r, 1, 1)).toBeCloseTo(Math.max(r, MIN), 12);
    }
  });

  it('widens with the spread of the averaged directions and toward grazing directions, alpha^2 adding like variances', () => {
    const a = (r: number): number => r * r; // three: alpha = roughness^2
    const a0 = a(MIN);
    expect(a(bakedLobeRoughness(0.05, 0.6, 1)) ** 2).toBeCloseTo(a0 * a0 + LOBE.K1 * 0.4, 12);
    expect(a(bakedLobeRoughness(0.05, 1, 0)) ** 2).toBeCloseTo(a0 * a0 + LOBE.K2, 12);
    expect(a(bakedLobeRoughness(0.05, 1, -0.2)) ** 2).toBeCloseTo(a0 * a0 + LOBE.K2, 12);
    let prev = 0;
    for (const ngl of [1, 0.3, 0.2, 0.1, 0.05, 0]) {
      const r = bakedLobeRoughness(0.1, 0.9, ngl);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(bakedLobeRoughness(1, 0, 0)).toBe(1); // clamped
  });

  it('the shader widens the base and the clearcoat lobe of the baked RE_Direct call only, and restores both', () => {
    const src = FRAG_LIGHTS_GLSL;
    expect(src).toContain(`#define BR_LOBE_K1 ${f(LOBE.K1)}`);
    const block = src.slice(src.indexOf('if ( brW > 0.0 ) {'), src.indexOf('irradiance += brEf'));
    expect(block).toContain('float brLobeX = BR_LOBE_K1 * ( 1.0 - brW ) + BR_LOBE_K2 * ( 1.0 - smoothstep( 0.0, BR_LOBE_NG_FADE, dot( brNg, brLv ) ) );');
    expect(block).toContain('material.roughness = min( 1.0, sqrt( sqrt( brLa * brLa + brLobeX ) ) );');
    expect(block).toContain('material.clearcoatRoughness = min( 1.0, sqrt( sqrt( brCa * brCa + brLobeX ) ) );');
    expect(block.indexOf('RE_Direct(')).toBeGreaterThan(block.indexOf('material.clearcoatRoughness = min('));
    expect(block).toContain('material.roughness = brR0;');
    expect(block).toContain('material.clearcoatRoughness = brCcR0;');
  });
});
