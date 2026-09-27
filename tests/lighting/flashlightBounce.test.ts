// tests/lighting/flashlightBounce.test.ts (package F) — flashlight bounce VPLs: the angular bins carry the whole beam,
// the flux of a hit, the room box stops at walls, off means zero, smoothing and snapping, camera-relative upload.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CELL, WALL_T } from '../../src/core/constants.ts';
import { cellIdx, exIdx, type ChunkKey } from '../../src/core/grid.ts';
import { CellFlag, EdgeKind, Mat, Mood, Zone, type StoreyId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import { LAYER_DEFS } from '../../src/core/materials.ts';
import { buildChunkCollision } from '../../src/player/collisionBuild.ts';
import { createChunkData, createWorldQuery, StoreyData } from '../../src/stream/WorldQueryImpl.ts';
import {
  BOUNCE, bounceBins, bounceSlots, createFlashlightBounce, mergeTargets, multiBounce, roomBox, type BounceInput,
  type BounceUniforms,
} from '../../src/lighting/FlashlightBounce.ts';
import { beamFluxLm, FLASHLIGHT_OPTICS } from '../../src/lighting/flashlightOptics.ts';
import { BOUNCE_GLSL } from '../../src/materials/chunks/bounce.ts';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Floor 0 / ceiling 2.7 room over the whole chunk; a wall on x = 6 m; a SOLID cell at (1, 10). */
function world() {
  const k: ChunkKey = { s: 0, cx: 0, cz: 0 };
  const l: ChunkLayout = createEmptyLayout(k, Zone.LOBBY, 1, Mood.NORMAL);
  l.floorCm.fill(0); l.ceilCm.fill(270);
  l.floorMat.fill(Mat.CARPET_L0); l.ceilMat.fill(Mat.CEILING_TILE); l.wallMat.fill(Mat.WALLPAPER_L0);
  for (let lj = 0; lj < 32; lj++) {
    const e = exIdx(5, lj);
    l.ex.kind[e] = EdgeKind.WALL; l.ex.matNeg[e] = Mat.WALLPAPER_L0; l.ex.matPos[e] = Mat.WALLPAPER_L0;
  }
  l.flags[cellIdx(1, 10)] |= CellFlag.SOLID;
  const s0 = new StoreyData();
  s0.set(createChunkData(l, buildChunkCollision(l)));
  const data = [s0, new StoreyData(), new StoreyData()];
  return createWorldQuery({ storey: () => 0 as StoreyId, data: (s) => data[s] });
}

type V4s = { value: THREE.Vector4[] };
function uniforms(): BounceUniforms & { fbP: V4s; fbN: V4s; fbC: V4s; fbBox: V4s } {
  const v = (): THREE.Vector4[] => Array.from({ length: 8 }, () => new THREE.Vector4());
  return { fbOn: { value: 0 }, fbP: { value: v() }, fbN: { value: v() }, fbC: { value: v() }, fbBox: { value: v() } };
}

/** Torch at (x, 1.42, z) aimed along d; eye 0.2 m above it. */
function input(n: number, x: number, z: number, d: [number, number, number], dt = 0): BounceInput {
  return {
    n, ox: x, oy: 1.42, oz: z, dx: d[0], dy: d[1], dz: d[2], rx: 1, ry: 0, rz: 0, cr: 1, cg: 0.9, cb: 0.75,
    eyeX: x - 0.15, eyeY: 1.62, eyeZ: z, dt,
  };
}

describe('flashlight bounce', () => {
  it('bins: 1 / 4 / 8 VPLs whose fluxes and solid angles add up to the whole rendered cone', () => {
    const total = beamFluxLm(0, FLASHLIGHT_OPTICS.CONE, 4000, true);
    const omega = 2 * Math.PI * (1 - Math.cos(FLASHLIGHT_OPTICS.CONE));
    for (const n of [1, 4, 8]) {
      const b = bounceBins(n);
      expect(b.length).toBe(n);
      expect(b.reduce((s, x) => s + x.flux, 0) / total).toBeCloseTo(1, 3);
      expect(b.reduce((s, x) => s + x.omega, 0)).toBeCloseTo(omega, 9);
    }
    expect(bounceBins(1)[0].theta).toBe(0);
    expect(bounceBins(4)[0].theta).toBe(0);
    expect(bounceBins(0).length).toBe(0);
    expect(bounceBins(2).length).toBe(1); // unsupported counts round down
    const b8 = bounceBins(8);
    expect(b8[0].theta).toBeGreaterThan(deg(5)); // flux-weighted mean of 0..16 deg (the core included)
    expect(b8[0].theta).toBeLessThan(deg(11));
    expect(b8[4].theta).toBeGreaterThan(deg(22)); // the spill sectors
    expect(b8[4].theta).toBeLessThan(deg(27));
    expect(b8[4].phi).toBeCloseTo(b8[0].phi, 12); // an inner and an outer sector per quadrant
    // slots the shader evaluates: medium 1 (4 rays merged), high 4, ultra 4 (8 rays merged pairwise)
    expect([0, 1, 4, 8].map(bounceSlots)).toEqual([0, 1, 4, 4]);
  });

  it('a floor hit re-emits flux x colour x albedo / PI from just above the patch', () => {
    const w = world();
    const fb = createFlashlightBounce();
    const u = uniforms();
    fb.update(input(4, 3, 20, [0, -1, 0]), w, u);
    expect(u.fbOn.value).toBe(1);
    expect(fb.active).toBe(4);
    const s = fb.slot(0); // the core bin, straight down
    expect(s[0]).toBeCloseTo(3, 9);
    expect(s[1]).toBeCloseTo(BOUNCE.OFFSET, 9);
    expect([s[3], s[4], s[5]]).toEqual([0, 1, 0]);
    expect(s[15]).toBe(0); // a plain Lambertian patch
    const a = LAYER_DEFS[Mat.CARPET_L0].albedoMean;
    const q = 1.42 / FLASHLIGHT_OPTICS.RANGE;
    const win = (1 - q ** 4) ** 2;
    const bin = bounceBins(4)[0];
    expect(s[6]).toBeCloseTo((bin.flux * win * 1 * a[0] * multiBounce(a[0])) / Math.PI, 6);
    expect(s[8]).toBeCloseTo((bin.flux * win * 0.75 * a[2] * multiBounce(a[2])) / Math.PI, 6);
    expect(multiBounce(0)).toBe(1);
    expect(multiBounce(0.5)).toBeCloseTo(1 / (1 - 0.275), 12);
    expect(multiBounce(1)).toBeCloseTo(1 / 0.45, 12);
    expect(multiBounce(2)).toBeCloseTo(2.5, 12); // capped
    // a far, wide patch spreads: its radius^2 is t^2 * omega / (PI cos i), at least EPS2
    expect(s[9]).toBeCloseTo(Math.max(BOUNCE.EPS2, (1.42 ** 2 * bin.omega) / Math.PI), 6);
    const ring = fb.slot(1);
    expect(ring[9]).toBeGreaterThan(s[9]);
    // uploaded relative to the eye
    const p = u.fbP.value[0];
    expect(p.x).toBeCloseTo(0.15, 6);
    expect(p.y).toBeCloseTo(BOUNCE.OFFSET - 1.62, 6);
    expect(p.w).toBe(1);
    expect(u.fbC.value[0].w).toBeCloseTo(s[9], 6);
    for (let k = 4; k < 8; k++) expect(u.fbP.value[k].w).toBe(0);
  });

  it('medium: one VPL merging the 4 rays keeps their flux, sits at their flux centre and spans their spread', () => {
    const w = world();
    const u4 = uniforms(), u1 = uniforms();
    const f4 = createFlashlightBounce(), f1 = createFlashlightBounce();
    // aimed at the wall on x = 6 from 1.5 m, slightly down: the rays land on the wall and the floor
    const aim: [number, number, number] = [1, -0.8, 0];
    f4.update(input(4, 4.5, 20, aim), w, u4);
    f1.update(input(1, 4.5, 20, aim), w, u1);
    expect(f1.active).toBe(1);
    const m = f1.slot(0);
    let cr = 0, x = 0, y = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const s = f4.slot(k);
      const wi = s[6] + s[7] + s[8];
      cr += s[6]; wsum += wi; x += wi * s[0]; y += wi * s[1];
    }
    expect(m[6]).toBeCloseTo(cr, 9);
    expect(m[0]).toBeCloseTo(x / wsum, 6);
    expect(m[1]).toBeCloseTo(y / wsum, 6);
    // mixed wall (-x) and floor (+y) patches: a shorter mean normal plus the isotropic rest, same total flux
    const ml = Math.hypot(m[3], m[4], m[5]);
    expect(ml).toBeLessThan(1);
    expect(m[3]).toBeLessThan(0);
    expect(m[4]).toBeGreaterThan(0);
    expect(m[15]).toBeCloseTo(0.25 * (1 - ml), 9);
    expect(m[9]).toBeGreaterThan(BOUNCE.EPS2);
    expect(u1.fbN.value[0].w).toBeCloseTo(m[15], 9);
    for (let k = 1; k < 8; k++) expect(u1.fbP.value[k].w).toBe(0);
  });

  it('mergeTargets: flux-weighted centre, flux conserved (directional |m| + isotropic 4 * iso = 1), union box', () => {
    const tg = new Float64Array(8 * 16);
    const put = (i: number, p: number[], n: number[], c: number, box: number[]) => {
      tg.set([...p, ...n, c, c, c, 0.09, ...box, 1, 0], i * 16);
    };
    put(0, [0, 0, 0], [0, 1, 0], 3, [0, 0, 1, 1]);
    put(1, [2, 0, 0], [0, -1, 0], 1, [1, 0, 3, 1]);
    tg[2 * 16 + 14] = 0; // a miss
    const out = new Float64Array(8 * 16);
    expect(mergeTargets(tg, [0, 1, 2], out, 1)).toBe(true);
    const o = 16;
    expect(out[o]).toBeCloseTo(0.5, 9); // (3 * 0 + 1 * 2) / 4
    expect(out[o + 4]).toBeCloseTo(0.5, 9); // (3 - 1) / 4
    expect(out[o + 15]).toBeCloseTo(0.125, 9); // 0.25 * (1 - 0.5)
    expect(out[o + 6]).toBe(4);
    expect(out[o + 9]).toBeCloseTo((3 * (0.25 + 0.09) + 1 * (2.25 + 0.09)) / 4, 9);
    expect([out[o + 10], out[o + 11], out[o + 12], out[o + 13]]).toEqual([0, 0, 3, 1]);
    expect(out[o + 14]).toBe(1);
    expect(mergeTargets(tg, [2], out, 0)).toBe(false);
    expect(out[14]).toBe(0);
  });

  it('ultra: 8 rays, 4 slots (each quadrant\'s inner and outer hit merged)', () => {
    const w = world();
    const fb = createFlashlightBounce();
    const u = uniforms();
    fb.update(input(8, 3, 20, [1, -0.3, 0]), w, u);
    expect(fb.active).toBe(4);
    for (let k = 4; k < 8; k++) expect(u.fbP.value[k].w).toBe(0);
    let c = 0;
    for (let k = 0; k < 4; k++) c += fb.slot(k)[6];
    // the 4 slots carry the flux of all 8 rays (compare with high's 4 rays of the same beam)
    const f4 = createFlashlightBounce();
    f4.update(input(4, 3, 20, [1, -0.3, 0]), w, uniforms());
    let c4 = 0;
    for (let k = 0; k < 4; k++) c4 += f4.slot(k)[6];
    expect(c / c4).toBeGreaterThan(0.9);
    expect(c / c4).toBeLessThan(1.1);
  });

  it('off (n = 0, torch off, or no raycast) uploads nothing', () => {
    const w = world();
    const fb = createFlashlightBounce();
    const u = uniforms();
    fb.update(input(8, 3, 20, [1, -0.3, 0]), w, u);
    expect(fb.active).toBe(4);
    fb.update(input(0, 3, 20, [1, -0.3, 0], 1 / 60), w, u);
    expect(u.fbOn.value).toBe(0);
    expect(fb.active).toBe(0);
    for (let k = 0; k < 8; k++) expect(u.fbP.value[k].w).toBe(0);
    const noRay = { ...w, raycast: undefined } as unknown as typeof w;
    fb.update(input(8, 3, 20, [1, -0.3, 0]), noRay, u);
    expect(u.fbOn.value).toBe(0);
  });

  it('the room box stops at a wall (within its thickness) and reaches into SOLID cells', () => {
    const w = world();
    const b = new Float64Array(4);
    expect(roomBox(w, 5, 20, b)).toBe(true);
    expect(b[2]).toBeCloseTo(6, 9); // the wall line: its far face (6 + WALL_T / 2) is outside
    expect(b[2] + BOUNCE.BOX_SOFT).toBeLessThan(6 + WALL_T / 2);
    expect(b[0]).toBeLessThan(5 - 3 * CELL); // open floor the other way
    expect(b[3] - b[1]).toBeGreaterThan(8 * CELL);
    // behind the wall: the box starts at the wall line
    expect(roomBox(w, 7, 20, b)).toBe(true);
    expect(b[0]).toBeCloseTo(6, 9);
    // next to the SOLID cell (1, 10) (x 1.2..2.4, z 12..13.2): the box reaches SOLID_MARGIN into it
    expect(roomBox(w, 1.8, 11.5, b)).toBe(true);
    expect(b[3]).toBeGreaterThan(12);
    // the torch aimed at the wall: the VPLs' boxes end at the wall
    const fb = createFlashlightBounce();
    const u = uniforms();
    fb.update(input(4, 3, 20, [1, -0.1, 0]), w, u);
    const s = fb.slot(0);
    expect(s[0]).toBeCloseTo(6 - WALL_T / 2 + BOUNCE.OFFSET * -1, 1);
    expect(s[3]).toBe(-1);
    expect(s[12]).toBeCloseTo(6, 9);
  });

  it('the shader loops over the slots the runtime fills (ultra: 8 rays in 4 slots), not over BR_BOUNCE_N', () => {
    // BR_BOUNCE_N 8 / 4 / 1 -> BR_FB_SLOTS bounceSlots(n), in the preprocessor order of bounceCount's rounding
    const m = /#if BR_BOUNCE_N >= 8\s+#define BR_FB_SLOTS (\d+)\s+#elif BR_BOUNCE_N >= 4\s+#define BR_FB_SLOTS (\d+)\s+#else\s+#define BR_FB_SLOTS (\d+)/.exec(BOUNCE_GLSL);
    expect(m).not.toBeNull();
    expect([Number(m![1]), Number(m![2]), Number(m![3])]).toEqual([bounceSlots(8), bounceSlots(4), bounceSlots(1)]);
    expect(BOUNCE_GLSL).toContain('k < BR_FB_SLOTS;');
    expect(BOUNCE_GLSL).not.toContain('k < BR_BOUNCE_N;');
  });

  it('frozen frames rebuild the room box (a box cached while a neighbour chunk streamed in never decides a capture)', () => {
    // an open room over chunk (0, 0) that continues into chunk (1, 0); the torch looks straight down at x = 37.8,
    // next to the chunk border at x = 38.4, so the fill reaches over the border once chunk (1, 0) is loaded
    const k: ChunkKey = { s: 0, cx: 1, cz: 0 };
    const l2: ChunkLayout = createEmptyLayout(k, Zone.LOBBY, 1, Mood.NORMAL);
    l2.floorCm.fill(0); l2.ceilCm.fill(270);
    l2.floorMat.fill(Mat.CARPET_L0); l2.ceilMat.fill(Mat.CEILING_TILE); l2.wallMat.fill(Mat.WALLPAPER_L0);
    const s0 = new StoreyData();
    const k0: ChunkKey = { s: 0, cx: 0, cz: 0 };
    const l0: ChunkLayout = createEmptyLayout(k0, Zone.LOBBY, 1, Mood.NORMAL);
    l0.floorCm.fill(0); l0.ceilCm.fill(270);
    l0.floorMat.fill(Mat.CARPET_L0); l0.ceilMat.fill(Mat.CEILING_TILE); l0.wallMat.fill(Mat.WALLPAPER_L0);
    s0.set(createChunkData(l0, buildChunkCollision(l0)));
    const data = [s0, new StoreyData(), new StoreyData()];
    const w = createWorldQuery({ storey: () => 0 as StoreyId, data: (s) => data[s] });
    const fb = createFlashlightBounce();
    const u = uniforms();
    const down: [number, number, number] = [0, -1, 0];
    fb.update(input(4, 37.8, 20, down, 1 / 60), w, u); // first activation: fresh
    expect(fb.slot(0)[12]).toBeCloseTo(38.4, 9); // x1: the loaded chunk's edge
    s0.set(createChunkData(l2, buildChunkCollision(l2))); // the neighbour streams in
    fb.update(input(4, 37.8, 20, down, 1 / 60), w, u); // live frame: the cached box (refreshed within FILL_TTL)
    expect(fb.slot(0)[12]).toBeCloseTo(38.4, 9);
    fb.update(input(4, 37.8, 20, down, 0), w, u); // frozen: rebuilt against the world as it is now
    expect(fb.slot(0)[12]).toBeGreaterThan(38.4 + 3 * CELL);
  });

  it('smooths small moves, snaps on jumps, frozen frames and first activation', () => {
    const w = world();
    const fb = createFlashlightBounce();
    const u = uniforms();
    const aim = (x: number): [number, number, number] => [x - 3, -1.42, 0];
    fb.update(input(4, 3, 20, aim(3.0), 1 / 60), w, u); // first activation: snap (slot 0: the core ray)
    expect(fb.slot(0)[0]).toBeCloseTo(3.0, 6);
    fb.update(input(4, 3, 20, aim(3.4), 1 / 60), w, u); // 0.4 m: partial
    const x1 = fb.slot(0)[0];
    expect(x1).toBeGreaterThan(3.0);
    expect(x1).toBeLessThan(3.25);
    fb.update(input(4, 3, 20, aim(3.4), 0), w, u); // frozen time: snap
    expect(fb.slot(0)[0]).toBeCloseTo(3.4, 6);
    fb.update(input(4, 3, 20, [0, -0.2, -1], 1 / 60), w, u); // aimed far down the room: a jump > SNAP
    expect(Math.abs(fb.slot(0)[2] - 20)).toBeGreaterThan(BOUNCE.SNAP);
    expect(fb.slot(0)[1]).toBeCloseTo(BOUNCE.OFFSET, 6); // snapped onto the floor, not interpolated in the air
  });
});
