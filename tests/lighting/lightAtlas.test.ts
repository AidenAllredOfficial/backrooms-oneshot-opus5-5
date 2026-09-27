// tests/lighting/lightAtlas.test.ts (package F) — the camera-centred light atlas: toroidal slots, the flicker-channel
// mirror of brChannelSlot, mask packing (walls, TOWER, VALID) and the upload plan (changed tiles only, nearest first,
// version bumps, storey switches, tiles leaving the window, test fakes).

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LV, TILE_SIZE } from '../../src/core/constants.ts';
import { CellFlag, Mood, Zone, type StoreyId } from '../../src/core/ids.ts';
import { createEmptyLayout } from '../../src/core/layout.ts';
import type { ChunkLayout } from '../../src/core/layout.ts';
import type { TileRuntime, WorldQuery } from '../../src/core/runtime.ts';
import { channelSlot, LA, LA_BIT, laMaskIndex, laSlot, LightAtlas, lightAtlasGlsl } from '../../src/lighting/LightAtlas.ts';
import { slotLut } from '../../src/materials/chunks/params.ts';

const N = LV.NX * LV.NY * LV.NZ * 4;

function tile(cx: number, cz: number, q: 0 | 1 | 2 | 3, s: StoreyId = 0): TileRuntime {
  const mask = new Uint8Array(18 * 18 * 4);
  return {
    key: { s, cx, cz, q }, keyStr: `${s}:${cx}:${cz}:${q}`, zone: 0, group: new THREE.Group(),
    materials: {
      bindings: {
        volA: { value: new THREE.Data3DTexture(new Uint16Array(N), LV.NX, LV.NY, LV.NZ) },
        volB: { value: new THREE.Data3DTexture(new Uint8Array(N), LV.NX, LV.NY, LV.NZ) },
        volC: { value: new THREE.Data3DTexture(new Uint16Array(N), LV.NX, LV.NY, LV.NZ) },
        volMask: { value: new THREE.DataTexture(mask, 18, 18) },
        flick: { value: new Float32Array(27).map((_, i) => i) },
        ownParity: { value: new THREE.Vector2((cx * 2 + (q & 1)) & 1, (cz * 2 + (q >> 1)) & 1) },
      },
    } as unknown as TileRuntime['materials'],
    dynLights: [], bake: 'full', state: 'resident', visible: true,
  };
}
const world = (layouts: Map<string, ChunkLayout> = new Map()): WorldQuery =>
  ({ layoutAt: (cx: number, cz: number) => layouts.get(`${cx}:${cz}`) ?? null }) as unknown as WorldQuery;
/** A renderer stand-in recording copyTextureToTexture calls (destination texel offsets). */
function renderer(): THREE.WebGLRenderer & { copies: THREE.Vector3[] } {
  const copies: THREE.Vector3[] = [];
  return { copies, copyTextureToTexture: vi.fn((_s: THREE.Texture, _d: THREE.Texture, _r: unknown, p: THREE.Vector3) => { copies.push(p.clone()); }) } as unknown as THREE.WebGLRenderer & { copies: THREE.Vector3[] };
}
const cam = new THREE.PerspectiveCamera();

describe('light atlas', () => {
  it('slots wrap toroidally and the atlas coordinate x / SPAN lands on the right texel across the wrap seam', () => {
    expect(laSlot(-1)).toBe(6);
    expect(laSlot(7)).toBe(0);
    expect(laSlot(-15)).toBe(6);
    expect(LA.SPAN).toBeCloseTo(7 * TILE_SIZE, 12);
    for (let gtx = -10; gtx <= 10; gtx++) {
      for (const i of [0, 17, 31]) {
        const x = gtx * TILE_SIZE + (i + 0.5) * LV.STEP; // world x of LV sample i
        const u = (((x / LA.SPAN) % 1) + 1) % 1;
        expect(u * LA.NX - 0.5).toBeCloseTo(laSlot(gtx) * LV.NX + i, 6);
      }
    }
    expect(laMaskIndex(-1, 0)).toBe(LA.CELLS - 1);
    expect(laMaskIndex(LA.CELLS, LA.CELLS + 2)).toBe(2 * LA.CELLS);
  });

  it('channelSlot equals a literal transcription of the GLSL brChannelSlot for every parity, quadrant and channel', () => {
    const LUT = slotLut();
    const half = TILE_SIZE / 2;
    const glsl = (k: number, lx: number, lz: number, px: number, pz: number): number => {
      const kx = k & 1, kz = k >> 1;
      const dx = kx === px ? 0 : lx < half ? -1 : 1;
      const dz = kz === pz ? 0 : lz < half ? -1 : 1;
      return LUT[(dx + 1) + 3 * (dz + 1)];
    };
    for (let px = 0; px < 2; px++) for (let pz = 0; pz < 2; pz++) for (let k = 0; k < 4; k++) {
      for (const [lx, lz] of [[1, 1], [18, 1], [1, 18], [18, 18], [9.59, 9.61]]) {
        expect(channelSlot(k, lx >= half ? 1 : 0, lz >= half ? 1 : 0, px, pz)).toBe(glsl(k, lx, lz, px, pz));
      }
    }
    // the GLSL twin samples the same quadrant rule and mask bits
    const g = lightAtlasGlsl();
    expect(g).toMatch(/bool brLaSample\( vec3 rel, out vec3 E, out float w, out vec3 Ld, out vec3 Ef \)/);
    expect(g).toContain(`& ${LA_BIT.VALID} )`);
    expect(g).toContain(`& ${LA_BIT.TOWER} )`);
  });

  it('packs the wall bits, TOWER and VALID of an uploaded tile, and copies its volumes to its slot', () => {
    const t = tile(1, -1, 3);
    const m = (t.materials.bindings.volMask.value as THREE.DataTexture).image.data as Uint8Array;
    m[((0 + 1) * 18 + (2 + 1)) * 4] = 1 | 8; // cell (2, 0): N + W walls
    m[((5 + 1) * 18 + (5 + 1)) * 4 + 1] = 200; // water channels (g/b/a) are not wall bits
    const lay = createEmptyLayout({ s: 0, cx: 1, cz: -1 }, Zone.LOBBY, 1, Mood.NORMAL);
    lay.flags[(16 + 4) * 32 + 16 + 7] |= CellFlag.TOWER; // tile q = 3: local cell (7, 4)
    const a = new LightAtlas();
    a.plan([t], 0, 1.5 * 38.4, -0.5 * 38.4, world(new Map([['1:-1', lay]])));
    expect(a.queued).toBe(1);
    const gtx = 3, gtz = -1; // cx * 2 + (q & 1), cz * 2 + (q >> 1)
    const i0 = laSlot(gtx) * 16, j0 = laSlot(gtz) * 16;
    expect(a.maskData[(j0 + 0) * LA.CELLS + i0 + 2]).toBe(0); // not before the upload
    const r = renderer();
    a.sync(r, cam);
    expect(a.queued).toBe(0);
    expect(r.copies.length).toBe(3); // A, B, C
    for (const p of r.copies) expect([p.x, p.y, p.z]).toEqual([laSlot(gtx) * LV.NX, 0, laSlot(gtz) * LV.NZ]);
    expect(a.maskData[(j0 + 0) * LA.CELLS + i0 + 2]).toBe(1 | 8 | LA_BIT.VALID);
    expect(a.maskData[(j0 + 5) * LA.CELLS + i0 + 5]).toBe(LA_BIT.VALID);
    expect(a.maskData[(j0 + 4) * LA.CELLS + i0 + 7]).toBe(LA_BIT.TOWER | LA_BIT.VALID);
    expect(a.validAt(gtx * TILE_SIZE + 1, gtz * TILE_SIZE + 1)).toBe(true);
    expect(a.validAt(gtx * TILE_SIZE - 1, gtz * TILE_SIZE + 1)).toBe(false);
    // flicker rows: channel k in quadrant q -> the tile's flick slot channelSlot(k, q)
    const par = t.materials.bindings.ownParity.value;
    const row = (laSlot(gtx) + 7 * laSlot(gtz)) * 64;
    for (let q = 0; q < 4; q++) for (let k = 0; k < 4; k++) {
      const s = channelSlot(k, q & 1, q >> 1, par.x, par.y);
      expect(a.flickData[row + (q * 4 + k) * 4]).toBe(s * 3);
      expect(a.flickData[row + (q * 4 + k) * 4 + 2]).toBe(s * 3 + 2);
    }
    // the camera uniform wraps like the atlas
    cam.position.set(-1, 1.6, LA.SPAN + 2);
    a.sync(r, cam);
    const cm = a.uniforms.uLaCamMod.value;
    expect(cm.x).toBeCloseTo(LA.SPAN - 1, 9);
    expect(cm.y).toBe(1.6);
    expect(cm.z).toBeCloseTo(2, 9);
  });

  it('plans only changed tiles, nearest first; re-queues on a version bump; clears tiles that leave, and storey switches', () => {
    const a = new LightAtlas();
    const near = tile(0, 0, 0), far = tile(1, 1, 3), outside = tile(3, 0, 0);
    const fake = { ...tile(0, 0, 1), materials: { bindings: { flick: { value: new Float32Array(27) } } } } as unknown as TileRuntime;
    const eye = [5, 5] as const;
    a.plan([far, fake, outside, near], 0, eye[0], eye[1], world());
    expect(a.queued).toBe(2); // the fake (no volumes) and the tile 6 tiles away are not planned
    const r = renderer();
    a.sync(r, cam);
    // nearest first: tile (0, 0) = slot 0 before tile (3, 3)
    expect([r.copies[0].x, r.copies[0].z]).toEqual([0, 0]);
    expect([r.copies[3].x, r.copies[3].z]).toEqual([3 * LV.NX, 3 * LV.NZ]);
    a.plan([far, near], 0, eye[0], eye[1], world());
    expect(a.queued).toBe(0); // unchanged
    (near.materials.bindings.volA.value as THREE.Texture).needsUpdate = true; // preview -> full re-upload in place
    a.plan([far, near], 0, eye[0], eye[1], world());
    expect(a.queued).toBe(1);
    a.sync(r, cam);
    expect(a.validAt(1, 1)).toBe(true);
    // a tile gone from the resident set loses VALID at once
    a.plan([near], 0, eye[0], eye[1], world());
    expect(a.validAt(3 * TILE_SIZE + 1, 3 * TILE_SIZE + 1)).toBe(false);
    expect(a.validAt(1, 1)).toBe(true);
    // another storey: everything invalid, the same tile queued again for the new storey's data
    const up = tile(0, 0, 0, 1);
    a.plan([up], 1, eye[0], eye[1], world());
    expect(a.validAt(1, 1)).toBe(false);
    expect(a.queued).toBe(1);
    // a slot reused by another tile (7 tiles away) is invalid until that tile's data is uploaded
    a.sync(r, cam);
    const wrapped = tile(3, 0, 1, 1); // gtx 7 -> slot 0
    a.plan([wrapped], 1, 7 * TILE_SIZE + 5, 5, world());
    expect(a.validAt(1, 1)).toBe(false);
    expect(a.validAt(7 * TILE_SIZE + 1, 1)).toBe(false);
    a.sync(r, cam);
    expect(a.validAt(7 * TILE_SIZE + 1, 1)).toBe(true);
    a.dispose();
  });
});
