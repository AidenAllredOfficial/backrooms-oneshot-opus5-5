// src/materials/water/WaterRipples.ts — package E: the interactive ripple heightfield around the player.
//
// A world-anchored N x N window (N = q.waterRippleRes texels of q.waterRippleTexel m, snapped to whole texels, so the
// waves never swim while it follows the eye) over the water plane the player stands in or is nearest (within 6 m).
// Two HalfFloat RGBA ping-pong targets hold (h(t), h(t - dt), foam, 0); a fixed 1/60 s step integrates the damped
// wave equation h' = (2h - h_prev + C^2 lap h) damp with reflecting (Neumann) walls from a per-window cell mask
// (rippleSources.ts buildRippleMask) and adds gaussian impulses: footsteps and wading wakes (bus 'footstep', player
// state), idle sway, drips falling into the window. At most 4 steps per frame; none when the simulation clock is
// frozen (time=), so captures stay deterministic (__backrooms.water.poke / step drive it there). Drips outside the
// window become analytic rings in the water shader (uDrips). Only the water shader samples the result (uRipple:
// the surface programs have no free sampler). The water shader interpolates the last two steps (RIPPLE_LERP).

import * as THREE from 'three';
import { CELL } from '../../core/constants.ts';
import type { GameBus } from '../../core/events.ts';
import type { PlayerState } from '../../core/player.ts';
import type { QualityConfig } from '../../core/quality.ts';
import type { MaterialGlobals } from '../../core/runtime.ts';
import { RIPPLE_LERP } from '../WaterMaterial.ts';
import {
  buildRippleMask, collectDrips, courant2, dampOf, dropsBetween, footstepImpulse, maskCell0, nearestWaterPlane, RIPPLE,
  rippleWindow, simulatedPlane, swayDue, wakeImpulses,
  type DripSource, type Impulse, type RippleWindow, type RippleWorld,
} from './rippleSources.ts';

export interface WaterRippleStats {
  enabled: boolean; on: boolean; plane: number | null; kind: number; res: number; texel: number; span: number;
  origin: [number, number]; steps: number; impulses: number; drips: number; dripsSim: number; maskCells: number; maskBuilds: number;
}

export interface WaterRipples {
  /** per frame, inside the GPU timer: window, mask, impulses, fixed steps (dtSim = simulation dt, 0 when frozen) */
  update(r: THREE.WebGLRenderer, dtSim: number, t: number, st: PlayerState, world: RippleWorld): void;
  /** queue a footstep-sized impulse x amp at (dx right, dz forward) m from the eye (debug / automation) */
  poke(dx: number, dz: number, amp?: number): void;
  /** run n simulation steps now (frozen-time captures) */
  step(n: number): void;
  stats(): WaterRippleStats;
  setQuality(q: QualityConfig): void;
  /** drop the state (seed change, teleport) */
  reset(): void;
  dispose(): void;
}

const SIM_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPrev;
uniform sampler2D uMask;
uniform vec2 uShift; // texel shift of the window since the previous state (first step of a frame)
uniform float uN;
uniform float uDx;
uniform vec2 uMaskOff; // metres from the mask's first cell corner to the window's texel-0 corner
uniform float uC2;
uniform float uDamp;
uniform float uFoamDecay;
uniform vec4 uImp[ ${RIPPLE.MAX_IMPULSES} ]; // window-local x, z (m), amplitude (m), radius (m)
uniform int uNImp;
uniform vec4 uFoam[ ${RIPPLE.MAX_FOAM} ];
uniform int uNFoam;
ivec2 cellOf( ivec2 t ) { return ivec2( floor( ( uMaskOff + ( vec2( t ) + 0.5 ) * uDx ) / ${CELL.toFixed(4)} ) ); }
vec4 maskAt( ivec2 c ) {
	if ( any( lessThan( c, ivec2( 0 ) ) ) || any( greaterThanEqual( c, ivec2( ${RIPPLE.MASK_W} ) ) ) ) return vec4( 0.0 );
	return texelFetch( uMask, c, 0 );
}
vec4 prevAt( ivec2 t ) {
	ivec2 s = t + ivec2( uShift );
	int n = int( uN );
	if ( any( lessThan( s, ivec2( 0 ) ) ) || any( greaterThanEqual( s, ivec2( n ) ) ) ) return vec4( 0.0 );
	return texelFetch( uPrev, s, 0 );
}
void main() {
	ivec2 t = ivec2( gl_FragCoord.xy );
	ivec2 c = cellOf( t );
	vec4 m = maskAt( c );
	if ( m.r < 0.5 ) { gl_FragColor = vec4( 0.0 ); return; }
	int bits = int( m.g * 255.0 + 0.5 );
	vec4 p = prevAt( t );
	float lapH = 0.0, lapF = 0.0;
	for ( int k = 0; k < 4; k ++ ) {
		ivec2 d = k == 0 ? ivec2( 0, - 1 ) : k == 1 ? ivec2( 1, 0 ) : k == 2 ? ivec2( 0, 1 ) : ivec2( - 1, 0 );
		ivec2 tn = t + d;
		ivec2 cn = cellOf( tn );
		// a wall side of this cell (N1 E2 S4 W8) or a dry neighbour cell reflects: the neighbour mirrors this texel
		bool wall = cn != c && ( ( bits & ( 1 << k ) ) != 0 || maskAt( cn ).r < 0.5 );
		vec4 q = wall ? p : prevAt( tn );
		lapH += q.r - p.r;
		lapF += q.b - p.b;
	}
	float hn = ( 2.0 * p.r - p.g + uC2 * lapH ) * uDamp;
	float fn = p.b * uFoamDecay + 0.02 * lapF;
	vec2 x = ( vec2( t ) + 0.5 ) * uDx;
	for ( int i = 0; i < ${RIPPLE.MAX_IMPULSES}; i ++ ) {
		if ( i >= uNImp ) break;
		vec2 dv = x - uImp[ i ].xy;
		hn += uImp[ i ].z * exp( - dot( dv, dv ) / ( uImp[ i ].w * uImp[ i ].w ) );
	}
	for ( int i = 0; i < ${RIPPLE.MAX_FOAM}; i ++ ) {
		if ( i >= uNFoam ) break;
		vec2 dv = x - uFoam[ i ].xy;
		fn += uFoam[ i ].z * exp( - dot( dv, dv ) / ( uFoam[ i ].w * uFoam[ i ].w ) );
	}
	gl_FragColor = vec4( hn, p.r, clamp( fn, 0.0, 1.0 ), 0.0 );
}
`;

const vec4s = (n: number): THREE.Vector4[] => Array.from({ length: n }, () => new THREE.Vector4());

export function createWaterRipples(globals: MaterialGlobals, q: QualityConfig, bus: GameBus): WaterRipples {
  let res = 0, texel = 0;
  let targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  let cur = 0;
  let renderer: THREE.WebGLRenderer | null = null;
  const W = RIPPLE.MASK_W;
  const maskData = new Uint8Array(W * W * 4);
  const mask = new THREE.DataTexture(maskData, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  mask.minFilter = THREE.NearestFilter;
  mask.magFilter = THREE.NearestFilter;
  mask.generateMipmaps = false;

  const uniforms = {
    uPrev: { value: null as THREE.Texture | null },
    uMask: { value: mask },
    uShift: { value: new THREE.Vector2() },
    uN: { value: 1 },
    uDx: { value: 1 },
    uMaskOff: { value: new THREE.Vector2() },
    uC2: { value: 0 },
    uDamp: { value: 1 },
    uFoamDecay: { value: dampOf(RIPPLE.FOAM_TAU) },
    uImp: { value: vec4s(RIPPLE.MAX_IMPULSES) },
    uNImp: { value: 0 },
    uFoam: { value: vec4s(RIPPLE.MAX_FOAM) },
    uNFoam: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ name: 'br-water-ripples', uniforms, vertexShader: SIM_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(geo, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- state
  const win: RippleWindow = { i0: 0, j0: 0, originX: 0, originZ: 0, span: 0 };
  let active = false; // a plane is simulated and the window is valid
  let plane: number | null = null, kind = 0;
  let scanPlane: { y: number; kind: number } | null = null;
  let frame = 0, acc = 0, tSim = 0, lastSway = 0, dripWait = 0, scanWait = 0;
  let pendShiftX = 0, pendShiftZ = 0;
  let maskCi = NaN, maskCj = NaN, maskPlane = NaN, maskCells = 0, maskBuilds = 0;
  let steps = 0;
  const pending: Impulse[] = []; // one-shot height impulses (world)
  const pendingFoam: Impulse[] = [];
  const stepImp: Impulse[] = [];
  const drips: DripSource[] = [];
  let dripsSim = 0;
  let eyeX = 0, eyeZ = 0, yaw = 0;
  const wake: Impulse[] = [];
  // window alignment of the current texture content (the window moves every frame, the content on the next step)
  let texX = 0, texZ = 0;

  const clearColor = new THREE.Color();
  function clearTargets(): void {
    if (!targets || !renderer) return;
    const prevRT = renderer.getRenderTarget();
    renderer.getClearColor(clearColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of targets) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(clearColor, prevAlpha);
    renderer.setRenderTarget(prevRT);
    pendShiftX = pendShiftZ = 0;
    texX = win.originX;
    texZ = win.originZ;
  }

  function ensureTargets(): void {
    if (targets || res <= 0) return;
    const mk = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false,
    });
    targets = [mk(), mk()];
    targets[0].texture.name = 'br-water-ripples-a';
    targets[1].texture.name = 'br-water-ripples-b';
    cur = 0;
    clearTargets();
  }

  function applyQuality(nq: QualityConfig): void {
    const nr = Math.max(0, Math.floor(nq.waterRippleRes)), nt = nq.waterRippleTexel;
    if (nr === res && nt === texel) return;
    disposeTargets();
    res = nt > 0 ? nr : 0;
    texel = nt;
    active = false;
    plane = null;
    uniforms.uN.value = Math.max(1, res);
    uniforms.uDx.value = texel > 0 ? texel : 1;
    uniforms.uC2.value = texel > 0 ? courant2(texel) : 0;
    publish();
  }

  function disposeTargets(): void {
    if (targets) { targets[0].dispose(); targets[1].dispose(); }
    targets = null;
    globals.ripple.value = null;
  }

  /** window-local impulse uniforms from world impulses */
  function loadImpulses(list: readonly Impulse[], dst: THREE.Vector4[], max: number): number {
    let n = 0;
    for (let i = 0; i < list.length && n < max; i++) {
      const p = list[i];
      const x = p.x - win.originX, z = p.z - win.originZ;
      if (x < -0.5 || z < -0.5 || x > win.span + 0.5 || z > win.span + 0.5) continue;
      dst[n++].set(x, z, p.a, p.r);
    }
    return n;
  }

  /** one fixed step: first = the first of this frame (window shift + one-shot impulses) */
  function simStep(r: THREE.WebGLRenderer, first: boolean, extra: readonly Impulse[]): void {
    if (!targets) return;
    stepImp.length = 0;
    if (first) for (const p of pending) stepImp.push(p);
    for (const p of extra) stepImp.push(p);
    uniforms.uNImp.value = loadImpulses(stepImp, uniforms.uImp.value, RIPPLE.MAX_IMPULSES);
    uniforms.uNFoam.value = first ? loadImpulses(pendingFoam, uniforms.uFoam.value, RIPPLE.MAX_FOAM) : 0;
    uniforms.uShift.value.set(first ? pendShiftX : 0, first ? pendShiftZ : 0);
    uniforms.uPrev.value = targets[cur].texture;
    const prevRT = r.getRenderTarget();
    const prevClear = r.autoClear;
    r.autoClear = false; // the triangle covers every texel
    r.setRenderTarget(targets[1 - cur]);
    r.render(scene, cam);
    r.setRenderTarget(prevRT);
    r.autoClear = prevClear;
    cur = 1 - cur;
    if (first) { pending.length = 0; pendingFoam.length = 0; pendShiftX = pendShiftZ = 0; texX = win.originX; texZ = win.originZ; }
    steps++;
  }

  function rebuildMask(world: RippleWorld): void {
    const ci = maskCell0(win.i0, texel), cj = maskCell0(win.j0, texel);
    uniforms.uMaskOff.value.set(win.originX - ci * CELL, win.originZ - cj * CELL);
    if (ci === maskCi && cj === maskCj && plane === maskPlane) return;
    maskCi = ci; maskCj = cj; maskPlane = plane ?? NaN;
    maskCells = buildRippleMask(world, ci, cj, W, plane ?? 0, maskData);
    mask.needsUpdate = true;
    maskBuilds++;
  }

  function publish(): void {
    const g = globals;
    g.rippleOn.value = active && targets ? 1 : 0;
    g.ripple.value = targets ? targets[cur].texture : null;
    g.rippleOrigin.value.set(texX, texZ);
    g.rippleSpan.value = win.span > 0 ? win.span : 1;
    g.ripplePlane.value = plane ?? -1e4;
  }

  /** the drips: the ones falling into the window on the simulated plane become impulses when they drop, the others
   * analytic rings (uDrips, relative to the window origin) */
  function updateDrips(t0: number, t1: number): void {
    let nd = 0;
    dripsSim = 0;
    for (const s of drips) {
      const inside = active && plane !== null && Math.abs(s.y - plane) < 0.02 &&
        s.x > win.originX + 0.3 && s.z > win.originZ + 0.3 && s.x < win.originX + win.span - 0.3 && s.z < win.originZ + win.span - 0.3;
      if (inside) {
        dripsSim++;
        if (dropsBetween(t0, t1, s.period, s.phase) > 0 && pending.length < RIPPLE.MAX_IMPULSES) pending.push({ x: s.x, z: s.z, a: RIPPLE.DRIP_A, r: RIPPLE.DRIP_R });
      } else if (nd < RIPPLE.MAX_DRIPS) {
        globals.drips.value[nd++].set(s.x - texX, s.z - texZ, s.period, s.phase);
      }
    }
    globals.nDrips.value = nd;
  }

  const offFoot = bus.on('footstep', (e) => {
    if (!active || res <= 0) return;
    const imp = footstepImpulse(e.x, e.z, yaw, e.foot, e.intensity, e.waterDepth);
    if (imp && pending.length < RIPPLE.MAX_IMPULSES) pending.push(imp);
  });
  const offTeleport = bus.on('teleport', () => { api.reset(); });

  const api: WaterRipples = {
    update(r, dtSim, t, st, world) {
      renderer = r;
      frame++;
      eyeX = st.eyeX; eyeZ = st.eyeZ; yaw = st.yaw;
      if (res <= 0) return;
      // the simulation clock jumped (time= / setTime at the ready gate, a new seed): restart from still water, so
      // frozen-time captures never depend on how many steps ran while booting
      if (frame > 1 && t !== tSim + dtSim) {
        api.reset();
        tSim = t;
      }
      // the simulated plane: the water the player stands in, else the nearest one within NEAR_M of the eye
      if (--scanWait <= 0) {
        scanWait = RIPPLE.SCAN_FRAMES;
        const wp = nearestWaterPlane(world, st.eyeX, st.eyeY, st.eyeZ, -Math.sin(st.camYaw), -Math.cos(st.camYaw), RIPPLE.NEAR_M + 2);
        scanPlane = wp ? { y: wp.y, kind: wp.kind } : null;
      }
      const np = simulatedPlane(st.y, st.waterDepth, scanPlane ? scanPlane.y : null);
      const nk = scanPlane && np !== null && Math.abs(scanPlane.y - np) < 0.03 ? scanPlane.kind : kind;
      const oi = win.i0, oj = win.j0;
      rippleWindow(res, texel, st.eyeX, st.eyeZ, win);
      if (np === null) {
        active = false;
        plane = null;
      } else {
        ensureTargets();
        const planeChanged = plane === null || Math.abs(np - plane) > 0.02;
        if (planeChanged || !active) {
          clearTargets();
          acc = 0;
        } else {
          const sx = win.i0 - oi, sz = win.j0 - oj;
          if (Math.abs(sx + pendShiftX) >= res || Math.abs(sz + pendShiftZ) >= res) clearTargets();
          else { pendShiftX += sx; pendShiftZ += sz; }
        }
        plane = np;
        kind = nk;
        active = true;
        uniforms.uDamp.value = dampOf(RIPPLE.TAU[Math.min(Math.max(kind, 0), 2)]);
        rebuildMask(world);
      }
      // drips (collected every DRIP_FRAMES frames)
      if (--dripWait <= 0) {
        collectDrips(world, st.eyeX, st.eyeZ, RIPPLE.DRIP_RANGE, RIPPLE.MAX_DRIPS * 2, drips);
        dripWait = RIPPLE.DRIP_FRAMES;
      }
      const t0 = tSim;
      tSim = t;
      updateDrips(t0, t);
      // fixed steps
      if (active && dtSim > 0) {
        acc += dtSim;
        let n = Math.floor(acc / RIPPLE.DT);
        if (n > RIPPLE.MAX_STEPS) { n = RIPPLE.MAX_STEPS; acc = RIPPLE.DT; }
        acc -= n * RIPPLE.DT;
        if (st.waterDepth > RIPPLE.WAKE_MIN_DEPTH && st.speed < RIPPLE.WAKE_MIN_SPEED && swayDue(lastSway, t)) {
          // idle sway: the body rocks back and forth, alternating pushes
          const sgn = Math.floor(t / RIPPLE.SWAY_PERIOD) % 2 === 0 ? 1 : -1;
          for (const foot of [0, 1] as const) {
            const imp = footstepImpulse(st.x, st.z, st.yaw, foot, 1, st.waterDepth);
            if (imp && pending.length < RIPPLE.MAX_IMPULSES) pending.push({ ...imp, a: sgn * RIPPLE.SWAY_A });
          }
        }
        lastSway = t;
        wake.length = 0;
        if (wakeImpulses(st.x, st.z, st.yaw, st.vx, st.vz, st.waterDepth, wake) > 0 && pendingFoam.length < RIPPLE.MAX_FOAM - 1) {
          const fa = RIPPLE.WAKE_FOAM[Math.min(Math.max(kind, 0), 2)] * RIPPLE.DT * 4;
          for (let i = 0; i < wake.length; i += 2) pendingFoam.push({ x: wake[i].x, z: wake[i].z, a: fa, r: 0.12 });
        }
        for (let i = 0; i < n; i++) simStep(r, i === 0, wake);
        RIPPLE_LERP.value = acc / RIPPLE.DT;
      } else if (dtSim <= 0) {
        RIPPLE_LERP.value = 1;
      }
      publish();
    },
    poke(dx, dz, amp = 1) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const x = eyeX + rx * dx + fx * dz, z = eyeZ + rz * dx + fz * dz;
      if (pending.length < RIPPLE.MAX_IMPULSES) pending.push({ x, z, a: RIPPLE.FOOT_A * amp, r: RIPPLE.FOOT_R });
      if (pendingFoam.length < RIPPLE.MAX_FOAM) pendingFoam.push({ x, z, a: 0.3 * Math.min(Math.abs(amp), 2), r: 0.1 });
    },
    step(n) {
      const r = renderer;
      if (!r || !active || !targets) return;
      const k = Math.max(0, Math.min(600, Math.floor(n)));
      for (let i = 0; i < k; i++) simStep(r, i === 0, []);
      RIPPLE_LERP.value = 1;
      publish();
    },
    stats() {
      return {
        enabled: res > 0, on: active && targets !== null, plane, kind, res, texel, span: win.span,
        origin: [Math.round(win.originX * 1000) / 1000, Math.round(win.originZ * 1000) / 1000], steps,
        impulses: pending.length, drips: globals.nDrips.value, dripsSim, maskCells, maskBuilds,
      };
    },
    setQuality(nq) { applyQuality(nq); },
    reset() {
      active = false;
      plane = null;
      scanPlane = null;
      acc = 0;
      pending.length = 0;
      pendingFoam.length = 0;
      drips.length = 0;
      dripWait = 0;
      scanWait = 0;
      maskCi = maskCj = maskPlane = NaN;
      globals.nDrips.value = 0;
      clearTargets();
      publish();
    },
    dispose() {
      offFoot();
      offTeleport();
      disposeTargets();
      mask.dispose();
      material.dispose();
      geo.dispose();
      globals.rippleOn.value = 0;
      globals.nDrips.value = 0;
    },
  };
  applyQuality(q);
  return api;
}
