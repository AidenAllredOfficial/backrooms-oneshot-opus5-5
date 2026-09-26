// src/props/pipes.ts — pipe solids (§5 WP6): 10-sided tubes (METAL_PAINTED, or METAL_RUST by decay), a torus
// elbow (6 segments) wherever two pipe solids share an endpoint, a junction fitting where three or more meet,
// flanges every 2.4 m, and hangers (clevis band + threaded rod + ceiling plate) to the ceiling every 2.4 m on
// horizontal runs.
//
// Generators split runs into many short solids (PIPEWORKS: ~700 per chunk, most shorter than 2.4 m), so flanges
// and hangers of axis-aligned runs sit on a WORLD lattice along the run (axis coordinate = 1.8 / 0.6 mod 2.4 m;
// chunk origins are multiples of 2.4 m, so chunk-local coordinates give the same lattice): the spacing is 2.4 m
// along the whole run however it is split, and collinear joints are seamless (no coupling). Free ends that pass
// through the ceiling or the floor get neither an end cap nor a blind flange.
//
// Deterministic ownership across tiles/chunks: both pipes of an elbow trim themselves by the same tangent length
// (a symmetric function of the pair), and only the pipe with the smallest geometric key draws the shared fitting,
// so an elbow is emitted exactly once whichever tile owns each pipe (pipes are owned by their midpoint).
// Pure module (no three/DOM).

import { Mat } from '../core/ids.ts';
import type { Solid } from '../core/layout.ts';
import type { GeometryWriter } from '../core/writer.ts';
import { PartBuilder } from './builder.ts';
import { canonRef, cylinder, lathe, sweep } from './primitives.ts';

export type PipeSolid = Extract<Solid, { kind: 'pipe' }>;

const B = new PartBuilder();
const SIDES = 10;
const ELBOW_SEGS = 6;
const SPACING = 2.4;
const EPS = 2e-3; // endpoint coincidence (m)
const RUST_DECAY = 150; // decay byte above which painted pipes are drawn rusty

const PAINTS: readonly (readonly [number, number, number])[] = [
  [0.3, 0.3, 0.29], [0.1, 0.17, 0.11], [0.2, 0.24, 0.3], [0.38, 0.33, 0.2],
];

const same = (a: readonly number[], b: readonly number[]): boolean =>
  Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS;
const samePipe = (p: PipeSolid, q: PipeSolid): boolean =>
  (same(p.a, q.a) && same(p.b, q.b)) || (same(p.a, q.b) && same(p.b, q.a));
/** Geometric key (mm-quantised endpoints, sorted) for chunk-independent ownership decisions. */
function keyLess(p: PipeSolid, q: PipeSolid): boolean {
  const kp = pipeKey(p), kq = pipeKey(q);
  for (let i = 0; i < 6; i++) if (kp[i] !== kq[i]) return kp[i] < kq[i];
  return false;
}
function pipeKey(p: PipeSolid): number[] {
  const qa = [Math.round(p.a[0] * 1000), Math.round(p.a[1] * 1000), Math.round(p.a[2] * 1000)];
  const qb = [Math.round(p.b[0] * 1000), Math.round(p.b[1] * 1000), Math.round(p.b[2] * 1000)];
  const aFirst = qa[0] < qb[0] || (qa[0] === qb[0] && (qa[1] < qb[1] || (qa[1] === qb[1] && qa[2] <= qb[2])));
  return aFirst ? [...qa, ...qb] : [...qb, ...qa];
}

interface EndInfo {
  trim: number; // distance to cut back from the endpoint
  kind: 'free' | 'elbow' | 'straight' | 'junction';
  owner: boolean;
  other: PipeSolid | null;
  bendR: number;
}

function analyseEnd(p: PipeSolid, atA: boolean, neighbours: readonly PipeSolid[], out: EndInfo): void {
  const E = atA ? p.a : p.b, F = atA ? p.b : p.a;
  out.trim = 0; out.kind = 'free'; out.owner = true; out.other = null; out.bendR = 0;
  let count = 0;
  let o: PipeSolid | null = null;
  let oFar: readonly number[] = E;
  let minKey = true;
  for (const q of neighbours) {
    if (q === p || samePipe(p, q)) continue;
    let far: readonly number[] | null = null;
    if (same(q.a, E)) far = q.b;
    else if (same(q.b, E)) far = q.a;
    if (!far) continue;
    // degenerate neighbour (both ends at E): no direction to bend toward, and dividing by its length would give NaN
    if (Math.hypot(far[0] - E[0], far[1] - E[1], far[2] - E[2]) < 1e-4) continue;
    // ignore duplicates of the same neighbour (a pipe added by several chunks)
    if (o && samePipe(o, q)) continue;
    count++;
    if (count === 1) { o = q; oFar = far; }
    if (keyLess(q, p)) minKey = false;
  }
  if (count === 0) return;
  out.owner = minKey;
  if (count >= 2) { out.kind = 'junction'; return; }
  out.other = o;
  const ax = F[0] - E[0], ay = F[1] - E[1], az = F[2] - E[2];
  const bx = oFar[0] - E[0], by = oFar[1] - E[1], bz = oFar[2] - E[2];
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
  const cosT = (ax * bx + ay * by + az * bz) / (la * lb || 1);
  const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
  if (theta > Math.PI - 0.09) { out.kind = 'straight'; return; }
  if (theta < 0.2) { out.kind = 'junction'; return; } // folded back: just a fitting
  const rr = Math.max(p.r, o ? o.r : 0);
  let bendR = Math.max(1.5 * rr, rr + 0.04);
  let t = bendR / Math.tan(theta / 2);
  const tMax = 0.45 * Math.min(la, lb);
  if (t > tMax) { t = tMax; bendR = t * Math.tan(theta / 2); }
  out.kind = 'elbow';
  out.trim = t;
  out.bendR = bendR;
}

const endA: EndInfo = { trim: 0, kind: 'free', owner: true, other: null, bendR: 0 };
const endB: EndInfo = { trim: 0, kind: 'free', owner: true, other: null, bendR: 0 };
const refA = [0, 0, 0], refB = [0, 0, 0], tanA = [0, 0, 0], tanB = [0, 0, 0];

function setPipeMaterial(p: PipeSolid, decay: number): void {
  if (p.mat === Mat.METAL_RUST || decay >= RUST_DECAY) { B.mat(Mat.METAL_RUST); return; }
  const c = PAINTS[Math.round(p.r * 1000) % PAINTS.length];
  B.mat(Mat.METAL_PAINTED, c[0], c[1], c[2], 0, 0.4);
}

/** Tube ring cylinder (flange / coupling) of radius rr, thickness th, centred at distance s along the pipe. */
function collar(x: number, y: number, z: number, dx: number, dy: number, dz: number, rr: number, th: number): void {
  B.push();
  B.translate(x, y, z);
  B.alignY(dx, dy, dz);
  cylinder(B, rr, rr, -th / 2, th / 2, SIDES, 3);
  B.pop();
}

/** Running fitting counters (diagnostics / triangle reports; reset by the caller). */
export const pipeStats = { pipes: 0, elbows: 0, junctions: 0, flanges: 0, blind: 0, hangers: 0, hangersMoved: 0, hangersBlocked: 0 };

const FLANGE_PHASE = 1.8;
const BAND_R = (r: number): number => (r + 0.006) / Math.cos(Math.PI / 8);
const HANGER_PHASE = 0.6;
const HANGER_SLIDE = 0.15; // step (m) when sliding a blocked hanger along its run
const HANGER_SLIDE_STEPS = 4; // up to +-0.6 m
const ROD_CLEAR = 0.03; // clearance (m) kept between a hanger rod / ceiling plate and another pipe's surface

/** Would a vertical hanger rod at (x, z) between y0 and y1 pass through (or graze) a pipe of `neighbours` other
 * than p? Horizontal / sloped pipes: the pipe's axis point nearest the rod in plan; vertical pipes: their y span. */
function rodBlocked(p: PipeSolid, neighbours: readonly PipeSolid[], x: number, z: number, y0: number, y1: number): boolean {
  for (let i = 0; i < neighbours.length; i++) {
    const q = neighbours[i];
    if (q === p || samePipe(p, q)) continue;
    const qx = q.b[0] - q.a[0], qz = q.b[2] - q.a[2];
    const l2 = qx * qx + qz * qz;
    let t = l2 > 1e-8 ? ((x - q.a[0]) * qx + (z - q.a[2]) * qz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = q.a[0] + qx * t - x, pz = q.a[2] + qz * t - z;
    const clr = q.r + ROD_CLEAR;
    if (px * px + pz * pz >= clr * clr) continue;
    let qy0: number, qy1: number;
    if (l2 <= 1e-8) { qy0 = Math.min(q.a[1], q.b[1]); qy1 = Math.max(q.a[1], q.b[1]); }
    else { qy0 = qy1 = q.a[1] + (q.b[1] - q.a[1]) * t; }
    if (qy1 + q.r > y0 && qy0 - q.r < y1) return true;
  }
  return false;
}
const stops: number[] = [];

/** Free end passing through the ceiling above it or the floor datum (a riser / drop): no cap, no blind flange. */
function penetrates(E: readonly number[], ceilAt: ((x: number, z: number) => number) | null): boolean {
  if (E[1] <= 0.02) return true;
  const c = ceilAt ? ceilAt(E[0], E[2]) : Number.NaN;
  return Number.isFinite(c) && E[1] >= c - 0.02;
}

/** Arc lengths s in [lo, hi) along the pipe where fittings go: for axis-aligned runs, where the axis coordinate
 * (chunk-local x, y or z) is phase mod 2.4 (a world lattice, identical however the run is split into solids);
 * otherwise phase + k * 2.4 from the start of the solid. Half-open, so a stop exactly on a collinear joint belongs
 * to exactly one of the two solids (the one starting there). */
function latticeStops(p: PipeSolid, len: number, dx: number, dy: number, dz: number, phase: number, lo: number, hi: number, out: number[]): void {
  out.length = 0;
  if (!(hi > lo)) return;
  const ax: number = Math.abs(dx) > 0.999 ? 0 : Math.abs(dy) > 0.999 ? 1 : Math.abs(dz) > 0.999 ? 2 : -1;
  if (ax < 0) {
    for (let s = phase; s < hi && s <= len; s += SPACING) if (s >= lo - 1e-6) out.push(s);
    return;
  }
  const d = ax === 0 ? dx : ax === 1 ? dy : dz; // +-1
  const c0 = ax === 0 ? p.a[0] : ax === 1 ? p.a[1] : p.a[2];
  // coordinate c(s) = c0 + d * s; lattice c = phase + k * SPACING
  const cLo = Math.min(c0 + d * lo, c0 + d * hi), cHi = Math.max(c0 + d * lo, c0 + d * hi);
  for (let k = Math.ceil((cLo - phase) / SPACING - 1e-6); phase + k * SPACING <= cHi + 1e-6; k++) {
    const s = (phase + k * SPACING - c0) * d;
    if (s >= lo - 1e-6 && s < hi - 1e-6) out.push(s);
  }
  if (d < 0) out.reverse();
}

/** Emit one pipe solid (chunk-local) into `w`, tile origin (ox, oz). `ceilAt(x, z)` gives the ceiling height
 * (storey-relative metres) above a chunk-local point (NaN where there is none: no hanger there); `ceilAt` null =
 * context unknown (hangers then get a short 25 cm rod). */
export function emitPipeInto(
  w: GeometryWriter, p: PipeSolid, neighbours: readonly PipeSolid[], ox: number, oz: number,
  ceilAt: ((x: number, z: number) => number) | null, decay: number, auxBits: number, ceilByte: number,
): number {
  const ax = p.a[0], ay = p.a[1], az = p.a[2];
  let dx = p.b[0] - ax, dy = p.b[1] - ay, dz = p.b[2] - az;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-4) || !(p.r > 0)) return 0;
  dx /= len; dy /= len; dz /= len;
  pipeStats.pipes++;
  analyseEnd(p, true, neighbours, endA);
  analyseEnd(p, false, neighbours, endB);

  w.setTransform(0, 1, -ox, 0, -oz);
  B.begin(w, false, auxBits, ceilByte, Math.round(p.r * 10000)); // seed from the run radius: one tint per run
  setPipeMaterial(p, decay);
  const r = p.r;

  // straight run between the trimmed ends
  const s0 = endA.trim, s1 = len - endB.trim;
  if (s1 - s0 > 1e-4) {
    canonRef(dx, dy, dz, refA);
    const caps = (endA.kind === 'free' && !penetrates(p.a, ceilAt) ? 1 : 0) | (endB.kind === 'free' && !penetrates(p.b, ceilAt) ? 2 : 0);
    sweep(B, [ax + dx * s0, ay + dy * s0, az + dz * s0, ax + dx * s1, ay + dy * s1, az + dz * s1], r, SIDES, caps, refA, refA);
  }

  // fittings at the ends (owner only)
  for (let e = 0; e < 2; e++) {
    const info = e === 0 ? endA : endB;
    const E = e === 0 ? p.a : p.b;
    const sg = e === 0 ? 1 : -1; // direction from E into this pipe
    if (info.kind === 'free') {
      if (!penetrates(E, ceilAt)) { collar(E[0] + dx * sg * 0.015, E[1] + dy * sg * 0.015, E[2] + dz * sg * 0.015, dx, dy, dz, r * 1.45, 0.03); pipeStats.blind++; } // blind flange
      continue;
    }
    if (!info.owner || info.kind === 'straight') continue; // collinear continuation: seamless
    if (info.kind === 'junction') {
      pipeStats.junctions++;
      B.push();
      B.translate(E[0], E[1], E[2]);
      const rr = r * 1.35;
      lathe(B, [0, -rr, rr * 0.7, -rr * 0.7, rr, 0, rr * 0.7, rr * 0.7, 0, rr], SIDES, 0, 60);
      B.pop();
    } else if (info.kind === 'elbow' && info.other) {
      pipeStats.elbows++;
      const o = info.other;
      const F = same(o.a, E) ? o.b : o.a;
      // unit legs from E
      const uax = dx * sg, uay = dy * sg, uaz = dz * sg;
      let ubx = F[0] - E[0], uby = F[1] - E[1], ubz = F[2] - E[2];
      const lb = Math.hypot(ubx, uby, ubz);
      ubx /= lb; uby /= lb; ubz /= lb;
      const cosT = uax * ubx + uay * uby + uaz * ubz;
      const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
      const t = info.trim, R = info.bendR;
      let bx = uax + ubx, by = uay + uby, bz = uaz + ubz;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      const dC = R / Math.sin(theta / 2);
      const cx = E[0] + bx * dC, cy = E[1] + by * dC, cz = E[2] + bz * dC;
      const sx = E[0] + uax * t - cx, sy = E[1] + uay * t - cy, sz = E[2] + uaz * t - cz;
      const ex = E[0] + ubx * t - cx, ey = E[1] + uby * t - cy, ez = E[2] + ubz * t - cz;
      const sweepA = Math.PI - theta, sinA = Math.sin(sweepA);
      const pts: number[] = [];
      for (let k = 0; k <= ELBOW_SEGS; k++) {
        const f = k / ELBOW_SEGS;
        const w0 = Math.sin((1 - f) * sweepA) / sinA, w1 = Math.sin(f * sweepA) / sinA;
        pts.push(cx + sx * w0 + ex * w1, cy + sy * w0 + ey * w1, cz + sz * w0 + ez * w1);
      }
      canonRef(uax, uay, uaz, refA);
      canonRef(ubx, uby, ubz, refB);
      // exact arc tangents at both ends so the end rings are coplanar with the trimmed straight tubes' end rings
      tanA[0] = -uax; tanA[1] = -uay; tanA[2] = -uaz;
      tanB[0] = ubx; tanB[1] = uby; tanB[2] = ubz;
      sweep(B, pts, r, SIDES, 0, refA, refB, tanA, tanB);
    }
  }

  // flanges every 2.4 m along the run (lattice phase 1.8 m), never on the trimmed (elbow) ends
  const fR = r * 1.45, fT = 0.03;
  const joinA = endA.kind === 'straight', joinB = endB.kind === 'straight';
  latticeStops(p, len, dx, dy, dz, FLANGE_PHASE, joinA ? 0 : s0 + 0.1, joinB ? len : s1 - 0.1, stops);
  for (let k = 0; k < stops.length; k++) {
    const s = stops[k];
    collar(ax + dx * s, ay + dy * s, az + dz * s, dx, dy, dz, fR, fT);
    pipeStats.flanges++;
  }

  // hangers every 2.4 m on horizontal runs (lattice phase 0.6 m): clevis band + threaded rod + ceiling plate. A short
  // isolated pipe (two free ends) that misses the lattice gets one hanger at its middle. A hanger whose rod would
  // pass through another pipe (a z-run hung under a crossing x-run, a riser) slides along the run to the nearest
  // clear spot (as an installer would), or is left out if the run has none.
  if (Math.abs(dy) < 0.3) {
    const hLo = joinA ? 0 : Math.max(s0, 0.05), hHi = joinB ? len : Math.min(s1, len - 0.05);
    latticeStops(p, len, dx, dy, dz, HANGER_PHASE, hLo, hHi, stops);
    if (stops.length === 0 && endA.kind === 'free' && endB.kind === 'free' && len >= 0.4) stops.push(len / 2);
    for (let k = 0; k < stops.length; k++) {
      let s = stops[k];
      let hx = ax + dx * s, hy = ay + dy * s, hz = az + dz * s;
      let topY = hy + r + 0.006;
      // known context (tile build): hang only from a real ceiling (none over NO_CEIL / SOLID cells, nor beyond a
      // 6 m rod); unknown context (emitPipe without a neighbourhood): a short 25 cm rod
      let ceil = ceilAt ? ceilAt(hx, hz) : topY + 0.25;
      if (!Number.isFinite(ceil) || ceil - topY > 6 || ceil - topY < 0.02) continue;
      if (rodBlocked(p, neighbours, hx, hz, topY, ceil)) {
        let found = false;
        for (let t = 1; t <= 2 * HANGER_SLIDE_STEPS && !found; t++) {
          const s2 = s + (t & 1 ? 1 : -1) * Math.ceil(t / 2) * HANGER_SLIDE;
          if (s2 < hLo || s2 > hHi) continue;
          const x2 = ax + dx * s2, y2 = ay + dy * s2, z2 = az + dz * s2, top2 = y2 + r + 0.006;
          const c2 = ceilAt ? ceilAt(x2, z2) : top2 + 0.25;
          if (!Number.isFinite(c2) || c2 - top2 > 6 || c2 - top2 < 0.02) continue;
          if (rodBlocked(p, neighbours, x2, z2, top2, c2)) continue;
          s = s2; hx = x2; hy = y2; hz = z2; topY = top2; ceil = c2; found = true;
        }
        if (!found) { pipeStats.hangersBlocked++; continue; }
        pipeStats.hangersMoved++;
      }
      B.mat(Mat.METAL_PAINTED, 0.22, 0.22, 0.22, 0, 0.45);
      pipeStats.hangers++;
      // clevis band: an open 8-sided sleeve circumscribing the 10-sided tube (apothem r + 6 mm)
      B.push();
      B.translate(hx, hy, hz);
      B.alignY(dx, dy, dz);
      cylinder(B, BAND_R(r), BAND_R(r), -0.0125, 0.0125, 8, 0);
      B.pop();
      B.push();
      B.translate(hx, 0, hz);
      cylinder(B, 0.006, 0.006, topY - 0.004, ceil - 0.006, 3, 0, 0); // threaded rod
      cylinder(B, 0.024, 0.024, ceil - 0.006, ceil, 4, 1, 0); // ceiling plate
      B.pop();
      setPipeMaterial(p, decay);
    }
  }
  w.resetTransform();
  return B.tris;
}
