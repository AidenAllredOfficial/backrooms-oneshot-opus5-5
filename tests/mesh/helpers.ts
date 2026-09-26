// tests/mesh/helpers.ts — WP5 test fixtures: neighbourhoods from ASCII layouts and from the real world generator,
// plus mesh / chart inspection helpers.

import { CHUNK_CELLS } from '../../src/core/constants.ts';
import type { TileKey } from '../../src/core/grid.ts';
import { CellFlag, Mood, Zone, type StoreyId, type ZoneId } from '../../src/core/ids.ts';
import { createEmptyLayout, type ChunkLayout } from '../../src/core/layout.ts';
import type { Chart, MeshBuffers } from '../../src/core/mesh.ts';
import type { LayoutNeighborhood, WorldGen, ZonePalette } from '../../src/core/world.ts';
import { layoutFromAscii } from '../../src/world/ascii.ts';
import { makeNeighborhood } from '../../src/world/neighborhood.ts';
import { createWorldGen } from '../../src/world/worldgen.ts';

/** An all-SOLID layout (neighbours of ASCII fixtures). */
export function solidLayout(s: StoreyId, cx: number, cz: number): ChunkLayout {
  const l = createEmptyLayout({ s, cx, cz }, Zone.LOBBY, 0, Mood.NORMAL);
  l.flags.fill(CellFlag.SOLID);
  l.ceilCm.fill(270);
  return l;
}

/** Neighbourhood around an ASCII layout at chunk (0, 0); the 8 neighbours are SOLID. `edit` may patch the layout. */
export function asciiNb(text: string, palette?: Partial<ZonePalette>, edit?: (l: ChunkLayout) => void): LayoutNeighborhood {
  const c = layoutFromAscii({ s: 0, cx: 0, cz: 0 }, text, palette);
  edit?.(c);
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ls.push(dx === 0 && dz === 0 ? c : solidLayout(0, dx, dz));
  return makeNeighborhood(ls);
}

const gens = new Map<string, WorldGen>();
export function worldGen(seed: number, forceZone: ZoneId | null = null): WorldGen {
  const k = `${seed}|${forceZone}`;
  let g = gens.get(k);
  if (!g) {
    g = createWorldGen({ seed, seedText: String(seed), forceZone, forceMood: null, forceLandmark: null, testScene: null, lights: 'default' });
    gens.set(k, g);
  }
  return g;
}

const layoutCache = new Map<string, ChunkLayout>();
/** Neighbourhood of chunk (s, cx, cz) from the real generator (cached layouts). */
export function genNb(seed: number, s: StoreyId, cx: number, cz: number, forceZone: ZoneId | null = null): LayoutNeighborhood {
  const g = worldGen(seed, forceZone);
  const ls: ChunkLayout[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const k = `${seed}|${forceZone}|${s}|${cx + dx}|${cz + dz}`;
      let l = layoutCache.get(k);
      if (!l) {
        l = g.generateChunk({ s, cx: cx + dx, cz: cz + dz });
        if (layoutCache.size > 200) layoutCache.clear();
        layoutCache.set(k, l);
      }
      ls.push(l);
    }
  }
  return makeNeighborhood(ls);
}

export const tileKey = (s: StoreyId, cx: number, cz: number, q: number): TileKey => ({ s, cx, cz, q: q as 0 | 1 | 2 | 3 });

export interface Tri3 { a: number[]; b: number[]; c: number[]; n: number[]; area: number; centre: number[] }

/** Triangle geometry of mesh triangle t. */
export function tri(m: MeshBuffers, t: number): Tri3 {
  const P = m.position, I = m.index;
  const v = (k: number): number[] => [P[I[t * 3 + k] * 3], P[I[t * 3 + k] * 3 + 1], P[I[t * 3 + k] * 3 + 2]];
  const a = v(0), b = v(1), c = v(2);
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return { a, b, c, n: n.map((x) => x / (l || 1)), area: l / 2, centre: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] };
}

/** Validity problems of a mesh buffer: NaN, index range, degenerate triangles, normal length, winding vs normal. */
export function meshProblems(m: MeshBuffers, label = ''): string[] {
  const bad: string[] = [];
  const fin = (a: ArrayLike<number>, name: string): void => {
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { bad.push(`${label} NaN ${name} @${i}`); return; }
  };
  fin(m.position, 'position'); fin(m.uv, 'uv'); fin(m.lmUv, 'lmUv'); fin(m.emit, 'emit');
  if (m.index.length % 3) bad.push(`${label} index count not a multiple of 3`);
  for (let i = 0; i < m.indexCount; i++) if (m.index[i] >= m.vertexCount) { bad.push(`${label} index out of range @${i}`); break; }
  let degenerate = 0, wrongWinding = 0;
  for (let t = 0; t < m.indexCount / 3; t++) {
    const T = tri(m, t);
    if (T.area < 1e-9) { degenerate++; continue; }
    const vi = m.index[t * 3];
    const nx = m.normal[vi * 4] / 127, ny = m.normal[vi * 4 + 1] / 127, nz = m.normal[vi * 4 + 2] / 127;
    if (T.n[0] * nx + T.n[1] * ny + T.n[2] * nz < 0.5) wrongWinding++;
  }
  if (degenerate) bad.push(`${label} ${degenerate} degenerate triangles`);
  if (wrongWinding) bad.push(`${label} ${wrongWinding} triangles wound against their normal`);
  for (let v = 0; v < m.vertexCount; v++) {
    const l = Math.hypot(m.normal[v * 4], m.normal[v * 4 + 1], m.normal[v * 4 + 2]) / 127;
    if (Math.abs(l - 1) > 0.01) { bad.push(`${label} normal not unit @${v} (${l.toFixed(4)})`); break; }
  }
  return bad;
}

/** Charts whose texel rects overlap (including the LM_PAD gutter of neither). */
export function chartOverlaps(charts: readonly Chart[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < charts.length; i++) {
    const a = charts[i];
    for (let j = i + 1; j < charts.length; j++) {
      const b = charts[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}

export const N_CELLS = CHUNK_CELLS;
