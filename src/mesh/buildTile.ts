// src/mesh/buildTile.ts — tile-local shell/water/decal meshes + SurfaceSet of one render tile (§5 WP5).
// Pure module (no three/DOM).
//
// buildTile runs the shared planning pass (surfaces.ts planTile: face records + chart specs + atlas), then writes
// every face into one of three GeometryWriters (shell / decals / water). Lightmap uvs are computed per vertex by
// projecting the vertex (or its explicit lightmap sample position, Face.lm) into the texel frame of the face's own
// chart, the chart it borrows (TRIM_BORROW), or the chart of the face it borrows from. T-junctions between shell
// faces are closed first (tjunction.ts). The props buffer comes from WP6 buildTileProps; dynLights lists the dynamic
// fixture of each of the 9 tiles around this one.

import { CHUNK_SIZE, type LmTpc } from '../core/constants.ts';
import { tileKeyStr, tileOfPoint, type TileKey } from '../core/grid.ts';
import type { ChunkLayout } from '../core/layout.ts';
import { DYN_SLOT_OFFSETS, emptyMeshBuffers, type DynLightRef, type MeshBuffers, type SurfaceSet, type TileMesh } from '../core/mesh.ts';
import type { LayoutNeighborhood } from '../core/world.ts';
import { buildTileProps } from '../props/tileProps.ts';
import { BUF_DECALS, BUF_WATER, type ChartSpec, type Face } from './plan.ts';
import { planTile } from './surfaces.ts';
import { repairTJunctions } from './tjunction.ts';

/** Chart (spec) whose texels a face samples: its own / borrowed spec, or the spec of the face it borrows from. */
export function faceSpec(f: Face): ChartSpec | null {
  let s: Face | null = f;
  for (let i = 0; i < 4 && s; i++) {
    if (!s.from) return s.spec;
    s = s.from;
  }
  return null;
}

/** Exact-size MeshBuffers writer for the shell / decal / water faces (no growth, one normalisation per face). */
class FaceWriter {
  readonly m: MeshBuffers;
  private n = 0;
  private ni = 0;
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];
  constructor(verts: number, idx: number) {
    this.m = {
      position: new Float32Array(verts * 3), normal: new Int8Array(verts * 4), uv: new Float32Array(verts * 2),
      lmUv: new Float32Array(verts * 2), layer: new Uint8Array(verts), flags: new Uint8Array(verts), tint: new Uint8Array(verts * 4),
      emit: new Float32Array(verts), aux: new Uint8Array(verts * 4), index: new Uint32Array(idx), vertexCount: verts, indexCount: idx,
      bounds: [0, 0, 0, 0, 0, 0],
    };
  }

  /** Write one convex face (fan triangulation from vertex f.fan, or around an added centre vertex when f.fan < 0;
   * CCW seen from the face normal). */
  face(f: Face, spec: ChartSpec, atlasW: number, atlasH: number): void {
    const p = f.p, n = p.length / 3;
    if (n < 3) return;
    const m = this.m;
    const lm = f.lm ?? p;
    // Newell normal of the vertex order, compared with the face normal to pick the winding
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2], bx = p[j * 3], by = p[j * 3 + 1], bz = p[j * 3 + 2];
      gx += (ay - by) * (az + bz); gy += (az - bz) * (ax + bx); gz += (ax - bx) * (ay + by);
    }
    const flip = gx * f.nx + gy * f.ny + gz * f.nz < 0;
    const nl = Math.sqrt(f.nx * f.nx + f.ny * f.ny + f.nz * f.nz) || 1;
    const qx = Math.round((f.nx / nl) * 127), qy = Math.round((f.ny / nl) * 127), qz = Math.round((f.nz / nl) * 127);
    const t = f.tint >>> 0, a = f.aux >>> 0;
    const t0 = t & 255, t1 = (t >>> 8) & 255, t2 = (t >>> 16) & 255, t3 = (t >>> 24) & 255;
    const a0 = a & 255, a1 = (a >>> 8) & 255, a2 = (a >>> 16) & 255, a3 = (a >>> 24) & 255;
    const clampLm = !(f.own && !f.from && !spec.grid);
    const tex = spec.tex, eu = spec.eu, ev = spec.ev, o = spec.o;
    const uHi = spec.w - 0.5, vHi = spec.h - 0.5;
    const base = this.n;
    const centre = f.fan < 0;
    const nw = centre ? n + 1 : n;
    let cx = 0, cy = 0, cz = 0, lx = 0, ly = 0, lz = 0, cu = 0, cv = 0;
    if (centre) {
      for (let i = 0; i < n; i++) {
        cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2];
        lx += lm[i * 3]; ly += lm[i * 3 + 1]; lz += lm[i * 3 + 2];
        cu += f.uv[i * 2] ?? 0; cv += f.uv[i * 2 + 1] ?? 0;
      }
      cx /= n; cy /= n; cz /= n; lx /= n; ly /= n; lz /= n; cu /= n; cv /= n;
    }
    for (let i = 0; i < nw; i++) {
      const k = this.n++;
      const c = i === n;
      const x = c ? cx : p[i * 3], y = c ? cy : p[i * 3 + 1], z = c ? cz : p[i * 3 + 2];
      m.position[k * 3] = x; m.position[k * 3 + 1] = y; m.position[k * 3 + 2] = z;
      if (x < this.min[0]) this.min[0] = x; if (y < this.min[1]) this.min[1] = y; if (z < this.min[2]) this.min[2] = z;
      if (x > this.max[0]) this.max[0] = x; if (y > this.max[1]) this.max[1] = y; if (z > this.max[2]) this.max[2] = z;
      m.normal[k * 4] = qx; m.normal[k * 4 + 1] = qy; m.normal[k * 4 + 2] = qz;
      m.uv[k * 2] = c ? cu : f.uv[i * 2] ?? 0; m.uv[k * 2 + 1] = c ? cv : f.uv[i * 2 + 1] ?? 0;
      const dx = (c ? lx : lm[i * 3]) - o[0], dy = (c ? ly : lm[i * 3 + 1]) - o[1], dz = (c ? lz : lm[i * 3 + 2]) - o[2];
      let tu = (dx * eu[0] + dy * eu[1] + dz * eu[2] - spec.uBase) / tex + 1;
      let tv = (dx * ev[0] + dy * ev[1] + dz * ev[2] - spec.vBase) / tex + 1;
      if (clampLm) { tu = tu < 0.5 ? 0.5 : tu > uHi ? uHi : tu; tv = tv < 0.5 ? 0.5 : tv > vHi ? vHi : tv; }
      m.lmUv[k * 2] = (spec.x + tu) / atlasW; m.lmUv[k * 2 + 1] = (spec.y + tv) / atlasH;
      m.layer[k] = f.layer; m.flags[k] = f.flags; m.emit[k] = f.emit;
      m.tint[k * 4] = t0; m.tint[k * 4 + 1] = t1; m.tint[k * 4 + 2] = t2; m.tint[k * 4 + 3] = t3;
      m.aux[k * 4] = a0; m.aux[k * 4 + 1] = a1; m.aux[k * 4 + 2] = a2; m.aux[k * 4 + 3] = a3;
    }
    const I = m.index;
    if (centre) {
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        I[this.ni++] = base + n;
        I[this.ni++] = base + (flip ? j : i);
        I[this.ni++] = base + (flip ? i : j);
      }
      return;
    }
    const k0 = f.fan;
    for (let s = 1; s + 1 < n; s++) {
      let i = k0 + s, j = k0 + s + 1;
      if (i >= n) i -= n;
      if (j >= n) j -= n;
      I[this.ni++] = base + k0;
      I[this.ni++] = base + (flip ? j : i);
      I[this.ni++] = base + (flip ? i : j);
    }
  }

  finish(): MeshBuffers {
    if (this.n > 0) this.m.bounds = [this.min[0], this.min[1], this.min[2], this.max[0], this.max[1], this.max[2]];
    return this.m;
  }
}

/** The dynamic fixture whose centre lies in tile (dcx, dcz, q) of the neighbourhood, in world metres. */
function dynLightOf(nb: LayoutNeighborhood, tile: TileKey, dx: number, dz: number): DynLightRef | null {
  const gtx = (tile.q & 1) + dx, gtz = (tile.q >> 1) + dz; // tile coords relative to the centre chunk's tile (0,0)
  const dcx = Math.floor(gtx / 2), dcz = Math.floor(gtz / 2);
  const q = ((gtx - dcx * 2) | ((gtz - dcz * 2) << 1)) as 0 | 1 | 2 | 3;
  const l: ChunkLayout = nb.get(dcx as -1 | 0 | 1, dcz as -1 | 0 | 1);
  let best: DynLightRef | null = null;
  let bestId = 0;
  for (const f of l.fixtures) {
    if (!f.dynamic || tileOfPoint(f.px, f.pz) !== q) continue;
    if (best && (f.id >>> 0) >= bestId) continue; // generation allows one; ties resolved by lowest id (deterministic)
    bestId = f.id >>> 0;
    const ocx = (tile.cx + dcx) * CHUNK_SIZE, ocz = (tile.cz + dcz) * CHUNK_SIZE;
    best = { id: f.id, state: f.state, seed: f.seed, color: [f.color[0], f.color[1], f.color[2]], x: ocx + f.px, y: f.py, z: ocz + f.pz };
  }
  return best;
}

export function buildTile(nb: LayoutNeighborhood, tile: TileKey, tpc: LmTpc): { mesh: TileMesh; surfaces: SurfaceSet } {
  const tp = planTile(nb, tile, tpc);
  repairTJunctions(tp.plan.faces);
  const surfaces = tp.surfaces;
  const W = surfaces.atlasW, H = surfaces.atlasH;
  // resolve every face's chart and size the three buffers exactly
  const faces = tp.plan.faces;
  const specs: (ChartSpec | null)[] = new Array<ChartSpec | null>(faces.length);
  const nv = [0, 0, 0], ni = [0, 0, 0];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    let spec = faceSpec(f);
    if (spec && spec.id < 0) spec = f.ny < -0.5 ? tp.plan.ceilGrid : tp.plan.floorGrid; // borrowed chart without own faces
    const n = f.p.length / 3;
    if (!spec || n < 3) { specs[i] = null; continue; }
    specs[i] = spec;
    const b = f.buf === BUF_DECALS ? 1 : f.buf === BUF_WATER ? 2 : 0;
    if (f.fan < 0) { nv[b] += n + 1; ni[b] += n * 3; } else { nv[b] += n; ni[b] += (n - 2) * 3; }
  }
  const ws = [new FaceWriter(nv[0], ni[0]), new FaceWriter(nv[1], ni[1]), new FaceWriter(nv[2], ni[2])];
  for (let i = 0; i < faces.length; i++) {
    const spec = specs[i];
    if (!spec) continue;
    const f = faces[i];
    ws[f.buf === BUF_DECALS ? 1 : f.buf === BUF_WATER ? 2 : 0].face(f, spec, W, H);
  }
  const shell = nv[0] > 0 ? ws[0].finish() : emptyMeshBuffers();
  const decalBuf: MeshBuffers | null = nv[1] > 0 ? ws[1].finish() : null;
  const waterBuf: MeshBuffers | null = nv[2] > 0 ? ws[2].finish() : null;
  const props = buildTileProps(nb, tile);

  const dynLights: (DynLightRef | null)[] = [];
  for (const [dx, dz] of DYN_SLOT_OFFSETS) dynLights.push(dynLightOf(nb, tile, dx, dz));

  const tris = (shell.indexCount + (props?.indexCount ?? 0) + (decalBuf?.indexCount ?? 0) + (waterBuf?.indexCount ?? 0)) / 3;
  const mesh: TileMesh = {
    tileKey: tileKeyStr(tile),
    zone: nb.center.zone,
    shell,
    props,
    water: waterBuf,
    decals: decalBuf,
    atlas: { width: W, height: H, tpc, chartHash: surfaces.hash, chartCount: surfaces.charts.length },
    dynLights,
    tris,
  };
  return { mesh, surfaces };
}
