// src/lighting/LightAtlas.ts — package F: the camera-centred light atlas. The resident tiles' baked light volumes
// (bake/volume.ts: 32x6x32 samples at 0.6 m; A = irradiance facing the dominant direction + AO, B = that direction
// + directionality w, C = the 4 flicker-channel luminances), their wall masks and the live flicker colours, packed
// into one set of textures that any shader can sample at any point in the air within ~57 m of the camera (the froxel
// volumetrics and the dust motes: lamp light in free air, wall-aware, flickering with the surfaces).
//
// Toroidal addressing: a 7 x 7-tile window around the camera tile; tile (gtx, gtz) lives in slot (gtx mod 7,
// gtz mod 7). TILE_SIZE = 32 * LV.STEP and the atlas is exactly 7 tiles wide with repeat wrapping, so the atlas
// coordinate of a world point is simply (x / SPAN, lvV(y), z / SPAN) mod 1, and hardware trilinear filtering is
// correct across every tile seam (the wrap seam included) while both tiles are in the window. The window only
// guarantees 3 tiles (57.6 m) from the camera tile's edge, so consumers stay within 56 m. A sample outside the
// window (a froxel more than 3 tiles to the side at a diagonal heading) finds no light: brLaSample tests the window
// (laInWindow) before the mask, because the wrapped slot there holds the tile 7 tiles away, and its VALID bit would
// pass.
//
// Textures:
//   A, B, C  224 x 6 x 224 3D (x, y level, z): RGBA16F / RGBA8 / RGBA16F, linear, repeat on x and z
//   mask     112 x 112 R8 (one texel per cell, repeat): wall bits N1 E2 S4 W8 (the tile's wall mask), TOWER 16
//            (the stair-tower y wrap, as chunks/lighting.ts), VALID 32 (the slot holds this tile's data)
//   flick    16 x 49 RGBA32F: row = slot (sx + 7 sz), column = quadrant * 4 + channel k: the tile's flicker colour
//            (bindings.flick) that channel k resolves to in that quadrant (brChannelSlot)
// Uploads: plan() (CPU, per frame, in LightingRuntime.update) queues the slots whose tile changed (new tile, or a
// preview -> full re-upload: the textures' versions), nearest first; sync() (the 'lightAtlas' afterDepth hook,
// order 30) copies at most UPLOADS_PER_FRAME of them with renderer.copyTextureToTexture from wrapper textures that
// are never bound (three then takes its texSubImage3D path from the tile's retained CPU arrays: TexturePool keeps
// them for 3D volumes), and re-uploads the mask (on change) and the flicker rows (every frame).

import * as THREE from 'three';
import { CELL, CHUNK_CELLS, LV, STOREY_PITCH, TILE_CELLS, TILE_SIZE } from '../core/constants.ts';
import { globalTileX, globalTileZ } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { DYN_SLOT_OFFSETS } from '../core/mesh.ts';
import type { TileRuntime, WorldQuery } from '../core/runtime.ts';
import { f } from '../materials/chunks/params.ts';

export const LA = {
  /** tiles per side of the window */
  TILES: 7,
  /** m: the atlas period (7 tiles) */
  SPAN: 7 * TILE_SIZE,
  /** cells per side of the mask */
  CELLS: 7 * TILE_CELLS,
  /** texels per side of the 3D atlases */
  NX: 7 * LV.NX,
  /** tile uploads per frame (3 x 24576 texels each) */
  UPLOADS_PER_FRAME: 8,
  /** m: samples stay this far inside their own cell on occluding sides (the props shader's BR_LV_WALL_CLAMP) */
  WALL_CLAMP: 0.3,
  /** m: consumers sample within this distance of the camera (3 tiles from the camera tile's edge = 57.6 m) */
  REACH: 56,
} as const;

/** Mask bits. */
export const LA_BIT = { N: 1, E: 2, S: 4, W: 8, WALLS: 15, TOWER: 16, VALID: 32 } as const;

const LV_TEXELS = LV.NX * LV.NY * LV.NZ * 4;
const MASK_N = 18;
const ZERO_C = new Uint16Array(LV_TEXELS);

/** Slot index (0..6) of a global tile coordinate. */
export const laSlot = (gt: number): number => ((gt % LA.TILES) + LA.TILES) % LA.TILES;

/** Slot lookup (dx+1) + 3*(dz+1) -> DYN_SLOT_OFFSETS index (chunks/params.ts slotLut). */
const SLOT_LUT: readonly number[] = (() => {
  const lut = new Array<number>(9).fill(0);
  DYN_SLOT_OFFSETS.forEach(([dx, dz], i) => { lut[(dx + 1) + 3 * (dz + 1)] = i; });
  return lut;
})();

/** TS mirror of chunks/common.ts brChannelSlot for a point in quadrant (qx, qz) of a tile with parity (px, pz):
 * the index into the tile's 9 flicker slots that channel k resolves to there. */
export function channelSlot(k: number, qx: number, qz: number, px: number, pz: number): number {
  const kx = k & 1, kz = k >> 1;
  const dx = kx === px ? 0 : qx === 0 ? -1 : 1;
  const dz = kz === pz ? 0 : qz === 0 ? -1 : 1;
  return SLOT_LUT[(dx + 1) + 3 * (dz + 1)];
}

/** TS twin of brLaSample's window test: whether the atlas point p (camera-relative point + uLaCamMod, both axes)
 * lies in the 7 x 7 tiles that plan() keeps around the camera tile (camMod / TILE_SIZE, floored). */
export function laInWindow(px: number, pz: number, camModX: number, camModZ: number): boolean {
  const half = (LA.TILES - 1) >> 1;
  const inAxis = (p: number, c: number): boolean => {
    const ct = Math.floor(c * (1 / TILE_SIZE));
    return p >= (ct - half) * TILE_SIZE && p < (ct + half + 1) * TILE_SIZE;
  };
  return inAxis(px, camModX) && inAxis(pz, camModZ);
}

/** Mask texel of the world cell (gi, gj) (repeat wrap). */
export const laMaskIndex = (gi: number, gj: number): number =>
  ((gj % LA.CELLS) + LA.CELLS) % LA.CELLS * LA.CELLS + ((gi % LA.CELLS) + LA.CELLS) % LA.CELLS;

/** Shared uniform objects (the froxel inject and the motes bind them by reference). */
export interface LightAtlasUniforms {
  uLaA: { value: THREE.Texture };
  uLaB: { value: THREE.Texture };
  uLaC: { value: THREE.Texture };
  uLaMask: { value: THREE.Texture };
  uLaFlick: { value: THREE.Texture };
  /** (camera x mod SPAN, camera y, camera z mod SPAN), float64 on the CPU */
  uLaCamMod: { value: THREE.Vector3 };
}

/** GLSL (vertex or fragment: no derivatives): the atlas uniforms and
 *   bool brLaSample( vec3 rel, out vec3 E, out float w, out vec3 Ld, out vec3 Ef )
 * at a camera-relative world point: E = baked irradiance facing the dominant direction (lux), w its directionality,
 * Ld the unit direction toward the light, Ef the live flicker-channel irradiance. False (all zero) outside the
 * camera's 7 x 7-tile window (laInWindow) and outside the valid slots. Self-contained (its own constants and
 * helpers). */
export function lightAtlasGlsl(): string {
  const lvY = LV.Y.map(f).join(', ');
  const half = (LA.TILES - 1) >> 1;
  return /* glsl */ `
// ---- light atlas (package F, lighting/LightAtlas.ts)
uniform highp sampler3D uLaA;
uniform highp sampler3D uLaB;
uniform highp sampler3D uLaC;
uniform highp sampler2D uLaMask;
uniform highp sampler2D uLaFlick;
uniform vec3 uLaCamMod;
const float BR_LA_Y[ ${LV.NY} ] = float[ ${LV.NY} ]( ${lvY} );
float brLaLvV( float y ) {
	y = clamp( y, BR_LA_Y[ 0 ], BR_LA_Y[ ${LV.NY - 1} ] );
	float k = 0.0;
	for ( int i = 0; i < ${LV.NY - 1}; i ++ ) {
		if ( y >= BR_LA_Y[ i ] ) k = float( i ) + ( y - BR_LA_Y[ i ] ) / ( BR_LA_Y[ i + 1 ] - BR_LA_Y[ i ] );
	}
	return ( min( k, ${f(LV.NY - 1)} ) + 0.5 ) * ${f(1 / LV.NY)};
}
bool brLaSample( vec3 rel, out vec3 E, out float w, out vec3 Ld, out vec3 Ef ) {
	E = vec3( 0.0 ); w = 0.0; Ld = vec3( 0.0, 1.0, 0.0 ); Ef = vec3( 0.0 );
	vec3 p = rel + uLaCamMod;
	// the window plan() keeps (laInWindow): beyond it the wrapped slot holds a tile 7 tiles away
	vec2 ct = floor( uLaCamMod.xz * ${f(1 / TILE_SIZE)} );
	if ( any( lessThan( p.xz, ( ct - ${f(half)} ) * ${f(TILE_SIZE)} ) ) || any( greaterThanEqual( p.xz, ( ct + ${f(half + 1)} ) * ${f(TILE_SIZE)} ) ) ) return false;
	ivec2 cell = ivec2( floor( p.xz * ${f(1 / CELL)} ) );
	ivec2 cm = cell - ${LA.CELLS} * ivec2( floor( vec2( cell ) * ${f(1 / LA.CELLS)} ) );
	int m = int( texelFetch( uLaMask, cm, 0 ).r * 255.0 + 0.5 );
	if ( ( m & ${LA_BIT.VALID} ) == 0 ) return false;
	// stay inside the own cell on occluding sides (the props shader's clamp): no light through walls
	vec2 lo = vec2( cell ) * ${f(CELL)};
	vec2 hi = lo + ${f(CELL)};
	if ( ( m & ${LA_BIT.N} ) != 0 ) p.z = max( p.z, lo.y + ${f(LA.WALL_CLAMP)} );
	if ( ( m & ${LA_BIT.E} ) != 0 ) p.x = min( p.x, hi.x - ${f(LA.WALL_CLAMP)} );
	if ( ( m & ${LA_BIT.S} ) != 0 ) p.z = min( p.z, hi.y - ${f(LA.WALL_CLAMP)} );
	if ( ( m & ${LA_BIT.W} ) != 0 ) p.x = max( p.x, lo.x + ${f(LA.WALL_CLAMP)} );
	float y = p.y;
	if ( ( m & ${LA_BIT.TOWER} ) != 0 ) y = 1.5 + mod( y - 1.5, ${f(STOREY_PITCH)} );
	vec3 uvw = vec3( p.x * ${f(1 / LA.SPAN)}, brLaLvV( y ), p.z * ${f(1 / LA.SPAN)} );
	vec4 a = textureLod( uLaA, uvw, 0.0 );
	vec4 b = textureLod( uLaB, uvw, 0.0 );
	vec4 c = textureLod( uLaC, uvw, 0.0 );
	E = max( a.rgb, vec3( 0.0 ) );
	w = clamp( b.a, 0.0, 1.0 );
	vec3 d = b.xyz * 2.0 - 1.0;
	float dl = length( d );
	if ( dl < 1e-3 ) w = 0.0; else Ld = d / dl;
	c = max( c, vec4( 0.0 ) );
	if ( c.r + c.g + c.b + c.a > 0.0 ) {
		ivec2 tl = ivec2( floor( p.xz * ${f(1 / TILE_SIZE)} ) );
		vec2 loc = p.xz - vec2( tl ) * ${f(TILE_SIZE)};
		ivec2 ts = tl - ${LA.TILES} * ivec2( floor( vec2( tl ) * ${f(1 / LA.TILES)} ) );
		int row = ts.x + ${LA.TILES} * ts.y;
		int q = ( loc.x >= ${f(TILE_SIZE / 2)} ? 1 : 0 ) + ( loc.y >= ${f(TILE_SIZE / 2)} ? 2 : 0 );
		Ef = c.r * texelFetch( uLaFlick, ivec2( q * 4, row ), 0 ).rgb
			+ c.g * texelFetch( uLaFlick, ivec2( q * 4 + 1, row ), 0 ).rgb
			+ c.b * texelFetch( uLaFlick, ivec2( q * 4 + 2, row ), 0 ).rgb
			+ c.a * texelFetch( uLaFlick, ivec2( q * 4 + 3, row ), 0 ).rgb;
	}
	return true;
}
`;
}

interface Slot {
  tile: TileRuntime | null;
  gtx: number;
  gtz: number;
  /** the textures (and their versions) last uploaded, or queued */
  a: THREE.Texture | null; av: number;
  b: THREE.Texture | null; bv: number;
  c: THREE.Texture | null; cv: number;
  m: THREE.Texture | null; mv: number;
  layout: ChunkLayout | null;
  /** data in the atlas belongs to `tile` (VALID set) */
  valid: boolean;
  pending: boolean;
  seen: number;
  prio: number;
}

type DataTex = THREE.Texture & { image: { data?: unknown } };
const dataOf = (t: THREE.Texture | undefined | null): unknown => (t ? (t as DataTex).image?.data : undefined);

/** The tile's volume textures when they hold uploaded LV data (else null: not ready). */
function volumesOf(tile: TileRuntime): { a: THREE.Texture; b: THREE.Texture; c: THREE.Texture | null; m: THREE.Texture } | null {
  const bd = tile.materials.bindings;
  if (!bd.volA || !bd.volB || !bd.volMask) return null; // test fakes
  const a = bd.volA.value, b = bd.volB.value, c = bd.volC ? bd.volC.value : null, m = bd.volMask.value;
  const ad = dataOf(a), bdd = dataOf(b), md = dataOf(m);
  if (!(ad instanceof Uint16Array) || ad.length !== LV_TEXELS) return null;
  if (!(bdd instanceof Uint8Array) || bdd.length !== LV_TEXELS) return null;
  if (!(md instanceof Uint8Array) || md.length < MASK_N * MASK_N * 4) return null;
  const cd = dataOf(c);
  return { a, b, c: cd instanceof Uint16Array && cd.length === LV_TEXELS ? c : null, m };
}

function newSlot(): Slot {
  return {
    tile: null, gtx: 0, gtz: 0, a: null, av: -1, b: null, bv: -1, c: null, cv: -1, m: null, mv: -1, layout: null,
    valid: false, pending: false, seen: -1, prio: 0,
  };
}

function data3D(type: THREE.TextureDataType): THREE.Data3DTexture {
  const n = LA.NX * LV.NY * LA.NX * 4;
  const t = new THREE.Data3DTexture(type === THREE.UnsignedByteType ? new Uint8Array(n) : new Uint16Array(n), LA.NX, LV.NY, LA.NX);
  t.format = THREE.RGBAFormat;
  t.type = type;
  t.wrapS = THREE.RepeatWrapping; // x
  t.wrapT = THREE.ClampToEdgeWrapping; // y levels
  t.wrapR = THREE.RepeatWrapping; // z
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  // the zero array only allocates the texture: drop it after the first upload (tiles are copied in afterwards)
  t.onUpdate = () => { (t.image as { data: unknown }).data = null; };
  t.needsUpdate = true;
  return t;
}

export class LightAtlas {
  readonly uniforms: LightAtlasUniforms;
  /** CPU copy of the mask texture (tests, validAt) */
  readonly maskData = new Uint8Array(LA.CELLS * LA.CELLS);
  readonly flickData = new Float32Array(16 * LA.TILES * LA.TILES * 4);
  private readonly slots: Slot[] = Array.from({ length: LA.TILES * LA.TILES }, newSlot);
  private readonly queue: number[] = [];
  private readonly atlasA = data3D(THREE.HalfFloatType);
  private readonly atlasB = data3D(THREE.UnsignedByteType);
  private readonly atlasC = data3D(THREE.HalfFloatType);
  private readonly maskTex: THREE.DataTexture;
  private readonly flickTex: THREE.DataTexture;
  // never-bound source wrappers: copyTextureToTexture takes the CPU texSubImage3D path for them
  private readonly wrap = new THREE.Data3DTexture(null, LV.NX, LV.NY, LV.NZ);
  private readonly dst = new THREE.Vector3();
  private frame = 0;
  private storey = -1;
  private maskDirty = true;

  constructor() {
    const mask = new THREE.DataTexture(this.maskData, LA.CELLS, LA.CELLS, THREE.RedFormat, THREE.UnsignedByteType);
    mask.wrapS = mask.wrapT = THREE.RepeatWrapping;
    mask.magFilter = mask.minFilter = THREE.NearestFilter;
    mask.generateMipmaps = false;
    mask.unpackAlignment = 1;
    mask.flipY = false;
    mask.colorSpace = THREE.NoColorSpace;
    mask.needsUpdate = true;
    this.maskTex = mask;
    const flick = new THREE.DataTexture(this.flickData, 16, LA.TILES * LA.TILES, THREE.RGBAFormat, THREE.FloatType);
    flick.magFilter = flick.minFilter = THREE.NearestFilter;
    flick.generateMipmaps = false;
    flick.flipY = false;
    flick.colorSpace = THREE.NoColorSpace;
    flick.needsUpdate = true;
    this.flickTex = flick;
    this.atlasA.name = 'LightAtlas.A';
    this.atlasB.name = 'LightAtlas.B';
    this.atlasC.name = 'LightAtlas.C';
    this.uniforms = {
      uLaA: { value: this.atlasA }, uLaB: { value: this.atlasB }, uLaC: { value: this.atlasC },
      uLaMask: { value: mask }, uLaFlick: { value: flick }, uLaCamMod: { value: new THREE.Vector3() },
    };
  }

  /** Slots waiting for their upload (tests / debug). */
  get queued(): number { return this.queue.length; }

  /** Whether the cell holding world (x, z) has valid atlas data. */
  validAt(x: number, z: number): boolean {
    const gi = Math.floor(x / CELL + 1e-7), gj = Math.floor(z / CELL + 1e-7);
    return (this.maskData[laMaskIndex(gi, gj)] & LA_BIT.VALID) !== 0;
  }

  /** CPU, once per frame after the flicker update: the window around the eye, the slots to (re)upload, and the
   * flicker rows. Tiles without uploaded volumes (not ready, or test fakes) count as absent. */
  plan(tiles: Iterable<TileRuntime>, storey: number, eyeX: number, eyeZ: number, world: WorldQuery | null): void {
    this.frame++;
    if (storey !== this.storey) {
      this.storey = storey;
      for (let i = 0; i < this.slots.length; i++) this.invalidate(i);
    }
    const gx0 = Math.floor(eyeX / TILE_SIZE), gz0 = Math.floor(eyeZ / TILE_SIZE);
    const half = (LA.TILES - 1) >> 1;
    for (const tile of tiles) {
      if (tile.state === 'disposed' || tile.key.s !== storey) continue;
      const gtx = globalTileX(tile.key), gtz = globalTileZ(tile.key);
      if (Math.abs(gtx - gx0) > half || Math.abs(gtz - gz0) > half) continue;
      const v = volumesOf(tile);
      if (!v) continue;
      const si = laSlot(gtx) + LA.TILES * laSlot(gtz);
      const s = this.slots[si];
      if (s.tile !== tile || s.gtx !== gtx || s.gtz !== gtz) {
        // another tile's data sits in the slot: never sample it at this tile's place
        this.invalidate(si);
        s.tile = tile; s.gtx = gtx; s.gtz = gtz;
      }
      s.seen = this.frame;
      if (s.a !== v.a || s.av !== v.a.version || s.b !== v.b || s.bv !== v.b.version || s.c !== v.c ||
        (v.c !== null && s.cv !== v.c.version) || s.m !== v.m || s.mv !== v.m.version) {
        s.a = v.a; s.av = v.a.version; s.b = v.b; s.bv = v.b.version; s.c = v.c; s.cv = v.c ? v.c.version : -1;
        s.m = v.m; s.mv = v.m.version;
        s.layout = world ? world.layoutAt(tile.key.cx, tile.key.cz) : null;
        if (!s.pending) { s.pending = true; this.queue.push(si); }
      }
      s.prio = Math.max(Math.abs(gtx - gx0), Math.abs(gtz - gz0));
      // flicker rows: channel k in quadrant q -> the tile's flicker colour
      const fl = tile.materials.bindings.flick.value;
      const par = tile.materials.bindings.ownParity.value;
      const px = par.x | 0, pz = par.y | 0;
      const row = si * 16 * 4;
      for (let q = 0; q < 4; q++) {
        for (let k = 0; k < 4; k++) {
          const o = channelSlot(k, q & 1, q >> 1, px, pz) * 3;
          const d = row + (q * 4 + k) * 4;
          this.flickData[d] = fl[o]; this.flickData[d + 1] = fl[o + 1]; this.flickData[d + 2] = fl[o + 2];
          this.flickData[d + 3] = 1;
        }
      }
    }
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.tile !== null && s.seen !== this.frame) this.invalidate(i);
    }
    // nearest first
    if (this.queue.length > 1) this.queue.sort((x, y) => this.slots[x].prio - this.slots[y].prio);
  }

  /** GPU (the 'lightAtlas' hook): upload queued slots, the mask and the flicker rows; set the camera uniform. */
  sync(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    let n = 0;
    while (this.queue.length > 0 && n < LA.UPLOADS_PER_FRAME) {
      const si = this.queue.shift() as number;
      const s = this.slots[si];
      s.pending = false;
      if (!s.tile || !s.a || !s.b || !s.m) continue;
      const sx = si % LA.TILES, sz = (si / LA.TILES) | 0;
      this.dst.set(sx * LV.NX, 0, sz * LV.NZ);
      this.copy(renderer, dataOf(s.a) as Uint16Array, this.atlasA);
      this.copy(renderer, dataOf(s.b) as Uint8Array, this.atlasB);
      this.copy(renderer, (s.c ? dataOf(s.c) as Uint16Array : null) ?? ZERO_C, this.atlasC);
      this.writeMask(si, s, true);
      s.valid = true;
      n++;
    }
    this.wrap.image.data = null;
    if (this.maskDirty) { this.maskTex.needsUpdate = true; this.maskDirty = false; }
    this.flickTex.needsUpdate = true;
    const p = camera.position;
    this.uniforms.uLaCamMod.value.set(p.x - LA.SPAN * Math.floor(p.x / LA.SPAN), p.y, p.z - LA.SPAN * Math.floor(p.z / LA.SPAN));
  }

  dispose(): void {
    this.atlasA.dispose();
    this.atlasB.dispose();
    this.atlasC.dispose();
    this.maskTex.dispose();
    this.flickTex.dispose();
    this.queue.length = 0;
  }

  private copy(renderer: THREE.WebGLRenderer, data: Uint16Array | Uint8Array, dst: THREE.Data3DTexture): void {
    (this.wrap.image as { data: unknown }).data = data;
    renderer.copyTextureToTexture(this.wrap, dst, null, this.dst);
  }

  /** Clear a slot: its mask cells lose VALID (never sampled again until re-uploaded). */
  private invalidate(si: number): void {
    const s = this.slots[si];
    if (s.valid) this.writeMask(si, s, false);
    s.valid = false;
    s.tile = null;
    s.a = s.b = s.c = s.m = null;
    s.av = s.bv = s.cv = s.mv = -1;
    s.layout = null;
    if (s.pending) {
      s.pending = false;
      const k = this.queue.indexOf(si);
      if (k >= 0) this.queue.splice(k, 1);
    }
  }

  /** The slot's 16 x 16 mask cells: wall bits of the tile's wall mask, TOWER from the layout, VALID. */
  private writeMask(si: number, s: Slot, valid: boolean): void {
    const sx = si % LA.TILES, sz = (si / LA.TILES) | 0;
    const wm = valid ? dataOf(s.m) as Uint8Array : null;
    const lay = valid ? s.layout : null;
    const q = s.tile ? s.tile.key.q : 0;
    const li0 = (q & 1) * TILE_CELLS, lj0 = (q >> 1) * TILE_CELLS;
    for (let cj = 0; cj < TILE_CELLS; cj++) {
      for (let ci = 0; ci < TILE_CELLS; ci++) {
        const o = (sz * TILE_CELLS + cj) * LA.CELLS + sx * TILE_CELLS + ci;
        if (!valid || !wm) { this.maskData[o] = 0; continue; }
        let m = wm[((cj + 1) * MASK_N + (ci + 1)) * 4] & LA_BIT.WALLS;
        if (lay && (lay.flags[(lj0 + cj) * CHUNK_CELLS + li0 + ci] & CellFlag.TOWER)) m |= LA_BIT.TOWER;
        this.maskData[o] = m | LA_BIT.VALID;
      }
    }
    this.maskDirty = true;
  }
}
