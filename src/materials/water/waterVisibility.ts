// src/materials/water/waterVisibility.ts — whether a water surface drew a visible pixel lately (perf pass). Every
// water mesh's draw in the view render (the late render on split frames, the main render otherwise; the planar
// reflection and the probe hide water) runs inside an ANY_SAMPLES_PASSED_CONSERVATIVE occlusion query:
// stream/TileObject.ts installs WATER_VIS.before / after as the water meshes' onBeforeRender / onAfterRender.
// PlanarReflection polls the finished queries once per update and skips its mirrored view of the scene (about 0.3 ms
// at high 1080p and 0.5-0.8 ms at ultra where water behind a wall is gated) while no water pixel has passed the
// depth test for HOLD_MS.
// - The water scan (app/loop.ts nearestWaterPlane) finds planes within 40 m ahead of the eye, not whether a wall hides
//   them: a film or pool behind the wall of a warehouse, a pipe corridor or a dark office cost a mirror every frame.
// - Only where the water is the mirror's sole reader (PlanarReflection.setQuality: the SSR / froxel presets compile
//   the floors' planar path out, chunks/lighting.ts): elsewhere a reflective floor at the water plane may be visible
//   while the water is not.
// - Results arrive a frame or two after the draw: water coming into view shows its probe / environment reflection
//   (what it shows beyond the mirrored plane anyway) for those frames. HOLD_MS keeps the mirror through brief
//   occlusions (a pillar sweeping past, the view bob at a screen edge), so it does not toggle.
// - Without occlusion queries, or while a result is overdue, the water counts as visible (the unconditional mirror).
// Times are wall-clock (performance.now()), so the decision is the same under time= and inside gpuBench's bursts.

import type * as THREE from 'three';

export const WATER_VIS_TUNE = {
  /** ms: the mirror keeps rendering this long after a water draw that passed the depth test */
  HOLD_MS: 500,
  /** ms: a query unanswered for this long makes the water count as visible */
  OVERDUE_MS: 500,
  /** outstanding queries at most (gpuBench renders 20 frames between polls); further draws go unqueried */
  MAX_PENDING: 64,
} as const;

/** The GL entry points the tracker uses (WebGL2RenderingContext; a fake in tests). */
export interface QueryGl {
  readonly ANY_SAMPLES_PASSED_CONSERVATIVE: number;
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
  createQuery(): WebGLQuery | null;
  beginQuery(target: number, q: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(q: WebGLQuery, pname: number): unknown;
}

export interface WaterVisibility {
  /** issue queries around water draws (false: before / after do nothing) */
  enabled: boolean;
  /** onBeforeRender of a water mesh: open a query for its draw */
  before(gl: QueryGl): void;
  /** onAfterRender of a water mesh: close it */
  after(gl: QueryGl): void;
  /** Read the finished queries; true while water was visible within HOLD_MS (or unknown). */
  poll(gl: QueryGl): boolean;
  /** forget every result (a quality switch: the next poll starts from 'not seen') */
  reset(): void;
  /** queries in flight (tests, debug) */
  readonly pending: number;
}

/** `now`: the wall clock in ms (injectable for tests). */
export function createWaterVisibility(now: () => number = () => performance.now()): WaterVisibility {
  const free: WebGLQuery[] = [];
  const pending: { q: WebGLQuery; at: number }[] = [];
  let active: WebGLQuery | null = null;
  let activeAt = 0;
  let lastSeen = -Infinity;
  let broken = false; // no query support: always visible
  const api: WaterVisibility = {
    enabled: false,
    before(gl) {
      if (!api.enabled || broken || active || pending.length >= WATER_VIS_TUNE.MAX_PENDING) return;
      const q = free.pop() ?? gl.createQuery();
      if (!q) { broken = true; return; }
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q);
      active = q;
      activeAt = now();
    },
    after(gl) {
      if (!active) return;
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      pending.push({ q: active, at: activeAt });
      active = null;
    },
    poll(gl) {
      if (broken) return true;
      const t = now();
      let n = 0;
      for (; n < pending.length; n++) {
        const p = pending[n];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (gl.getQueryParameter(p.q, gl.QUERY_RESULT)) lastSeen = Math.max(lastSeen, p.at);
        free.push(p.q);
      }
      if (n > 0) pending.splice(0, n);
      if (pending.length > 0 && t - pending[0].at > WATER_VIS_TUNE.OVERDUE_MS) lastSeen = t;
      return t - lastSeen <= WATER_VIS_TUNE.HOLD_MS;
    },
    reset() {
      lastSeen = -Infinity;
    },
    get pending() { return pending.length; },
  };
  return api;
}

/** The app's tracker (one GL context): TileObject's water meshes feed it, PlanarReflection reads it. */
export const WATER_VIS = createWaterVisibility();

/** Object3D.onBeforeRender / onAfterRender pair for a water mesh. */
export const waterQueryBefore = (renderer: THREE.WebGLRenderer): void => {
  if (WATER_VIS.enabled) WATER_VIS.before(renderer.getContext() as WebGL2RenderingContext);
};
export const waterQueryAfter = (renderer: THREE.WebGLRenderer): void => {
  WATER_VIS.after(renderer.getContext() as WebGL2RenderingContext);
};
