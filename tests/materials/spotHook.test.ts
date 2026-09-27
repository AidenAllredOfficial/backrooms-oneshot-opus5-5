// tests/materials/spotHook.test.ts — package E's in-water flashlight hook: chunks/surface.ts redirects three's
// getSpotLightInfo call in lights_fragment_begin to brSpotInfoW (chunks/water.ts) with a function-like #define at
// the end of the emissive chunk, and chunks/lighting.ts #undefs it at its start. The redirect relies on three r186's
// exact call text, pinned here.

import { describe, expect, it } from 'vitest';
import { ShaderChunk, ShaderLib } from 'three';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';
import { WATER_SPOT_GLSL } from '../../src/materials/chunks/water.ts';

describe('in-water flashlight hook (getSpotLightInfo redirect)', () => {
  const f = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
  const count = (s: string, sub: string): number => s.split(sub).length - 1;

  it('exactly one #define before lights_fragment_begin and one #undef after it (before the baked lighting)', () => {
    expect(count(f, '#define getSpotLightInfo(')).toBe(1);
    expect(count(f, '#undef getSpotLightInfo')).toBe(1);
    const def = f.indexOf('#define getSpotLightInfo('), begin = f.indexOf('#include <lights_fragment_begin>');
    const undef = f.indexOf('#undef getSpotLightInfo'), baked = f.indexOf('// ==== WP9 baked lighting');
    expect(def).toBeGreaterThan(f.indexOf('vec4 brSubInfo = brWaterSubInfo('));
    expect(def).toBeLessThan(begin);
    expect(undef).toBeGreaterThan(begin);
    expect(undef).toBeLessThan(baked);
    expect(f.slice(def, f.indexOf('\n', def))).toBe('#define getSpotLightInfo( l, p, d ) brSpotInfoW( l, p, d, brSubInfo )');
  });

  it('three r186 still calls getSpotLightInfo( spotLight, geometryPosition, directLight ) once in lights_fragment_begin', () => {
    expect(count(ShaderChunk.lights_fragment_begin, 'getSpotLightInfo( spotLight, geometryPosition, directLight );')).toBe(1);
    expect(count(ShaderChunk.lights_fragment_begin, 'getSpotLightInfo(')).toBe(1);
    expect(ShaderChunk.lights_pars_begin).toContain('void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light )');
  });

  it('brSpotInfoW is declared after three\'s light pars (clipping_planes_pars injection) and calls the original', () => {
    const pars = f.indexOf('#include <lights_pars_begin>'), decl = f.indexOf('void brSpotInfoW(');
    expect(decl).toBeGreaterThan(pars);
    expect(decl).toBeLessThan(f.indexOf('void main()'));
    expect(WATER_SPOT_GLSL).toContain('getSpotLightInfo( spotLight, geometryPosition, light );');
    // the full caustic path only under BR_CAUSTICS_FULL; otherwise the redirect is the plain call
    expect(WATER_SPOT_GLSL.indexOf('#ifdef BR_CAUSTICS_FULL')).toBeGreaterThan(WATER_SPOT_GLSL.indexOf('getSpotLightInfo( spotLight'));
  });
});
