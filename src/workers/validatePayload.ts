// src/workers/validatePayload.ts — dev-time payload validation (WP10). PURE.
// Each function returns a list of violations ([] when valid). The handler runs them when `init.validate`
// (dev builds and the Node pipeline test) and turns violations into a loud `error` response.
//
// Checks (DESIGN §5 WP10 acceptance): no NaN/Inf, indices in range, lmUv inside the atlas, build chartHash ==
// bake chartHash, texture array lengths = w*h*4 (dir: w*h*4 per layer, bake/encode.ts LM_DIR_LAYERS), light-volume
// sizes, collision prefix sums monotone, plus the structural invariants every consumer relies on (attribute lengths,
// enum ranges, per-cell array sizes).

import { LM_DIR_LAYERS } from '../bake/encode.ts';
import {
  CHUNK_CELL_COUNT, EDGE_COUNT, EMISSION, GEN_VERSION, LM_ATLAS_W, LM_TPC_ALLOWED, LV,
} from '../core/constants.ts';
import { chunkKeyStr } from '../core/grid.ts';
import { toHalf } from '../core/half.ts';
import { MAT_COUNT, ZONE_COUNT } from '../core/ids.ts';
import type { ChunkLayout, EdgeGrid } from '../core/layout.ts';
import type { ChunkCollision, LightmapData, MeshBuffers, TileMesh } from '../core/mesh.ts';

const MAX_ERRORS = 24; // keep messages readable; the first violations are the informative ones
const ATLAS_HEIGHTS = [256, 512, 768, 1024];
const DEGENERATE_ATLAS_TEXELS = 16;
const EDGE_KIND_COUNT = 10;
const MOOD_COUNT = 4;
const CEIL_KIND_COUNT = 6;
const SHELL_TRI_CAP = 120_000; // §8.3 hard cap per tile
const WALLMASK_LEN = 18 * 18 * 4;
const LV_LEN = LV.NX * LV.NY * LV.NZ * 4;
const EMISSION_LEN = EMISSION.RES * EMISSION.RES * 4;
/** Half-float magnitude bits of 1e-3: negative irradiance beyond this is a producer bug (tiny negatives from
 * rounding are tolerated). */
const NEG_EPS_BITS = toHalf(1e-3);

class Errs {
  readonly list: string[] = [];
  push(msg: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push(msg);
    else if (this.list.length === MAX_ERRORS) this.list.push('... (more violations truncated)');
  }
}

// ---------------------------------------------------------------- helpers
function firstNonFinite(a: Float32Array | Float64Array, n = a.length): number {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return i;
  return -1;
}

/** Scan half-float RGBA data. `signedAlpha`: alpha may be negative (emission region keys). */
function checkHalf(e: Errs, what: string, a: Uint16Array, allowNegative: boolean, signedAlpha: boolean): void {
  for (let i = 0; i < a.length; i++) {
    const h = a[i];
    if ((h & 0x7c00) === 0x7c00) {
      e.push(`${what}: NaN/Inf half at [${i}] (texel ${i >> 2}, ch ${i & 3})`);
      return;
    }
    if (!allowNegative && (h & 0x8000) !== 0 && (h & 0x7fff) > NEG_EPS_BITS && !(signedAlpha && (i & 3) === 3)) {
      e.push(`${what}: negative value at [${i}] (texel ${i >> 2}, ch ${i & 3})`);
      return;
    }
  }
}

function checkLen(e: Errs, what: string, got: number, want: number): boolean {
  if (got !== want) {
    e.push(`${what}: length ${got}, expected ${want}`);
    return false;
  }
  return true;
}

function validateMeshBuffers(e: Errs, name: string, m: MeshBuffers, lmUvInAtlas: boolean): void {
  const n = m.vertexCount, ni = m.indexCount;
  if (!Number.isInteger(n) || n < 0) { e.push(`${name}: bad vertexCount ${n}`); return; }
  if (!Number.isInteger(ni) || ni < 0 || ni % 3 !== 0) { e.push(`${name}: bad indexCount ${ni}`); return; }
  let ok = true;
  ok = checkLen(e, `${name}.position`, m.position.length, n * 3) && ok;
  ok = checkLen(e, `${name}.normal`, m.normal.length, n * 4) && ok;
  ok = checkLen(e, `${name}.uv`, m.uv.length, n * 2) && ok;
  ok = checkLen(e, `${name}.lmUv`, m.lmUv.length, n * 2) && ok;
  ok = checkLen(e, `${name}.layer`, m.layer.length, n) && ok;
  ok = checkLen(e, `${name}.flags`, m.flags.length, n) && ok;
  ok = checkLen(e, `${name}.tint`, m.tint.length, n * 4) && ok;
  ok = checkLen(e, `${name}.emit`, m.emit.length, n) && ok;
  ok = checkLen(e, `${name}.aux`, m.aux.length, n * 4) && ok;
  if (m.index.length < ni) { e.push(`${name}.index: length ${m.index.length} < indexCount ${ni}`); ok = false; }
  if (!ok) return;
  let bad = firstNonFinite(m.position);
  if (bad >= 0) e.push(`${name}.position: non-finite at [${bad}]`);
  bad = firstNonFinite(m.uv);
  if (bad >= 0) e.push(`${name}.uv: non-finite at [${bad}]`);
  bad = firstNonFinite(m.lmUv);
  if (bad >= 0) e.push(`${name}.lmUv: non-finite at [${bad}]`);
  for (let i = 0; i < n; i++) {
    const v = m.emit[i];
    if (!Number.isFinite(v) || v < 0) { e.push(`${name}.emit: invalid ${v} at vertex ${i}`); break; }
  }
  for (let i = 0; i < n; i++) {
    if (m.layer[i] >= MAT_COUNT) { e.push(`${name}.layer: ${m.layer[i]} >= MAT_COUNT at vertex ${i}`); break; }
  }
  for (let i = 0; i < ni; i++) {
    if (m.index[i] >= n) { e.push(`${name}.index: ${m.index[i]} out of range (vertexCount ${n}) at [${i}]`); break; }
  }
  if (lmUvInAtlas) {
    for (let i = 0; i < n * 2; i++) {
      const v = m.lmUv[i];
      if (v < 0 || v > 1) { e.push(`${name}.lmUv: ${v} outside the atlas at vertex ${i >> 1}`); break; }
    }
  }
  const b = m.bounds;
  if (b.length !== 6 || b.some((v) => !Number.isFinite(v))) e.push(`${name}.bounds: not 6 finite numbers`);
  else if (n > 0) {
    const eps = 1e-3;
    if (b[0] > b[3] || b[1] > b[4] || b[2] > b[5]) e.push(`${name}.bounds: min > max`);
    for (let i = 0; i < n; i++) {
      const x = m.position[i * 3], y = m.position[i * 3 + 1], z = m.position[i * 3 + 2];
      if (x < b[0] - eps || y < b[1] - eps || z < b[2] - eps || x > b[3] + eps || y > b[4] + eps || z > b[5] + eps) {
        e.push(`${name}.bounds: vertex ${i} (${x}, ${y}, ${z}) outside bounds`);
        break;
      }
    }
  }
}

function validateLightmap(e: Errs, lm: LightmapData, variant: 'preview' | 'full'): void {
  if (lm.variant !== variant) e.push(`lightmap.variant: '${lm.variant}', expected '${variant}'`);
  const w = lm.width, h = lm.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) e.push(`lightmap size ${w}x${h} invalid`);
  else if (w * h > DEGENERATE_ATLAS_TEXELS) {
    // a degenerate atlas (<= 4x4 texels, no charts) is accepted so the WP0 mesher stub keeps the app running
    if (w !== LM_ATLAS_W) e.push(`lightmap.width: ${w}, expected LM_ATLAS_W ${LM_ATLAS_W}`);
    if (!ATLAS_HEIGHTS.includes(h)) e.push(`lightmap.height: ${h} not in {256, 512, 768, 1024}`);
  }
  if (!Number.isInteger(lm.chartHash)) e.push(`lightmap.chartHash: not an integer (${lm.chartHash})`);
  const n = w * h * 4;
  if (checkLen(e, 'lightmap.irr', lm.irr.length, n)) checkHalf(e, 'lightmap.irr', lm.irr, false, false);
  checkLen(e, 'lightmap.dir', lm.dir.length, n * LM_DIR_LAYERS);
  checkLen(e, 'lightmap.mask', lm.mask.length, n);
  if (lm.flick !== null && checkLen(e, 'lightmap.flick', lm.flick.length, n)) checkHalf(e, 'lightmap.flick', lm.flick, false, false);
  if (checkLen(e, 'lightmap.emission', lm.emission.length, EMISSION_LEN)) checkHalf(e, 'lightmap.emission', lm.emission, false, true);
  const v = lm.volume;
  if (!v) { e.push('lightmap.volume: missing'); return; }
  if (checkLen(e, 'volume.a', v.a.length, LV_LEN)) checkHalf(e, 'volume.a', v.a, false, false);
  checkLen(e, 'volume.b', v.b.length, LV_LEN);
  if (v.c !== null && checkLen(e, 'volume.c', v.c.length, LV_LEN)) checkHalf(e, 'volume.c', v.c, false, false);
  checkLen(e, 'volume.wallMask', v.wallMask.length, WALLMASK_LEN);
}

// ---------------------------------------------------------------- public API

export function validateBuild(mesh: TileMesh, lm: LightmapData, variant: 'preview' | 'full' = 'preview'): string[] {
  const e = new Errs();
  if (mesh.tileKey !== lm.tileKey) e.push(`tileKey mismatch: mesh '${mesh.tileKey}' vs lightmap '${lm.tileKey}'`);
  if (!Number.isInteger(mesh.zone) || mesh.zone < 0 || mesh.zone >= ZONE_COUNT) e.push(`mesh.zone: ${mesh.zone} out of range`);
  const at = mesh.atlas;
  if (!(LM_TPC_ALLOWED as readonly number[]).includes(at.tpc)) e.push(`atlas.tpc: ${at.tpc} not allowed`);
  if (at.width !== lm.width || at.height !== lm.height) e.push(`atlas size ${at.width}x${at.height} != lightmap ${lm.width}x${lm.height}`);
  if (at.chartHash !== lm.chartHash) e.push(`chartHash mismatch: mesh atlas ${at.chartHash} vs lightmap ${lm.chartHash}`);
  validateMeshBuffers(e, 'shell', mesh.shell, true);
  if (mesh.shell.indexCount / 3 > SHELL_TRI_CAP) e.push(`shell: ${mesh.shell.indexCount / 3} triangles > hard cap ${SHELL_TRI_CAP}`);
  if (mesh.props) validateMeshBuffers(e, 'props', mesh.props, false);
  if (mesh.water) validateMeshBuffers(e, 'water', mesh.water, true);
  if (mesh.decals) validateMeshBuffers(e, 'decals', mesh.decals, true);
  for (const d of mesh.doors ?? []) {
    validateMeshBuffers(e, 'door', d.mesh, false);
    if (![d.x, d.y, d.z, d.yaw, d.seed].every(Number.isFinite)) e.push('door: non-finite transform');
  }
  if (!Array.isArray(mesh.dynLights) || mesh.dynLights.length !== 9) e.push(`dynLights: expected 9 slots, got ${mesh.dynLights?.length}`);
  else {
    for (let i = 0; i < 9; i++) {
      const d = mesh.dynLights[i];
      if (d === null) continue;
      if (![d.x, d.y, d.z, d.seed, d.id, ...d.color].every(Number.isFinite)) e.push(`dynLights[${i}]: non-finite field`);
    }
  }
  if (!Number.isFinite(mesh.tris) || mesh.tris < 0) e.push(`mesh.tris: ${mesh.tris}`);
  validateLightmap(e, lm, variant);
  return e.list;
}

export function validateBake(lm: LightmapData, expectHash: number): string[] {
  const e = new Errs();
  if (lm.chartHash !== expectHash) e.push(`chartHash mismatch: bake ${lm.chartHash} vs surfaces ${expectHash}`);
  validateLightmap(e, lm, 'full');
  return e.list;
}

function validateEdges(e: Errs, axis: string, g: EdgeGrid): void {
  checkLen(e, `${axis}.kind`, g.kind.length, EDGE_COUNT);
  checkLen(e, `${axis}.hA`, g.hA.length, EDGE_COUNT);
  checkLen(e, `${axis}.hB`, g.hB.length, EDGE_COUNT);
  checkLen(e, `${axis}.matNeg`, g.matNeg.length, EDGE_COUNT);
  checkLen(e, `${axis}.matPos`, g.matPos.length, EDGE_COUNT);
  checkLen(e, `${axis}.trim`, g.trim.length, EDGE_COUNT);
  for (let i = 0; i < g.kind.length; i++) if (g.kind[i] >= EDGE_KIND_COUNT) { e.push(`${axis}.kind[${i}] = ${g.kind[i]} out of range`); break; }
  for (let i = 0; i < g.matNeg.length; i++) if (g.matNeg[i] >= MAT_COUNT || g.matPos[i] >= MAT_COUNT) { e.push(`${axis}.mat[${i}] out of range`); break; }
}

export function validateLayoutPayload(l: ChunkLayout, c: ChunkCollision): string[] {
  const e = new Errs();
  const key = chunkKeyStr(l.key);
  if (l.genVersion !== GEN_VERSION) e.push(`layout.genVersion ${l.genVersion} != GEN_VERSION ${GEN_VERSION}`);
  if (c.chunkKey !== key) e.push(`collision.chunkKey '${c.chunkKey}' != layout key '${key}'`);
  if (l.zone < 0 || l.zone >= ZONE_COUNT) e.push(`layout.zone ${l.zone} out of range`);
  if (l.mood < 0 || l.mood >= MOOD_COUNT) e.push(`layout.mood ${l.mood} out of range`);
  const N = CHUNK_CELL_COUNT;
  const cellArrays: [string, ArrayLike<number>][] = [
    ['flags', l.flags], ['floorCm', l.floorCm], ['ceilCm', l.ceilCm], ['waterCm', l.waterCm], ['blockCm', l.blockCm],
    ['floorMat', l.floorMat], ['ceilMat', l.ceilMat], ['ceilKind', l.ceilKind], ['tiles', l.tiles], ['cellZone', l.cellZone],
    ['wallMat', l.wallMat], ['trimMat', l.trimMat], ['room', l.room], ['power', l.power], ['decay', l.decay],
    ['humidity', l.humidity], ['warmth', l.warmth],
  ];
  let cellsOk = true;
  for (const [name, a] of cellArrays) {
    if (!a) { e.push(`layout.${name}: missing`); cellsOk = false; continue; }
    cellsOk = checkLen(e, `layout.${name}`, a.length, N) && cellsOk;
  }
  if (cellsOk) {
    for (let i = 0; i < N; i++) {
      if (l.cellZone[i] >= ZONE_COUNT) { e.push(`layout.cellZone[${i}] = ${l.cellZone[i]} out of range`); break; }
    }
    for (let i = 0; i < N; i++) {
      if (l.floorMat[i] >= MAT_COUNT || l.ceilMat[i] >= MAT_COUNT) { e.push(`layout.floorMat/ceilMat[${i}] out of range`); break; }
    }
    for (let i = 0; i < N; i++) {
      if (l.wallMat[i] >= MAT_COUNT || l.trimMat[i] >= MAT_COUNT) { e.push(`layout.wallMat/trimMat[${i}] out of range (${l.wallMat[i]}, ${l.trimMat[i]})`); break; }
    }
    for (let i = 0; i < N; i++) {
      if (l.ceilKind[i] >= CEIL_KIND_COUNT) { e.push(`layout.ceilKind[${i}] = ${l.ceilKind[i]} out of range`); break; }
    }
    for (let i = 0; i < N; i++) {
      if ((l.flags[i] & 1) === 0 && l.ceilCm[i] <= l.floorCm[i]) { e.push(`layout cell ${i}: ceilCm ${l.ceilCm[i]} <= floorCm ${l.floorCm[i]} (not SOLID)`); break; }
    }
  }
  validateEdges(e, 'ex', l.ex);
  validateEdges(e, 'ez', l.ez);
  // content: finite positions
  for (let i = 0; i < l.fixtures.length; i++) {
    const f = l.fixtures[i];
    if (![f.px, f.py, f.pz, f.nx, f.ny, f.nz, f.tx, f.ty, f.tz, f.w, f.h, f.luminance, ...f.color].every(Number.isFinite)) {
      e.push(`fixtures[${i}] (id ${f.id}): non-finite field`);
      break;
    }
  }
  for (let i = 0; i < l.props.length; i++) {
    const p = l.props[i];
    if (![p.x, p.y, p.z, p.yaw, p.scale].every(Number.isFinite)) { e.push(`props[${i}]: non-finite field`); break; }
  }
  for (let i = 0; i < l.solids.length; i++) {
    const s = l.solids[i];
    const vals = s.kind === 'box' ? [...s.min, ...s.max] : s.kind === 'ramp' ? [s.x0, s.z0, s.x1, s.z1, s.y0, s.y1] : [...s.a, ...s.b, s.r];
    if (!vals.every(Number.isFinite)) { e.push(`solids[${i}] (${s.kind}): non-finite field`); break; }
  }
  // collision
  const nb = c.boxes.length / 6;
  if (!Number.isInteger(nb)) e.push(`collision.boxes: length ${c.boxes.length} not a multiple of 6`);
  else {
    checkLen(e, 'collision.boxFlags', c.boxFlags.length, nb);
    const bad = firstNonFinite(c.boxes);
    if (bad >= 0) e.push(`collision.boxes: non-finite at [${bad}]`);
    for (let i = 0; i < nb; i++) {
      const o = i * 6;
      if (c.boxes[o] > c.boxes[o + 3] || c.boxes[o + 1] > c.boxes[o + 4] || c.boxes[o + 2] > c.boxes[o + 5]) {
        e.push(`collision box ${i}: min > max`);
        break;
      }
    }
  }
  if (checkLen(e, 'collision.cellStart', c.cellStart.length, N + 1)) {
    if (c.cellStart[0] !== 0) e.push(`collision.cellStart[0] = ${c.cellStart[0]} (expected 0)`);
    for (let i = 1; i <= N; i++) {
      if (c.cellStart[i] < c.cellStart[i - 1]) { e.push(`collision.cellStart not monotone at ${i}`); break; }
    }
    if (c.cellStart[N] !== c.cellBoxes.length) e.push(`collision.cellStart[${N}] = ${c.cellStart[N]} != cellBoxes.length ${c.cellBoxes.length}`);
  }
  if (Number.isInteger(nb)) {
    for (let i = 0; i < c.cellBoxes.length; i++) {
      if (c.cellBoxes[i] >= nb) { e.push(`collision.cellBoxes[${i}] = ${c.cellBoxes[i]} >= box count ${nb}`); break; }
    }
  }
  if (c.ramps.length % 8 !== 0) e.push(`collision.ramps: length ${c.ramps.length} not a multiple of 8`);
  else {
    const bad = firstNonFinite(c.ramps);
    if (bad >= 0) e.push(`collision.ramps: non-finite at [${bad}]`);
    for (let i = 0; i < c.ramps.length; i += 8) {
      const d = c.ramps[i + 6];
      if (!(d === 0 || d === 1 || d === 2 || d === 3)) { e.push(`collision ramp ${i / 8}: dir ${d} not in 0..3`); break; }
      if (c.ramps[i] > c.ramps[i + 2] || c.ramps[i + 1] > c.ramps[i + 3]) { e.push(`collision ramp ${i / 8}: footprint min > max`); break; }
    }
  }
  return e.list;
}
