// src/mesh/periodic.ts — periodic stair-tower replication (core/layout.ts TOWER_REPLICAS), shared by the mesher,
// props (WP6), collision (WP12) and the baker (WP7). Pure module (no three/DOM).
//
// Tower content (solids / fixtures whose bakeGroup is a TOWER structure's group, props anchored in TOWER cells)
// describes ONE period y in [-1.5, 1.5). Replicas are placed at y + 3k for k in TOWER_REPLICAS (extended by
// `extraK` periods on both sides) and clipped to |y| <= TOWER_SPAN + 3 * extraK (boxes are cut, ramps keep their
// whole steps: clipRamp). Output order: layout order, each tower item replaced by its replicas in increasing k
// (deterministic; ids and seeds are kept).

import { CHUNK_CELLS, STOREY_PITCH, TOWER_SPAN } from '../core/constants.ts';
import { worldToCell } from '../core/grid.ts';
import { CellFlag } from '../core/ids.ts';
import { TOWER_REPLICAS, towerGroups, type ChunkLayout, type Fixture, type PropPlacement, type Solid } from '../core/layout.ts';

const EPS = 1e-6;

function replicaKs(extraK: number): number[] {
  const lo = TOWER_REPLICAS[0] - extraK, hi = TOWER_REPLICAS[TOWER_REPLICAS.length - 1] + extraK;
  const out: number[] = [];
  for (let k = lo; k <= hi; k++) out.push(k);
  return out;
}

/** Replicas at y + 3k, clipped to |y| <= TOWER_SPAN (+extraK periods beyond). Non-tower solids unchanged. */
export function expandPeriodicSolids(l: ChunkLayout, extraK = 0): Solid[] {
  const groups = towerGroups(l);
  if (groups.length === 0) return l.solids.slice();
  const ks = replicaKs(extraK);
  const span = TOWER_SPAN + STOREY_PITCH * extraK;
  const out: Solid[] = [];
  for (const s of l.solids) {
    if (s.kind === 'pipe' || !groups.includes(s.bakeGroup)) { out.push(s); continue; }
    for (const k of ks) {
      const dy = k * STOREY_PITCH;
      if (s.kind === 'box') {
        const y0 = Math.max(s.min[1] + dy, -span), y1 = Math.min(s.max[1] + dy, span);
        if (y1 - y0 <= EPS) continue;
        out.push(k === 0 && y0 === s.min[1] && y1 === s.max[1] ? s : { ...s, min: [s.min[0], y0, s.min[2]], max: [s.max[0], y1, s.max[2]] });
      } else {
        const r = clipRamp(s, dy, span);
        if (r) out.push(r);
      }
    }
  }
  return out;
}

type Ramp = Extract<Solid, { kind: 'ramp' }>;

/** Ramp shifted by dy and clipped to |y| <= span, or null if nothing remains. The clip keeps the geometry model of
 * the mesher / collision (mesh/stairs.ts): a smooth ramp is cut where its slope crosses the bound; a stepped flight
 * (n risers at s = i * dep, i < n; treads between them, dep = L / (n - 1)) keeps its whole steps inside the bound
 * with the same rise and tread depth; a single step keeps its tread and shortens its riser. */
export function clipRamp(s: Ramp, dy: number, span: number): Ramp | null {
  const Y0 = s.y0 + dy, Y1 = s.y1 + dy;
  const lo = Math.min(Y0, Y1), hi = Math.max(Y0, Y1);
  if (hi <= -span + EPS || lo >= span - EPS) return null;
  if (lo >= -span - EPS && hi <= span + EPS) return dy === 0 ? s : { ...s, y0: Y0, y1: Y1 };
  const alongX = s.dir <= 1;
  const A0 = alongX ? Math.min(s.x0, s.x1) : Math.min(s.z0, s.z1), A1 = alongX ? Math.max(s.x0, s.x1) : Math.max(s.z0, s.z1);
  const L = A1 - A0;
  const n = Math.max(0, Math.round(s.steps));
  const up = Y1 >= Y0;
  // ascent-coordinate range [sa, sb] (0 = low end) and new end heights
  let sa: number, sb: number, ny0: number, ny1: number;
  if (!up || L <= EPS) {
    // descending / degenerate footprint (not produced by generation): clamp the heights only
    ny0 = Math.max(-span, Math.min(span, Y0)); ny1 = Math.max(-span, Math.min(span, Y1));
    return { ...s, y0: ny0, y1: ny1 };
  }
  if (n === 0) {
    const sAt = (h: number): number => ((h - Y0) / (Y1 - Y0)) * L;
    ny0 = Math.max(Y0, -span); ny1 = Math.min(Y1, span);
    sa = sAt(ny0); sb = sAt(ny1);
    if (sb - sa <= EPS) return null;
  } else if (n === 1) {
    if (Y1 > span + EPS) return null; // the tread is out of range
    return { ...s, y0: Math.max(Y0, -span), y1: Y1 };
  } else {
    const rise = (Y1 - Y0) / n, dep = L / (n - 1);
    const a = Math.max(0, Math.ceil((-span - Y0) / rise - 1e-6));
    const b = Math.min(n, Math.floor((span - Y0) / rise + 1e-6));
    const m = b - a;
    if (m <= 0) return null;
    if (m === 1) {
      if (a >= n - 1) return null; // only the top riser (no tread) would remain
      // one riser at a * dep plus its tread [a * dep, (a + 1) * dep]
      sa = a * dep; sb = (a + 1) * dep; ny0 = Y0 + a * rise; ny1 = Y0 + b * rise;
      return withAlong(s, A0, A1, sa, sb, ny0, ny1, 1);
    }
    sa = a * dep; sb = (b - 1) * dep; ny0 = Y0 + a * rise; ny1 = Y0 + b * rise;
    return withAlong(s, A0, A1, sa, sb, ny0, ny1, m);
  }
  return withAlong(s, A0, A1, sa, sb, ny0, ny1, 0);
}

/** Copy of ramp s restricted to ascent coordinates [sa, sb] (0 = low end) with new heights and step count. */
function withAlong(s: Ramp, A0: number, A1: number, sa: number, sb: number, y0: number, y1: number, steps: number): Ramp {
  const pos = s.dir === 0 || s.dir === 2; // ascent toward +x / +z: s measured from the min side
  const c0 = pos ? A0 + sa : A1 - sb, c1 = pos ? A0 + sb : A1 - sa;
  const q = (v: number): number => Math.round(v * 1e6) / 1e6;
  if (s.dir <= 1) return { ...s, x0: q(c0), x1: q(c1), z0: Math.min(s.z0, s.z1), z1: Math.max(s.z0, s.z1), y0, y1, steps };
  return { ...s, z0: q(c0), z1: q(c1), x0: Math.min(s.x0, s.x1), x1: Math.max(s.x0, s.x1), y0, y1, steps };
}

/** Replicas keep the base id and seed. Non-tower fixtures unchanged. */
export function expandPeriodicFixtures(l: ChunkLayout, extraK = 0): Fixture[] {
  const groups = towerGroups(l);
  if (groups.length === 0) return l.fixtures.slice();
  const ks = replicaKs(extraK);
  const span = TOWER_SPAN + STOREY_PITCH * extraK;
  const out: Fixture[] = [];
  for (const f of l.fixtures) {
    if (!groups.includes(f.bakeGroup)) { out.push(f); continue; }
    for (const k of ks) {
      const py = f.py + k * STOREY_PITCH;
      if (Math.abs(py) > span + EPS) continue;
      out.push(k === 0 ? f : { ...f, py });
    }
  }
  return out;
}

/** Props anchored in TOWER cells replicated like solids; others unchanged. */
export function expandPeriodicProps(l: ChunkLayout): PropPlacement[] {
  let any = false;
  for (const s of l.structures) if (s.kind === 0) any = true;
  if (!any) return l.props.slice();
  const ks = replicaKs(0);
  const out: PropPlacement[] = [];
  for (const p of l.props) {
    const li = worldToCell(p.x), lj = worldToCell(p.z);
    const inside = li >= 0 && lj >= 0 && li < CHUNK_CELLS && lj < CHUNK_CELLS;
    if (!inside || !(l.flags[lj * CHUNK_CELLS + li] & CellFlag.TOWER)) { out.push(p); continue; }
    for (const k of ks) {
      const y = p.y + k * STOREY_PITCH;
      if (Math.abs(y) > TOWER_SPAN + EPS) continue;
      out.push(k === 0 ? p : { ...p, y });
    }
  }
  return out;
}
