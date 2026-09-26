// src/core/constants.ts — single source of truth for units, grid sizes and invariants.
// Units: metres, seconds, radians. Photometric: luminance in nits (cd/m^2), illuminance in lux,
// point-light intensity in candela. Heights inside layouts are integer centimetres (Int16).

export const GEN_VERSION = 1; // mixed into every generation hash; bump => update golden hashes

// ---------------------------------------------------------------- grid
export const CELL = 1.2; // m, = two 0.6 m ceiling tiles
export const CEIL_TILE = 0.6; // m
export const CHUNK_CELLS = 32; // generation + streaming unit
export const CHUNK_SIZE = 38.4; // m
export const CHUNK_CELL_COUNT = 1024; // 32*32
export const EDGE_LINES = 33; // lines per axis stored per chunk (both borders)
export const EDGE_COUNT = 1056; // 33*32 edges per axis
export const TILE_CELLS = 16; // render/bake tile ("RTile") = one chunk quadrant
export const TILE_SIZE = 19.2; // m
export const TILES_PER_AXIS = 2; // per chunk
export const TILES_PER_CHUNK = 4;

// ---------------------------------------------------------------- walls / openings (cm unless noted)
export const WALL_T = 0.15; // m, centred on the edge line
export const PARTITION_T = 0.06; // m, panel thickness above the base plinth
export const PARTITION_BASE_T = 0.15; // m, floor plinth under PARTITION panels (keeps the no-leak rule, see below)
export const PARTITION_BASE_CM = 10; // plinth height
export const DOOR_W = 0.9; // m, DOORWAY hole width, centred on the edge
export const DOOR_CM = 210; // default DOORWAY head height
export const HEADER_CM = 220; // default HEADER underside
export const ARCH_CROWN_CM = 260; // default ARCH crown
export const ARCH_JAMB = 0.1; // m per side
export const PARTITION_CM = 150;
export const HALF_WALL_CM = 105;
export const RAIL_CM = 100;
export const STD_CEIL_CM = 270;

// ---------------------------------------------------------------- storeys / verticality
export const STOREY_COUNT = 3; // 0 Lobby, 1 Sublevel (industrial), 2 Poolrooms; down: s -> (s+1)%3
export const STOREY_PITCH = 3.0; // m, y shift applied by the periodic stair tower
export const TOWER_SWITCH_Y = 1.6; // m, |feetY| beyond this inside a tower footprint switches storey
export const TOWER_SPAN = 6.0; // m, tower geometry spans y in [-6, +6] in every storey
export const TOWER = { SUPER_CHUNKS: 4, W_CELLS: 3, L_CELLS: 5, SEAM_MARGIN: 2, FLIGHT_RISE: 1.5, TREADS: 12, TREAD: 0.3 } as const;
export const ELEVATOR = { SUPER_CHUNKS: 8, W_CELLS: 2, L_CELLS: 3, DWELL_S: 3, RIDE_S: 6 } as const;
export const ARTERY = { BAND_CHUNKS: 12, BAND_P: 0.5, SEG_CHUNKS: 8, SEG_P: 0.7, WIDTH_CELLS: 2, SEAM_MARGIN: 3 } as const;

// ---------------------------------------------------------------- districts / fields
export const DISTRICT = { SITE_CHUNKS: 4, JITTER_CHUNKS: 1.5, WARP_AMP_CHUNKS: 0.8, WARP_WAVELENGTH_CHUNKS: 6 } as const;
export const FIELD_WAVELENGTH = { power: 96, decay: 160, humidity: 72, warmth: 400 } as const; // metres

// ---------------------------------------------------------------- player
export const PLAYER = {
  radius: 0.28, height: 1.75, eye: 1.62, crouchHeight: 1.15, crouchEye: 1.0, stepMax: 0.36,
  // R2 (B7) pace: walk 1.45 -> 1.75 (the 'normal' comfort pace), sprint 3.2 -> 4.0, sprintTired 2.4 -> 3.2
  walk: 1.75, sprint: 4.0, sprintTired: 3.2, crouch: 0.75, gravity: 9.81, wadeMaxDepth: 1.1,
} as const;

// ---------------------------------------------------------------- lightmaps (the no-leak invariant)
// Floor/ceiling charts are whole-tile grids whose texel boundaries lie on cell lines (integer texels per
// cell). With BILINEAR filtering only, a visible floor point is >= T/2 from the line of an occluding edge,
// T = edgeBaseThickness(kind) (core/edges.ts: WALL_T, or PARTITION_BASE_T under partitions), and the nearest
// wrong-side texel centre is LM_TEXEL/2 behind the line, so its bilinear weight is
// max(0, (LM_TEXEL/2 - T/2) / LM_TEXEL) = 0  iff  LM_TEXEL <= T  for EVERY occluding kind.
// (tests/core/invariants.test.ts checks all EdgeKinds x all LM_TPC_ALLOWED.)
export const LM_TPC_ALLOWED = [8, 12] as const; // texels per cell
export type LmTpc = (typeof LM_TPC_ALLOWED)[number];
export const lmTexel = (tpc: LmTpc): number => CELL / tpc;
export const LM_ATLAS_W = 512; // atlas width; height in {256,512,768,1024}
export const LM_PAD = 2; // texels of padding (dilated) around every non-grid chart
export const LM_SAMPLE_WALL_CLEAR = WALL_T / 2 + 0.01; // bake sample points are clamped this far from walls

// ---------------------------------------------------------------- baked lighting
export const LIGHT = {
  R_STATIC: 10, // m, window radius for closed zones: w(d) = (1-(d/R)^4)^2
  R_OPEN: 14, // m, zones with ZONE_INFO.open
  MOUNT_R_EXTRA: 8, // m, per-light R = min(R_MAX, max(zoneR, landmarkR, mountHeightAboveFloor + MOUNT_R_EXTRA))
  R_MAX: 20, // m, hard cap (lights must stay inside the 3x3-chunk neighbourhood + VisGrid halo)
  R_DYN: 9.5, // m, dynamic (flicker) lights; < TILE_SIZE/2 so channel ownership is unambiguous
  DYN_MAX_MOUNT: 6, // m above floor; higher fixtures are never dynamic (R_DYN would not reach the floor)
  MAX_DYN_PER_TILE: 1, // at most one FLICKER light per 16x16 tile (enforced by generation)
  CHANNELS: 4, // flicker channel = (globalTileX & 1) + 2 * (globalTileZ & 1)
  POLY_EXACT_FACTOR: 3, // exact clipped-polygon form factor when d < 3 * emitter long side, else point samples
  K_MAX: 16, // per receiver (texel / patch / LV sample): only the K strongest unoccluded lights are evaluated
  PROBE_RAY_MAX: 8, // m, probe rays are capped; misses use a tile-independent ambient term (WP7)
  HALO_CELLS: 24, // VisGrid halo around the tile (the 3x3 neighbourhood guarantees >= 32)
} as const;
export const PROBE_Y = { LOW: 0.4, TOP_BELOW_CEIL: 0.35 } as const; // probes at 0.4, mid, ceil-0.35 per cell
export const LV = { NX: 32, NY: 6, NZ: 32, STEP: 0.6, Y: [0.2, 0.8, 1.5, 2.3, 3.4, 5.0] } as const; // per-tile prop light volume
export const EMISSION = { RES: 88, TEXEL: 0.3, MARGIN: 3.6, FADE: 3.6 } as const; // floor-reflection emission map per tile
/** Light-region ids are stored in 11+1 bits (floor brAux, emission-map alpha). regionKey maps a region label
 * (0 = solid) to 1..REGION_MASK+1 (exact in half float); WP5, WP7 and WP9 compare keys, never raw labels. */
export const REGION_MASK = 2047;
export const regionKey = (r: number): number => (r === 0 ? 0 : ((r - 1) & REGION_MASK) + 1);

// ---------------------------------------------------------------- streaming / rendering
export const NOISE_WRAP = 1228.8; // m (32 chunks); world-space shader noise uses origin mod NOISE_WRAP
export const UPLOAD = { MAX_STEPS_PER_FRAME: 1, PREFETCH_STEPS_PER_FRAME: 1, FADE_IN_S: 0.5, DISPOSE_DELAY_FRAMES: 1 } as const;
export const EDGE_FOG = { START: 0.55, END: 0.8, LOOKAHEAD_S: 2 } as const; // x R = streamRadius*CHUNK_SIZE; desired-set centre = pos + vel*LOOKAHEAD_S
export const HDR_CLAMP = 32768; // every shader clamps outgoing radiance (nits) to this before writing RGBA16F
export const PHOTOMETRY = { EV100_L0: 9.4, EXPOSURE_CAL: 1.2 } as const; // exposure = 1 / (1.2 * 2^EV100)

// ---------------------------------------------------------------- audio
export const SPEED_OF_SOUND = 343;
