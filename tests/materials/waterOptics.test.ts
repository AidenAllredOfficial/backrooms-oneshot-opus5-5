// tests/materials/waterOptics.test.ts — package E shader maths with TypeScript twins: the caustic pattern's mean
// (zero-mean modulations), the wave lattice (periodicity, per-kind slope RMS, dispersion), the texture-octave
// periods, the refracted path and the legacy in-water closed forms, and the media table.

import { describe, expect, it } from 'vitest';
import { NOISE_WRAP } from '../../src/core/constants.ts';
import { HELPERS_GLSL } from '../../src/materials/chunks/common.ts';
import { FRAG_LIGHTS_GLSL } from '../../src/materials/chunks/lighting.ts';
import { downwellPhi, f, fresnelWater, phaseHG, phaseWater, WATER_CAUSTICS, WATER_MEDIA, WATER_PHI, waterMediaGlsl } from '../../src/materials/chunks/params.ts';
import { WATER_SURF_GLSL, WATER_SURFACE, waveAmplitudes, waveLattice, waveOmega, waterMirrorWeight, waterWavesGlsl } from '../../src/materials/chunks/water.ts';
import { waterFragmentGlsl } from '../../src/materials/WaterMaterial.ts';

// ---------------------------------------------------------------- caustic twin (chunks/common.ts brCausticsW)

const u32 = (x: number): number => x >>> 0;
function pcg(v: number): number {
  const s = u32(Math.imul(u32(v), 747796405) + 2891336453);
  const w = u32(Math.imul(u32((s >>> ((s >>> 28) + 4)) ^ s), 277803737));
  return u32((w >>> 22) ^ w);
}
const hash2u = (cx: number, cy: number, salt: number): number => pcg(u32(Math.imul(u32(cx), 1597334677)) ^ pcg(u32(cy) ^ u32(Math.imul(salt, 3812015801))));
const u01 = (h: number): number => (h >>> 8) * (1 / 16777216);
const wrap = (c: number, p: number): number => c - p * Math.floor(c / p);
function layer(px: number, py: number, P: number, t: number, salt: number): number {
  const qx = Math.floor(px), qy = Math.floor(py), fx = px - qx, fy = py - qy;
  let f1 = 8, f2 = 8;
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const h = hash2u(wrap(qx + x, P), wrap(qy + y, P), salt);
      const ox = u01(h), oy = u01(pcg(h));
      const ph = u01(pcg(u32(h ^ 0x9e3779b9))) * 6.2831853;
      const dx = x + 0.5 + 0.38 * Math.sin(ph + t * (0.55 + 0.5 * oy) + ox * 6.2831853) - fx;
      const dy = y + 0.5 + 0.38 * Math.sin(ph * 1.37 + t * (0.55 + 0.5 * ox) + oy * 6.2831853) - fy;
      const dd = dx * dx + dy * dy;
      if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
    }
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}
const sstep = (a: number, b: number, x: number): number => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
function causticsW(x: number, z: number, t: number, wd: number, sc: number, w0: number): number {
  let p1x = x / (0.6 * sc), p1y = z / (0.6 * sc);
  const a1x = 0.22 * Math.sin(1.5707963 * p1y + t * 0.7), a1y = 0.22 * Math.sin(1.5707963 * p1x + t * 0.53);
  p1x += a1x; p1y += a1y;
  let p2x = x / (0.3 * sc) + 0.37, p2y = z / (0.3 * sc) + 0.37;
  const a2x = 0.18 * Math.sin(1.5707963 * p2y - t * 0.61), a2y = 0.18 * Math.sin(1.5707963 * p2x + t * 0.83);
  p2x += a2x; p2y += a2y;
  const e1 = layer(p1x, p1y, Math.round(2048 / sc), t * 0.9, 11);
  const e2 = layer(p2x, p2y, Math.round(4096 / sc), t * 1.3, 23);
  const c1 = Math.pow(1 - sstep(0, w0 + wd, e1), 1.6), c2 = Math.pow(1 - sstep(0, w0 + 0.04 + wd, e2), 1.6);
  return c1 * 0.6 + c2 * 0.35 + c1 * c2 * 0.9;
}

/** brCausticMeanW's cubic, read from the GLSL (the test checks the shader's own numbers). */
function meanW(w: number): number {
  const m = /float brCausticMeanW\( float w \) \{ w = clamp\( w, ([0-9.]+), ([0-9.]+) \); return ([0-9.]+) \+ w \* \( ([0-9.]+) \+ w \* \( ([0-9.]+) - ([0-9.]+) \* w \) \); \}/.exec(HELPERS_GLSL);
  expect(m).not.toBeNull();
  const [lo, hi, a, b, c, d] = m!.slice(1).map(Number);
  const x = Math.min(Math.max(w, lo), hi);
  return a + x * (b + x * (c - d * x));
}

describe('caustic pattern', () => {
  let seed = 12345;
  const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  it('brCausticMeanW matches the pattern mean (TS twin) for every width in use (zero-mean modulations)', () => {
    for (const [w0, wd, sc] of [[0.08, 0, 0.5], [0.08, 0.2, 0.5], [0.18, 0, 1], [0.18, 0, 3.3], [0.26, 0.25, 1], [0.26, 0.75, 2]]) {
      let s = 0;
      const N = 30000;
      for (let i = 0; i < N; i++) s += causticsW(rnd() * 400, rnd() * 400, rnd() * 100, wd, sc, w0);
      expect(Math.abs(s / N - meanW(w0 + wd)), `w0 ${w0} wd ${wd} sc ${sc}`).toBeLessThan(0.015);
    }
  });
  it('the above-water net stays continuous where the height above the water varies (stepped magnification)', () => {
    // twin of chunks/water.ts brCausticLevel / brCausticsAbove
    const level = (k: number): number => 2048 / (4 * Math.floor(512 / Math.pow(WATER_CAUSTICS.LEVEL, k) + 0.5));
    const above = (x: number, z: number, t: number, sc: number): number => {
      const L = Math.log2(Math.max(sc, 1)) / Math.log2(WATER_CAUSTICS.LEVEL), k = Math.floor(L), w = sstep(0.3, 0.7, L - k); // walls: band 0.2
      return (w < 1 ? (1 - w) * causticsW(x, z, t, 0, level(k), 0.18) : 0) + (w > 0 ? w * causticsW(x, z, t, 0, level(k + 1), 0.18) : 0);
    };
    for (let k = 0; k < 8; k++) {
      const n = 2048 / level(k);
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
      expect(Math.round(n) % 4).toBe(0); // the lattices and their period-4 warp tile NOISE_WRAP
    }
    // a wall at |pw| ~ 600 m of the world-periodic origin, 1 mm steps of height: the stepped net changes smoothly,
    // the continuously scaled one (the previous formula) jumps by whole cells per millimetre
    let maxStep = 0, maxCont = 0;
    const x = 612.3, z = 287.9;
    for (let h = 0.05; h < 4; h += 0.037) {
      const sc0 = 1 + h * WATER_CAUSTICS.MAGNIFY, sc1 = 1 + (h + 0.001) * WATER_CAUSTICS.MAGNIFY;
      maxStep = Math.max(maxStep, Math.abs(above(x, z, 3, sc1) - above(x, z, 3, sc0)));
      maxCont = Math.max(maxCont, Math.abs(causticsW(x, z, 3, 0, sc1, 0.18) - causticsW(x, z, 3, 0, sc0, 0.18)));
    }
    expect(maxStep).toBeLessThan(0.02);
    expect(maxCont).toBeGreaterThan(0.2);
    expect(FRAG_LIGHTS_GLSL).toContain('brCausticsAbove( brXs + uNoiseOrigin.xz, uTime * 0.7, 1.0 + brH * BR_CAUSTIC_MAGNIFY, brBand )');
    expect(FRAG_LIGHTS_GLSL).toContain('float brBand = abs( brNWg.y ) > 0.9 ? 0.05 : 0.2;');
    expect(WATER_SURF_GLSL).toContain('float brCausticsAbove( vec2 xz, float t, float sc, float band )');
    expect(WATER_SURF_GLSL).toContain('float w = smoothstep( 0.5 - band, 0.5 + band, L - k );');
  });
  it('the pool-floor pattern keeps its own mean (brCaustics = brCausticsW with width 0.26 + depth / 2)', () => {
    expect(HELPERS_GLSL).toContain('return brCausticsW( xz, t, 0.5 * depth, sc, 0.26 )');
    // two fits of the same pattern: they agree (the floors keep their historic brCausticMean)
    for (const depth of [0.2, 1, 2]) expect(Math.abs(meanW(0.26 + 0.5 * depth) - (0.3 + depth * (0.63 - 0.07 * depth)))).toBeLessThan(0.03);
  });
});

// ---------------------------------------------------------------- waves

describe('water waves', () => {
  it('every wave vector is on the integer lattice of NOISE_WRAP (exactly periodic), wavelengths 1.6 -> 0.22 m', () => {
    for (let n = 1; n <= 8; n++) {
      const ws = waveLattice(n);
      expect(ws.length).toBe(n);
      for (const w of ws) {
        expect(Number.isInteger(w.mx) && Number.isInteger(w.mz)).toBe(true);
        expect(Math.abs((w.kx * NOISE_WRAP) / (2 * Math.PI) - w.mx)).toBeLessThan(1e-6);
        expect(Math.abs((w.kz * NOISE_WRAP) / (2 * Math.PI) - w.mz)).toBeLessThan(1e-6);
        expect(w.lambda).toBeGreaterThan(WATER_SURFACE.LAMBDA_MIN * 0.99);
        expect(w.lambda).toBeLessThan(WATER_SURFACE.LAMBDA_MAX * 1.01);
      }
      if (n > 1) {
        expect(ws[0].lambda).toBeCloseTo(WATER_SURFACE.LAMBDA_MAX, 2);
        expect(ws[n - 1].lambda).toBeCloseTo(WATER_SURFACE.LAMBDA_MIN, 2);
      }
    }
  });

  it('the slope RMS per kind matches the target (sum of a^2 / 2), amplitudes grow with the wavelength', () => {
    for (const n of [3, 6, 8]) {
      const ws = waveLattice(n), a = waveAmplitudes(ws);
      WATER_SURFACE.RMS.forEach((rms, k) => {
        expect(Math.sqrt(a[k].reduce((s, x) => s + 0.5 * x * x, 0))).toBeCloseTo(rms, 9);
        for (let i = 1; i < n; i++) expect(a[k][i]).toBeLessThan(a[k][i - 1]);
      });
    }
  });

  it('the GLSL tables are the TS lattice (BR_WATER_WAVES 1..8)', () => {
    const g = waterWavesGlsl();
    const fmt = (v: number): string => { const s = String(Number(v.toPrecision(9))); return /[.eE]/.test(s) ? s : s + '.0'; };
    for (let n = 1; n <= 8; n++) {
      const m = new RegExp(`BR_WATER_WAVES == ${n}\\nconst vec2 BR_WK\\[${n}\\] = vec2\\[${n}\\]\\(([^;]+)\\);`).exec(g);
      expect(m, `n = ${n}`).not.toBeNull();
      expect(m![1]).toBe(waveLattice(n).map((w) => `vec2(${fmt(w.kx)}, ${fmt(w.kz)})`).join(', '));
    }
  });

  it('dispersion: deep water sqrt(g k), shallow sqrt(g k^2 D), capillary ripples faster than gravity alone', () => {
    const k = (2 * Math.PI) / 1.6;
    expect(waveOmega(k, 10)).toBeCloseTo(Math.sqrt(9.81 * k + 7.3e-5 * k ** 3), 6);
    const ks = (2 * Math.PI) / 1.6, D = 0.01;
    expect(waveOmega(ks, D) / Math.sqrt(9.81 * ks * ks * 0.02)).toBeGreaterThan(0.98); // D floored at 2 cm
    const kc = (2 * Math.PI) / 0.02;
    expect(waveOmega(kc, 1) / Math.sqrt(9.81 * kc)).toBeGreaterThan(1.3);
    // phase speed: 1.6 m waves ~1.6 m/s in a deep pool, slower in 25 cm of flood water
    expect(waveOmega(k, 2) / k).toBeGreaterThan(1.5);
    expect(waveOmega(k, 0.25) / k).toBeLessThan(1.45);
  });

  it('texture octaves and the fleck lattice are periodic over NOISE_WRAP (the rotated octave too)', () => {
    for (const p of WATER_SURFACE.TEX_PERIOD) expect(Number.isInteger(Math.round((NOISE_WRAP / p) * 1e6) / 1e6)).toBe(true);
    const p3 = WATER_SURFACE.TEX_PERIOD[2];
    expect(Math.abs((0.6 * NOISE_WRAP) / p3 - Math.round((0.6 * NOISE_WRAP) / p3))).toBeLessThan(1e-9);
    expect(Math.abs((0.8 * NOISE_WRAP) / p3 - Math.round((0.8 * NOISE_WRAP) / p3))).toBeLessThan(1e-9);
    expect(Math.abs(NOISE_WRAP / WATER_SURFACE.FLECK_CELL - Math.round(NOISE_WRAP / WATER_SURFACE.FLECK_CELL))).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------- optics (chunks/haze.ts legacy path, flashlight hook)

/** cos of the refracted angle for a view ray with world y component vy (air -> water, eta 0.75). */
const cosRefracted = (vy: number): number => Math.sqrt(Math.max(1 - (1 - vy * vy) * 0.5625, 0));

describe('in-water optics', () => {
  it('fades mirror lookups at capture edges and behind the reflection eye, widening the fade for rough lobes', () => {
    expect(waterMirrorWeight([0.5, 0.5, 0, 1])).toBe(1);
    expect(waterMirrorWeight([-0.1, 0.5, 0, 1])).toBe(0);
    expect(waterMirrorWeight([0.5, 1.1, 0, 1])).toBe(0);
    expect(waterMirrorWeight([0, 0, 0, 0])).toBe(0);
    expect(waterMirrorWeight([-0.5, -0.5, 0, -1])).toBe(0);
    expect(waterMirrorWeight([0.01, 0.5, 0, 1])).toBeCloseTo(0.5, 9);
    expect(waterMirrorWeight([0.02, 0.5, 0, 1], 0.08)).toBeLessThan(0.2);
    let previous = 0;
    for (let u = -0.02; u <= 0.04; u += 0.0001) {
      const weight = waterMirrorWeight([u, 0.5, 0, 1]);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
    const shader = waterFragmentGlsl();
    expect(shader.indexOf('if ( mirrorWeight > 0.0 )')).toBeLessThan(shader.indexOf('refl = 0.35 *'));
    expect(shader).toContain('3.2 * rT * stretch / min( texSz.x, texSz.y )');
    expect(shader).toContain('refl = mix( brWaterEnv( rW, irr, rough, waterY, brAuxB ), refl, mirrorWeight );');
  });

  it('the refracted path through flat water is D / cos(theta_t), at most ~1.51 D at grazing incidence', () => {
    expect(cosRefracted(-1)).toBeCloseTo(1, 12);
    const D = 0.5;
    for (let vy = -1; vy <= -0.001; vy += 0.05) {
      const ct = cosRefracted(vy), st = Math.sqrt(1 - ct * ct);
      const si = Math.sqrt(1 - vy * vy);
      expect(st).toBeCloseTo(0.75 * si, 9); // Snell
      expect(D / ct).toBeLessThanOrEqual(D * 1.512);
    }
  });

  it('the closed-form in-scatter equals the numeric integral over the refracted path', () => {
    // radiance scattered toward the eye along s in [0, L]: ss A exp(-DOWN kap s cT) (ambient at depth s cT) exp(-kap s)
    for (const [kap, ss, cT, L] of [[1.26, 0.36, 0.85, 0.3], [0.069, 0.004, 0.7, 2.5], [2.96, 0.36, 0.95, 0.6]]) {
      const K = kap * (1 + WATER_MEDIA.DOWN * cT);
      const closed = (ss * (1 - Math.exp(-K * L))) / K;
      let num = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) { const s = ((i + 0.5) / n) * L; num += ss * Math.exp(-WATER_MEDIA.DOWN * kap * s * cT) * Math.exp(-kap * s) * (L / n); }
      expect(Math.abs(closed - num) / num).toBeLessThan(1e-3);
    }
  });

  it('media table: non-negative coefficients, 0 < g < 1, GLSL arrays match', () => {
    const g = waterMediaGlsl();
    for (let k = 0; k < 3; k++) {
      for (const a of WATER_MEDIA.SA[k]) expect(a).toBeGreaterThanOrEqual(0);
      expect(WATER_MEDIA.SS[k]).toBeGreaterThanOrEqual(0);
      expect(WATER_MEDIA.G[k]).toBeGreaterThan(0);
      expect(WATER_MEDIA.G[k]).toBeLessThan(1);
    }
    // pool water absorbs red most, blue least; flood water the other way round (tea-coloured)
    expect(WATER_MEDIA.SA[0][0]).toBeGreaterThan(WATER_MEDIA.SA[0][2]);
    expect(WATER_MEDIA.SA[1][2]).toBeGreaterThan(WATER_MEDIA.SA[1][0]);
    expect(g).toContain('const vec3 BR_WM_SA[3] = vec3[3](vec3(0.35, 0.065, 0.03)');
    expect(g).toContain(`const float BR_WM_SS[3] = float[3](${WATER_MEDIA.SS.map(f).join(', ')});`);
    expect(g).toMatch(/#define BR_WM_DOWN /);
    for (let k = 0; k < 3; k++) {
      expect(WATER_MEDIA.BACK[k]).toBeGreaterThanOrEqual(0);
      expect(WATER_MEDIA.BACK[k]).toBeLessThan(0.5);
    }
  });

  it('exact dielectric Fresnel: F(1) = 0.0204, rising monotonically to 1 at grazing; the GLSL twin uses the same IOR', () => {
    expect(fresnelWater(1)).toBeCloseTo(0.0204, 4);
    expect(fresnelWater(0)).toBeCloseTo(1, 9);
    let last = fresnelWater(1);
    for (let c = 0.99; c >= 0; c -= 0.01) {
      const F = fresnelWater(c);
      expect(F).toBeGreaterThanOrEqual(last - 1e-12);
      last = F;
    }
    // Schlick with F0 0.02 (the old approximation) is within 0.06 everywhere (worst near 80 deg: exact is higher)
    for (let c = 0; c <= 1; c += 0.05) expect(Math.abs(fresnelWater(c) - (0.02 + 0.98 * Math.pow(1 - c, 5)))).toBeLessThan(0.06);
    const g = waterMediaGlsl();
    expect(g).toContain('float brFresnelW( float ci )');
    expect(g).toContain(`( c - ${WATER_MEDIA.IOR} * ct )`);
  });

  it('the dual-lobe phase integrates to 1 over the sphere; flood silt backscatters little (dark water, not milk)', () => {
    for (let k = 0; k < 3; k++) {
      let all = 0, back = 0;
      const n = 40000;
      for (let i = 0; i < n; i++) {
        const mu = -1 + ((i + 0.5) / n) * 2;
        const p = phaseWater(mu, k) * 2 * Math.PI * (2 / n);
        all += p;
        if (mu < 0) back += p;
      }
      expect(all).toBeCloseTo(1, 3);
      expect(back).toBeLessThan(0.1);
    }
    expect(phaseHG(1, 0.9)).toBeGreaterThan(phaseHG(-1, 0.9) * 100);
    expect(waterMediaGlsl()).toContain('float brPhaseW( float mu, int kind )');
  });

  it('PHI (downwelling backscatter share) matches an independent sphere integral and barely varies with the view', () => {
    // independent: sum the phase over a fine latitude-longitude grid of the whole sphere of propagation directions,
    // keeping those inside Snell's window (going down within asin(1 / n) of the nadir), with n^2 (1 - F) radiance
    const n = WATER_MEDIA.IOR;
    const brute = (kind: number, cosV: number): number => {
      const sv = Math.sqrt(1 - cosV * cosV);
      const N = 600, M = 300;
      let acc = 0;
      for (let i = 0; i < N; i++) {
        const th = ((i + 0.5) / N) * Math.PI; // polar angle from the nadir
        if (th > Math.asin(1 / n)) break;
        const st = Math.sin(th), ct = Math.cos(th);
        const tr = 1 - fresnelWater(Math.sqrt(Math.max(1 - n * n * st * st, 0)));
        for (let j = 0; j < M; j++) {
          const ph = ((j + 0.5) / M) * 2 * Math.PI;
          acc += phaseWater(st * Math.cos(ph) * sv - ct * cosV, kind) * tr * st * (Math.PI / N) * ((2 * Math.PI) / M);
        }
      }
      return n * n * acc;
    };
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(WATER_PHI[k] - brute(k, Math.cos((25 * Math.PI) / 180))) / WATER_PHI[k]).toBeLessThan(0.02);
      const lo = downwellPhi(k, 0.66), hi = downwellPhi(k, 1);
      expect(Math.abs(hi - lo) / WATER_PHI[k]).toBeLessThan(0.25);
      // the old in-scatter used an effective share of ~1 (x the tint): milky flood water
      expect(WATER_PHI[k]).toBeLessThan(0.1);
    }
    expect(waterMediaGlsl()).toMatch(/const float BR_WM_PHI\[3\] = float\[3\]\(/);
  });

  it('refracting water: unscattered + forward-scattered = the transport transmittance; closed-form in-scatter', () => {
    for (let k = 0; k < 3; k++) {
      const ss = WATER_MEDIA.SS[k], g = WATER_MEDIA.G[k];
      for (let c = 0; c < 3; c++) {
        const sa = WATER_MEDIA.SA[k][c], st = sa + ss, kap = sa + (1 - g) * ss;
        for (const L of [0.02, 0.3, 2.5]) {
          const Tu = Math.exp(-st * L), Tf = Math.max(Math.exp(-kap * L) - Tu, 0);
          expect(Tu + Tf).toBeCloseTo(Math.exp(-kap * L), 12);
          // brWVolume: source ss PHI E / pi at depth s cosT (downwelling 1.25 kappa per metre), back up with st
          const cosT = 0.8, K = st + 1.25 * kap * cosT;
          const closed = (ss * WATER_PHI[k] * (1 - Math.exp(-K * L))) / K;
          let num = 0;
          const n = 20000;
          for (let i = 0; i < n; i++) { const s = ((i + 0.5) / n) * L; num += ss * WATER_PHI[k] * Math.exp(-1.25 * kap * s * cosT) * Math.exp(-st * s) * (L / n); }
          expect(Math.abs(closed - num) / num).toBeLessThan(1e-3);
        }
      }
    }
  });
});
