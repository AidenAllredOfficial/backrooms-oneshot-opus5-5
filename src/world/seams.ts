// src/world/seams.ts — the pure seam function: BOUNDARY / PATTERN / GLOBAL + artery overrides + port guarantee (WP1).
//
// seam(s, axis, cx, cz) describes the 32 edges of the WEST ('x') or NORTH ('z') border line of chunk (cx, cz).
// A = the chunk on the negative side (cx−1 or cz−1), B = (cx, cz). Both chunks call it, so both store the same
// line bit for bit.

import { CHUNK_CELLS } from '../core/constants.ts';
import { EDGE_WALKABLE, edgeDefaults } from '../core/edges.ts';
import { EdgeKind, EdgeTrim, SeamMode, type SeamModeId, type StoreyId, Zone, type ZoneId } from '../core/ids.ts';
import { hash01, hash5, hash6, rngFor, SALT, type Rng } from '../core/rng.ts';
import type { DistrictInfo, SeamEdges, SeamSpec, ZonePalette } from '../core/world.ts';
import { ZONE_INFO } from '../core/zones.ts';
import type { Districts } from './districts.ts';
import type { Sites } from './sites.ts';
import { defaultPatternSeam, patternRuns } from './zones/defaultSeam.ts';
import { generatorFor } from './zones/registry.ts';

const N = CHUNK_CELLS;
const MAX_WALL_RUN = 12;
const HEADER_WALKABLE_CM = 190;
const SOFT_P = 0.4;

/** Soft/hard is decided once per DISTRICT PAIR (order-independent), so every chunk seam of one district boundary
 * agrees: a boundary is either a continuous run of hard walls with styled openings or a soft, mostly open one.
 * (DESIGN §5 WP1 acceptance: "soft BOUNDARY seams are 40% ± 5% of eligible district pairs".) */
export function softPair(seed: number, s: StoreyId, idA: number, idB: number): boolean {
  const lo = idA >>> 0 < idB >>> 0 ? idA : idB, hi = lo === idA ? idB : idA;
  return hash01(hash5(seed, SALT.SEAM, s, lo | 0, hi | 0)) < SOFT_P;
}

export type SeamStyle = 'arch' | 'doorway' | 'rollup' | 'header' | 'wide';

/** Diagnostic classification of a seam (tests, tools/map). */
export interface SeamClass {
  mode: SeamModeId;
  boundary: boolean;
  /** BOUNDARY between two open zones or two Level 0 family zones (soft allowed). */
  softEligible: boolean;
  soft: boolean;
  style: SeamStyle | null; // hard boundaries only
  openings: number; // hard boundaries only (before artery overrides)
}

export interface Seams {
  seam(s: StoreyId, axis: 'x' | 'z', cx: number, cz: number): SeamSpec;
  classify(s: StoreyId, axis: 'x' | 'z', cx: number, cz: number): SeamClass;
}

/** Walkable edge for ports / connectivity (HEADER only when its underside is >= 190 cm). */
export const seamEdgeWalkable = (kind: number, hA: number): boolean =>
  EDGE_WALKABLE[kind] && (kind !== EdgeKind.HEADER || hA >= HEADER_WALKABLE_CM);

const isL0 = (z: ZoneId): boolean => z <= Zone.OFFICE;
const isOpenZone = (z: ZoneId): boolean => ZONE_INFO[z].open;

export function styleFor(zA: ZoneId, zB: ZoneId): SeamStyle {
  const has = (z: ZoneId): boolean => zA === z || zB === z;
  if (has(Zone.POOLROOMS)) return 'arch';
  if (has(Zone.OFFICE)) return 'doorway';
  if (has(Zone.PARKING) || has(Zone.WAREHOUSE)) return 'rollup';
  return 'header';
}

export function createSeams(
  seed: number, districts: Districts, sites: Sites, paletteOf: (s: StoreyId, d: DistrictInfo) => ZonePalette,
): Seams {
  const build = (s: StoreyId, axis: 'x' | 'z', cx: number, cz: number, cls: SeamClass | null): SeamSpec => {
    const ax = axis === 'x' ? 0 : 1;
    const acx = axis === 'x' ? cx - 1 : cx, acz = axis === 'x' ? cz : cz - 1;
    const dA = districts.districtAt(s, acx, acz);
    const dB = districts.districtAt(s, cx, cz);
    const pA = paletteOf(s, dA), pB = paletteOf(s, dB);
    const rng = rngFor(seed, SALT.SEAM, s, ax, cx, cz);
    const kind = new Uint8Array(N), hA = new Int16Array(N), hB = new Int16Array(N);
    const trim = new Uint8Array(N);
    // artery lanes crossing this line (post-rule 1 opens them; hard openings keep clear of them)
    const along = axis === 'x' ? cz : cx; // chunk coordinate along the line
    const lineG = N * (axis === 'x' ? cx : cz); // global line index
    const lanes: number[] = [];
    for (const spans of [sites.arteriesInChunk(cx, cz), sites.arteriesInChunk(acx, acz)]) {
      for (const a of spans) {
        if (a.axis !== axis || a.g0 > lineG || a.g1 < lineG) continue;
        for (let w = 0; w < 2; w++) {
          const idx = a.row + w - N * along;
          if (idx >= 0 && idx < N && !lanes.includes(idx)) lanes.push(idx);
        }
      }
    }
    let mode: SeamModeId;
    if (dA.id !== dB.id) {
      mode = SeamMode.BOUNDARY;
      const zA = dA.zone, zB = dB.zone;
      const eligible = (isOpenZone(zA) && isOpenZone(zB)) || (isL0(zA) && isL0(zB));
      const soft = eligible && softPair(seed, s, dA.id, dB.id);
      if (cls) { cls.boundary = true; cls.softEligible = eligible; cls.soft = soft; }
      if (soft) {
        patternRuns(rng, kind, 1, 3, 3, 8); // the zone change is carried by floorMat / soffits / lighting
      } else {
        const n = hardBoundary(rng, zA, zB, Math.min(pA.ceilCm, pB.ceilCm), lanes, kind, hA, trim, cls);
        if (cls) cls.openings = n;
      }
    } else {
      const gen = generatorFor(dB.zone);
      let e: SeamEdges;
      if (ZONE_INFO[dB.zone].seamMode === SeamMode.GLOBAL && gen.globalSeam) {
        mode = SeamMode.GLOBAL;
        e = gen.globalSeam({ seed, s, district: dB, axis, line: N * (axis === 'x' ? cx : cz), g0: N * (axis === 'x' ? cz : cx) });
      } else {
        mode = SeamMode.PATTERN;
        e = gen.seamPattern?.(rng, dB) ?? defaultPatternSeam(rng);
      }
      for (let i = 0; i < N; i++) {
        const k = e.kind[i] ?? EdgeKind.OPEN;
        kind[i] = k <= EdgeKind.GLITCH ? k : EdgeKind.WALL;
        hA[i] = e.hA[i] ?? 0;
        hB[i] = e.hB[i] ?? 0;
      }
    }
    if (cls) cls.mode = mode;
    // Heights: kinds that need one get the default when the source left it at 0.
    for (let i = 0; i < N; i++) {
      const d = edgeDefaults(kind[i]);
      if (d[0] !== 0 && hA[i] === 0) hA[i] = d[0];
      if (d[1] !== 0 && hB[i] === 0) hB[i] = d[1];
    }

    // ---- post-rule 1: artery lanes crossing the line are OPEN.
    for (const idx of lanes) { kind[idx] = EdgeKind.OPEN; hA[idx] = 0; hB[idx] = 0; trim[idx] = 0; }

    // ---- post-rule 2: PATTERN seams never have a non-walkable run > 12: break it at its middle with 2 OPEN.
    if (mode === SeamMode.PATTERN) {
      let changed = true;
      while (changed) {
        changed = false;
        let run = 0;
        for (let i = 0; i <= N; i++) {
          if (i < N && !seamEdgeWalkable(kind[i], hA[i])) { run++; continue; }
          if (run > MAX_WALL_RUN) {
            const a = i - run, mid = a + (run >> 1) - 1;
            for (let m = mid; m < mid + 2; m++) { kind[m] = EdgeKind.OPEN; hA[m] = 0; hB[m] = 0; trim[m] = 0; }
            changed = true;
          }
          run = 0;
        }
      }
    }

    // ---- post-rule 3: at least one walkable edge (port).
    let walkable = 0;
    for (let i = 0; i < N; i++) if (seamEdgeWalkable(kind[i], hA[i])) walkable++;
    if (walkable === 0) {
      const idx = 4 + (hash6(seed, SALT.SEAM, s, ax, cx, cz) % 24);
      kind[idx] = EdgeKind.OPEN; hA[idx] = 0; hB[idx] = 0; trim[idx] = 0;
    }

    // ---- post-rule 4: materials from the A (negative) / B (positive) palettes; baseboard where both have one.
    const matNeg = new Uint8Array(N).fill(pA.wallMat);
    const matPos = new Uint8Array(N).fill(pB.wallMat);
    const base = pA.baseboard && pB.baseboard ? EdgeTrim.BASEBOARD : 0;
    // SeamEdges carry no trim: doorways on the line get their casing here (as interior generator doors do)
    for (let i = 0; i < N; i++) trim[i] |= base | (kind[i] === EdgeKind.DOORWAY ? EdgeTrim.CASING : 0);
    return { mode, kind, hA, hB, matNeg, matPos, trim };
  };

  return {
    seam: (s, axis, cx, cz) => build(s, axis, cx, cz, null),
    classify(s, axis, cx, cz) {
      const cls: SeamClass = { mode: SeamMode.PATTERN, boundary: false, softEligible: false, soft: false, style: null, openings: 0 };
      build(s, axis, cx, cz, cls);
      return cls;
    },
  };
}

/** Hard district boundary: a full wall with 2–4 styled openings in [2, 29] (minimum centre spacing 6).
 * Style precedence (DESIGN §5 WP1 is ambiguous here; see docs/contract-changes/WP1.md): PARKING / WAREHOUSE give
 * roll-up doors (HEADER, 3–4 cells, EdgeTrim.ROLLUP) even though both zones are open — otherwise the roll-up style
 * could never occur; any other boundary touching an open zone gets 4–8-cell 'wide' openings of the open zone's
 * kind (ARCH arcades when POOLROOMS is involved, else OPEN); closed pairs use styleFor. */
function hardBoundary(
  rng: Rng, zA: ZoneId, zB: ZoneId, minCeilCm: number, lanes: readonly number[], kind: Uint8Array, hA: Int16Array, trim: Uint8Array,
  cls: SeamClass | null,
): number {
  kind.fill(EdgeKind.WALL);
  const base = styleFor(zA, zB);
  const wide = base !== 'rollup' && (isOpenZone(zA) || isOpenZone(zB));
  const style: SeamStyle = wide ? 'wide' : base;
  if (cls) cls.style = style;
  const pool = zA === Zone.POOLROOMS || zB === Zone.POOLROOMS;
  let k: number, h: number, t: number;
  switch (style) {
    case 'wide': k = pool ? EdgeKind.ARCH : EdgeKind.OPEN; h = pool ? Math.min(260, minCeilCm) : 0; t = 0; break;
    case 'arch': k = EdgeKind.ARCH; h = Math.min(260, minCeilCm); t = 0; break;
    case 'doorway': k = EdgeKind.DOORWAY; h = Math.min(210, minCeilCm - 10); t = EdgeTrim.CASING; break;
    // the roll-up box needs room under the ceiling; the underside stays walkable (>= 220 >= 190)
    case 'rollup': k = EdgeKind.HEADER; h = Math.max(220, Math.min(300, minCeilCm - 30)); t = EdgeTrim.ROLLUP; break;
    default: k = EdgeKind.HEADER; h = Math.min(220, minCeilCm); t = 0; break;
  }
  const width = (): number => {
    switch (style) {
      case 'wide': return rng.int(4, 8);
      case 'doorway': return 1;
      case 'rollup': return rng.int(3, 4);
      default: return 2;
    }
  };
  const count = rng.int(2, 4);
  const from: number[] = [], to: number[] = [];
  for (let o = 0; o < count; o++) {
    const w = width();
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rng.int(2, N - 2 - w); // cells [a, a+w) inside [2, 29]
      const c = a + w / 2;
      let ok = true;
      for (const ln of lanes) if (a < ln + 3 && a + w + 2 > ln) ok = false; // keep >= 2 wall cells from artery lanes
      for (let p = 0; p < from.length && ok; p++) {
        const pc = (from[p] + to[p]) / 2;
        if (Math.abs(c - pc) < 6 || (a < to[p] + 2 && a + w + 2 > from[p])) ok = false;
      }
      if (ok) { from.push(a); to.push(a + w); break; }
    }
  }
  if (from.length < 2) {
    // deterministic fallback: one opening near each end of the usable range (clear of artery lanes)
    const w0 = width(), w1 = width();
    const clear = (a: number, w: number): boolean => lanes.every((ln) => !(a < ln + 3 && a + w + 2 > ln));
    let a0 = 2;
    while (a0 < N - 2 - w0 && !clear(a0, w0)) a0++;
    let a1 = N - 2 - w1;
    while (a1 > a0 + w0 + 2 && !clear(a1, w1)) a1--;
    from.length = 0; to.length = 0;
    from.push(a0, a1); to.push(a0 + w0, a1 + w1);
  }
  for (let p = 0; p < from.length; p++) {
    for (let i = from[p]; i < to[p]; i++) { kind[i] = k; hA[i] = h; trim[i] = t; }
  }
  return from.length;
}
