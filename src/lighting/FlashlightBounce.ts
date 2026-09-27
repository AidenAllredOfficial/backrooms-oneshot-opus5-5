// src/lighting/FlashlightBounce.ts — package F: one diffuse bounce of the flashlight from virtual point lights (VPLs)
// placed on the CPU (bgi-flashlight-bounce with the optics-aware flux of vfa). Pure (no three), allocation-free per
// frame after warm-up; uploaded as uniform arrays (no surface sampler).
//
// Per frame, while the torch is on: the beam is split into angular bins (4 on high: the core + 3 sectors of the
// rest; 8 on ultra: the core + 3 sectors to 16 deg + 4 spill sectors; medium casts the 4 rays and merges them into its
// single VPL). One ray per bin, along the bin's flux-weighted mean direction, finds the surface that bin lights
// (WorldQuery.raycast). The bin's flux (PEAK_CD x the integral of the rendered beam profile over the bin, lm) times
// the light colour, the hit's albedo, three's range window and the bake's multi-bounce gain is re-emitted by a
// Lambertian VPL just off the hit (C = flux / PI):
//
//   E(P, N) = sum_k C_k * max(N.l, 0) * (max(N_k.-l, 0) + iso_k) * window(d / RANGE) * box_k(P) / (d^2 + eps2_k)
//
// eps2_k is the squared radius of the patch the bin lights (d^2 * omega / cos(incidence), at least EPS2): the
// on-axis irradiance of a Lambertian disc of radius r is flux / (PI (d^2 + r^2)), so a far, wide patch spreads its
// light softly and a near, tight one stays point-like. box_k is the axis-aligned room around the hit found by a
// short flood fill through open edges (walls cut it within their thickness), so the fill does not leak through the
// walls of the lit room. Positions, normals and fluxes are smoothed exponentially (TAU) and snap on jumps > SNAP m
// and on frozen or hitched frames, so captures are deterministic and moving the torch does not flicker.

import { CELL, CHUNK_CELLS } from '../core/constants.ts';
import { cellToChunk, exIdx, ezIdx, worldToCell } from '../core/grid.ts';
import { CellFlag, EdgeKind } from '../core/ids.ts';
import type { RaycastHit, WorldQuery } from '../core/runtime.ts';
import { beamCentroid, beamFluxLm, FLASHLIGHT_OPTICS } from './flashlightOptics.ts';

export const BOUNCE = {
  /** m: VPL reach; the shader's window is (1 - (d / RANGE)^4)^2 */
  RANGE: 6,
  /** m^2: the smallest patch radius^2 (the singularity guard of a point VPL) */
  EPS2: 0.09,
  /** s: smoothing time constant of position, normal, flux and patch size */
  TAU: 0.08,
  /** m: a VPL that moves further than this in one frame snaps (the beam crossed a depth edge) */
  SNAP: 1.5,
  /** m: the VPL sits this far off the lit surface, along its normal */
  OFFSET: 0.05,
  /** floor for cos(incidence) in the patch size (grazing hits spread over a long ellipse) */
  PATCH_COS_MIN: 0.3,
  /** VPL slots in the uniform arrays */
  MAX: 8,
  /** room fill: steps from the lit cell (an OPEN edge costs 1, a doorway / arch / window OPENING_COST) */
  FILL_CELLS: 5,
  OPENING_COST: 3,
  /** m above the lit cell's floor where the fill tests the edges (below door headers, above half walls) */
  FILL_Y: 1.2,
  /** m: a SOLID neighbour's face lies ON the cell line: the room box reaches this far into it */
  SOLID_MARGIN: 0.05,
  /** frames a cached room fill stays valid (streaming can change the world under it) */
  FILL_TTL: 90,
  /** m: half-width of the room box's edge ramp in the shader (inside a wall's thickness) */
  BOX_SOFT: 0.035,
  /** later bounces, as the bake's multi-bounce: each channel's flux x 1 / (1 - min(MB_MAX, MB * albedo)) */
  MB: 0.55,
  MB_MAX: 0.6,
} as const;

/** Multi-bounce gain of a re-emitted channel of albedo a (the light keeps bouncing around the room). */
export const multiBounce = (a: number): number => 1 / (1 - Math.min(BOUNCE.MB_MAX, BOUNCE.MB * a));

/** One angular bin of the beam: its ray (polar theta from the axis, azimuth phi around it, rad), its luminous flux
 * (lm, as rendered: profile x three's spot attenuation) and its solid angle (sr). */
export interface VplBin { theta: number; phi: number; flux: number; omega: number }

const DEG = Math.PI / 180;
/** Ring edges (deg) of each supported VPL count; the outer edge is the cone. */
const RINGS: Readonly<Record<1 | 4 | 8, readonly (readonly [number, number, number])[]>> = {
  // [inner edge deg, sectors, first azimuth deg]
  1: [[0, 1, 0]],
  4: [[0, 1, 0], [6, 3, 90]],
  8: [[0, 4, 45], [16, 4, 45]],
};
/** How the rays of each quality value become VPL slots: the ray split, and the groups of rays merged into one slot
 * (null: one slot per ray). Ultra casts 8 rays (an inner and an outer sector per quadrant) and merges each quadrant's
 * pair: the per-pixel cost of 4 VPLs (a VPL costs ~0.07 ms at the 3840 x 2160 ultra buffer) with the energy placed
 * by 8 rays. Medium merges the 4 rays of the high split into its one VPL. */
const LAYOUT: Readonly<Record<1 | 4 | 8, { rays: 4 | 8; groups: readonly (readonly number[])[] | null }>> = {
  1: { rays: 4, groups: [[0, 1, 2, 3]] },
  4: { rays: 4, groups: null },
  8: { rays: 8, groups: [[0, 4], [1, 5], [2, 6], [3, 7]] },
};
/** VPL slots the shader evaluates for a quality value. */
export const bounceSlots = (n: number): number => {
  const c = bounceCount(n);
  return c === 0 ? 0 : LAYOUT[c].groups?.length ?? LAYOUT[c].rays;
};
const binCache = new Map<number, VplBin[]>();

/** Supported VPL count for a quality value (0, 1, 4 or 8). */
export const bounceCount = (n: number): 0 | 1 | 4 | 8 => (n >= 8 ? 8 : n >= 4 ? 4 : n >= 1 ? 1 : 0);

/** The angular bins of an n-VPL split. Their fluxes sum to the rendered flux of the whole cone. */
export function bounceBins(n: number): readonly VplBin[] {
  const m = bounceCount(n);
  if (m === 0) return [];
  const hit = binCache.get(m);
  if (hit) return hit;
  const rings = RINGS[m];
  const cone = FLASHLIGHT_OPTICS.CONE;
  const out: VplBin[] = [];
  for (let r = 0; r < rings.length; r++) {
    const t0 = rings[r][0] * DEG, t1 = r + 1 < rings.length ? rings[r + 1][0] * DEG : cone;
    const count = rings[r][1];
    const flux = beamFluxLm(t0, t1, 2000, true) / count;
    const omega = (2 * Math.PI * (Math.cos(t0) - Math.cos(t1))) / count;
    const theta = count === 1 && t0 === 0 ? 0 : beamCentroid(t0, t1);
    for (let j = 0; j < count; j++) out.push({ theta, phi: (rings[r][2] * DEG) + (2 * Math.PI * j) / count, flux, omega });
  }
  binCache.set(m, out);
  return out;
}

// ---------------------------------------------------------------- room fill

/** Cell facts through the public WorldQuery (layoutAt); null when the chunk is not loaded. */
function cellAt(world: WorldQuery, gi: number, gj: number, out: { flags: number; floor: number; ceil: number }): boolean {
  const cx = cellToChunk(gi), cz = cellToChunk(gj);
  const l = world.layoutAt(cx, cz);
  if (!l) return false;
  const c = (gj - cz * CHUNK_CELLS) * CHUNK_CELLS + (gi - cx * CHUNK_CELLS);
  out.flags = l.flags[c]; out.floor = l.floorCm[c] / 100; out.ceil = l.ceilCm[c] / 100;
  return true;
}
/** Kind of the edge on the x line `line` (between cells line-1 | line) of row gj, or of the z line of column gi. */
function edgeKind(world: WorldQuery, axisX: boolean, line: number, g: number): number {
  const gi = axisX ? line : g, gj = axisX ? g : line;
  // the chunk holding the cell on the + side of the line (its edge grid owns index 0 of that line)
  const cx = cellToChunk(gi), cz = cellToChunk(gj);
  const l = world.layoutAt(cx, cz);
  if (!l) return EdgeKind.WALL;
  return axisX ? l.ex.kind[exIdx(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS)] : l.ez.kind[ezIdx(gi - cx * CHUNK_CELLS, gj - cz * CHUNK_CELLS)];
}

const fillCost = new Map<number, number>();
const fillQueue: number[][] = Array.from({ length: BOUNCE.FILL_CELLS * BOUNCE.OPENING_COST + 1 }, () => []);
const fillA = { flags: 0, floor: 0, ceil: 0 };
const fillB = { flags: 0, floor: 0, ceil: 0 };
const cellKey = (gi: number, gj: number): number => (gi + 32768) * 65536 + (gj + 32768);
const DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];

/** Axis-aligned room around the cell containing (x, z): a flood fill of at most FILL_CELLS steps through edges that
 * are clear FILL_Y above the start cell's floor. Writes world (x0, z0, x1, z1): the reached cells' bounds, reaching
 * SOLID_MARGIN into SOLID neighbours (whose faces lie on the cell line). Returns false (and the cell's own bounds)
 * when the cell is not loaded. */
export function roomBox(world: WorldQuery, x: number, z: number, out: Float64Array): boolean {
  const gi0 = worldToCell(x), gj0 = worldToCell(z);
  out[0] = gi0 * CELL; out[1] = gj0 * CELL; out[2] = (gi0 + 1) * CELL; out[3] = (gj0 + 1) * CELL;
  if (!cellAt(world, gi0, gj0, fillA)) return false;
  const y = Math.max(fillA.floor + 0.1, Math.min(fillA.floor + BOUNCE.FILL_Y, fillA.ceil - 0.1));
  fillCost.clear();
  for (const b of fillQueue) b.length = 0;
  fillCost.set(cellKey(gi0, gj0), 0);
  fillQueue[0].push(gi0, gj0);
  for (let cost = 0; cost <= BOUNCE.FILL_CELLS; cost++) {
    const bucket = fillQueue[cost];
    for (let q = 0; q < bucket.length; q += 2) {
      const gi = bucket[q], gj = bucket[q + 1];
      if ((fillCost.get(cellKey(gi, gj)) ?? Infinity) < cost) continue; // reached cheaper since
      const ax = (gi + 0.5) * CELL, az = (gj + 0.5) * CELL;
      for (let dd = 0; dd < 4; dd++) {
        const ni = gi + DI[dd], nj = gj + DJ[dd];
        if (!cellAt(world, ni, nj, fillB)) continue;
        const axisX = DI[dd] !== 0;
        if (fillB.flags & CellFlag.SOLID) {
          // the SOLID mass's face is on the shared line: let the box reach just into it
          const m = BOUNCE.SOLID_MARGIN;
          if (dd === 0) out[2] = Math.max(out[2], ni * CELL + m);
          else if (dd === 1) out[0] = Math.min(out[0], gi * CELL - m);
          else if (dd === 2) out[3] = Math.max(out[3], nj * CELL + m);
          else out[1] = Math.min(out[1], gj * CELL - m);
          continue;
        }
        const line = axisX ? Math.max(gi, ni) : Math.max(gj, nj);
        const kind = edgeKind(world, axisX, line, axisX ? gj : gi);
        const nc = cost + (kind === EdgeKind.OPEN ? 1 : BOUNCE.OPENING_COST);
        if (nc > BOUNCE.FILL_CELLS) continue;
        const k = cellKey(ni, nj);
        if ((fillCost.get(k) ?? Infinity) <= nc) continue;
        if (!world.losClear(ax, y, az, (ni + 0.5) * CELL, y, (nj + 0.5) * CELL)) continue;
        fillCost.set(k, nc);
        fillQueue[nc].push(ni, nj);
        if (ni * CELL < out[0]) out[0] = ni * CELL;
        if (nj * CELL < out[1]) out[1] = nj * CELL;
        if ((ni + 1) * CELL > out[2]) out[2] = (ni + 1) * CELL;
        if ((nj + 1) * CELL > out[3]) out[3] = (nj + 1) * CELL;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------- VPL state

/** Minimal uniform vector (THREE.Vector4). */
export interface Vec4Like { set(x: number, y: number, z: number, w: number): unknown }
/** The MaterialGlobals the bounce writes. */
export interface BounceUniforms {
  fbOn: { value: number };
  fbP: { value: Vec4Like[] };
  fbN: { value: Vec4Like[] };
  fbC: { value: Vec4Like[] };
  fbBox: { value: Vec4Like[] };
}

/** One frame's torch state. Positions and directions are world (storey-relative y); the uniforms are written
 * relative to the eye (the camera position of the frame being rendered). */
export interface BounceInput {
  /** VPL count (quality x URL toggle x torch on); 0 = off */
  n: number;
  ox: number; oy: number; oz: number; // light position
  dx: number; dy: number; dz: number; // beam axis (normalised here)
  rx: number; ry: number; rz: number; // a vector across the beam (the camera's right): azimuth 0 reference
  cr: number; cg: number; cb: number; // linear light colour (THREE.Color of the SpotLight)
  eyeX: number; eyeY: number; eyeZ: number;
  dt: number;
}

export interface FlashlightBounce {
  update(inp: BounceInput, world: WorldQuery, u: BounceUniforms): void;
  /** active VPLs after the last update */
  readonly active: number;
  /** world state of slot k (tests / debug): [px, py, pz, nx, ny, nz, cr, cg, cb, eps2, x0, z0, x1, z1, on, iso] */
  slot(k: number): Float64Array;
  /** forget the smoothing history and the fill cache (teleports, storey switches, world reset) */
  reset(): void;
}

// per slot / target: 0-2 position, 3-5 normal (unit, or the shorter mean normal of a merged VPL), 6-8 C (rgb),
// 9 eps2, 10-13 room box (x0, z0, x1, z1), 14 on, 15 iso (isotropic emission share of a merged VPL)
const S_LEN = 16;
const S_ON = 14, S_ISO = 15;

/** Merges the valid targets tg[members] into slot `k` of out: one VPL at the flux-weighted mean of the hits whose
 * emission is the flux-weighted mean normal (length |m| <= 1) plus an isotropic share 0.25 (1 - |m|) (same total
 * flux: pi C), whose patch radius^2 spans the hits' spread plus their own, and whose room box is the union of theirs.
 * Returns false (slot off) if none is valid. */
export function mergeTargets(tg: Float64Array, members: readonly number[], out: Float64Array, k: number): boolean {
  let w = 0, px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, cr = 0, cg = 0, cb = 0;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const d = k * S_LEN;
  for (const i of members) {
    const o = i * S_LEN;
    if (tg[o + S_ON] === 0) continue;
    const wi = tg[o + 6] + tg[o + 7] + tg[o + 8] + 1e-9;
    w += wi;
    px += wi * tg[o]; py += wi * tg[o + 1]; pz += wi * tg[o + 2];
    nx += wi * tg[o + 3]; ny += wi * tg[o + 4]; nz += wi * tg[o + 5];
    cr += tg[o + 6]; cg += tg[o + 7]; cb += tg[o + 8];
    x0 = Math.min(x0, tg[o + 10]); z0 = Math.min(z0, tg[o + 11]); x1 = Math.max(x1, tg[o + 12]); z1 = Math.max(z1, tg[o + 13]);
  }
  if (w === 0) { out[d + S_ON] = 0; return false; }
  px /= w; py /= w; pz /= w; nx /= w; ny /= w; nz /= w;
  let e = 0;
  for (const i of members) {
    const o = i * S_LEN;
    if (tg[o + S_ON] === 0) continue;
    const wi = tg[o + 6] + tg[o + 7] + tg[o + 8] + 1e-9;
    e += wi * ((tg[o] - px) ** 2 + (tg[o + 1] - py) ** 2 + (tg[o + 2] - pz) ** 2 + tg[o + 9]);
  }
  const ml = Math.min(1, Math.hypot(nx, ny, nz));
  out[d] = px; out[d + 1] = py; out[d + 2] = pz; out[d + 3] = nx; out[d + 4] = ny; out[d + 5] = nz;
  out[d + 6] = cr; out[d + 7] = cg; out[d + 8] = cb;
  out[d + 9] = Math.max(BOUNCE.EPS2, e / w);
  out[d + 10] = x0; out[d + 11] = z0; out[d + 12] = x1; out[d + 13] = z1;
  out[d + S_ON] = 1; out[d + S_ISO] = 0.25 * (1 - ml);
  return true;
}

export function createFlashlightBounce(): FlashlightBounce {
  const B = BOUNCE;
  const st = new Float64Array(B.MAX * S_LEN); // the smoothed slots
  const tg = new Float64Array(B.MAX * S_LEN); // this frame's targets (one per ray)
  const mg = new Float64Array(B.MAX * S_LEN); // merged targets (one per slot)
  const hit: RaycastHit = { t: 0, nx: 0, ny: 0, nz: 0, r: 0, g: 0, b: 0 };
  const fills = new Map<number, { frame: number; box: Float64Array }>();
  let frame = 0;
  let wasOn = false;
  let active = 0;
  let storey = -1;

  const fillOf = (world: WorldQuery, x: number, z: number): Float64Array => {
    const key = cellKey(worldToCell(x), worldToCell(z));
    const f = fills.get(key);
    if (f && frame - f.frame <= B.FILL_TTL) return f.box;
    if (fills.size > 128) fills.clear();
    const b = f ? f.box : new Float64Array(4);
    roomBox(world, x, z, b);
    fills.set(key, { frame, box: b });
    return b;
  };

  const api: FlashlightBounce = {
    get active() { return active; },
    slot(k) { return st.subarray(k * S_LEN, (k + 1) * S_LEN); },
    reset() { st.fill(0); fills.clear(); wasOn = false; active = 0; },
    update(inp, world, u) {
      frame++;
      if (world.storey !== storey) { storey = world.storey; fills.clear(); wasOn = false; }
      const count = inp.n > 0 && world.raycast ? bounceCount(inp.n) : 0;
      // medium's one VPL merges the 4 rays of the high split, so its light lands where the beam's flux does (mostly
      // the near spill) instead of wherever the axis happens to hit; ultra merges its 8 rays pairwise (LAYOUT)
      const layout = count === 0 ? null : LAYOUT[count];
      const bins = layout ? bounceBins(layout.rays) : [];
      const m = bins.length;
      active = 0;
      if (m === 0) {
        for (let k = 0; k < B.MAX; k++) { st[k * S_LEN + S_ON] = 0; u.fbP.value[k].set(0, 0, 0, 0); }
        u.fbOn.value = 0;
        wasOn = false;
        return;
      }
      // beam frame: axis d, right r (orthogonalised), up = r x d
      let dx = inp.dx, dy = inp.dy, dz = inp.dz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      let rx = inp.rx, ry = inp.ry, rz = inp.rz;
      const rd = rx * dx + ry * dy + rz * dz;
      rx -= rd * dx; ry -= rd * dy; rz -= rd * dz;
      let rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-6) { rx = -dz; ry = 0; rz = dx; rl = Math.hypot(rx, rz) || 1; } // looking straight up / down
      rx /= rl; ry /= rl; rz /= rl;
      const ux = ry * dz - rz * dy, uy = rz * dx - rx * dz, uz = rx * dy - ry * dx;
      const snap = !(inp.dt > 0) || inp.dt > 0.25 || !wasOn;
      const a = snap ? 1 : 1 - Math.exp(-inp.dt / B.TAU);
      const R = FLASHLIGHT_OPTICS.RANGE;
      // 1. this frame's targets: one ray per bin
      for (let k = 0; k < m; k++) {
        const o = k * S_LEN;
        const bin = bins[k];
        const ct = Math.cos(bin.theta), stt = Math.sin(bin.theta);
        const cp = Math.cos(bin.phi) * stt, sp = Math.sin(bin.phi) * stt;
        const vx = dx * ct + ux * sp + rx * cp;
        const vy = dy * ct + uy * sp + ry * cp;
        const vz = dz * ct + uz * sp + rz * cp;
        tg[o + S_ON] = 0;
        if (!world.raycast!(inp.ox, inp.oy, inp.oz, vx, vy, vz, R, hit)) continue;
        const q = hit.t / R;
        const w1 = Math.max(0, 1 - q * q * q * q);
        const f = (bin.flux * w1 * w1) / Math.PI; // C = flux / PI (lm / sr per unit cosine)
        tg[o] = inp.ox + vx * hit.t + hit.nx * B.OFFSET;
        tg[o + 1] = inp.oy + vy * hit.t + hit.ny * B.OFFSET;
        tg[o + 2] = inp.oz + vz * hit.t + hit.nz * B.OFFSET;
        tg[o + 3] = hit.nx; tg[o + 4] = hit.ny; tg[o + 5] = hit.nz;
        tg[o + 6] = f * inp.cr * hit.r * multiBounce(hit.r);
        tg[o + 7] = f * inp.cg * hit.g * multiBounce(hit.g);
        tg[o + 8] = f * inp.cb * hit.b * multiBounce(hit.b);
        const ci = Math.max(B.PATCH_COS_MIN, Math.abs(vx * hit.nx + vy * hit.ny + vz * hit.nz));
        tg[o + 9] = Math.max(B.EPS2, (hit.t * hit.t * bin.omega) / (Math.PI * ci));
        const rb = fillOf(world, tg[o] + hit.nx * 0.05, tg[o + 2] + hit.nz * 0.05);
        tg[o + 10] = rb[0]; tg[o + 11] = rb[1]; tg[o + 12] = rb[2]; tg[o + 13] = rb[3];
        tg[o + S_ON] = 1; tg[o + S_ISO] = 0;
      }
      const groups = layout ? layout.groups : null;
      const slots = groups ? groups.length : m;
      let src = tg;
      if (groups) {
        for (let k = 0; k < groups.length; k++) mergeTargets(tg, groups[k], mg, k);
        src = mg;
      }
      // 2. the slots follow their targets (exponential smoothing; snaps on jumps and frozen frames)
      for (let k = 0; k < B.MAX; k++) {
        const o = k * S_LEN;
        if (k >= slots) { st[o + S_ON] = 0; continue; }
        if (src[o + S_ON] !== 0) {
          const jump = Math.hypot(src[o] - st[o], src[o + 1] - st[o + 1], src[o + 2] - st[o + 2]) > B.SNAP;
          const ka = snap || jump || st[o + S_ON] === 0 ? 1 : a;
          for (let i = 0; i < 3; i++) st[o + i] += (src[o + i] - st[o + i]) * ka;
          // the normal turns toward the target and keeps the target's length (1, or a merged VPL's |m|)
          let nx = st[o + 3] + (src[o + 3] - st[o + 3]) * ka;
          let ny = st[o + 4] + (src[o + 4] - st[o + 4]) * ka;
          let nz = st[o + 5] + (src[o + 5] - st[o + 5]) * ka;
          const nl = Math.hypot(nx, ny, nz), tl = Math.hypot(src[o + 3], src[o + 4], src[o + 5]);
          if (nl > 1e-6) { nx *= tl / nl; ny *= tl / nl; nz *= tl / nl; } else { nx = src[o + 3]; ny = src[o + 4]; nz = src[o + 5]; }
          st[o + 3] = nx; st[o + 4] = ny; st[o + 5] = nz;
          for (let i = 6; i < 10; i++) st[o + i] += (src[o + i] - st[o + i]) * ka;
          for (let i = 10; i < 14; i++) st[o + i] = src[o + i];
          st[o + S_ISO] += (src[o + S_ISO] - st[o + S_ISO]) * ka;
          st[o + S_ON] = 1;
        } else if (st[o + S_ON] !== 0) {
          // nothing lit by this bin (open space beyond the range): fade the old patch out
          const kf = snap ? 0 : 1 - a;
          st[o + 6] *= kf; st[o + 7] *= kf; st[o + 8] *= kf;
          if (Math.max(st[o + 6], st[o + 7], st[o + 8]) < 1e-3) st[o + S_ON] = 0;
        }
      }
      for (let k = 0; k < B.MAX; k++) {
        const o = k * S_LEN;
        const on = st[o + S_ON] !== 0;
        if (on) active++;
        u.fbP.value[k].set(st[o] - inp.eyeX, st[o + 1] - inp.eyeY, st[o + 2] - inp.eyeZ, on ? 1 : 0);
        u.fbN.value[k].set(st[o + 3], st[o + 4], st[o + 5], st[o + S_ISO]);
        u.fbC.value[k].set(st[o + 6], st[o + 7], st[o + 8], st[o + 9]);
        u.fbBox.value[k].set(st[o + 10] - inp.eyeX, st[o + 11] - inp.eyeZ, st[o + 12] - inp.eyeX, st[o + 13] - inp.eyeZ);
      }
      u.fbOn.value = active > 0 ? 1 : 0;
      wasOn = true;
    },
  };
  return api;
}
