// tests/materials/waterContact.test.ts — package E refraction and contact lines (chunks/water.ts waterVolumeGlsl,
// waterFilmGlsl): a TypeScript twin of the refracted-ray march against a linear-depth "pyramid" of an analytic pool
// (flat floor fast path, the far wall under water, the floor hidden under the near rim), the contact distance from the
// straight ray, the wall-mask edge distance and the scum band.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WALL_T } from '../../src/core/constants.ts';
import { waterFilmGlsl, waterVolumeGlsl, WATER_SURFACE } from '../../src/materials/chunks/water.ts';

// ---------------------------------------------------------------- analytic scene: a pool seen from its near deck
// deck y = 0 (z >= -2 and z <= -8), pool floor y = -1.5 and walls z = -2 / z = -8 between, water surface y = -0.1
const WY = -0.1, FLOOR = -1.5, Z_NEAR = -2, Z_FAR = -8;
function hitScene(o: THREE.Vector3, d: THREE.Vector3): number {
  let best = Infinity;
  const plane = (axis: 'y' | 'z', v: number, ok: (p: THREE.Vector3) => boolean): void => {
    const den = d[axis];
    if (Math.abs(den) < 1e-9) return;
    const t = (v - o[axis]) / den;
    if (t <= 1e-6 || t >= best) return;
    const p = o.clone().addScaledVector(d, t);
    if (ok(p)) best = t;
  };
  plane('y', 0, (p) => p.z >= Z_NEAR || p.z <= Z_FAR);
  plane('y', FLOOR, (p) => p.z < Z_NEAR && p.z > Z_FAR);
  plane('z', Z_NEAR, (p) => p.y < 0 && p.y > FLOOR);
  plane('z', Z_FAR, (p) => p.y < 0 && p.y > FLOOR);
  return best;
}

const W = 480, H = 270;
const cam = new THREE.PerspectiveCamera(60, W / H, 0.05, 400);
cam.position.set(0, 1.62, 0);
cam.rotation.set((-40 * Math.PI) / 180, 0, 0, 'YXZ');
cam.updateMatrixWorld(true);
cam.updateProjectionMatrix();
const view = cam.matrixWorldInverse, proj = cam.projectionMatrix;
const invView = cam.matrixWorld;

const toView = (p: THREE.Vector3): THREE.Vector3 => p.clone().applyMatrix4(view);
/** brWProj: view-space point -> uv */
const projUv = (X: THREE.Vector3): THREE.Vector2 => {
  const c = new THREE.Vector4(X.x, X.y, X.z, 1).applyMatrix4(proj);
  return new THREE.Vector2((c.x / c.w) * 0.5 + 0.5, (c.y / c.w) * 0.5 + 0.5);
};
/** brWViewPos: uv + linear depth -> view-space point */
const viewPos = (uv: THREE.Vector2, z: number): THREE.Vector3 => {
  const e = proj.elements;
  const nx = uv.x * 2 - 1, ny = uv.y * 2 - 1;
  return new THREE.Vector3(((nx + e[8]) * z) / e[0], ((ny + e[9]) * z) / e[5], -z);
};
/** brWSceneZ: the linear depth of the nearest texel of a W x H pyramid level 0 */
const sceneZ = (uv: THREE.Vector2): number => {
  const tx = Math.min(Math.max(Math.floor(uv.x * W), 0), W - 1), ty = Math.min(Math.max(Math.floor(uv.y * H), 0), H - 1);
  const c = new THREE.Vector2((tx + 0.5) / W, (ty + 0.5) / H);
  const dirV = viewPos(c, 1).normalize();
  const dirW = dirV.clone().transformDirection(invView);
  const t = hitScene(cam.position, dirW);
  return t === Infinity ? 400 : -dirV.multiplyScalar(t).z;
};
const onScreen = (uv: THREE.Vector2): boolean => uv.x >= 0 && uv.y >= 0 && uv.x <= 1 && uv.y <= 1;

/** twin of brWRefract (the GLSL above, step for step) */
function refractMarch(P: THREE.Vector3, Tv: THREE.Vector3, Lf: number, upV: THREE.Vector3, steps: number): { L: number; uv: THREE.Vector2; hit: boolean } {
  const at = (t: number): THREE.Vector3 => P.clone().addScaledVector(Tv, t);
  const Xf = at(Lf), uvf = projUv(Xf);
  if (onScreen(uvf) && Math.abs(sceneZ(uvf) + Xf.z) < 0.01 - 0.012 * Xf.z) return { L: Lf, uv: uvf, hit: true };
  let tA = 0, dA = 1, tB = -1, dB = 0, tH = -1;
  let uvH = projUv(P);
  for (let i = 1; i <= steps; i++) {
    const t = (1.2 * Lf * i) / steps, X = at(t), uv = projUv(X);
    if (!onScreen(uv)) { tH = t; break; }
    const zs = sceneZ(uv), d = zs + X.z;
    if (d <= 0) {
      if (viewPos(uv, zs).sub(P).dot(upV) > 0.01) { tH = t; break; }
      tB = t; dB = d;
      break;
    }
    tA = t; dA = d; uvH = uv;
  }
  if (tB < 0) {
    if (tH > 0) {
      for (let k = 0; k < 2; k++) {
        const tm = 0.5 * (tA + tH), X = at(tm), uv = projUv(X);
        if (onScreen(uv) && sceneZ(uv) + X.z > 0) { tA = tm; uvH = uv; } else tH = tm;
      }
    }
    const f = Math.min(Math.max(tA / Lf, 0), 1);
    return { L: Lf, uv: projUv(P).lerp(uvH, f), hit: false };
  }
  for (let k = 0; k < 2; k++) {
    const tm = 0.5 * (tA + tB), X = at(tm), d = sceneZ(projUv(X)) + X.z;
    if (d <= 0) { tB = tm; dB = d; } else { tA = tm; dA = d; }
  }
  const t = tA + ((tB - tA) * dA) / Math.max(dA - dB, 1e-5);
  return { L: t, uv: projUv(at(t)), hit: true };
}

/** the water fragment at screen uv: its view-space point on the surface, the refracted direction and Lf */
function waterPixel(uv: THREE.Vector2): { P: THREE.Vector3; Tv: THREE.Vector3; Lf: number; upV: THREE.Vector3 } | null {
  const dirW = viewPos(uv, 1).normalize().transformDirection(invView);
  const t = (WY - cam.position.y) / dirW.y;
  const Pw = cam.position.clone().addScaledVector(dirW, t);
  if (!(t > 0) || Pw.z >= Z_NEAR || Pw.z <= Z_FAR) return null;
  const upV = new THREE.Vector3(0, 1, 0).transformDirection(view);
  const Vw = dirW.clone().negate(); // toward the eye
  // GLSL refract(-V, n, eta)
  const I = Vw.clone().negate(), n = new THREE.Vector3(0, 1, 0), eta = 0.75;
  const ci = -I.dot(n), k = 1 - eta * eta * (1 - ci * ci);
  const Tw = I.clone().multiplyScalar(eta).addScaledVector(n, eta * ci - Math.sqrt(k));
  const Tv = Tw.clone().transformDirection(view);
  const cosT = Math.max(-Tv.dot(upV), 0.05);
  return { P: toView(Pw), Tv, Lf: (WY - FLOOR) / cosT, upV };
}

describe('refracted-ray march against the pyramid depth (brWRefract twin)', () => {
  it('open floor: the fast path returns the flat-floor path D / cos(theta_t); the floor looks shallower', () => {
    const px = waterPixel(new THREE.Vector2(0.5, 0.62))!;
    expect(px).not.toBeNull();
    const r = refractMarch(px.P, px.Tv, px.Lf, px.upV, 10);
    expect(r.hit).toBe(true);
    expect(r.L).toBe(px.Lf);
    // the refracted floor point projects below (nearer the eye than) the straight-through one
    expect(r.uv.y).toBeLessThan(0.62);
  });

  it('a far wall under the water: the march, bisections and secant land on it within 2 cm', () => {
    let tested = 0;
    for (let v = 0.995; v > 0.8; v -= 0.005) {
      const px = waterPixel(new THREE.Vector2(0.5, v));
      if (!px) continue;
      // analytic refracted hit
      const Pw = px.P.clone().applyMatrix4(invView), Tw = px.Tv.clone().transformDirection(invView);
      const tWall = (Z_FAR - Pw.z) / Tw.z, yWall = Pw.y + Tw.y * tWall;
      if (!(tWall > 0) || yWall <= FLOOR + 0.05) continue; // this ray reaches the floor first
      const r = refractMarch(px.P, px.Tv, px.Lf, px.upV, 10);
      expect(r.hit).toBe(true);
      expect(Math.abs(r.L - tWall)).toBeLessThan(0.02);
      tested++;
    }
    expect(tested).toBeGreaterThan(3);
  });

  it('the floor hidden under the near rim: no hit, and the lookup morphs continuously (no band, no seam)', () => {
    const out: { v: number; hit: boolean; uv: THREE.Vector2; uv0: THREE.Vector2 }[] = [];
    for (let v = 0.2; v < 0.9; v += 0.004) {
      const px = waterPixel(new THREE.Vector2(0.5, v));
      if (!px) continue;
      const r = refractMarch(px.P, px.Tv, px.Lf, px.upV, 10);
      out.push({ v, hit: r.hit, uv: r.uv, uv0: projUv(px.P) });
    }
    const hidden = out.filter((o) => !o.hit);
    expect(hidden.length).toBeGreaterThan(2);
    // the pixel right above the rim edge samples (almost) straight through
    const first = out[0];
    expect(first.hit).toBe(false);
    expect(Math.abs(first.uv.y - first.uv0.y)).toBeLessThan(0.02);
    // the lookup moves continuously with the pixel through the band and into the refracted neighbours (steps of about
    // one pyramid texel per pixel step: no seam at either end). The content there (the floor and the near wall under
    // the rim) is not in the pyramid at all: inside the band the morph folds back gently toward the rim.
    const dv = 0.004 * H; // texels per pixel step
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i].uv.y - out[i - 1].uv.y) * H).toBeLessThan(dv * 1.6);
    const edge = out.findIndex((o) => o.hit);
    expect(edge).toBeGreaterThan(0);
    expect(Math.abs(out[edge].uv.y - out[edge - 1].uv.y) * H).toBeLessThan(dv * 1.6);
  });

  it('the GLSL march is this algorithm (pinned statements)', () => {
    const g = waterVolumeGlsl();
    expect(g).toContain('abs( brWSceneZ( uvf ) + Xf.z ) < 0.01 - 0.012 * Xf.z');
    expect(g).toContain('float t = 1.2 * Lf * float( i ) / float( BR_WATER_REFRACT );');
    expect(g).toContain('uvH = mix( brWProj( P ), uvH, f );');
    expect(g).toContain('if ( brWOnScreen( uv ) && zs + X.z > 0.0 ) { tA = tm; uvH = uv; } else tH = tm;');
    expect(g).toContain('float t = tA + ( tB - tA ) * dA / max( dA - dB, 1e-5 );');
  });
});

// ---------------------------------------------------------------- contact lines

/** twin of brWContact: the horizontal distance to what the straight view ray meets tau metres below the surface
 * point at depth h0 (0 when it lies at the surface), or none when it is deeper than half the flat-floor path */
function contactDistance(tau: number, h0: number, D: number, cV: number): number | null {
  if (tau > (0.5 * D) / Math.max(cV, 0.05)) return null;
  return Math.sqrt(Math.max(tau * tau - Math.max(h0, 0) ** 2, 0));
}
/** twin of brWaterEdge's distance in one cell (fx, fz in [0, CELL)): bits N1 E2 S4 W8 = walls; open[k] = neighbour k
 * holds this water */
function edgeDistance(fx: number, fz: number, bits: number, open: readonly boolean[], cell = 1.2): number {
  let e = 1e3;
  for (let k = 0; k < 4; k++) {
    const wall = (bits & (1 << k)) !== 0;
    if (!wall && open[k]) continue;
    let d = k === 0 ? fz : k === 1 ? cell - fx : k === 2 ? cell - fz : fx;
    if (wall) d -= 0.5 * WALL_T;
    e = Math.min(e, d);
  }
  return Math.max(e, 0);
}

describe('contact lines', () => {
  it('the straight ray meeting a wall at the surface gives e = 0; the wall at x behind gives e = x; open floor gives none', () => {
    // a vertical wall at horizontal distance x, seen at elevation el: tau along the ray, h0 = the depth reached
    for (const el of [0.3, 0.6, 1.0]) {
      for (const x of [0, 0.02, 0.05]) {
        const tau = x / Math.cos(el), h0 = x * Math.tan(el);
        expect(contactDistance(tau, h0, 0.5, Math.sin(el))).toBeCloseTo(x, 9);
      }
    }
    expect(contactDistance(1.0, 0.25, 0.25, Math.sin(0.4))).toBeNull(); // the floor, 1 m away along a 23 deg ray
  });

  it('the wall-mask edge distance: walls stand WALL_T / 2 proud of the edge line; dry neighbours bound at the line', () => {
    const allOpen = [true, true, true, true];
    expect(edgeDistance(0.6, 0.6, 0, allOpen)).toBe(1e3);
    expect(edgeDistance(0.6, 0.3, 1, allOpen)).toBeCloseTo(0.3 - WALL_T / 2, 9); // N wall
    expect(edgeDistance(0.9, 0.6, 0, [true, false, true, true])).toBeCloseTo(0.3, 9); // dry E neighbour (the pool rim)
    expect(edgeDistance(0.02, 0.6, 8, allOpen)).toBe(0); // inside the wall's thickness
    expect(waterFilmGlsl()).toContain(`#define BR_WALL_T ${WALL_T}`);
  });

  it('scum width and strength per kind: pools barely, flooded rooms a wide ragged band; the meniscus stays >= 1.2 px', () => {
    const [pool, flood, film] = WATER_SURFACE.SCUM_W;
    expect(flood).toBeGreaterThan(film);
    expect(film).toBeGreaterThan(pool);
    expect(WATER_SURFACE.SCUM_K[1]).toBeGreaterThan(WATER_SURFACE.SCUM_K[0]);
    const g = waterFilmGlsl();
    expect(g).toContain('if ( e > 2.0 * w ) return 0.0;');
    expect(g).toContain(`const float BR_WSCUM_W[3] = float[3](`);
    expect(WATER_SURFACE.MENISCUS_W).toBeLessThan(0.005);
  });
});
