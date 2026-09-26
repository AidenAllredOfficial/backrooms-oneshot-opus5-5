// src/lighting/LightingRuntime.ts — flicker uniforms, atmosphere globals and flashlight (WP11).
// Per frame (DESIGN §5.WP11 "LightingRuntime.update"):
//  1. every resident tile's bindings.flick (9 x vec3) = color/luma(color) * intensity; each dynamic light is
//     evaluated once per frame (cache by id; setOverride wins, e.g. ANOMALY lights driven by the director);
//  2. lightToggle on 0.5 crossings;
//  3. atmosphere at the camera: ATMOSPHERES[zoneAt] x MOOD_MODS[moodAt], 1.5 s crossfade; camIrradiance from the
//     player tile's light volume (CPU half data, trilinear, wall-clamped, tower y-wrap); farColor (slow local mean
//     irradiance x haze x FAR_FRACTION x FAR_WARM); edge fog; flashlight/flicker hints for the post stack;
//     writes the MaterialGlobals and scene.background;
//  4. flashlight rig.
// Allocation-free per frame (payload objects for bus events are reused: handlers must copy what they keep).

import * as THREE from 'three';
import { CELL, CHUNK_CELLS, CHUNK_SIZE, EDGE_FOG, LV, TILE_SIZE } from '../core/constants.ts';
import type { GameBus, GameEvents } from '../core/events.ts';
import { flicker } from '../core/flicker.ts';
import type { FlickerSample } from '../core/flicker.ts';
import { worldToCell } from '../core/grid.ts';
import { fromHalf } from '../core/half.ts';
import { CellFlag } from '../core/ids.ts';
import type { LightStateId } from '../core/ids.ts';
import type { PlayerState } from '../core/player.ts';
import type { QualityConfig } from '../core/quality.ts';
import type { FlickerMode, Settings } from '../core/settings.ts';
import type {
  AtmosphereState, LightingRuntime, MaterialGlobals, TextureSet, TileRuntime, WorldQuery,
} from '../core/runtime.ts';
import { copyParams, createAtmosphereBlender, newAtmosphereState } from './atmosphereBlend.ts';
import { LANDMARK_EV_MIN } from './atmospheres.ts';
import { createFlashlight } from './Flashlight.ts';
import type { FlashlightRig } from './Flashlight.ts';

export const FLICKER_MODE_INDEX: Readonly<Record<FlickerMode, number>> = { standard: 0, reduced: 1, off: 2 };
/** Fraction of the camera-local inscatter used as the far / clear colour (edge fog target). R2-post: 0.3 -> 0.14 and
 * warmer (FAR_WARM), from a slowly averaged local irradiance, so the streaming edge falls into a warm grey-brown
 * gloom instead of a flat grey-green wall (quality=low puts the edge fog at ~31 m). */
export const FAR_FRACTION = 0.14;
export const FAR_WARM: readonly [number, number, number] = [1.0, 0.9, 0.74];
const FAR_TAU = 3; // s, local mean irradiance smoothing for the far colour
const DEFAULT_IRRADIANCE = 150; // lux, before the first light-volume read (loading)
const IRR_TAU = 0.25; // s, camera irradiance smoothing
const SLOTS = 9;
const PRUNE_EVERY = 240; // frames

const luma709 = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Trilinear light-volume lookup of rgb irradiance (lux) at a tile-local point. Returns false if no data. */
export function sampleLightVolume(
  data: Uint16Array, mask: Uint8Array | null, lx: number, y: number, lz: number, tower: boolean, out: Float64Array,
): boolean {
  const n = LV.NX * LV.NY * LV.NZ * 4;
  if (data.length < n) return false;
  // wall clamp: stay >= 0.3 m inside the own cell on occluding sides (like the WP9 props shader)
  if (mask && mask.length >= 18 * 18 * 4) {
    const ci = Math.min(15, Math.max(0, Math.floor(lx / CELL)));
    const cj = Math.min(15, Math.max(0, Math.floor(lz / CELL)));
    const bits = mask[((cj + 1) * 18 + (ci + 1)) * 4];
    const x0 = ci * CELL, z0 = cj * CELL;
    if (bits & 1) lz = Math.max(lz, z0 + 0.3); // N (-z)
    if (bits & 2) lx = Math.min(lx, x0 + CELL - 0.3); // E (+x)
    if (bits & 4) lz = Math.min(lz, z0 + CELL - 0.3); // S (+z)
    if (bits & 8) lx = Math.max(lx, x0 + 0.3); // W (-x)
  }
  if (tower) y = 1.5 + (((y - 1.5) % 3) + 3) % 3;
  const fi = Math.min(LV.NX - 1, Math.max(0, lx / LV.STEP - 0.5));
  const fj = Math.min(LV.NZ - 1, Math.max(0, lz / LV.STEP - 0.5));
  const Y = LV.Y;
  let k0 = 0;
  let wy = 0;
  if (y <= Y[0]) { k0 = 0; wy = 0; } else if (y >= Y[LV.NY - 1]) { k0 = LV.NY - 2; wy = 1; } else {
    while (k0 < LV.NY - 2 && y > Y[k0 + 1]) k0++;
    wy = (y - Y[k0]) / (Y[k0 + 1] - Y[k0]);
  }
  const i0 = Math.min(LV.NX - 2, Math.floor(fi)), j0 = Math.min(LV.NZ - 2, Math.floor(fj));
  const wx = fi - i0, wz = fj - j0;
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let c = 0; c < 8; c++) {
    const di = c & 1, dk = (c >> 1) & 1, dj = c >> 2;
    const w = (di ? wx : 1 - wx) * (dk ? wy : 1 - wy) * (dj ? wz : 1 - wz);
    if (w === 0) continue;
    const idx = (((j0 + dj) * LV.NY + (k0 + dk)) * LV.NX + (i0 + di)) * 4;
    out[0] += w * fromHalf(data[idx]);
    out[1] += w * fromHalf(data[idx + 1]);
    out[2] += w * fromHalf(data[idx + 2]);
  }
  return Number.isFinite(out[0] + out[1] + out[2]);
}


/** LANDMARK_EV_MIN of the landmark whose footprint holds cell (gi, gj) of chunk (pcx, pcz); 0 when none. */
function landmarkEvMin(world: WorldQuery, gi: number, gj: number, pcx: number, pcz: number): number {
  const lay = world.layoutAt(pcx, pcz);
  if (!lay || lay.landmarks.length === 0) return 0;
  const li = gi - pcx * CHUNK_CELLS, lj = gj - pcz * CHUNK_CELLS;
  if (!(lay.flags[lj * CHUNK_CELLS + li] & CellFlag.LANDMARK)) return 0;
  for (const lm of lay.landmarks) {
    if (li >= lm.i0 && li < lm.i1 && lj >= lm.j0 && lj < lm.j1) return LANDMARK_EV_MIN[lm.kind] ?? 0;
  }
  return 0;
}

export function createLightingRuntime(scene: THREE.Scene, globals: MaterialGlobals, textures: TextureSet, q: QualityConfig, s: Settings, bus: GameBus): LightingRuntime {
  const flashlight: FlashlightRig = createFlashlight(scene, textures.cookie, q, bus);
  let quality = q;
  let mode: FlickerMode = s.flicker;

  // ---- dynamic light state (per id)
  const stamp = new Map<number, number>(); // id -> frame of last evaluation
  const cur = new Map<number, number>(); // id -> intensity this frame
  const onState = new Map<number, boolean>(); // id -> i >= 0.5 last frame
  const overrides = new Map<number, number>();
  const pendingToggle = new Map<number, number>(); // id -> frame of an onState change not yet emitted
  const sample: FlickerSample = { i: 0, tint: 0, buzz: 0 };
  const toggle: GameEvents['lightToggle'] = { lightId: 0, on: false, x: 0, y: 0, z: 0 };
  let frame = 0;
  let dynamicResident = 0;

  // ---- atmosphere
  const blender = createAtmosphereBlender();
  const atm: AtmosphereState = newAtmosphereState();
  const camIrr = new Float64Array([DEFAULT_IRRADIANCE, DEFAULT_IRRADIANCE, DEFAULT_IRRADIANCE]);
  const meanIrr = new Float64Array([DEFAULT_IRRADIANCE, DEFAULT_IRRADIANCE, DEFAULT_IRRADIANCE]);
  const irrTmp = new Float64Array(3);
  let irrValid = false;
  const background = new THREE.Color(0, 0, 0);
  scene.background = background;
  let lastEyeX = NaN, lastEyeZ = NaN;

  const setEdgeFog = (): void => {
    const r = quality.streamRadius * CHUNK_SIZE;
    atm.edgeFog[0] = EDGE_FOG.START * r;
    atm.edgeFog[1] = EDGE_FOG.END * r;
  };
  setEdgeFog();
  copyParams(atm, blender.update(0, 0, 0, true));

  const writeGlobals = (): void => {
    globals.hazeDensity.value = atm.hazeDensity;
    globals.hazeTint.value.setRGB(atm.hazeTint[0], atm.hazeTint[1], atm.hazeTint[2]);
    globals.hazeAlbedo.value = atm.hazeAlbedo;
    globals.edgeFog.value.set(atm.edgeFog[0], atm.edgeFog[1]);
    const k = (atm.hazeAlbedo / Math.PI) * FAR_FRACTION;
    const r = meanIrr[0] * k * atm.hazeTint[0] * FAR_WARM[0];
    const g = meanIrr[1] * k * atm.hazeTint[1] * FAR_WARM[1];
    const b = meanIrr[2] * k * atm.hazeTint[2] * FAR_WARM[2];
    globals.farColor.value.setRGB(r, g, b);
    background.setRGB(r, g, b);
    if (scene.background !== background) scene.background = background;
    globals.flickerMode.value = FLICKER_MODE_INDEX[mode];
  };
  atm.camIrradiance[0] = camIrr[0]; atm.camIrradiance[1] = camIrr[1]; atm.camIrradiance[2] = camIrr[2];
  writeGlobals();

  const evalLight = (id: number, state: LightStateId, seed: number, t: number): number => {
    if (stamp.get(id) === frame) return cur.get(id) as number;
    const ov = overrides.get(id);
    let i: number;
    if (ov !== undefined) i = ov;
    else { flicker(state, seed, t, mode, sample); i = sample.i; }
    stamp.set(id, frame);
    cur.set(id, i);
    dynamicResident++;
    return i;
  };

  const rt: LightingRuntime = {
    flashlight,
    update(t: number, dt: number, tiles: Iterable<TileRuntime>, player: PlayerState, camera: THREE.Camera, world: WorldQuery) {
      frame++;
      dynamicResident = 0;
      const ex = player.eyeX, ey = player.eyeY, ez = player.eyeZ;
      const gi = worldToCell(ex), gj = worldToCell(ez);
      const pcx = Math.floor(gi / CHUNK_CELLS), pcz = Math.floor(gj / CHUNK_CELLS);
      const pq = (((gi - pcx * CHUNK_CELLS) >> 4) & 1) | ((((gj - pcz * CHUNK_CELLS) >> 4) & 1) << 1);
      let playerTile: TileRuntime | null = null;

      // 1-2. flicker uniforms + toggles
      for (const tile of tiles) {
        if (tile.state === 'disposed') continue;
        const k = tile.key;
        if (k.s === player.s && k.cx === pcx && k.cz === pcz && k.q === pq) playerTile = tile;
        const f = tile.materials.bindings.flick.value;
        const dl = tile.dynLights;
        for (let sl = 0; sl < SLOTS; sl++) {
          const ref = sl < dl.length ? dl[sl] : null;
          const o = sl * 3;
          if (!ref) { f[o] = 0; f[o + 1] = 0; f[o + 2] = 0; continue; }
          const first = stamp.get(ref.id) !== frame;
          const i = evalLight(ref.id, ref.state, ref.seed, t);
          const c = ref.color;
          const l = Math.max(1e-4, luma709(c[0], c[1], c[2]));
          const m = i / l;
          f[o] = c[0] * m; f[o + 1] = c[1] * m; f[o + 2] = c[2] * m;
          if (first) {
            const on = i >= 0.5;
            const prev = onState.get(ref.id);
            if (prev === undefined) onState.set(ref.id, on);
            else if (prev !== on) {
              onState.set(ref.id, on);
              pendingToggle.set(ref.id, frame);
            }
          }
          // only lights of the player's storey are audible: a toggle first seen through a hidden (prefetched)
          // storey's tile is emitted once a current-storey tile references the same light this frame
          if (k.s === player.s && pendingToggle.get(ref.id) === frame) {
            pendingToggle.delete(ref.id);
            toggle.lightId = ref.id; toggle.on = onState.get(ref.id) === true;
            toggle.x = ref.x; toggle.y = ref.y; toggle.z = ref.z;
            bus.emit('lightToggle', toggle);
          }
        }
      }
      if (frame % PRUNE_EVERY === 0) {
        for (const [id, f] of stamp) {
          if (f < frame - 30) { stamp.delete(id); cur.delete(id); onState.delete(id); }
        }
        pendingToggle.clear();
      }

      // 3. atmosphere at the eye (cell-based zone/mood)
      const jumped = !Number.isFinite(lastEyeX) || Math.abs(ex - lastEyeX) + Math.abs(ez - lastEyeZ) > 6;
      lastEyeX = ex; lastEyeZ = ez;
      const snap = !(dt > 0) || jumped;
      const zone = world.zoneAt(ex, ez);
      const mood = world.moodAt(ex, ez);
      copyParams(atm, blender.update(zone, mood, dt, snap));
      const lmEv = landmarkEvMin(world, gi, gj, pcx, pcz);
      if (lmEv > atm.ev100Range[0]) {
        atm.ev100Range[0] = lmEv;
        atm.ev100Range[1] = Math.max(atm.ev100Range[1], lmEv + 0.5);
      }

      // camera irradiance from the player tile's light volume
      if (playerTile) {
        const b = playerTile.materials.bindings;
        const img = (b.volA.value as { image?: { data?: unknown } }).image;
        const data = img && img.data instanceof Uint16Array ? img.data : null;
        const mimg = (b.volMask.value as { image?: { data?: unknown } }).image;
        const mdata = mimg && mimg.data instanceof Uint8Array ? mimg.data : null;
        if (data) {
          const ox = pcx * CHUNK_SIZE + (pq & 1) * TILE_SIZE;
          const oz = pcz * CHUNK_SIZE + (pq >> 1) * TILE_SIZE;
          let tower = false;
          const lay = world.layoutAt(pcx, pcz);
          if (lay) {
            const li = gi - pcx * CHUNK_CELLS, lj = gj - pcz * CHUNK_CELLS;
            tower = (lay.flags[lj * CHUNK_CELLS + li] & CellFlag.TOWER) !== 0;
          }
          if (sampleLightVolume(data, mdata, ex - ox, ey, ez - oz, tower, irrTmp)) {
            if (!irrValid || snap) {
              camIrr[0] = irrTmp[0]; camIrr[1] = irrTmp[1]; camIrr[2] = irrTmp[2]; irrValid = true;
              meanIrr[0] = irrTmp[0]; meanIrr[1] = irrTmp[1]; meanIrr[2] = irrTmp[2];
            } else {
              const a = 1 - Math.exp(-dt / IRR_TAU);
              camIrr[0] += (irrTmp[0] - camIrr[0]) * a;
              camIrr[1] += (irrTmp[1] - camIrr[1]) * a;
              camIrr[2] += (irrTmp[2] - camIrr[2]) * a;
              const am = 1 - Math.exp(-dt / FAR_TAU);
              meanIrr[0] += (irrTmp[0] - meanIrr[0]) * am;
              meanIrr[1] += (irrTmp[1] - meanIrr[1]) * am;
              meanIrr[2] += (irrTmp[2] - meanIrr[2]) * am;
            }
          }
        }
      }
      atm.camIrradiance[0] = camIrr[0]; atm.camIrradiance[1] = camIrr[1]; atm.camIrradiance[2] = camIrr[2];
      atm.flashlight = flashlight.on ? 1 : 0;
      atm.flickerMode = FLICKER_MODE_INDEX[mode];
      setEdgeFog();
      writeGlobals();

      // 4. flashlight
      flashlight.update(player, camera, dt);
    },
    intensityOf(lightId) {
      const ov = overrides.get(lightId);
      if (ov !== undefined) return ov;
      const i = cur.get(lightId);
      return i === undefined ? 1 : i;
    },
    setOverride(lightId, intensity) {
      if (intensity === null) overrides.delete(lightId);
      else overrides.set(lightId, Math.max(0, Math.min(1.1, intensity)));
    },
    atmosphere() {
      return atm;
    },
    setFlickerMode(m) {
      mode = m;
      globals.flickerMode.value = FLICKER_MODE_INDEX[m];
    },
    setQuality(nq) {
      quality = nq;
      flashlight.setQuality(nq);
      setEdgeFog();
      writeGlobals();
    },
  };
  // QA counters (DebugStats.lights.dynamicResident) without widening the contract
  lightingInfo.set(rt, { get dynamicResident() { return dynamicResident; }, get mode() { return mode; } });
  return rt;
}

const lightingInfo = new WeakMap<LightingRuntime, { readonly dynamicResident: number; readonly mode: FlickerMode }>();
/** Debug counters of a runtime created by createLightingRuntime (WP14 F3 overlay / stats). */
export function lightingStats(rt: LightingRuntime): { dynamicResident: number; flickerMode: FlickerMode } {
  const i = lightingInfo.get(rt);
  return { dynamicResident: i ? i.dynamicResident : 0, flickerMode: i ? i.mode : 'standard' };
}
