// tests/post/ssr.test.ts — package D's screen-space reflections: the Hi-Z layout (level sizes, the remainder texels),
// the glossy cone's footprint, the resolve's kernel, the composite's confidence mix (CPU twins in post/ssr/ssrGlsl.ts)
// and the shape of the shader sources (texelFetch of the Hi-Z at a level, the hook order on the frame graph).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY } from '../../src/core/quality.ts';
import {
  compositeSpecular, HIZ_FRAG, hiZLayout, hiZSpan, lobeCones, lobeFootprint, resolveKernel, resolveTap, SSR,
  SSR_COMPOSITE_SPECULAR, SSR_RESOLVE_FRAG, SSR_TRACE_FRAG, SSR_TRACE_GLSL, symAxis,
} from '../../src/post/ssr/ssrGlsl.ts';
import { MRT_COMPOSITE_FRAG } from '../../src/post/frame/MrtComposite.ts';
import { MIP_DOWN_FRAG, PYR_MAX } from '../../src/post/frame/ColorPyramid.ts';
import { HDR_CLAMP } from '../../src/core/constants.ts';
import { ScreenSpaceReflections, ssrSettingsOf, ssrStepFor } from '../../src/post/ssr/SsrTrace.ts';

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

describe('glossy lobe footprint', () => {
  // view space, camera at the origin looking down -z, 1920 x 1080, 60 deg vertical field of view
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
  cam.updateProjectionMatrix();
  const W = 1920, H = 1080;
  const project = (v: readonly [number, number, number]): [number, number] => {
    const p = new THREE.Vector3(...v).applyMatrix4(cam.projectionMatrix);
    return [(p.x * 0.5 + 0.5) * W, (p.y * 0.5 + 0.5) * H];
  };
  const len = (g: readonly [number, number]): number => Math.hypot(g[0], g[1]);
  const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // a floor 1.6 m below the eye seen at N.V = 0.2 (P 8 m away); its reflected ray meets a wall facing it at wallZ
  const grazing = (tn: number, wallZ = -20) => {
    const P: [number, number, number] = [0, -1.6, -Math.sqrt(64 - 1.6 * 1.6)];
    const N: [number, number, number] = [0, 1, 0];
    const v = new THREE.Vector3(...P).normalize();
    const R: [number, number, number] = [v.x, -v.y, v.z]; // reflect(-V, N) about the floor
    const t = (wallZ - P[2]) / R[2];
    const Ph: [number, number, number] = [P[0] + R[0] * t, P[1] + R[1] * t, wallZ];
    return { P, N, R, Ph, L0: t, fp: lobeFootprint(P, R, N, 0.2, Ph, [0, 0, 1], tn, project) };
  };

  it('keeps the lobe\'s spread in the plane of incidence and narrows it by N.V across it (grazing floor)', () => {
    const { fp, L0 } = grazing(0.1);
    // the in-plane edges lie 2 tn L0 apart along the wall (over the cosine of R's tilt to its normal), the
    // out-of-plane ones 2 tn N.V L0: on a wall facing the camera the screen ellipse keeps that ratio (about 0.18),
    // down to the pyramid's anisotropy cap
    const [e0, e1, e2, e3] = fp.edges;
    expect(dist(e0, e1) / (2 * 0.1 * L0)).toBeGreaterThan(0.95);
    expect(dist(e0, e1) / (2 * 0.1 * L0)).toBeLessThan(1.1);
    expect(dist(e2, e3) / (2 * 0.1 * 0.2 * L0)).toBeCloseTo(1, 1);
    expect(len(fp.gO) / len(fp.gI)).toBeGreaterThan(Math.max(0.15, 1 / SSR.PYR_ANISO) - 1e-9);
    expect(len(fp.gO) / len(fp.gI)).toBeLessThan(Math.max(0.22, 1 / SSR.PYR_ANISO + 1e-9));
    // the in-plane axis is vertical on screen (the streak of a lamp in a wet floor)
    expect(Math.abs(fp.gI[1])).toBeGreaterThan(10 * Math.abs(fp.gI[0]));
  });

  it('a frontal view is isotropic', () => {
    // a receiver seen head-on (N.V = 1) whose reflected ray meets a plane facing it 3 m away
    const fp = lobeFootprint([0, 0, -5], [0, 0, 1], [0, 0, 1], 1, [0, 0, -2], [0, 0, -1], 0.1, (v) => [v[0] * 100, v[1] * 100]);
    expect(dist(fp.edges[0], fp.edges[1])).toBeCloseTo(dist(fp.edges[2], fp.edges[3]), 9);
    expect(len(fp.gI)).toBeCloseTo(len(fp.gO), 6);
    expect(len(fp.gI)).toBeCloseTo(2 * 0.1 * 3 * 100, 6);
  });

  it('is smaller than the screen disc stretched along the normal it replaced (N.V = 0.2)', () => {
    const tn = 0.1;
    const { fp, L0, Ph } = grazing(tn);
    // the old lookup: diameter D = 2 tn L0 px/rad / z, x min(1 / max(N.V, 0.15), 4) along the projected normal
    const D = (2 * tn * L0 * 0.5 * H * cam.projectionMatrix.elements[5]) / -Ph[2];
    const oldArea = 4 * D * D;
    expect(len(fp.gI) * len(fp.gO)).toBeLessThan(oldArea / 15);
    // the in-plane axis alone is about the old unstretched diameter
    expect(len(fp.gI) / D).toBeGreaterThan(0.9);
    expect(len(fp.gI) / D).toBeLessThan(1.2);
  });

  it('grows with the lobe and the ray length; a mirror is a point', () => {
    expect(len(grazing(0).fp.gI)).toBe(0);
    let prev = -1;
    for (const tn of [0.01, 0.05, 0.1, 0.2, 0.4]) {
      const l = len(grazing(tn).fp.gI);
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
    const near = grazing(0.1, -12), far = grazing(0.1, -40);
    expect(dist(far.fp.edges[0], far.fp.edges[1])).toBeGreaterThan(dist(near.fp.edges[0], near.fp.edges[1]));
  });

  it('a hit plane seen edge-on along the lobe stretches the footprint along it, within LEN_MAX', () => {
    // the grazing floor's lobe meets a ceiling 1.2 m above the eye instead of a wall
    const P: [number, number, number] = [0, -1.6, -Math.sqrt(64 - 1.6 * 1.6)];
    const v = new THREE.Vector3(...P).normalize();
    const R: [number, number, number] = [v.x, -v.y, v.z];
    const t = (1.2 - P[1]) / R[1];
    const Ph: [number, number, number] = [0, 1.2, P[2] + R[2] * t];
    const fp = lobeFootprint(P, R, [0, 1, 0], 0.2, Ph, [0, -1, 0], 0.1, project);
    const wall = lobeFootprint(P, R, [0, 1, 0], 0.2, Ph, [0, 0, 1], 0.1, project);
    expect(dist(fp.edges[0], fp.edges[1])).toBeGreaterThan(2 * dist(wall.edges[0], wall.edges[1]));
    for (const e of fp.edges) expect(dist(e, P)).toBeLessThanOrEqual(SSR.LEN_MAX * t * Math.hypot(1, 0.1) + 1e-9);
    // the ellipse's axis ratio stays within the pyramid's anisotropy
    const r = len(fp.gI) / len(fp.gO);
    expect(Math.max(r, 1 / r)).toBeLessThanOrEqual(SSR.PYR_ANISO + 1e-9);
  });

  it('the lookup, symmetric about the hit, never reaches past the nearer end of an oblique footprint', () => {
    // the grazing floor's lobe on a ceiling: its edge rays meet it at very different lengths, so the hit lies far off
    // the footprint's middle on screen
    const P: [number, number, number] = [0, -1.6, -Math.sqrt(64 - 1.6 * 1.6)];
    const v = new THREE.Vector3(...P).normalize();
    const R: [number, number, number] = [v.x, -v.y, v.z];
    const t = (1.2 - P[1]) / R[1];
    const Ph: [number, number, number] = [0, 1.2, P[2] + R[2] * t];
    const fp = lobeFootprint(P, R, [0, 1, 0], 0.2, Ph, [0, -1, 0], 0.2, project);
    const p0 = project(Ph);
    const a = project(fp.edges[0]), b = project(fp.edges[1]);
    const ax = [a[0] - b[0], a[1] - b[1]], l = Math.hypot(ax[0], ax[1]);
    const along = (q: readonly [number, number]): number => Math.abs(((q[0] - p0[0]) * ax[0] + (q[1] - p0[1]) * ax[1]) / l);
    const near = Math.min(along(a), along(b)), far = Math.max(along(a), along(b));
    expect(far / near).toBeGreaterThan(2.5); // an axis of |a - b| centred on the hit would overshoot the near end
    expect(len(fp.gI) / 2).toBeLessThanOrEqual(near + 1e-6);
    expect(len(fp.gI) / 2).toBeGreaterThan(0.99 * near);
    // a symmetric footprint (a wall facing the ray) keeps its full axes
    expect(symAxis([10, 0], [-10, 0], [0, 0])).toEqual([20, 0]);
    expect(symAxis([10, 0], [-30, 0], [0, 0])).toEqual([20, 0]);
    expect(symAxis([0, 0], [0, 0], [5, 5])).toEqual([0, 0]);
    // the shader does the same to both axes
    expect(SSR_TRACE_FRAG).toContain('gI = brSymAxis( brFootPx( P, R + eI, Nh, hd, L0 ), brFootPx( P, R - eI, Nh, hd, L0 ), p0 ) / uFull;');
    expect(SSR_TRACE_FRAG).toContain('gO = brSymAxis( brFootPx( P, R + eO, Nh, hd, L0 ), brFootPx( P, R - eO, Nh, hd, L0 ), p0 ) / uFull;');
  });

  it('the trace looks the core and the tail up in the pyramid, centred on the hit', () => {
    expect(SSR_TRACE_FRAG).toContain('brSsrFootprint( P, R, Nt, nv, Ph, Nh, BR_SSR_CONE * a, gI, gO );');
    expect(SSR_TRACE_FRAG).toContain('vec3 col = textureGrad( tPyr, hitUv, gI, gO ).rgb;');
    expect(SSR_TRACE_FRAG).toContain('BR_SSR_CONE * sqrt( BR_SSR_TAIL_K * BR_SSR_TAIL_K * pow4( rough ) + ( 1.0 - nLen ) / nLen )');
    expect(SSR_TRACE_FRAG).toContain('col = mix( col, textureGrad( tPyr, hitUv, gI, gO ).rgb, BR_SSR_TAIL_W );');
    expect(SSR_TRACE_FRAG).not.toMatch(/STRETCH/);
  });

  it('the tail widens the microfacet lobe only (a block\'s normal spread is Gaussian, not heavy-tailed)', () => {
    const glossy = lobeCones(0.2, 1);
    expect(glossy.core).toBeCloseTo(SSR.CONE * 0.04, 9);
    expect(glossy.tail).toBeCloseTo(SSR.TAIL_K * glossy.core, 9);
    // a rippled puddle: the Toksvig spread dominates, the tail stays near the core
    const rippled = lobeCones(0.08, 0.98);
    expect(rippled.tail / rippled.core).toBeLessThan(1.02);
    expect(SSR.TAIL_W).toBeGreaterThan(0);
    expect(SSR.TAIL_W).toBeLessThan(0.3);
  });
});

describe('resolve', () => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
  cam.updateProjectionMatrix();
  const p11 = cam.projectionMatrix.elements[5];
  const angle = (a: THREE.Vector3, b: THREE.Vector3): number => a.angleTo(b);

  it('a neighbour whose ray hits d away along our lobe sits d x Lr / (|P| + Lr) away on screen (a mirror is a window)', () => {
    // a floor 1.6 m below the eye, a wall facing the camera 20 m away: the reflected ray of view direction v meets it at H
    const hit = (v: THREE.Vector3): { P: THREE.Vector3; H: THREE.Vector3 } => {
      const P = v.clone().multiplyScalar(-1.6 / v.y);
      const R = new THREE.Vector3(v.x, -v.y, v.z);
      return { P, H: P.clone().addScaledVector(R, (-20 - P.z) / R.z) };
    };
    const v = new THREE.Vector3(0, -1.6, -8).normalize();
    const { P, H } = hit(v);
    const Lr = P.distanceTo(H);
    for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]) {
      const dv = 0.002;
      const v2 = v.clone().applyAxisAngle(axis, dv);
      const { H: H2 } = hit(v2);
      // the lobe direction from P that reaches the neighbour's hit is off ours by dv x (|P| + Lr) / Lr
      const lobeOff = angle(H.clone().sub(P), H2.clone().sub(P));
      expect(lobeOff * Lr / (P.length() + Lr) / dv).toBeGreaterThan(0.9);
      expect(lobeOff * Lr / (P.length() + Lr) / dv).toBeLessThan(1.1);
    }
  });

  it('the kernel follows the lobe and the ray length, narrows by N.V across the plane of incidence, and is capped', () => {
    const P: [number, number, number] = [0, -1.6, -8];
    const k = resolveKernel(P, 0.2, 0.05, 12, p11, 1080, 2);
    const angleSd = SSR.RESOLVE_K * SSR.RESOLVE_SD * 0.05 * 12 / (Math.hypot(...P) + 12);
    expect(k[0]).toBeLessThan(SSR.RESOLVE_MAX);
    expect(k[0]).toBeCloseTo(angleSd * p11 * 540 / 2, 9);
    expect(k[1] / k[0]).toBeCloseTo(0.2, 9);
    // a mirror and a contact reflection are points; ultra's 3x3 blocks make the texels a third the size in px
    expect(resolveKernel(P, 0.2, 0, 12, p11, 1080, 2)[0]).toBe(0);
    expect(resolveKernel(P, 0.2, 0.05, 0.01, p11, 1080, 2)[0]).toBeLessThan(SSR.RESOLVE_MIN);
    expect(resolveKernel(P, 0.2, 0.05, 12, p11, 1080, 3)[0]).toBeCloseTo((k[0] * 2) / 3, 9);
    expect(resolveKernel(P, 1, 0.8, 60, p11, 1080, 2)).toEqual([SSR.RESOLVE_MAX, SSR.RESOLVE_MAX]);
    expect(resolveKernel(P, 0, 0.05, 12, p11, 1080, 2)[1] / k[0]).toBeCloseTo(SSR.NV_MIN, 9);
  });

  it('the taps cover a disc of 2 sd evenly (a Vogel spiral)', () => {
    for (const n of SSR.RESOLVE_TAPS) {
      let r2 = 0;
      for (let i = 0; i < n; i++) {
        const [r] = resolveTap(i, n);
        expect(r).toBeLessThanOrEqual(2);
        r2 += r * r;
      }
      // area-uniform over radius 2: mean r^2 = 2
      expect(r2 / n).toBeCloseTo(2, 9);
    }
    expect(SSR_RESOLVE_FRAG).toContain('float r = 2.0 * sqrt( ( float( i ) + 0.5 ) / float( BR_SSR_TAPS ) );');
    expect(SSR_RESOLVE_FRAG).toContain('float th = float( i ) * 2.39996323;');
  });

  it('the trace sizes the kernel from the hit, and from where a ray last went behind an occluder when it missed', () => {
    expect(SSR_TRACE_FRAG).toContain('outKer = vec4( brOctEnc( Nm ), brSsrKernel( P, nv, BR_SSR_CONE * a, length( Ph - P ) ) );');
    expect(SSR_TRACE_FRAG).toContain('if ( brSsrBehindT > 0.0 ) outKer = vec4( brOctEnc( Nm ), brSsrKernel( P, nv, BR_SSR_CONE * a, brSsrBehindT ) );');
    expect(SSR_TRACE_GLSL).toContain('brSsrBehindT = t * L;');
    // the kernel is sized before the facing test: a hit on the back of a surface is a miss the resolve fills
    expect(SSR_TRACE_FRAG.indexOf('outKer = vec4( brOctEnc( Nm ), brSsrKernel( P, nv, BR_SSR_CONE * a, length( Ph - P ) ) );'))
      .toBeLessThan(SSR_TRACE_FRAG.indexOf('if ( dot( Nh, R ) > BR_SSR_FACING ) return;'));
  });

  it('mirrors stay sharp, and the taps are weighed on the macro plane, not by their block normals', () => {
    expect(SSR_RESOLVE_FRAG).toContain(`if ( k.z < ${SSR.RESOLVE_MIN} ) return;`);
    expect(SSR_RESOLVE_FRAG).toContain('vec3 Nc = brOctDec( k.xy );');
    expect(SSR_RESOLVE_FRAG).not.toContain('mq.yz');
    expect(SSR_RESOLVE_FRAG).toContain('abs( dot( brResPos( q, mq.x ) - Pc, Nc ) ) * pInv');
    // premultiplied: a miss (confidence 0) among the taps lowers the confidence, not the colour; each tap is clamped to
    // the range of the texel and its kernel's axis points at 1 sd (one lamp-lit ray is not copied as a ring of glints)
    expect(SSR_RESOLVE_FRAG).toContain('acc += w * clamp( texelFetch( tSsr, q, 0 ), lo, hi );');
    expect(SSR_RESOLVE_FRAG).toContain('vec2 ax = ( n < 2 ? dI : dO ) * ( ( n & 1 ) == 0 ? - 1.0 : 1.0 );');
    expect(SSR_RESOLVE_FRAG).toContain('outSsr = acc / ws;');
  });

  it('every traced frame is resolved: 8 taps with ssrFilter (ultra), 6 without (high)', () => {
    for (const [q, taps] of [[QUALITY.ultra, 8], [QUALITY.high, 6]] as const) {
      const ssr = new ScreenSpaceReflections(q);
      const resolve = ssr.materials.find((m) => m.name === 'br-ssr-resolve');
      expect(resolve?.defines.BR_SSR_TAPS).toBe(taps);
      expect(ssr.materials.some((m) => m.name === 'br-ssr-filter')).toBe(false);
      ssr.dispose();
    }
    // a quality switch that changes the steps and the tap set together rebuilds both programs
    const ssr = new ScreenSpaceReflections(QUALITY.high);
    ssr.setQuality(QUALITY.ultra);
    expect(ssr.materials.find((m) => m.name === 'br-ssr-trace')?.defines.BR_SSR_STEPS).toBe(QUALITY.ultra.ssrSteps);
    expect(ssr.materials.find((m) => m.name === 'br-ssr-resolve')?.defines.BR_SSR_TAPS).toBe(SSR.RESOLVE_TAPS[0]);
    ssr.setQuality(QUALITY.high);
    expect(ssr.materials.find((m) => m.name === 'br-ssr-resolve')?.defines.BR_SSR_TAPS).toBe(SSR.RESOLVE_TAPS[1]);
    ssr.dispose();
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
    // the upsample's normal weight is the cosine to the 8th power, by three squarings
    expect(SSR.UP_NPOW).toBe(8);
    expect(MRT_COMPOSITE_FRAG).toContain('nd *= nd; nd *= nd; nd *= nd; // ^UP_NPOW');
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
    // ...the macro normal is the mean depth normal of the texel and its 4 neighbours, used where they agree with each
    // other and with the block's mean (one pixel's depth slope at sub-pixel geometry, far ceiling-grid T-bars, is noise:
    // traced along it they sparkled along every far grid line); the below-surface test uses the same normal
    expect(SSR_TRACE_FRAG).toContain('Ng += brDepthNormal( clamp( p + o, ivec2( 0 ), lim ) );');
    expect(SSR.NCOH[0]).toBeLessThan(SSR.NCOH[1]);
    expect(SSR.NAGREE[0]).toBeLessThan(SSR.NAGREE[1]);
    // a corrugation's partial-period mean (up to ~35 deg off its plane) still takes the macro normal
    expect(Math.acos(SSR.NAGREE[1]) * 180 / Math.PI).toBeGreaterThan(35);
    expect(SSR_TRACE_FRAG).toContain('vec3 Nm = normalize( mix( N, Ng, smoothstep( BR_SSR_NCOH0, BR_SSR_NCOH1, coh ) * smoothstep( BR_SSR_NAGREE0, BR_SSR_NAGREE1, dot( N, Ng ) ) ) );');
    expect(SSR_TRACE_FRAG).toContain('vec3 Nt = normalize( mix( N, Nm, smoothstep( BR_SSR_NVAR0, BR_SSR_NVAR1, 1.0 - nLen ) ) );');
    expect(SSR_TRACE_FRAG).toContain('vec3 R = reflect( - V, Nt );');
    expect(SSR_TRACE_FRAG).toContain('float a = sqrt( pow4( rough ) + ( 1.0 - nLen ) / nLen );');
    // rays below the macro surface are left to the fallback
    const i = SSR_TRACE_FRAG.indexOf('float up = dot( R, Nm );');
    expect(i).toBeGreaterThan(0);
    expect(SSR_TRACE_FRAG.indexOf('if ( up <= 0.0 ) return;')).toBeGreaterThan(i);
    expect(SSR_TRACE_FRAG.indexOf('if ( up <= 0.0 ) return;')).toBeLessThan(SSR_TRACE_FRAG.indexOf('brSsrTrace( P + Nt'));
  });

  it('no Inf reaches the cone lookups: the pyramid is clamped and filtered in fp32, a non-finite lookup is a miss', () => {
    // the mips are weighted means computed in the shader (never gl.generateMipmap's half-precision 2x2 sums)
    expect(PYR_MAX).toBeLessThanOrEqual(HDR_CLAMP);
    expect(HDR_CLAMP).toBeLessThan(65504);
    expect(MIP_DOWN_FRAG).toContain('precision highp float;');
    expect(MIP_DOWN_FRAG).toContain('min( c.rgb, vec3( uMax ) )');
    const i = SSR_TRACE_FRAG.indexOf('vec3 col = textureGrad( tPyr');
    expect(i).toBeGreaterThan(0);
    expect(SSR_TRACE_FRAG.slice(i, i + 800)).toContain('if ( any( isnan( col ) ) || any( isinf( col ) ) ) return;');
  });

  it('presets: high and ultra trace, ultra resolves with the full tap set; low and medium do not trace', () => {
    expect(QUALITY.low.ssr).toBe('off');
    expect(QUALITY.medium.ssr).toBe('off');
    expect(ssrSettingsOf(QUALITY.high)).toEqual({ maxRough: 0.45, steps: 48, filter: false });
    expect(ssrSettingsOf(QUALITY.ultra)).toEqual({ maxRough: 0.6, steps: 56, filter: true });
  });
});
