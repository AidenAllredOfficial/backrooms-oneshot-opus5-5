// src/materials/water/rippleSources.ts — package E: the pure half of the ripple simulation (WaterRipples.ts): the
// world-anchored window, the fixed-step constants, the impulses (footsteps, wading wakes, idle sway, drips), the
// per-window cell mask (water on the simulated plane + wall bits) and the nearest-water-plane scan (also used by
// the app loop for the planar reflection). No three.js: everything here is unit-tested.

import { CELL } from '../../core/constants.ts';
import { edgeOccludesAt } from '../../core/edges.ts';
import { cellIdx, chunkOriginX, chunkOriginZ, exIdx, ezIdx, worldToChunk } from '../../core/grid.ts';
import { CellFlag, EmitterKind } from '../../core/ids.ts';
import { NO_WATER, type ChunkLayout } from '../../core/layout.ts';

/** Ripple simulation tuning. Index = WaterRect kind (0 pool, 1 flooded room, 2 film). */
export const RIPPLE = {
  DT: 1 / 60, // s, fixed simulation step
  MAX_STEPS: 4, // per frame (dt spikes are dropped)
  C: 0.55, // m/s, wave speed (capillary-gravity ripples of ~20 cm)
  TAU: [2.5, 1.2, 0.8], // s, amplitude damping per kind
  FOAM_TAU: 3, // s
  MASK_W: 16, // cells per side of the mask texture (window span / CELL + 2 <= 16)
  NEAR_M: 6, // m, the simulated plane must come this close to the eye (xz)
  SCAN_FRAMES: 6,
  // impulses: amplitude (m of height) and gaussian radius (m); a foot entering the water displaces ~0.3 l
  FOOT_A: 0.012, FOOT_R: 0.1,
  FOOT_OFFSET: 0.11, // m, a foot's lateral offset from the body centre
  WAKE_A: 0.0015, WAKE_R: 0.07, WAKE_MIN_SPEED: 0.2, WAKE_MIN_DEPTH: 0.05,
  WAKE_FOAM: [0.15, 0.3, 0.2],
  SWAY_A: 0.0006, SWAY_PERIOD: 1.3, // s
  DRIP_A: 0.004, DRIP_R: 0.025,
  DRIP_PERIOD: [1.2, 4], // s, hashed per source
  DRIP_RANGE: 25, // m
  DRIP_FRAMES: 30,
  MAX_IMPULSES: 16,
  MAX_FOAM: 8,
  MAX_DRIPS: 8,
} as const;

export interface Impulse { x: number; z: number; a: number; r: number } // world x/z (m), amplitude (m), radius (m)

/** (c dt / dx)^2 of the discrete wave equation for a texel size (must stay <= 0.5 in 2D: CFL). */
export const courant2 = (texel: number): number => {
  const c = (RIPPLE.C * RIPPLE.DT) / texel;
  return c * c;
};
/** per-step amplitude factor for a damping time */
export const dampOf = (tau: number): number => Math.exp(-RIPPLE.DT / tau);

// ---------------------------------------------------------------- window

export interface RippleWindow { i0: number; j0: number; originX: number; originZ: number; span: number }

/** The window of n texels of `texel` m centred on the eye, snapped to whole texels (world anchored: a texel keeps its
 * world position while the window moves, so the waves never swim). */
export function rippleWindow(n: number, texel: number, eyeX: number, eyeZ: number, out: RippleWindow): RippleWindow {
  const span = n * texel;
  out.i0 = Math.floor((eyeX - span / 2) / texel);
  out.j0 = Math.floor((eyeZ - span / 2) / texel);
  out.originX = out.i0 * texel;
  out.originZ = out.j0 * texel;
  out.span = span;
  return out;
}

/** First global cell index covered by a window starting at texel index i0 (mask cell origin). */
export const maskCell0 = (i0: number, texel: number): number => Math.floor((i0 * texel) / CELL + 1e-9);

// ---------------------------------------------------------------- impulses

/** Lateral offset (world x, z) of foot 0 (left) / 1 (right) for a body yaw (camera convention: forward = -sin, -cos). */
export function footOffset(yaw: number, foot: 0 | 1): [number, number] {
  const s = foot === 0 ? -RIPPLE.FOOT_OFFSET : RIPPLE.FOOT_OFFSET;
  return [Math.cos(yaw) * s, -Math.sin(yaw) * s];
}

/** Rings of a footstep in water (none when dry): A = FOOT_A intensity clamp(depth / 0.3, 0.3, 1). */
export function footstepImpulse(x: number, z: number, yaw: number, foot: 0 | 1, intensity: number, waterDepth: number): Impulse | null {
  if (!(waterDepth > 0.02)) return null;
  const [ox, oz] = footOffset(yaw, foot);
  const a = RIPPLE.FOOT_A * Math.max(0, intensity) * Math.min(Math.max(waterDepth / 0.3, 0.3), 1);
  return { x: x + ox, z: z + oz, a, r: RIPPLE.FOOT_R };
}

/** Wake of both legs for one simulation step while wading (velocity vx, vz m/s, depth m), appended to `out`: per
 * leg a bow wave ahead and a trough behind (a dipole: the legs push water aside, they add none), so a V-wake trails
 * the player without a mound building up around the legs. Returns the number added (0 when too slow / shallow). */
export function wakeImpulses(x: number, z: number, yaw: number, vx: number, vz: number, depth: number, out: Impulse[]): number {
  const speed = Math.hypot(vx, vz);
  if (speed <= RIPPLE.WAKE_MIN_SPEED || depth <= RIPPLE.WAKE_MIN_DEPTH) return 0;
  const a = (RIPPLE.WAKE_A * speed * Math.min(depth, 0.5)) / 0.5;
  const dx = (vx / speed) * RIPPLE.WAKE_R, dz = (vz / speed) * RIPPLE.WAKE_R;
  for (const foot of [0, 1] as const) {
    const [ox, oz] = footOffset(yaw, foot);
    out.push({ x: x + ox + dx, z: z + oz + dz, a, r: RIPPLE.WAKE_R });
    out.push({ x: x + ox - dx, z: z + oz - dz, a: -a, r: RIPPLE.WAKE_R });
  }
  return 4;
}

/** Idle sway while standing in water: true when a sway pulse falls in (t0, t1]. */
export const swayDue = (t0: number, t1: number): boolean => Math.floor(t1 / RIPPLE.SWAY_PERIOD) > Math.floor(t0 / RIPPLE.SWAY_PERIOD);

// ---------------------------------------------------------------- drips

export interface DripSource { x: number; z: number; y: number; period: number; phase: number; seed: number }

const hash01 = (seed: number, salt: number): number => {
  let h = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Drop period (s) and phase (s) of a drip source (deterministic in its seed). */
export function dripTiming(seed: number): { period: number; phase: number } {
  const [p0, p1] = RIPPLE.DRIP_PERIOD;
  const period = p0 + (p1 - p0) * hash01(seed, 1);
  return { period, phase: period * hash01(seed, 2) };
}
/** Number of drops of a source falling in (t0, t1] (drops at t with (t + phase) mod period = 0). */
export const dropsBetween = (t0: number, t1: number, period: number, phase: number): number =>
  t1 > t0 ? Math.floor((t1 + phase) / period) - Math.floor((t0 + phase) / period) : 0;

/** Water surface (m) of the cell under world (x, z), or null (dry, SOLID, not loaded). */
export function waterAtCell(world: RippleWorld, x: number, z: number): number | null {
  const cx = worldToChunk(x), cz = worldToChunk(z);
  const l = world.layoutAt(cx, cz);
  if (!l) return null;
  const li = Math.min(31, Math.max(0, Math.floor((x - chunkOriginX(cx)) / CELL))), lj = Math.min(31, Math.max(0, Math.floor((z - chunkOriginZ(cz)) / CELL)));
  const c = cellIdx(li, lj);
  if (l.waterCm[c] === NO_WATER || (l.flags[c] & CellFlag.SOLID) !== 0) return null;
  return l.waterCm[c] / 100;
}

/** DRIP emitters within `range` m of (x, z) that fall into water, nearest first, at most `max` (out is cleared). */
export function collectDrips(world: RippleWorld, x: number, z: number, range: number, max: number, out: DripSource[]): number {
  out.length = 0;
  const cx0 = worldToChunk(x), cz0 = worldToChunk(z);
  const cand: { d: number; s: DripSource }[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = world.layoutAt(cx0 + dx, cz0 + dz);
      if (!l) continue;
      const ox = chunkOriginX(cx0 + dx), oz = chunkOriginZ(cz0 + dz);
      for (const e of l.emitters) {
        if (e.kind !== EmitterKind.DRIP) continue;
        const wx = ox + e.x, wz = oz + e.z;
        const d = Math.hypot(wx - x, wz - z);
        if (d > range) continue;
        const wy = waterAtCell(world, wx, wz);
        if (wy === null) continue;
        const { period, phase } = dripTiming(e.seed);
        cand.push({ d, s: { x: wx, z: wz, y: wy, period, phase, seed: e.seed } });
      }
    }
  }
  cand.sort((a, b) => a.d - b.d || a.s.seed - b.s.seed);
  for (let i = 0; i < cand.length && out.length < max; i++) out.push(cand[i].s);
  return out.length;
}

// ---------------------------------------------------------------- world scans

/** The layouts the ripple code reads (WorldQuery.layoutAt). */
export interface RippleWorld { layoutAt(cx: number, cz: number): ChunkLayout | null }

export interface WaterPlane { y: number; kind: number; dist: number }

/**
 * Nearest water plane below the eye (at most 8 m below, within maxDist of it, not behind the camera) over the 3x3
 * chunks around the eye: WaterRect y, kind and distance, or null. The app loop uses it (40 m) for the planar
 * reflection, the ripple window (6 m) for the simulated plane.
 */
export function nearestWaterPlane(world: RippleWorld, ex: number, ey: number, ez: number, fx: number, fz: number, maxDist: number): WaterPlane | null {
  const pcx = worldToChunk(ex), pcz = worldToChunk(ez);
  let best: WaterPlane | null = null;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const l = world.layoutAt(pcx + dx, pcz + dz);
      if (!l || l.water.length === 0) continue;
      const ox = chunkOriginX(pcx + dx), oz = chunkOriginZ(pcz + dz);
      for (let i = 0; i < l.water.length; i++) {
        const w = l.water[i];
        if (w.y >= ey - 0.05 || w.y < ey - 8) continue; // must be below the eye, and near
        // closest point of the rect to the eye (xz)
        const cx = Math.min(Math.max(ex, ox + Math.min(w.x0, w.x1)), ox + Math.max(w.x0, w.x1));
        const cz = Math.min(Math.max(ez, oz + Math.min(w.z0, w.z1)), oz + Math.max(w.z0, w.z1));
        const ddx = cx - ex, ddz = cz - ez;
        const d = Math.sqrt(ddx * ddx + ddz * ddz + (ey - w.y) * (ey - w.y));
        if (d > maxDist || (best && d >= best.dist)) continue;
        const h = Math.sqrt(ddx * ddx + ddz * ddz);
        if (h > 2 && (ddx * fx + ddz * fz) / h < -0.35) continue; // behind the camera
        best = { y: w.y, kind: w.kind, dist: d };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- cell mask

const layoutOfCell = (world: RippleWorld, gi: number, gj: number): { l: ChunkLayout | null; li: number; lj: number } => {
  const cx = Math.floor(gi / 32), cz = Math.floor(gj / 32);
  return { l: world.layoutAt(cx, cz), li: gi - cx * 32, lj: gj - cz * 32 };
};

/**
 * The window's cell mask (W x W RGBA8, global cells ci0.. / cj0..): r = 255 where the cell's water surface is the
 * simulated plane (+- 2 cm), it is not SOLID, has no blocker and is not mostly covered by a box solid through the
 * plane; g = wall bits N1 E2 S4 W8 of the cell sides that occlude at plane + 5 cm (bake/volume.ts bakeWallMask's
 * rule). The simulation reflects waves (Neumann) at walls and dry cells. Returns the number of water cells.
 */
export function buildRippleMask(world: RippleWorld, ci0: number, cj0: number, W: number, plane: number, out: Uint8Array): number {
  out.fill(0);
  const planeCm = Math.round(plane * 100);
  const y = plane + 0.05;
  let n = 0;
  const floorOf = (gi: number, gj: number): number => {
    const { l, li, lj } = layoutOfCell(world, gi, gj);
    return l ? l.floorCm[cellIdx(li, lj)] / 100 : -Infinity;
  };
  for (let cj = 0; cj < W; cj++) {
    for (let ci = 0; ci < W; ci++) {
      const gi = ci0 + ci, gj = cj0 + cj;
      const { l, li, lj } = layoutOfCell(world, gi, gj);
      if (!l) continue;
      const c = cellIdx(li, lj);
      const w = l.waterCm[c];
      if (w === NO_WATER || Math.abs(w - planeCm) > 2 || (l.flags[c] & CellFlag.SOLID) !== 0 || l.blockCm[c] !== 0) continue;
      if (boxCovered(l, li, lj, plane)) continue;
      const f0 = l.floorCm[c] / 100;
      let bits = 0;
      const e = l.ez, x = l.ex;
      const occ = (g: typeof e, idx: number, sill: number): boolean => edgeOccludesAt(g.kind[idx], g.hA[idx], g.hB[idx], CELL / 2, y, sill);
      if (occ(e, ezIdx(li, lj), Math.max(f0, floorOf(gi, gj - 1)))) bits |= 1;
      if (occ(x, exIdx(li + 1, lj), Math.max(f0, floorOf(gi + 1, gj)))) bits |= 2;
      if (occ(e, ezIdx(li, lj + 1), Math.max(f0, floorOf(gi, gj + 1)))) bits |= 4;
      if (occ(x, exIdx(li, lj), Math.max(f0, floorOf(gi - 1, gj)))) bits |= 8;
      const o = (cj * W + ci) * 4;
      out[o] = 255;
      out[o + 1] = bits;
      n++;
    }
  }
  return n;
}

/** More than half of cell (li, lj) covered by a box solid that spans height y (pillars standing in a pool). */
function boxCovered(l: ChunkLayout, li: number, lj: number, y: number): boolean {
  const x0 = li * CELL, z0 = lj * CELL;
  let area = 0;
  for (const s of l.solids) {
    if (s.kind !== 'box' || s.min[1] > y || s.max[1] < y) continue;
    const ox = Math.min(s.max[0], x0 + CELL) - Math.max(s.min[0], x0);
    const oz = Math.min(s.max[2], z0 + CELL) - Math.max(s.min[2], z0);
    if (ox > 0 && oz > 0) area += ox * oz;
  }
  return area > 0.5 * CELL * CELL;
}
