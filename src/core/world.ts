// src/core/world.ts — generation-side contracts: districts, fields, seams, zone generator plug-in API,
// the ChunkGrid builder (implemented by WP1, used by WP2/WP3/WP4) and the WorldGen facade.

import { ELEVATOR, TOWER } from './constants.ts';
import { footprintRect, type ChunkKey, type Vec3 } from './grid.ts';
import type {
  AnomalyKindId, CeilKindId, EmitterKindId, FixtureKindId, LandmarkKindId, MatId, MoodId, PropKindId,
  SeamModeId, StoreyId, StructureKindId, VignetteKindId, ZoneId,
} from './ids.ts';
import type {
  ChunkLayout, DecalPlacement, Fixture, Leak, PortalSpec, PropPlacement, Solid, WaterRect,
} from './layout.ts';
import type { Rng } from './rng.ts';

export type TestSceneId = 'leak' | 'cornell' | 'tower' | 'materials' | 'flicker' | 'grid';
export const TEST_SCENES: readonly TestSceneId[] = ['leak', 'cornell', 'tower', 'materials', 'flicker', 'grid'];

export interface WorldGenOptions {
  seed: number; // hashString(seedText)
  seedText: string;
  forceZone: ZoneId | null; // every district becomes this zone
  forceMood: MoodId | null;
  forceLandmark: LandmarkKindId | null; // landmark stamped at chunk (0,0) of every storey
  testScene: TestSceneId | null; // hand-authored layouts around the origin; other chunks empty SOLID
  lights: 'default' | 'on' | 'dead'; // QA override of fixture states (on: all ON, no dynamic lights)
}

export interface DistrictInfo {
  id: number; // hash of (s, site cell); stable
  s: StoreyId;
  zone: ZoneId;
  mood: MoodId;
  siteX: number; siteZ: number; // site position in CHUNK units (float)
  seed: number;
  params: Readonly<Record<string, number>>; // from ZoneGenerator.districtParams; shared by all chunks of the district
}

/** Continuous fields over world metres, each in [0,1). Storey-offset. */
export interface FieldSampler {
  power(x: number, z: number): number;
  decay(x: number, z: number): number;
  humidity(x: number, z: number): number;
  warmth(x: number, z: number): number;
}

/** Edges along one chunk seam line (32 entries, index = cell along the line in increasing x or z). */
export interface SeamEdges { kind: Uint8Array; hA: Int16Array; hB: Int16Array }
export interface SeamSpec extends SeamEdges {
  mode: SeamModeId;
  matNeg: Uint8Array; matPos: Uint8Array; trim: Uint8Array;
}

/** (i0, j0) = MIN corner of the rotated footprint (core/grid.ts footprintRect/footprintCell/footprintPoint).
 * Tower local frame per §2.4 (u across W = 3, v along L = 5); elevator: u across W = 2, v along L = 3 (v = 0,1 cab, v = 2 lobby). */
export interface TowerSite { id: number; cx: number; cz: number; i0: number; j0: number; rot: 0 | 1 | 2 | 3; endless: boolean }
export interface ElevatorSite { id: number; cx: number; cz: number; i0: number; j0: number; rot: 0 | 1 | 2 | 3 }
/** Half-open local cell rect [i0, j0, i1, j1) of a tower / elevator footprint. Used by WP1 (site rejection, seam
 * margins) and WP4 (stamping, exit cells). */
export const towerFootprint = (t: TowerSite): [number, number, number, number] => footprintRect(t.i0, t.j0, TOWER.W_CELLS, TOWER.L_CELLS, t.rot);
export const elevatorFootprint = (e: ElevatorSite): [number, number, number, number] => footprintRect(e.i0, e.j0, ELEVATOR.W_CELLS, ELEVATOR.L_CELLS, e.rot);
/** Endless 2-cell hallway. axis 'x' = runs along x; `row` = global cell index (gj) of its first lane. [g0,g1) global cells along the axis. */
export interface ArterySpan { axis: 'x' | 'z'; row: number; g0: number; g1: number; seed: number }
export interface LandmarkSite { kind: LandmarkKindId; cx: number; cz: number; seed: number }

export interface SpawnPoint {
  s: StoreyId; x: number; y: number; z: number; yaw: number; pitch: number;
  zone: ZoneId; score: number; reason: string;
}

export interface ZonePalette {
  floorMat: MatId; wallMat: MatId; ceilMat: MatId; trimMat: MatId;
  ceilKind: CeilKindId; ceilCm: number; baseboard: boolean;
}

export interface LightingProfile {
  kind: FixtureKindId;
  placement: 'lattice' | 'custom'; // custom: the zone places its own fixtures via grid.addFixture
  lattice: [number, number]; // pitch in 0.6 m ceiling tiles along x, z (global lattice)
  phase: [number, number]; // lattice offset in tiles (from district params)
  axis: 0 | 1; // long axis of rect fixtures: 0 = x, 1 = z
  cctRange: [number, number]; // Kelvin; warmth field interpolates: warmth 1 -> the low-Kelvin end, 0 -> the high-Kelvin end (any pair order)
  luminance: number; // nits (RECT) or cd (SPHERE)
  zoneMul: number; // multiplies the power field (DARK: 0.35)
  mountCm: number; // distance below ceiling of the emitting surface (0 for recessed)
  /** added to fields.decay(x, z) (result clamped to [0, 0.999]) wherever this profile applies; DARK: 0.2.
   * WP1 chunkgen wraps ctx.fields with the offset when set, so WP4 placement sees it too. */
  decayAdd?: number;
}

export interface PropRule {
  kind: PropKindId;
  where: 'wall' | 'corner' | 'center' | 'wallMounted' | 'aisle' | 'cluster';
  per100m2: number; // expected count per 100 m^2 of walkable room area, x (0.5 + decay)
  variants: number;
  minSpacing: number; // m
  yCm: number; // mount height for wallMounted
}
export interface PropRuleSet { rules: readonly PropRule[] }

/** Mutable builder over a ChunkLayout (WP1 implements; generators use ONLY this API to write). */
export interface CellPatch {
  floorCm?: number; ceilCm?: number; waterCm?: number; blockCm?: number; floorMat?: MatId; ceilMat?: MatId;
  ceilKind?: CeilKindId; cellZone?: ZoneId; flagsSet?: number; flagsClear?: number;
}
export interface EdgeOpts { hA?: number; hB?: number; matNeg?: MatId; matPos?: MatId; trim?: number }
export interface ChunkGrid {
  readonly key: ChunkKey;
  readonly layout: ChunkLayout;
  readonly gi0: number; // global cell of local (0,0)
  readonly gj0: number;
  isReserved(li: number, lj: number): boolean;
  /** seam lines (i=0/32 on 'x', j=0/32 on 'z') are frozen after the seam step */
  isFrozenEdge(axis: 'x' | 'z', i: number, j: number): boolean;
  /** axis 'x': ex edge on line x=i between cells (i-1,j),(i,j); axis 'z': ez edge on line z=j between (i,j-1),(i,j).
   * Returns false (and writes nothing) if frozen or touching a reserved cell unless `force`. */
  setEdge(axis: 'x' | 'z', i: number, j: number, kind: number, o?: EdgeOpts, force?: boolean): boolean;
  getEdge(axis: 'x' | 'z', i: number, j: number): number;
  /** straight run on one line: axis 'x' => line x=line, cells [from,to) along z */
  wallRun(axis: 'x' | 'z', line: number, from: number, to: number, kind: number, o?: EdgeOpts): void;
  /** closed rectangle of edges around cells [li0,li1) x [lj0,lj1) */
  rectWalls(li0: number, lj0: number, li1: number, lj1: number, kind: number, o?: EdgeOpts): void;
  setCells(li0: number, lj0: number, li1: number, lj1: number, p: CellPatch, force?: boolean): void;
  hasFlag(li: number, lj: number, f: number): boolean;
  /** Solids crossing chunk bounds: EVERY chunk whose bounds a solid intersects adds it (clipped or unclipped;
   * ids are chunk-assigned, there are no shared global ids). WP5/WP6 mesh only nb.center's solids, filtered by
   * face ownership (pipes: by midpoint), so no face is emitted twice. WP7 (nb.solids()) and WP12 tolerate the
   * resulting duplicates. */
  addSolid(s: DistributiveOmit<Solid, 'id'>): number;
  /** key: lattice coords of the fixture centre => id = fixtureId(seed, s, latticeI, latticeJ, f.kind), seed =
   * fixtureSeed(id); or an explicit {id, seed} (towers/elevators: structureFixtureId). Returns the id. */
  addFixture(f: Omit<Fixture, 'id' | 'seed' | 'dynamic'>, key: FixtureKey): number;
  addProp(p: PropPlacement): void;
  addDecal(d: DecalPlacement): void;
  addWater(w: WaterRect): void;
  addLeak(l: Leak): void;
  addEmitter(kind: EmitterKindId, x: number, y: number, z: number, gain: number): void;
  addVignette(kind: VignetteKindId, x: number, z: number, yaw: number): void;
  addAnomaly(kind: AnomalyKindId, x: number, z: number, r: number): void;
  addStructure(kind: StructureKindId, i0: number, j0: number, i1: number, j1: number, rot: 0 | 1 | 2 | 3, portal: PortalSpec | null): number;
  addLandmark(kind: LandmarkKindId, i0: number, j0: number, i1: number, j1: number): void;
  cellCenter(li: number, lj: number): [number, number]; // chunk-local metres
}
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type FixtureKey = { latticeI: number; latticeJ: number } | { id: number; seed: number };

export interface ZoneGenContext {
  key: ChunkKey;
  seed: number;
  opts: WorldGenOptions;
  rng: Rng; // rngFor(seed, SALT.ZONE_LAYOUT, s, cx, cz)
  district: DistrictInfo;
  grid: ChunkGrid;
  seams: { W: SeamSpec; N: SeamSpec; E: SeamSpec; S: SeamSpec };
  neighbors: { W: ZoneId; N: ZoneId; E: ZoneId; S: ZoneId };
  fields: FieldSampler;
  palette: ZonePalette;
  lighting: LightingProfile;
  world: WorldGenQuery;
}

/** Read-only queries a generator may make about the world (pure). */
export interface WorldGenQuery {
  districtAt(s: StoreyId, cx: number, cz: number): DistrictInfo;
  arteriesNear(s: StoreyId, cx: number, cz: number): readonly ArterySpan[];
  towersNear(s: StoreyId, cx: number, cz: number): readonly TowerSite[];
}

export interface GlobalSeamQuery {
  seed: number; s: StoreyId; district: DistrictInfo;
  axis: 'x' | 'z'; // 'x' = line x = const (a west/east seam); 'z' = line z = const
  line: number; // global line index (gi for 'x', gj for 'z')
  g0: number; // global cell index of the first of the 32 cells along the line
}

export interface ZoneGenerator {
  id: ZoneId;
  seamMode: 'pattern' | 'global';
  districtParams(rng: Rng, s: StoreyId): Record<string, number>;
  /** PATTERN mode: seam edges from a seam-local rng (shared by both sides). */
  seamPattern?(rng: Rng, d: DistrictInfo): SeamEdges;
  /** GLOBAL mode: rasterize world-space features onto the seam line (must agree with generate()). */
  globalSeam?(q: GlobalSeamQuery): SeamEdges;
  generate(ctx: ZoneGenContext): void;
  palette(s: StoreyId, d: DistrictInfo): ZonePalette;
  lighting(s: StoreyId, d: DistrictInfo): LightingProfile;
  props: PropRuleSet;
}

/** 3x3 chunk neighbourhood; cell coords are relative to the CENTER chunk, valid in [-32, 64). */
export interface LayoutNeighborhood {
  readonly center: ChunkLayout;
  get(dcx: -1 | 0 | 1, dcz: -1 | 0 | 1): ChunkLayout;
  flags(li: number, lj: number): number;
  floorCm(li: number, lj: number): number;
  ceilCm(li: number, lj: number): number;
  blockCm(li: number, lj: number): number;
  waterCm(li: number, lj: number): number;
  room(li: number, lj: number): number; // chunk-local room ids are made unique: (layoutIndex << 12) | room
  /** Light-region label over the whole 96x96 halo: flood fill across edges that do not occlude at y = 1.2 m
   * (and cells not SOLID). Deterministic for a given centre chunk; used by BOTH the mesher (floor brAux) and the
   * baker (emission-map alpha), always through regionKey() (core/constants.ts), so floor-reflection rejection
   * is self-consistent per tile. 0 = solid. */
  region(li: number, lj: number): number;
  exKind(i: number, lj: number): number; // i in [-32, 65)
  ezKind(li: number, j: number): number;
  exH(i: number, lj: number): [number, number];
  ezH(li: number, j: number): [number, number];
  /** fixtures of all 9 layouts whose centre is within r metres (center-chunk-local coords).
   * `out` is cleared first; returns out.length. Neighbour-chunk fixtures are copies translated into
   * centre-chunk-local coordinates (cached per neighbourhood); centre-chunk fixtures are the originals. */
  fixturesNear(x: number, z: number, r: number, out: Fixture[]): number;
  /** solids of all 9 layouts (positions converted to center-chunk-local coords, cached) */
  solids(): readonly Solid[];
}

export interface WorldGen extends WorldGenQuery {
  readonly opts: WorldGenOptions;
  zoneAt(s: StoreyId, cx: number, cz: number): ZoneId;
  fields(s: StoreyId): FieldSampler;
  /** 'x': the WEST line of chunk (cx,cz) (= EAST line of cx-1); 'z': its NORTH line. Pure; both sides call it. */
  seam(s: StoreyId, axis: 'x' | 'z', cx: number, cz: number): SeamSpec;
  elevatorsNear(s: StoreyId, cx: number, cz: number): readonly ElevatorSite[];
  landmarkAt(s: StoreyId, cx: number, cz: number): LandmarkSite | null;
  generateChunk(key: ChunkKey): ChunkLayout;
  findSpawn(s: StoreyId): SpawnPoint;
  /** query: 'zone:NAME' | 'landmark:NAME' | 'vignette:NAME' | 'tower' | 'elevator' | 'dark' | 'spawn' | 'water' | 'flicker'
   *  | 'safe' (nearest walkable, non-reserved cell to `from`; used by glitch/pit traversal and spawn snapping) */
  findNearest(query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): SpawnPoint | null;
  asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): string;
}

export type { Vec3 };
