// src/core/layout.ts — the world data model produced by generation (WP1-4) and consumed by mesher (WP5),
// baker (WP7), collision (WP12), audio (WP13), streaming/queries (WP10) and debug tools (WP14).
// All positions are CHUNK-LOCAL metres (x,z in [0, CHUNK_SIZE)), y storey-relative metres.
// Heights in the per-cell/per-edge arrays are integer centimetres.

import { CHUNK_CELL_COUNT, EDGE_COUNT, GEN_VERSION } from './constants.ts';
import type { ChunkKey, Vec3 } from './grid.ts';
import { hash2, hash3, hash5, SALT } from './rng.ts';
import { Mat } from './ids.ts';
import type {
  AnomalyKindId, EmitterKindId, FixtureKindId, LandmarkKindId, LightStateId, MatId, MoodId, PropKindId,
  StructureKindId, VignetteKindId, ZoneId,
} from './ids.ts';

/** Edge data for one axis (EDGE_COUNT entries; see core/grid.ts for indexing). */
export interface EdgeGrid {
  kind: Uint8Array; // EdgeKind
  hA: Int16Array; // cm, meaning per kind (ids.ts)
  hB: Int16Array; // cm
  matNeg: Uint8Array; // MatId of the face looking toward -axis (the face in cell i-1 / j-1)
  matPos: Uint8Array; // MatId of the face looking toward +axis
  trim: Uint8Array; // EdgeTrim bits
}

/** Rectangular or spherical emitter. RECT: one-sided Lambertian of `luminance` nits on a w x h rectangle
 * centred at p, normal n, long axis t (w along t, h along n x t). SPHERE: isotropic, `luminance` = intensity cd,
 * radius w/2 (HIGHBAY: downward disk of radius w/2, same intensity semantics).
 * RGB radiance of the emitting surface = fixtureRadiance(f) * color (color has max component 1); every consumer
 * (WP5/WP6 lens emit, WP7 bake + emission map) uses exactly this. Flicker `flick` stores luma(E_rgb) with Rec.709
 * weights; WP11 writes color/luma(color) * i, which reproduces E_rgb exactly.
 * Recessed RECT fixtures never straddle a render-tile line (validateLayout); "the tile containing the light" is
 * always tileOfPoint(px, pz). */
export interface Fixture {
  id: number; // fixtureId(...) for lattice/custom fixtures; structureFixtureId(...) for tower/elevator (storey-free). Unique per chunk (validated)
  kind: FixtureKindId;
  state: LightStateId;
  shape: 0 | 1; // EmitterShape
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  tx: number; ty: number; tz: number;
  w: number; h: number;
  color: Vec3; // linear RGB, max component 1
  luminance: number;
  seed: number; // flicker/shimmer phase seed
  hum: number; // 0..1 audio loudness weight
  bakeGroup: number; // 0 = storey; towerId for tower-internal fixtures
  dynamic: boolean; // true only for the (<=1 per tile) FLICKER/ANOMALY light that owns its tile's channel
}

export type Solid =
  | { kind: 'box'; id: number; min: Vec3; max: Vec3; mat: MatId; flags: number; bakeGroup: number }
  | {
      kind: 'ramp'; id: number; x0: number; z0: number; x1: number; z1: number; // footprint (chunk-local m)
      y0: number; y1: number; // height at the low end / high end
      dir: 0 | 1 | 2 | 3; // ascent direction: 0 +x, 1 -x, 2 +z, 3 -z
      steps: number; // visual risers (0 = smooth ramp)
      mat: MatId; flags: number; bakeGroup: number;
    }
  | { kind: 'pipe'; id: number; a: Vec3; b: Vec3; r: number; mat: MatId; flags: number };

export interface PropPlacement {
  kind: PropKindId; variant: number; x: number; y: number; z: number; yaw: number; scale: number;
  flags: number; // SolidFlag.COLLIDE / OCCLUDE override bits (default from PROP_DEFS) | PropFlag bits (ids.ts)
  seed: number;
  /** Hinged, operable leaf. Coordinates are chunk-local; yaw is a three.js Y rotation. */
  door?: { hingeX: number; hingeZ: number; closedYaw: number; openYaw: number };
}

/** Decal quad. Atlas convention (WP8 draws, WP5 maps): a slot's "up" is +v and every arrow glyph points +v;
 * EXIT_LEFT/RIGHT are left/right when viewed with +v up.
 * rot: floor/ceiling decals (|ny| > 0.9): a yaw in the camera convention, +v points along forwardXZ(rot)
 *      (rot 0 => +v points -Z; positive rot turns counter-clockwise seen from above).
 *      wall decals: rot 0 => +v = +Y; positive rot turns the quad counter-clockwise as seen looking AGAINST the
 *      normal (i.e. by a viewer in front of the wall). Tested by WP5 (tests/mesh/decals.test.ts). */
export interface DecalPlacement {
  kind: number; // DecalKind (atlas slot) or SignKind when sign=true
  sign: boolean; // true: SIGNAGE layer, false: DECAL_ATLAS
  px: number; py: number; pz: number; nx: number; ny: number; nz: number;
  rot: number; w: number; h: number; alpha: number;
  emit?: number; // optional emissive luminance (nits) for the decal's emissive mask (LEDs, glowing signs)
  color?: Vec3; // optional linear tint (emissive colour when emit > 0); default white
}

export interface WaterRect { x0: number; z0: number; x1: number; z1: number; y: number; floorY: number; kind: 0 | 1 | 2 } // pool | flooded | film

export interface PortalSpec {
  kind: 'tower' | 'elevator' | 'pit' | 'glitch' | 'doorway';
  min: Vec3; max: Vec3; // trigger volume (chunk-local)
  towerId: number; // tower/elevator id (bakeGroup for towers), 0 otherwise
  endless: boolean; // ENDLESS_STAIRS anomaly: switches y but not storey
  wrong?: boolean; // elevator with a WRONG_ELEVATOR site: the ride goes to (s+2)%3 instead of (s+1)%3
  doorway?: DoorwayLink;
}

/** Ordinary architectural opening, with an outward normal pointing into the accessible room. */
export interface PortalFrame { x: number; y: number; z: number; nx: number; nz: number }
export interface DoorwayLink {
  id: number;
  effect: 'level' | 'interior';
  frame: PortalFrame; // chunk-local
  target: PortalFrame & { s: import('./ids.ts').StoreyId }; // world coordinates
}

export interface StructureInstance {
  id: number; kind: StructureKindId;
  bakeGroup: number; // TOWER/ELEVATOR: nonzero isolated bake group (== portal.towerId); others 0
  i0: number; j0: number; i1: number; j1: number; // local cell rect, half-open
  rot: 0 | 1 | 2 | 3;
  portal: PortalSpec | null;
}

/** A passable opening on a chunk seam; side 'W' = line i=0, 'N' = line j=0, 'E' = i=32, 'S' = j=32. */
export interface Port { side: 'W' | 'N' | 'E' | 'S'; from: number; to: number } // cell range [from,to)

export interface Leak { x: number; y: number; z: number; strength: number } // ceiling leak source (drives stains)
export interface AudioEmitterSpec { kind: EmitterKindId; x: number; y: number; z: number; gain: number; seed: number }
export interface VignetteInstance { kind: VignetteKindId; x: number; z: number; yaw: number; seed: number }
export interface LandmarkInstance { kind: LandmarkKindId; i0: number; j0: number; i1: number; j1: number }
export interface AnomalySite { kind: AnomalyKindId; x: number; z: number; r: number; seed: number }

export interface ChunkLayout {
  key: ChunkKey;
  genVersion: number;
  zone: ZoneId;
  districtId: number;
  mood: MoodId;
  // ---- per cell (CHUNK_CELL_COUNT, index lj*32+li)
  flags: Uint16Array; // CellFlag bits
  floorCm: Int16Array;
  ceilCm: Int16Array;
  waterCm: Int16Array; // water surface, NO_WATER if none
  blockCm: Int16Array; // height above floor of a cell-filling blocker box (racks, counters); 0 none
  floorMat: Uint8Array;
  ceilMat: Uint8Array;
  ceilKind: Uint8Array;
  tiles: Uint16Array; // 4 x TileState nibbles
  cellZone: Uint8Array; // palette zone per cell (arteries/landmarks may differ from `zone`)
  wallMat: Uint8Array; // palette wallMat (MatId) of the cell, written by WP1 from the district ZonePalette (stamps may override)
  trimMat: Uint8Array; // palette trimMat (MatId) of the cell (default Mat.TRIM_PAINT)
  room: Uint16Array; // room label (flood fill separated by walls/doorways); 0 = none (solid)
  power: Uint8Array; decay: Uint8Array; humidity: Uint8Array; warmth: Uint8Array; // fields 0..255
  // ---- edges
  ex: EdgeGrid;
  ez: EdgeGrid;
  // ---- content
  fixtures: Fixture[];
  solids: Solid[];
  props: PropPlacement[];
  decals: DecalPlacement[];
  water: WaterRect[];
  structures: StructureInstance[];
  ports: Port[];
  leaks: Leak[];
  emitters: AudioEmitterSpec[];
  vignettes: VignetteInstance[];
  landmarks: LandmarkInstance[];
  anomalies: AnomalySite[];
  hash: number; // FNV over all arrays + content, set by WP1 finish(); golden-hash tested
}

export const NO_WATER = -32768;

/** Fixture id from the 0.6 m lattice tile containing the fixture CENTRE (latticeI = floor(worldX/0.6),
 * latticeJ = floor(worldZ/0.6), world metres). Two fixtures of one kind may not share a lattice tile. */
export const fixtureId = (seed: number, s: number, latticeI: number, latticeJ: number, kind: number): number =>
  (hash5(seed, SALT.FIXTURE, s, latticeI, latticeJ) ^ kind) >>> 0;
/** Storey-free id for fixtures belonging to a structure (towers: SALT.TOWER, elevators: SALT.ELEVATOR). */
export const structureFixtureId = (structureId: number, salt: number, index: number): number => hash3(structureId, salt, index);
/** Flicker/shimmer phase seed of a fixture (a pure function of its id). Shaders use (seed & 255). */
export const fixtureSeed = (id: number): number => hash2(id, SALT.FLICKER);
/** Emitting-surface luminance (nits) of a fixture: RECT luminance; SPHERE/disk I / (PI r^2), r = w/2. */
export const fixtureRadiance = (f: Pick<Fixture, 'shape' | 'luminance' | 'w'>): number =>
  f.shape === 0 ? f.luminance : f.luminance / (Math.PI * (f.w / 2) * (f.w / 2));

/** Periodic stair towers: solids/fixtures whose bakeGroup belongs to a TOWER structure, and props whose anchor
 * cell is a TOWER cell, describe ONE period (y in [-STOREY_PITCH/2, +STOREY_PITCH/2)). Mesher (WP5), props
 * (WP6, via expandPeriodicProps), collision (WP12) and baker (WP7) replicate them at
 * y + k*STOREY_PITCH for every k in TOWER_REPLICAS (clipped to |y| <= TOWER_SPAN); the baker extends k further
 * as needed for its light window so baked lighting is exactly periodic. */
export const TOWER_REPLICAS = [-2, -1, 0, 1, 2] as const;
export function towerGroups(l: ChunkLayout): number[] {
  const out: number[] = [];
  for (const s of l.structures) if (s.kind === 0 /* StructureKind.TOWER */) out.push(s.bakeGroup);
  return out;
}

export function createEdgeGrid(): EdgeGrid {
  return {
    kind: new Uint8Array(EDGE_COUNT), hA: new Int16Array(EDGE_COUNT), hB: new Int16Array(EDGE_COUNT),
    matNeg: new Uint8Array(EDGE_COUNT), matPos: new Uint8Array(EDGE_COUNT), trim: new Uint8Array(EDGE_COUNT),
  };
}

export function createEmptyLayout(key: ChunkKey, zone: ZoneId, districtId: number, mood: MoodId): ChunkLayout {
  const n = CHUNK_CELL_COUNT;
  const waterCm = new Int16Array(n);
  waterCm.fill(NO_WATER);
  return {
    key, genVersion: GEN_VERSION, zone, districtId, mood,
    flags: new Uint16Array(n), floorCm: new Int16Array(n), ceilCm: new Int16Array(n), waterCm,
    blockCm: new Int16Array(n), floorMat: new Uint8Array(n), ceilMat: new Uint8Array(n), ceilKind: new Uint8Array(n),
    tiles: new Uint16Array(n), cellZone: new Uint8Array(n), wallMat: new Uint8Array(n), trimMat: new Uint8Array(n).fill(Mat.TRIM_PAINT),
    room: new Uint16Array(n),
    power: new Uint8Array(n), decay: new Uint8Array(n), humidity: new Uint8Array(n), warmth: new Uint8Array(n),
    ex: createEdgeGrid(), ez: createEdgeGrid(),
    fixtures: [], solids: [], props: [], decals: [], water: [], structures: [], ports: [], leaks: [],
    emitters: [], vignettes: [], landmarks: [], anomalies: [], hash: 0,
  };
}

/** Deep copy of every typed array (content arrays are copied shallowly; postMessage clones their objects). */
export function cloneLayout(l: ChunkLayout): ChunkLayout {
  const eg = (e: EdgeGrid): EdgeGrid => ({
    kind: e.kind.slice(), hA: e.hA.slice(), hB: e.hB.slice(), matNeg: e.matNeg.slice(), matPos: e.matPos.slice(), trim: e.trim.slice(),
  });
  return {
    ...l,
    flags: l.flags.slice(), floorCm: l.floorCm.slice(), ceilCm: l.ceilCm.slice(), waterCm: l.waterCm.slice(),
    blockCm: l.blockCm.slice(), floorMat: l.floorMat.slice(), ceilMat: l.ceilMat.slice(), ceilKind: l.ceilKind.slice(),
    tiles: l.tiles.slice(), cellZone: l.cellZone.slice(), wallMat: l.wallMat.slice(), trimMat: l.trimMat.slice(), room: l.room.slice(),
    power: l.power.slice(), decay: l.decay.slice(), humidity: l.humidity.slice(), warmth: l.warmth.slice(),
    ex: eg(l.ex), ez: eg(l.ez),
    fixtures: l.fixtures.slice(), solids: l.solids.slice(), props: l.props.slice(), decals: l.decals.slice(),
    water: l.water.slice(), structures: l.structures.slice(), ports: l.ports.slice(), leaks: l.leaks.slice(),
    emitters: l.emitters.slice(), vignettes: l.vignettes.slice(), landmarks: l.landmarks.slice(), anomalies: l.anomalies.slice(),
  };
}

/** Every ArrayBuffer referenced by a layout (for postMessage transfer lists). Transferring DETACHES them:
 * NEVER pass a layout that anything else still references (e.g. the worker LRU). Transfer cloneLayout(l). */
export function layoutTransferables(l: ChunkLayout): ArrayBuffer[] {
  const arrs = [
    l.flags, l.floorCm, l.ceilCm, l.waterCm, l.blockCm, l.floorMat, l.ceilMat, l.ceilKind, l.tiles, l.cellZone,
    l.wallMat, l.trimMat,
    l.room, l.power, l.decay, l.humidity, l.warmth,
    l.ex.kind, l.ex.hA, l.ex.hB, l.ex.matNeg, l.ex.matPos, l.ex.trim,
    l.ez.kind, l.ez.hA, l.ez.hB, l.ez.matNeg, l.ez.matPos, l.ez.trim,
  ];
  return arrs.map((a) => a.buffer as ArrayBuffer);
}

/** Ceiling tile state helpers (t = tz*2 + tx). */
export const getTile = (tiles: Uint16Array, cell: number, t: number): number => (tiles[cell] >> (t * 4)) & 15;
export function setTile(tiles: Uint16Array, cell: number, t: number, state: number): void {
  tiles[cell] = (tiles[cell] & ~(15 << (t * 4))) | ((state & 15) << (t * 4));
}
