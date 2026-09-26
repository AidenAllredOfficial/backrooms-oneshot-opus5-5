// src/bake/lights.ts — the tile's light set (WP7 §Algorithms 3). Pure module.
//
// All fixtures of the 9 layouts after expandPeriodicFixtures (tower groups extended by PERIODIC_EXTRA_K periods).
// Each light's window R is computed from ITS OWN chunk only, so every tile sees the same light definition:
//   R = min(R_MAX, max(ZONE_INFO[zone].lightR, LANDMARK_LIGHT_R[landmark] ?? 0, mountHeightAboveFloor + MOUNT_R_EXTRA))
// tower lights 4.5 m, dynamic lights R_DYN. The window distance is the horizontal distance plus the vertical
// excess beyond the light's mount height (windowDist2 in util.ts): a fixture mounted h metres above its floor
// reaches that whole floor with the horizontal window, which is what the tall-light acceptance requires
// (a 12 m ATRIUM panel would otherwise already be attenuated to 76% directly below). Tower lights use the plain
// 3D distance (hAllow = 0) so their periodic replica set has finite support in y.
// OFF lights emit nothing and are dropped. Static: ON/BUZZ x1, DYING x DYING_MEAN with the colour lerped 20%
// toward (1, 0.8, 0.85); a FLICKER/ANOMALY light that is not dynamic (impossible after WP4) bakes statically at
// flickerMean and is counted in `nonDynamicFlicker`. Dynamic lights bake at intensity 1 into their channel.

import { CELL, CHUNK_CELLS, LIGHT } from '../core/constants.ts';
import { flickerMean } from '../core/flicker.ts';
import { cellIdx, clamp, tileChannel, tileOfPoint, worldToCell, type TileKey } from '../core/grid.ts';
import { DYING_MEAN, FixtureKind, LandmarkKind, LightState, StructureKind } from '../core/ids.ts';
import { fixtureRadiance, type ChunkLayout, type Fixture } from '../core/layout.ts';
import { hash4, SALT } from '../core/rng.ts';
import { LANDMARK_LIGHT_R, ZONE_INFO } from '../core/zones.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { expandPeriodicFixtures } from '../mesh/periodic.ts';
import { EMIT_OFF, HALO, HALO_OFF, INV_CELL, luma, quant } from './util.ts';
import { PERIODIC_EXTRA_K, slotDcx, slotDcz } from './visgrid.ts';

export const SHAPE_RECT = 0, SHAPE_SPHERE = 1, SHAPE_DISK = 2;
export const TOWER_LIGHT_R = 4.5;
/** Receivers beyond the tile that need direct light (patches hit by probe rays): tile rect + this margin (m). */
export const PATCH_MARGIN = 12;
/** Light buckets: blocks of BLOCK x BLOCK halo cells. */
export const BLOCK = 4;
export const NBLOCK = HALO / BLOCK;

export interface LightSet {
  n: number;
  fixtures: Fixture[]; // originals (own-chunk coordinates)
  slot: Uint8Array; // own layout slot 0..8
  key: string[]; // world-stable key "cx,cz,index"
  uid: Uint32Array; // world-stable tie-break id
  group: Int32Array;
  dynamic: Uint8Array;
  channel: Int8Array; // flicker channel (dynamic lights), -1 otherwise
  shape: Uint8Array;
  /** 1 = prismatic-lens emitter (troffers: I ~ cos^LENS_N, areaLight.ts), 0 = Lambertian */
  lens: Uint8Array;
  pos: Float64Array; // 3/light: x z halo units, y m (emitter centre)
  vis: Float64Array; // 3/light: visibility end point (centre offset EMIT_OFF along the emitting normal)
  nrm: Float64Array; tan: Float64Array; bit: Float64Array; // 3/light unit vectors (world)
  w: Float64Array; h: Float64Array; // emitter extents (m); SPHERE/DISK: w = diameter
  rad: Float64Array; // 3/light: RGB radiance (nits, RECT) or intensity (cd, SPHERE/DISK), state applied
  radLum: Float64Array;
  imax: Float64Array; // luminance intensity along the axis: RECT L*A, SPHERE/DISK I
  R: Float64Array; invR2: Float64Array; hAllow: Float64Array;
  size: Float64Array; // max(w, h)
  reachTile: Uint8Array;
  /** 1 = periodic tower light (one of the y + 3k replicas of a tower-group fixture) */
  tower: Uint8Array;
  nonDynamicFlicker: number;
  /** light indices per block (lights whose window disc intersects the block) */
  blockStart: Int32Array;
  blockList: Int32Array;
}

function lightCellFloor(l: ChunkLayout, px: number, pz: number): number {
  const li = clamp(worldToCell(px), 0, CHUNK_CELLS - 1), lj = clamp(worldToCell(pz), 0, CHUNK_CELLS - 1);
  return l.floorCm[cellIdx(li, lj)] / 100;
}

function isTowerGroup(l: ChunkLayout, g: number): boolean {
  if (g === 0) return false;
  for (const s of l.structures) if (s.kind === StructureKind.TOWER && s.bakeGroup === g) return true;
  return false;
}

function landmarkR(l: ChunkLayout, px: number, pz: number): number {
  const li = worldToCell(px), lj = worldToCell(pz);
  let r = 0;
  for (const lm of l.landmarks) {
    if (li >= lm.i0 && li < lm.i1 && lj >= lm.j0 && lj < lm.j1) r = Math.max(r, LANDMARK_LIGHT_R[lm.kind] ?? 0);
  }
  return r;
}

/** Window radius of a fixture from its own layout (exported for tests). */
export function fixtureWindowR(l: ChunkLayout, f: Fixture): number {
  if (f.dynamic) return LIGHT.R_DYN;
  if (isTowerGroup(l, f.bakeGroup)) return TOWER_LIGHT_R;
  const mount = f.py - lightCellFloor(l, f.px, f.pz);
  const zr = ZONE_INFO[l.zone]?.lightR ?? LIGHT.R_STATIC;
  return Math.min(LIGHT.R_MAX, Math.max(zr, landmarkR(l, f.px, f.pz), mount + LIGHT.MOUNT_R_EXTRA));
}

export function gatherLights(nb: LayoutNeighborhood, tile: TileKey, hl0: number, hm0: number): LightSet {
  const fixtures: Fixture[] = [], slots: number[] = [], keys: string[] = [], uids: number[] = [];
  const Rs: number[] = [], hA: number[] = [], px: number[] = [], pz: number[] = [], towers: number[] = [];
  let nonDyn = 0;
  // zone rect in halo cells (tile +- PATCH_MARGIN)
  const m = PATCH_MARGIN * INV_CELL;
  const zx0 = HALO_OFF - m, zx1 = HALO_OFF + 16 + m;
  for (let slot = 0; slot < 9; slot++) {
    const dcx = slotDcx(slot), dcz = slotDcz(slot);
    const l = nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1);
    const ex = expandPeriodicFixtures(l, PERIODIC_EXTRA_K);
    const offX = dcx * CHUNK_CELLS - hl0, offZ = dcz * CHUNK_CELLS - hm0;
    const ocx = tile.cx + dcx, ocz = tile.cz + dcz;
    for (let k = 0; k < ex.length; k++) {
      const f = ex[k];
      if (f.state === LightState.OFF || !(f.luminance > 0)) continue;
      const x = offX + quant(f.px * INV_CELL), z = offZ + quant(f.pz * INV_CELL);
      const R = fixtureWindowR(l, f);
      // horizontal distance (m) from the light to the zone rect
      const ddx = x < zx0 ? zx0 - x : x > zx1 ? x - zx1 : 0;
      const ddz = z < zx0 ? zx0 - z : z > zx1 ? z - zx1 : 0;
      if ((ddx * ddx + ddz * ddz) * CELL * CELL >= R * R) continue;
      if (x < 0 || z < 0 || x >= HALO || z >= HALO) continue; // outside the VisGrid (cannot happen within R_MAX)
      if (!f.dynamic && (f.state === LightState.FLICKER || f.state === LightState.ANOMALY)) nonDyn++;
      // uid: stable tie-break and sample-rotation seed. The replicas of a periodic tower light share it (they share
      // the fixture id), so a texel and its copy one period up see identical sampling patterns.
      const towerLight = isTowerGroup(l, f.bakeGroup);
      fixtures.push(f); slots.push(slot); keys.push(`${ocx},${ocz},${k}`);
      uids.push(towerLight ? hash4(ocx, ocz, f.id | 0, SALT.BAKE ^ 0x70e7) : hash4(ocx, ocz, k, SALT.BAKE));
      Rs.push(R);
      hA.push(towerLight ? 0 : Math.max(0, f.py - lightCellFloor(l, f.px, f.pz)) + 0.05);
      towers.push(towerLight ? 1 : 0);
      px.push(x); pz.push(z);
    }
  }
  const n = fixtures.length;
  const L: LightSet = {
    n, fixtures, slot: Uint8Array.from(slots), key: keys, uid: Uint32Array.from(uids),
    group: new Int32Array(n), dynamic: new Uint8Array(n), channel: new Int8Array(n), shape: new Uint8Array(n), lens: new Uint8Array(n),
    pos: new Float64Array(3 * n), vis: new Float64Array(3 * n), nrm: new Float64Array(3 * n), tan: new Float64Array(3 * n), bit: new Float64Array(3 * n),
    w: new Float64Array(n), h: new Float64Array(n), rad: new Float64Array(3 * n), radLum: new Float64Array(n), imax: new Float64Array(n),
    R: Float64Array.from(Rs), invR2: new Float64Array(n), hAllow: Float64Array.from(hA), size: new Float64Array(n),
    reachTile: new Uint8Array(n), tower: Uint8Array.from(towers), nonDynamicFlicker: nonDyn,
    blockStart: new Int32Array(NBLOCK * NBLOCK + 1), blockList: new Int32Array(0),
  };
  const apron = 0.1 * INV_CELL;
  for (let i = 0; i < n; i++) {
    const f = fixtures[i];
    L.group[i] = f.bakeGroup;
    L.dynamic[i] = f.dynamic ? 1 : 0;
    L.channel[i] = -1;
    if (f.dynamic) {
      const dcx = slotDcx(slots[i]), dcz = slotDcz(slots[i]);
      L.channel[i] = tileChannel({ s: tile.s, cx: tile.cx + dcx, cz: tile.cz + dcz, q: tileOfPoint(f.px, f.pz) });
    }
    const shape = f.shape === 0 ? SHAPE_RECT : f.kind === FixtureKind.HIGHBAY ? SHAPE_DISK : SHAPE_SPHERE;
    L.shape[i] = shape;
    L.lens[i] = shape === SHAPE_RECT && (f.kind === FixtureKind.TROFFER_2x4 || f.kind === FixtureKind.TROFFER_2x2) ? 1 : 0;
    // frame
    let nx = f.nx, ny = f.ny, nz = f.nz;
    let ln = Math.hypot(nx, ny, nz);
    if (!(ln > 1e-9)) { nx = 0; ny = -1; nz = 0; ln = 1; }
    nx /= ln; ny /= ln; nz /= ln;
    let tx = f.tx, ty = f.ty, tz = f.tz;
    const td = tx * nx + ty * ny + tz * nz; // orthogonalize
    tx -= td * nx; ty -= td * ny; tz -= td * nz;
    let tl = Math.hypot(tx, ty, tz);
    if (!(tl > 1e-9)) { // any perpendicular
      if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = -nz; ty = 0; tz = nx; }
      tl = Math.hypot(tx, ty, tz);
    }
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    L.nrm[i * 3] = nx; L.nrm[i * 3 + 1] = ny; L.nrm[i * 3 + 2] = nz;
    L.tan[i * 3] = tx; L.tan[i * 3 + 1] = ty; L.tan[i * 3 + 2] = tz;
    L.bit[i * 3] = bx; L.bit[i * 3 + 1] = by; L.bit[i * 3 + 2] = bz;
    L.pos[i * 3] = px[i]; L.pos[i * 3 + 1] = f.py; L.pos[i * 3 + 2] = pz[i];
    const off = shape === SHAPE_SPHERE ? 0 : EMIT_OFF;
    L.vis[i * 3] = px[i] + quant(nx * off * INV_CELL); L.vis[i * 3 + 1] = f.py + ny * off; L.vis[i * 3 + 2] = pz[i] + quant(nz * off * INV_CELL);
    L.w[i] = Math.max(f.w, 1e-3); L.h[i] = Math.max(shape === SHAPE_RECT ? f.h : f.w, 1e-3);
    L.size[i] = Math.max(L.w[i], L.h[i]);
    // radiance with the static state
    let mul = 1, cr = f.color[0], cg = f.color[1], cb = f.color[2];
    if (!f.dynamic) {
      if (f.state === LightState.DYING) {
        mul = DYING_MEAN;
        cr += (1 - cr) * 0.2; cg += (0.8 - cg) * 0.2; cb += (0.85 - cb) * 0.2;
      } else if (f.state === LightState.ON || f.state === LightState.BUZZ) mul = 1;
      else mul = flickerMean(f.state);
    }
    const base = (shape === SHAPE_RECT ? fixtureRadiance(f) : f.luminance) * mul;
    L.rad[i * 3] = base * cr; L.rad[i * 3 + 1] = base * cg; L.rad[i * 3 + 2] = base * cb;
    L.radLum[i] = luma(L.rad[i * 3], L.rad[i * 3 + 1], L.rad[i * 3 + 2]);
    L.imax[i] = shape === SHAPE_RECT ? L.radLum[i] * f.w * f.h : L.radLum[i];
    L.invR2[i] = 1 / (L.R[i] * L.R[i]);
    // reaches the tile (+ apron)?
    const tx0 = HALO_OFF - apron, tx1 = HALO_OFF + 16 + apron;
    const ddx = px[i] < tx0 ? tx0 - px[i] : px[i] > tx1 ? px[i] - tx1 : 0;
    const ddz = pz[i] < tx0 ? tx0 - pz[i] : pz[i] > tx1 ? pz[i] - tx1 : 0;
    L.reachTile[i] = (ddx * ddx + ddz * ddz) * CELL * CELL < L.R[i] * L.R[i] ? 1 : 0;
  }
  // block buckets (horizontal window disc vs block rect)
  const cnt = new Int32Array(NBLOCK * NBLOCK + 1);
  const forBlocks = (i: number, fn: (b: number) => void): void => {
    const r = L.R[i] * INV_CELL;
    const x = L.pos[i * 3], z = L.pos[i * 3 + 2];
    const b0 = Math.max(0, Math.floor((x - r) / BLOCK)), b1 = Math.min(NBLOCK - 1, Math.floor((x + r) / BLOCK));
    const c0 = Math.max(0, Math.floor((z - r) / BLOCK)), c1 = Math.min(NBLOCK - 1, Math.floor((z + r) / BLOCK));
    for (let bj = c0; bj <= c1; bj++) {
      for (let bi = b0; bi <= b1; bi++) {
        const rx0 = bi * BLOCK, rz0 = bj * BLOCK;
        const ddx = x < rx0 ? rx0 - x : x > rx0 + BLOCK ? x - rx0 - BLOCK : 0;
        const ddz = z < rz0 ? rz0 - z : z > rz0 + BLOCK ? z - rz0 - BLOCK : 0;
        if (ddx * ddx + ddz * ddz < r * r) fn(bj * NBLOCK + bi);
      }
    }
  };
  for (let i = 0; i < n; i++) forBlocks(i, (b) => { cnt[b + 1]++; });
  for (let b = 0; b < NBLOCK * NBLOCK; b++) cnt[b + 1] += cnt[b];
  const list = new Int32Array(cnt[NBLOCK * NBLOCK]);
  const fill = cnt.slice(0, NBLOCK * NBLOCK);
  for (let i = 0; i < n; i++) forBlocks(i, (b) => { list[fill[b]++] = i; });
  L.blockStart = cnt;
  L.blockList = list;
  return L;
}

/** Block index of a halo position. */
export const blockOf = (x: number, z: number): number => {
  const bi = Math.min(NBLOCK - 1, Math.max(0, Math.floor(x / BLOCK)));
  const bj = Math.min(NBLOCK - 1, Math.max(0, Math.floor(z / BLOCK)));
  return bj * NBLOCK + bi;
};

// ---------------------------------------------------------------- the sun (R2 lighting)
// SKY_PANEL fixtures of a SKYLIGHT_HALL landmark are glazed openings to the sky: besides their diffuse sky
// radiance (the RECT light above) they admit direct sunlight. The sun is one world-fixed direction (a late-morning
// sun, elevation SUN.elev, azimuth SUN.azim from +x toward +z), so every hall and every tile agrees on it. A
// receiver is sunlit where the parallel ray toward the sun passes through an aperture (an exact bitmap of the
// panels on the 0.6 m ceiling-tile lattice, per aperture plane height) and nothing occludes it on the way (DDA).
// Irradiance E = SUN.e * SUN.glazing * max(0, n.s) * visible fraction (direct.ts sunAt: SUN_SAMPLES directions
// jittered over a SUN.cone half-width square: ~13 cm penumbrae from the sun disc and the glazing).

export const SUN = {
  elev: 56 * Math.PI / 180,
  azim: 35 * Math.PI / 180,
  e: 32000, // lux normal to the beam, outside the glazing (a hazy sun; tuned with the 7000-nit sky panels so the hall
  // stays inside the Poolrooms exposure range: patches ~3x the ambient floor irradiance)
  glazing: 0.6,
  color: [1.0, 0.93, 0.84] as const, // linear RGB, max 1 (slightly warmer than the 7000 K sky panels)
  cone: 0.006, // rad: half-width of the jitter square (sun disc 0.0047 + a little glazing diffusion: ~13 cm penumbra at 11 m)
} as const;

export interface SunPlane {
  y: number; // aperture plane height (m)
  bits: Uint8Array; // (2 * HALO)^2 half-cell bitmap: 1 = glazed aperture
}
export interface SunSet {
  planes: SunPlane[];
  dx: number; dy: number; dz: number; // unit direction toward the sun (world metres)
  e1x: number; e1z: number; // jitter frame: e1 horizontal, e2 = s x e1
  e2x: number; e2y: number; e2z: number;
  er: number; eg: number; eb: number; // RGB irradiance normal to the beam, glazing applied (lux)
}
export const SUN_RES = 2 * HALO; // half cells per halo side

/** Is the fixture a sun aperture (a lit SKY_PANEL of a SKYLIGHT_HALL)? */
function isSunAperture(l: ChunkLayout, f: Fixture): boolean {
  if (f.kind !== FixtureKind.SKY_PANEL || f.state === LightState.OFF || !(f.luminance > 0) || f.bakeGroup !== 0) return false;
  if (f.ny > -0.99) return false;
  const li = worldToCell(f.px), lj = worldToCell(f.pz);
  for (const lm of l.landmarks) {
    if (lm.kind === LandmarkKind.SKYLIGHT_HALL && li >= lm.i0 && li < lm.i1 && lj >= lm.j0 && lj < lm.j1) return true;
  }
  return false;
}

/** The sun apertures of the 9 layouts in halo coordinates (null when there are none). */
export function gatherSun(nb: LayoutNeighborhood, hl0: number, hm0: number): SunSet | null {
  const planes: SunPlane[] = [];
  for (let slot = 0; slot < 9; slot++) {
    const dcx = slotDcx(slot), dcz = slotDcz(slot);
    const l = nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1);
    const offX = dcx * CHUNK_CELLS - hl0, offZ = dcz * CHUNK_CELLS - hm0;
    for (const f of l.fixtures) {
      if (!isSunAperture(l, f)) continue;
      const alongX = Math.abs(f.tx) > 0.5;
      const hx = (alongX ? f.w : f.h) / 2, hz = (alongX ? f.h : f.w) / 2;
      // half-cell index range whose centres lie inside the rect (exact for rects on the 0.6 m lattice)
      const a0 = Math.ceil((offX + (f.px - hx) * INV_CELL) * 2 - 0.5 - 1e-6), a1 = Math.floor((offX + (f.px + hx) * INV_CELL) * 2 - 0.5 + 1e-6);
      const b0 = Math.ceil((offZ + (f.pz - hz) * INV_CELL) * 2 - 0.5 - 1e-6), b1 = Math.floor((offZ + (f.pz + hz) * INV_CELL) * 2 - 0.5 + 1e-6);
      if (a1 < 0 || b1 < 0 || a0 >= SUN_RES || b0 >= SUN_RES) continue;
      let p = planes.find((q) => Math.abs(q.y - f.py) < 1e-3);
      if (!p) { p = { y: f.py, bits: new Uint8Array(SUN_RES * SUN_RES) }; planes.push(p); }
      for (let b = Math.max(0, b0); b <= Math.min(SUN_RES - 1, b1); b++) {
        for (let a = Math.max(0, a0); a <= Math.min(SUN_RES - 1, a1); a++) p.bits[b * SUN_RES + a] = 1;
      }
    }
  }
  if (planes.length === 0) return null;
  planes.sort((a, b) => a.y - b.y);
  const ce = Math.cos(SUN.elev), se = Math.sin(SUN.elev);
  const dx = ce * Math.cos(SUN.azim), dy = se, dz = ce * Math.sin(SUN.azim);
  // e1 horizontal and perpendicular to s; e2 = s x e1
  const hl = Math.hypot(dx, dz);
  const e1x = -dz / hl, e1z = dx / hl;
  const e2x = dy * e1z, e2y = dz * e1x - dx * e1z, e2z = -dy * e1x;
  const e = SUN.e * SUN.glazing;
  return { planes, dx, dy, dz, e1x, e1z, e2x, e2y, e2z, er: e * SUN.color[0], eg: e * SUN.color[1], eb: e * SUN.color[2] };
}
