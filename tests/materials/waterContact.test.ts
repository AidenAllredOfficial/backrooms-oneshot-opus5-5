// tests/materials/waterContact.test.ts — package E refraction and contact lines (chunks/water.ts waterVolumeGlsl,
// waterFilmGlsl): a TypeScript twin of the refracted-ray march against a linear-depth "pyramid" of an analytic pool
// (flat floor fast path, the far wall under water, the floor hidden under the near rim), the contact distance from the
// straight ray, the wall-mask edge distance and the scum band.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CELL, WALL_T } from '../../src/core/constants.ts';
import { waterFilmGlsl, waterVolumeGlsl, WATER_SURFACE } from '../../src/materials/chunks/water.ts';

// ---------------------------------------------------------------- analytic scene: a pool seen from its near deck
// deck y = 0 (z >= -2 and z <= -8), pool floor y = FLOOR (-1.5; deepPool() switches to a 3.9 m deep end) and walls
// z = -2 / z = -8 between, water surface y = -0.1
const WY = -0.1, Z_NEAR = -2, Z_FAR = -8;
let FLOOR = -1.5;
/** run fn with the pool floor at y (a DEEP_END-like pool: most of the surface's refracted rays go under the near lip) */
function withFloor<T>(y: number, fn: () => T): T {
  const f0 = FLOOR;
  FLOOR = y;
  try { return fn(); } finally { FLOOR = f0; }
}
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
/** brWScenePos: the surface point in the texel nearest uv (the texel centre's ray at the texel's depth) */
const scenePos = (uv: THREE.Vector2): THREE.Vector3 => {
  const tx = Math.min(Math.max(Math.floor(uv.x * W), 0), W - 1), ty = Math.min(Math.max(Math.floor(uv.y * H), 0), H - 1);
  const c = new THREE.Vector2((tx + 0.5) / W, (ty + 0.5) / H);
  return viewPos(c, sceneZ(c));
};

/** twin of brWRefract (the GLSL above, step for step); edgeAxis = brWEdgeAxis's answer (the analytic pool's rims
 * run along x: 1) */
function refractMarch(P: THREE.Vector3, Tv: THREE.Vector3, Lf: number, upV: THREE.Vector3, steps: number, edgeAxis = 1): { L: number; uv: THREE.Vector2; hit: boolean } {
  const at = (t: number): THREE.Vector3 => P.clone().addScaledVector(Tv, t);
  const Xf = at(Lf), uvf = projUv(Xf);
  if (onScreen(uvf) && Math.abs(scenePos(uvf).sub(Xf).dot(upV)) < 0.01 - 0.004 * Xf.z) return { L: Lf, uv: uvf, hit: true };
  let tA = 0, dA = 1, tB = -1, dB = 0;
  let uvA = projUv(P), uvX = uvA.clone(), off = false;
  for (let i = 1; i <= steps; i++) {
    const t = (1.2 * Lf * i) / steps, X = at(t), uv = projUv(X);
    if (!onScreen(uv)) { off = true; break; }
    const d = sceneZ(uv) + X.z;
    if (d <= 0) { tB = t; dB = d; uvX = uv; break; }
    tA = t; dA = d; uvA = uv;
  }
  let hidden = off || tB < 0;
  if (!hidden) {
    for (let k = 0; k < 3; k++) {
      const tm = 0.5 * (tA + tB), X = at(tm), uv = projUv(X), d = sceneZ(uv) + X.z;
      if (d <= 0) { tB = tm; dB = d; uvX = uv; } else { tA = tm; dA = d; uvA = uv; }
    }
    hidden = scenePos(uvX).sub(P).dot(upV) > 0.01;
  }
  if (!hidden) {
    const t = tA + ((tB - tA) * dA) / Math.max(dA - dB, 1e-5);
    return { L: t, uv: projUv(at(t)), hit: true };
  }
  const fold = (x: number): number => 1 - Math.abs(1 - Math.abs(x));
  let uvM = new THREE.Vector2(fold(uvf.x), fold(uvf.y));
  if (!off && tB > 0) {
    let tH = tB;
    for (let k = 0; k < 8; k++) {
      const gx = (uvX.x - uvA.x) * W, gy = (uvX.y - uvA.y) * H;
      if (gx * gx + gy * gy < 1) break;
      const tm = 0.5 * (tA + tH), X = at(tm), uv = projUv(X);
      if (onScreen(uv) && sceneZ(uv) + X.z > 0) { tA = tm; uvA = uv; } else { tH = tm; uvX = uv; }
    }
    const ps = new THREE.Vector2(W, H);
    const qB = uvA.clone().add(uvX).multiplyScalar(0.5).multiply(ps), qf = uvf.clone().multiply(ps);
    let q = qB.clone().multiplyScalar(2).sub(qf);
    if (edgeAxis !== 0) {
      const dW = new THREE.Vector3(edgeAxis === 1 ? 1 : 0, 0, edgeAxis === 2 ? 1 : 0).transformDirection(view);
      const c = new THREE.Vector4(dW.x, dW.y, dW.z, 0).applyMatrix4(proj);
      const n0 = qB.clone().divide(ps).multiplyScalar(2).subScalar(1);
      const tl = new THREE.Vector2(c.x - n0.x * c.w, c.y - n0.y * c.w).multiply(ps);
      if (tl.lengthSq() > 1e-8) {
        const n = new THREE.Vector2(-tl.y, tl.x).normalize();
        q = qf.clone().addScaledVector(n, -2 * qf.clone().sub(qB).dot(n));
      }
      // the floor mirror across the lip's shadow line
      const Lp = scenePos(uvX), lh = Lp.dot(upV), fh = Xf.dot(upV);
      if (lh < 0 && fh < lh) {
        const Xs = Lp.clone().multiplyScalar(fh / lh);
        const nH = new THREE.Vector3().crossVectors(upV, dW);
        if (nH.dot(Xs) < 0) nH.negate();
        const Xm = Xf.clone().addScaledVector(nH, -2 * Math.min(Xf.clone().sub(Xs).dot(nH), 0));
        const uvW = projUv(Xm);
        if (onScreen(uvW) && scenePos(uvW).sub(P).dot(upV) < 0) q = uvW.clone().multiply(ps);
      }
    }
    uvM = q.divide(ps).clampScalar(0, 1);
  }
  return { L: Lf, uv: scenePos(uvM).sub(P).dot(upV) < 0 ? uvM : uvA, hit: false };
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

  it('the floor hidden under the near rim: no hit; the lookup mirrors the target about the boundary (no seam, no smear)', () => {
    const out: { v: number; hit: boolean; uv: THREE.Vector2 }[] = [];
    for (let v = 0.2; v < 0.9; v += 0.004) {
      const px = waterPixel(new THREE.Vector2(0.5, v));
      if (!px) continue;
      const r = refractMarch(px.P, px.Tv, px.Lf, px.upV, 10);
      out.push({ v, hit: r.hit, uv: r.uv });
    }
    const hidden = out.filter((o) => !o.hit);
    expect(hidden.length).toBeGreaterThan(5);
    expect(out[0].hit).toBe(false); // the pixel right above the rim edge
    // every hidden lookup shows the pool (floor or far wall under the water), not the deck
    for (const o of hidden) expect(scenePos(o.uv).applyMatrix4(invView).y).toBeLessThan(WY);
    // the lookup moves continuously with the pixel through the band and into the refracted neighbours: about one
    // pyramid texel per pixel step (the boundary is located to a texel, which the mirror doubles), no seam at the
    // band's edge
    const dv = 0.004 * H; // texels per pixel step
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i].uv.y - out[i - 1].uv.y) * H).toBeLessThan(dv + 2.5);
    const edge = out.findIndex((o) => o.hit);
    expect(edge).toBeGreaterThan(0);
    expect(Math.abs(out[edge].uv.y - out[edge - 1].uv.y) * H).toBeLessThan(dv + 2.5);
    // and never stalls (the old morph toward the straight-through view folded the band onto a strip of texels, a
    // smear): over any 4 pixel steps in the band the lookup travels at least a quarter of what the refracted
    // neighbours' does (the mirror reverses its direction: a kink, not a plateau)
    const refr = Math.abs(out[edge + 8].uv.y - out[edge].uv.y) / 8;
    for (let i = 0; i + 4 < edge; i++) {
      let path = 0;
      for (let j = i; j < i + 4; j++) path += Math.abs(out[j + 1].uv.y - out[j].uv.y);
      expect(path / 4, `v ${out[i].v}`).toBeGreaterThan(0.25 * refr);
    }
  });

  it('a deep pool (3.9 m): the wide hidden band shows the floor beyond the lip\'s shadow, continuous and never far', () => {
    withFloor(-4.0, () => {
      const out: { v: number; hit: boolean; uv: THREE.Vector2; y: number }[] = [];
      for (let v = 0.2; v < 0.99; v += 0.004) {
        const px = waterPixel(new THREE.Vector2(0.5, v));
        if (!px) continue;
        const r = refractMarch(px.P, px.Tv, px.Lf, px.upV, 10);
        out.push({ v, hit: r.hit, uv: r.uv, y: scenePos(r.uv).applyMatrix4(invView).y });
      }
      const hidden = out.filter((o) => !o.hit);
      expect(hidden.length).toBeGreaterThan(40); // most of this pool's surface
      // every hidden lookup is the floor beyond the shadow or the foot of the far wall (floor maps to floor; this pool
      // is short), never higher up the far wall or the deck (the screen-space mirror reached 1.1 m up the far wall)
      for (const o of hidden) expect(o.y, `v ${o.v}`).toBeLessThan(FLOOR + 0.6);
      // continuous through the band and at its edge (the screen-space mirror threw these lookups far up the screen,
      // onto the far wall: a ghost of the pool's far end)
      const dv = 0.004 * H;
      const edge = out.findIndex((o) => o.hit);
      expect(edge).toBeGreaterThan(40);
      for (let i = 1; i <= edge; i++) expect(Math.abs(out[i].uv.y - out[i - 1].uv.y) * H, `v ${out[i].v}`).toBeLessThan(dv + 2.5);
    });
  });

  it('the GLSL march is this algorithm (pinned statements)', () => {
    const g = waterVolumeGlsl();
    expect(g).toContain('abs( dot( brWScenePos( uvf ) - Xf, upV ) ) < 0.01 - 0.004 * Xf.z');
    expect(g).toContain('float t = 1.2 * Lf * float( i ) / float( BR_WATER_REFRACT );');
    expect(g).toContain('hidden = dot( brWScenePos( uvX ) - P, upV ) > 0.01;');
    expect(g).toContain('if ( brWOnScreen( uv ) && brWSceneZ( uv ) + X.z > 0.0 ) { tA = tm; uvA = uv; } else { tH = tm; uvX = uv; }');
    expect(g).toContain('vec2 uvM = 1.0 - abs( 1.0 - abs( uvf ) );');
    expect(g).toContain('vec2 tl = ( c.xy - ( 2.0 * qB / ps - 1.0 ) * c.w ) * ps;');
    expect(g).toContain('q = qf - 2.0 * dot( qf - qB, n ) * n;');
    expect(g).toContain('vec3 Xs = Lp * ( fh / lh );');
    expect(g).toContain('vec3 Xm = Xf - 2.0 * min( dot( Xf - Xs, nH ), 0.0 ) * nH;');
    expect(g).toContain('if ( brWOnScreen( uvW ) && dot( brWScenePos( uvW ) - P, upV ) < 0.0 ) q = uvW * ps;');
    expect(g).toContain('uvH = dot( brWScenePos( uvM ) - P, upV ) < 0.0 ? uvM : uvA;');
    expect(g).toContain('float t = tA + ( tB - tA ) * dA / max( dA - dB, 1e-5 );');
  });

  it('the lip\'s axis (brWEdgeAxis twin): walking the cells toward the eye finds the rim the refracted rays go behind', () => {
    // a 10 x 6 cell pool (cells 2..11 x 2..7) in a tile; dry elsewhere; the east side a wall
    const water = (i: number, j: number): boolean => i >= 2 && i <= 11 && j >= 2 && j <= 7;
    const wallE = (i: number, j: number): boolean => i === 11 && j >= 2 && j <= 7;
    const axis = (px: number, pz: number, dx: number, dz: number): number => {
      const l = Math.hypot(dx, dz), dir = [dx / l, dz / l];
      let c = [Math.floor(px / CELL), Math.floor(pz / CELL)];
      const st = [dir[0] > 0 ? 1 : -1, dir[1] > 0 ? 1 : -1];
      const inv = [1 / Math.max(Math.abs(dir[0]), 1e-4), 1 / Math.max(Math.abs(dir[1]), 1e-4)];
      const tM = [Math.abs((c[0] + (dir[0] > 0 ? 1 : 0)) * CELL - px) * inv[0], Math.abs((c[1] + (dir[1] > 0 ? 1 : 0)) * CELL - pz) * inv[1]];
      for (let k = 0; k < 4; k++) {
        const xs = tM[0] < tM[1];
        const d = xs ? [st[0], 0] : [0, st[1]];
        const cn = [c[0] + d[0], c[1] + d[1]];
        if (cn[0] < -1 || cn[1] < -1 || cn[0] > 16 || cn[1] > 16) return 0;
        if ((d[0] > 0 && wallE(c[0], c[1])) || !water(cn[0], cn[1])) return xs ? 2 : 1;
        c = cn;
        if (xs) tM[0] += CELL * inv[0]; else tM[1] += CELL * inv[1];
      }
      return 0;
    };
    expect(axis(5.5 * CELL, 3.2 * CELL, 0.1, -1)).toBe(1); // eye beyond the -z side: the rim runs along x
    expect(axis(3.1 * CELL, 5.5 * CELL, -1, 0.2)).toBe(2); // eye beyond the -x side: along z
    expect(axis(10.6 * CELL, 5.5 * CELL, 1, 0)).toBe(2); // the east wall
    expect(axis(6.5 * CELL, 7.5 * CELL, 0.1, -1)).toBe(0); // 4 cells of water on the way: none in reach
    const g = waterVolumeGlsl();
    expect(g).toContain('int brWEdgeAxis( vec2 p, vec2 dir, float wy )');
    expect(g).toContain("if ( ( brWallBits( c ) & side ) != 0 || ! brWaterCell( cn, wyn, kn ) || abs( wyn - wy ) > 0.03 ) return xs ? 2 : 1;");
  });
});

// ---------------------------------------------------------------- contact lines

/** twin of brWContact: S0 = the surface point of the texel at the own pixel, P the fragment on the surface; the
 * horizontal distance between them when S0 lies less than D / 2 below the surface (and not above it), else none */
function contactDistance(S0: THREE.Vector3, P: THREE.Vector3, up: THREE.Vector3, D: number): number | null {
  const dv = S0.clone().sub(P);
  const h0 = -dv.dot(up);
  if (h0 > 0.5 * D || h0 < -0.01) return null;
  const u = Math.min(Math.max((h0 - 0.2 * D) / (0.3 * D), 0), 1);
  return dv.addScaledVector(up, h0).length() + 0.3 * u * u * (3 - 2 * u);
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
    const up = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(0, 0, 0);
    // a vertical wall at horizontal distance x, seen at elevation el: the ray reaches it at the depth x tan(el)
    for (const el of [0.3, 0.6, 1.0]) {
      for (const x of [0, 0.02, 0.05]) {
        const S0 = new THREE.Vector3(0, -x * Math.tan(el), -x);
        expect(contactDistance(S0, P, up, 0.5)).toBeCloseTo(x, 9);
      }
    }
    // the floor, D below: none, also where the texel's centre is off the pixel's ray (the ultra pyramid at a grazing
    // film: 2 cm deep, 0.3 m farther along the view; the old along-the-ray distance then read as a contact)
    expect(contactDistance(new THREE.Vector3(0, -0.25, -1), P, up, 0.25)).toBeNull();
    expect(contactDistance(new THREE.Vector3(0, -0.02, -0.25), P, up, 0.02)).toBeNull();
    // a texel of something above the water (a silhouette in front of the surface): none
    expect(contactDistance(new THREE.Vector3(0, 0.3, 0.2), P, up, 0.5)).toBeNull();
    expect(waterVolumeGlsl()).toContain('if ( h0 > 0.5 * D || h0 < - 0.01 ) return 1e3;');
    // seen steeply (60 deg) in 25 cm of flood water, a chair leg's contact fades out smoothly before the cutoff: the
    // distance grows past twice the scum width (no effect left) without a jump, so the band has no hard outer ring
    const el = Math.PI / 3, D = 0.25;
    let prev = 0;
    for (let x = 0.0; x < (0.5 * D) / Math.tan(el); x += 0.002) {
      const e = contactDistance(new THREE.Vector3(0, -x * Math.tan(el), -x), P, up, D)!;
      expect(e - prev).toBeLessThan(0.03);
      prev = e;
    }
    expect(prev).toBeGreaterThan(2 * WATER_SURFACE.SCUM_W[1]);
    expect(waterVolumeGlsl()).toContain('return e + 0.3 * smoothstep( 0.2 * D, 0.5 * D, h0 );');
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
