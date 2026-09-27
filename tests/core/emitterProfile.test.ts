// tests/core/emitterProfile.test.ts — graphics-realism C.2/C.3: every emitter profile is normalised to a mean of 1
// seen from the nadir (the baked flux stays calibrated), the EP_NORM literal matches its recipe, the prismatic
// angular profile integrates to about a Lambertian's, and the aux packing round-trips.

import { describe, expect, it } from 'vitest';
import {
  AGED_P, computeEpNorm, defaultShapeInput, emitterShape, EP, EP_NORM, epNormIndex, LENS_TILE, lensAux, lensParam,
  lensVariant, LOUVER, LOUVER_P, nadirMean, offLouverAlbedo, PRISM, prismAngular, profileBits, recessedProfile,
  unpackLensParam, unpackProfile, type ShapeInput,
} from '../../src/core/emitterProfile.ts';
import { FixtureKind, LightState, Zone } from '../../src/core/ids.ts';

const luma = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('emitter profiles: nadir normalisation', () => {
  it('the EP_NORM literal matches computeEpNorm() (96 x 48 midpoint integration)', () => {
    const t = computeEpNorm();
    expect(t.length).toBe(EP_NORM.length);
    for (let i = 0; i < t.length; i++) expect(Math.abs(t[i] - EP_NORM[i]), `EP_NORM[${i}]`).toBeLessThan(2e-4);
  });

  it('recessed lenses: nadir mean 1 +-2 % for every (profile, lamps, U, V)', () => {
    for (const ep of [EP.PRISM, EP.LOUVER, EP.OPAL]) {
      for (let n = 2; n <= 4; n++) {
        for (let U = 1; U <= 4; U++) {
          for (let V = 1; V <= 4; V++) {
            const m = nadirMean(ep, n, U, V);
            expect(Math.abs(m - 1), `ep ${ep} n ${n} ${U}x${V}: ${m.toFixed(4)}`).toBeLessThan(0.02);
          }
        }
      }
    }
  });

  it('a lens is normalised per seed too (gains renormalised to mean 1, blackening small)', () => {
    const inp = defaultShapeInput();
    const out = [0, 0, 0];
    for (const seed8 of [0, 17, 61, 128, 201, 255]) {
      let s = 0;
      const NU = 96, NV = 48;
      for (let j = 0; j < NV; j++) {
        for (let i = 0; i < NU; i++) {
          inp.seed8 = seed8; inp.u = ((i + 0.5) / NU) * 2; inp.v = (j + 0.5) / NV; inp.fp = 0.02;
          s += luma(emitterShape(inp, out));
        }
      }
      expect(Math.abs(s / (NU * NV) - 1), `seed ${seed8}`).toBeLessThan(0.05);
    }
  });

  /** Mean of `f(inp)` over a (0..1)^2 uv grid (props) or a disk (uv in [-1, 1]^2, |uv| <= 1). */
  function meanOver(ep: number, variant: number, param: number, disk: boolean, setV: (inp: ShapeInput, u: number, v: number) => void): number {
    const inp = defaultShapeInput();
    inp.ep = ep; inp.variant = variant; inp.param = param; inp.fp = 0.01;
    const out = [0, 0, 0];
    let s = 0, c = 0;
    const N = 200;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N, v = (j + 0.5) / N;
        if (disk && (2 * u - 1) ** 2 + (2 * v - 1) ** 2 > 1) continue;
        setV(inp, u, v);
        s += luma(emitterShape(inp, out)); c++;
      }
    }
    return s / c;
  }

  it('prop emitters: nadir mean 1 +-2 % over their projected shape', () => {
    // TUBE: the projected width coordinate s in [-1, 1] sees the cylinder normal at mu = sqrt(1 - s^2)
    for (const Lcm of [60, 120, 150]) {
      for (const variant of [0, 1]) {
        const m = meanOver(EP.TUBE, variant, Lcm, false, (inp, u, v) => { const s = 2 * u - 1; inp.vz = Math.sqrt(1 - s * s); inp.v = v - 0.5; });
        expect(Math.abs(m - 1), `TUBE ${Lcm} cm v${variant}: ${m.toFixed(4)}`).toBeLessThan(0.02);
      }
    }
    // BULB (frosted / clear): the projected disk at radius rho sees n.V = sqrt(1 - rho^2)
    for (const variant of [0, 1]) {
      const m = meanOver(EP.BULB, variant, 0, true, (inp, u, v) => { const r2 = (2 * u - 1) ** 2 + (2 * v - 1) ** 2; inp.vz = Math.sqrt(Math.max(0, 1 - r2)); });
      expect(Math.abs(m - 1), `BULB v${variant}: ${m.toFixed(4)}`).toBeLessThan(0.02);
    }
    // HIGHBAY: uv = xz / r on the disk, seen from the nadir
    const hb = meanOver(EP.HIGHBAY, 0, 0, true, (inp, u, v) => { inp.u = 2 * u - 1; inp.v = 2 * v - 1; inp.vx = 0; inp.vy = 0; inp.vz = 1; });
    expect(Math.abs(hb - 1), `HIGHBAY ${hb.toFixed(4)}`).toBeLessThan(0.02);
    // DROP / SODIUM: uv in [0, 1]^2, nadir
    for (const [ep, len] of [[EP.DROP, 120], [EP.DROP, 60], [EP.SODIUM, 45]]) {
      const m = meanOver(ep, 0, len, false, (inp, u, v) => { inp.u = u; inp.v = v; inp.vz = 1; });
      expect(Math.abs(m - 1), `ep ${ep} ${len} cm: ${m.toFixed(4)}`).toBeLessThan(0.02);
    }
  });
});

describe('emitter profiles: angular behaviour', () => {
  it('prismatic angular profile: 1 at the nadir, ~.5 at 85 deg; cosine-weighted hemispherical integral in [.9, 1.05]', () => {
    expect(prismAngular(1)).toBeCloseTo(1, 6);
    expect(prismAngular(Math.cos((85 * Math.PI) / 180))).toBeGreaterThan(0.45);
    expect(prismAngular(Math.cos((85 * Math.PI) / 180))).toBeLessThan(0.6);
    // integral of P(theta) cos(theta) d omega / pi = 2 * int_0^1 P(mu) mu dmu
    let s = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) { const mu = (i + 0.5) / N; s += prismAngular(mu) * mu / N; }
    expect(2 * s).toBeGreaterThan(0.9);
    expect(2 * s).toBeLessThan(1.05);
  });

  it('the whole prism lens (parallax included): hemispherical cosine integral in [.9, 1.05]', () => {
    const inp = defaultShapeInput();
    inp.fp = 0.05; // far field
    const out = [0, 0, 0];
    let acc = 0;
    const NT = 24, NP = 8, NU = 24, NV = 12;
    for (let it = 0; it < NT; it++) {
      const mu = (it + 0.5) / NT; // cos(theta)
      const st = Math.sqrt(1 - mu * mu);
      let lensMean = 0;
      for (let ip = 0; ip < NP; ip++) {
        const ph = ((ip + 0.5) / NP) * 2 * Math.PI;
        inp.vx = st * Math.cos(ph); inp.vy = st * Math.sin(ph); inp.vz = mu;
        for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
          inp.u = ((i + 0.5) / NU) * 2; inp.v = (j + 0.5) / NV; inp.seed8 = (i + 7 * j) & 255;
          lensMean += luma(emitterShape(inp, out));
        }
      }
      acc += (lensMean / (NP * NU * NV)) * mu / NT;
    }
    expect(2 * acc).toBeGreaterThan(0.9);
    expect(2 * acc).toBeLessThan(1.05);
  });

  it('prism facet sparkle: resolved up close, gone before a 4 mm cell shrinks to 4 px (no moire)', () => {
    // facet modulation inside one pyramid cell at a lamp-band edge (lamps along u: the lamp images are constant
    // along u there, so any change along u within the cell is the facet pattern), footprint 1 / pxPerCell cells
    const spread = (pxPerCell: number): number => {
      const inp = defaultShapeInput();
      inp.fp = PRISM.PITCH / pxPerCell / LENS_TILE;
      inp.vx = 0.3; inp.vy = 0.2; inp.vz = Math.sqrt(1 - 0.13);
      const out = [0, 0, 0];
      let worst = 0;
      for (let j = 0; j < 8; j++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 8; i++) {
          inp.u = 1 + (PRISM.PITCH * (i + 0.5)) / 8 / LENS_TILE; inp.v = 0.5 + (0.025 + (PRISM.PITCH * (j + 0.5)) / 8) / LENS_TILE;
          const l = luma(emitterShape(inp, out));
          lo = Math.min(lo, l); hi = Math.max(hi, l);
        }
        worst = Math.max(worst, hi - lo);
      }
      return worst;
    };
    expect(spread(20)).toBeGreaterThan(0.05);
    expect(spread(4)).toBeLessThan(1e-3);
    expect(PRISM.FAR1 * 4).toBeLessThanOrEqual(1);
  });

  it('louver: bright cells from below, dark past the cutoff', () => {
    const inp = defaultShapeInput();
    inp.ep = EP.LOUVER; inp.variant = lensVariant(3, false); inp.param = lensParam(1, 1, 0); inp.fp = 0.01;
    const out = [0, 0, 0];
    const mean = (thetaDeg: number): number => {
      const mu = Math.cos((thetaDeg * Math.PI) / 180), st = Math.sin((thetaDeg * Math.PI) / 180);
      inp.vx = st; inp.vy = 0; inp.vz = mu;
      let s = 0;
      for (let j = 0; j < 30; j++) for (let i = 0; i < 30; i++) { inp.u = (i + 0.5) / 30; inp.v = (j + 0.5) / 30; s += luma(emitterShape(inp, out)); }
      return s / 900;
    };
    expect(mean(0)).toBeGreaterThan(0.8);
    expect(mean(75)).toBeLessThan(0.15 * mean(0));
  });

  it('louver past the cutoff: neutral room-mirroring blades under a top-weighted lamp sheen, cell means far away', () => {
    const inp = defaultShapeInput();
    inp.ep = EP.LOUVER; inp.variant = lensVariant(3, false); inp.param = lensParam(1, 2, 1); inp.fp = 0.002;
    const out = [0, 0, 0, 0];
    const view = (thetaDeg: number): void => {
      inp.vx = 0; inp.vy = Math.sin((thetaDeg * Math.PI) / 180); inp.vz = Math.cos((thetaDeg * Math.PI) / 180);
    };
    // one cell row along the lamps (v), away from the cell sides: [emission luma, room albedo] per sample
    const row = (): number[][] => {
      const r: number[][] = [];
      for (let i = 0; i < 40; i++) {
        inp.u = 0.3 / LENS_TILE; inp.v = (2 * 0.2 + (i + 0.5) / 40 * 0.2) / LENS_TILE; // middle cell column, row 2
        emitterShape(inp, out);
        r.push([luma(out), out[3]]);
      }
      return r;
    };
    // from below: the cells show the lamps (over the fixture interior's dark albedo), the blades are not seen (only
    // the bottom edges reflect the room)
    view(0);
    const below = row();
    expect(Math.max(...below.map((x) => x[1]))).toBeLessThanOrEqual(LOUVER.EDGE_ALB + 1e-9);
    expect(Math.min(...below.map((x) => x[1]))).toBeGreaterThan(0.5 * LOUVER.CAV_OFF);
    expect(below.filter((x) => x[1] > LOUVER.CAV_OFF + 0.01).length).toBeLessThan(6);
    // past the cutoff: the blades mirror the room (neutral albedo ALU) under a sheen that grows toward the blade top
    view(75);
    const past = row();
    const bladeRoom = past.filter((x) => x[1] > 0.5 * LOUVER.ALU);
    expect(bladeRoom.length).toBeGreaterThan(30);
    const lum = past.map((x) => x[0]);
    expect(Math.max(...lum)).toBeGreaterThan(2 * Math.min(...lum)); // the per-row gradient
    // far away the row pattern fades into its cell mean (no moire), keeping about the same mean
    inp.fp = 0.5 * 0.2 / LENS_TILE;
    const far = row().map((x) => x[0]);
    const mean = (a: number[]): number => a.reduce((p, q) => p + q, 0) / a.length;
    expect((Math.max(...far) - Math.min(...far)) / mean(far)).toBeLessThan(0.1);
    expect(mean(far) / mean(lum)).toBeGreaterThan(0.6);
    expect(mean(far) / mean(lum)).toBeLessThan(1.4);
    // other profiles keep the material diffuse
    inp.ep = EP.PRISM; inp.fp = 0.002;
    expect(emitterShape(inp, out)[3]).toBe(-1);
  });

  it('dead louver: its blade grid (bright bottom edges over dark cells from below, aluminium blades obliquely)', () => {
    const inp = defaultShapeInput();
    inp.ep = EP.LOUVER; inp.variant = lensVariant(3, false); inp.param = lensParam(1, 2, 1); inp.fp = 0.001;
    inp.vx = 0; inp.vy = 0; inp.vz = 1;
    inp.u = 0.3 / LENS_TILE; inp.v = 0.1 / LENS_TILE; // a cell centre
    const cell = offLouverAlbedo(inp);
    inp.v = 0.2 / LENS_TILE; // on a blade's bottom edge
    const edge = offLouverAlbedo(inp);
    expect(cell).toBeLessThanOrEqual(LOUVER.CAV_OFF + 1e-9);
    expect(edge).toBeGreaterThan(2 * cell);
    inp.v = 0.1 / LENS_TILE; inp.vy = Math.sin((75 * Math.PI) / 180); inp.vz = Math.cos((75 * Math.PI) / 180);
    let s = 0;
    for (let i = 0; i < 40; i++) { inp.v = (2 * 0.2 + (i + 0.5) / 40 * 0.2) / LENS_TILE; s += offLouverAlbedo(inp); }
    expect(s / 40).toBeGreaterThan(0.5); // obliquely the blades (mirroring the room) fill the view
  });

  it('a lit louver whose lamps are out (flicker burst, anomaly dip) shows the dead louver\'s albedo, not black cells', () => {
    const inp = defaultShapeInput();
    inp.ep = EP.LOUVER; inp.variant = lensVariant(3, false); inp.param = lensParam(1, 2, 1);
    inp.state = LightState.FLICKER; inp.dynEmit = true; inp.dyn = 0;
    const out = [0, 0, 0, 0];
    for (const [theta, fp] of [[0, 0.001], [50, 0.002], [75, 0.002], [80, 0.5 * 0.2 / LENS_TILE]] as const) {
      inp.fp = fp;
      inp.vx = 0; inp.vy = Math.sin((theta * Math.PI) / 180); inp.vz = Math.cos((theta * Math.PI) / 180);
      for (let i = 0; i < 40; i++) {
        inp.u = 0.3 / LENS_TILE; inp.v = (2 * 0.2 + (i + 0.5) / 40 * 0.2) / LENS_TILE;
        emitterShape(inp, out);
        const dead = offLouverAlbedo(inp);
        expect(out[3], `theta ${theta} i ${i}`).toBeGreaterThan(0.5 * LOUVER.CAV_OFF);
        // the same geometry; only the lamp silhouettes differ a little (the lit set's per-lamp gains)
        expect(Math.abs(out[3] - dead), `theta ${theta} i ${i}`).toBeLessThan(0.02);
      }
    }
  });

  it('dynamics: a FLICKER lens that is out keeps glowing cathode ends; BUZZ scales, DYING dims one lamp', () => {
    const inp = defaultShapeInput();
    const out = [0, 0, 0];
    inp.fp = 0.02; inp.u = 1; inp.v = 0.5; // lens centre (lamps along u, a 2 x 1 lens)
    inp.dynEmit = true; inp.state = LightState.FLICKER; inp.dyn = 0;
    expect(luma(emitterShape(inp, out))).toBeLessThan(1e-3); // middle: dark
    inp.u = 0.1; inp.v = 0.5 + 1 / 6; // near a lamp end (x = +0.1 m... any lamp row) and its cathode
    let endGlow = 0;
    for (let v = 0; v < 1; v += 0.02) { inp.v = v; endGlow = Math.max(endGlow, emitterShape(inp, out)[0]); }
    expect(endGlow).toBeGreaterThan(0.02);
    expect(out[0]).toBeGreaterThanOrEqual(out[2]); // warm (pink-orange)
    inp.dynEmit = false; inp.shimmer = true; inp.state = LightState.BUZZ; inp.sh = 1.03; inp.u = 1; inp.v = 0.5;
    const b = luma(emitterShape(inp, out));
    inp.sh = 1;
    expect(b / luma(emitterShape(inp, out))).toBeCloseTo(1.03, 5);
    // DYING: single-lamp profiles shimmer as a whole, multi-lamp lenses dim one lamp only
    for (const [ep, whole] of [[EP.BULB, true], [EP.HIGHBAY, true], [EP.OPAL, true], [EP.PRISM, false]] as const) {
      inp.ep = ep; inp.variant = ep === EP.PRISM ? 1 : 0; inp.param = ep === EP.PRISM || ep === EP.OPAL ? lensParam(2, 1, 0) : 0;
      inp.u = ep === EP.HIGHBAY ? 0.1 : 1; inp.v = ep === EP.HIGHBAY ? 0.1 : 0.5; inp.state = LightState.DYING; inp.sh = 0.6;
      const dim = luma(emitterShape(inp, out));
      inp.sh = 1;
      const full = luma(emitterShape(inp, out));
      if (whole) expect(dim / full, `ep ${ep}`).toBeCloseTo(0.6, 5);
      else expect(dim / full, `ep ${ep}`).toBeGreaterThan(0.6);
    }
  });
});

describe('emitter profiles: packing and choices', () => {
  it('aux round-trip: lensParam / profileBits / lensAux', () => {
    for (let U = 1; U <= 8; U++) for (let V = 1; V <= 8; V++) for (const axis of [0, 1] as const) {
      expect(unpackLensParam(lensParam(U, V, axis))).toEqual([U, V, axis]);
    }
    for (let ep = 0; ep < 16; ep++) for (let v = 0; v < 8; v++) {
      const z = profileBits(ep, v, 1);
      expect(z & 1).toBe(1);
      expect(unpackProfile(z)).toEqual([ep, v]);
    }
    const p = recessedProfile(FixtureKind.TROFFER_2x4, 2, 1, 0, 12345, Zone.LOBBY);
    const aux = lensAux(p, LightState.DYING);
    expect(aux & 255).toBe(p.A);
    expect((aux >>> 8) & 255).toBe(0);
    expect(unpackProfile((aux >>> 16) & 255)).toEqual([p.ep, p.variant]);
    expect(aux >>> 24).toBe(LightState.DYING);
    expect(epNormIndex(EP.OPAL, 3, 2 * LENS_TILE, 2 * LENS_TILE)).toBe(96 + 5);
  });

  it('recessed choices: sky panels are opal, OFFICE mostly louvers, 2x2 prisms carry two U-tubes, 2x4 prisms 2-3 lamps', () => {
    let louvers = 0, three = 0, aged = 0;
    const N = 2000;
    for (let s = 0; s < N; s++) {
      expect(recessedProfile(FixtureKind.SKY_PANEL, 2, 2, 0, s, Zone.POOLROOMS).ep).toBe(EP.OPAL);
      const o = recessedProfile(FixtureKind.TROFFER_2x2, 1, 1, 0, s, Zone.OFFICE);
      if (o.ep === EP.LOUVER) { louvers++; expect(o.n).toBe(3); expect(o.aged).toBe(false); } else expect(o.n).toBe(4);
      const l = recessedProfile(FixtureKind.TROFFER_2x4, 1, 2, 1, s, Zone.LOBBY);
      expect(l.ep).toBe(EP.PRISM);
      expect([2, 3]).toContain(l.n);
      if (l.n === 3) three++;
      if (l.aged) aged++;
      expect(unpackLensParam(l.A)).toEqual([1, 2, 1]);
    }
    expect(louvers / N).toBeCloseTo(LOUVER_P[Zone.OFFICE], 1);
    expect(three / N).toBeCloseTo(0.6, 1);
    expect(aged / N).toBeCloseTo(AGED_P[Zone.LOBBY], 1);
  });
});
