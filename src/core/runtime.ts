// src/core/runtime.ts — main-thread system interfaces. The ONLY core file allowed to reference three,
// and only via `import type` (erased at runtime; pure modules may import these types).

import type * as THREE from 'three';
import type { ChunkKey, TileKey } from './grid.ts';
import type { MoodId, PropKindId, StoreyId, SurfaceSoundId, ZoneId } from './ids.ts';
import type { ChunkLayout, Fixture, PortalSpec, AudioEmitterSpec } from './layout.ts';
import type { DynLightRef, MeshBuffers } from './mesh.ts';
import type { PlayerInput, PlayerState } from './player.ts';
import type { QualityConfig } from './quality.ts';
import type { FlickerMode, Settings } from './settings.ts';
import type { GameBus } from './events.ts';
import type { SpawnPoint } from './world.ts';
import type { WorkerInit } from './worker.ts';
import type { ReflView } from './debug.ts';

// ---------------------------------------------------------------- textures (WP8 -> WP9)
export interface TextureSet {
  size: 512 | 1024;
  albedo: THREE.Texture; // sampler2DArray, SRGB8_ALPHA8 (a = decal/sign alpha), mipmapped
  normal: THREE.Texture; // sampler2DArray RGBA8: xyz tangent normal *0.5+0.5, a = height
  ormh: THREE.Texture; // sampler2DArray RGBA8: r AO(cavity), g roughness, b metal, a emissive mask
  grime: THREE.Texture; // 512^2 tileable RGBA8: r tide/stain rings, g speckle/mould, b scuff, a drip streaks
  waterNormals: THREE.Texture; // 512^2 tileable RG normal
  cookie: THREE.Texture; // 256^2 flashlight cookie
  /** package B: LEAN detail-map array (sampler2DArray uBrDetail), generated only when QualityConfig.detailMaps */
  detail?: THREE.Texture | null;
  dispose(): void;
}

// ---------------------------------------------------------------- atmosphere (WP11 table, WP9/WP11 consumers)
export interface ColorGrade {
  temperature: number; tint: number; saturation: number; contrast: number;
  lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number];
  shadowTint: [number, number, number]; highlightTint: [number, number, number];
  /** R2-post: sensor black pedestal in sRGB-encoded units, applied after the contrast curve (e = ped + (1 - ped) * e).
   * Optional (additive); absent = 0. */
  pedestal?: number;
  /** package C: toe strength of the grade curve (e = mix(e, e*e*1.12/(e + .12), toe)). Optional; absent = 0. */
  toe?: number;
}
export interface AtmosphereParams {
  hazeDensity: number; // 1/m, exponential
  hazeTint: [number, number, number]; // linear multiplier on local-irradiance inscatter
  hazeAlbedo: number; // scattering albedo (inscatter = E * albedo / PI * tint)
  ev100Range: [number, number]; // exposure clamp; dark sectors must stay dark
  exposureBias: number; // EV
  bloomIntensity: number;
  aoIntensity: number;
  aoColor: [number, number, number];
  grain: number;
  grade: ColorGrade;
  // package F (volumetrics / dust / mist / motes). Optional (additive); absent = the analytic defaults.
  hazePhase?: number; // dual-HG forward-lobe weight of the haze
  dustDensity?: number;
  dustNoise?: number;
  mistDensity?: number;
  moteDensity?: number;
}
/** Blended per frame at the camera (1.5 s crossfade). */
export interface AtmosphereState extends AtmosphereParams {
  camIrradiance: [number, number, number]; // lux, sampled from the tile light volume at the camera
  edgeFog: [number, number]; // start/end metres of the streaming-edge fog (EDGE_FOG.START*R, EDGE_FOG.END*R; R = streamRadius*CHUNK_SIZE)
  /** R2-post (optional, additive): 1 while the flashlight is on (the camcorder meter weights the frame centre). */
  flashlight?: number;
  /** R2-post (optional, additive): Settings.flicker as 0 standard / 1 reduced / 2 off (post banding respects it). */
  flickerMode?: number;
}

// ---------------------------------------------------------------- materials (WP9)
export interface MaterialGlobals {
  time: { value: number };
  debugView: { value: number };
  hazeDensity: { value: number };
  hazeTint: { value: THREE.Color };
  hazeAlbedo: { value: number };
  edgeFog: { value: THREE.Vector2 };
  farColor: { value: THREE.Color }; // edge-fog / clear colour (== camera inscatter colour)
  flickerMode: { value: number }; // 0 standard 1 reduced 2 off (GLSL shimmer twin)
  reflTex: { value: THREE.Texture | null };
  reflMatrix: { value: THREE.Matrix4 };
  reflOn: { value: number };
  reflY: { value: number }; // world y of the plane currently mirrored by PlanarReflection (valid when reflOn = 1)
  floorReflOn: { value: number };
  // ---- graphics-realism contract (A.0). Every field starts inert (MaterialSystem.createGlobals); the owning package
  // writes .value only. Positions are camera-relative world metres unless stated otherwise.
  // D: box-projected reflection probe (GGX-prefiltered cube)
  probeTex: { value: THREE.Texture | null }; // samplerCube uBrProbe (null: three binds its empty cube)
  probeOn: { value: number };
  probeLod: { value: number }; // last prefiltered mip
  probeMin: { value: THREE.Vector3 }; // box min - camera
  probeMax: { value: THREE.Vector3 }; // box max - camera
  probePos: { value: THREE.Vector3 }; // capture anchor - camera
  // A/E: opaque colour pyramid of split frames (rgb = opaque HDR, a = linear view depth; mipmapped) + D's Hi-Z
  sceneColor: { value: THREE.Texture | null };
  sceneInvSize: { value: THREE.Vector2 }; // 1 / level-0 size
  waterVolOn: { value: number }; // 1 during the opaque render of a split frame (water owns the submerged optics)
  hiZ: { value: THREE.Texture | null }; // D: half-res R32F min device-depth pyramid
  hiZInfo: { value: THREE.Vector4 };
  // A: pre-shade SSAO (aoRT: r AO, g view Z, ba oct view normal) and contact shadows
  ssaoTex: { value: THREE.Texture }; // 1x1 white until the SSAO hook publishes aoRT
  ssaoParams: { value: THREE.Vector4 }; // x on, y pow, z plane, w step
  ssaoProj: { value: THREE.Vector4 }; // (P00, P11, P20, P21)
  ssaoSize: { value: THREE.Vector4 }; // (w, h, 1/w, 1/h) of the full-resolution target
  csOn: { value: number }; // URL cs=0 -> 0
  // F: froxel volume (integrated in-scatter rgb, transmittance a)
  volTex: { value: THREE.Texture }; // 1x1 (0, 0, 0, 1) until the volumetrics hook publishes
  volGrid: { value: THREE.Vector4 }; // (W, H, N, tiles per row)
  volZ: { value: THREE.Vector4 }; // (zNear, zFar, slice scale, on)
  volScreen: { value: THREE.Vector2 }; // 1 / target size
  // F: flashlight bounce VPLs
  fbOn: { value: number };
  fbP: { value: THREE.Vector4[] }; // 8
  fbN: { value: THREE.Vector4[] }; // 8
  fbC: { value: THREE.Vector4[] }; // 8
  fbBox: { value: THREE.Vector4[] }; // 8
  // E: ripple simulation (world-anchored window), drips and in-water lights
  ripple: { value: THREE.Texture | null };
  rippleOrigin: { value: THREE.Vector2 }; // world xz of the texel-0 corner
  rippleSpan: { value: number }; // metres
  ripplePlane: { value: number }; // world y
  rippleOn: { value: number };
  drips: { value: THREE.Vector4[] }; // 8
  nDrips: { value: number };
  uwPos: { value: THREE.Vector4[] }; // 4
  uwDir: { value: THREE.Vector4[] }; // 4
  uwCol: { value: THREE.Vector4[] }; // 4
  nUw: { value: number };
}
/** Every per-tile binding is a uniform object. WP9 puts THESE EXACT objects into shader.uniforms (in
 * onBeforeCompile); WP10/WP11 update them only by assigning `.value` (never by replacing the object). */
export interface TileBindings {
  tileOrigin: { value: THREE.Vector3 }; // world metres
  noiseOrigin: { value: THREE.Vector3 }; // tileOrigin mod NOISE_WRAP
  lmIrr: { value: THREE.Texture }; lmDir: { value: THREE.Texture }; lmMask: { value: THREE.Texture };
  lmFlick: { value: THREE.Texture }; // shared zero texture if none
  emission: { value: THREE.Texture };
  volA: { value: THREE.Texture }; volB: { value: THREE.Texture }; volC: { value: THREE.Texture }; // Data3DTexture (volC shared zero if none)
  volMask: { value: THREE.Texture }; // 18x18 RGBA8 LightVolumeData.wallMask
  flick: { value: Float32Array }; // 9 x vec3: DYN_SLOT_OFFSETS order; rgb = color/luma(color) * intensity(t)
  ownParity: { value: THREE.Vector2 }; // (gtx & 1, gtz & 1)
  fade: { value: number }; // 0..1 dithered fade-in
  water: { value: number }; // package E: non-zero when the tile holds water (from the wall mask); 0 until E sets it
}
export interface TileMaterials {
  shell: THREE.MeshStandardMaterial;
  props: THREE.MeshStandardMaterial;
  decal: THREE.MeshStandardMaterial; // 'decal' variant: premultiplied soft alpha, depthWrite off, polygonOffset
  water: THREE.Material | null;
  /** depth-prepass materials of the shell and props meshes (same fade binding, alpha test and reflection cull;
   * materials/DepthMaterial.ts, one program) */
  depth: THREE.Material;
  depthProps: THREE.Material;
  bindings: TileBindings;
  dispose(): void; // materials only; textures belong to the TexturePool (WP10)
}
export interface MaterialSystem {
  readonly globals: MaterialGlobals;
  /** Factory: fresh materials + fresh uniform objects per tile. NEVER Material.clone(). */
  createTileMaterials(withWater: boolean): TileMaterials;
  setDebugView(v: number): void;
  setQuality(q: QualityConfig): void; // defines that change programs are applied here only, then warmup again
  zeroTextures: { lm2d: THREE.Texture; vol3d: THREE.Texture };
  /** Compiles AND draws every variant (shell, props, decal, water) into a HalfFloat target with the real scene's
   * light/shadow state (flashlight present), and pins one material per variant for the app's lifetime. */
  warmup(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void>;
}

// ---------------------------------------------------------------- streaming (WP10)
export type TileLifecycle = 'queued' | 'building' | 'received' | 'texUpload' | 'geoUpload' | 'fadingIn' | 'resident' | 'evicting' | 'disposed';
export interface TileRuntime {
  key: TileKey;
  keyStr: string;
  zone: ZoneId;
  group: THREE.Group; // position = tile origin; children: shell, props (optional), water (optional)
  materials: TileMaterials;
  dynLights: (DynLightRef | null)[]; // 9 slots
  bake: 'preview' | 'full';
  state: TileLifecycle;
  visible: boolean; // frustum result from last frame
}
export interface FixtureRef { f: Fixture; wx: number; wy: number; wz: number; tileKey: string }
export interface EmitterRef { e: AudioEmitterSpec; wx: number; wy: number; wz: number }
export interface PortalHit { spec: PortalSpec; ox: number; oz: number } // ox/oz: chunk origin (world)
export interface PropHit { kind: PropKindId; x: number; y: number; z: number; seed: number; cx: number; cz: number } // world metres
export interface DynamicMeshHandle { setOffset(x: number, y: number, z: number): void; dispose(): void }

export interface CollisionWorld {
  readonly storey: StoreyId;
  isLoaded(x: number, z: number): boolean; // unloaded cells are SOLID for collision
  floorAt(x: number, z: number, feetY: number): number; // highest walkable surface <= feetY + stepMax; NaN if unloaded
  ceilingAt(x: number, z: number, y: number): number; // lowest ceiling/overhang above y
  waterAt(x: number, z: number): number | null; // water surface y
  surfaceAt(x: number, z: number, y: number): SurfaceSoundId;
  /** world AABBs (6 floats each) whose footprint intersects the circle; returns count */
  boxesNear(x: number, z: number, r: number, out: Float32Array): number;
  portalAt(x: number, y: number, z: number): PortalHit | null;
  /** portals (layout.structures) whose trigger footprint comes within r of (x,z); returns count written to out */
  portalsNear(x: number, z: number, r: number, out: PortalHit[]): number;
  /** nearest INTERACTABLE_PROPS prop whose footprint the horizontal ray from (x,z) along yaw hits within maxDist */
  propAt(x: number, z: number, yaw: number, maxDist: number): PropHit | null;
}
export interface WorldQuery extends CollisionWorld {
  layoutAt(cx: number, cz: number): ChunkLayout | null;
  /** cellZone of the cell at (x,z) (NOT layout.zone). WP11 atmosphere and WP13 ambience use this. */
  zoneAt(x: number, z: number): ZoneId;
  /** layout.mood, except NORMAL in TOWER/ELEVATOR cells. */
  moodAt(x: number, z: number): MoodId;
  fixturesNear(x: number, z: number, r: number, out: FixtureRef[]): number;
  emittersNear(x: number, z: number, r: number, out: EmitterRef[]): number;
  /** 2.5D line of sight using core/edges semantics (walls, partitions by height, SOLID cells, blockCm). */
  losClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** Distance to the first occluder along a horizontal ray at height y (capped at maxDist). */
  rayDistance(x: number, y: number, z: number, dx: number, dz: number, maxDist: number): number;
  /** Package F (optional until implemented): 3D ray (unit direction) against the 2.5D world plus collision boxes;
   * true on a hit within maxDist, with the distance, surface normal and albedo written to out. */
  raycast?(x: number, y: number, z: number, dx: number, dy: number, dz: number, maxDist: number, out: RaycastHit): boolean;
  /** audio passability of the edge between global cells: 'x' = line x=gi between (gi-1,gj)|(gi,gj). 0..1 */
  edgeSound(axis: 'x' | 'z', gi: number, gj: number): number;
  cellWalkable(gi: number, gj: number): boolean;
}
export interface RaycastHit { t: number; nx: number; ny: number; nz: number; r: number; g: number; b: number }
export interface StreamStats {
  chunksResident: number; chunksDesired: number; layoutsPending: number;
  tilesResident: number; tilesPreview: number; tilesFull: number; queued: number; inFlight: number;
  /** live tiles of the other storeys (tower / elevator / pit / glitch prefetch keep-alive; not drawn) */
  tilesOtherStoreys: number;
  uploadsPending: number; fadingIn: number; workers: number; workersBusy: number; texturesPooled: number;
  bakeLastMs: number; bakeAvgMs: number; buildAvgMs: number;
}
export interface WorldStreamer {
  readonly storey: StoreyId;
  /** Always the data set (layouts + collision) of `storey`; layouts are held per storey and switchStorey swaps
   * which set `query` reads in the same call. */
  readonly query: WorldQuery;
  readonly scene: THREE.Group; // add to the main scene once
  /** Temporary visibility for a portal capture; does not change collision, streaming or the player's storey. */
  withStoreyView?(s: StoreyId, draw: () => void): void;
  setDoorYaw?(s: StoreyId, cx: number, cz: number, seed: number, yaw: number): void;
  /** desired set around (x,z) + smoothed velocity * EDGE_FOG.LOOKAHEAD_S (velocity estimated from successive
   * calls; teleports reset it); priorities (ring, frustum); dispatch; eviction. No uploads here. */
  update(x: number, z: number, viewX: number, viewZ: number, camera: THREE.Camera, frame: number): void;
  /** at most UPLOAD.MAX_STEPS_PER_FRAME residency step(s) within budgetMs (texture step, then geometry step),
   * plus UPLOAD.PREFETCH_STEPS_PER_FRAME step(s) for prefetch groups. burst (automation, while the ready gate is
   * closed and nobody watches): any number of steps within budgetMs, and arriving / fading tiles show at once */
  processUploads(renderer: THREE.WebGLRenderer, budgetMs: number, burst?: boolean): void;
  tiles(): Iterable<TileRuntime>;
  /** For storey s around (x,z): `layout` jobs for the (2r+1)^2 chunks (registered in storey s's query data) +
   * build/bake/upload of their tiles into s's hidden group. Idempotent; repeated calls refresh a keep-alive. */
  prefetch(s: StoreyId, x: number, z: number, radiusChunks: number): void;
  /** true when, in storey s, the layouts + collision of the chunk containing (x,z) and its 8 neighbours are
   * loaded (chunkLoaded), all their tiles are uploaded (preview is enough), and the tiles of the chunk containing
   * (x,z) are full-baked (so the tower/elevator interior matches the current storey exactly) */
  isPrefetched(s: StoreyId, x: number, z: number): boolean;
  /** instant swap (same frame): group visibility AND `query` data set; evicts the old storey progressively */
  switchStorey(to: StoreyId): void;
  /** WP12 elevator doors: a mesh drawn with the tile's props material inside the tile's group (tile-local
   * vertices). null if the tile is not resident. The handle is disposed automatically on eviction. */
  attachDynamicMesh(tileKey: string, m: MeshBuffers): DynamicMeshHandle | null;
  isReady(radiusChunks: number, needFull: boolean): boolean;
  /** Player-facing readiness (boot / teleport gate): the chunk data (collision) of the player's chunk and every
   * current-storey tile within `nearM` metres of the player, or inside the view frustum within `viewM` metres, is
   * resident (full-baked when needFull), limited to the preset's stream radius and edge-fog visibility.
   * Far tiles fade in afterwards behind the haze / edge fog. */
  isReadyNear(nearM: number, viewM: number, needFull: boolean): boolean;
  isIdle(): boolean;
  /** radius change: re-desire; BakeQuality change: await pool.reinit(init) then rebuild everything */
  setQuality(q: QualityConfig): Promise<void>;
  /** Replace the seed, releasing old residency while keeping the GPU uploader and workers. */
  reset(init: WorkerInit): Promise<void>;
  findNearest(query: string, from: { s: StoreyId; x: number; z: number }, maxChunks: number): Promise<SpawnPoint | null>;
  spawn(s: StoreyId): Promise<SpawnPoint>;
  asciiMap(s: StoreyId, cx0: number, cz0: number, cx1: number, cz1: number): Promise<string>;
  chunkLoaded(k: ChunkKey): boolean;
  stats(): StreamStats;
  dispose(): void;
}

// ---------------------------------------------------------------- lighting runtime + post (WP11)
export interface Flashlight {
  readonly light: THREE.SpotLight; // ALWAYS in the scene, castShadow ALWAYS true; off = intensity 0
  on: boolean;
  set(on: boolean): void;
  update(player: PlayerState, camera: THREE.Camera, dt: number): void;
}
export interface LightingRuntime {
  reset(): void;
  readonly flashlight: Flashlight;
  /** evaluate flicker for all resident tiles' dynamic lights; write TileBindings.flick; emit lightToggle */
  update(t: number, dt: number, tiles: Iterable<TileRuntime>, player: PlayerState, camera: THREE.Camera, world: WorldQuery): void;
  intensityOf(lightId: number): number; // current multiplier (1 for static ON lights)
  /** ANOMALY-state lights: force an intensity multiplier (null = release to the default). Used by the director. */
  setOverride(lightId: number, intensity: number | null): void;
  atmosphere(): AtmosphereState;
  setFlickerMode(m: FlickerMode): void;
  setQuality(q: QualityConfig): void;
}
export interface PostStack {
  /** realDt drives exposure adaptation; t = SIMULATION time (frozen under time=): grain frame = floor(t * 24),
   * glitch and camcorder noise also derive from t, so captures are deterministic. */
  render(realDt: number, t: number): void;
  setSize(w: number, h: number): void;
  setQuality(q: QualityConfig): void;
  setAtmosphere(a: AtmosphereState): void;
  setFilm(f: Settings['film'], brightnessEV: number): void;
  setEnabled(p: Partial<Record<'ao' | 'bloom' | 'lens' | 'grain' | 'smaa' | 'exposure' | 'grade' | 'ssr', boolean>>): void;
  /** Package D (optional until implemented): SSR debug output ('ssr' = the reflection, 'conf' = confidence). */
  setReflectionDebug?(mode: ReflView): void;
  setExposureLock(ev100: number | null): void;
  snapExposure(): void;
  glitch(seconds: number, strength: number): void;
  setPaused(p: boolean): void;
  /** Resolves after the next rendered frame with the final display-referred image downsampled to w x h RGBA8 (sRGB). */
  capture(w: number, h: number): Promise<Uint8Array>;
  readonly exposure: { ev100: number; value: number; locked: boolean };
  readonly renderScale: number;
  dispose(): void;
}

// ---------------------------------------------------------------- player (WP12)
export interface PlayerSystem {
  readonly state: PlayerState;
  readonly doorCue?: string;
  /** fixed 120 Hz internally; interpolated camera rig output written into state.eyeX..camRoll */
  update(dt: number, input: PlayerInput, world: CollisionWorld, bus: GameBus, frozenTime: boolean): void;
  teleport(s: StoreyId, x: number, y: number | null, z: number, yaw: number, pitch: number): void;
  applyToCamera(camera: THREE.PerspectiveCamera, fovDeg: number): void;
  setFly(on: boolean): void;
}
export interface InputSource {
  poll(out: PlayerInput): void;
  lock(): void;
  readonly locked: boolean;
  dispose(): void;
}

// ---------------------------------------------------------------- audio (WP13)
export interface AudioStats { state: string; voices: number; rt60: number; ir: number }
export interface AudioSystem {
  /** Clear world-specific voices while retaining the audio context and synthesized buffers. */
  reset(): void;
  start(): Promise<void>; // create/resume AudioContext (gesture or autostart)
  update(t: number, dt: number, player: PlayerState, world: WorldQuery, lighting: LightingRuntime): void;
  setVolumes(v: Settings['volume']): void;
  setFlickerMode(m: FlickerMode): void;
  setPaused(p: boolean): void;
  setQuality(q: QualityConfig): void; // humVoices / hrtf changes at runtime
  stats(): AudioStats;
  recentEvents(): string[];
  dispose(): void;
}

// ---------------------------------------------------------------- frame context (WP14)
export interface FrameContext {
  t: number; // simulation time (frozen by time=/freeze=)
  dt: number; // simulation dt (0 when frozen)
  realDt: number;
  frame: number;
  quality: QualityConfig;
  settings: Settings;
  player: PlayerState;
  camera: THREE.PerspectiveCamera;
}
