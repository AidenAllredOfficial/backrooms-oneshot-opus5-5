// src/core/ids.ts — numeric id tables. `as const` objects + union types (no TS enums: erasableSyntaxOnly).
// Tables are APPEND-ONLY after WP0; never renumber (ids are baked into layouts, vertex data and golden hashes).

export type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------- storeys
export const Storey = { LOBBY: 0, SUBLEVEL: 1, POOLROOMS: 2 } as const;
export type StoreyId = ValueOf<typeof Storey>;

// ---------------------------------------------------------------- zones
export const Zone = {
  LOBBY: 0, MANILA: 1, DARK: 2, MAZE: 3, LOW_EXPANSE: 4, PILLAR_HALL: 5, OFFICE: 6, // WP2 (Level 0 family)
  POOLROOMS: 7, PARKING: 8, PIPEWORKS: 9, WAREHOUSE: 10, CONCRETE: 11, // WP3 (deep zones)
} as const;
export type ZoneId = ValueOf<typeof Zone>;
export const ZONE_COUNT = 12;
export const ZONE_NAMES: readonly string[] = [
  'LOBBY', 'MANILA', 'DARK', 'MAZE', 'LOW_EXPANSE', 'PILLAR_HALL', 'OFFICE',
  'POOLROOMS', 'PARKING', 'PIPEWORKS', 'WAREHOUSE', 'CONCRETE',
];

export const Mood = { NORMAL: 0, SPARSE: 1, DYING: 2, DARK: 3 } as const;
export type MoodId = ValueOf<typeof Mood>;
export const MOOD_NAMES: readonly string[] = ['NORMAL', 'SPARSE', 'DYING', 'DARK'];

export const SeamMode = { BOUNDARY: 0, PATTERN: 1, GLOBAL: 2 } as const;
export type SeamModeId = ValueOf<typeof SeamMode>;

// ---------------------------------------------------------------- cells / edges
export const CellFlag = {
  SOLID: 1, // full-height mass (floor..ceil)
  VOID: 2, // no floor (pit / shaft); falls
  NOWALK: 4, // walkable=false for connectivity (e.g. deep water edge), still has floor
  RESERVED: 8, // owned by a stamp (tower/elevator/landmark/artery/spawn); zone generators must not touch
  SEALED: 16, // unreachable pocket kept on purpose (heard, not entered)
  TOWER: 32,
  ELEVATOR: 64,
  ARTERY: 128,
  LANDMARK: 256,
  WET: 512, // puddle/film cell (footsteps CARPET_WET, reflective)
  NO_CEIL: 1024, // no rendered ceiling at ceilCm (dark void / truss above)
  SPAWN_OK: 2048, // candidate spawn cell (lit, open, not reserved) - set by WP1 labeling
} as const;

export const EdgeKind = {
  OPEN: 0, WALL: 1, DOORWAY: 2, HEADER: 3, ARCH: 4, PARTITION: 5, HALF: 6, RAIL: 7, WINDOW: 8, GLITCH: 9,
} as const;
export type EdgeKindId = ValueOf<typeof EdgeKind>;
// hA / hB meaning per kind (cm, storey-relative absolute heights):
//   DOORWAY hA=head (default DOOR_CM)  HEADER hA=underside  ARCH hA=crown  PARTITION/HALF/RAIL hA=top
//   WINDOW hA=sill hB=head            others: unused (0)

// THRESHOLD = threshold strip only. ROLLUP = METAL_PAINTED roll-up-door header box on the HEADER piece (WP5).
export const EdgeTrim = { BASEBOARD: 1, CASING: 2, WAINSCOT: 4, THRESHOLD: 8, EXIT_SIGN: 16, ROLLUP: 32 } as const;

export const CeilKind = { TILES: 0, CONCRETE: 1, BEAMS: 2, OPEN_DARK: 3, TILE_GLAZED: 4, TRUSS: 5 } as const;
export type CeilKindId = ValueOf<typeof CeilKind>;

// 4 ceiling tiles per cell, 4 bits each, tile index t = (tz*2 + tx), bits [4t, 4t+3] of layout.tiles[cell]
export const TileState = { NORMAL: 0, STAINED: 1, MISSING: 2, VENT: 3, FIXTURE: 4, SAGGING: 5, NEW: 6, DIRTY: 7 } as const;
export type TileStateId = ValueOf<typeof TileState>;

// ---------------------------------------------------------------- materials (= texture array layer ids)
export const Mat = {
  WALLPAPER_L0: 0, CARPET_L0: 1, CEILING_TILE: 2, PANEL_LENS: 3, TRIM_PAINT: 4, WALLPAPER_MANILA: 5,
  CARPET_OFFICE: 6, DRYWALL: 7, VINYL_VCT: 8, CONCRETE_FLOOR: 9, CONCRETE_WALL: 10, CONCRETE_CEIL: 11,
  CMU_PAINTED: 12, POOL_TILE: 13, POOL_MOSAIC: 14, METAL_PAINTED: 15, METAL_RUST: 16, METAL_GRATE: 17,
  WOOD: 18, PLASTIC: 19, FABRIC_PARTITION: 20, PLENUM: 21, RUBBER: 22, SIGNAGE: 23, DECAL_ATLAS: 24,
  FLOOR_PAINT: 25, TERRAZZO: 26, METAL_DECK: 27, // 27 was SPARE_27: corrugated roof deck (WAREHOUSE TRUSS ceilings)
} as const;
export type MatId = ValueOf<typeof Mat>;
export const MAT_COUNT = 28;

// DECAL_ATLAS / SIGNAGE layers are 4x4 atlases; slot s occupies uv [(s%4)/4, floor(s/4)/4] .. +1/4
export const DecalKind = {
  WATER_STAIN: 0, MOLD: 1, FOOTPRINTS_WET: 2, SCUFF: 3, CRACK: 4, OIL: 5, RUST_STREAK: 6, DRAIN: 7,
  POSTER: 8, CHALK_ARROW: 9, HANDPRINT: 10, DRIP: 11, TALLY: 12, BURN: 13, PAPER: 14, PARKING_NUMBER: 15,
} as const;
export type DecalKindId = ValueOf<typeof DecalKind>;
/** DecalPlacement.kind value for a worn FLOOR_PAINT stripe (parking lines, safety lines): layer FLOOR_PAINT, w x h quad. */
export const DECAL_PAINT_STRIPE = 255;
export const SignKind = {
  EXIT: 0, EXIT_LEFT: 1, EXIT_RIGHT: 2, STAIRS: 3, B1: 4, B2: 5, L0: 6, WET_FLOOR: 7, NO_DIVING: 8,
  LEVEL_P1: 9, LEVEL_P2: 10, ELEVATOR: 11, AUTHORIZED: 12, FIRE: 13, ARROW_UP: 14, BLANK: 15,
} as const;

export const SurfaceSound = {
  CARPET: 0, CARPET_WET: 1, CONCRETE: 2, TILE: 3, METAL: 4, VINYL: 5, WOOD: 6, WATER_SHALLOW: 7,
  WATER_DEEP: 8, STAIR_CONCRETE: 9, GRATE: 10,
} as const;
export type SurfaceSoundId = ValueOf<typeof SurfaceSound>;
export const SURFACE_NAMES: readonly string[] = [
  'carpet', 'carpetWet', 'concrete', 'tile', 'metal', 'vinyl', 'wood', 'waterShallow', 'waterDeep', 'stairConcrete', 'grate',
];

// ---------------------------------------------------------------- lights
export const FixtureKind = {
  TROFFER_2x4: 0, TROFFER_2x2: 1, SKY_PANEL: 2, // recessed: shell geometry (WP5)
  TUBE_STRIP: 3, CAGE_BULB: 4, HIGHBAY: 5, PENDANT_LINEAR: 6, SODIUM: 7, EXIT_SIGN: 8, UNDERWATER: 9,
  VENDING: 10, RED_BULB: 11, // surface-mounted / hanging: prop library geometry (WP6)
} as const;
export type FixtureKindId = ValueOf<typeof FixtureKind>;
export const isRecessedFixture = (k: number): boolean => k <= 2;

export const LightState = { ON: 0, OFF: 1, FLICKER: 2, DYING: 3, BUZZ: 4, ANOMALY: 5 } as const;
export type LightStateId = ValueOf<typeof LightState>;
// ON: static. OFF: dead (grey lens, no light). FLICKER: the tile's single dynamic light (flicker channel).
// DYING: static at DYING_MEAN intensity with pink/green cast + lens shimmer. BUZZ: static on + shimmer + loud hum.
// ANOMALY: dynamic, driven by the director instead of flicker().
export const DYING_MEAN = 0.35;

export const EmitterShape = { RECT: 0, SPHERE: 1 } as const;

// ---------------------------------------------------------------- solids / structures / content
export const SolidFlag = { COLLIDE: 1, OCCLUDE: 2, WALKABLE_TOP: 4, RENDER: 8, NO_LM: 16 } as const;

export const StructureKind = { TOWER: 0, ELEVATOR: 1, SPAWN_ROOM: 2, PIT: 3, GLITCH: 4 } as const;
export type StructureKindId = ValueOf<typeof StructureKind>;

export const LandmarkKind = {
  RED_ROOM: 0, ENDLESS_HALL: 1, ATRIUM: 2, CHAIR_CATHEDRAL: 3, FLOODED_HALL: 4, LOCKED_EXIT: 5,
  VENDING_ALCOVE: 6, SERVER_ROOM: 7, DEEP_END: 8, SKYLIGHT_HALL: 9, LOCKER_ROOM: 10, LOADING_DOCK: 11, BOILER_HALL: 12,
  // R2 (B4): regular lottery kinds
  STAIRS_TO_NOWHERE: 13, LIGHT_WELL: 14, SPLIT_LEVEL_HALL: 15, RESTROOM_BLOCK: 16, CAFETERIA: 17, MOTEL_CORRIDOR: 18,
  CHAPEL: 19, CHILDRENS_PLAYROOM: 20, DRAINED_POOL: 21, SLIDE_TOWER: 22, LAZY_RIVER: 23, SHOWER_BLOCK: 24,
  // R2 (B4): hero rooms (one per district, picked from the district zone's list; world/heroRooms)
  TALL_ROOM: 25, CHAIR_STACKS: 26, CRT_WALL: 27, STAIRCASE_TO_CEILING: 28, CONVERSATION_PIT: 29, EXECUTIVE_SUITE: 30,
  COPY_ROOM: 31, HALF_LEVEL: 32, TOLL_BOOTH: 33, MEZZANINE_OFFICE: 34, CRANE_BAY: 35, VALVE_GALLERY: 36, SUMP_PIT: 37,
} as const;
export type LandmarkKindId = ValueOf<typeof LandmarkKind>;
export const LANDMARK_COUNT = 38;
export const LANDMARK_NAMES: readonly string[] = [
  'RED_ROOM', 'ENDLESS_HALL', 'ATRIUM', 'CHAIR_CATHEDRAL', 'FLOODED_HALL', 'LOCKED_EXIT', 'VENDING_ALCOVE', 'SERVER_ROOM',
  'DEEP_END', 'SKYLIGHT_HALL', 'LOCKER_ROOM', 'LOADING_DOCK', 'BOILER_HALL',
  'STAIRS_TO_NOWHERE', 'LIGHT_WELL', 'SPLIT_LEVEL_HALL', 'RESTROOM_BLOCK', 'CAFETERIA', 'MOTEL_CORRIDOR',
  'CHAPEL', 'CHILDRENS_PLAYROOM', 'DRAINED_POOL', 'SLIDE_TOWER', 'LAZY_RIVER', 'SHOWER_BLOCK',
  'TALL_ROOM', 'CHAIR_STACKS', 'CRT_WALL', 'STAIRCASE_TO_CEILING', 'CONVERSATION_PIT', 'EXECUTIVE_SUITE',
  'COPY_ROOM', 'HALF_LEVEL', 'TOLL_BOOTH', 'MEZZANINE_OFFICE', 'CRANE_BAY', 'VALVE_GALLERY', 'SUMP_PIT',
];

export const VignetteKind = {
  CHAIR_FACING_WALL: 0, WET_FLOOR_SIGNS: 1, FALLEN_TILES: 2, LONE_DOORFRAME: 3, MATTRESS_CLOSET: 4,
  SPARKING_FIXTURE: 5, RADIO: 6, RINGING_PHONE: 7, BACKPACK_CAMP: 8,
  POOL_FLOAT: 9, OPEN_CAR: 10, COLLAPSED_RACK: 11, STEAM_LEAK: 12,
} as const;
export type VignetteKindId = ValueOf<typeof VignetteKind>;
export const VIGNETTE_NAMES: readonly string[] = [
  'CHAIR_FACING_WALL', 'WET_FLOOR_SIGNS', 'FALLEN_TILES', 'LONE_DOORFRAME', 'MATTRESS_CLOSET',
  'SPARKING_FIXTURE', 'RADIO', 'RINGING_PHONE', 'BACKPACK_CAMP', 'POOL_FLOAT', 'OPEN_CAR', 'COLLAPSED_RACK', 'STEAM_LEAK',
];

// SPARKING: WP11 director reads these sites (spark bursts). REPEATED_ROOM / CEILING_FURNITURE: layout-only visuals.
export const AnomalyKind = {
  LATE_ECHO: 0, ENDLESS_STAIRS: 1, GLITCH_WALL: 2, WRONG_ELEVATOR: 3, SPARKING: 4, REPEATED_ROOM: 5, CEILING_FURNITURE: 6,
} as const;
export type AnomalyKindId = ValueOf<typeof AnomalyKind>;

export const PropKind = {
  CHAIR_STACKING: 0, OFFICE_CHAIR: 1, DESK: 2, FILING_CABINET: 3, CRT_MONITOR: 4, WATER_COOLER: 5,
  VENDING_MACHINE: 6, CONFERENCE_TABLE: 7, CRATE: 8, PALLET: 9, SHELF_RACK: 10, TRASH_CAN: 11, CONE: 12,
  WET_FLOOR_SIGN: 13, WHEEL_STOP: 14, CAR_SEDAN: 15, POOL_LADDER: 16, LOUNGE_CHAIR: 17, LIFEBUOY: 18,
  BENCH_TILED: 19, MATTRESS: 20, PHONE: 21, RADIO: 22, BACKPACK: 23, DOOR_FRAME: 24, DOOR_LEAF: 25,
  ELEVATOR_DOOR: 26, VENT_GRILLE: 27, OUTLET: 28, THERMOSTAT: 29, EXTINGUISHER: 30, PIPE_VALVE: 31,
  BOILER: 32, TANK: 33, HANDRAIL: 34, CEILING_DEBRIS: 35, TILE_FRAGMENT: 36, BOTTLE: 37, SLEEPING_BAG: 38,
  BUCKET: 39, MOP: 40, CARDBOARD_BOX: 41, FLOAT_ROPE: 42, POOL_FLOAT: 43, TOWEL: 44,
} as const;
export type PropKindId = ValueOf<typeof PropKind>;
export const PROP_KIND_COUNT = 45;
/** PropPlacement.flags bits above the SolidFlag overrides. CEILING: mounted upside down, base at y (ceiling). */
export const PropFlag = { CEILING: 256 } as const;

export const EmitterKind = { DRIP: 0, VENT: 1, PIPE: 2, MACHINE: 3, WATER: 4, STEAM: 5, RADIO: 6, PHONE: 7, BUZZ: 8 } as const;
export type EmitterKindId = ValueOf<typeof EmitterKind>;

// ---------------------------------------------------------------- vertex flags (brFlags, u8)
// brAux byte usage (u8x4). A vertex has at most one of FLOOR_AUX / PROP_AUX. DYN_EMIT|SHIMMER vertices always
// store aux.w = LightState and tint.a = fixture.seed & 255 (overrides any other use of aux.w; those faces
// skip emission-map reflections). UNDERWATER vertices store aux.w = clamp((waterCm + 320) / 5, 0, 255).
export const VFlag = {
  DYN_EMIT: 1, // emissive driven by the tile's own flicker channel intensity (uFlick[0])
  SHIMMER: 2, // DYING/BUZZ lens shimmer (emissive only; state from aux.w, 8-bit seed from tint.a)
  NO_GRIME: 4,
  UNDERWATER: 8, // submerged surface: per-channel absorption along the view path + caustics (aux.w = water height)
  REFLECTIVE: 16, // eligible for floor-emission / planar reflection
  DECAL: 32, // shell/props variant: alpha-tested against albedo.a (grates, sign faces); decal variant: soft alpha
  FLOOR_AUX: 64, // brAux = (reflPlaneHeightAboveFloor/5cm, regionKey & 255, regionKey >> 8, water byte or 0)
  PROP_AUX: 128, // brAux = (roughness override byte (0 = none, else roughness = x / 255), thin-tube radius in 0.1 mm (0 = none; widened to >= 1 px on screen), bits: 1 = tower-periodic (wrap y for LV lookup), ceilCm/5 of the anchor cell)
} as const;

/** PROP_AUX aux.y value marking a drop lens (PartBuilder.dropLens) rather than a thin-tube radius. */
export const DROP_LENS_AUX = 255;
/** Built depth (m) of a drop lens below its housing (deepened to >= 1 px on screen by the vertex shaders). */
export const DROP_LENS_H = 0.004;

// ---------------------------------------------------------------- debug views (int uniform; no recompiles)
export const DebugView = {
  FINAL: 0, ALBEDO: 1, NORMAL: 2, ROUGHNESS: 3, LIGHTMAP: 4, DIRECTIONALITY: 5, AO: 6, FLICKER: 7,
  MASK: 8, LAYER: 9, TEXEL: 10, ZONE: 11, ROOM: 12, UV: 13, EMISSION: 14, LIGHT_VOLUME: 15,
} as const;
export type DebugViewId = ValueOf<typeof DebugView>;
export const DEBUG_VIEW_NAMES: readonly string[] = [
  'final', 'albedo', 'normal', 'roughness', 'lightmap', 'directionality', 'ao', 'flicker', 'mask', 'layer',
  'texel', 'zone', 'room', 'uv', 'emission', 'lv',
];
