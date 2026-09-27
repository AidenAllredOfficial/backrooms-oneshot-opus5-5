// tests/materials/anchors.test.ts (WP9) — every shader chunk WP9 injects after / replaces exists (exactly once) in
// three's ShaderLib.physical (three pinned to 0.186.1), the injection plan is what SurfaceMaterial applies, and the
// fully expanded surface / water shaders are structurally sound GLSL (balanced braces, parentheses and #if blocks).

import { describe, expect, it } from 'vitest';
import { REVISION, ShaderChunk, ShaderLib } from 'three';
import { injectAt, SHADER_ANCHORS, SURFACE_INJECTIONS } from '../../src/materials/anchors.ts';
import { buildSurfaceFragment, buildSurfaceVertex } from '../../src/materials/SurfaceMaterial.ts';
import { WATER_VERTEX_GLSL, waterFragmentGlsl } from '../../src/materials/WaterMaterial.ts';
import { LENS_SHIMMER_GLSL } from '../../src/core/flicker.ts';
import { FRAG_FOG_GLSL } from '../../src/materials/chunks/haze.ts';

const physical = ShaderLib.physical;
const srcOf = (stage: 'vertex' | 'fragment'): string => (stage === 'vertex' ? physical.vertexShader : physical.fragmentShader);
const count = (s: string, sub: string): number => s.split(sub).length - 1;

/** Resolve `#include <x>` recursively with ShaderChunk (what three's WebGLProgram does). */
function expand(src: string, depth = 0): string {
  if (depth > 8) throw new Error('include recursion');
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
    const chunk = (ShaderChunk as unknown as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`unknown chunk ${name}`);
    return expand(chunk, depth + 1);
  });
}

/** Strip comments; check braces/parentheses/brackets balance and #if/#endif nesting. */
function structure(src: string): { braces: number; parens: number; brackets: number; ifDepthOk: boolean; ifDepth: number } {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let braces = 0, parens = 0, brackets = 0, depth = 0, ok = true;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (/^#\s*if/.test(t)) depth++;
    else if (/^#\s*endif/.test(t)) { depth--; if (depth < 0) ok = false; }
    if (t.startsWith('#')) continue;
    for (const ch of t) {
      if (ch === '{') braces++; else if (ch === '}') braces--;
      else if (ch === '(') parens++; else if (ch === ')') parens--;
      else if (ch === '[') brackets++; else if (ch === ']') brackets--;
    }
  }
  return { braces, parens, brackets, ifDepthOk: ok, ifDepth: depth };
}

describe('WP9 shader anchors (three r186)', () => {
  it('runs against the pinned three revision', () => {
    expect(REVISION).toBe('186');
  });

  it('every SHADER_ANCHORS include exists exactly once in ShaderLib.physical', () => {
    expect(SHADER_ANCHORS.length).toBeGreaterThan(0);
    for (const a of SHADER_ANCHORS) {
      const n = count(srcOf(a.stage), `#include <${a.include}>`);
      expect(n, `${a.stage}: #include <${a.include}>`).toBe(1);
    }
  });

  it('SHADER_ANCHORS lists exactly the injection plan (no hidden anchors)', () => {
    expect(SHADER_ANCHORS.map((a) => `${a.stage}:${a.include}`)).toEqual(SURFACE_INJECTIONS.map((a) => `${a.stage}:${a.include}`));
    const keys = new Set(SHADER_ANCHORS.map((a) => `${a.stage}:${a.include}`));
    expect(keys.size).toBe(SHADER_ANCHORS.length);
    for (const a of SHADER_ANCHORS) expect(ShaderChunk).toHaveProperty(a.include);
  });

  it('covers every chunk the spec requires', () => {
    const need = ['map_fragment', 'roughnessmap_fragment', 'metalnessmap_fragment', 'normal_fragment_maps', 'emissivemap_fragment',
      'lights_physical_fragment', 'lights_fragment_maps', 'aomap_fragment', 'fog_fragment'];
    const frag = new Set(SHADER_ANCHORS.filter((a) => a.stage === 'fragment').map((a) => a.include));
    for (const n of need) expect(frag.has(n), n).toBe(true);
    const vert = new Set(SHADER_ANCHORS.filter((a) => a.stage === 'vertex').map((a) => a.include));
    expect(vert.has('uv_vertex')).toBe(true);
    expect(vert.has('worldpos_vertex')).toBe(true);
  });

  it('r186 chunk order assumptions hold (roughness before normal maps, fog after colorspace)', () => {
    const f = physical.fragmentShader;
    const at = (n: string): number => f.indexOf(`#include <${n}>`);
    expect(at('map_fragment')).toBeLessThan(at('roughnessmap_fragment'));
    expect(at('roughnessmap_fragment')).toBeLessThan(at('normal_fragment_maps'));
    expect(at('normal_fragment_maps')).toBeLessThan(at('emissivemap_fragment'));
    // the material-post anchor: after three fills `material`, before lights_fragment_begin computes material.dfg
    expect(at('emissivemap_fragment')).toBeLessThan(at('lights_physical_fragment'));
    expect(at('lights_physical_fragment')).toBeLessThan(at('lights_fragment_begin'));
    expect(at('lights_fragment_begin')).toBeLessThan(at('lights_fragment_maps'));
    expect(at('lights_fragment_maps')).toBeLessThan(at('lights_fragment_end'));
    expect(at('lights_fragment_end')).toBeLessThan(at('aomap_fragment'));
    expect(at('colorspace_fragment')).toBeLessThan(at('fog_fragment'));
    // lights_fragment_begin sets geometryNormal = the PERTURBED normal and initialises material.dfg
    expect(ShaderChunk.lights_fragment_begin).toMatch(/vec3 geometryNormal = normal;/);
    expect(ShaderChunk.lights_fragment_begin).toMatch(/material\.dfg = /);
  });

  it('injectAt inserts after / replaces, and fails loudly on a missing or duplicated anchor', () => {
    const src = 'a\n#include <x>\nb';
    expect(injectAt(src, 'x', 'CODE', 'after')).toContain('#include <x>\nCODE');
    const rep = injectAt(src, 'x', 'CODE', 'replace');
    expect(rep).toContain('CODE');
    expect(rep).not.toContain('#include <x>');
    expect(() => injectAt(src, 'y', 'CODE', 'after')).toThrow(/anchor missing/);
    expect(() => injectAt(src + '\n#include <x>', 'x', 'CODE', 'after')).toThrow(/not unique/);
  });

  it('replaced chunks are gone and kept chunks remain after injection', () => {
    const v = buildSurfaceVertex(physical.vertexShader);
    const f = buildSurfaceFragment(physical.fragmentShader);
    for (const a of SURFACE_INJECTIONS) {
      const out = a.stage === 'vertex' ? v : f;
      expect(count(out, `#include <${a.include}>`), `${a.stage}:${a.include}`).toBe(a.mode === 'replace' ? 0 : 1);
    }
    // memoised: identical text on the second call
    expect(buildSurfaceFragment(physical.fragmentShader)).toBe(f);
  });

  it('expanded surface shaders are structurally balanced and carry the WP9 code', () => {
    const v = expand(buildSurfaceVertex(physical.vertexShader));
    const f = expand(buildSurfaceFragment(physical.fragmentShader));
    // three's own sources contain #if/#else alternatives that open a brace in each branch, so compare against the
    // unmodified program: our injections must not change the balance
    const base = { vertex: structure(expand(physical.vertexShader)), fragment: structure(expand(physical.fragmentShader)) };
    for (const [s, b] of [[v, base.vertex], [f, base.fragment]] as const) {
      const st = structure(s);
      expect(st.braces).toBe(b.braces);
      expect(st.parens).toBe(b.parens);
      expect(st.brackets).toBe(b.brackets);
      expect(st.ifDepthOk).toBe(true);
      expect(st.ifDepth).toBe(0);
    }
    for (const a of ['vec2 brLmUv', 'float brLayer', 'float brFlags', 'vec4 brTint', 'float brEmit', 'vec4 brAux']) expect(v).toContain(`attribute ${a};`);
    expect(v).toMatch(/flat varying float vBrLayer;/);
    expect(f).toMatch(/flat varying float vBrFlags;/);
    expect(f).toContain(LENS_SHIMMER_GLSL.trim()); // injected verbatim (WP11 owns it)
    expect(f).toMatch(/min\(\s*max\(\s*gl_FragColor\.rgb,\s*vec3\(\s*0\.0\s*\)\s*\),\s*vec3\(\s*BR_HDR_CLAMP\s*\)\s*\)/);
    expect(f).toMatch(/#define BR_HDR_CLAMP 32768\.0/);
    expect(f).toMatch(/material\.multiScatteringCompensation = 1\.0 \+ material\.specularColorBlended/);
    expect(f).toMatch(/RE_Direct\(/);
    expect(f).toMatch(/computeSpecularOcclusion\(/);
    // no float32 world-position varying
    expect(v).not.toMatch(/varying vec3 vBrWorld/);
    // the fade dither runs at main start (before any sampling)
    expect(f.indexOf('brBayer4( gl_FragCoord.xy ) >= uFade')).toBeLessThan(f.indexOf('==== WP9 surface sampling'));
    // HDR clamp is the last thing the fog replacement does (after haze); only the G-buffer outputs follow it
    expect(f.lastIndexOf('BR_HDR_CLAMP')).toBeGreaterThan(f.indexOf('brHaze('));
    const clamp = FRAG_FOG_GLSL.indexOf('gl_FragColor.rgb = min( max( gl_FragColor.rgb');
    expect(clamp).toBeGreaterThan(FRAG_FOG_GLSL.indexOf('brHaze('));
    expect(FRAG_FOG_GLSL.slice(clamp + 1)).not.toMatch(/gl_FragColor(\.\w+)?\s*[*+-]?=[^=]/);
  });

  it('A.0 extension points: stub chunks in owner order, lighting / haze hooks in place', () => {
    const f = buildSurfaceFragment(physical.fragmentShader);
    // 'fragment:common' appends A (screenspace, gbuffer), B (detail, pom), C (emitters), D (probe), E (water), F
    // (volumetric, bounce), after the WP9 declarations
    const marks = ['uniform float uBrMrt;', 'float brSsao(', 'out highp vec4 brOut1;', '// ---- detail maps (package B)',
      '// ---- parallax occlusion mapping (package B)', '// ---- emitter profiles (package C)', 'float brProbeWeight(',
      'float brWaterWetBand(', 'vec4 brVolLookup(', '// ---- flashlight bounce (package F)', '#include <clipping_planes_pars_fragment>'];
    const at = marks.map((m) => f.indexOf(m));
    for (let i = 0; i < marks.length; i++) {
      expect(at[i], marks[i]).toBeGreaterThan(0);
      if (i > 0) expect(at[i], `${marks[i - 1]} before ${marks[i]}`).toBeGreaterThan(at[i - 1]);
    }
    // the material-post anchor sits between three's material setup and the DFG in lights_fragment_begin
    expect(f.indexOf('#include <lights_physical_fragment>')).toBeLessThan(f.indexOf('#include <lights_fragment_begin>'));
    // lighting: SSAO factors after the flicker loop, the split variables, brDirVis inside the directional block before
    // RE_Direct, the bounce inline after the ambient lines, the planar floor path compiled out under BR_SSR
    const i = (s: string): number => { const k = f.indexOf(s); expect(k, s).toBeGreaterThan(0); return k; };
    expect(i('float brSs = 1.0, brSsK = 1.0;')).toBeGreaterThan(i('brEf += max( brFl[ k ], 0.0 )'));
    expect(i('bool brMrtSpec = false;')).toBeLessThan(i('if ( brW > 0.0 ) {'));
    expect(i('float brDirVis = 1.0;')).toBeGreaterThan(i('if ( brW > 0.0 ) {'));
    expect(i('brDL.color = brW * brE / brNgL * brDirVis;')).toBeLessThan(i('RE_Direct( brDL'));
    expect(i('iblIrradiance += ( 1.0 - brW ) * ( brE * brSsC );')).toBeLessThan(i('vec3 brIrrLocal'));
    expect(i('computeSpecularOcclusion( brDotNV, brAO * brSsK * brCav')).toBeGreaterThan(0);
    expect(f.indexOf('uReflTex, brRuv')).toBeGreaterThan(f.indexOf('#ifndef BR_SSR'));
    expect(f.match(/\( brAO \* brSsK \)/g)?.length).toBe(2);
    // haze: brHazeT next to brHazeTerms; the MRT write after the clamp
    expect(i('float brHazeT( vec3 viewPos )')).toBeGreaterThan(i('void brHazeTerms('));
    expect(i('brOut1 = brO1;')).toBeGreaterThan(i('gl_FragColor.rgb = min( max( gl_FragColor.rgb'));
  });

  it('the water shader is structurally balanced, premultiplied and clamped', () => {
    const v = expand(WATER_VERTEX_GLSL);
    const f = expand(waterFragmentGlsl());
    for (const s of [v, f]) {
      const st = structure(s);
      expect(st.braces).toBe(0);
      expect(st.parens).toBe(0);
      expect(st.ifDepth).toBe(0);
      expect(st.ifDepthOk).toBe(true);
    }
    expect(f).toMatch(/gl_FragColor = vec4\( min\( max\( col, vec3\( 0\.0 \) \), vec3\( BR_HDR_CLAMP \) \), A \);/);
    // premultiplied: the Fresnel weight is the alpha, and floating matter only raises it
    expect(f).toMatch(/float A = F;/);
  });
});
