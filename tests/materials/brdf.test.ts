// tests/materials/brdf.test.ts — texture realism v2 (0b) shading maths: the EON rough diffuse (chunks/brdf.ts TS twin,
// white furnace, the published single-scattering ratios, the RE_Direct override text), the linear cavity visibility of
// the baked light (chunks/pom.ts dirVis) against a ray-marched height-field reference, and the grime helpers
// (chunks/grimeLib.ts).

import { describe, expect, it } from 'vitest';
import { ShaderChunk, ShaderLib } from 'three';
import {
  brdfParsGlsl, brDirectSource, EON_C1, EON_C2, EON_G, eonAlbedo, eonBrdf, eonDelta, eonSingleRatio, fonAlbedo, fonAlbedoExact,
  physicalDirectSource,
} from '../../src/materials/chunks/brdf.ts';
import { DIRVIS, dirVis, dirVisG, FRAG_DIRVIS_GLSL } from '../../src/materials/chunks/pom.ts';
import { f } from '../../src/materials/chunks/params.ts';
import { GRIME_LIB_GLSL, heightBlend, STAIN_FRONT, stainFront } from '../../src/materials/chunks/grimeLib.ts';
import { buildSurfaceFragment } from '../../src/materials/SurfaceMaterial.ts';

describe('EON rough diffuse (chunks/brdf.ts)', () => {
  it('white furnace: the directional albedo is rho within 3 % for sigma 0.2 / 0.5 / 0.9 and mu in [0.1, 1]', () => {
    for (const s of [0.2, 0.5, 0.9]) {
      for (const mu of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
        for (const rho of [1, 0.3]) {
          const a = eonAlbedo(rho, s, mu, 96, 48);
          if (!(Math.abs(a / rho - 1) <= 0.03)) expect(a / rho, `sigma ${s} mu ${mu} rho ${rho}`).toBeCloseTo(1, 1);
        }
      }
    }
  });

  it('sigma 0: exact Lambert (rho / pi) at every angle', () => {
    for (const [mi, mo, c] of [[1, 1, 1], [0.5, 0.8, 0.2], [0.2, 0.9, -0.3], [0.7, 0.3, 0.9]]) {
      expect(eonBrdf(0.4, 0, mi, mo, c)).toBeCloseTo(0.4 / Math.PI, 5);
    }
  });

  it('single scattering at sigma 0.45: 0.885 at L = V = N, 1.48 at L = V 60 degrees off the normal', () => {
    expect(eonSingleRatio(0.45, 1, 1, 1)).toBeCloseTo(0.885, 3);
    expect(eonSingleRatio(0.45, 0.5, 0.5, 1)).toBeCloseTo(1.483, 3);
    // retroreflection grows toward grazing (the torch's oblique ring lifts); forward scattering stays below Lambert
    expect(eonBrdf(1, 0.45, 0.3, 0.3, 1)).toBeGreaterThan(eonBrdf(1, 0.45, 0.6, 0.6, 1));
    const fwd = 2 * 0.3 * 0.3 - 1; // L and V mirrored about the normal at mu 0.3: cos = 2 mu^2 - 1
    expect(eonBrdf(1, 0.45, 0.3, 0.3, fwd)).toBeLessThan(1 / Math.PI);
  });

  it('the shader form (brEonD, twin eonDelta) is the BRDF over Lambert minus 1', () => {
    for (const s of [0.2, 0.45, 0.9]) {
      for (const [mi, mo, c] of [[1, 1, 1], [0.5, 0.5, 1], [0.3, 0.8, 0.1], [0.9, 0.2, -0.4], [0.05, 0.7, 0.5]]) {
        expect(eonDelta(s, mi, mo, c)).toBeCloseTo(eonBrdf(1, s, mi, mo, c) * Math.PI - 1, 9);
      }
    }
    expect(eonDelta(0, 0.3, 0.7, 0.2)).toBeCloseTo(0, 6); // (the branch never runs at sigma 0)
  });

  it('the FON albedo fit is within 0.1 % of the closed form', () => {
    for (const s of [0.1, 0.45, 0.9]) {
      for (let mu = 0.02; mu <= 1; mu += 0.02) {
        const e = Math.abs(fonAlbedo(mu, s) - fonAlbedoExact(mu, s));
        if (!(e < 1e-3)) expect(e, `sigma ${s} mu ${mu}`).toBeLessThan(1e-3);
      }
    }
  });

  it('the GLSL uses the TS constants', () => {
    const g = brdfParsGlsl();
    expect(g).toContain(`#define BR_EON_C1 ${f(EON_C1)}`);
    expect(g).toContain(`#define BR_EON_C2 ${f(EON_C2)}`);
    for (const c of EON_G) expect(g).toContain(f(c));
    expect(g).toContain('float brDiffSigma = 0.0;');
  });

  it('brRE_Direct is three\'s RE_Direct_Physical plus one EON line after the verbatim Lambert line', () => {
    const three = physicalDirectSource();
    const ours = brDirectSource();
    const extra = ours.split('\n').filter((l) => l.includes('brDiffSigma'));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/^\tif \( brDiffSigma > 0\.0 \) reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseContribution \) \* \( brEonD\(/);
    expect(ours.split('\n').filter((l) => !l.includes('brDiffSigma')).join('\n'))
      .toBe(three.replace('void RE_Direct_Physical(', 'void brRE_Direct('));
    // a changed Lambert line (three upgrade) fails loudly instead of silently dropping EON
    expect(() => brDirectSource(ShaderChunk.lights_physical_pars_fragment.replace('BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F )', 'X'))).toThrow();
  });

  it('the surface program defines the override after three\'s physical lighting and before main; every RE_Direct call uses it', () => {
    const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
    const at = (s: string): number => { const i = frag.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(at('#include <lights_physical_pars_fragment>')).toBeLessThan(at('void brRE_Direct('));
    expect(at('#define RE_Direct brRE_Direct')).toBeLessThan(at('void main()'));
    // the EON roughness is set in material post (before lights_fragment_begin: the flashlight), from the layer's sigma
    expect(at('brDiffSigma = min( 1.0, sqrt( brSg * brSg + 0.5 * brSv ) );')).toBeLessThan(at('#include <lights_fragment_begin>'));
    expect(at('#include <lights_fragment_begin>')).toBeLessThan(at('RE_Direct( brDL,'));
  });
});

// ---------------------------------------------------------------- linear cavity visibility (pom.ts dirVis)

/** A ray-marched reference on small periodic height fields (texel units; heights in texels): the cosine-weighted
 * visibility of a uniform light cap (half-angle beta around L at thetaL from the normal), and the cavity V as the
 * generator computes it (textures/glsl/common.ts br_cavity: 8 azimuths, horizon over radii 1-16). */
const N = 64;
const RADII = [1, 2, 3, 5, 8, 12, 16];
const mod = (a: number, n: number): number => ((a % n) + n) % n;
function cavity(h: Float64Array, x: number, y: number): number {
  let occ = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    let t = 0;
    for (const r of RADII) {
      const ox = Math.floor(Math.cos(a) * r + 0.5), oy = Math.floor(Math.sin(a) * r + 0.5);
      t = Math.max(t, (h[mod(y + oy, N) * N + mod(x + ox, N)] - h[y * N + x]) / Math.hypot(ox, oy));
    }
    occ += (t * t) / (1 + t * t);
  }
  return 1 - occ / 8;
}
function bilin(h: Float64Array, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = mod(x0, N), b = mod(y0, N), c = mod(x0 + 1, N), d = mod(y0 + 1, N);
  return h[b * N + a] * (1 - fx) * (1 - fy) + h[b * N + c] * fx * (1 - fy) + h[d * N + a] * (1 - fx) * fy + h[d * N + c] * fx * fy;
}
function capVis(h: Float64Array, x: number, y: number, thL: number, beta: number, phi: number, m = 96): number {
  const L = [Math.sin(thL) * Math.cos(phi), Math.sin(thL) * Math.sin(phi), Math.cos(thL)];
  const up = Math.abs(L[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
  let T = [up[1] * L[2] - up[2] * L[1], up[2] * L[0] - up[0] * L[2], up[0] * L[1] - up[1] * L[0]];
  const tl = Math.hypot(T[0], T[1], T[2]);
  T = T.map((v) => v / tl);
  const B = [L[1] * T[2] - L[2] * T[1], L[2] * T[0] - L[0] * T[2], L[0] * T[1] - L[1] * T[0]];
  const h0 = h[y * N + x] + 1e-3;
  let sw = 0, sv = 0;
  for (let i = 0; i < m; i++) {
    const ct = 1 - ((i + 0.5) / m) * (1 - Math.cos(beta)), st = Math.sqrt(1 - ct * ct), ph = 2 * Math.PI * ((i * 0.6180339887) % 1);
    const d = [0, 1, 2].map((k) => st * Math.cos(ph) * T[k] + st * Math.sin(ph) * B[k] + ct * L[k]);
    if (d[2] <= 0) continue;
    sw += d[2];
    const hor = Math.max(Math.hypot(d[0], d[1]), 1e-9);
    let vis = true;
    for (let s = 0.5; s < 20 && vis; s += 0.5) if (bilin(h, x + (d[0] / hor) * s, y + (d[1] / hor) * s) > h0 + (d[2] / hor) * s) vis = false;
    if (vis) sv += d[2];
  }
  return sw > 0 ? sv / sw : 1;
}
function feature(kind: 'groove' | 'tooled' | 'pit', size: number, depth: number): { h: Float64Array; pts: [number, number][] } {
  const h = new Float64Array(N * N), c = N / 2;
  const pts: [number, number][] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = kind === 'pit' ? Math.hypot(x + 0.5 - c, y + 0.5 - c) / size : Math.abs(x + 0.5 - c) / (size / 2);
      if (d < 1) h[y * N + x] = -depth * (kind === 'groove' ? 1 : 1 - d * d);
    }
  }
  const r = Math.ceil(size) + 2;
  for (let x = c - r; x <= c + (kind === 'pit' ? 0 : r); x++) pts.push([x, c]);
  return { h, pts };
}

describe('linear cavity visibility of the baked light (chunks/pom.ts dirVis)', () => {
  it('fits a ray-marched reference better than the cone-scaled form, without bias', () => {
    const feats = [
      feature('groove', 2, 1.2), feature('groove', 4, 2.4), feature('groove', 4, 8), feature('groove', 8, 4.8),
      feature('tooled', 3, 1.8), feature('tooled', 6, 6), feature('pit', 3, 3), feature('pit', 6, 3), feature('pit', 4, 8),
    ];
    // the cone-scaled form of the plan: g = clamp(4 (1 - R_d), 0.25, 1) mix(1, 1.6, 1 - c)
    const planG = (cb: number, c: number): number => Math.min(Math.max(2 * (1 - cb), 0.25), 1) * (1 + 0.6 * (1 - c));
    let e2 = 0, e2p = 0, bias = 0, n = 0;
    for (const { h, pts } of feats) {
      const V = pts.map(([x, y]) => cavity(h, x, y));
      for (const thD of [0, 35, 70]) {
        for (const betaD of [30, 55, 80]) {
          const th = (thD * Math.PI) / 180, beta = (betaD * Math.PI) / 180;
          const cb = Math.cos(beta), c = Math.cos(th);
          const w = DIRVIS.RD_W * (1 + cb) / 2; // the directionality whose R_d estimate is this cap
          pts.forEach(([x, y], i) => {
            const ref = [0, Math.PI / 4, Math.PI / 2].reduce((s, p) => s + capVis(h, x, y, th, beta, p) / 3, 0);
            const v = dirVis(V[i], w, c);
            const vp = Math.max(0, 1 - (1 - V[i]) * planG(cb, c));
            e2 += (v - ref) ** 2; e2p += (vp - ref) ** 2; bias += v - ref; n++;
          });
        }
      }
    }
    const rmse = Math.sqrt(e2 / n), rmsePlan = Math.sqrt(e2p / n);
    expect(rmse).toBeLessThan(0.09);
    expect(Math.abs(bias / n)).toBeLessThan(0.02);
    expect(rmse).toBeLessThan(0.8 * rmsePlan);
  });

  it('is linear in V (the mip-filtered cavity gives the filtered visibility) and exact at the limits', () => {
    for (const [w, c] of [[0.3, 1], [0.6, 0.9], [0.8, 0.5], [0.5, 0.2]]) {
      const vs = [0.55, 0.7, 0.85, 1];
      const mean = vs.reduce((s, v) => s + dirVis(v, w, c), 0) / vs.length;
      expect(dirVis(vs.reduce((s, v) => s + v, 0) / vs.length, w, c)).toBeCloseTo(mean, 12);
      expect(dirVis(1, w, c)).toBe(1); // a flat texel sees all of the light
    }
    // a collimated light along the normal reaches the bottom of any open cavity; a hemisphere sees the cavity's V
    expect(dirVisG(DIRVIS.RD_W, 1)).toBeCloseTo(0, 12);
    expect(dirVisG(DIRVIS.RD_W / 2, 1)).toBeCloseTo(DIRVIS.K, 12);
    // grazing light loses more than overhead light of the same spread
    expect(dirVisG(0.6, 0.3)).toBeGreaterThan(dirVisG(0.6, 0.95));
  });

  it('the GLSL uses the DIRVIS constants and skips pile layers', () => {
    expect(DIRVIS.LINEAR).toBe(true);
    for (const v of [DIRVIS.RD_W, DIRVIS.CB_LOW, DIRVIS.K]) expect(FRAG_DIRVIS_GLSL).toContain(f(v));
    expect(FRAG_DIRVIS_GLSL).toContain('if ( BR_L_PILE[ brL ].x <= 0.0 ) {');
    expect(FRAG_DIRVIS_GLSL).not.toContain('smoothstep'); // the legacy cone is off
  });
});

describe('grime helpers (chunks/grimeLib.ts)', () => {
  it('brHeightBlend fills the low relief first and is 0 / 1 at the mask extremes', () => {
    expect(heightBlend(0.2, -1)).toBeGreaterThan(heightBlend(0.2, 0));
    expect(heightBlend(0.2, 0)).toBeGreaterThan(heightBlend(0.2, 1));
    expect(heightBlend(0.2, 0)).toBeGreaterThan(0);
    for (const r of [-1, 0, 1]) { expect(heightBlend(0, r)).toBe(0); expect(heightBlend(1, r)).toBe(1); }
  });

  it('brStainFront: nested tide lines, sharp outside and softer inside; inside covers the wet side', () => {
    const w = 0.01, l0 = 0.44;
    const at = (s: number) => stainFront(s, l0, w, 0.5, 0.5);
    expect(at(l0).tide).toBeCloseTo(1, 6);
    // asymmetric deposit: 2 w outside it has faded far more than 2 w inside
    expect(at(l0 - 2 * w).tide).toBeLessThan(0.05);
    expect(at(l0 + 2 * w).tide).toBeGreaterThan(0.5);
    // a second front lies inside the first, weaker
    const l1 = l0 + STAIN_FRONT.A1 + STAIN_FRONT.B1 * 0.5;
    expect(at(l1).tide).toBeCloseTo(1 - STAIN_FRONT.NEST_FADE, 2);
    expect(at(l0 - 5 * w).inside).toBe(0);
    expect(at(l0 + 5 * w).inside).toBe(1);
    expect(GRIME_LIB_GLSL).toContain('void brStainFront( float s, float fine, float L0, out float inside, out float tide )');
    expect(GRIME_LIB_GLSL).toContain('float brHeightBlend( float m, float rel, float K, float E )');
  });

  it('the helpers are in the surface program before the family hooks', () => {
    const frag = buildSurfaceFragment(ShaderLib.physical.fragmentShader);
    expect(frag.indexOf('void brStainFront(')).toBeGreaterThan(0);
    expect(frag.indexOf('void brStainFront(')).toBeLessThan(frag.indexOf('// ---- family hooks: pars'));
  });
});
