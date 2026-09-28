// tests/post/ssr.test.ts — package D's screen-space reflections: the Hi-Z layout (level sizes, the remainder texels),
// the glossy cone's footprint, the composite's confidence mix (CPU twins in post/ssr/ssrGlsl.ts) and the shape of the
// shader sources (texelFetch of the Hi-Z at a level, the hook order on the frame graph).

import { describe, expect, it } from 'vitest';
import { QUALITY } from '../../src/core/quality.ts';
import {
  coneLod, compositeSpecular, HIZ_FRAG, hiZLayout, hiZSpan, SSR, SSR_COMPOSITE_SPECULAR, SSR_FILTER_FRAG, SSR_TRACE_FRAG,
  SSR_TRACE_GLSL,
} from '../../src/post/ssr/ssrGlsl.ts';
import { MRT_COMPOSITE_FRAG } from '../../src/post/frame/MrtComposite.ts';
import { PYR_MAX } from '../../src/post/frame/ColorPyramid.ts';
import { HDR_CLAMP } from '../../src/core/constants.ts';
import { ssrSettingsOf, ssrStepFor } from '../../src/post/ssr/SsrTrace.ts';

describe('Hi-Z layout', () => {
  it('level 0 is half the frame (rounded up), then floor-halved down to 1x1, HIZ_LEVELS of them built', () => {
    const L = hiZLayout(1920, 1080);
    expect(L.sizes[0]).toEqual([960, 540]);
    expect(L.sizes[1]).toEqual([480, 270]);
    expect(L.sizes[L.levels - 1]).toEqual([1, 1]);
    expect(L.levels).toBe(Math.floor(Math.log2(960)) + 1);
    expect(L.built).toBe(SSR.HIZ_LEVELS);
    const odd = hiZLayout(2401, 1351);
    expect(odd.sizes[0]).toEqual([1201, 676]);
    expect(odd.sizes[1]).toEqual([600, 338]);
    const tiny = hiZLayout(6, 4);
    expect(tiny.sizes).toEqual([[3, 2], [1, 1]]);
    expect(tiny.built).toBe(2);
  });

  it('every source texel is covered by exactly one texel of the level above (odd remainders fold into the last)', () => {
    for (const src of [1, 2, 3, 5, 8, 675, 1201, 1351]) {
      const dst = Math.max(1, src >> 1);
      const seen = new Array<number>(src).fill(0);
      for (let t = 0; t < dst; t++) for (const s of new Set(hiZSpan(t, dst, src))) seen[s]++;
      expect(seen.every((n) => n === 1)).toBe(true);
    }
  });

  it('level 0 covers every full-resolution pixel (ceil halving: the last texel may see one pixel twice)', () => {
    for (const w of [1, 2, 7, 1920, 2401]) {
      const dst = Math.ceil(w / 2);
      const seen = new Set<number>();
      for (let t = 0; t < dst; t++) for (const s of hiZSpan(t, dst, w)) seen.add(s);
      expect(seen.size).toBe(w);
    }
  });

  it('a clamped lookup of any traced cell lands on a texel whose span contains it', () => {
    // positions run up to W/2 level-0 cells; level k cell c = floor(x / 2^k) clamped to the level size
    const W = 1351;
    const L = hiZLayout(W, 8);
    for (let k = 0; k < L.built; k++) {
      const n = L.sizes[k][0];
      for (let x = 0; x < W / 2; x += 0.37) {
        const c = Math.min(Math.floor(x / 2 ** k), n - 1);
        // the level-0 cells that texel c covers, found by descending the spans
        let lo = c, hi = c;
        for (let j = k; j > 0; j--) {
          const srcN = L.sizes[j - 1][0], dstN = L.sizes[j][0];
          lo = Math.min(...hiZSpan(lo, dstN, srcN));
          hi = Math.max(...hiZSpan(hi, dstN, srcN));
        }
        expect(Math.floor(x)).toBeGreaterThanOrEqual(lo);
        expect(Math.floor(x)).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe('glossy cone footprint', () => {
  const pxPerRad = 0.5 * 1080 * 1.732;
  it('is monotonic in roughness and ray length, and a point (LOD 0) for a mirror', () => {
    expect(coneLod(0, 5, 10, pxPerRad).lod).toBe(0);
    let prev = -1;
    for (const r of [0.05, 0.1, 0.2, 0.3, 0.45, 0.6]) {
      const l = coneLod(r, 5, 10, pxPerRad).diameter;
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
    prev = -1;
    for (const len of [0.5, 1, 2, 5, 20]) {
      const l = coneLod(0.3, len, 10, pxPerRad).diameter;
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
    // farther hits of the same cone cover fewer pixels
    expect(coneLod(0.3, 5, 20, pxPerRad).diameter).toBeLessThan(coneLod(0.3, 5, 10, pxPerRad).diameter);
  });
});

describe('composite', () => {
  it('confidence 0 (or no weight) gives exactly the fallback; confidence 1 gives Ws x the reflection', () => {
    const s1 = [0.3, 0.2, 0.1, 0.25] as const;
    expect(compositeSpecular(s1, [0, 0, 0, 0])).toEqual([0.3, 0.2, 0.1]);
    expect(compositeSpecular([0.3, 0.2, 0.1, 0], [5, 5, 5, 1])).toEqual([0.3, 0.2, 0.1]);
    const full = compositeSpecular(s1, [8, 4, 2, 1]);
    expect(full[0]).toBeCloseTo(0.25 * 8, 6);
    expect(full[1]).toBeCloseTo(0.25 * 4, 6);
    expect(full[2]).toBeCloseTo(0.25 * 2, 6);
    // premultiplied half confidence: the midpoint of fallback and Ws x colour
    const half = compositeSpecular(s1, [4, 2, 1, 0.5]);
    expect(half[0]).toBeCloseTo(0.5 * 0.3 + 0.5 * 0.25 * 8, 6);
  });

  it('the composite shader keeps the fallback path exact and mixes by confidence', () => {
    expect(MRT_COMPOSITE_FRAG).toContain('vec3 spec = s1.rgb;');
    expect(SSR_COMPOSITE_SPECULAR).toContain('uSsrP.x > 0.5 && s1.a > 0.0');
    expect(SSR_COMPOSITE_SPECULAR).toContain('spec = mix( s1.rgb, s1.a * ssr.rgb / max( ssr.a, 1e-4 ), ssr.a );');
    expect(MRT_COMPOSITE_FRAG).toContain('outColor = vec4( outc, 1.0 );');
    for (const u of ['tC0', 'tS1', 'tN2', 'tSsr', 'tDepth', 'uSsrP', 'uLin']) expect(MRT_COMPOSITE_FRAG).toMatch(new RegExp(`uniform [\\w ]+ ${u};`));
  });
});

describe('shader sources', () => {
  it('the trace steps through the Hi-Z with texelFetch at a level, bounded by BR_SSR_STEPS', () => {
    expect(SSR_TRACE_GLSL).toMatch(/texelFetch\( uHiZ, [^;]*, lvl \)/);
    expect(SSR_TRACE_GLSL).toContain('for ( int i = 0; i < BR_SSR_STEPS; i ++ )');
    expect(SSR_TRACE_GLSL).toContain('bool brSsrTrace( vec3 P, vec3 R, mat4 proj, float maxDist');
    // usable in any program that declares uHiZ / uHiZInfo (the water shader): no other uniform
    const uniforms = SSR_TRACE_GLSL.match(/\buniform\b/g);
    expect(uniforms).toBeNull();
    expect(SSR_TRACE_FRAG).toContain(SSR_TRACE_GLSL);
  });

  it('the Hi-Z build reads a source level and folds the odd remainder into the last texel', () => {
    expect(HIZ_FRAG).toContain('texelFetch( tSrc, min( s0 + ivec2( x, y ), last ), uLevel )');
    expect(HIZ_FRAG).toContain('clamp( uSrcSize.x - s0.x, 1, 3 )');
  });

  it('the ultra filter leaves mirrors sharp', () => {
    expect(SSR_FILTER_FRAG).toContain(`m.w <= ${SSR.FILTER_ROUGH}`);
  });

  it('traces at half the display resolution: 2x2 blocks, 3x3 on ultra\'s 1.5x supersampled buffer', () => {
    expect(ssrStepFor(1)).toBe(2);
    expect(ssrStepFor(0.7)).toBe(2);
    expect(ssrStepFor(QUALITY.ultra.renderScale)).toBe(3);
    expect(SSR_TRACE_FRAG).toContain('ivec2 p = min( ivec2( gl_FragCoord.xy ) * uStep, ivec2( uFull ) - 1 );');
    expect(SSR_COMPOSITE_SPECULAR).toContain('vec2 tf = vec2( p ) / uSsrP.z;');
  });

  it('a texel averages its whole block and traces a normal-mapped block along the macro (depth) normal', () => {
    // every pixel of the step x step block (ultra's 3x3 too, not a 2x2 subset)
    expect(SSR_TRACE_FRAG).toContain('for ( int k = 1; k < uStep * uStep; k ++ )');
    // ...of the representative's lobe only (a shore block must not blend a mirror with the wet carpet around it)
    expect(SSR_TRACE_FRAG).toContain('if ( gk.a < 0.5 || abs( gk.b - g.b ) > BR_SSR_BLOCK_DR ) continue;');
    // disagreeing normals (1 - |mean| over NVAR) move the traced lobe to the depth normal; the cone keeps the spread
    expect(SSR.NVAR[0]).toBeLessThan(SSR.NVAR[1]);
    expect(SSR_TRACE_FRAG).toContain('vec3 Nt = normalize( mix( N, Ng, smoothstep( BR_SSR_NVAR0, BR_SSR_NVAR1, 1.0 - nLen ) ) );');
    expect(SSR_TRACE_FRAG).toContain('vec3 R = reflect( - V, Nt );');
    expect(SSR_TRACE_FRAG).toContain('float a = sqrt( pow4( rough ) + ( 1.0 - nLen ) / nLen );');
    // rays below the macro surface are left to the fallback
    const i = SSR_TRACE_FRAG.indexOf('float up = dot( R, Ng );');
    expect(i).toBeGreaterThan(0);
    expect(SSR_TRACE_FRAG.indexOf('if ( up <= 0.0 ) return;')).toBeGreaterThan(i);
    expect(SSR_TRACE_FRAG.indexOf('if ( up <= 0.0 ) return;')).toBeLessThan(SSR_TRACE_FRAG.indexOf('brSsrTrace( P + Nt'));
  });

  it('half-float mips never reach the cone lookups as Inf: the pyramid is clamped, a non-finite lookup is a miss', () => {
    // gl.generateMipmap may sum a 2x2 block of an RGBA16F level in half precision (NVIDIA GL): 4 x PYR_MAX must fit
    expect(4 * PYR_MAX).toBeLessThan(65504);
    expect(PYR_MAX).toBeLessThanOrEqual(HDR_CLAMP);
    const i = SSR_TRACE_FRAG.indexOf('vec3 col = textureGrad( tPyr');
    expect(i).toBeGreaterThan(0);
    expect(SSR_TRACE_FRAG.slice(i, i + 400)).toContain('if ( any( isnan( col ) ) || any( isinf( col ) ) ) return;');
  });

  it('presets: high and ultra trace, ultra filters; low and medium do not', () => {
    expect(QUALITY.low.ssr).toBe('off');
    expect(QUALITY.medium.ssr).toBe('off');
    expect(ssrSettingsOf(QUALITY.high)).toEqual({ maxRough: 0.45, steps: 48, filter: false });
    expect(ssrSettingsOf(QUALITY.ultra)).toEqual({ maxRough: 0.6, steps: 56, filter: true });
  });
});
